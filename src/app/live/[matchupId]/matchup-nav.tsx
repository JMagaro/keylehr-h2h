'use client';

/**
 * Step between the week's matchups from inside one of them.
 *
 * Both owners are named on each side, because "Ryan Kealy" alone doesn't tell you which
 * matchup you're about to open — a head-to-head is identified by the pair, not by whoever
 * happens to be listed first.
 *
 * ON A PHONE the rich prev/next cards are the wrong trade: two of them stacked push the
 * actual scoreboard below the fold, which is the one thing you opened the page for. So below
 * `sm` they collapse to two tappable arrows either side of the jump dropdown — the dropdown
 * already names every matchup with both owners and both scores, so nothing is lost but
 * height. The full cards return from `sm` up.
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

/** The full card form — sm and up, where there is room for it. */
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

/**
 * The arrow-only form — below `sm`. Sized to a 44px tap target rather than to its icon, which
 * is the difference between a control you can hit on a phone and one you stab at.
 */
function ArrowStep({
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
        'flex size-11 shrink-0 items-center justify-center rounded-lg border border-border',
        'bg-card text-muted transition-colors hover:border-border-strong hover:text-foreground',
      ].join(' ')}
    >
      <Icon className="size-5" aria-hidden="true" />
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

  // A native select can't render logos, so it carries the scores as text instead — still
  // enough to find the matchup you want without stepping through them. Shared by both
  // layouts so the option list is written once.
  // `block` is load-bearing: a <label> is inline by default, so `w-full` on it does nothing and
  // the select falls back to its INTRINSIC width — which a native select takes from its longest
  // option ("Chris deMartino 141.20 — 138.40 Josh Lehr"). That pushed the whole page wider than
  // a phone viewport and scrolled the header off screen.
  const jumpSelect = (
    <label className="block w-full">
      <span className="sr-only">Jump to a matchup</span>
      <select
        value={currentId}
        onChange={(e) => router.push(`/live/${e.target.value}`)}
        className="w-full truncate rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-strong"
      >
        {matchups.map((m) => (
          <option key={m.id} value={m.id}>
            {/* Each name carries its OWN score, separated by "vs". The previous format put
                both scores in the middle ("Josh Lehr 62.66 — — James Myers"), which collides
                with the em dash that means "not captured" — a matchup with neither lineup read
                as "Marc Downing — — — Nick Scianna". */}
            {m.home.ownerName} {score(m.home)} vs {m.away.ownerName} {score(m.away)}
          </option>
        ))}
      </select>
    </label>
  );

  const positionLabel = (
    <span className="text-[11px] text-muted">
      {position} of {matchups.length}
    </span>
  );

  return (
    <>
      {/* Below sm: arrows flanking the dropdown, one row, no scoreboard pushed off screen. */}
      <div className="flex flex-col items-center gap-1 sm:hidden">
        <div className="flex w-full items-center gap-2">
          <ArrowStep matchup={prev} direction="prev" />
          <div className="min-w-0 flex-1">{jumpSelect}</div>
          <ArrowStep matchup={next} direction="next" />
        </div>
        {positionLabel}
      </div>

      {/* sm and up: the full prev/next cards. */}
      <div className="hidden sm:flex sm:items-stretch sm:gap-3">
        <Step matchup={prev} direction="prev" />

        <div className="flex shrink-0 flex-col items-center justify-center gap-1 sm:w-80">
          {jumpSelect}
          {positionLabel}
        </div>

        <Step matchup={next} direction="next" />
      </div>
    </>
  );
}
