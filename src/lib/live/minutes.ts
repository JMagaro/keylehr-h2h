/**
 * Game time remaining across a lineup — the "how much football is left" number.
 *
 * This is the metric that makes a live head-to-head readable: 40 points with 300 minutes left
 * is a very different position from 40 points with 12. DraftKings shows its own version, PMR
 * ("Points Minutes Remaining"), and its `maxTimeRemaining: 540` confirms the model — nine
 * roster slots × 60 minutes of regulation.
 *
 * WHY OURS IS NOT CALLED PMR. DraftKings' exact rule could not be confirmed. Two captured
 * samples disagree: Austin Trammell showed 30 with his game at halftime, which matches
 * (4 − 2) × 15 + 0 exactly — but Mario Williams showed 60 with his game at "15:00 3rd",
 * where the same rule gives 30. Rather than claim to reproduce a number we cannot verify, this
 * computes a plainly-defined "minutes left" of our own and labels it as such. If DK's rule is
 * ever pinned down, this is the one place to change.
 *
 * Pure — no clock of its own, no network. The game state comes from ESPN.
 */
import type { LiveSlot } from './assemble';

/** Regulation minutes in an NFL game, and per quarter. */
const REGULATION_MINUTES = 60;
const QUARTER_MINUTES = 15;
const QUARTERS = 4;

export interface GameClock {
  state: 'pre' | 'in' | 'post';
  /** Quarter number: 1–4, 5+ for overtime. */
  period?: number | null;
  /** "8:30" — minutes:seconds left in the current quarter. */
  displayClock?: string | null;
}

/** Parse "8:30" to minutes as a decimal. Returns null for anything unparseable. */
export function parseClockMinutes(displayClock: string | null | undefined): number | null {
  if (!displayClock) return null;
  const m = /^(\d+):(\d{1,2})$/.exec(displayClock.trim());
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return minutes + seconds / 60;
}

/**
 * Minutes of regulation left in one game.
 *
 * Overtime counts as 0: it is extra football beyond the 60 this metric is denominated in, and
 * treating it as negative would make a lineup's total misleading.
 */
export function minutesLeftInGame(clock: GameClock): number {
  if (clock.state === 'pre') return REGULATION_MINUTES;
  if (clock.state === 'post') return 0;

  const period = clock.period ?? 0;
  if (period <= 0) return REGULATION_MINUTES; // in progress but no period yet — treat as full
  if (period > QUARTERS) return 0; // overtime

  const inQuarter = parseClockMinutes(clock.displayClock);
  // Clock missing mid-game (between quarters, halftime): the quarter is effectively over.
  const remainingThisQuarter = inQuarter ?? 0;
  return (QUARTERS - period) * QUARTER_MINUTES + remainingThisQuarter;
}

export interface LineupMinutes {
  /** Minutes left across the slots we can place. */
  minutesLeft: number;
  /** Maximum possible, i.e. 60 × slots — the denominator for "X of Y". */
  maxMinutes: number;
  /** Slots whose remaining time could not be determined; `minutesLeft` excludes them. */
  unknownSlots: number;
  /** Slots with time still on the clock — "N still playing or yet to play". */
  slotsWithTimeLeft: number;
}

/**
 * Sum the minutes left across a lineup.
 *
 * Concealed slots count as a FULL 60. DraftKings conceals a player exactly until their game
 * kicks off, so at capture time a concealed player had not started — meaning a full game
 * ahead of them. That inference is only as fresh as the capture, which is why a stale capture
 * is flagged separately (see ./staleness).
 */
export function lineupMinutes(
  slots: LiveSlot[],
  clockByTeam: Record<string, GameClock | undefined>,
): LineupMinutes {
  let minutesLeft = 0;
  let unknownSlots = 0;
  let slotsWithTimeLeft = 0;

  for (const slot of slots) {
    let left: number | null;

    if (!slot.teamKey) {
      // Concealed (no identity yet), or revealed but never resolved to a team. Only the first
      // supports an inference, and it is a solid one: DK conceals until kickoff.
      left = slot.status === 'concealed' ? REGULATION_MINUTES : null;
    } else {
      const clock = clockByTeam[slot.teamKey];
      left = clock ? minutesLeftInGame(clock) : null;
    }

    if (left === null) {
      unknownSlots += 1;
      continue;
    }
    minutesLeft += left;
    if (left > 0) slotsWithTimeLeft += 1;
  }

  return {
    minutesLeft: Math.round(minutesLeft),
    maxMinutes: slots.length * REGULATION_MINUTES,
    unknownSlots,
    slotsWithTimeLeft,
  };
}

/** "312 min" / "48 min" — compact enough for a matchup card. */
export function formatMinutes(minutes: number): string {
  return `${Math.round(minutes)} min`;
}
