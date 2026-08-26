/**
 * The safety invariant, enforced mechanically rather than by discipline.
 *
 * Live scoring produces an ESTIMATE. If any of it ever writes to `scores` — or feeds the
 * standings engine, the settled-week gate, or bye/forfeit derivation — then a mid-Sunday
 * state where every owner sits near zero becomes readable as 32 forfeits. That is the exact
 * class of bug docs/SCORING.md exists to document, and it is the reason rosters live in
 * their own tables instead of a column on `scores`.
 *
 * A comment saying "don't do this" does not survive a refactor six months from now. This
 * test does. It scans the live-scoring modules for writes to the score/standings tables and
 * fails the build if one appears.
 *
 * If you are here because this test failed: you almost certainly want a new table, not a
 * write to an existing one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

/** Directories that make up the live-scoring path. Missing ones are simply skipped. */
const GUARDED_DIRS = ['dfs', 'lineups', 'live'];

/**
 * Forbidden patterns. Drizzle writes always read as `.insert(<table>` / `.update(<table>` /
 * `.delete(<table>`, so matching the call plus the table name is precise enough to avoid
 * flagging a legitimate READ of the same table (which is allowed — the live page reads
 * `scores` to show DraftKings' authoritative number alongside the estimate).
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\.insert\(\s*scores\b/, why: 'inserts into `scores`' },
  { pattern: /\.update\(\s*scores\b/, why: 'updates `scores`' },
  { pattern: /\.delete\(\s*scores\b/, why: 'deletes from `scores`' },
  { pattern: /\.insert\(\s*matchups\b/, why: 'inserts into `matchups`' },
  { pattern: /\.update\(\s*matchups\b/, why: 'updates `matchups`' },
  { pattern: /\.delete\(\s*matchups\b/, why: 'deletes from `matchups`' },
  { pattern: /\.insert\(\s*playoffMatchups\b/, why: 'inserts into `playoff_matchups`' },
  { pattern: /\.update\(\s*playoffMatchups\b/, why: 'updates `playoff_matchups`' },
  { pattern: /\.insert\(\s*seasonAwards\b/, why: 'inserts into `season_awards`' },
  { pattern: /\.update\(\s*seasonAwards\b/, why: 'updates `season_awards`' },
  { pattern: /\.insert\(\s*nflGames\b/, why: 'inserts into `nfl_games`' },
  { pattern: /\.update\(\s*nflGames\b/, why: 'updates `nfl_games`' },
  { pattern: /ingestLeaderboard\s*\(/, why: 'calls the SCORE ingest' },
  { pattern: /writeTeamScores\s*\(/, why: 'calls the SCORE writer' },
];

const libDir = fileURLToPath(new URL('..', import.meta.url));
/**
 * The ROUTES are guarded too, not just the libraries behind them. A server component or route
 * handler can reach the database directly, so "the lib layer is clean" would be an incomplete
 * proof.
 *
 * Add any new surface that reads the live-scoring path here. Each of these carries a
 * "NOTHING HERE WRITES" comment in its header — this is what makes that a proof rather than
 * an intention.
 */
const guardedRouteDirs = [
  '../../app/live',
  // The capture-staleness endpoint the extension polls.
  '../../app/api/live-status',
  // The scoring-drift audit, which reads captures and box scores to compare them.
  '../../app/admin/(panel)/scoring',
].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));

function collectSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // directory not created yet (a later phase)
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.test.tsx')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('live scoring never writes a score', () => {
  const files = [
    ...GUARDED_DIRS.flatMap((d) => collectSourceFiles(join(libDir, d))),
    ...guardedRouteDirs.flatMap((d) => collectSourceFiles(d)),
  ];

  it('finds the live-scoring modules to guard', () => {
    // A guard that silently scans nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each([
    ['/live', `${sep}app${sep}live${sep}`],
    ['/api/live-status', `${sep}app${sep}api${sep}live-status${sep}`],
    ['admin scoring audit', `${sep}scoring${sep}`],
  ])('guards the %s route, not only the libraries behind it', (_label, marker) => {
    // Each route dir is asserted individually: a typo'd path would silently scan nothing,
    // and a guard that scans nothing passes.
    expect(files.some((f) => f.includes(marker))).toBe(true);
  });

  it.each(files.map((f) => [f.slice(f.indexOf(`${sep}src${sep}`) + 1), f]))(
    '%s does not write to the scoring chain',
    (_label, full) => {
      const source = readFileSync(full, 'utf8');
      const violations = FORBIDDEN.filter((f) => f.pattern.test(source)).map((f) => f.why);
      expect(violations).toEqual([]);
    },
  );
});
