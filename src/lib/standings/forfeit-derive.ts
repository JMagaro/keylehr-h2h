/**
 * Deriving byes and forfeits — the two facts the scoring engine needs that the `scores`
 * table cannot be trusted to carry.
 *
 * WHY DERIVE AT ALL
 * `scores.isBye` and `scores.isForfeit` are persisted *derivations* of facts that live in
 * other tables (`nfl_games`, `matchups`), written once at ingest time with no recompute
 * trigger. That drifts in two directions that both actually occur:
 *
 *   - `isForfeit` is written by the historical backfill scripts and by nothing else. The
 *     live DraftKings ingest path never sets it, so on a live season the league's entire
 *     missed-lineup rule silently does not apply.
 *   - `isBye` is computed from whether a `matchups` row exists at ingest time. Sync a week's
 *     scores before generating its matchups and all 32 owners are written `isBye = true`,
 *     which erases their Points For and their weekly-high eligibility.
 *
 * Deriving at read time fixes both, self-heals when data arrives out of order, and handles
 * the case a write-time fix structurally cannot: an owner with **no `scores` row at all**.
 *
 * COMPOSITION: derived ∪ stored. A stored `isForfeit = true` is always honored, so the
 * commissioner keeps a manual override for cases no rule can infer.
 *
 * Pure / no DB. Callers map their rows into the small shapes below.
 */

/** The score fields these derivations read. */
export interface ScoreRow {
  ownerSeasonId: number;
  week: number;
  /** `numeric` from the driver is a string; callers convert once before passing. */
  dkPoints: number | null;
  isBye: boolean;
  isForfeit: boolean;
}

/** The matchup fields these derivations read. */
export interface MatchupRow {
  week: number;
  homeOwnerSeasonId: number;
  awayOwnerSeasonId: number;
  isPlayoff: boolean;
}

/** Canonical `${ownerSeasonId}:${week}` key, shared by every map/set in the scoring path. */
export function ownerWeekKey(ownerSeasonId: number, week: number): string {
  return `${ownerSeasonId}:${week}`;
}

/**
 * The set of owner-weeks that have a REGULAR-SEASON matchup — i.e. the owners who were
 * actually scheduled to play. This is the authority for "not a bye", and the precondition
 * for "could have missed a lineup".
 */
export function buildPlayingSet(matchups: readonly MatchupRow[]): Set<string> {
  const playing = new Set<string>();
  for (const m of matchups) {
    if (m.isPlayoff) continue;
    playing.add(ownerWeekKey(m.homeOwnerSeasonId, m.week));
    playing.add(ownerWeekKey(m.awayOwnerSeasonId, m.week));
  }
  return playing;
}

/**
 * Reconcile a stored `isBye` flag against the schedule.
 *
 * An owner who has a regular-season matchup that week was, by definition, not on a bye —
 * so a row flagged `isBye = true` is self-contradictory and the flag is ignored. This is
 * what protects a week whose scores were ingested before its matchups existed.
 *
 * Playoff and exhibition weeks never produce byes: `matchups` holds only regular-season
 * rows (playoff games live in `playoff_matchups`), so "no matchup row" is meaningless there
 * and would otherwise mark every participant as a bye.
 */
export function isEffectiveBye(params: {
  storedIsBye: boolean;
  ownerSeasonId: number;
  week: number;
  regularSeasonWeeks: number;
  playing: ReadonlySet<string>;
}): boolean {
  const { storedIsBye, ownerSeasonId, week, regularSeasonWeeks, playing } = params;
  if (!storedIsBye) return false;
  if (week > regularSeasonWeeks) return false; // playoff / exhibition namespace
  return !playing.has(ownerWeekKey(ownerSeasonId, week));
}

/**
 * Owner-weeks that are byes, derived from the schedule rather than trusted from the column.
 * Convenience wrapper over {@link isEffectiveBye} for callers that want the whole set.
 */
export function deriveByes(params: {
  scores: readonly ScoreRow[];
  matchups: readonly MatchupRow[];
  regularSeasonWeeks: number;
}): Set<string> {
  const { scores, matchups, regularSeasonWeeks } = params;
  const playing = buildPlayingSet(matchups);
  const byes = new Set<string>();
  for (const s of scores) {
    const bye = isEffectiveBye({
      storedIsBye: s.isBye,
      ownerSeasonId: s.ownerSeasonId,
      week: s.week,
      regularSeasonWeeks,
      playing,
    });
    if (bye) byes.add(ownerWeekKey(s.ownerSeasonId, s.week));
  }
  return byes;
}

export interface DeriveForfeitsParams {
  scores: readonly ScoreRow[];
  matchups: readonly MatchupRow[];
  /**
   * Weeks whose NFL games have all finished. Derivation runs ONLY for these — see the
   * "settled" note below.
   */
  settledWeeks: ReadonlySet<number>;
  regularSeasonWeeks: number;
}

/**
 * The owner-weeks to treat as missed lineups: **derived ∪ stored**.
 *
 * Derived (settled regular-season weeks only) — an owner who had a matchup that week and:
 *   - has no `scores` row at all, or
 *   - has a non-bye row worth exactly 0.
 *
 * THE SETTLED GATE IS THE WHOLE SAFETY ARGUMENT. Without it, a sync run at 11am Sunday sees
 * 32 owners on 0.00 points and resolves the week as 32 forfeits, each triggering an
 * auto-loss and charging its opponent the league average. Deriving nothing until every game
 * that week is final makes that impossible; an in-progress week simply resolves as unplayed.
 *
 * Stored `isForfeit = true` is always included regardless of week or points, preserving the
 * manual override (and making this function a provable no-op on the historical seasons,
 * whose importers set the flag using exactly this rule).
 */
export function deriveForfeits(params: DeriveForfeitsParams): Set<string> {
  const { scores, matchups, settledWeeks, regularSeasonWeeks } = params;
  const playing = buildPlayingSet(matchups);
  const forfeits = new Set<string>();

  // Stored flags always win — never drop a manually-set forfeit.
  const scoreByKey = new Map<string, ScoreRow>();
  for (const s of scores) {
    const key = ownerWeekKey(s.ownerSeasonId, s.week);
    scoreByKey.set(key, s);
    if (s.isForfeit) forfeits.add(key);
  }

  for (const key of playing) {
    const [ownerPart, weekPart] = key.split(':');
    const week = Number(weekPart);
    if (!Number.isInteger(week) || week > regularSeasonWeeks) continue;
    if (!settledWeeks.has(week)) continue;

    const row = scoreByKey.get(key);
    if (row === undefined) {
      // Scheduled to play, week is over, never posted a score at all.
      forfeits.add(ownerWeekKey(Number(ownerPart), week));
      continue;
    }
    if (!row.isBye && row.dkPoints !== null && row.dkPoints === 0) {
      forfeits.add(key);
    }
  }

  return forfeits;
}
