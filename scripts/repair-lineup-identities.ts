/**
 * repair-lineup-identities.ts — refill the team/name/position that a capture stored as null.
 *
 *   npx tsx scripts/repair-lineup-identities.ts                  # report, write nothing
 *   npx tsx scripts/repair-lineup-identities.ts --write          # apply the repair
 *   npx tsx scripts/repair-lineup-identities.ts --season=1 --week=1 --write
 *
 * WHY THIS EXISTS
 * A roster capture identifies each drafted player by `draftableId` alone. Until 2026 week 1
 * the only way to turn that into `(name, team, position)` was DraftKings' public draftables
 * endpoint, fetched once at capture time — and `fetchDraftableIndex` swallows its errors and
 * returns an EMPTY MAP rather than throwing. When that happened, `enrichLineups` passed the
 * lineups through untouched and the snapshot was stored with no team on any slot.
 *
 * That is unrecoverable at read time, because a slot with no team cannot be matched to an
 * ESPN boxscore, and it is not confined to the bad capture: /live scores the NEWEST capture
 * per owner and nothing else, so one failed fetch on Tuesday DISCARDED three good captures
 * from Sunday. 2026 week 1 rendered as 288 unresolved slots — every owner on 0.00 — while
 * the capture run logged `status: 'success'`.
 *
 * The scoring engine was never implicated: replaying that same week with identity restored
 * reproduces DraftKings' own number on all 288 slots and all 32 owner totals, exactly.
 *
 * Three sources are tried per slot, cheapest and most trustworthy first:
 *   1. the capture's OWN raw payload — DK's `competition` block names the player's side;
 *      this is what `normalizeSlotObject` now reads, so new captures never need the rest
 *   2. any other capture of the same week that already resolved that draftableId
 *   3. the public draftables endpoint for the snapshot's draft group
 *
 * Writes ONLY `lineup_snapshots.slots`, and only ever fills NULLS — an existing value is
 * never overwritten. Idempotent: a second run reports nothing left to do.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import { eq, inArray } from 'drizzle-orm';

import { db, lineupCaptureRuns, lineupSnapshots } from '@/db';
import { fetchDraftableIndex } from '@/lib/draftkings/draftables';
import {
  hydrateStoredSlots,
  normalizeRosterPayload,
  type LineupSlotInput,
} from '@/lib/lineups/normalize';

interface Identity {
  name: string | null;
  teamKey: string | null;
  position: string | null;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
}

const WRITE = process.argv.includes('--write');
const ONLY_SEASON = arg('season') ? Number(arg('season')) : null;
const ONLY_WEEK = arg('week') ? Number(arg('week')) : null;

/** Merge `next` into `into`, filling only what is still missing. */
function learn(into: Map<string, Identity>, draftableId: string, next: Identity): void {
  const prior = into.get(draftableId);
  into.set(draftableId, {
    name: prior?.name ?? next.name,
    teamKey: prior?.teamKey ?? next.teamKey,
    position: prior?.position ?? next.position,
  });
}

