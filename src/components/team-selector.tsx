'use client';

/**
 * TeamSelector — accessible `<select>` that switches which team the `/my-team`
 * dashboard shows by navigating to `?season=<id>&team=<ownerSeasonId>` (preserving
 * the chosen season). Mirrors SeasonSelector's no-client-data-layer approach.
 */
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

interface TeamOption {
  ownerSeasonId: number;
  ownerName: string;
  teamKey: string;
  teamName: string;
}

interface TeamSelectorProps {
  teams: TeamOption[];
  selectedId: number;
  seasonId: number;
}

export function TeamSelector({ teams, selectedId, seasonId }: TeamSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="font-medium text-muted">Team</span>
      <select
        aria-label="Select team"
        value={selectedId}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => {
            router.push(`${pathname}?season=${seasonId}&team=${id}`);
          });
        }}
        className="max-w-[14rem] truncate rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60 sm:max-w-[18rem]"
      >
        {teams.map((t) => (
          <option key={t.ownerSeasonId} value={t.ownerSeasonId}>
            {t.teamKey} · {t.ownerName}
          </option>
        ))}
      </select>
    </label>
  );
}
