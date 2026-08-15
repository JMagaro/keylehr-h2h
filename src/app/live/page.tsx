/**
 * /live — the running estimate for a week, computed from public NFL stats.
 *
 * WHAT MAKES THIS WORK WITH EVERY MACHINE SWITCHED OFF: rosters were captured once from an
 * authenticated DraftKings session and stored; the per-player scoring comes from ESPN's
 * public boxscore, which needs no auth. So this page is live on Vercel without anything
 * polling DraftKings all week.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DO NOT ADD `export const dynamic = 'force-dynamic'` TO THIS ROUTE.
 *
 * Every other data page in this repo sets it, so copying the idiom is the obvious mistake.
 * Here it is actively harmful: `force-dynamic` implies `fetchCache = 'force-no-store'`, which
 * silently disables the Data Cache for EVERY fetch on the route (confirmed in the bundled
 * Next 16.2.9 docs, caching-without-cache-components.md:97-99). The whole caching design
 * below — one warm entry serving all 32 owners — would collapse into 32 separate ESPN
 * fan-outs. The route is already dynamic because it awaits `searchParams`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * NOTHING HERE IS A SCORE. The DraftKings leaderboard remains the official number; this is an
 * estimate and says so on the page. See docs/SCORING.md §15.
 */
import type { Metadata } from 'next';
import { Activity, TriangleAlert } from 'lucide-react';

import { Card, CardBody } from '@/components/card';
import { Container } from '@/components/container';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { assembleLive } from '@/lib/live/assemble';
import { getDefaultLiveWeek, getLiveWeekData } from '@/lib/live/query';
import { getLiveStatsForWeek } from '@/lib/live/stats';
import { assessCaptureStaleness, countConcealedSlots } from '@/lib/live/staleness';
import { lineupMinutes } from '@/lib/live/minutes';
import { projectLineup, winProbability } from '@/lib/live/projection';
import { exhibitionWeekLabel, isExhibitionWeek } from '@/lib/schedule/preseason';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';

import { LiveRefresh } from './live-refresh';
import { MatchupCard } from './matchup-card';

export const metadata: Metadata = {
  title: 'Live',
  description:
    'Live in-progress scoring estimates for the current KeyLehr H2H week, computed from public NFL stats.',
};

export const runtime = 'nodejs';
/** A cold render fans out to ~16 ESPN summaries; give it room rather than a partial slate. */
export const maxDuration = 30;

const LIVE_DESCRIPTION =
  "A running estimate while games are being played, computed from public NFL stats using DraftKings' scoring rules.";

