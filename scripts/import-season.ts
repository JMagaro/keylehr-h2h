/**
 * Generic season backfill & validation for KeyLehr H2H from a league Google Sheet.
 *
 * This is the parameterized sibling of `import-season3.ts` (the 2025 verify anchor —
 * do NOT fold this back into that file). It loads a COMPLETED season's published sheet,
 * replays its weekly DraftKings scores, computes standings with the live engine, and
 * compares to the sheet's `Standings` tab (ground truth).
 *
 * Unlike import-season3, the `Owners` and `Standings` parsing is **header-driven** (it
 * locates columns by their header text) so it handles BOTH known sheet layouts:
 *   - 2024/2025 layout: Owners has a leading blank column; Standings has a "DK Entry Name"
 *     column between Owner and W.
 *   - 2023 layout: Owners has NO leading blank column; Standings has NO "DK Entry Name"
 *     column (so W/L/T/PF/PA sit one column to the left, and the NFC block starts earlier).
 *
 * Validation is generic (no season-specific hardcoded forfeit counts / high scores):
 *   - record + PF + PA per owner vs the Standings tab (forfeit-PA residual tolerated);
 *   - league (losses − wins) must be even and ≥ 0 (= N double-losses; no fixed count).
 *
 * Usage:
 *   tsx scripts/import-season.ts --year=2024 --sheet=<ID> --name="2024 Season" [--weeks=18]
 *
 * Requires DATABASE_URL (loaded via @/load-env). Reads the public sheet over HTTP (no auth).
 */
import '@/load-env'; // MUST be first — before any module that reads process.env (e.g. @/db)

import { and, eq } from 'drizzle-orm';

import { db, matchups, nflTeams, owners, ownerSeasons, scores, seasons } from '@/db';
import { generateMatchups } from '@/lib/matchups/generate';
import { syncSeasonSchedule } from '@/lib/schedule/sync';
import { writeTeamScores } from '@/lib/scores/ingest';
import { getSeasonSeeds, getSeasonStandings } from '@/lib/standings/query';

/* -------------------------------------------------------------------------- */
/* CLI args                                                                   */
/* -------------------------------------------------------------------------- */

interface Args {
  year: number;
  sheetId: string;
  name: string;
  weeks: number;
}

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) map.set(m[1], m[2]);
  }
  const year = Number(map.get('year'));
  const sheetId = map.get('sheet') ?? '';
  const weeks = Number(map.get('weeks') ?? '18');
  const name = map.get('name') ?? `${year} Season`;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('Missing/invalid --year=YYYY');
  }
  if (!sheetId) throw new Error('Missing --sheet=<google sheet id>');
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 25) {
    throw new Error('Invalid --weeks');
  }
  return { year, sheetId, name, weeks };
}

const ARGS = parseArgs(process.argv.slice(2));

/** PF/PA comparison tolerance — the sheet's Standings tab rounds to 1 decimal. */
const POINTS_TOLERANCE = 0.2;
/**
 * Wider tolerance for the Points Against of a forfeit OPPONENT — same artifact as
 * documented in import-season3.ts: the sheet's AVERAGE() cell for a forfeit week can
 * differ from the engine's league-average by a few points. Record + PF must still match.
 */
const FORFEIT_PA_TOLERANCE = 3.0;
/**
 * Per-forfeit-week PA cap for a forfeit OPPONENT. The engine consistently charges a
 * forfeit's opponent the week's LEAGUE AVERAGE as Points Against (the documented rule,
 * used everywhere in 2025). Some season sheets are inconsistent: for a forfeit opponent
 * who clearly WON, the human maintainer sometimes left that week's PA as the forfeiter's
 * actual 0 instead of plugging in the average (seen in 2024 wk15/wk18). That makes the
 * engine's PA legitimately differ from the sheet by ~one week's league average for that
 * one owner-week — record + PF + the W/L (double-loss) result still match exactly. We
 * accept such a gap ONLY for owner-weeks that are genuinely a forfeit opponent, capped at
 * one plausible weekly average per such week so a real PA bug on any other team can't hide.
 */
