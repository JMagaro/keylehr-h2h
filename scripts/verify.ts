/**
 * verify.ts — the project's single "is everything still good?" gate.
 *
 * Runs the full verification suite and exits non-zero if ANY check fails, so it
 * can back a periodic validator (a scheduled agent / CI) that keeps the site
 * honest as code changes land. Every check runs even if an earlier one fails, so
 * one run shows the whole picture.
 *
 *   npm run verify            # everything (code + data + ground-truth)
 *   npm run verify -- --quick # skip the slow build + ground-truth replay
 *
 * Checks, in order:
 *   CODE  typecheck · lint · unit tests · production build
 *         (the build is non-negotiable: it catches production-only errors —
 *          e.g. invalid "use server" exports — that `next dev` silently allows.)
 *   DATA  ESPN schedule API reachable · standings/seeding engine invariants
 *         (read-only — no DB writes)
 *   TRUTH historical snapshot unchanged (2023-2025 frozen) · engine no-op proofs ·
 *         ground-truth replay of the 2025 season vs published standings
 *         (scripts/import-season3.ts; idempotent re-import of a frozen season)
 *
 * Requires DATABASE_URL (loaded via @/load-env) for the DATA + TRUTH checks; the
 * CODE checks need no secrets.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { execSync } from 'node:child_process';

const QUICK = process.argv.includes('--quick');

type CheckResult = { ok: boolean; detail?: string };
interface Check {
  group: 'CODE' | 'DATA' | 'TRUTH';
  name: string;
  run: () => Promise<CheckResult>;
}

/** Keep the last N lines of a (possibly huge) command output for failure context. */
function tail(text: string, n = 20): string {
  return text.split('\n').filter(Boolean).slice(-n).join('\n');
}

/** A check that shells out to a command; ok when the command exits 0. */
function cmd(group: Check['group'], name: string, command: string): Check {
  return {
    group,
    name,
    run: async () => {
      try {
        execSync(command, { stdio: 'pipe', encoding: 'utf8' });
        return { ok: true };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, detail: tail(`${e.stdout ?? ''}\n${e.stderr ?? ''}` || e.message || '') };
      }
    },
  };
}

const CONFERENCES = ['AFC', 'NFC'] as const;
const DIVISIONS = ['East', 'North', 'South', 'West'] as const;

/** ESPN schedule API still returns games — so the schedule pull won't silently break. */
async function checkEspn(): Promise<CheckResult> {
  const { getCurrentSeason } = await import('@/lib/season');
  const { fetchWeekGames } = await import('@/lib/espn/client');
  const season = await getCurrentSeason();
  if (!season) return { ok: false, detail: 'no season in DB to derive a year from' };
  const games = await fetchWeekGames(season.year, 1);
  return games.length > 0
    ? { ok: true, detail: `${games.length} games for ${season.year} week 1` }
    : { ok: false, detail: `ESPN returned 0 games for ${season.year} week 1` };
}

/** Standings + seeding engine produce structurally sane output on the live data. */
async function checkEngineInvariants(): Promise<CheckResult> {
  const { getDefaultStandingsSeasonId, getStandingsView, getSeasonSeeds } = await import(
    '@/lib/standings/query'
  );
  const seasonId = await getDefaultStandingsSeasonId();
  if (!seasonId) return { ok: true, detail: 'no season with data yet — skipped' };

  const view = await getStandingsView(seasonId);
  if (!view.hasData) return { ok: true, detail: 'season has no scored games yet — skipped' };

  const rows = CONFERENCES.flatMap((c) => DIVISIONS.flatMap((d) => view.byConference[c][d]));
  const problems: string[] = [];

  for (const r of rows) {
    if (![r.pointsFor, r.pointsAgainst, r.winPct].every(Number.isFinite)) {
      problems.push(`non-finite numbers for ownerSeason ${r.ownerSeasonId}`);
    }
    if (r.winPct < 0 || r.winPct > 1) problems.push(`winPct out of range for ${r.ownerSeasonId}`);
    if (r.gamesPlayed !== r.wins + r.losses + r.ties) {
      problems.push(`record mismatch for ownerSeason ${r.ownerSeasonId}`);
    }
  }

  const seeds = await getSeasonSeeds(seasonId);
  for (const conf of CONFERENCES) {
    const nums = seeds[conf].map((s) => s.seed);
    if (new Set(nums).size !== nums.length) problems.push(`duplicate seed numbers in ${conf}`);
    nums.forEach((n, i) => {
      if (n !== i + 1) problems.push(`non-contiguous seeds in ${conf} (got ${n} at slot ${i + 1})`);
    });
  }

  return problems.length === 0
    ? { ok: true, detail: `${rows.length} owners, seeds ${seeds.AFC.length}+${seeds.NFC.length} — all invariants hold` }
    : { ok: false, detail: problems.slice(0, 6).join('; ') };
}

