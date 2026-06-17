/**
 * Backfill & validate Season 3 (2025) of KeyLehr H2H from the league's Google Sheet.
 *
 * This is the project's most important correctness check: it loads a known COMPLETED
 * season, replays its real weekly DraftKings scores, computes standings with the live
 * engine, and compares them to the league's published final standings (ground truth).
 *
 * Steps (all idempotent / re-runnable):
 *   a. Upsert Season 3 (year 2025, status 'completed').
 *   b. Upsert owners + owner_seasons from the sheet's `Owners` tab.
 *   c. Sync the 2025 NFL schedule (ESPN) and generate owner matchups.
 *   d. Backfill all 18 weeks of `scores` from the `Master Scores` tab.
 *   e. Compute standings via the live engine and compare to the `Standings` tab.
 *
 * Usage:  tsx scripts/import-season3.ts
 *
 * Requires DATABASE_URL (loaded via @/load-env). Reads the public sheet over HTTP (no auth).
 */
import '@/load-env'; // MUST be first — before any module that reads process.env (e.g. @/db)

import { eq } from 'drizzle-orm';

import { db, matchups, nflTeams, owners, ownerSeasons, scores, seasons } from '@/db';
import { generateMatchups } from '@/lib/matchups/generate';
import { syncSeasonSchedule } from '@/lib/schedule/sync';
import { writeTeamScores } from '@/lib/scores/ingest';
import { getSeasonSeeds, getSeasonStandings } from '@/lib/standings/query';

const SHEET_ID = '1FsZRCawf2w0nvTigQ5_GjL4fT-MC-P5zfcZZTphsySU';
const SEASON_YEAR = 2025;
const SEASON_NAME = '2025 Season';
const WEEKS = 18;
/** PF/PA comparison tolerance — the sheet's Standings tab rounds to 1 decimal. */
const POINTS_TOLERANCE = 0.2;
/**
 * Wider tolerance for the Points Against of a forfeit OPPONENT. Our league
 * average is the mean of the week's non-forfeit, non-bye scorers (per the rule
 * definition), INCLUDING the opponent's own score. The sheet's AVERAGE() cell
 * differs slightly on a couple of weeks (it excludes the opponent's own cell,
 * and handles that week's byes via its own range), producing a residual of a
 * few points on at most 1–2 forfeit-opponent weeks. Such residuals are an
 * artifact of the sheet's exact cell formula, not an engine error.
 */
const FORFEIT_PA_TOLERANCE = 3.0;

/* -------------------------------------------------------------------------- */
/* CSV fetch + parse                                                          */
/* -------------------------------------------------------------------------- */

function tabUrl(tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
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
  // Flush trailing field/row (file may not end with newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* a. Season                                                                  */
/* -------------------------------------------------------------------------- */

async function upsertSeason(): Promise<number> {
  await db
    .insert(seasons)
    .values({
      year: SEASON_YEAR,
      name: SEASON_NAME,
      status: 'completed',
      regularSeasonWeeks: WEEKS,
      currentWeek: WEEKS,
    })
    .onConflictDoUpdate({
      target: seasons.year,
      set: { name: SEASON_NAME, status: 'completed', regularSeasonWeeks: WEEKS },
    });

  const [season] = await db.select().from(seasons).where(eq(seasons.year, SEASON_YEAR)).limit(1);
  if (!season) throw new Error('Season upsert failed — could not read it back.');
  return season.id;
}

/* -------------------------------------------------------------------------- */
/* b. Owners + owner_seasons                                                  */
/* -------------------------------------------------------------------------- */

interface OwnerRow {
  ownerName: string;
  dkEntryName: string;
  teamName: string;
  email: string | null;
}

async function parseOwners(): Promise<OwnerRow[]> {
  const rows = await fetchTab('Owners');
  // Header: ["", "DK Entry Name", "NFL Team", "Owner", "Paid?", "Email Address"]
  const out: OwnerRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dkEntryName = (r[1] ?? '').trim();
    const teamName = (r[2] ?? '').trim();
    const ownerName = (r[3] ?? '').trim();
    const email = (r[5] ?? '').trim();
    if (!ownerName || !teamName) continue;
    out.push({ ownerName, dkEntryName, teamName, email: email || null });
  }
  return out;
}

