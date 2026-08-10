/**
 * Unit tests for the preseason (exhibition) week namespace.
 *
 * These pin the property the DraftKings ingest endpoint leans on: the regular/playoff week
 * range and the exhibition range are DISJOINT with a gap between them, so a mistyped week
 * can never silently land in the wrong namespace. The extension applies the same offset
 * client-side (extension/popup.js mirrors these constants), which is why the round-trip
 * matters more than either half on its own.
 */
import { describe, it, expect } from 'vitest';
import {
  PRESEASON_WEEK_BASE,
  MAX_PRESEASON_WEEK,
  toExhibitionWeek,
  fromExhibitionWeek,
  isExhibitionWeek,
  exhibitionWeekLabel,
} from './preseason';

/** Mirrors MAX_REGULAR_WEEK in src/app/api/ingest/draftkings/route.ts. */
const MAX_REGULAR_WEEK = 25;

describe('preseason week namespace', () => {
  it('round-trips every allowed preseason week', () => {
    for (let w = 1; w <= MAX_PRESEASON_WEEK; w += 1) {
      expect(fromExhibitionWeek(toExhibitionWeek(w))).toBe(w);
    }
  });

  it('maps preseason weeks to the documented 101/102/103 values', () => {
    expect(toExhibitionWeek(1)).toBe(101);
    expect(toExhibitionWeek(2)).toBe(102);
    expect(toExhibitionWeek(3)).toBe(103);
  });

  it('keeps the exhibition range disjoint from regular and playoff weeks', () => {
    // The gap is the safety property: no regular/playoff week is ever an exhibition week,
    // and the API's two accepted ranges cannot touch.
    expect(MAX_REGULAR_WEEK).toBeLessThan(PRESEASON_WEEK_BASE + 1);

    for (let w = 1; w <= MAX_REGULAR_WEEK; w += 1) {
      expect(isExhibitionWeek(w)).toBe(false);
    }
    for (let w = 1; w <= MAX_PRESEASON_WEEK; w += 1) {
      expect(isExhibitionWeek(toExhibitionWeek(w))).toBe(true);
    }
  });

  it('does not treat the base itself as an exhibition week', () => {
    // 100 is the base, not a usable week — off-by-one here would make week 100 ingestable.
    expect(isExhibitionWeek(PRESEASON_WEEK_BASE)).toBe(false);
    expect(isExhibitionWeek(PRESEASON_WEEK_BASE + 1)).toBe(true);
  });

  it('labels a stored week with its preseason number', () => {
    expect(exhibitionWeekLabel(102)).toBe('Preseason Week 2');
  });
});
