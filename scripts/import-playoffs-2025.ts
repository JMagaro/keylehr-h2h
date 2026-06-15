/**
 * Import & validate the 2025 (Season 3) PLAYOFFS from the league's Google Sheet.
 *
 * The `Playoff Bracket` tab is a VISUAL bracket: columns are grouped per round
 * (Wild Card / Divisional / Conference / Super Bowl / Champion) and each
 * participant cell carries that owner's seed, NFL team, owner name, and the
 * round's DFS score. We parse out each owner's per-round score and write them as
 * `scores` rows for weeks 19–22, then run the playoff service to seed + advance
 * the bracket and validate the result against ground truth.
 *
 * Round → week: wild_card=19, divisional=20, conference=21, championship=22.
 *
 * Note on the championship: the sheet's bracket shows the Super Bowl matchup
 * (Jaguars vs 49ers) and the Champion (49ers / Gary Lehr) but records NO points
 * for the title game. Since both participants need scores to auto-resolve, we
 * record the champion via the service's manual winner override after advancing
 * the scored rounds. This is honest: the sheet itself provides no title-game
 * points, only the outcome.
 *
 * Usage:  tsx scripts/import-playoffs-2025.ts
 * Idempotent / re-runnable. Reads the public sheet over HTTP (no auth).
 */
import '@/load-env'; // MUST be first — before any module that reads process.env (e.g. @/db)

import { and, eq } from 'drizzle-orm';

import { db, ownerSeasons, nflTeams, playoffMatchups, scores, seasonAwards } from '@/db';
import {
  advancePlayoffs,
  generatePlayoffBracket,
  getPlayoffBracket,
  PLAYOFF_ROUND_WEEKS,
  setGameWinner,
} from '@/lib/playoffs/service';
import { getSeasonSeeds } from '@/lib/standings/query';
import type { Conference } from '@/lib/standings';

const SHEET_ID = '1FsZRCawf2w0nvTigQ5_GjL4fT-MC-P5zfcZZTphsySU';
const SEASON_ID = 2; // 2025 season
const BRACKET_TAB = 'Playoff Bracket';

/** Column base offset for each round block in the visual bracket. */
const ROUND_BASE: Record<'wild_card' | 'divisional' | 'conference' | 'championship', number> = {
  wild_card: 0,
  divisional: 5,
  conference: 10,
  championship: 15,
};
/** Within a block: seed at base, team at base+2, owner at base+3, score at base+4. */
const SEED_OFFSET = 0;
const TEAM_OFFSET = 2;
const OWNER_OFFSET = 3;
const SCORE_OFFSET = 4;

/* -------------------------------------------------------------------------- */
/* CSV fetch + parse                                                          */
/* -------------------------------------------------------------------------- */