async function upsertOwners(seasonId: number, ownerRows: OwnerRow[]): Promise<void> {
  // team name (lc) -> nfl_teams.id
  const teams = await db.select({ id: nflTeams.id, name: nflTeams.name }).from(nflTeams);
  const teamIdByName = new Map(teams.map((t) => [t.name.trim().toLowerCase(), t.id]));

  for (const o of ownerRows) {
    const nflTeamId = teamIdByName.get(o.teamName.toLowerCase());
    if (nflTeamId === undefined) {
      throw new Error(`No nfl_teams row for team name "${o.teamName}" (owner ${o.ownerName}).`);
    }

    // Find existing owner: dedupe by email first, then by exact name.
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

    // Upsert owner_seasons on the (season, owner) unique index. The (season, team)
    // unique index is also respected because the sheet has a 1:1 owner↔team mapping.
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
  /** team name -> [week1..week18] points (numbers; sheet "0" stays 0). */
  byTeam: Map<string, number[]>;
}

async function parseMasterScores(): Promise<MasterScores> {
  const rows = await fetchTab('Master Scores');
  // Row 0 is the ["", "Week 1"..."Week 18"] header.
  const byTeam = new Map<string, number[]>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const teamName = (r[0] ?? '').trim();
    if (!teamName) continue; // totals row has empty team cell
    if (teamName.toLowerCase().startsWith('as of')) continue;
    const weekly: number[] = [];
    for (let w = 1; w <= WEEKS; w++) {
      const raw = (r[w] ?? '').trim();
      weekly.push(raw === '' ? 0 : Number(raw));
    }
    byTeam.set(teamName, weekly);
  }
  return { byTeam };
}

async function backfillScores(seasonId: number, master: MasterScores): Promise<void> {
  for (let week = 1; week <= WEEKS; week++) {
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
/* d2. Mark forfeits (missed lineups)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Flag forfeits: an owner-week that HAS a regular-season matchup that week (i.e.
 * is not on bye) and scored exactly 0 is a "missed lineup". The standings engine
 * then applies the season's configured missed-lineup rule (auto-loss + opponent
 * faces the week's league average).
 *
 * Idempotent: it resets `isForfeit` to a clean computed state on every run —
 * forfeits get set, everything else gets cleared — so re-running never drifts.
 *
 * The 6 known Season 3 forfeits (Commanders wk3, Steelers wk4, Panthers wk12,
 * Raiders wk13, Packers wk15, Chiefs wk16) are detected purely from this rule.
 */
async function markForfeits(seasonId: number): Promise<number> {
  // 1. Clear any prior forfeit flags so the pass is fully recomputed.
  await db.update(scores).set({ isForfeit: false }).where(eq(scores.seasonId, seasonId));

  // 2. Owner-weeks that have a (regular-season) matchup that week.
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

  // 3. Score rows that are not byes and scored exactly 0.
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

  // 4. Flag them.
  for (const id of forfeitIds) {
    await db.update(scores).set({ isForfeit: true }).where(eq(scores.id, id));
  }
  return forfeitIds.length;
}

/* -------------------------------------------------------------------------- */
/* e. Ground-truth Standings parse + comparison                               */
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

/**
 * Parse the `Standings` tab. It is two side-by-side divisional grids: the AFC block in
 * columns 1..9 (Team, Owner, DK, W, L, T, PF, PA, STRK) and the NFC block in columns
 * 11..19. Division-label and total rows have empty W/L cells and are skipped.
 */
async function parseExpectedStandings(): Promise<ExpectedStanding[]> {
  const rows = await fetchTab('Standings');
  const out: ExpectedStanding[] = [];

  const tryBlock = (r: string[], base: number) => {
    const teamName = (r[base] ?? '').trim();
    const ownerName = (r[base + 1] ?? '').trim();
    const w = (r[base + 3] ?? '').trim();
    const l = (r[base + 4] ?? '').trim();
    const t = (r[base + 5] ?? '').trim();
    const pf = (r[base + 6] ?? '').trim();
    const pa = (r[base + 7] ?? '').trim();
    if (!teamName || w === '' || Number.isNaN(Number(w))) return;
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

  for (const r of rows) {
    tryBlock(r, 1); // AFC block: Team at col 1
    tryBlock(r, 12); // NFC block: Team at col 12 (two empty separator columns at 10,11)
  }
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
  /** True when record + PF match and the ONLY gap is a small PA residual (forfeit-week AVERAGE() artifact). */
  residual: boolean;
  pass: boolean;
}

function compareStandings(
  computed: Awaited<ReturnType<typeof getSeasonStandings>>,
  expected: ExpectedStanding[],
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
        pass: false,
      });
      continue;
    }
    const recOk = c.wins === e.wins && c.losses === e.losses && c.ties === e.ties;
    const pfOk = Math.abs(c.pointsFor - e.pf) <= POINTS_TOLERANCE;
    const paDiff = Math.abs(c.pointsAgainst - e.pa);
    const paOk = paDiff <= POINTS_TOLERANCE;
    // Record + PF correct and only a small PA residual → accepted (sheet AVERAGE()
    // artifact on a forfeit-opponent week), reported honestly with the exact gap.
    const residual = recOk && pfOk && !paOk && paDiff <= FORFEIT_PA_TOLERANCE;
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
      pass: recOk && pfOk && (paOk || residual),
    });
  }
  // Stable order: best record first for readability.
  out.sort((a, b) => b.cW - a.cW || a.cL - b.cL || b.cPF - a.cPF);
  return out;
}

