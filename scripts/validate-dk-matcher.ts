/**
 * Validate the DraftKings EntryName → owner matcher against raw weekly leaderboards.
 *
 * The live scoring pipeline (and the DK Browser-Sync Chrome extension) matches each
 * leaderboard entry to an owner by its `EntryName`. This script pulls each available
 * `Week N` leaderboard tab from the league's Google Sheet, runs its EntryName list
 * against Season 3's `dkEntryName` map, and reports per-week matched/unmatched counts
 * plus any unmatched names — independently validating the matcher the extension relies on.
 *
 * Usage:  tsx scripts/validate-dk-matcher.ts
 */
import '@/load-env';

import { eq } from 'drizzle-orm';

import { db, owners, ownerSeasons, seasons } from '@/db';

const SHEET_ID = '1FsZRCawf2w0nvTigQ5_GjL4fT-MC-P5zfcZZTphsySU';
const SEASON_YEAR = 2025;
const WEEKS = 18;

function tabUrl(tab: string): string {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tab,
  )}`;
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
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchTab(tab: string): Promise<string[][] | null> {
  const res = await fetch(tabUrl(tab));
  if (!res.ok) return null;
  return parseCsv(await res.text());
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Detect a real DK leaderboard header: starts with Rank, EntryId, EntryName. */
function isLeaderboardHeader(row: string[] | undefined): boolean {
  if (!row) return false;
  return (
    normalize(row[0] ?? '') === 'rank' &&
    normalize(row[1] ?? '') === 'entryid' &&
    normalize(row[2] ?? '') === 'entryname'
  );
}

/** Extract the EntryName column from a DK leaderboard tab (skips non-leaderboard tabs). */
function extractEntryNames(rows: string[][]): string[] | null {
  if (!isLeaderboardHeader(rows[0])) return null;
  const names: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][2] ?? '').trim();
    if (name) names.push(name);
  }
  return names;
}

async function main(): Promise<void> {
  const [season] = await db.select().from(seasons).where(eq(seasons.year, SEASON_YEAR)).limit(1);
  if (!season) {
    throw new Error(`Season ${SEASON_YEAR} not found. Run import-season3.ts first.`);
  }

  // Build the matcher: normalized dkEntryName (fallback dkUsername) -> owner name.
  const ownerRows = await db
    .select({
      dkEntryName: ownerSeasons.dkEntryName,
      dkUsername: owners.dkUsername,
      ownerName: owners.name,
    })
    .from(ownerSeasons)
    .innerJoin(owners, eq(ownerSeasons.ownerId, owners.id))
    .where(eq(ownerSeasons.seasonId, season.id));

  const byName = new Map<string, string>();
  for (const r of ownerRows) {
    if (r.dkEntryName) byName.set(normalize(r.dkEntryName), r.ownerName);
    if (r.dkUsername && !byName.has(normalize(r.dkUsername)))
      byName.set(normalize(r.dkUsername), r.ownerName);
  }
  console.log(`Matcher built from ${ownerRows.length} owner_seasons (${byName.size} keys).\n`);

  let totalEntries = 0;
  let totalMatched = 0;
  let leaderboardWeeks = 0;
  const allUnmatched = new Set<string>();

  for (let week = 1; week <= WEEKS; week++) {
    const rows = await fetchTab(`Week ${week}`);
    if (!rows) {
      console.log(`Week ${String(week).padStart(2)}: tab not found`);
      continue;
    }
    const names = extractEntryNames(rows);
    if (!names) {
      console.log(`Week ${String(week).padStart(2)}: not a leaderboard tab (skipped)`);
      continue;
    }
    leaderboardWeeks++;
    let matched = 0;
    const unmatched: string[] = [];
    for (const name of names) {
      if (byName.has(normalize(name))) matched++;
      else {
        unmatched.push(name);
        allUnmatched.add(name);
      }
    }
    totalEntries += names.length;
    totalMatched += matched;
    console.log(
      `Week ${String(week).padStart(2)}: entries=${String(names.length).padStart(3)} matched=${String(matched).padStart(3)} unmatched=${unmatched.length}` +
        (unmatched.length ? `  -> ${unmatched.join(', ')}` : ''),
    );
  }

  const rate = totalEntries === 0 ? 0 : (totalMatched / totalEntries) * 100;
  console.log('\n=== DK Matcher Summary ===');
  console.log(`Leaderboard weeks scanned: ${leaderboardWeeks}`);
  console.log(`Total entries: ${totalEntries}, matched: ${totalMatched} (${rate.toFixed(1)}%)`);
  console.log(
    allUnmatched.size === 0
      ? 'Distinct unmatched EntryNames: none'
      : `Distinct unmatched EntryNames (${allUnmatched.size}): ${[...allUnmatched].join(', ')}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('\nvalidate-dk-matcher failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