function tabUrl(tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tab,
  )}`;
}

/** Minimal RFC-4180-ish CSV parser (handles quoted fields + embedded commas). */
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
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // ignore; handled by \n
    } else {
      field += ch;
    }
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

/* -------------------------------------------------------------------------- */
/* Bracket parse → per-round, per-team scores                                  */
/* -------------------------------------------------------------------------- */

type Round = keyof typeof ROUND_BASE;

interface ParsedCell {
  seed: number;
  team: string;
  owner: string;
  score: number | null;
}

/**
 * Parse the visual bracket into { round → (team → score) } for scored rounds.
 *
 * Some round blocks (the Conference Championship column) show the owner name
 * but NOT the team in the cell, so we also build an owner-name → team map from
 * every cell that DOES carry a team, then resolve owner-only cells through it.
 */
function parseBracket(rows: string[][]): {
  scoresByRound: Record<Round, Map<string, number>>;
  cellsByRound: Record<Round, ParsedCell[]>;
} {
  const scoresByRound = {
    wild_card: new Map<string, number>(),
    divisional: new Map<string, number>(),
    conference: new Map<string, number>(),
    championship: new Map<string, number>(),
  };
  const cellsByRound: Record<Round, ParsedCell[]> = {
    wild_card: [],
    divisional: [],
    conference: [],
    championship: [],
  };

  // First pass: collect every cell + an owner→team map from cells that have a team.
  const teamByOwner = new Map<string, string>();
  for (const raw of rows) {
    const r = [...raw];
    while (r.length < 25) r.push('');
    for (const round of Object.keys(ROUND_BASE) as Round[]) {
      const b = ROUND_BASE[round];
      const seedStr = (r[b + SEED_OFFSET] ?? '').trim();
      const team = (r[b + TEAM_OFFSET] ?? '').trim();
      const owner = (r[b + OWNER_OFFSET] ?? '').trim();
      const scoreStr = (r[b + SCORE_OFFSET] ?? '').trim();
      const seed = Number(seedStr);
      if (!seedStr || !Number.isFinite(seed) || !owner) continue;
      const score = scoreStr && Number.isFinite(Number(scoreStr)) ? Number(scoreStr) : null;
      cellsByRound[round].push({ seed, team, owner, score });
      if (team) teamByOwner.set(owner.toLowerCase(), team);
    }
  }

  // Second pass: map each scored cell to a team (directly, or via the owner map)
  // and record team → score per round.
  for (const round of Object.keys(ROUND_BASE) as Round[]) {
    for (const cell of cellsByRound[round]) {
      if (cell.score === null) continue;
      const team = cell.team || teamByOwner.get(cell.owner.toLowerCase()) || '';
      if (team) scoresByRound[round].set(team, cell.score);
    }
  }

  return { scoresByRound, cellsByRound };
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

interface SeedExpectation {
  seed: number;
  team: string;
  owner: string;
}

const EXPECTED_SEEDS: Record<Conference, SeedExpectation[]> = {
  AFC: [
    { seed: 1, team: 'Colts', owner: 'Josh Lehr' },
    { seed: 2, team: 'Ravens', owner: 'Matt Tepley' },
    { seed: 3, team: 'Raiders', owner: 'Ben Miller' },
    { seed: 4, team: 'Dolphins', owner: 'Will Thomas' },
    { seed: 5, team: 'Texans', owner: 'Scott Cohen' },
    { seed: 6, team: 'Broncos', owner: 'Brian Darby' },
    { seed: 7, team: 'Jaguars', owner: 'Myles Hyman' },
  ],
  NFC: [
    { seed: 1, team: 'Giants', owner: 'Andy Myers' },
    { seed: 2, team: 'Vikings', owner: 'Jake Feldman' },
    { seed: 3, team: '49ers', owner: 'Gary Lehr' },
    { seed: 4, team: 'Saints', owner: 'Scott Koretsky' },
    { seed: 5, team: 'Cowboys', owner: 'Ryan Kealy' },
    { seed: 6, team: 'Bears', owner: 'Ryan Block' },
    { seed: 7, team: 'Lions', owner: 'Chris deMartino and Zack Herman' },
  ],
};

function log(msg = ''): void {
  console.log(msg);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  log('=== Import 2025 playoffs (Season 3) ===\n');

  // ownerSeasonId ↔ team/owner lookups for this season.
  const osRows = await db
    .select({
      ownerSeasonId: ownerSeasons.id,
      team: nflTeams.name,
    })
    .from(ownerSeasons)
    .innerJoin(nflTeams, eq(ownerSeasons.nflTeamId, nflTeams.id))
    .where(eq(ownerSeasons.seasonId, SEASON_ID));
  const osIdByTeam = new Map<string, number>();
  for (const r of osRows) osIdByTeam.set(r.team.trim().toLowerCase(), r.ownerSeasonId);

  // 1. Fetch + parse the visual bracket.
  const rows = await fetchTab(BRACKET_TAB);
  const { scoresByRound, cellsByRound } = parseBracket(rows);

  // 2. Write per-round scores as `scores` rows for weeks 19–21 (championship has
  //    no points in the sheet — handled via override below). Playoff weeks have
  //    no `matchups` rows, so we upsert directly with isBye=false (these are real
  //    playoff scores, not byes) rather than via the bye-deriving ingest path.
  for (const round of ['wild_card', 'divisional', 'conference'] as const) {
    const week = PLAYOFF_ROUND_WEEKS[round];
    const byTeam = scoresByRound[round];
    if (byTeam.size === 0) {
      log(`Week ${week} (${round}): no scores parsed — skipping.`);
      continue;
    }
    let written = 0;
    const unmatched: string[] = [];
    for (const [team, points] of byTeam) {
      const osId = osIdByTeam.get(team.trim().toLowerCase());
      if (osId === undefined) {
        unmatched.push(team);
        continue;
      }
      await db
        .insert(scores)
        .values({
          seasonId: SEASON_ID,
          ownerSeasonId: osId,
          week,
          dkPoints: points.toFixed(2),
          source: 'manual',
          isBye: false,
          note: 'playoffs-import-2025',
        })
        .onConflictDoUpdate({
          target: [scores.ownerSeasonId, scores.week],
          set: {
            dkPoints: points.toFixed(2),
            source: 'manual',
            isBye: false,
            note: 'playoffs-import-2025',
            updatedAt: new Date(),
          },
        });
      written++;
    }
    log(
      `Week ${week} (${round}): wrote ${written} scores` +
        (unmatched.length ? `, UNMATCHED: ${unmatched.join(', ')}` : ''),
    );
  }
  log('');

  // 3. Generate the wild-card bracket from the computed regular-season seeds.
  const gen = await generatePlayoffBracket(SEASON_ID);
  log(`generatePlayoffBracket: ${gen.message}`);

  // 4. Advance through every fully-scored round (wild_card → conference).
  const adv1 = await advancePlayoffs(SEASON_ID);
  log(`advancePlayoffs (1): ${adv1.message}`);

  // 5. Championship: the sheet records no title-game points, only that the 49ers
  //    (Gary Lehr) won. If the championship row exists but is unresolved, set the
  //    winner via the override path and re-advance to record the champion.
  const champOsId = osIdByTeam.get('49ers');
  if (champOsId !== undefined) {
    const [titleGame] = await db
      .select({ id: playoffMatchups.id, winner: playoffMatchups.winnerOwnerSeasonId })
      .from(playoffMatchups)
      .where(
        and(eq(playoffMatchups.seasonId, SEASON_ID), eq(playoffMatchups.round, 'championship')),
      )
      .limit(1);
    if (titleGame && titleGame.winner === null) {
      const adv2 = await setGameWinner(SEASON_ID, titleGame.id, champOsId);
      log(`setGameWinner (championship → 49ers): ${adv2.message}`);
    } else if (titleGame) {
      log('Championship already resolved.');
    } else {
      log('WARNING: no championship row was generated — bracket did not reach the title game.');
    }
  }
  log('');

  // 6. Validate seeding vs ground truth (Playoff Picture tab).
  log('--- Seeding validation (engine vs ground truth) ---');
  const seeds = await getSeasonSeeds(SEASON_ID);
  let seedMismatches = 0;
  for (const conf of ['AFC', 'NFC'] as Conference[]) {
    log(`${conf}:`);
    const expected = EXPECTED_SEEDS[conf];
    const ownerByOsId = new Map(osRows.map((r) => [r.ownerSeasonId, r.team]));
    for (const exp of expected) {
      const got = seeds[conf].find((s) => s.seed === exp.seed);
      const gotTeam = got ? ownerByOsId.get(got.ownerSeasonId) ?? '?' : '(none)';
      const ok = gotTeam?.toLowerCase() === exp.team.toLowerCase();
      if (!ok) seedMismatches++;
      log(
        `  seed ${exp.seed}: expected ${exp.team}/${exp.owner} → got ${gotTeam} ${ok ? 'OK' : 'MISMATCH'}`,
      );
    }
  }
  log(seedMismatches === 0 ? '✓ Seeding matches ground truth.\n' : `✗ ${seedMismatches} seed mismatch(es).\n`);

  // 7. Validate the Super Bowl matchup + champion.
  log('--- Super Bowl + champion validation ---');
  const bracket = await getPlayoffBracket(SEASON_ID);
  const title = bracket.rounds.find((r) => r.round === 'championship')?.games[0];
  if (title) {
    const a = `${title.high.teamName}/${title.high.ownerName}`;
    const b = `${title.low.teamName}/${title.low.ownerName}`;
    const teams = [title.high.teamName, title.low.teamName].filter(Boolean);
    const sbOk = teams.includes('Jaguars') && teams.includes('49ers');
    log(`Super Bowl: ${a} vs ${b} — expected Jaguars/Myles Hyman vs 49ers/Gary Lehr ${sbOk ? 'OK' : 'MISMATCH'}`);
  } else {
    log('Super Bowl: NO championship game found — MISMATCH');
  }
  const champOk =
    bracket.championTeamName === '49ers' && bracket.championOwnerName === 'Gary Lehr';
  log(
    `Champion: ${bracket.championTeamName ?? '(none)'}/${bracket.championOwnerName ?? '(none)'} — expected 49ers/Gary Lehr ${champOk ? 'OK' : 'MISMATCH'}`,
  );

  // 8. Confirm the seasonAwards champion row exists.
  const [award] = await db
    .select()
    .from(seasonAwards)
    .where(and(eq(seasonAwards.seasonId, SEASON_ID), eq(seasonAwards.type, 'champion')))
    .limit(1);
  log(
    award
      ? `✓ seasonAwards champion row exists: ownerSeasonId=${award.ownerSeasonId}, ownerId=${award.ownerId}`
      : '✗ No seasonAwards champion row found.',
  );

  // Reference the parsed conference cells so the lint stays honest about usage.
  log(
    `\n(Parsed ${cellsByRound.wild_card.length} wild-card, ${cellsByRound.divisional.length} divisional, ` +
      `${cellsByRound.conference.length} conference, ${cellsByRound.championship.length} championship cells.)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
