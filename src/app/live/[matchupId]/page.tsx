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
import { ArrowLeft, TriangleAlert } from 'lucide-react';

import { Card, CardBody } from '@/components/card';
import { Container } from '@/components/container';
import { assembleLive, type LiveMatchup } from '@/lib/live/assemble';
import { getLiveWeekData, getMatchupLocation } from '@/lib/live/query';
import { getLiveStatsForWeek, type LiveStatIndex } from '@/lib/live/stats';
import { lineupMinutes } from '@/lib/live/minutes';
import { assessCaptureStaleness } from '@/lib/live/staleness';
import { exhibitionWeekLabel, isExhibitionWeek } from '@/lib/schedule/preseason';

import { LiveRefresh } from '../live-refresh';
import { MatchupDetail } from './matchup-detail';
import { MatchupNav, type MatchupNavItem } from './matchup-nav';

export const runtime = 'nodejs';
export const maxDuration = 30;

export const metadata: Metadata = {
  title: 'Live matchup',
  robots: { index: false },
};

function weekLabel(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

/**
 * A matchup is identified by BOTH owners — one name doesn't say which pairing it is — and a
 * step target is far more useful carrying its score and how much football it has left.
 */
function toNavItem(m: LiveMatchup, index: LiveStatIndex): MatchupNavItem {
  const clocks = index.teamState;
  const side = (t: LiveMatchup['home']) => ({
    ownerName: t.ownerName,
    logoEspn: t.logoEspn,
    teamKey: t.teamKey,
    // null, not 0 — an uncaptured roster is unknown. Same rule as everywhere else.
    points: t.hasSnapshot ? t.points : null,
  });
  return {
    id: m.id,
    home: side(m.home),
    away: side(m.away),
    minutesLeft:
      lineupMinutes(m.home.slots, clocks).minutesLeft +
      lineupMinutes(m.away.slots, clocks).minutesLeft,
  };
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

  const position = view.matchups.findIndex((m) => m.id === id);
  const matchup = position >= 0 ? view.matchups[position] : undefined;
  if (!matchup) notFound();

  // Step through the week's matchups without going back to the list. Wraps at both ends, so
  // there is never a dead arrow — with 16 matchups, hitting a disabled control is more
  // annoying than looping.
  const count = view.matchups.length;
  const prev = view.matchups[(position - 1 + count) % count];
  const next = view.matchups[(position + 1) % count];
  const options = view.matchups.map((m) => toNavItem(m, index));

  // THE WARNING THIS PAGE WAS MISSING. /live has carried it since the feature shipped, but a
  // matchup page is where people actually sit during a game — and it rendered a total that was
  // quietly low with nothing to say so. 2026 week 2: the only capture was taken at 1:08pm, so
  // the whole late slate stayed hidden and this page showed 56.02 against DraftKings' 78.42.
  //
  // Scoped to THIS matchup's hidden slots (a week-wide count would cry wolf on a matchup whose
  // players are all accounted for), while "games started since" is necessarily week-wide —
  // it is a property of the capture, not of one roster.
  const concealedHere = matchup.home.concealed + matchup.away.concealed;
  // THIS matchup's capture time, not the week's newest. Concealment is a property of when
  // THESE two rosters were read, so judging them against a later capture of somebody else's
  // roster would understate how much has kicked off since — and under-warn.
  const capturedHere = [matchup.home.capturedAt, matchup.away.capturedAt]
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const staleness = assessCaptureStaleness({
    games: index.games,
    kickoffByTeam: Object.fromEntries(
      Object.entries(data.teamContext).map(([k, c]) => [k, c.kickoff]),
    ),
    capturedAt: capturedHere,
    concealedSlots: concealedHere,
  });

  return (
    <Container width="wide" as="div" className="flex flex-col gap-4 py-6 sm:py-8">
      {/*
        Deliberately spare. The matchup is named three more times below — in the nav bar, the
        dropdown and the scoreboard — and the week appears in the back link, so a PageHeader
        repeating both was pure duplication pushing the actual scores below the fold.
      */}
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

      <MatchupNav
        matchups={options}
        currentId={id}
        position={position + 1}
        prev={toNavItem(prev, index)}
        next={toNavItem(next, index)}
      />

      {staleness.shouldRecapture ? (
        <Card className="border-tie/30 bg-tie-soft/40">
          <CardBody className="flex items-start gap-3 p-4 sm:p-5">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-tie" aria-hidden="true" />
            <p className="text-sm">
              <span className="font-semibold">These totals are low — re-sync to fix.</span>{' '}
              {concealedHere} player{concealedHere === 1 ? '' : 's'} in this matchup
              {concealedHere === 1 ? ' was' : ' were'} hidden by DraftKings when the lineups were
              last synced, and {staleness.gamesStartedSinceCapture} game
              {staleness.gamesStartedSinceCapture === 1 ? ' has' : 's have'} kicked off since.
              They are scoring points that are not counted below. Hit Sync in the Chrome
              extension to fill them in.
            </p>
          </CardBody>
        </Card>
      ) : null}

      <MatchupDetail matchup={matchup} index={index} teamContext={data.teamContext} />

      <p className="text-xs text-muted">
        Live estimate from public NFL stats — the DraftKings leaderboard is the official score.
        {' · '}
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
