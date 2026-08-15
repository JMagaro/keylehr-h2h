/**
 * /live/[matchupId] — one head-to-head matchup in full.
 *
 * It resolves the matchup's week and then goes through the SAME `getLiveWeekData` +
 * `getLiveStatsForWeek` path as the list page. That is deliberate: the week's ESPN stat index
 * is already warm in the Data Cache, so clicking into a matchup costs no extra upstream
 * traffic however many people do it.
 *
 * As on /live, DO NOT add `export const dynamic = 'force-dynamic'` — it would disable the
 * Data Cache for every fetch on the route and defeat the sharing described above. The route is
 * already dynamic because it awaits `params`.
 *
 * NOTHING HERE IS A SCORE. See docs/SCORING.md §15.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Container } from '@/components/container';
import { PageHeader } from '@/components/page-header';
import { assembleLive } from '@/lib/live/assemble';
import { getLiveWeekData, getMatchupLocation } from '@/lib/live/query';
import { getLiveStatsForWeek } from '@/lib/live/stats';
import { exhibitionWeekLabel, isExhibitionWeek } from '@/lib/schedule/preseason';

import { LiveRefresh } from '../live-refresh';
import { MatchupDetail } from './matchup-detail';

export const runtime = 'nodejs';
export const maxDuration = 30;

export const metadata: Metadata = {
  title: 'Live matchup',
  robots: { index: false },
};

function weekLabel(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

export default async function LiveMatchupPage({
  params,
}: {
  params: Promise<{ matchupId: string }>;
}) {
  const { matchupId } = await params;
  const id = Number(matchupId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const location = await getMatchupLocation(id);
  if (!location) notFound();

  const data = await getLiveWeekData(location.seasonId, location.week);
  const index = await getLiveStatsForWeek(location.seasonId, location.week, data.games);
  const view = assembleLive(data.matchups, data.snapshots, index);

  const matchup = view.matchups.find((m) => m.id === id);
  if (!matchup) notFound();

  return (
    <Container width="wide" as="div" className="flex flex-col gap-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/live?season=${location.seasonId}&week=${location.week}`}
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          All {weekLabel(location.week)} matchups
        </Link>
        <LiveRefresh fetchedAt={view.fetchedAt} />
      </div>

      <PageHeader
        eyebrow={weekLabel(location.week)}
        title={`${matchup.home.ownerName} vs ${matchup.away.ownerName}`}
        description="Live estimate from public NFL stats. The DraftKings leaderboard is the official score."
      />

      <MatchupDetail matchup={matchup} index={index} teamContext={data.teamContext} />

      <p className="text-xs text-muted">
        {view.gamesLoaded}/{view.gamesTotal} games loaded
        {matchup.home.capturedAt || matchup.away.capturedAt
          ? ` · lineups captured ${(matchup.home.capturedAt ?? matchup.away.capturedAt)!.toLocaleString(
              'en-US',
              { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
            )}`
          : ''}
      </p>
    </Container>
  );
}
