'use client';

/**
 * LineupBuilderControls — the wizard's input row. Three steps presented inline:
 *   1. Season  (<select>)   2. Week  (<select>)   3. Risk level  (segmented buttons)
 *
 * Each change navigates to /my-team/builder with ALL THREE params preserved, so results
 * are server-rendered and the URL is shareable. Mirrors the SeasonSelector pattern
 * (useRouter + useTransition) but keeps the trio in sync rather than resetting siblings.
 */
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';

interface SeasonOpt {
  id: number;
  name: string;
}

export interface RiskOption {
  value: string;
  label: string;
  tagline: string;
}

interface Props {
  seasons: SeasonOpt[];
  selectedSeasonId: number;
  weeks: number;
  selectedWeek: number;
  risks: RiskOption[];
  selectedRisk: string;
}

export function LineupBuilderControls({
  seasons,
  selectedSeasonId,
  weeks,
  selectedWeek,
  risks,
  selectedRisk,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function go(next: { season?: number; week?: number; risk?: string }) {
    const season = next.season ?? selectedSeasonId;
    const week = next.week ?? selectedWeek;
    const risk = next.risk ?? selectedRisk;
    startTransition(() => {
      router.push(`/my-team/builder?season=${season}&week=${week}&risk=${risk}`);
    });
  }

  const weekList = Array.from({ length: weeks }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-subtle">1 · Season</span>
          <select
            aria-label="Select season"
            value={selectedSeasonId}
            disabled={isPending}
            onChange={(e) => go({ season: Number(e.target.value) })}
            className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
          >
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-subtle">2 · Week</span>
          <select
            aria-label="Select week"
            value={selectedWeek}
            disabled={isPending}
            onChange={(e) => go({ week: Number(e.target.value) })}
            className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
          >
            {weekList.map((w) => (
              <option key={w} value={w}>
                Week {w}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-subtle">3 · Risk level</span>
        <div
          role="group"
          aria-label="Risk level"
          className="inline-flex flex-wrap gap-2"
        >
          {risks.map((r) => {
            const active = r.value === selectedRisk;
            return (
              <button
                key={r.value}
                type="button"
                aria-pressed={active}
                disabled={isPending}
                onClick={() => go({ risk: r.value })}
                className={cn(
                  'flex flex-col items-start rounded-lg border px-3.5 py-2 text-left transition-colors disabled:opacity-60',
                  active
                    ? 'border-accent bg-accent/10 text-foreground ring-1 ring-accent/40'
                    : 'border-border-strong bg-card text-muted hover:bg-surface hover:text-foreground',
                )}
              >
                <span className="text-sm font-semibold">{r.label}</span>
                <span className="text-[11px] text-subtle">{r.tagline}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
