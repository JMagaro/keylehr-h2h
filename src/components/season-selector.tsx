'use client';

/**
 * SeasonSelector — a small accessible `<select>` that navigates to the same
 * route with a different `?season=<id>` query param. Used by /standings and
 * /playoffs to switch the season being viewed without a client data layer.
 */
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

interface SeasonOption {
  id: number;
  name: string;
}

interface SeasonSelectorProps {
  seasons: SeasonOption[];
  selectedId: number;
}

export function SeasonSelector({ seasons, selectedId }: SeasonSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium text-muted">Season</span>
      <select
        aria-label="Select season"
        value={selectedId}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => {
            router.push(`${pathname}?season=${id}`);
          });
        }}
        className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
      >
        {seasons.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
