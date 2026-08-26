/**
 * Does our scoring engine agree with DraftKings, player by player?
 *
 * PURE — no DB, no network, no clock — like every other module in this directory.
 *
 * WHY THIS EXISTS. /live computes DK Classic points from ESPN box scores. If one of those
 * rules were wrong, nothing would ever say so: the page would render slightly wrong numbers
 * forever and look completely healthy doing it. One reconciliation was done by hand (max
 * |delta| 0.00 across 6 owners) and never repeated.
 *
 * IT COSTS NOTHING TO CHECK, because the data is already collected. Every roster capture
 * stores DraftKings' own per-player score AND DraftKings' own stat line
 * (`LineupSlotInput.dkScore` / `dkStats`) — that is DK's unmediated account of the same game
 * we scored from ESPN. Comparing the two is arithmetic over rows already in the database.
 *
 * WHAT A DISAGREEMENT MEANS — the distinction that makes this actionable:
 *
 *   ruleDrift   The two sources agree on what HAPPENED, and disagree on what it is WORTH.
 *               That is our bug, in our rules, and the component breakdown names it.
 *   statDrift   They disagree on what happened — ESPN says 7 receptions, DK says 8. Nothing
 *               to fix in our code; recorded so it is never mistaken for the above.
 *   unmapped    DK paid for a stat key this module does not recognise, so the totals cannot
 *               be explained. Points at THIS FILE's key map, not at the scoring rules — the
 *               difference between "our rules are wrong" and "we have not taught the audit
 *               about blocked kicks yet".
 *   unmatched   We produced no score at all: the ESPN join failed for that player.
 *
 * THE ONE TRAP: `dkScore` IS A SNAPSHOT, ours IS LIVE. DK's number is whatever it was when
 * the roster was captured; ours is recomputed from current stats on every render. Comparing a
 * mid-game capture against a finished game measures the gap between two moments in time, not
 * an error — and would report drift on almost every player. So a slot is only judged when its
 * game is FINAL, and `capturedAt` must be after that game ended. Everything else is reported
 * as `notComparable`, and the caller is told how many were skipped.
 */
import type { DkStat } from '@/lib/lineups/normalize';

import type { LiveSlot } from './assemble';

/** Points closer than this are the same number; DK publishes 2dp. */
export const RECONCILE_TOLERANCE = 0.01;

export type ReconcileVerdict =
  | 'agree'
  | 'ruleDrift'
  | 'statDrift'
  | 'unmapped'
  | 'unmatched'
  | 'notComparable';

export interface StatDifference {
  /** DraftKings' own key, e.g. "RecYds". */
  dkKey: string;
  /** Our engine's key, e.g. "recYards". Null when the key is unrecognised. */
  ourKey: string | null;
  dkValue: number;
  ourValue: number | null;
  dkPoints: number;
  ourPoints: number | null;
}

export interface SlotReconciliation {
  verdict: ReconcileVerdict;
  playerName: string | null;
  teamKey: string | null;
  slot: string | null;
  /** Our ESPN-derived points. Null when we could not score the player. */
  ourPoints: number | null;
  /** DraftKings' points at capture time. Null when DK had no number (concealed). */
  dkPoints: number | null;
  /** ourPoints − dkPoints, when both exist. */
  delta: number | null;
  /** Every stat that does not line up, and why. Empty when the two agree. */
  differences: StatDifference[];
  /** Human explanation, safe to render directly. */
  explanation: string;
}

/**
 * DraftKings' stat keys → our engine's component keys.
 *
 * Built from REAL captured payloads, not from documentation. Keys observed so far:
 * `PaYds PaTD INT RuYds RuTD REC RecYds RecTD SACK DFR Targets` plus the points-allowed tier
 * rows (`0 PA`, `1-6 PA`, `7-13 PA`, `14-20 PA`, …).
 *
 * Anything absent here is reported as `unmapped` rather than guessed at. That is deliberate:
 * a wrong guess would surface as a phantom rule bug and send someone hunting a defect that
 * does not exist.
 */
const DK_TO_OUR_KEY: Record<string, string> = {
  PaYds: 'passYards',
  PaTD: 'passTd',
  RuYds: 'rushYards',
  RuTD: 'rushTd',
  REC: 'receptions',
  RecYds: 'recYards',
  RecTD: 'recTd',
  FUM: 'fumblesLost',
  RetTD: 'returnTd',
  '2PT': 'twoPointConversions',
  SACK: 'sacks',
  DFR: 'fumbleRecoveries',
  SAF: 'safeties',
  BLK: 'blockedKicks',
  DefTD: 'defensiveTds',
  STTD: 'specialTeamsTds',
};

