/**
 * Detect a capture that has gone stale — the single most consequential way the live estimate
 * can be quietly wrong.
 *
 * THE PROBLEM. DraftKings conceals a player until that player's game kicks off, so a capture
 * taken at 1pm legitimately hides the whole late slate. Those slots carry no identity at all,
 * contribute nothing, and the UI describes them as "to play". That reading is correct at 1pm
 * and WRONG at 5pm: by then those games have started, DraftKings would now reveal the players,
 * and the only reason they are still missing is that nobody re-captured. Every one of them is
 * scoring points that the estimate does not include.
 *
 * Measured on a real capture: 14 of 16 games had started while 30 slots were still concealed.
 *
 * THE TEST. A slot is concealed at capture time T exactly when its player's game starts after
 * T. So a re-capture can reveal more if any game kicked off after T and has since started.
 * That is precise rather than a heuristic — it uses the same property (concealment tracks
 * kickoff) that makes revealed data trustworthy in the first place.
 */

export interface StalenessInput {
  /** Games in the week, with the state ESPN currently reports. */
  games: { state: string; teamKeys: string[] }[];
  /** Kickoff per `nfl_teams.key`. */
  kickoffByTeam: Record<string, Date | null | undefined>;
  /** Newest capture across all owners. */
  capturedAt: Date | null;
  /** How many slots are still concealed. */
  concealedSlots: number;
}

export interface StalenessResult {
  /** True when re-capturing would reveal players the estimate is currently missing. */
  shouldRecapture: boolean;
  /** Games that kicked off AFTER the capture and have since started. */
  gamesStartedSinceCapture: number;
  concealedSlots: number;
}

export function assessCaptureStaleness(input: StalenessInput): StalenessResult {
  const { games, kickoffByTeam, capturedAt, concealedSlots } = input;

  if (!capturedAt || concealedSlots === 0) {
    return { shouldRecapture: false, gamesStartedSinceCapture: 0, concealedSlots };
  }

  let started = 0;
  for (const game of games) {
    if (game.state === 'pre') continue;
    // Any of the game's teams gives its kickoff; they share one.
    const kickoff = game.teamKeys.map((t) => kickoffByTeam[t]).find((k): k is Date => Boolean(k));
    if (kickoff && kickoff > capturedAt) started += 1;
  }

  return {
    shouldRecapture: started > 0,
    gamesStartedSinceCapture: started,
    concealedSlots,
  };
}

/** Total concealed slots across every captured roster in a view. */
export function countConcealedSlots(matchups: { home: { concealed: number }; away: { concealed: number } }[]): number {
  return matchups.reduce((n, m) => n + m.home.concealed + m.away.concealed, 0);
}
