/**
 * Model registry — identity + versioning for the three lineup models.
 *
 * Honest framing: today these are **transparent, hand-weighted heuristic models** (see
 * recommend.ts) — interpretable, no training data required. They are versioned so their
 * real performance can be tracked over time (see performance.ts), and the plan is to
 * GRADUATE them to genuinely *trained* models (stage: 'trained', v1.0.0) once a season of
 * recommendation→outcome data has accumulated. The UI shows the stage badge so the label
 * is always accurate.
 */
import type { RiskLevel } from './recommend';

export type ModelStage = 'heuristic' | 'trained';

export interface ModelInfo {
  risk: RiskLevel;
  /** Short product name for the model. */
  codename: string;
  /** Semantic version. Heuristic builds are 0.x; the first trained build will be 1.0.0. */
  version: string;
  stage: ModelStage;
  /** One-line description of how it scores (kept in sync with recommend.ts weights). */
  algorithm: string;
}

export const MODEL_REGISTRY: Record<RiskLevel, ModelInfo> = {
  safe: {
    risk: 'safe',
    codename: 'Floor',
    version: '0.1.0',
    stage: 'heuristic',
    algorithm:
      'Weights consensus rank + availability + a clear starting role heavily and penalizes waiver volatility — a high-floor build.',
  },
  balanced: {
    risk: 'balanced',
    codename: 'Blend',
    version: '0.1.0',
    stage: 'heuristic',
    algorithm: 'An even blend of consensus, availability, role and waiver momentum.',
  },
  boom: {
    risk: 'boom',
    codename: 'Ceiling',
    version: '0.1.0',
    stage: 'heuristic',
    algorithm:
      'Up-weights waiver momentum and ascending backups for ceiling, tolerating questionable tags — a boom-or-bust build.',
  },
};

/** e.g. "Floor v0.1.0". */
export function modelLabel(risk: RiskLevel): string {
  const m = MODEL_REGISTRY[risk];
  return `${m.codename} v${m.version}`;
}

/** The version string stored alongside a snapshot, e.g. "Floor@0.1.0". */
export function modelVersionTag(risk: RiskLevel): string {
  const m = MODEL_REGISTRY[risk];
  return `${m.codename}@${m.version}`;
}
