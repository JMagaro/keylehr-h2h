/**
 * Finding superseded playoff bracket rows.
 *
 * `upsertRoundGames` matches existing rows by their structural key
 * `(round, conference, highSeed, lowSeed)` and never deletes. That is fine while a round's
 * pairings are stable, but they are not: `setGameWinner` (the admin override) re-runs
 * `advancePlayoffs`, and a different winner produces a DIFFERENT next-round pairing. The new
 * pairing gets inserted under a new key and the old row survives as a phantom game.
 *
 * The damage compounds. A stale divisional row is scored from that week's `scores` like any
 * other, counts toward "is the round resolved?", and feeds `advanceBracket` — so a conference
 * can end up with three advancing owners, two championship rows, and a $2000 champion payout
 * read off the wrong game.
 *
 * Making `upsertRoundGames` authoritative for the rounds it writes fixes it at the source.
 *
 * Pure / no DB.
 */

/** An existing bracket row, as far as pruning is concerned. */
export interface ExistingGameRow {
  id: number;
  round: string;
  conference: string | null;
  highSeed: number | null;
  lowSeed: number | null;
}

/** A pairing the caller is about to write. */
export interface DesiredGame {
  round: string;
  conference: string | null;
  highSeed: number;
  lowSeed: number;
}

/** The structural identity of a playoff row. Mirrors `service.ts` `gameKey`. */
export function bracketKey(
  round: string,
  conference: string | null,
  highSeed: number,
  lowSeed: number,
): string {
  return `${round}|${conference ?? 'XF'}|${highSeed}|${lowSeed}`;
}

/** The slice of the bracket a write claims authority over. */
const scopeOf = (round: string, conference: string | null): string => `${round}|${conference ?? 'XF'}`;

/**
 * Ids of rows that should be removed because their slice of the bracket is being rewritten
 * and they are no longer part of it.
 *
 * Authority is scoped to the (round, conference) pairs actually present in `desired`. Today
 * `advanceBracket` always returns a complete round across both conferences, so scoping by
 * round alone would be equivalent — but scoping by conference too means a future caller that
 * writes one conference at a time cannot wipe the other. Passing an empty `desired` deletes
 * nothing, the safe reading of "no opinion".
 */
export function staleGameIds(
  existing: readonly ExistingGameRow[],
  desired: readonly DesiredGame[],
): number[] {
  const scopes = new Set(desired.map((d) => scopeOf(d.round, d.conference)));
  const keep = new Set(desired.map((d) => bracketKey(d.round, d.conference, d.highSeed, d.lowSeed)));

  return existing
    .filter((e) => scopes.has(scopeOf(e.round, e.conference)))
    .filter((e) => !keep.has(bracketKey(e.round, e.conference, e.highSeed ?? -1, e.lowSeed ?? -1)))
    .map((e) => e.id);
}