function weekLabel(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

export default async function LivePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  if (seasons.length === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
        <PageHeader eyebrow="In progress" title="Live" description={LIVE_DESCRIPTION} />
        <EmptyState icon={Activity} title="No seasons yet" description="Create a season first." />
      </Container>
    );
  }

  // An explicit ?season= wins; otherwise fall back to the most recent season that actually has
  // owners, so an empty upcoming season never becomes the default.
  const requestedSeason = Number(Array.isArray(sp.season) ? sp.season[0] : sp.season);
  const seasonId = seasons.some((s) => s.id === requestedSeason)
    ? requestedSeason
    : ((await getDefaultStandingsSeasonId()) ?? seasons[0].id);

  const header = (
    <PageHeader
      eyebrow="In progress"
      title="Live"
      description={LIVE_DESCRIPTION}
      actions={
        seasons.length > 1 ? (
          <SeasonSelector seasons={seasons} selectedId={seasonId} />
        ) : undefined
      }
    />
  );

  const requestedWeek = Number(Array.isArray(sp.week) ? sp.week[0] : sp.week);
  const week = Number.isInteger(requestedWeek) ? requestedWeek : await getDefaultLiveWeek(seasonId);

  const data = await getLiveWeekData(seasonId, week);
  const index = await getLiveStatsForWeek(seasonId, week, data.games);
  const view = assembleLive(data.matchups, data.snapshots, index);

  const partialSlate = view.gamesTotal > 0 && view.gamesLoaded < view.gamesTotal;

  // Order by CLOSENESS, not matchup id. On a Sunday afternoon the interesting cards are the
  // ones that could still go either way, and burying them behind blowouts wastes the top of
  // the page. Fully-uncaptured matchups sort last — there is nothing to be close about.
  const ordered = [...view.matchups]
    .map((m) => {
      const known = m.home.hasSnapshot && m.away.hasSnapshot;
      if (!known) return { m, rank: Number.POSITIVE_INFINITY };
      const homeProj = projectLineup(m.home, index.teamState);
      const awayProj = projectLineup(m.away, index.teamState);
      const minutes =
        lineupMinutes(m.home.slots, index.teamState).minutesLeft +
        lineupMinutes(m.away.slots, index.teamState).minutesLeft;
      const odds = winProbability(homeProj.projected, awayProj.projected, minutes);
      // Distance from a coin flip: 0 is a dead heat, 0.5 is decided.
      return { m, rank: Math.abs(odds.home - 0.5) };
    })
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.m);

  // The estimate's most consequential failure mode: a capture taken before the late games,
  // never repeated. Those players are playing and scoring, and we do not even know their
  // names — so the totals below are silently low until someone re-captures.
  const staleness = assessCaptureStaleness({
    games: index.games,
    kickoffByTeam: Object.fromEntries(
      Object.entries(data.teamContext).map(([k, c]) => [k, c.kickoff]),
    ),
    capturedAt: view.latestCapturedAt,
    concealedSlots: countConcealedSlots(view.matchups),
  });

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      {header}

      {/* Permanent, not dismissible. The number on this page is not the number that pays out. */}
      <Card className="border-tie/30 bg-tie-soft/40">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-foreground">
            <span className="font-semibold">Live estimate — {weekLabel(week)}.</span> Computed from
            public NFL stats. The <span className="font-semibold">DraftKings leaderboard is the
            official score</span>, and it is what settles the week.
          </p>
          <LiveRefresh fetchedAt={view.fetchedAt} />
        </CardBody>
      </Card>

      {view.matchups.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={`No matchups for ${weekLabel(week)}`}
          description="Once the week's schedule exists and lineups are captured, the live estimate shows up here."
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              {view.gamesLoaded}/{view.gamesTotal} games loaded
            </span>
            {view.latestCapturedAt ? (
              <span>
                Lineups as of{' '}
                {view.latestCapturedAt.toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
            ) : null}
          </div>

          {staleness.shouldRecapture ? (
            <Card className="border-tie/30 bg-tie-soft/40">
              <CardBody className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-tie" aria-hidden="true" />
                <p className="text-sm">
                  <span className="font-semibold">
                    These totals are low — re-sync to fix.
                  </span>{' '}
                  {staleness.gamesStartedSinceCapture} game
                  {staleness.gamesStartedSinceCapture === 1 ? ' has' : 's have'} kicked off since
                  the last capture, so DraftKings would now reveal players it was hiding.{' '}
                  {staleness.concealedSlots} roster spot
                  {staleness.concealedSlots === 1 ? ' is' : 's are'} still unknown and counting
                  as nothing. Hit Sync in the Chrome extension to fill them in.
                </p>
              </CardBody>
            </Card>
          ) : null}

          {/* Surfaced, never swallowed: an owner with no capture is not an owner with 0.00. */}
          {view.missingCaptures.length > 0 ? (
            <Card className="border-tie/30">
              <CardBody className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-tie" aria-hidden="true" />
                <p className="text-sm">
                  <span className="font-semibold">
                    {view.missingCaptures.length} lineup
                    {view.missingCaptures.length === 1 ? '' : 's'} not captured:
                  </span>{' '}
                  {view.missingCaptures.join(', ')}. Their totals show as{' '}
                  <span className="font-mono">—</span>, not zero — run a capture from the Chrome
                  extension to fill them in.
                </p>
              </CardBody>
            </Card>
          ) : null}

          {partialSlate ? (
            <Card className="border-tie/30">
              <CardBody className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-tie" aria-hidden="true" />
                <p className="text-sm">
                  Only {view.gamesLoaded} of {view.gamesTotal} games loaded from ESPN. Players in
                  the missing games show as unresolved rather than scoring zero.
                </p>
              </CardBody>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {ordered.map((m) => (
              <MatchupCard key={m.id} matchup={m} />
            ))}
          </div>
        </>
      )}
    </Container>
  );
}