async function main(): Promise<void> {
  const rows = await db
    .select({
      id: lineupSnapshots.id,
      seasonId: lineupSnapshots.seasonId,
      week: lineupSnapshots.week,
      ownerSeasonId: lineupSnapshots.ownerSeasonId,
      draftGroupId: lineupSnapshots.dkDraftGroupId,
      captureRunId: lineupSnapshots.captureRunId,
      slots: lineupSnapshots.slots,
    })
    .from(lineupSnapshots);

  const scoped = rows.filter(
    (r) =>
      (ONLY_SEASON === null || r.seasonId === ONLY_SEASON) &&
      (ONLY_WEEK === null || r.week === ONLY_WEEK),
  );

  const broken = scoped.filter((r) =>
    hydrateStoredSlots(r.slots).some((s) => s.revealed && s.teamKey === null),
  );

  if (broken.length === 0) {
    console.log(`Nothing to repair — every revealed slot in ${scoped.length} snapshot(s) has a team.`);
    return;
  }

  const weeks = [...new Set(broken.map((r) => `${r.seasonId}:${r.week}`))];
  console.log(
    `${broken.length} of ${scoped.length} snapshot(s) carry team-less slots, across ${weeks.length} week(s): ${weeks.join(', ')}`,
  );

  // --- source 2: everything any capture of an affected week already resolved -------------
  const known = new Map<string, Identity>();
  for (const row of scoped) {
    if (!weeks.includes(`${row.seasonId}:${row.week}`)) continue;
    for (const slot of hydrateStoredSlots(row.slots)) {
      if (slot.draftableId && slot.teamKey) learn(known, slot.draftableId, slot);
    }
  }
  console.log(`  ${known.size} draftableId(s) already identified by a sibling capture`);

  // --- source 1: the raw payloads of the affected captures -------------------------------
  const runIds = [...new Set(broken.map((r) => r.captureRunId).filter((id): id is number => id !== null))];
  if (runIds.length > 0) {
    const runs = await db
      .select({ id: lineupCaptureRuns.id, rawPayload: lineupCaptureRuns.rawPayload })
      .from(lineupCaptureRuns)
      .where(inArray(lineupCaptureRuns.id, runIds));

    let fromPayload = 0;
    for (const run of runs) {
      if (!run.rawPayload) continue;
      for (const lineup of normalizeRosterPayload(run.rawPayload).lineups) {
        for (const slot of lineup.slots) {
          if (!slot.draftableId || !slot.teamKey) continue;
          if (!known.has(slot.draftableId)) fromPayload += 1;
          learn(known, slot.draftableId, slot);
        }
      }
    }
    console.log(`  ${fromPayload} further draftableId(s) recovered from the stored raw payloads`);
  }

  // --- source 3: the public draftables endpoint ------------------------------------------
  const stillMissing = new Set<string>();
  for (const row of broken) {
    for (const slot of hydrateStoredSlots(row.slots)) {
      if (slot.revealed && slot.teamKey === null && slot.draftableId && !known.get(slot.draftableId)?.teamKey) {
        stillMissing.add(slot.draftableId);
      }
    }
  }
  if (stillMissing.size > 0) {
    const groups = [...new Set(broken.map((r) => r.draftGroupId).filter((g): g is string => !!g))];
    console.log(`  ${stillMissing.size} still unidentified — querying draft group(s) ${groups.join(', ')}`);
    for (const group of groups) {
      const index = await fetchDraftableIndex(group);
      if (index.size === 0) {
        console.warn(`  ! draft group ${group} returned nothing (expired or unreachable)`);
        continue;
      }
      for (const id of stillMissing) {
        const hit = index.get(id);
        if (hit) learn(known, id, hit);
      }
    }
  }

  // --- apply -----------------------------------------------------------------------------
  let repairedSlots = 0;
  let repairedRows = 0;
  const unresolved = new Set<string>();

  for (const row of broken) {
    const slots = hydrateStoredSlots(row.slots);
    let changed = 0;

    const next: LineupSlotInput[] = slots.map((slot) => {
      if (!slot.revealed || !slot.draftableId) return slot;
      if (slot.name !== null && slot.teamKey !== null && slot.position !== null) return slot;
      const hit = known.get(slot.draftableId);
      if (!hit) {
        if (slot.teamKey === null) unresolved.add(`${slot.name ?? '?'} (${slot.draftableId})`);
        return slot;
      }
      if (slot.teamKey === null && hit.teamKey !== null) changed += 1;
      return {
        ...slot,
        name: slot.name ?? hit.name,
        teamKey: slot.teamKey ?? hit.teamKey,
        position: slot.position ?? hit.position,
      };
    });

    if (changed === 0) continue;
    repairedSlots += changed;
    repairedRows += 1;

    if (WRITE) {
      await db
        .update(lineupSnapshots)
        .set({ slots: next as unknown as object })
        .where(eq(lineupSnapshots.id, row.id));
    }
  }

  console.log(
    `\n${WRITE ? 'Repaired' : 'Would repair'} ${repairedSlots} slot(s) across ${repairedRows} snapshot(s).`,
  );
  if (unresolved.size > 0) {
    console.warn(`Still unidentified (${unresolved.size}):`);
    for (const u of unresolved) console.warn(`  - ${u}`);
  }
  if (!WRITE) console.log('\nDry run — pass --write to apply.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
