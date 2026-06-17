/**
 * Lineup recommendation engine — PURE (no DB / network), so it is unit-testable.
 *
 * It turns free public signals into a transparent, risk-weighted shortlist. It is NOT a
 * point projector — free sources don't give reliable weekly projections or DK salaries.
 * Instead it ranks on signals fantasy managers actually trust for free:
 *   • consensus relevance  (Sleeper search rank, expressed as a positional rank)
 *   • availability         (injury status)
 *   • role                 (depth-chart order: starter vs backup)
 *   • momentum             (waiver add/drop trend)
 *   • a light schedule edge (home/away; bye filtering)
 *
 * The three risk profiles re-weight those signals:
 *   safe   — floor first: consensus + health + clear starter role; punish volatility.
 *   balanced — an even blend.
 *   boom   — ceiling first: reward waiver buzz + ascending backups; tolerate questionable tags.
 *
 * Every recommendation carries the reasons it surfaced, so the UI can show *why* — never a
 * fake number presented as a projection.
 */
import type { FantasyPosition, SleeperPlayer } from './sleeper';

export type RiskLevel = 'safe' | 'balanced' | 'boom';

export const RISK_LEVELS: RiskLevel[] = ['safe', 'balanced', 'boom'];

export const RISK_META: Record<
  RiskLevel,
  { label: string; tagline: string; description: string }
> = {
  safe: {
    label: 'Safe',
    tagline: 'High floor',
    description:
      'Established, healthy starters with steady roles. Minimizes bust risk — favors consensus and availability over upside.',
  },
  balanced: {
    label: 'Balanced',
    tagline: 'Floor + ceiling',
    description:
      'An even blend of proven production and emerging value. A sensible default for most weeks.',
  },
  boom: {
    label: 'Boom or bust',
    tagline: 'High ceiling',
    description:
      'Leans into waiver buzz and ascending backups for tournament upside. Accepts more volatility and questionable tags.',
  },
};

/** Injury tags that rule a player OUT of a target lineup (still shown as fades). */
const INACTIVE_TAGS = new Set([
  'out',
  'ir',
  'pup',
  'sus',
  'susp',
  'na',
  'dnr',
  'cov',
  'covid',
  'doubtful',
  'inactive',
]);

/** Injury tags that are a yellow flag but still playable. */
const QUESTIONABLE_TAGS = new Set(['questionable', 'gtd', 'q']);

export function isInactiveTag(status: string | null): boolean {
  if (!status) return false;
  return INACTIVE_TAGS.has(status.trim().toLowerCase());
}

export function isQuestionableTag(status: string | null): boolean {
  if (!status) return false;
  return QUESTIONABLE_TAGS.has(status.trim().toLowerCase());
}

/** Per-team schedule context for the chosen week. */
export interface WeekMatchup {
  opponentKey: string;
  isHome: boolean;
}

export interface RecommendContext {
  /** team key (e.g. "BUF") → that team's opponent this week. Absent ⇒ team is on bye. */
  matchups: Map<string, WeekMatchup>;
  trendingAdd: Map<string, number>;
  trendingDrop: Map<string, number>;
}

export type ReasonTone = 'good' | 'warn' | 'bad' | 'neutral';

export interface Reason {
  label: string;
  tone: ReasonTone;
}

export interface Recommendation {
  player: SleeperPlayer;
  /** 1-based rank within the player's position across the relevant pool. */
  posRank: number;
  /** 0–100 fit score for the chosen risk profile. Relative, not a projection. */
  fit: number;
  reasons: Reason[];
  opponentKey: string | null;
  isHome: boolean;
  addCount: number;
  dropCount: number;
}

