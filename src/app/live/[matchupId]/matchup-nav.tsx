'use client';

/**
 * Step between the week's matchups from inside one of them.
 *
 * Both owners are named on each side, because "Ryan Kealy" alone doesn't tell you which
 * matchup you're about to open — a head-to-head is identified by the pair, not by whoever
 * happens to be listed first.
 *
 * Prev/next are `<Link>`s, so they navigate with JavaScript disabled; only the dropdown needs
 * the client. It wraps at both ends — with 16 matchups a dead arrow is more annoying than a
 * loop.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface MatchupNavItem {
  id: number;
  home: string;
  away: string;
}

function label(m: MatchupNavItem): string {
  return `${m.home} vs ${m.away}`;
}

function Step({
  matchup,
  direction,
}: {
  matchup: MatchupNavItem;
  direction: 'prev' | 'next';
}) {
  const isPrev = direction === 'prev';
  const Icon = isPrev ? ChevronLeft : ChevronRight;

  return (
    <Link
      href={`/live/${matchup.id}`}
      aria-label={`${isPrev ? 'Previous' : 'Next'} matchup: ${label(matchup)}`}
      className={[
        'group flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card',
        'px-3 py-2 transition-colors hover:border-border-strong hover:bg-surface',
        isPrev ? 'justify-start' : 'flex-row-reverse justify-start text-right',
      ].join(' ')}
    >
      <Icon
        className="size-5 shrink-0 text-muted transition-transform group-hover:text-foreground"
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {isPrev ? 'Previous' : 'Next'}
        </span>
        <span className="truncate text-sm font-medium text-foreground">{label(matchup)}</span>
      </span>
    </Link>
  );
}

export function MatchupNav({
  matchups,
  currentId,
  position,
  prev,
  next,
}: {
  matchups: MatchupNavItem[];
  currentId: number;
  /** 1-based, for the "3 of 16" readout. */
  position: number;
  prev: MatchupNavItem;
  next: MatchupNavItem;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
      <Step matchup={prev} direction="prev" />

      <div className="flex shrink-0 flex-col items-center justify-center gap-1 sm:w-72">
        <label className="w-full">
          <span className="sr-only">Jump to a matchup</span>
          <select
            value={currentId}
            onChange={(e) => router.push(`/live/${e.target.value}`)}
            className="w-full truncate rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
          >
            {matchups.map((m) => (
              <option key={m.id} value={m.id}>
                {label(m)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-muted">
          {position} of {matchups.length}
        </span>
      </div>

      <Step matchup={next} direction="next" />
    </div>
  );
}