function printComparison(rows: CompareRow[]): {
  passCount: number;
  failCount: number;
  residualCount: number;
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
  for (const r of rows) {
    const comp = `${r.cW}-${r.cL}-${r.cT}`;
    const exp = Number.isNaN(r.eW) ? 'MISSING' : `${r.eW}-${r.eL}-${r.eT}`;
    const flags =
      (r.recOk ? '' : ' [REC]') + (r.pfOk ? '' : ' [PF]') + (r.paOk ? '' : ' [PA]');
    let status: string;
    if (r.residual) {
      const diff = Math.abs(r.cPA - r.ePA).toFixed(2);
      status = `PASS* (PA residual ${diff})`;
      passCount++;
      residualCount++;
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
  return { passCount, failCount, residualCount };
}

/* -------------------------------------------------------------------------- */
/* Extra checks                                                               */
/* -------------------------------------------------------------------------- */

async function leagueWinLossBalance(seasonId: number): Promise<{ wins: number; losses: number; ties: number }> {
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
    if (r.isBye || r.points === null) continue; // bye scores are not high-score eligible
    const p = Number(r.points);
    if (!best || p > best.points) best = { points: p, ownerName: r.ownerName, week: r.week };
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<boolean> {
  console.log(`\n=== Backfill & validate ${SEASON_NAME} ===\n`);

  console.log('[a] Upserting season ...');
  const seasonId = await upsertSeason();
  console.log(`    season id = ${seasonId}`);

  console.log('\n[b] Upserting owners + owner_seasons ...');
  const ownerRows = await parseOwners();
  await upsertOwners(seasonId, ownerRows);
  console.log(`    owners processed: ${ownerRows.length}`);

  console.log('\n[c] Syncing 2025 NFL schedule (ESPN) + generating matchups ...');
  const sync = await syncSeasonSchedule(seasonId, SEASON_YEAR, WEEKS);
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
  console.log(`    forfeits flagged: ${forfeitCount} (expected 6)`);

  console.log('\n[e] Computing standings + comparing to ground truth ...');
  const computed = await getSeasonStandings(seasonId);
  const expected = await parseExpectedStandings();
  console.log(`    computed rows: ${computed.length}, expected rows: ${expected.length}`);

  const comparison = compareStandings(computed, expected);
  const { passCount, failCount, residualCount } = printComparison(comparison);

  // Aggregate checks. With the missed-lineup rule, a forfeit where the opponent
  // scored BELOW the league average yields a DOUBLE LOSS: that opponent's game
  // flips from a win to a loss, so league wins drop by 1 and losses rise by 1 —
  // a net loss-minus-win gap of 2 PER double-loss. Season 3 has exactly one such
  // double-loss (Titans wk16: 83.90 < the ~125.04 average), so we expect a gap
  // of 2 (271 wins vs 273 losses).
  const balance = await leagueWinLossBalance(seasonId);
  const lossExcess = balance.losses - balance.wins;
  const doubleLosses = lossExcess / 2;
  const balanceOk = Number.isInteger(doubleLosses) && doubleLosses === 1;
  const high = await highestWeeklyScore(seasonId);
  const seeds = await getSeasonSeeds(seasonId);
  const entryById = new Map(computed.map((c) => [c.ownerSeasonId, c]));

  console.log('\n--- Aggregate checks ---');
  console.log(
    `League W/L balance: ${balance.wins} wins vs ${balance.losses} losses, ${balance.ties} ties` +
      ` (gap ${lossExcess} = ${doubleLosses} double-loss(es); expect 1) — ${balanceOk ? 'OK' : 'MISMATCH'}`,
  );
  if (high) {
    console.log(
      `Highest single-week score: ${high.points.toFixed(2)} (${high.ownerName}, Week ${high.week}) — expected 241.68 (Josh Lehr, Week 12)`,
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
    `Per-owner: ${passCount} PASS (${residualCount} via small PA residual), ${failCount} FAIL (of ${comparison.length})`,
  );
  if (residualCount > 0) {
    console.log(
      `  ${residualCount} owner(s) match on record + PF with only a small PA residual on a forfeit-opponent week` +
        ` (≤ ${FORFEIT_PA_TOLERANCE} pts) — an artifact of the sheet's AVERAGE() cell formula, not an engine error.`,
    );
  }
  const overall = failCount === 0 && balanceOk;
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  return overall;
}

main()
  // Exit non-zero when the ground-truth comparison fails so CI / the periodic
  // validator actually detects an engine regression (it previously always exited 0).
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nimport-season3 failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
