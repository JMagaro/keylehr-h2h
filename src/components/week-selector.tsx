'use client';

/**
 * WeekSelector — a small `<select>` that navigates to the same path with `?season=&week=`,
 * preserving the season. Mirrors SeasonSelector. Used by admin pages that pick a week.
 */
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

interface WeekSelectorProps {
  weeks: number;
  selectedWeek: number;
  seasonId: number;
}

export function WeekSelector({ weeks, selectedWeek, seasonId }: WeekSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium text-muted">Week</span>
      <select
        aria-label="Select week"
        value={selectedWeek}
        disabled={isPending}
        onChange={(e) => {
          const week = e.target.value;
          startTransition(() => {
            router.push(`${pathname}?season=${seasonId}&week=${week}`);
          });
        }}
        className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
      >
        {Array.from({ length: weeks }, (_, i) => i + 1).map((w) => (
          <option key={w} value={w}>
            Week {w}
          </option>
        ))}
      </select>
    </label>
  );
}
