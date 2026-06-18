/**
 * Generic playoff importer — backfill a completed season's PLAYOFFS from its Google Sheet's
 * `Playoff Bracket` tab. Parameterized sibling of import-playoffs-2025.ts (which stays as the
 * 2025-specific, hardcoded-validation version); this one auto-detects the champion from the
 * sheet so it works for any season whose bracket uses the same visual layout (confirmed for
 * 2023 + 2024).
 *
 * Bracket layout (per the sheet): five column blocks at bases 0/5/10/15/20 =
 *   Wild Card / Divisional / Conference / Super Bowl / Champion.
 * Within a block: seed@base, team@base+2, owner@base+3, score@base+4.
 * Round → week: wild_card=19, divisional=20, conference=21, championship=22. The Super Bowl
 * records no points in the sheet (only the matchup + champion), so the title game is resolved
 * via the service's winner override, read from the Champion column.
 *
 * Usage:
 *   tsx scripts/import-playoffs.ts --season=<id> --sheet=<sheetId> [--dry-run]
 *
 * --dry-run parses + prints what it WOULD write (champion, Super Bowl, per-round scores)
 * without touching the DB — use it to verify before the real run. Idempotent.
 */
import '@/load-env';

import { and, eq } from 'drizzle-orm';

import { db, owners, ownerSeasons, nflTeams, playoffMatchups, scores, seasonAwards } from '@/db';
import {
  advancePlayoffs,
  generatePlayoffBracket,
  getPlayoffBracket,
  PLAYOFF_ROUND_WEEKS,
  setGameWinner,
} from '@/lib/playoffs/service';
import { getSeasonSeeds } from '@/lib/standings/query';

/* -------------------------------------------------------------------------- */
/* CLI args                                                                   */
/* -------------------------------------------------------------------------- */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const SEASON_ID = Number(arg('season'));
const SHEET_ID = arg('sheet') ?? '';
const DRY_RUN = process.argv.includes('--dry-run');
const BRACKET_TAB = 'Playoff Bracket';

if (!Number.isInteger(SEASON_ID) || SEASON_ID <= 0) throw new Error('Missing/invalid --season=<id>');
if (!SHEET_ID) throw new Error('Missing --sheet=<sheetId>');

const ROUND_BASE = { wild_card: 0, divisional: 5, conference: 10, championship: 15 } as const;
const CHAMPION_BASE = 20;
const SEED_OFFSET = 0;
const TEAM_OFFSET = 2;
const OWNER_OFFSET = 3;
const SCORE_OFFSET = 4;

type Round = keyof typeof ROUND_BASE;

/* -------------------------------------------------------------------------- */
/* CSV fetch + parse                                                          */
/* -------------------------------------------------------------------------- */

