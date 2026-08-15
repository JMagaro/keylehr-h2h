/**
 * The stored-week contract, shared by every ingest route.
 *
 * Extracted from `src/app/api/ingest/draftkings/route.ts` when roster capture was added, so
 * scores and rosters can never disagree about what a legal week is. Behaviour is unchanged.
 */
import { z } from 'zod';

import { MAX_PRESEASON_WEEK, PRESEASON_WEEK_BASE } from '@/lib/schedule/preseason';

/** Highest regular/playoff week we accept (18 regular + playoffs 19–22, with headroom). */
export const MAX_REGULAR_WEEK = 25;
export const MIN_EXHIBITION_WEEK = PRESEASON_WEEK_BASE + 1;
export const MAX_EXHIBITION_WEEK = PRESEASON_WEEK_BASE + MAX_PRESEASON_WEEK;

/**
 * A stored week value. Two disjoint namespaces are legal — regular/playoff (1–25) and
 * preseason exhibition (101–103) — and the gap between them is deliberate: it means a
 * typo'd week can never silently land in the wrong namespace.
 */
export const weekSchema = z
  .number()
  .int()
  .refine(
    (w) =>
      (w >= 1 && w <= MAX_REGULAR_WEEK) ||
      (w >= MIN_EXHIBITION_WEEK && w <= MAX_EXHIBITION_WEEK),
    {
      message:
        `Week must be 1–${MAX_REGULAR_WEEK} (regular/playoff) or ` +
        `${MIN_EXHIBITION_WEEK}–${MAX_EXHIBITION_WEEK} (preseason exhibition).`,
    },
  );