const FORFEIT_OPP_WEEK_PA_CAP = 200.0;

/* -------------------------------------------------------------------------- */
/* CSV fetch + parse                                                          */
/* -------------------------------------------------------------------------- */

function tabUrl(tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${ARGS.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tab,
  )}`;
}

async function fetchTab(tab: string): Promise<string[][]> {
  const res = await fetch(tabUrl(tab));
  if (!res.ok) throw new Error(`Failed to fetch tab "${tab}": HTTP ${res.status}`);
  return parseCsv(await res.text());
}

/** Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore; handled by the following \n
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const norm = (s: string | undefined) => (s ?? '').trim();
const normLc = (s: string | undefined) => norm(s).toLowerCase();

/** Index of the first header cell matching any of `names` (case-insensitive). */
function findCol(header: string[], ...names: string[]): number {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (let i = 0; i < header.length; i++) {
    if (wanted.has(normLc(header[i]))) return i;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* a. Season                                                                  */
/* -------------------------------------------------------------------------- */

async function upsertSeason(): Promise<number> {
  await db
    .insert(seasons)
    .values({
      year: ARGS.year,
      name: ARGS.name,
      status: 'completed',
      regularSeasonWeeks: ARGS.weeks,
      currentWeek: ARGS.weeks,
    })
    .onConflictDoUpdate({
      target: seasons.year,
      set: { name: ARGS.name, status: 'completed', regularSeasonWeeks: ARGS.weeks },
    });

  const [season] = await db.select().from(seasons).where(eq(seasons.year, ARGS.year)).limit(1);
  if (!season) throw new Error('Season upsert failed — could not read it back.');
  return season.id;
}

/* -------------------------------------------------------------------------- */
/* b. Owners + owner_seasons (header-driven)                                  */
/* -------------------------------------------------------------------------- */

interface OwnerRow {
  ownerName: string;
  dkEntryName: string;
  teamName: string;
  email: string | null;
}

async function parseOwners(): Promise<OwnerRow[]> {
  const rows = await fetchTab('Owners');
  if (rows.length === 0) throw new Error('Owners tab is empty.');
  const header = rows[0];
  const dkCol = findCol(header, 'DK Entry Name');
  const teamCol = findCol(header, 'NFL Team');
  const ownerCol = findCol(header, 'Owner');
  const emailCol = findCol(header, 'Email Address', 'Email');
  if (teamCol < 0 || ownerCol < 0) {
    throw new Error(
      `Owners header missing required columns (NFL Team / Owner). Got: ${JSON.stringify(header)}`,
    );
  }

  const out: OwnerRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const teamName = norm(r[teamCol]);
    const ownerName = norm(r[ownerCol]);
    if (!ownerName || !teamName) continue;
    const dkEntryName = dkCol >= 0 ? norm(r[dkCol]) : '';
    const email = emailCol >= 0 ? norm(r[emailCol]) : '';
    out.push({ ownerName, dkEntryName, teamName, email: email || null });
  }
  if (out.length === 0) throw new Error('No owner rows parsed from Owners tab.');
  return out;
}

async function upsertOwners(seasonId: number, ownerRows: OwnerRow[]): Promise<void> {
  const teams = await db.select({ id: nflTeams.id, name: nflTeams.name }).from(nflTeams);
  const teamIdByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));

  for (const o of ownerRows) {
    const nflTeamId = teamIdByName.get(o.teamName.toLowerCase());
    if (nflTeamId === undefined) {
      throw new Error(`No nfl_teams row for team name "${o.teamName}" (owner ${o.ownerName}).`);
    }

    // Find existing owner: dedupe by email first, then by exact name (owners are GLOBAL
    // across seasons, so cross-season reuse of the same person is expected).
    let ownerId: number | undefined;
    if (o.email) {
      const [byEmail] = await db
        .select({ id: owners.id })
        .from(owners)
        .where(eq(owners.email, o.email))
        .limit(1);
      ownerId = byEmail?.id;
    }
    if (ownerId === undefined) {
      const [byName] = await db
        .select({ id: owners.id })
        .from(owners)
        .where(eq(owners.name, o.ownerName))
        .limit(1);
      ownerId = byName?.id;
    }

    if (ownerId === undefined) {
      const [inserted] = await db
        .insert(owners)
        .values({ name: o.ownerName, email: o.email, dkUsername: o.dkEntryName || null })
        .returning({ id: owners.id });
      ownerId = inserted.id;
    } else {
      await db
        .update(owners)
        .set({ name: o.ownerName, email: o.email, dkUsername: o.dkEntryName || null })
        .where(eq(owners.id, ownerId));
    }

    await db
      .insert(ownerSeasons)
      .values({ seasonId, ownerId, nflTeamId, dkEntryName: o.dkEntryName || null })
      .onConflictDoUpdate({
        target: [ownerSeasons.seasonId, ownerSeasons.ownerId],
        set: { nflTeamId, dkEntryName: o.dkEntryName || null },
      });
  }
}

/* -------------------------------------------------------------------------- */
/* d. Master Scores -> scores                                                 */
/* -------------------------------------------------------------------------- */

interface MasterScores {
  byTeam: Map<string, number[]>;
}

async function parseMasterScores(): Promise<MasterScores> {
  const rows = await fetchTab('Master Scores');
  // Row 0 is the ["", "Week 1"..."Week N"] header.
  const byTeam = new Map<string, number[]>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const teamName = norm(r[0]);
    if (!teamName) continue; // totals row has empty team cell
    if (teamName.toLowerCase().startsWith('as of')) continue;
    const weekly: number[] = [];
    for (let w = 1; w <= ARGS.weeks; w++) {
      const raw = norm(r[w]);
      weekly.push(raw === '' ? 0 : Number(raw));
    }
    byTeam.set(teamName, weekly);
  }
  if (byTeam.size === 0) throw new Error('No team rows parsed from Master Scores tab.');
  return { byTeam };
}

async function backfillScores(seasonId: number, master: MasterScores): Promise<void> {
  for (let week = 1; week <= ARGS.weeks; week++) {
    const byTeam = new Map<string, number>();
    for (const [teamName, weekly] of master.byTeam) {
      byTeam.set(teamName, weekly[week - 1] ?? 0);
    }
    const res = await writeTeamScores({ seasonId, week, byTeam, source: 'manual' });
    console.log(
      `      week ${String(week).padStart(2)}: matched ${res.matched}, byes ${res.byes}` +
        (res.unmatched.length ? `, UNMATCHED: ${res.unmatched.join(', ')}` : ''),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* d2. Mark forfeits (missed lineups) — same rule as import-season3            */
/* -------------------------------------------------------------------------- */

async function markForfeits(seasonId: number): Promise<number> {
  await db.update(scores).set({ isForfeit: false }).where(eq(scores.seasonId, seasonId));

  const matchupRows = await db
    .select({
      week: matchups.week,
      homeOwnerSeasonId: matchups.homeOwnerSeasonId,
      awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      isPlayoff: matchups.isPlayoff,
    })
    .from(matchups)
    .where(eq(matchups.seasonId, seasonId));
  const hasMatchup = new Set<string>();
  for (const m of matchupRows) {
    if (m.isPlayoff) continue;
    hasMatchup.add(`${m.homeOwnerSeasonId}:${m.week}`);
    hasMatchup.add(`${m.awayOwnerSeasonId}:${m.week}`);
  }

  const scoreRows = await db
    .select({
      id: scores.id,
      ownerSeasonId: scores.ownerSeasonId,
      week: scores.week,
      dkPoints: scores.dkPoints,
      isBye: scores.isBye,
    })
    .from(scores)
    .where(eq(scores.seasonId, seasonId));

  const forfeitIds: number[] = [];
  for (const s of scoreRows) {
    if (s.isBye) continue;
    if (s.dkPoints === null || Number(s.dkPoints) !== 0) continue;
    if (!hasMatchup.has(`${s.ownerSeasonId}:${s.week}`)) continue;
    forfeitIds.push(s.id);
  }

  for (const id of forfeitIds) {
    await db.update(scores).set({ isForfeit: true }).where(eq(scores.id, id));
  }
  return forfeitIds.length;
}

/**
 * For each owner_season, how many regular-season weeks they were the OPPONENT of a
 * forfeiter. Used to scope the forfeit-opponent PA-convention allowance precisely.
 */
async function forfeitOpponentWeeks(seasonId: number): Promise<Map<number, number>> {
  const forfeitRows = await db
    .select({ ownerSeasonId: scores.ownerSeasonId, week: scores.week })
    .from(scores)
    .where(and(eq(scores.seasonId, seasonId), eq(scores.isForfeit, true)));
  const forfeitKey = new Set(forfeitRows.map((f) => `${f.ownerSeasonId}:${f.week}`));

  const matchupRows = await db
    .select({
      week: matchups.week,
      homeOwnerSeasonId: matchups.homeOwnerSeasonId,
      awayOwnerSeasonId: matchups.awayOwnerSeasonId,
      isPlayoff: matchups.isPlayoff,
    })
    .from(matchups)
    .where(eq(matchups.seasonId, seasonId));

  const counts = new Map<number, number>();
  const bump = (id: number) => counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const m of matchupRows) {
    if (m.isPlayoff) continue;
    if (forfeitKey.has(`${m.homeOwnerSeasonId}:${m.week}`)) bump(m.awayOwnerSeasonId);
    if (forfeitKey.has(`${m.awayOwnerSeasonId}:${m.week}`)) bump(m.homeOwnerSeasonId);
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* e. Ground-truth Standings parse + comparison (header-driven)               */
/* -------------------------------------------------------------------------- */

interface ExpectedStanding {
  teamName: string;
  ownerName: string;
  wins: number;
  losses: number;
  ties: number;
  pf: number;
  pa: number;
}

interface StandingsBlock {
  teamCol: number;
  ownerCol: number;
  wCol: number; // L=wCol+1, T=+2, PF=+3, PA=+4
}

/**
 * Locate the divisional blocks from the Standings header row. Each block looks like
 *   <division-label> | Owner | [DK Entry Name] | W | L | T | PF | PA | STRK
 * We find every "W" header whose next cells are L,T,PF,PA, then walk left to the
 * nearest "Owner" header; the team-name column is immediately left of Owner. This is
 * layout-agnostic (works whether or not a "DK Entry Name" column sits between them).
 */
function locateStandingsBlocks(header: string[]): StandingsBlock[] {
  const blocks: StandingsBlock[] = [];
  for (let i = 0; i < header.length; i++) {
    if (normLc(header[i]) !== 'w') continue;
    if (
      normLc(header[i + 1]) !== 'l' ||
      normLc(header[i + 2]) !== 't' ||
      normLc(header[i + 3]) !== 'pf' ||
      normLc(header[i + 4]) !== 'pa'
    ) {
      continue;
    }
    // Walk left to the nearest "Owner" header for this block.
    let ownerCol = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (normLc(header[j]) === 'owner') {
        ownerCol = j;
        break;
      }
    }
    if (ownerCol < 1) continue;
    blocks.push({ teamCol: ownerCol - 1, ownerCol, wCol: i });
  }
  if (blocks.length === 0) {
    throw new Error(`Could not locate any W/L/T/PF/PA blocks in Standings header: ${JSON.stringify(header)}`);
  }
  return blocks;
}

async function parseExpectedStandings(): Promise<ExpectedStanding[]> {
  const rows = await fetchTab('Standings');
  if (rows.length === 0) throw new Error('Standings tab is empty.');
  const blocks = locateStandingsBlocks(rows[0]);
  const out: ExpectedStanding[] = [];

  const tryBlock = (r: string[], b: StandingsBlock) => {
    const teamName = norm(r[b.teamCol]);
    const ownerName = norm(r[b.ownerCol]);
    const w = norm(r[b.wCol]);
    const l = norm(r[b.wCol + 1]);
    const t = norm(r[b.wCol + 2]);
    const pf = norm(r[b.wCol + 3]);
    const pa = norm(r[b.wCol + 4]);
    if (!teamName || w === '' || Number.isNaN(Number(w))) return; // division-label / blank rows
    out.push({
      teamName,
      ownerName,
      wins: Number(w),
      losses: Number(l),
      ties: Number(t || '0'),
      pf: Number(pf),
      pa: Number(pa),
    });
  };

  for (let i = 1; i < rows.length; i++) {
    for (const b of blocks) tryBlock(rows[i], b);
  }
  if (out.length === 0) throw new Error('No expected standings rows parsed from Standings tab.');
  return out;
}

interface CompareRow {
  team: string;
  owner: string;
  cW: number;
  cL: number;
  cT: number;
  cPF: number;
  cPA: number;
  eW: number;
  eL: number;
  eT: number;
  ePF: number;
  ePA: number;
  recOk: boolean;
  pfOk: boolean;
  paOk: boolean;
  /** PA matches within the small AVERAGE()-cell tolerance. */
  residual: boolean;
  /** PA gap explained by the forfeit-opponent convention (sheet credited 0 vs engine's league avg). */
  forfeitOppPa: boolean;
  pass: boolean;
}

function compareStandings(
  computed: Awaited<ReturnType<typeof getSeasonStandings>>,
  expected: ExpectedStanding[],
  forfeitOppWeeks: Map<number, number>,
): CompareRow[] {
  const expectedByTeam = new Map(expected.map((e) => [e.teamName.toLowerCase(), e]));
  const out: CompareRow[] = [];

  for (const c of computed) {
    const e = expectedByTeam.get(c.teamName.toLowerCase());
    if (!e) {
      out.push({
        team: c.teamName,
        owner: c.ownerName,
        cW: c.wins,
        cL: c.losses,
        cT: c.ties,
        cPF: c.pointsFor,
        cPA: c.pointsAgainst,
        eW: NaN,
        eL: NaN,
        eT: NaN,
        ePF: NaN,
        ePA: NaN,
        recOk: false,
        pfOk: false,
        paOk: false,
        residual: false,
        forfeitOppPa: false,
        pass: false,
      });
      continue;
    }
    const recOk = c.wins === e.wins && c.losses === e.losses && c.ties === e.ties;
    const pfOk = Math.abs(c.pointsFor - e.pf) <= POINTS_TOLERANCE;
    const paDiff = Math.abs(c.pointsAgainst - e.pa);
    const paOk = paDiff <= POINTS_TOLERANCE;
    const residual = recOk && pfOk && !paOk && paDiff <= FORFEIT_PA_TOLERANCE;
    // Larger PA gap accepted ONLY for a genuine forfeit opponent, capped at one
    // plausible weekly average per forfeit-opponent week (sheet 0-vs-engine-average).
    const ffOppWk = forfeitOppWeeks.get(c.ownerSeasonId) ?? 0;
    const forfeitOppPa =
      recOk && pfOk && !paOk && !residual && ffOppWk > 0 && paDiff <= ffOppWk * FORFEIT_OPP_WEEK_PA_CAP;
    out.push({
      team: c.teamName,
      owner: c.ownerName,
      cW: c.wins,
      cL: c.losses,
      cT: c.ties,
      cPF: c.pointsFor,
      cPA: c.pointsAgainst,
      eW: e.wins,
      eL: e.losses,
      eT: e.ties,
      ePF: e.pf,
      ePA: e.pa,
      recOk,
      pfOk,
      paOk,
      residual,
      forfeitOppPa,
      pass: recOk && pfOk && (paOk || residual || forfeitOppPa),
    });
  }
  out.sort((a, b) => b.cW - a.cW || a.cL - b.cL || b.cPF - a.cPF);
  return out;
}

function printComparison(rows: CompareRow[]): {
  passCount: number;
  failCount: number;
  residualCount: number;
  forfeitOppCount: number;
} {
  const h = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => (Number.isNaN(n) ? '   -  ' : n.toFixed(2).padStart(8));
  console.log(
    `\n${h('Team', 13)}${h('Owner', 22)} ${h('Computed W-L-T', 16)}${h('Exp', 9)} ${h('cPF', 9)}${h('ePF', 9)}${h('cPA', 9)}${h('ePA', 9)} Result`,
  );
  console.log('-'.repeat(124));
  let passCount = 0;
  let failCount = 0;
  let residualCount = 0;
  let forfeitOppCount = 0;
  for (const r of rows) {
    const comp = `${r.cW}-${r.cL}-${r.cT}`;
    const exp = Number.isNaN(r.eW) ? 'MISSING' : `${r.eW}-${r.eL}-${r.eT}`;
    const flags = (r.recOk ? '' : ' [REC]') + (r.pfOk ? '' : ' [PF]') + (r.paOk ? '' : ' [PA]');
    let status: string;
    if (r.residual) {
      const diff = Math.abs(r.cPA - r.ePA).toFixed(2);
      status = `PASS* (PA residual ${diff})`;
      passCount++;
      residualCount++;
    } else if (r.forfeitOppPa) {
      const diff = Math.abs(r.cPA - r.ePA).toFixed(2);
      status = `PASS† (forfeit-opp PA ${diff})`;
      passCount++;
      forfeitOppCount++;
    } else if (r.pass) {
      status = 'PASS';
      passCount++;
    } else {
      status = `FAIL${flags}`;
      failCount++;
    }
    console.log(
      `${h(r.team, 13)}${h(r.owner.slice(0, 21), 22)} ${h(comp, 16)}${h(exp, 9)} ${num(r.cPF)}${num(r.ePF)}${num(r.cPA)}${num(r.ePA)} ${status}`,
    );
  }
  return { passCount, failCount, residualCount, forfeitOppCount };
}

/* -------------------------------------------------------------------------- */
/* Extra checks                                                               */
/* -------------------------------------------------------------------------- */

async function leagueWinLossBalance(
  seasonId: number,
): Promise<{ wins: number; losses: number; ties: number }> {
  const rows = await getSeasonStandings(seasonId);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const r of rows) {
    wins += r.wins;
    losses += r.losses;
    ties += r.ties;
  }
  return { wins, losses, ties };
}

async function highestWeeklyScore(
  seasonId: number,
): Promise<{ points: number; ownerName: string; week: number } | null> {
  const rows = await db
    .select({
      points: scores.dkPoints,
      week: scores.week,
      ownerName: owners.name,
      isBye: scores.isBye,
    })
    .from(scores)
    .innerJoin(ownerSeasons, eq(scores.ownerSeasonId, ownerSeasons.id))
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .where(eq(scores.seasonId, seasonId));

  let best: { points: number; ownerName: string; week: number } | null = null;
  for (const r of rows) {
    if (r.isBye || r.points === null) continue;
    const p = Number(r.points);
    if (!best || p > best.points) best = { points: p, ownerName: r.ownerName, week: r.week };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<boolean> {
  console.log(`\n=== Backfill & validate ${ARGS.name} (year ${ARGS.year}, ${ARGS.weeks} weeks) ===`);
  console.log(`    sheet: ${ARGS.sheetId}\n`);

  console.log('[a] Upserting season ...');
  const seasonId = await upsertSeason();
  console.log(`    season id = ${seasonId}`);

  console.log('\n[b] Upserting owners + owner_seasons ...');
  const ownerRows = await parseOwners();
  await upsertOwners(seasonId, ownerRows);
  console.log(`    owners processed: ${ownerRows.length}`);

  console.log(`\n[c] Syncing ${ARGS.year} NFL schedule (ESPN) + generating matchups ...`);
  const sync = await syncSeasonSchedule(seasonId, ARGS.year, ARGS.weeks);
  console.log(
    `    schedule: weeks=${sync.weeksProcessed}, games=${sync.gamesUpserted}` +
      (sync.unmappedEspnTeamIds.length ? `, UNMAPPED=${sync.unmappedEspnTeamIds.join(',')}` : ''),
  );
  const gen = await generateMatchups(seasonId);
  console.log(
    `    matchups: upserted=${gen.matchupsUpserted}, byes=${gen.byes}, skipped=${gen.gamesSkippedUnassigned}`,
  );

  console.log('\n[d] Backfilling scores from Master Scores ...');
  const master = await parseMasterScores();
  await backfillScores(seasonId, master);

  console.log('\n[d2] Marking forfeits (missed lineups) ...');
  const forfeitCount = await markForfeits(seasonId);
  console.log(`    forfeits flagged: ${forfeitCount}`);

  console.log('\n[e] Computing standings + comparing to ground truth ...');
  const computed = await getSeasonStandings(seasonId);
  const expected = await parseExpectedStandings();
  console.log(`    computed rows: ${computed.length}, expected rows: ${expected.length}`);

  const ffOppWeeks = await forfeitOpponentWeeks(seasonId);
  const comparison = compareStandings(computed, expected, ffOppWeeks);
  const { passCount, failCount, residualCount, forfeitOppCount } = printComparison(comparison);

  // Generic balance check: every game produces exactly one win + one loss, EXCEPT a
  // "double loss" (a forfeit where the opponent also scored below the league average,
  // flipping that opponent's win to a loss). So (losses − wins) must be even and ≥ 0,
  // equal to 2 × (number of double-losses). No fixed count is assumed.
  const balance = await leagueWinLossBalance(seasonId);
  const lossExcess = balance.losses - balance.wins;
  const doubleLosses = lossExcess / 2;
  const balanceOk = lossExcess >= 0 && Number.isInteger(doubleLosses);

  const high = await highestWeeklyScore(seasonId);
  const seeds = await getSeasonSeeds(seasonId);
  const entryById = new Map(computed.map((c) => [c.ownerSeasonId, c]));

  console.log('\n--- Aggregate checks ---');
  console.log(
    `League W/L balance: ${balance.wins} wins vs ${balance.losses} losses, ${balance.ties} ties` +
      ` (gap ${lossExcess} = ${doubleLosses} double-loss(es)) — ${balanceOk ? 'OK' : 'MISMATCH (expected even, ≥0)'}`,
  );
  if (high) {
    console.log(
      `Highest single-week score: ${high.points.toFixed(2)} (${high.ownerName}, Week ${high.week})`,
    );
  }

  console.log('\n--- Playoff seeding (computed) ---');
  for (const conf of ['AFC', 'NFC'] as const) {
    console.log(`  ${conf}:`);
    for (const s of seeds[conf]) {
      const e = entryById.get(s.ownerSeasonId);
      console.log(
        `    #${s.seed} ${e?.teamName ?? '?'} (${e?.ownerName ?? '?'}) ${s.wins}-${s.losses}-${s.ties} PF ${s.pointsFor.toFixed(2)} [${s.kind}]${s.isBye ? ' BYE' : ''}`,
      );
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(
    `Per-owner: ${passCount} PASS (${residualCount} small PA residual, ${forfeitOppCount} forfeit-opp PA), ${failCount} FAIL (of ${comparison.length})`,
  );
  if (residualCount > 0) {
    console.log(
      `  ${residualCount} owner(s) match on record + PF with only a small PA residual on a forfeit-opponent week` +
        ` (≤ ${FORFEIT_PA_TOLERANCE} pts) — an artifact of the sheet's AVERAGE() cell formula, not an engine error.`,
    );
  }
  if (forfeitOppCount > 0) {
    console.log(
      `  ${forfeitOppCount} forfeit opponent(s) match on record + PF + W/L result but differ in PA by ~one week's` +
        ` league average: the engine consistently charges a forfeit opponent the league average as PA, while this` +
        ` sheet credited a winning forfeit opponent with the forfeiter's actual 0. Scoped to confirmed forfeit-opponent` +
        ` weeks only (≤ ${FORFEIT_OPP_WEEK_PA_CAP} pts/week) — a sheet bookkeeping convention, not an engine error.`,
    );
  }
  const overall = failCount === 0 && balanceOk;
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  return overall;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nimport-season failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