/**
 * The 2023-2025 seasons are FROZEN by league decision: corrections apply to 2026 forward.
 * This diffs the engine's full derived output — including the seed ORDER that the
 * ground-truth replay never asserts — against the committed baseline.
 *
 * Re-baseline ONLY with explicit sign-off:  npx tsx scripts/snapshot-standings.ts --write
 */
async function checkHistoricalSnapshot(): Promise<CheckResult> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { buildSnapshot, BASELINE_PATH } = await import('./snapshot-standings');

  if (!existsSync(BASELINE_PATH)) {
    return { ok: false, detail: 'no baseline committed — run: npx tsx scripts/snapshot-standings.ts --write' };
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Awaited<ReturnType<typeof buildSnapshot>>;
  const current = await buildSnapshot();

  if (baseline.version !== current.version) {
    return { ok: false, detail: `snapshot shape changed (v${baseline.version} → v${current.version}) — re-baseline deliberately` };
  }

  // Compare season-by-season so the failure names the year and the exact field.
  const diffs: string[] = [];
  const byYear = new Map(current.seasons.map((s) => [s.year, s]));
  for (const want of baseline.seasons) {
    const got = byYear.get(want.year);
    if (!got) {
      diffs.push(`${want.year}: missing from current output`);
      continue;
    }
    const a = JSON.stringify(want);
    const b = JSON.stringify(got);
    if (a === b) continue;
    // Narrow to the first differing top-level field for a readable message.
    for (const k of Object.keys(want) as (keyof typeof want)[]) {
      const wa = JSON.stringify(want[k]);
      const gb = JSON.stringify(got[k]);
      if (wa !== gb) diffs.push(`${want.year}.${String(k)} changed`);
    }
  }

  return diffs.length === 0
    ? { ok: true, detail: `${baseline.seasons.length} frozen season(s) byte-identical (records, order, seeds, awards)` }
    : { ok: false, detail: `HISTORY MOVED — ${diffs.slice(0, 8).join('; ')}` };
}

/**
 * Mechanical proofs that the planned Phase-1 engine changes are no-ops on historical data.
 * Each is a precondition that, while it holds, makes a specific change provably safe:
 *
 *   1. derived forfeits == stored `isForfeit`  → deriving forfeits at read time changes nothing
 *   2. every owner played the same number of games → win% ties imply equal wins, so dropping
 *      `wins` from the tiebreaker cohort key cannot regroup anyone
 *   3. 2023-2025 still scored on `league_average` → nobody "consistency-fixed" history to median
 *
 * If one of these ever fails, the corresponding change is NOT safe and needs a fresh look.
 */
