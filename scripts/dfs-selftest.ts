/**
 * Whole-slate self-test for the DraftKings scoring engine — no DraftKings auth required.
 *
 * WHY THIS EXISTS: the live page recomputes DK points from ESPN because DK's own scoring
 * API is authenticated. That means the engine has no upstream to check itself against until
 * the official leaderboard lands at the end of the week. This script closes that gap using
 * two INDEPENDENT free sources:
 *
 *   ESPN boxscore  -> our engine        -> DK points
 *   Sleeper stats  -> Sleeper's own math -> pts_ppr
 *
 * DK Classic and full-PPR differ by a KNOWN, ENUMERABLE set of rules, so every per-player
 * delta must decompose into that set. Anything left over is a real bug in our extraction or
 * arithmetic, and gets printed. This validates ~300 players per week instead of the handful
 * a unit test can hand-compute.
 *
 * Known DK-vs-PPR differences:
 *   DK adds  : +3 for 300+ passing yards, +3 for 100+ rushing, +3 for 100+ receiving.
 *   Sleeper adds : +1 per special-teams solo tackle (`st_tkl_solo`). DraftKings Classic pays
 *                  nothing for special-teams tackles, so our lower number is the correct one.
 *                  This is a real rule difference, not an error — Ben Skowronek in 2025 wk1
 *                  (dk 9.20 vs ppr 10.20) is the canonical example.
 * Sleeper's fumble-lost weighting is detected empirically rather than assumed.
 *
 * Usage:
 *   npm run dfs:selftest                          # 2025 regular-season week 1
 *   npm run dfs:selftest -- --year=2025 --week=4
 *   npm run dfs:selftest -- --year=2025 --week=1 --verbose
 */
import '@/load-env';

import { fetchWeekGames } from '@/lib/espn/client';
import { fetchGameSummary } from '@/lib/dfs/sources/espn-boxscore';
import { extractGame } from '@/lib/dfs/sources/espn-extract';
import { scorePlayer, round2 } from '@/lib/dfs/score';
import { normalizeName } from '@/lib/draftkings/match';
import { normalizeTeamKey } from '@/lib/nfl/team-keys';

/**
 * Cross-source player key. MUST include the team: an initial+surname key collides badly
 * league-wide (Bijan Robinson vs Brian Robinson Jr., Travis vs Trevor Etienne, Josh Allen
 * the QB vs Jonathan Allen the DT), which silently compares two different players and looks
 * exactly like an engine bug.
 */
const playerKey = (name: string, teamKey: string) => `${normalizeName(name)}|${teamKey}`;

/** Tolerance for float noise when matching a delta to an explanation. */
const EPS = 0.011;

interface Args {
  year: number;
  week: number;
  verbose: boolean;
}

function parseArgs(): Args {
  const get = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return {
    year: Number(get('year') ?? 2025),
    week: Number(get('week') ?? 1),
    verbose: process.argv.includes('--verbose'),
  };
}

/** Sleeper's weekly stat dump, keyed by Sleeper player id. */
async function fetchSleeperWeek(
  year: number,
  week: number,
): Promise<Record<string, Record<string, number>>> {
  const url = `https://api.sleeper.app/v1/stats/nfl/regular/${year}/${week}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Sleeper stats ${year} wk${week} failed (HTTP ${res.status})`);
  return (await res.json()) as Record<string, Record<string, number>>;
}

/** Sleeper's player dictionary, so stat rows can be resolved to names + teams. */
async function fetchSleeperPlayers(): Promise<
  Record<string, { full_name?: string; position?: string; team?: string | null }>
