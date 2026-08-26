/**
 * export-captures.ts — put the one thing that can never be re-fetched into git.
 *
 *   npm run export:captures            # print what would be written
 *   npm run export:captures -- --write # (re)write scripts/fixtures/captures/
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM `db:dump`
 * Almost everything in this database can be rebuilt. `nfl_games` re-pulls from ESPN; 2023-2025
 * re-imports from the commissioner's Google Sheets; odds and model snapshots recompute. The
 * exception is roster captures. DraftKings' authenticated roster endpoint is the ONLY source
 * for who each owner started, and contests age out — once a week has passed, that data cannot
 * be obtained again at any price.
 *
 * `db:dump` protects it, but only on whatever disk it was written to. This puts it in git:
 * off Neon, versioned, replicated to every clone, free. It is the same move the league already
 * makes for standings — `snapshot-standings.ts` writes a committed baseline so history can be
 * proven not to move — applied to the data with the shortest shelf life.
 *
 * 🛑 WHY THIS EXPORT IS NOT SIMPLY THE WHOLE TABLE: THIS REPOSITORY IS PUBLIC.
 *   - `dk_entry_key` is dropped. It identifies a DraftKings ACCOUNT, and these are the
 *     commissioner's friends.
 *   - `lineup_capture_runs.raw_payload` is NOT exported at all. DraftKings' raw payload carries
 *     every entrant's DK username; publishing it would expose the league's members to the
 *     internet. It stays in `db:dump` (gitignored) where it belongs.
 *   - What IS exported is the NORMALIZED roster: NFL player names, positions, teams, DK's own
 *     per-player scores and stat lines. All public sporting facts. Owners appear only as
 *     `ownerSeasonId`, an integer that means nothing without the database.
 *
 * The normalized roster is also the useful half: it is what /live scores and what the drift
 * audit reconciles. The raw payload is forensic evidence, not working data.
 *
 * ONE FILE PER SEASON-WEEK, deliberately. A single growing file would be rewritten in full
 * every week, so git would store a complete new copy each time. Per-week files mean a week
 * lands once and is never touched again.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { asc, eq } from 'drizzle-orm';

import { db, lineupSnapshots, seasons } from '@/db';

const OUT_DIR = fileURLToPath(new URL('./fixtures/captures', import.meta.url));

/** One captured roster, stripped of anything that identifies a DraftKings account. */
interface ExportedSnapshot {
  ownerSeasonId: number;
  week: number;
  isExhibition: boolean;
  dkDraftGroupId: string | null;
  capturedAt: string;
  /** The normalized slots exactly as stored — NFL players, DK scores, DK stat lines. */
  slots: unknown;
}

interface WeekFile {
  version: number;
  seasonYear: number;
  seasonId: number;
  week: number;
  snapshotCount: number;
  /** Distinct owners represented, i.e. how much of the league this week actually covers. */
  ownerCount: number;
  snapshots: ExportedSnapshot[];
}

function fileNameFor(seasonYear: number, week: number): string {
  // Zero-padded so a directory listing sorts the way a season runs.
  return `${seasonYear}-w${String(week).padStart(3, '0')}.json`;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');

  const seasonRows = await db
    .select({ id: seasons.id, year: seasons.year })
    .from(seasons)
    .orderBy(asc(seasons.year));
  const yearById = new Map(seasonRows.map((s) => [s.id, s.year]));

  const rows = await db
    .select({
      seasonId: lineupSnapshots.seasonId,
      ownerSeasonId: lineupSnapshots.ownerSeasonId,
      week: lineupSnapshots.week,
      isExhibition: lineupSnapshots.isExhibition,
      dkDraftGroupId: lineupSnapshots.dkDraftGroupId,
      capturedAt: lineupSnapshots.capturedAt,
      slots: lineupSnapshots.slots,
    })
    .from(lineupSnapshots)
    // Deterministic order, so re-running produces a byte-identical file and git sees no diff
    // when nothing has changed.
    .orderBy(
      asc(lineupSnapshots.seasonId),
      asc(lineupSnapshots.week),
      asc(lineupSnapshots.ownerSeasonId),
      asc(lineupSnapshots.capturedAt),
    );

  if (rows.length === 0) {
    console.log('No captures in the database — nothing to export.');
    return;
  }

  // EVERY version is exported, not just the newest per owner. Captures are append-only
  // precisely so a late swap leaves a trail, and an export that kept only the winner would
  // discard the history the table exists to preserve.
  const byKey = new Map<string, WeekFile>();
  for (const r of rows) {
    const year = yearById.get(r.seasonId);
    if (year === undefined) continue; // orphaned snapshot; nothing sensible to file it under
    const key = `${year}-${r.week}`;
    let file = byKey.get(key);
    if (!file) {
      file = {
        version: 1,
        seasonYear: year,
        seasonId: r.seasonId,
        week: r.week,
        snapshotCount: 0,
        ownerCount: 0,
        snapshots: [],
      };
      byKey.set(key, file);
    }
    file.snapshots.push({
      ownerSeasonId: r.ownerSeasonId,
      week: r.week,
      isExhibition: r.isExhibition,
      dkDraftGroupId: r.dkDraftGroupId,
      capturedAt: r.capturedAt.toISOString(),
      slots: r.slots,
    });
  }

  for (const file of byKey.values()) {
    file.snapshotCount = file.snapshots.length;
    file.ownerCount = new Set(file.snapshots.map((s) => s.ownerSeasonId)).size;
  }

  if (write) mkdirSync(OUT_DIR, { recursive: true });

  let changed = 0;
  let unchanged = 0;
  for (const file of [...byKey.values()].sort(
    (a, b) => a.seasonYear - b.seasonYear || a.week - b.week,
  )) {
    const name = fileNameFor(file.seasonYear, file.week);
    const path = join(OUT_DIR, name);
    const body = `${JSON.stringify(file, null, 2)}\n`;

    let existing: string | null = null;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      existing = null;
    }
    const isChanged = existing !== body;
    if (isChanged) changed += 1;
    else unchanged += 1;

    console.log(
      `  ${name}  ${String(file.snapshotCount).padStart(4)} snapshots  ` +
        `${String(file.ownerCount).padStart(2)} owners  ` +
        `${(body.length / 1024).toFixed(0)} kB  ${isChanged ? (existing ? 'CHANGED' : 'NEW') : 'unchanged'}`,
    );
    if (write && isChanged) writeFileSync(path, body, 'utf8');
  }

  // A week that exists on disk but no longer in the database is a red flag, not housekeeping:
  // captures are append-only, so they should never disappear. Report it and let a human decide.
  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    onDisk = [];
  }
  const expected = new Set(
    [...byKey.values()].map((f) => fileNameFor(f.seasonYear, f.week)),
  );
  const orphans = onDisk.filter((f) => !expected.has(f));
  if (orphans.length > 0) {
    console.warn(
      `\n⚠ ${orphans.length} exported week(s) no longer exist in the database: ${orphans.join(', ')}` +
        '\n  Captures are append-only, so this should be impossible. Investigate before deleting' +
        '\n  anything — the committed file may be the only surviving copy.',
    );
  }

  console.log(
    write
      ? `\n✅ Wrote ${changed} file(s), ${unchanged} already current → scripts/fixtures/captures/` +
          '\n   Commit them: this is the off-Neon copy of data DraftKings will not serve twice.'
      : `\n${changed} file(s) would change, ${unchanged} already current. Re-run with --write.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Export FAILED\n', err);
    process.exit(1);
  });
