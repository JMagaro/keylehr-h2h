/**
 * Resolve `draftableId` → (name, team, position) on a captured lineup.
 *
 * DraftKings' authenticated roster payload is deliberately thin: each drafted player arrives
 * as a `draftableId` plus a roster slot. There is NO team abbreviation and no player
 * position anywhere in it (see scripts/fixtures/dk-roster-entry.json). Scoring reaches
 * ESPN's boxscore by `(normalizeName, teamKey)`, so a raw capture is not yet scorable.
 *
 * The missing half comes from DraftKings' PUBLIC draftables endpoint, which needs no auth —
 * which is the whole point of the architecture: authenticate once for WHO was started, then
 * compute all week from public data.
 *
 * Enrichment happens at CAPTURE time, not at read time, because DK expires draftables for
 * old draft groups. A snapshot has to stand on its own months later.
 */
import { fetchDraftableIndex, type DraftableIdentity } from '@/lib/draftkings/draftables';

import type { LineupInput, LineupSlotInput } from './normalize';

export interface EnrichResult {
  lineups: LineupInput[];
  /** Slots that gained a team key they didn't have. */
  enriched: number;
  /** Revealed draftableIds absent from the index — surfaced, never silently zeroed. */
  unresolvedIds: string[];
}

/**
 * Pure half: apply an already-fetched index. Split out so it is unit-testable without a
 * network call, and so a caller holding an index can enrich many captures with one fetch.
 *
 * Existing values always win. DraftKings' own roster payload is closer to the source than a
 * separately-fetched slate, and a hand-pasted lineup may carry corrections we should not
 * overwrite.
 */
export function applyDraftableIndex(
  lineups: LineupInput[],
  index: ReadonlyMap<string, DraftableIdentity>,
): EnrichResult {
  let enriched = 0;
  const unresolved = new Set<string>();

  const out = lineups.map((lineup) => ({
    ...lineup,
    slots: lineup.slots.map((slot): LineupSlotInput => {
      // Concealed slots have no identity at all yet — nothing to look up, and their absence
      // is expected rather than a failure.
      if (!slot.revealed || !slot.draftableId) return slot;

      const hit = index.get(slot.draftableId);
      if (!hit) {
        unresolved.add(slot.draftableId);
        return slot;
      }

      if (slot.teamKey === null && hit.teamKey !== null) enriched += 1;

      return {
        ...slot,
        dkPlayerId: slot.dkPlayerId ?? hit.dkPlayerId,
        name: slot.name ?? hit.name,
        teamKey: slot.teamKey ?? hit.teamKey,
        position: slot.position ?? hit.position,
      };
    }),
  }));

  return { lineups: out, enriched, unresolvedIds: [...unresolved] };
}

/**
 * Fetch the draft group's draftables and enrich in one step.
 *
 * Never throws: `fetchDraftableIndex` already swallows network errors and returns an empty
 * map, which passes lineups through untouched. A capture that stores names without teams is
 * far better than a capture that fails — the teams can be backfilled from a later run.
 */
export async function enrichLineups(
  lineups: LineupInput[],
  draftGroupId: string,
): Promise<EnrichResult> {
  const index = await fetchDraftableIndex(draftGroupId);
  if (index.size === 0) return { lineups, enriched: 0, unresolvedIds: [] };
  return applyDraftableIndex(lineups, index);
}