> {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Sleeper players failed (HTTP ${res.status})`);
  return (await res.json()) as Record<
    string,
    { full_name?: string; position?: string; team?: string | null }
  >;
}

async function main() {
  const { year, week, verbose } = parseArgs();
  console.log(`\nDFS engine self-test — ${year} regular-season week ${week}\n`);

  // --- our side: ESPN -> engine -------------------------------------------
  const games = await fetchWeekGames(year, week);
  console.log(`ESPN: ${games.length} games`);

  const ours = new Map<string, { name: string; dk: number; line: ReturnType<typeof extractGame>['players'][number]['line'] }>();
  for (const g of games) {
    const summary = await fetchGameSummary(g.espnEventId, 0);
    const extracted = extractGame(summary);
    for (const p of extracted.players) {
      ours.set(playerKey(p.name, p.teamKey), {
        name: p.name,
        dk: scorePlayer(p.line).points,
        line: p.line,
      });
    }
  }
  console.log(`Engine: scored ${ours.size} players from ESPN boxscores`);

  // --- their side: Sleeper's own PPR --------------------------------------
  const [stats, players] = await Promise.all([fetchSleeperWeek(year, week), fetchSleeperPlayers()]);
  const theirs = new Map<string, { name: string; ppr: number; fumLost: number; stTackles: number }>();
  for (const [pid, row] of Object.entries(stats)) {
    const meta = players[pid];
    const name = meta?.full_name;
    const pos = meta?.position;
    if (!name || !pos || !['QB', 'RB', 'WR', 'TE'].includes(pos)) continue;
    if (typeof row.pts_ppr !== 'number') continue;
    if (!meta?.team) continue; // no team => cannot key safely
    theirs.set(playerKey(name, normalizeTeamKey(meta.team)), {
      name,
      ppr: row.pts_ppr,
      fumLost: row.fum_lost ?? 0,
      stTackles: row.st_tkl_solo ?? 0,
    });
  }
  console.log(`Sleeper: ${theirs.size} skill players with pts_ppr\n`);

  // --- compare -------------------------------------------------------------
  let compared = 0;
  let exact = 0;
  let explained = 0;
  const unexplained: { name: string; dk: number; ppr: number; delta: number }[] = [];

  for (const [key, mine] of ours) {
    const other = theirs.get(key);
    if (!other) continue;
    // Only compare players who actually did something in both feeds.
    if (mine.dk === 0 && other.ppr === 0) continue;
    compared += 1;

    const delta = round2(mine.dk - other.ppr);
    if (Math.abs(delta) < EPS) {
      exact += 1;
      explained += 1;
      continue;
    }

    // Enumerate the known DK-vs-Sleeper rule differences and see if one explains the delta.
    // DK-only credits (push our number UP relative to PPR):
    const bonusTotal =
      (mine.line.passYards >= 300 ? 3 : 0) +
      (mine.line.rushYards >= 100 ? 3 : 0) +
      (mine.line.recYards >= 100 ? 3 : 0);
    // Sleeper-only credits (push their number UP, so ours reads lower by the same amount):
    const sleeperOnly = other.stTackles * 1;
    // Sleeper's fumble-lost weight may differ from DK's -1; allow a per-fumble adjustment.
    const fumbleAdjustments = [0, mine.line.fumblesLost * 1, mine.line.fumblesLost * 2];

    const matched = fumbleAdjustments.some(
      (fa) => Math.abs(delta - (bonusTotal - sleeperOnly + fa)) < EPS,
    );
    if (matched) explained += 1;
    else unexplained.push({ name: mine.name, dk: mine.dk, ppr: other.ppr, delta });
  }

  const pct = compared ? ((explained / compared) * 100).toFixed(1) : '0.0';
  console.log(`Compared      : ${compared} players present in both feeds`);
  console.log(`Exact match   : ${exact}`);
  console.log(`Explained     : ${explained} (${pct}%)`);
  console.log(`UNEXPLAINED   : ${unexplained.length}`);

  if (unexplained.length > 0) {
    console.log('\nUnexplained deltas (engine bug, extraction bug, or a rule we have not modelled):');
    unexplained
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, verbose ? unexplained.length : 25)
      .forEach((u) => {
        console.log(`  ${u.name.padEnd(26)} dk=${u.dk.toFixed(2).padStart(7)}  ppr=${u.ppr.toFixed(2).padStart(7)}  Δ=${u.delta.toFixed(2)}`);
      });
  }

  console.log('');
  // A handful of unexplained players is expected (2-pt conversions ESPN buries in play text,
  // Sleeper stat corrections). A systematic failure is not.
  const failRate = compared ? unexplained.length / compared : 0;
  if (failRate > 0.05) {
    console.error(`FAIL: ${(failRate * 100).toFixed(1)}% unexplained exceeds the 5% threshold.`);
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
