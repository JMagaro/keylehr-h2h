/**
 * Cap-constrained lineup optimizer — PURE, unit-tested.
 *
 * Given salaried candidates and the DraftKings roster (QB/RB×2/WR×3/TE/FLEX/DST) under a
 * salary cap, build a valid lineup that maximizes total "fit" (the recommender's 0–100
 * score) without exceeding the cap and without repeating a player.
 *
 * Exact DFS optimization is an integer program; for a 9-slot roster a fast heuristic is
 * plenty and stays transparent:
 *   1. Seed with the max-fit lineup (ignoring salary).
 *   2. If it's over the cap, REPAIR: repeatedly apply the single swap to a cheaper allowed
 *      candidate that saves the most salary per unit of fit lost, until under the cap.
 *   3. UPGRADE: while leftover cap remains, apply the single swap that adds the most fit
 *      without breaking the cap. Repeat to a fixed iteration bound.
 *
 * The result is a strong, cap-valid lineup. It is not guaranteed globally optimal, which is
 * fine for a shortlist tool — and far better than a naive over-cap "all studs" lineup.
 */
import type { FantasyPosition } from './sleeper';

export interface OptCandidate {
  id: string;
  position: FantasyPosition;
  fit: number;
  salary: number;
}

export interface OptSlot {
  slot: string;
  positions: FantasyPosition[];
}

export interface OptResult {
  lineup: { slot: string; id: string | null }[];
  totalSalary: number;
  totalFit: number;
  /** True when every slot is filled and the cap is respected. */
  feasible: boolean;
}

const EPS = 1e-6;

export function optimizeLineup(
  candidates: OptCandidate[],
  slots: OptSlot[],
  cap: number,
  poolPerPosition = 40,
): OptResult {
  // Build per-position pools sorted by fit desc, capped for performance.
  const byPos = new Map<FantasyPosition, OptCandidate[]>();
  for (const c of candidates) {
    const arr = byPos.get(c.position) ?? [];
    arr.push(c);
    byPos.set(c.position, arr);
  }
  for (const [pos, arr] of byPos) {
    arr.sort((a, b) => b.fit - a.fit || a.salary - b.salary);
    byPos.set(pos, arr.slice(0, poolPerPosition));
  }

  /** Candidates allowed in a slot, fit desc. */
  function poolFor(slot: OptSlot): OptCandidate[] {
    const out: OptCandidate[] = [];
    for (const pos of slot.positions) out.push(...(byPos.get(pos) ?? []));
    out.sort((a, b) => b.fit - a.fit || a.salary - b.salary);
    return out;
  }
  const pools = slots.map(poolFor);

  // 1. Seed: best fit per slot, no duplicate players.
  const picks: (OptCandidate | null)[] = new Array(slots.length).fill(null);
  const used = new Set<string>();
  slots.forEach((_, i) => {
    const pick = pools[i].find((c) => !used.has(c.id)) ?? null;
    picks[i] = pick;
    if (pick) used.add(pick.id);
  });

  const salaryOf = () => picks.reduce((s, p) => s + (p?.salary ?? 0), 0);
  const fitOf = () => picks.reduce((s, p) => s + (p?.fit ?? 0), 0);

  // 2. Repair down to the cap: pick the swap that saves the most $ per fit lost.
  let guard = 0;
  while (salaryOf() > cap && guard++ < 500) {
    let best: { i: number; cand: OptCandidate; ratio: number } | null = null;
    for (let i = 0; i < slots.length; i++) {
      const cur = picks[i];
      if (!cur) continue;
      for (const alt of pools[i]) {
        if (alt.id === cur.id || (used.has(alt.id) && alt.id !== cur.id)) continue;
        if (alt.salary >= cur.salary) continue; // must save money
        const saved = cur.salary - alt.salary;
        const lost = Math.max(cur.fit - alt.fit, EPS);
        const ratio = saved / lost;
        if (!best || ratio > best.ratio) best = { i, cand: alt, ratio };
      }
    }
    if (!best) break; // cannot get under cap — infeasible
    const cur = picks[best.i]!;
    used.delete(cur.id);
    used.add(best.cand.id);
    picks[best.i] = best.cand;
  }

  // 3. Upgrade: spend leftover cap on the single biggest fit gain that still fits.
  guard = 0;
  while (guard++ < 500) {
    const room = cap - salaryOf();
    let best: { i: number; cand: OptCandidate; gain: number } | null = null;
    for (let i = 0; i < slots.length; i++) {
      const cur = picks[i];
      const curFit = cur?.fit ?? 0;
      const curSalary = cur?.salary ?? 0;
      for (const alt of pools[i]) {
        if (used.has(alt.id) && alt.id !== cur?.id) continue;
        if (alt.id === cur?.id) continue;
        const gain = alt.fit - curFit;
        if (gain <= EPS) continue;
        if (alt.salary - curSalary > room) continue; // would break the cap
        if (!best || gain > best.gain) best = { i, cand: alt, gain };
      }
    }
    if (!best) break;
    const cur = picks[best.i];
    if (cur) used.delete(cur.id);
    used.add(best.cand.id);
    picks[best.i] = best.cand;
  }

  const lineup = slots.map((s, i) => ({ slot: s.slot, id: picks[i]?.id ?? null }));
  const totalSalary = salaryOf();
  const feasible = picks.every((p) => p !== null) && totalSalary <= cap;
  return { lineup, totalSalary, totalFit: fitOf(), feasible };
}
