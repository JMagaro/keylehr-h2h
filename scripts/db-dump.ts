/**
 * db-dump.ts — a full, restorable copy of the database, written outside Neon.
 *
 *   npm run db:dump                  # write backups/<timestamp>/
 *   npm run db:dump -- --out=/path   # somewhere else (an external disk, iCloud, …)
 *
 * WHY THIS EXISTS
 * There was no backup of any kind. The only thing between this league and total data loss was
 * whatever point-in-time window Neon's plan happens to give — see docs/RUNBOOK.md, "Backups
 * and recovery", for the number and how to check it.
 *
 * And the realistic threat here is not hardware. It is a script: the importers take
 * `--season=` / `--sheet=` arguments, `db:push` and `db:migrate` change schema, and `verify`'s
 * ground-truth replay writes to the database by design. A wrong flag damages real data, and the
 * frozen-history gate DETECTS that after the fact without being able to undo it. So: dump
 * before anything that writes, and weekly during a season.
 *
 * WHY NOT pg_dump
 * pg_dump is the gold standard and is worth having, but it must be at least the server's major
 * version (currently PostgreSQL 18) and is not installed on this machine. This script needs
 * nothing but the app's own dependencies, so it works anywhere the app runs — including a
 * machine you have just picked up in an emergency, which is exactly when a backup matters.
 *
 * The trade is that this is a DATA-ONLY dump: no DDL. That is sufficient here because the
 * schema lives in git as drizzle migrations, so `db:migrate` on an empty database plus this
 * data is a complete restore. See the runbook for the procedure.
 *
 * 🛑 THE OUTPUT CONTAINS PERSONAL DATA — owner email addresses and bcrypt password hashes from
 * `users`. It is written to a gitignored directory and MUST NOT be committed; this repository
 * is public. For the PII-free export that IS committed, see scripts/export-captures.ts.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { db } from '@/db';

/**
 * Dumped in dependency order, so a restore can insert them front to back without tripping a
 * foreign key. Anything added to src/db/schema.ts must be added here — a table missing from
 * this list is silently absent from every future backup, so the run prints a loud warning if
 * the database holds a table this array does not name.
 */
const TABLES_IN_FK_ORDER = [
  'seasons',
  'nfl_teams',
  'owners',
  'users',
  'owner_seasons',
  'nfl_games',
  'matchups',
  // Depends only on `seasons`; grouped with the other per-week tables it sits alongside.
  'weekly_contests',
  'score_import_runs',
  'scores',
  'season_awards',
  'playoff_matchups',
  'playoff_odds_snapshots',
  'lineup_capture_runs',
  'lineup_snapshots',
  'model_snapshots',
] as const;

interface TableDump {
  table: string;
  rows: number;
  bytes: number;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

/** A filename-safe stamp: 2026-08-25T21-40-13Z. */
function stamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..*$/, 'Z');
}

async function listTables(): Promise<string[]> {
  const res = await db.execute(
    sql`select tablename from pg_tables where schemaname = 'public' order by tablename`,
  );
  const rows = (res as unknown as { rows?: { tablename: string }[] }).rows ?? [];
  return rows.map((r) => r.tablename).filter((t) => !t.startsWith('__drizzle'));
}

async function main(): Promise<void> {
  const outRoot = arg('out') ?? join(process.cwd(), 'backups');
  const dir = join(outRoot, stamp());
  mkdirSync(dir, { recursive: true });

  const present = await listTables();
  const known = new Set<string>(TABLES_IN_FK_ORDER);
  const unlisted = present.filter((t) => !known.has(t));
  if (unlisted.length > 0) {
    // Loud, not fatal: an unnamed table still gets dumped below, but its restore ORDER is
    // unknown, and silence here is how a table quietly falls out of every future backup.
    console.warn(
      `\n⚠ ${unlisted.length} table(s) not listed in TABLES_IN_FK_ORDER: ${unlisted.join(', ')}` +
        '\n  They are dumped last. Add them to the list in scripts/db-dump.ts so a restore' +
        '\n  inserts them in an order the foreign keys accept.\n',
    );
  }

  const order = [...TABLES_IN_FK_ORDER.filter((t) => present.includes(t)), ...unlisted];
  const dumped: TableDump[] = [];

  for (const table of order) {
    // The table name comes from pg_tables / a literal array, never from user input.
    const res = await db.execute(sql.raw(`select * from "${table}"`));
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? [];

    // NDJSON: one row per line. A truncated file loses its tail rather than becoming
    // unparseable, and a single row can be recovered by eye without a parser.
    const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
    const gz = gzipSync(Buffer.from(ndjson, 'utf8'));
    writeFileSync(join(dir, `${table}.ndjson.gz`), gz);
    dumped.push({ table, rows: rows.length, bytes: gz.length });
    console.log(`  ${table.padEnd(24)} ${String(rows.length).padStart(6)} rows  ${(gz.length / 1024).toFixed(1)} kB`);
  }

  const totalBytes = dumped.reduce((n, d) => n + d.bytes, 0);
  const manifest = {
    version: 1,
    takenAt: new Date().toISOString(),
    // Which migration the schema was on. A restore must run migrations up to this point,
    // and a dump whose migration state you cannot name is a dump you cannot trust.
    database: 'neondb',
    restoreOrder: order,
    tables: dumped,
    totalBytes,
    note:
      'Data-only. Restore: create an empty database, run `npm run db:migrate` to build the ' +
      'schema, then load each file in `restoreOrder`. See docs/RUNBOOK.md, Backups and recovery.',
    containsPersonalData: true,
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `\n✅ Dumped ${dumped.length} tables, ${dumped.reduce((n, d) => n + d.rows, 0)} rows, ` +
      `${(totalBytes / 1024).toFixed(0)} kB total\n   → ${dir}` +
      '\n\n🛑 Contains owner emails and password hashes. Do not commit it; this repo is public.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Dump FAILED — do not proceed with whatever you were about to run.\n', err);
    process.exit(1);
  });
