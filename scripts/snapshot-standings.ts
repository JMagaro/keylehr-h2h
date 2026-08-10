/**
 * snapshot-standings.ts — a READ-ONLY dump of everything the scoring engine derives,
 * used as a regression baseline so historical seasons can be proven not to move.
 *
 *   npx tsx scripts/snapshot-standings.ts            # print a readable summary
 *   npx tsx scripts/snapshot-standings.ts --write    # (re)write the committed baseline
 *
 * `verify` imports {@link buildSnapshot} directly rather than shelling out, so this file
 * never needs to emit machine-readable output on stdout (the env loader prints a banner
 * there, which would corrupt it).
 *
 * WHY THIS EXISTS
 * The league's 2023-2025 seasons are validated against the commissioner's own spreadsheets
 * and the agreed policy is that they are FROZEN — corrections apply to 2026 forward. But the
 * existing ground-truth replay (`scripts/import-season3.ts`) is not sufficient to prove that:
 *
 *   1. it covers 2025 only;
 *   2. it compares per-owner records and PF/PA but NEVER asserts the resulting seed ORDER,
 *      so a tiebreaker change can reorder the playoff field while every number it checks
 *      stays identical;
 *   3. it compares against the sheet with tolerances (0.2 pts, 3.0 PA), so small drifts pass;
 *   4. it MUTATES the database, so it cannot serve as a before/after baseline of itself.
 *
 * This script closes all four gaps: it asserts ORDER, it is exact (no tolerances), it compares
 * the engine against its own previous output rather than against the sheet, and it writes
 * nothing to the database.
 *
 * WHAT IS CAPTURED (per season with data)
 *   - every owner's record, PF/PA, win%, games played and streak
 *   - the full `rankStandings` ORDER per division and per conference (the seed-order gap)
 *   - both conferences' playoff seeds with `kind` and `isBye`
 *   - the highest weekly score and the most-points leader (the two biggest payouts)
 *   - every `season_awards` row (the payout ledger)
 *   - `missedLineup.opponentScores` — because the league changed this rule for 2026 while
 *     2023-2025 legitimately used `league_average`; a future "consistency" cleanup that
 *     flipped history would otherwise silently rewrite validated seasons.
 *
 * Floats are rounded to 4 decimals so an irrelevant last-bit difference can't fail the gate.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { asc } from 'drizzle-orm';

import { db, seasonAwards } from '@/db';
import {
  getSeasonOptions,
  getSeasonSeeds,
  getSeasonStandings,
  getSeasonStandingsData,
  getHighestWeeklyScore,
} from '@/lib/standings/query';
import { buildTiebreakerContext, rankStandings } from '@/lib/standings/tiebreakers';
import type { Conference, Division } from '@/lib/standings/types';

export const BASELINE_PATH = join(process.cwd(), 'scripts', 'fixtures', 'standings-baseline.json');

/** Seasons the baseline gate protects. 2026 is live and is expected to change. */
export const FROZEN_YEARS = [2023, 2024, 2025] as const;

const CONFERENCES: Conference[] = ['AFC', 'NFC'];
const DIVISIONS: Division[] = ['East', 'North', 'South', 'West'];

/** Round to 4dp so float noise can't fail the diff; points are only ever 2dp anyway. */
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

export interface SeasonSnapshot {
  year: number;
  seasonId: number;
  status: string;
  /** The missed-lineup convention this season was scored under. */
  opponentScores: string;
  regularSeasonWeeks: number;
  /** One line per owner, keyed by team so it stays readable in a diff. */
  owners: Record<string, {
    ownerName: string;
    wins: number;
    losses: number;
    ties: number;
    gamesPlayed: number;
    pointsFor: number;
    pointsAgainst: number;
    winPct: number;
    streak: string;
  }>;
  /** ORDER matters — this is the gap the ground-truth replay leaves open. */
  divisionOrder: Record<string, string[]>;
  conferenceOrder: Record<string, string[]>;
  seeds: Record<string, { seed: number; teamKey: string; kind: string; isBye: boolean }[]>;
  highestWeeklyScore: { teamKey: string; week: number; points: number } | null;
  mostPointsLeader: { teamKey: string; pointsFor: number } | null;
  awards: { type: string; week: number | null; teamKey: string | null; amountCents: number | null; value: string | null }[];
}

export interface Snapshot {
  /** Bumped only when the snapshot SHAPE changes, forcing a deliberate re-baseline. */
  version: number;
  seasons: SeasonSnapshot[];
}

