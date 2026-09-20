/**
 * The one-line roster summary under an owner's name, shared by the week list and the detail
 * page so the two can never describe the same roster differently.
 *
 * WHY THIS IS ITS OWN FILE: the wording is load-bearing, and it was wrong in both places at
 * once. Both summed `pending + concealed` and called the total "to play" — which reads as
 * "these players have not kicked off yet, so nothing is missing". That is true of `pending`
 * and FALSE of `concealed`, and the difference is the whole story of a stale capture:
 *
 *   pending     We know exactly who this is; their game has not started. Worth nothing YET,
 *               and the total below is complete as of right now.
 *   concealed   DraftKings hid this pick when the roster was read, so we do not know WHO it
 *               is — and if their game has since started they are scoring points the total
 *               does not include. The total is a FLOOR, not a score.
 *
 * Collapsing them made a stale capture look like a normal mid-afternoon scoreboard. In 2026
 * week 2 the only capture was taken at 1:08pm, so the entire late slate stayed concealed: the
 * page read "7 playing · 2 to play" and showed 56.02 while DraftKings showed 78.42, and the
 * 22.40 difference was exactly the two hidden players (CeeDee Lamb 19.90 + 2.50). Nothing was
 * mis-scored; two players were invisible and the label said that was fine.
 *
 * So `concealed` is now reported as **unknown**, which is the honest word in every case: at
 * 1pm we genuinely do not know who they are, and at 5pm we do not know what they have scored.
 * `assessCaptureStaleness` (src/lib/live/staleness.ts) is what turns that into the actionable
 * "re-sync" banner.
 */
import type { LiveTeam } from '@/lib/live/assemble';

/**
 * Count phrases for a captured roster, in reading order.
 *
 * Returns the pieces rather than a joined string so each caller can prepend its own context
 * (the detail page leads with minutes remaining) without re-deriving the counts.
 */
export function rosterSummaryParts(team: LiveTeam): string[] {
  const parts = [`${team.scored + team.noStats} playing`];
  // Distinct clauses on purpose — see the header. A roster can legitimately have both.
  if (team.pending > 0) parts.push(`${team.pending} to play`);
  if (team.concealed > 0) parts.push(`${team.concealed} unknown`);
  if (team.unresolved > 0) parts.push(`${team.unresolved} unresolved`);
  return parts;
}

/**
 * True when this roster's total is a FLOOR rather than a running score.
 *
 * `pending` is deliberately NOT included: a player who has not kicked off is worth nothing
 * yet, so the total is complete and correct at this moment. Only slots whose points we cannot
 * see — hidden picks and failed matches — make the number an understatement.
 */
export function isFloorTotal(team: LiveTeam): boolean {
  return team.hasSnapshot && team.concealed + team.unresolved > 0;
}