/** DraftKings Classic NFL roster: QB, RB×2, WR×3, TE, FLEX(RB/WR/TE), DST. */
export const LINEUP_SLOTS: { slot: string; positions: FantasyPosition[] }[] = [
  { slot: 'QB', positions: ['QB'] },
  { slot: 'RB', positions: ['RB'] },
  { slot: 'RB', positions: ['RB'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'WR', positions: ['WR'] },
  { slot: 'TE', positions: ['TE'] },
  { slot: 'FLEX', positions: ['RB', 'WR', 'TE'] },
  { slot: 'DST', positions: ['DST'] },
];

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Assign 1-based positional ranks by Sleeper search rank within each position. */
export function assignPositionalRanks(players: SleeperPlayer[]): Map<string, number> {
  const byPos = new Map<FantasyPosition, SleeperPlayer[]>();
  for (const p of players) {
    const arr = byPos.get(p.position) ?? [];
    arr.push(p);
    byPos.set(p.position, arr);
  }
  const ranks = new Map<string, number>();
  for (const arr of byPos.values()) {
    arr.sort((a, b) => a.searchRank - b.searchRank);
    arr.forEach((p, i) => ranks.set(p.id, i + 1));
  }
  return ranks;
}

/** Smoothly decaying consensus score from a positional rank (1 → 1.0, decays toward 0). */
function consensusScore(posRank: number): number {
  return 1 / (1 + (posRank - 1) / 12);
}

/** Normalize a waiver add/drop count into 0–1 (log scale; ~25k moves ≈ 1.0). */
function momentumScore(count: number): number {
  if (count <= 0) return 0;
  return clamp01(Math.log10(1 + count) / Math.log10(1 + 25000));
}

function healthScore(status: string | null, risk: RiskLevel): number {
  if (!status) return 1;
  if (isQuestionableTag(status)) {
    return risk === 'safe' ? 0.4 : risk === 'balanced' ? 0.68 : 0.85;
  }
  // Any other tag is an inactive-class flag — should already be gated out of targets.
  return 0.05;
}

function roleScore(depthOrder: number | null): number {
  if (depthOrder === null) return 0.7; // unknown — many relevant players lack a depth slot
  if (depthOrder <= 1) return 1;
  if (depthOrder === 2) return 0.65;
  if (depthOrder === 3) return 0.4;
  return 0.2;
}

interface Weights {
  consensus: number;
  health: number;
  role: number;
  momentumPos: number;
  momentumNeg: number;
  upside: number;
}

const WEIGHTS: Record<RiskLevel, Weights> = {
  safe: { consensus: 0.46, health: 0.3, role: 0.2, momentumPos: 0.04, momentumNeg: 0.22, upside: 0 },
  balanced: { consensus: 0.38, health: 0.22, role: 0.15, momentumPos: 0.16, momentumNeg: 0.12, upside: 0.04 },
  boom: { consensus: 0.24, health: 0.12, role: 0.08, momentumPos: 0.36, momentumNeg: 0.04, upside: 0.16 },
};

/**
 * Score a single player for a risk profile. Returns the 0–100 fit and the reasons that
 * drove it. Pure: same inputs → same output.
 */
export function scorePlayer(
  player: SleeperPlayer,
  posRank: number,
  ctx: RecommendContext,
  risk: RiskLevel,
): { fit: number; reasons: Reason[]; addCount: number; dropCount: number } {
  const w = WEIGHTS[risk];
  const matchup = ctx.matchups.get(player.teamKey);
  const addCount = ctx.trendingAdd.get(player.id) ?? 0;
  const dropCount = ctx.trendingDrop.get(player.id) ?? 0;

  const consensus = consensusScore(posRank);
  const health = healthScore(player.injuryStatus, risk);
  const role = roleScore(player.depthOrder);
  const momPos = momentumScore(addCount);
  const momNeg = momentumScore(dropCount);

  // Ascending-backup upside: a low-experience player with real waiver buzz who isn't the
  // established starter — only rewarded in higher-risk profiles.
  const ascending =
    (player.yearsExp ?? 99) <= 2 && momPos > 0.2 && (player.depthOrder ?? 9) >= 2 ? momPos : 0;

  const homeEdge = matchup?.isHome ? 0.04 : 0;

  let fit =
    w.consensus * consensus +
    w.health * health +
    w.role * role +
    w.momentumPos * momPos -
    w.momentumNeg * momNeg +
    w.upside * ascending +
    homeEdge;
  fit = clamp01(fit) * 100;

  const reasons: Reason[] = [];
  // Consensus / role
  reasons.push({
    label: `${player.position}${posRank}`,
    tone: posRank <= 12 ? 'good' : 'neutral',
  });
  if (player.depthOrder === 1) reasons.push({ label: 'Starter', tone: 'good' });
  else if (risk === 'boom' && ascending > 0) reasons.push({ label: 'Ascending', tone: 'good' });
  else if ((player.depthOrder ?? 0) >= 3) reasons.push({ label: 'Backup', tone: 'warn' });

  // Availability
  if (isQuestionableTag(player.injuryStatus)) {
    reasons.push({
      label: player.injuryNote ? `Questionable · ${player.injuryNote}` : 'Questionable',
      tone: 'warn',
    });
  }

  // Momentum
  if (addCount >= 3000) reasons.push({ label: `Trending ↑`, tone: 'good' });
  if (dropCount >= 3000) reasons.push({ label: `Trending ↓`, tone: 'bad' });

  // Schedule
  if (matchup) {
    reasons.push({
      label: `${matchup.isHome ? 'vs' : '@'} ${matchup.opponentKey}`,
      tone: 'neutral',
    });
  }

  return { fit: Math.round(fit * 10) / 10, reasons, addCount, dropCount };
}

export interface RecommendResult {
  /** Per-position target shortlists (top N each), best first. */
  targetsByPosition: Record<FantasyPosition, Recommendation[]>;
  /** A concrete DraftKings Classic lineup filled greedily by fit. */
  suggestedLineup: { slot: string; pick: Recommendation | null }[];
  /** Notable players to avoid this week (injured-out, dropped, or on bye). */
  fades: Recommendation[];
}

const EMPTY_POS: Record<FantasyPosition, Recommendation[]> = {
  QB: [],
  RB: [],
  WR: [],
  TE: [],
  K: [],
  DST: [],
};

/**
 * Produce the full recommendation set for one risk profile.
 *
 * @param relevant The full relevant player pool (used for positional ranks + fades).
 * @param ctx      Week matchups + trending maps.
 * @param risk     The chosen risk profile.
 * @param perPosition How many targets to keep per position (default 6).
 */
export function recommend(
  relevant: SleeperPlayer[],
  ctx: RecommendContext,
  risk: RiskLevel,
  perPosition = 6,
): RecommendResult {
  const posRanks = assignPositionalRanks(relevant);

  // Players whose team actually plays this week (not on bye) are lineup-eligible.
  const eligible = relevant.filter((p) => ctx.matchups.has(p.teamKey));

  const scored: Recommendation[] = eligible
    .filter((p) => !isInactiveTag(p.injuryStatus))
    .map((p) => {
      const posRank = posRanks.get(p.id) ?? 999;
      const s = scorePlayer(p, posRank, ctx, risk);
      const matchup = ctx.matchups.get(p.teamKey);
      return {
        player: p,
        posRank,
        fit: s.fit,
        reasons: s.reasons,
        opponentKey: matchup?.opponentKey ?? null,
        isHome: matchup?.isHome ?? false,
        addCount: s.addCount,
        dropCount: s.dropCount,
      };
    })
    .sort((a, b) => b.fit - a.fit || a.posRank - b.posRank);

  const targetsByPosition: Record<FantasyPosition, Recommendation[]> = {
    ...EMPTY_POS,
    QB: [],
    RB: [],
    WR: [],
    TE: [],
    K: [],
    DST: [],
  };
  for (const rec of scored) {
    const bucket = targetsByPosition[rec.player.position];
    if (bucket.length < perPosition) bucket.push(rec);
  }

  // Greedy lineup: fill each slot with the best unused eligible player it allows.
  const used = new Set<string>();
  const suggestedLineup = LINEUP_SLOTS.map(({ slot, positions }) => {
    const allowed = new Set(positions);
    const pick =
      scored.find((r) => !used.has(r.player.id) && allowed.has(r.player.position)) ?? null;
    if (pick) used.add(pick.player.id);
    return { slot, pick };
  });

  // Fades: notable names (good positional rank) with a red flag this week.
  const fades: Recommendation[] = relevant
    .map((p) => {
      const posRank = posRanks.get(p.id) ?? 999;
      const onBye = !ctx.matchups.has(p.teamKey);
      const inactive = isInactiveTag(p.injuryStatus);
      const dropped = (ctx.trendingDrop.get(p.id) ?? 0) >= 5000;
      if (!(onBye || inactive || dropped)) return null;
      if (posRank > 36) return null; // only players you'd actually consider
      const matchup = ctx.matchups.get(p.teamKey);
      const reasons: Reason[] = [{ label: `${p.position}${posRank}`, tone: 'neutral' }];
      if (inactive) {
        reasons.push({
          label: p.injuryNote ? `${p.injuryStatus} · ${p.injuryNote}` : (p.injuryStatus ?? 'Out'),
          tone: 'bad',
        });
      }
      if (onBye) reasons.push({ label: 'On bye', tone: 'warn' });
      if (dropped) reasons.push({ label: 'Trending ↓', tone: 'bad' });
      return {
        player: p,
        posRank,
        fit: 0,
        reasons,
        opponentKey: matchup?.opponentKey ?? null,
        isHome: matchup?.isHome ?? false,
        addCount: ctx.trendingAdd.get(p.id) ?? 0,
        dropCount: ctx.trendingDrop.get(p.id) ?? 0,
      } satisfies Recommendation;
    })
    .filter((r): r is Recommendation => r !== null)
    .sort((a, b) => a.posRank - b.posRank)
    .slice(0, 8);

  return { targetsByPosition, suggestedLineup, fades };
}
