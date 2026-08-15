/**
 * Projected final scores, and who is winning.
 *
 * THE FORMULA IS DRAFTKINGS' OWN, not an invention. DK's roster payload carries both a
 * `pregameProjection` and a `realTimeProjection`, and the relationship between them was
 * reverse-engineered exactly from three captured samples — matching to nine decimal places:
 *
 *     projected = score + pregameProjection × (minutesRemaining / 60)
 *
 *   Trammell  1.50 + 14.6667 × (34.35/60) = 9.896667   DK: 9.896667
 *   Trammell  3.80 + 14.6667 × (30.00/60) = 11.133333  DK: 11.133333
 *   Williams  0.00 + 14.6667 × (60.00/60) = 14.666667  DK: 14.666667
 *
 * In words: a player is expected to keep earning at their pregame rate for whatever game time
 * is left. We recompute it live from ESPN's clock instead of storing DK's number, because DK's
 * is only as fresh as the last capture — and the whole point is to keep moving without one.
 *
 * Pure. No DB, no network, no clock of its own.
 */
import type { LiveSlot, LiveTeam } from './assemble';
import { minutesLeftInGame, type GameClock } from './minutes';

const REGULATION_MINUTES = 60;

export interface LineupProjection {
  /** Points already banked (the same figure the scoreboard shows). */
  current: number;
  /** Projected final, i.e. current plus what the remaining game time is expected to yield. */
  projected: number;
  /** Slots with no pregame projection — projected excludes their future contribution. */
  unprojectedSlots: number;
  /** True when nothing is left to play: projected equals current, and this is the result. */
  isFinal: boolean;
}

/** One slot's projected final. Null when we have no basis to project it. */
export function projectSlot(
  slot: LiveSlot,
  clock: GameClock | undefined,
): number | null {
  const banked = slot.points ?? 0;

  // No pregame projection captured (a concealed player, or an older capture) — we can report
  // what they have but must not invent what they will get.
  if (slot.dkProjection === null) return slot.points === null ? null : banked;

  const minutesLeft = clock ? minutesLeftInGame(clock) : REGULATION_MINUTES;
  return banked + slot.dkProjection * (minutesLeft / REGULATION_MINUTES);
}

export function projectLineup(
  team: LiveTeam,
  clockByTeam: Record<string, GameClock | undefined>,
): LineupProjection {
  let projected = 0;
  let unprojectedSlots = 0;
  let anyTimeLeft = false;

  for (const slot of team.slots) {
    const clock = slot.teamKey ? clockByTeam[slot.teamKey] : undefined;

    // A concealed slot has no identity and therefore no projection, but DK conceals exactly
    // until kickoff — so it does have a full game ahead, and pretending otherwise would
    // understate a lineup that has barely started.
    const minutesLeft =
      slot.status === 'concealed' ? REGULATION_MINUTES : clock ? minutesLeftInGame(clock) : 0;
    if (minutesLeft > 0) anyTimeLeft = true;

    if (slot.dkProjection === null) {
      projected += slot.points ?? 0;
      if (minutesLeft > 0) unprojectedSlots += 1;
      continue;
    }
    projected += (slot.points ?? 0) + slot.dkProjection * (minutesLeft / REGULATION_MINUTES);
  }

  return {
    current: team.points,
    projected: Math.round(projected * 100) / 100,
    unprojectedSlots,
    isFinal: !anyTimeLeft,
  };
}

/* -------------------------------------------------------------------------- */
/* Win probability                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Standard deviation of a full DFS lineup's score, in points.
 *
 * A ROUGH industry figure, not measured from this league — a Classic NFL lineup typically
 * lands within about 40 points either side of its projection. The margin between two
 * independent lineups therefore has sd ≈ 40 × √2 ≈ 57 with a full slate ahead.
 *
 * It is deliberately a single tunable constant: once a season of real results exists, fit it
 * and the whole model improves without touching anything else.
 */
const LINEUP_SD_FULL_SLATE = 40;

/** Both lineups' worth of game time — the denominator for "how much is still uncertain". */
const FULL_MATCHUP_MINUTES = 2 * 9 * REGULATION_MINUTES;

/** Normal CDF via an Abramowitz-and-Stegun erf approximation. Accurate to ~1e-7. */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface WinProbability {
  /** P(home wins), 0–1. */
  home: number;
  /** True when no game time remains, so the result is settled rather than estimated. */
  settled: boolean;
}

/**
 * Rough win probability from projected margin and how much football is left.
 *
 * Uncertainty shrinks with the remaining minutes: with a full slate ahead almost anything can
 * happen, and with the clock at zero the margin IS the result. This is a model, not a
 * measurement — it should be labelled as an estimate wherever it appears.
 */
export function winProbability(
  homeProjected: number,
  awayProjected: number,
  minutesLeftTotal: number,
): WinProbability {
  const margin = homeProjected - awayProjected;
  if (minutesLeftTotal <= 0) {
    return { home: margin > 0 ? 1 : margin < 0 ? 0 : 0.5, settled: true };
  }

  const sd =
    LINEUP_SD_FULL_SLATE * Math.SQRT2 * Math.sqrt(minutesLeftTotal / FULL_MATCHUP_MINUTES);
  // Guard the degenerate case where rounding leaves sd at zero.
  if (sd <= 0) return { home: margin > 0 ? 1 : margin < 0 ? 0 : 0.5, settled: true };

  return { home: normalCdf(margin / sd), settled: false };
}

/** "73%" — rounded, and never shown as 0% or 100% while games are still running. */
export function formatWinProbability(p: number, settled: boolean): string {
  if (settled) return p >= 0.5 ? 'Won' : 'Lost';
  const pct = Math.round(p * 100);
  return `${Math.min(99, Math.max(1, pct))}%`;
}
