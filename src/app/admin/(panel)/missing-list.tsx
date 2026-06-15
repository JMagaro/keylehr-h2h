'use client';

/**
 * MissingList — a small expandable `<details>` for the dashboard data-status
 * checklist. It shows the first few missing items inline (so the most common
 * gaps are visible at a glance) and tucks the rest behind a "show all" toggle,
 * keeping each checklist row scannable even when many items are missing.
 *
 * Server-rendered content (the item nodes) is passed in as `children` so the
 * parent Server Component can include logos/links; this client wrapper only owns
 * the expand/collapse interaction.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';

interface MissingListProps {
  /** Short summary shown before the items, e.g. "5 teams unassigned:". */
  summary: string;
  /** All missing items, already rendered as nodes. */
  items: ReactNode[];
  /** How many to show before collapsing the rest. */
  previewCount?: number;
}

export function MissingList({ summary, items, previewCount = 6 }: MissingListProps) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;

  const hasMore = items.length > previewCount;
  const shown = expanded ? items : items.slice(0, previewCount);

  return (
    <div className="text-xs text-muted">
      <p className="mb-1.5 font-medium text-foreground/80">{summary}</p>
      <ul className="flex flex-wrap gap-1.5">
        {shown.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 text-xs font-semibold text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}