async function checkEngineNoOpProofs(): Promise<CheckResult> {
  const { and, eq, inArray } = await import('drizzle-orm');
  const { db, matchups, scores, seasons: seasonsTable } = await import('@/db');
  const { getSeasonOptions, getSeasonStandingsData } = await import('@/lib/standings/query');
  const { FROZEN_YEARS } = await import('./snapshot-standings');

  const options = (await getSeasonOptions()).filter((s) => (FROZEN_YEARS as readonly number[]).includes(s.year));
  if (options.length === 0) return { ok: true, detail: 'no frozen seasons in DB — skipped' };

  const problems: string[] = [];
  const seasonIds = options.map((s) => s.id);

  const [scoreRows, matchupRows, seasonRows] = await Promise.all([
    db
      .select({
        seasonId: scores.seasonId,
        ownerSeasonId: scores.ownerSeasonId,
        week: scores.week,
        dkPoints: scores.dkPoints,
        isBye: scores.isBye,
        isForfeit: scores.isForfeit,
      })
      .from(scores)
      .where(and(inArray(scores.seasonId, seasonIds), eq(scores.isExhibition, false))),
    db
      .select({
        seasonId: matchups.seasonId,
        week: matchups.week,
        home: matchups.homeOwnerSeasonId,
        away: matchups.awayOwnerSeasonId,
        isPlayoff: matchups.isPlayoff,
      })
      .from(matchups)
      .where(and(inArray(matchups.seasonId, seasonIds), eq(matchups.isExhibition, false))),
    db
      .select({ id: seasonsTable.id, regularSeasonWeeks: seasonsTable.regularSeasonWeeks })
      .from(seasonsTable)
      .where(inArray(seasonsTable.id, seasonIds)),
  ]);

  const weeksById = new Map(seasonRows.map((s) => [s.id, s.regularSeasonWeeks ?? 18]));

  for (const season of options) {
    const regularWeeks = weeksById.get(season.id) ?? 18;

    // Owners holding a regular-season matchup in a given week.
    const playing = new Set<string>();
    for (const m of matchupRows) {
      if (m.seasonId !== season.id || m.isPlayoff) continue;
      playing.add(`${m.home}:${m.week}`);
      playing.add(`${m.away}:${m.week}`);
    }

    // PROOF 1 — the derivation the historical importers encode:
    //   not bye ∧ has a regular-season matchup ∧ dkPoints === 0
    const stored = new Set<string>();
    const derived = new Set<string>();
    for (const s of scoreRows) {
      if (s.seasonId !== season.id) continue;
      const key = `${s.ownerSeasonId}:${s.week}`;
      if (s.isForfeit) stored.add(key);
      if (s.week > regularWeeks) continue;
      if (!s.isBye && s.dkPoints !== null && Number(s.dkPoints) === 0 && playing.has(key)) {
        derived.add(key);
      }
    }
    const onlyStored = [...stored].filter((k) => !derived.has(k));
    const onlyDerived = [...derived].filter((k) => !stored.has(k));
    if (onlyStored.length || onlyDerived.length) {
      problems.push(
        `${season.year}: forfeit derivation differs (stored-only ${onlyStored.length}, derived-only ${onlyDerived.length})`,
      );
    }

    const data = await getSeasonStandingsData(season.id);

    // PROOF 2 — equal games played ⇒ the tiebreaker cohort key can drop `wins` safely.
    const games = new Map<number, number>();
    for (const m of data.results) {
      if (!m.isFinal || m.isPlayoff || m.isExhibition) continue;
      games.set(m.homeOwnerSeasonId, (games.get(m.homeOwnerSeasonId) ?? 0) + 1);
      games.set(m.awayOwnerSeasonId, (games.get(m.awayOwnerSeasonId) ?? 0) + 1);
    }
    const distinct = [...new Set(games.values())];
    if (distinct.length > 1) {
      problems.push(`${season.year}: unequal gamesPlayed (${distinct.sort((a, b) => a - b).join('/')})`);
    }

    // PROOF 3 — history stays on league_average; 2026+ is the season that uses league_median.
    if (data.rules.missedLineup.opponentScores !== 'league_average') {
      problems.push(
        `${season.year}: opponentScores is '${data.rules.missedLineup.opponentScores}', expected 'league_average'`,
      );
    }
  }

  return problems.length === 0
    ? { ok: true, detail: `${options.length} frozen season(s): forfeits derivable, games equal, rules unchanged` }
    : { ok: false, detail: problems.slice(0, 6).join('; ') };
}

async function main() {
  const checks: Check[] = [
    cmd('CODE', 'typecheck', 'npm run typecheck'),
    cmd('CODE', 'lint', 'npm run lint'),
    cmd('CODE', 'unit tests', 'npm test'),
    ...(QUICK ? [] : [cmd('CODE', 'production build', 'npm run build')]),
    { group: 'DATA', name: 'ESPN schedule API', run: checkEspn },
    { group: 'DATA', name: 'standings/seeding invariants', run: checkEngineInvariants },
    { group: 'TRUTH', name: 'historical snapshot unchanged', run: checkHistoricalSnapshot },
    { group: 'TRUTH', name: 'engine no-op proofs', run: checkEngineNoOpProofs },
    ...(QUICK ? [] : [cmd('TRUTH', 'ground-truth replay (2025)', 'npx tsx scripts/import-season3.ts')]),
  ];

  console.log(`\nKeyLehr H2H — verification suite${QUICK ? ' (quick)' : ''}\n${'='.repeat(48)}`);

  const results: { check: Check; result: CheckResult }[] = [];
  for (const check of checks) {
    process.stdout.write(`[${check.group}] ${check.name} … `);
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    console.log(result.ok ? 'PASS' : 'FAIL');
    if (result.detail) console.log(`        ${result.detail.replace(/\n/g, '\n        ')}`);
    results.push({ check, result });
  }

  const failed = results.filter((r) => !r.result.ok);
  console.log('='.repeat(48));
  console.log(
    `${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.check.name).join(', ')}` : ''),
  );
  console.log(`OVERALL: ${failed.length === 0 ? 'PASS' : 'FAIL'}\n`);
  return failed.length === 0;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err: unknown) => {
    console.error('\nverify crashed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