/**
 * DK keys that carry no points and exist only as colour on the roster card.
 *
 * Targets is the one seen in the wild: DK lists it at 0 points because DK Classic does not
 * pay for targets. Skipping them keeps the diff about scoring.
 */
const DK_IGNORED_KEYS = new Set(['Targets']);

/** True for DK's points-allowed tier rows, which are named for their range: "7-13 PA". */
function isPointsAllowedKey(key: string): boolean {
  return /\bPA$/.test(key.trim());
}

/**
 * `INT` is two different stats depending on who recorded it: thrown by a quarterback,
 * caught by a defense. DraftKings uses one key for both.
 */
function resolveOurKey(dkKey: string, isDst: boolean): string | null {
  if (dkKey === 'INT') return isDst ? 'interceptions' : 'passInterceptions';
  return DK_TO_OUR_KEY[dkKey] ?? null;
}

function isDstSlot(slot: LiveSlot): boolean {
  return (slot.slot ?? '').toUpperCase() === 'DST' || (slot.position ?? '').toUpperCase() === 'DST';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Compare one captured slot against DraftKings' own account of it.
 *
 * @param slot        The assembled slot — carries both our score and DK's.
 * @param comparable  Whether the player's game is final AND the capture postdates it. False
 *                    means the two numbers describe different moments and must not be judged.
 */
export function reconcileSlot(slot: LiveSlot, comparable: boolean): SlotReconciliation {
  const base = {
    playerName: slot.name,
    teamKey: slot.teamKey,
    slot: slot.slot,
    ourPoints: slot.points,
    dkPoints: slot.dkScore,
    differences: [] as StatDifference[],
  };

  if (slot.dkScore === null) {
    return {
      ...base,
      verdict: 'notComparable',
      delta: null,
      explanation: 'DraftKings had no number for this player when the roster was captured.',
    };
  }

  if (!comparable) {
    return {
      ...base,
      verdict: 'notComparable',
      delta: null,
      explanation:
        "The game was not final when the roster was captured, so DraftKings' number and ours " +
        'describe different moments.',
    };
  }

  if (slot.points === null) {
    return {
      ...base,
      verdict: 'unmatched',
      delta: null,
      explanation: `We could not score this player from ESPN, but DraftKings paid ${slot.dkScore}. The name/team match failed.`,
    };
  }

  const delta = round2(slot.points - slot.dkScore);
  if (Math.abs(delta) <= RECONCILE_TOLERANCE) {
    return { ...base, verdict: 'agree', delta, explanation: 'Matches DraftKings exactly.' };
  }

  // The totals disagree. Work out whether the inputs or the pricing is responsible.
  const dst = isDstSlot(slot);
  const ourByKey = new Map(slot.components.map((c) => [c.key, c]));
  const differences: StatDifference[] = [];
  let sawUnmapped = false;
  let sawStatMismatch = false;

  for (const dkStat of slot.dkStats ?? []) {
    if (DK_IGNORED_KEYS.has(dkStat.key)) continue;

    // Points-allowed is a tier award: DK's row is a flag (value 1) named for the range, while
    // ours records the actual points conceded. Only the POINTS are comparable.
    if (isPointsAllowedKey(dkStat.key)) {
      const ours = ourByKey.get('pointsAllowed');
      if (!ours || Math.abs(ours.points - dkStat.points) > RECONCILE_TOLERANCE) {
        differences.push({
          dkKey: dkStat.key,
          ourKey: 'pointsAllowed',
          dkValue: dkStat.value,
          ourValue: ours ? ours.quantity : null,
          dkPoints: dkStat.points,
          ourPoints: ours ? ours.points : null,
        });
      }
      continue;
    }

    const ourKey = resolveOurKey(dkStat.key, dst);
    if (ourKey === null) {
      // Only a scoring stat we cannot place is a problem. A 0-point unknown is just noise.
      if (Math.abs(dkStat.points) > RECONCILE_TOLERANCE) sawUnmapped = true;
      differences.push({
        dkKey: dkStat.key,
        ourKey: null,
        dkValue: dkStat.value,
        ourValue: null,
        dkPoints: dkStat.points,
        ourPoints: null,
      });
      continue;
    }

    const ours = ourByKey.get(ourKey);
    const ourValue = ours ? ours.quantity : 0;
    const ourPoints = ours ? ours.points : 0;
    const valueDiffers = Math.abs(ourValue - dkStat.value) > RECONCILE_TOLERANCE;
    const pointsDiffer = Math.abs(ourPoints - dkStat.points) > RECONCILE_TOLERANCE;
    if (valueDiffers) sawStatMismatch = true;
    if (valueDiffers || pointsDiffer) {
      differences.push({
        dkKey: dkStat.key,
        ourKey,
        dkValue: dkStat.value,
        ourValue,
        dkPoints: dkStat.points,
        ourPoints,
      });
    }
  }

  // A stat WE scored that DK never listed is a difference too — and it is invisible from the
  // loop above, which only walks DK's rows. Bonuses are the likely case.
  const dkKeys = new Set(
    (slot.dkStats ?? [])
      .filter((s) => !DK_IGNORED_KEYS.has(s.key))
      .map((s) => (isPointsAllowedKey(s.key) ? 'pointsAllowed' : resolveOurKey(s.key, dst)))
      .filter((k): k is string => k !== null),
  );
  for (const ours of slot.components) {
    if (dkKeys.has(ours.key)) continue;
    if (Math.abs(ours.points) <= RECONCILE_TOLERANCE) continue;
    sawStatMismatch = true;
    differences.push({
      dkKey: '(not listed by DraftKings)',
      ourKey: ours.key,
      dkValue: 0,
      ourValue: ours.quantity,
      dkPoints: 0,
      ourPoints: ours.points,
    });
  }

  const sign = delta > 0 ? 'more' : 'fewer';
  const magnitude = `${Math.abs(delta).toFixed(2)} ${sign}`;

  if (sawUnmapped) {
    return {
      ...base,
      verdict: 'unmapped',
      delta,
      differences,
      explanation:
        `We score ${magnitude} than DraftKings, and DraftKings paid for a stat this audit ` +
        'does not recognise — so the gap cannot be attributed. Add the key to DK_TO_OUR_KEY in ' +
        'src/lib/live/reconcile.ts before concluding anything about the scoring rules.',
    };
  }

  if (sawStatMismatch) {
    return {
      ...base,
      verdict: 'statDrift',
      delta,
      differences,
      explanation:
        `We score ${magnitude} than DraftKings because the two sources disagree on what ` +
        'happened, not on what it is worth. Nothing to fix in our scoring rules.',
    };
  }

  return {
    ...base,
    verdict: 'ruleDrift',
    delta,
    differences,
    explanation:
      `We score ${magnitude} than DraftKings from an IDENTICAL stat line — our scoring rules ` +
      'price this differently. This is a real bug in src/lib/dfs/rules.ts.',
  };
}

export interface ReconcileSummary {
  total: number;
  agree: number;
  ruleDrift: number;
  statDrift: number;
  unmapped: number;
  unmatched: number;
  notComparable: number;
  /** Largest absolute delta among slots that were actually judged. */
  maxAbsDelta: number;
  /** Everything except `agree` and `notComparable`, worst first. */
  findings: SlotReconciliation[];
  /** True when something needs a human: a rule bug, an unmapped key, or a failed match. */
  needsAttention: boolean;
}

/** One captured slot plus whether its game had finished by the time it was captured. */
export interface ReconcileInput {
  slot: LiveSlot;
  comparable: boolean;
}

/** Roll individual verdicts into the summary the admin page renders. */
export function reconcileWeek(inputs: ReconcileInput[]): ReconcileSummary {
  const results = inputs.map((i) => reconcileSlot(i.slot, i.comparable));

  const summary: ReconcileSummary = {
    total: results.length,
    agree: 0,
    ruleDrift: 0,
    statDrift: 0,
    unmapped: 0,
    unmatched: 0,
    notComparable: 0,
    maxAbsDelta: 0,
    findings: [],
    needsAttention: false,
  };

  for (const r of results) {
    summary[r.verdict] += 1;
    if (r.delta !== null) summary.maxAbsDelta = Math.max(summary.maxAbsDelta, Math.abs(r.delta));
    if (r.verdict !== 'agree' && r.verdict !== 'notComparable') summary.findings.push(r);
  }

  // Worst first: a rule bug outranks a source disagreement, and within a verdict the biggest
  // delta leads. An unmatched player has no delta and sorts by name.
  const rank: Record<ReconcileVerdict, number> = {
    ruleDrift: 0,
    unmapped: 1,
    unmatched: 2,
    statDrift: 3,
    agree: 4,
    notComparable: 5,
  };
  summary.findings.sort(
    (a, b) => rank[a.verdict] - rank[b.verdict] || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0),
  );

  summary.maxAbsDelta = round2(summary.maxAbsDelta);
  summary.needsAttention =
    summary.ruleDrift > 0 || summary.unmapped > 0 || summary.unmatched > 0;
  return summary;
}
