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

import { TeamLogo } from '@/components/team-logo';
import { formatMinutes } from '@/lib/live/minutes';
import { formatPoints, cn } from '@/lib/utils';

export interface NavSide {
  ownerName: string;
  logoEspn: string | null;
  teamKey: string | null;
  /** null when that owner has no capture — rendered as an em dash, never 0.00. */
  points: number | null;
}

export interface MatchupNavItem {
  id: number;
  home: NavSide;
  away: NavSide;
  /** Regulation minutes left across both lineups — how much football this matchup has left. */
  minutesLeft: number;
}

function label(m: MatchupNavItem): string {
  return `${m.home.ownerName} vs ${m.away.ownerName}`;
}

function score(side: NavSide): string {
  return side.points === null ? '—' : formatPoints(side.points);
}

/** Both owners with logos and running scores, so a step target is identifiable at a glance. */
function SidePreview({ side }: { side: NavSide }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TeamLogo src={side.logoEspn} alt={side.teamKey ? `${side.teamKey} logo` : ''} size={16} />
      <span className="truncate text-xs text-foreground">{side.ownerName}</span>
      <span
        className={cn(
          'shrink-0 text-xs tabular-nums',
          side.points === null ? 'text-muted' : 'font-semibold text-foreground',
        )}
      >
        {score(side)}
      </span>
    </span>
  );
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
        isPrev ? '' : 'flex-row-reverse',
      ].join(' ')}
    >
      <Icon
        className="size-5 shrink-0 text-muted group-hover:text-foreground"
        aria-hidden="true"
      />
      <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5', !isPrev && 'items-end')}>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {isPrev ? 'Previous' : 'Next'} · {formatMinutes(matchup.minutesLeft)} left
        </span>
        <SidePreview side={matchup.home} />
        <SidePreview side={matchup.away} />
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

      <div className="flex shrink-0 flex-col items-center justify-center gap-1 sm:w-80">
        <label className="w-full">
          <span className="sr-only">Jump to a matchup</span>
          {/* A native select can't render logos, so it carries the scores as text instead —
              still enough to find the matchup you want without stepping through them. */}
          <select
            value={currentId}
            onChange={(e) => router.push(`/live/${e.target.value}`)}
            className="w-full truncate rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
          >
            {matchups.map((m) => (
              <option key={m.id} value={m.id}>
                {m.home.ownerName} {score(m.home)} — {score(m.away)} {m.away.ownerName}
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