function tabUrl(tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      /* ignore */
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchTab(tab: string): Promise<string[][]> {
  const res = await fetch(tabUrl(tab));
  if (!res.ok) throw new Error(`Failed to fetch tab "${tab}": HTTP ${res.status}`);
  return parseCsv(await res.text());
}

interface ParsedCell {
  seed: number;
  team: string;
  owner: string;
  score: number | null;
}

function readBlock(r: string[], base: number): ParsedCell | null {
  const seedStr = (r[base + SEED_OFFSET] ?? '').trim();
  const team = (r[base + TEAM_OFFSET] ?? '').trim();
  const owner = (r[base + OWNER_OFFSET] ?? '').trim();
  const scoreStr = (r[base + SCORE_OFFSET] ?? '').trim();
  const seed = Number(seedStr);
  // A real bracket cell has a seed and at least one of team/owner. (Some sheets, e.g.
  // 2023's divisional column, carry the team but leave the owner blank.) Reject cells
  // where neither field is a NAME — consolation-section rows can drop a stray number into
  // a name position.
  const hasName = /[a-z]/i.test(team) || /[a-z]/i.test(owner);
  if (!seedStr || !Number.isFinite(seed) || !hasName) return null;
  const score = scoreStr && Number.isFinite(Number(scoreStr)) ? Number(scoreStr) : null;
  return { seed, team, owner, score };
}

function parseBracket(rows: string[][]): {
  cellsByRound: Record<Round, ParsedCell[]>;
  superBowl: ParsedCell[];
  champion: ParsedCell | null;
} {
  const cellsByRound: Record<Round, ParsedCell[]> = {
    wild_card: [],
    divisional: [],
    conference: [],
    championship: [],
  };
  let champion: ParsedCell | null = null;

  for (const raw of rows) {
    const r = [...raw];
    while (r.length < 25) r.push('');
    for (const round of Object.keys(ROUND_BASE) as Round[]) {
      const cell = readBlock(r, ROUND_BASE[round]);
      if (cell) cellsByRound[round].push(cell);
    }
    const champ = readBlock(r, CHAMPION_BASE);
    if (champ) champion = champ;
  }

  return { cellsByRound, superBowl: cellsByRound.championship, champion };
}

function log(msg = ''): void {
  console.log(msg);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<boolean> {
  log(`=== Import playoffs — season ${SEASON_ID}${DRY_RUN ? ' (DRY RUN — no writes)' : ''} ===\n`);

  const osRows = await db
    .select({ ownerSeasonId: ownerSeasons.id, team: nflTeams.name, owner: owners.name })
    .from(ownerSeasons)
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .where(eq(ownerSeasons.seasonId, SEASON_ID));

  const norm = (s: string) => s.trim().toLowerCase();
  const teamById = new Map<number, string>();
  const osIdByTeam = new Map<string, number>();
  const osIdByOwner = new Map<string, number>();
  for (const r of osRows) {
    teamById.set(r.ownerSeasonId, r.team);
    osIdByTeam.set(norm(r.team), r.ownerSeasonId);
    osIdByOwner.set(norm(r.owner), r.ownerSeasonId);
    // Index the lead owner of a co-owned team too (e.g. "Chris deMartino and Zack Herman").
    const lead = norm(r.owner).split(/\s+and\s+/)[0];
    if (lead && !osIdByOwner.has(lead)) osIdByOwner.set(lead, r.ownerSeasonId);
  }

  /** Resolve a bracket cell to an ownerSeasonId by team name, else owner name. */
  const resolveOs = (cell: ParsedCell): number | undefined => {
    if (cell.team) {
      const byTeam = osIdByTeam.get(norm(cell.team));
      if (byTeam !== undefined) return byTeam;
    }
    if (cell.owner) {
      const o = norm(cell.owner);
      return osIdByOwner.get(o) ?? osIdByOwner.get(o.split(/\s+and\s+/)[0]);
    }
    return undefined;
  };

  const rows = await fetchTab(BRACKET_TAB);
  const { cellsByRound, superBowl, champion } = parseBracket(rows);

  // Resolve each round's scored cells to ownerSeasonId → points (first writer wins, so the
  // real bracket at the top of the tab takes precedence over any consolation rows below).
  const scoresByRound: Record<Round, Map<number, number>> = {
    wild_card: new Map(),
    divisional: new Map(),
    conference: new Map(),
    championship: new Map(),
  };
  const unresolved = new Set<string>();
  for (const round of ['wild_card', 'divisional', 'conference'] as const) {
    for (const cell of cellsByRound[round]) {
      if (cell.score === null) continue;
      const osId = resolveOs(cell);
      if (osId === undefined) {
        unresolved.add(cell.team || cell.owner);
        continue;
      }
      if (!scoresByRound[round].has(osId)) scoresByRound[round].set(osId, cell.score);
    }
  }
  const championOsId = champion ? resolveOs(champion) : undefined;

  // Report the postseason result for verification.
  log('--- Parsed from the sheet ---');
  for (const round of ['wild_card', 'divisional', 'conference'] as const) {
    const week = PLAYOFF_ROUND_WEEKS[round];
    const entries = [...scoresByRound[round].entries()].sort((a, b) => b[1] - a[1]);
    log(
      `Week ${week} (${round}): ` +
        (entries.map(([os, s]) => `${teamById.get(os) ?? os} ${s}`).join(', ') || '(none)'),
    );
  }
  const sbTeams = superBowl.filter((c) => c.team || c.owner);
  log(`Super Bowl: ${sbTeams.map((c) => `${c.team || '?'}/${c.owner}`).join('  vs  ') || '(none)'}`);
  log(
    `Champion:   ${champion ? `${champion.team || teamById.get(championOsId ?? -1) || '?'} / ${champion.owner}` : '(none parsed)'}`,
  );
  log('');

  if (unresolved.size) log(`⚠ Unresolved cells (no owner match): ${[...unresolved].join(', ')}`);

  if (DRY_RUN) {
    log('\nDRY RUN complete — nothing written. Re-run without --dry-run to import.');
    return unresolved.size === 0;
  }

  // 1. Generate the wild-card bracket from the engine's regular-season seeding. This also
  //    tells us exactly which 14 owners are in the playoff field, so we never write a
  //    playoff-week score for a non-playoff team (the sheet's "Round 3" consolation bracket
  //    reuses the same columns).
  const gen = await generatePlayoffBracket(SEASON_ID);
  log(`generatePlayoffBracket: ${gen.message}`);
  const playoffOsIds = new Set(
    [...gen.seeds.AFC, ...gen.seeds.NFC].map((s) => s.ownerSeasonId),
  );

  // 2. Clean slate for the playoff weeks, then write per-round scores for ONLY the 14
  //    playoff teams. Deleting first keeps re-runs idempotent and removes any stray
  //    consolation scores written by an earlier run.
  for (const week of [19, 20, 21, 22]) {
    await db.delete(scores).where(and(eq(scores.seasonId, SEASON_ID), eq(scores.week, week)));
  }
  for (const round of ['wild_card', 'divisional', 'conference'] as const) {
    const week = PLAYOFF_ROUND_WEEKS[round];
    let written = 0;
    let skipped = 0;
    for (const [osId, points] of scoresByRound[round]) {
      if (!playoffOsIds.has(osId)) {
        skipped++; // non-playoff owner (consolation bracket) — not a real playoff score
        continue;
      }
      await db.insert(scores).values({
        seasonId: SEASON_ID,
        ownerSeasonId: osId,
        week,
        dkPoints: points.toFixed(2),
        source: 'manual',
        isBye: false,
        note: `playoffs-import-s${SEASON_ID}`,
      });
      written++;
    }
    log(`Week ${week} (${round}): wrote ${written} scores${skipped ? ` (skipped ${skipped} non-playoff)` : ''}.`);
  }
  log('');

  // 3. Advance the bracket using those scores.
  log(`advancePlayoffs: ${(await advancePlayoffs(SEASON_ID)).message}`);

  // 4. Championship has no points in the sheet — set the winner from the Champion cell.
  if (championOsId !== undefined) {
    const [titleGame] = await db
      .select({ id: playoffMatchups.id, winner: playoffMatchups.winnerOwnerSeasonId })
      .from(playoffMatchups)
      .where(and(eq(playoffMatchups.seasonId, SEASON_ID), eq(playoffMatchups.round, 'championship')))
      .limit(1);
    if (titleGame && titleGame.winner === null) {
      const champTeam = teamById.get(championOsId) ?? '?';
      log(`setGameWinner (championship → ${champTeam}): ${(await setGameWinner(SEASON_ID, titleGame.id, championOsId)).message}`);
    } else if (titleGame) {
      log('Championship already resolved.');
    } else {
      log('WARNING: no championship game generated — bracket did not reach the title game.');
    }
  }
  log('');

  // 4. Validate the final bracket vs the sheet.
  const bracket = await getPlayoffBracket(SEASON_ID);
  const seeds = await getSeasonSeeds(SEASON_ID);
  const seedCount = seeds.AFC.length + seeds.NFC.length;
  const expectedChampTeam = championOsId !== undefined ? teamById.get(championOsId) : undefined;
  const champOk =
    !!expectedChampTeam &&
    bracket.championTeamName?.toLowerCase() === expectedChampTeam.toLowerCase();
  log('--- Validation ---');
  log(`Seeds generated: ${seedCount} (expect 14).`);
  log(
    `Champion recorded: ${bracket.championTeamName ?? '(none)'} / ${bracket.championOwnerName ?? '(none)'}` +
      ` — sheet says ${expectedChampTeam ?? '?'} / ${champion?.owner ?? '?'} ${champOk ? 'OK' : 'MISMATCH'}`,
  );

  const [award] = await db
    .select()
    .from(seasonAwards)
    .where(and(eq(seasonAwards.seasonId, SEASON_ID), eq(seasonAwards.type, 'champion')))
    .limit(1);
  log(award ? `✓ seasonAwards champion row exists (ownerSeasonId=${award.ownerSeasonId}).` : '✗ No champion award row.');

  const overall = seedCount === 14 && champOk && unresolved.size === 0 && !!award;
  log(`\nOVERALL: ${overall ? 'PASS' : 'CHECK'}`);
  return overall;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err: unknown) => {
    console.error('import-playoffs failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
