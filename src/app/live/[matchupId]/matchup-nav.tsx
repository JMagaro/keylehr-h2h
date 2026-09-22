'use client';

/**
 * Step between the week's matchups from inside one of them.
 *
 * Both owners are named on each side, because "Ryan Kealy" alone doesn't tell you which
 * matchup you're about to open — a head-to-head is identified by the pair, not by whoever
 * happens to be listed first.
 *
 * ON A PHONE the rich prev/next cards are the wrong trade: two of them stacked push the
 * actual scoreboard below the fold, which is the one thing you opened the page for. Below
 * `sm` the whole week is a SCROLLABLE STRIP of chips instead (`MatchupStrip`) — every matchup
 * reachable in one tap rather than stepped through one at a time, and still a single row.
 * The full cards, and the jump dropdown beside them, return from `sm` up.
 *
 * That strip replaced arrows either side of the dropdown. Stepping is a poor fit for 16
 * sibling matchups: reaching the one you want took up to eight taps and a page load each
 * time, and the dropdown that made it bearable could not show a score without being opened.
 *
 * Prev/next are `<Link>`s, so they navigate with JavaScript disabled, and so are the chips —
 * only the dropdown and the strip's scroll-into-view need the client.
 */
import { useEffect, useRef } from 'react';
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
 * The week's matchups as a scrollable strip — tap any one to switch to it.
 *
 * Replaces the arrows + dropdown below `sm` rather than sitting above them: the whole reason
 * the phone nav is one row is that two rows push the scoreboard off screen, and that
 * constraint does not relax just because the row got nicer. A chip is about the height of the
 * select it displaces.
 *
 * Each chip is BOTH scores plus both logos, because a head-to-head is identified by the pair.
 * The logos are the fast cue and the `aria-label` carries the owners' names, which the chip
 * itself has no room for and a screen reader cannot get from an image.
 */
function MatchupStrip({
  matchups,
  currentId,
}: {
  matchups: MatchupNavItem[];
  currentId: number;
}) {
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  // Matchup 14 of 16 would otherwise open with its own chip off screen to the right, which
  // makes the strip look like it starts at someone else's game. `block: 'nearest'` keeps this
  // from scrolling the PAGE as well — the scoreboard must stay where it is.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [currentId]);

  return (
    // Full-bleed: the strip should run to both screen edges so it reads as scrollable, while
    // the padding keeps the first and last chips clear of them.
    <div className="-mx-4 overflow-x-auto px-4 pb-1 sm:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex w-max gap-2">
        {matchups.map((m) => {
          const isCurrent = m.id === currentId;
          return (
            <Link
              key={m.id}
              ref={isCurrent ? activeRef : undefined}
              href={`/live/${m.id}`}
              aria-label={label(m)}
              aria-current={isCurrent ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 transition-colors',
                isCurrent
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-card hover:border-border-strong',
              )}
            >
              <TeamLogo src={m.home.logoEspn} alt="" size={18} />
              <span className="text-xs font-semibold tabular-nums">{score(m.home)}</span>
              <span className="text-[10px] text-muted">vs</span>
              <span className="text-xs font-semibold tabular-nums">{score(m.away)}</span>
              <TeamLogo src={m.away.logoEspn} alt="" size={18} />
            </Link>
          );
        })}
      </div>
    </div>
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
      {/* Below sm: every matchup as a tappable chip, one scrollable row. */}
      <MatchupStrip matchups={matchups} currentId={currentId} />

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
