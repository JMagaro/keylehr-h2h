/**
 * Live sanity check for the DraftKings scoring engine — a CLI preview of what /live will show.
 *
 * Fetches every in-progress NFL game from ESPN, runs the real extractor + scoring engine over
 * the boxscores, and prints the top scorers with their DK points. No auth, no database.
 *
 * TWO JOBS:
 *   1. Eyeball the pipeline against a game you can watch.
 *   2. `--watch` proves ESPN's boxscore actually MOVES during a game. That is the assumption
 *      the whole no-auth design rests on: DraftKings' scoring API needs a session and Sleeper's
 *      weekly stats are a batch feed (verified 14h stale during preseason), so if ESPN did not
 *      update live there would be no live source at all.
 *
 * Usage:
 *   npm run live:check                     # one snapshot of every in-progress game
 *   npm run live:check -- --watch          # poll until stats change, proving live updates
 *   npm run live:check -- --event=401873283
 *   npm run live:check -- --seasontype=2   # regular season (default: auto-detect)
 */
import '@/load-env';

import { fetchGameSummary } from '@/lib/dfs/sources/espn-boxscore';
import { extractGame, type ExtractedGame } from '@/lib/dfs/sources/espn-extract';
import { scoreDst, scorePlayer } from '@/lib/dfs/score';

const SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

/** Poll interval and cap for --watch. Long enough for a play to happen, short enough to sit through. */
const WATCH_INTERVAL_MS = 45_000;
const WATCH_MAX_POLLS = 10;

interface LiveEvent {
  id: string;
  name: string;
  state: string;
  detail: string;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

/** In-progress games, trying preseason then regular season unless told which. */
async function findLiveEvents(): Promise<LiveEvent[]> {
  const explicit = arg('seasontype');
  const types = explicit ? [Number(explicit)] : [1, 2];

  for (const seasontype of types) {
    const res = await fetch(`${SCOREBOARD}?seasontype=${seasontype}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      events?: {
        id: string;
        name: string;
        status?: { type?: { state?: string; detail?: string } };
      }[];
    };
    const live = (data.events ?? [])
      .filter((e) => e.status?.type?.state === 'in')
      .map((e) => ({
        id: String(e.id),
        name: e.name,
        state: e.status?.type?.state ?? '',
        detail: e.status?.type?.detail ?? '',
      }));
    if (live.length > 0) return live;
  }
  return [];
}

/** Every scoring player in a game, DK points descending. */
function scoreAll(game: ExtractedGame): { name: string; teamKey: string; points: number }[] {
  const rows = game.players
    .map((p) => ({ name: p.name, teamKey: p.teamKey, points: scorePlayer(p.line).points }))
    .concat(
      game.defenses.map((d) => ({
        name: `${d.teamKey} DST`,
        teamKey: d.teamKey,
        points: scoreDst(d.line).points,
      })),
    );
  return rows.filter((r) => r.points !== 0).sort((a, b) => b.points - a.points);
}

/** Stable fingerprint of a game's scoring state, for change detection. */
function fingerprint(rows: { name: string; points: number }[]): string {
  return rows.map((r) => `${r.name}:${r.points}`).join('|');
}

async function snapshot(eventId: string) {
  // ttl 0 — never serve a cached boxscore to a liveness check.
  const summary = await fetchGameSummary(eventId, 0);
  const game = extractGame(summary);
  return { game, rows: scoreAll(game) };
}

function printGame(label: string, game: ExtractedGame, rows: ReturnType<typeof scoreAll>) {
  console.log(`\n${label}`);
  console.log(`  ${game.teamKeys.join(' vs ')} — ${game.statusDetail ?? game.state}`);
  if (rows.length === 0) {
    console.log('  (nobody has scored yet)');
    return;
  }
  for (const r of rows.slice(0, 10)) {
    console.log(`    ${r.points.toFixed(2).padStart(7)}  ${r.name} (${r.teamKey})`);
  }
}

async function main() {
  const watch = process.argv.includes('--watch');
  const explicitEvent = arg('event');

  let events: LiveEvent[];
  if (explicitEvent) {
    events = [{ id: explicitEvent, name: `event ${explicitEvent}`, state: 'in', detail: '' }];
  } else {
    events = await findLiveEvents();
    if (events.length === 0) {
      console.log('\nNo games are in progress right now.');
      console.log('Pass --event=<espnEventId> to inspect a specific game.\n');
      return;
    }
  }

  console.log(`\nLive games: ${events.length}`);
  for (const e of events) console.log(`  ${e.id}  ${e.name} — ${e.detail}`);

  // ---- single snapshot -----------------------------------------------------
  const first = new Map<string, string>();
  for (const e of events) {
    const { game, rows } = await snapshot(e.id);
    printGame(`[${e.id}] ${e.name}`, game, rows);
    first.set(e.id, fingerprint(rows));
  }

  if (!watch) {
    console.log('\nRun with --watch to prove the numbers move.\n');
    return;
  }

  // ---- watch: poll until something changes ---------------------------------
  console.log(
    `\nWatching for changes (every ${WATCH_INTERVAL_MS / 1000}s, up to ${WATCH_MAX_POLLS} polls)…`,
  );
  for (let poll = 1; poll <= WATCH_MAX_POLLS; poll += 1) {
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));

    for (const e of events) {
      const { game, rows } = await snapshot(e.id);
      const now = fingerprint(rows);
      if (now !== first.get(e.id)) {
        console.log(`\n✅ ESPN UPDATED — poll ${poll}, event ${e.id} (${game.statusDetail})`);
        printGame(`[${e.id}] ${e.name}`, game, rows);
        console.log(
          '\nThe boxscore moved mid-game, so ESPN is a viable live source. This is the\n' +
            'assumption the whole no-auth live design depends on.\n',
        );
        return;
      }
      console.log(`  poll ${poll}: ${e.id} unchanged (${game.statusDetail})`);
    }
  }

  console.log('\n⚠️  No change detected within the watch window.');
  console.log('   Could be a genuine lull (timeouts, commercials) — re-run during active play.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
