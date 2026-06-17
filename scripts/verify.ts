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
 *   TRUTH ground-truth replay of the 2025 season vs published standings
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

async function main() {
  const checks: Check[] = [
    cmd('CODE', 'typecheck', 'npm run typecheck'),
    cmd('CODE', 'lint', 'npm run lint'),
    cmd('CODE', 'unit tests', 'npm test'),
    ...(QUICK ? [] : [cmd('CODE', 'production build', 'npm run build')]),
    { group: 'DATA', name: 'ESPN schedule API', run: checkEspn },
    { group: 'DATA', name: 'standings/seeding invariants', run: checkEngineInvariants },
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
