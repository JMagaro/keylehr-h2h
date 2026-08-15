'use client';

/**
 * Jump between the week's matchups without going back to the list.
 *
 * A <select> rather than 16 links: it stays one line on a phone, and the current matchup is
 * always visible as the chosen option. Prev/next are rendered as real <Link>s by the page so
 * they work without JavaScript; only this dropdown needs the client.
 */
import { useRouter } from 'next/navigation';

export interface SwitcherOption {
  id: number;
  label: string;
}

export function MatchupSwitcher({
  matchups,
  currentId,
}: {
  matchups: SwitcherOption[];
  currentId: number;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">Choose a matchup</span>
      <select
        value={currentId}
        onChange={(e) => router.push(`/live/${e.target.value}`)}
        className="max-w-[18rem] truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
      >
        {matchups.map((m, i) => (
          <option key={m.id} value={m.id}>
            {i + 1}. {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