export async function buildSnapshot(years: readonly number[] = FROZEN_YEARS): Promise<Snapshot> {
  const options = await getSeasonOptions();
  const wanted = options.filter((s) => years.includes(s.year)).sort((a, b) => a.year - b.year);

  // One read of the whole ledger; filtered per season below.
  const allAwards = await db
    .select()
    .from(seasonAwards)
    .orderBy(asc(seasonAwards.seasonId), asc(seasonAwards.type), asc(seasonAwards.week));

  const seasons: SeasonSnapshot[] = [];

  for (const season of wanted) {
    const data = await getSeasonStandingsData(season.id);
    const rows = await getSeasonStandings(season.id);
    if (rows.length === 0) continue;

    // ownerSeasonId → teamKey, so the snapshot reads in league terms rather than surrogate ids
    // (and stays stable if ids are ever renumbered by a re-import).
    const teamByOwnerSeason = new Map(rows.map((r) => [r.ownerSeasonId, r.teamKey]));
    const key = (id: number): string => teamByOwnerSeason.get(id) ?? `os:${id}`;

    const owners: SeasonSnapshot['owners'] = {};
    for (const r of [...rows].sort((a, b) => a.teamKey.localeCompare(b.teamKey))) {
      owners[r.teamKey] = {
        ownerName: r.ownerName,
        wins: r.wins,
        losses: r.losses,
        ties: r.ties,
        gamesPlayed: r.gamesPlayed,
        pointsFor: r4(r.pointsFor),
        pointsAgainst: r4(r.pointsAgainst),
        winPct: r4(r.winPct),
        streak: r.streak,
      };
    }

    // The ranked order — the thing the existing replay never asserts. Context is built once
    // from ALL rows (so every head-to-head pair is present) and subsets are ranked against it,
    // exactly as `seeding.ts:51` does.
    const ctx = buildTiebreakerContext(rows, data.results);
    const rank = (subset: typeof rows): string[] =>
      rankStandings(subset, ctx, data.rankingOptions.tiebreakers).map((r) => key(r.ownerSeasonId));

    const divisionOrder: Record<string, string[]> = {};
    const conferenceOrder: Record<string, string[]> = {};
    for (const conf of CONFERENCES) {
      conferenceOrder[conf] = rank(rows.filter((r) => r.conference === conf));
      for (const div of DIVISIONS) {
        divisionOrder[`${conf} ${div}`] = rank(
          rows.filter((r) => r.conference === conf && r.division === div),
        );
      }
    }

    const seedsByConf = await getSeasonSeeds(season.id);
    const seeds: SeasonSnapshot['seeds'] = {};
    for (const conf of CONFERENCES) {
      seeds[conf] = seedsByConf[conf].map((s) => ({
        seed: s.seed,
        teamKey: key(s.ownerSeasonId),
        kind: s.kind,
        isBye: s.isBye,
      }));
    }

    const high = await getHighestWeeklyScore(season.id);

    // Most regular-season points — one of the two biggest payouts, and a number the awards
    // work in a later phase deliberately changes the SOURCE of. Captured so that change is
    // forced to be visible rather than silent.
    let mostPointsLeader: SeasonSnapshot['mostPointsLeader'] = null;
    for (const r of rows) {
      if (!mostPointsLeader || r.pointsFor > mostPointsLeader.pointsFor) {
        mostPointsLeader = { teamKey: r.teamKey, pointsFor: r4(r.pointsFor) };
      }
    }

    const awards = allAwards
      .filter((a) => a.seasonId === season.id)
      .map((a) => ({
        type: a.type,
        week: a.week ?? null,
        teamKey: a.ownerSeasonId === null ? null : key(a.ownerSeasonId),
        amountCents: a.amountCents ?? null,
        value: a.value ?? null,
      }))
      .sort((x, y) =>
        x.type.localeCompare(y.type) ||
        (x.week ?? -1) - (y.week ?? -1) ||
        (x.teamKey ?? '').localeCompare(y.teamKey ?? ''),
      );

    seasons.push({
      year: season.year,
      seasonId: season.id,
      status: season.status,
      opponentScores: data.rules.missedLineup.opponentScores,
      regularSeasonWeeks: data.rules.regularSeasonWeeks,
      owners,
      divisionOrder,
      conferenceOrder,
      seeds,
      highestWeeklyScore: high
        ? { teamKey: high.teamKey, week: high.week, points: r4(high.points) }
        : null,
      mostPointsLeader,
      awards,
    });
  }

  return { version: 1, seasons };
}

async function main() {
  const snapshot = await buildSnapshot();
  const write = process.argv.includes('--write');

  if (write) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`Wrote baseline → ${BASELINE_PATH}`);
  }

  for (const s of snapshot.seasons) {
    const gamesPlayed = [...new Set(Object.values(s.owners).map((o) => o.gamesPlayed))];
    console.log(
      `\n${s.year} (id=${s.seasonId}, ${s.status}) — ${Object.keys(s.owners).length} owners · ` +
        `opponentScores=${s.opponentScores} · gamesPlayed=${gamesPlayed.join('/')}`,
    );
    for (const conf of CONFERENCES) {
      console.log(
        `  ${conf} seeds: ` +
          s.seeds[conf].map((d) => `${d.seed}:${d.teamKey}${d.isBye ? '*' : ''}`).join(' '),
      );
    }
    console.log(
      `  highest week: ${s.highestWeeklyScore ? `${s.highestWeeklyScore.teamKey} wk${s.highestWeeklyScore.week} ${s.highestWeeklyScore.points}` : '—'}` +
        ` · most pts: ${s.mostPointsLeader ? `${s.mostPointsLeader.teamKey} ${s.mostPointsLeader.pointsFor}` : '—'}` +
        ` · awards: ${s.awards.length}`,
    );
  }
  if (!write) console.log('\n(dry run — pass --write to update the committed baseline)');
}

// Only run the CLI when invoked directly. `scripts/verify.ts` imports `buildSnapshot` from
// this module, and an unguarded top-level `main()` would run a full snapshot (and print to
// stdout) as an import side effect.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('snapshot-standings failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
