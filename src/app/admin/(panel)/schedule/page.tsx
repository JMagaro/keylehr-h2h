import type { Metadata } from 'next';
import { CalendarClock, CalendarDays, Download, ListChecks } from 'lucide-react';
import { sql } from 'drizzle-orm';

import { db, nflGames, matchups, ownerSeasons } from '@/db';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { PageHeader } from '@/components/page-header';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { requireAdmin } from '@/lib/auth-helpers';
import { getCurrentSeason } from '@/lib/season';

import { PipelineActions } from './pipeline-actions';

export const metadata: Metadata = { title: 'Schedule & matchups', robots: { index: false } };
export const dynamic = 'force-dynamic';
// Safety margin for the ESPN pull + matchup generation server actions hosted on
// this route. With batched upserts they finish in ~1s, but the explicit ceiling
// (vs. the 10s Hobby default) protects against a slow ESPN response or cold DB.
export const maxDuration = 60;

export default async function SchedulePage() {
  await requireAdmin();
  const season = await getCurrentSeason();

  if (!season) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Schedule & matchups" />
        <EmptyState
          icon={CalendarDays}
          title="No season found"
          description="Seed a season before pulling the schedule."
        />
      </div>
    );
  }

  // Schedule status: game/matchup counts, distinct weeks, latest known kickoff
  // (the closest thing to a "last pulled" signal we can derive from nfl_games),
  // and how many teams are assigned (matchups need both teams claimed).
  const [gameStats, matchupCount, assignmentCount] = await Promise.all([
    db
      .select({
        games: sql<number>`count(*)::int`,
        weeks: sql<number>`count(distinct ${nflGames.week})::int`,
        latestKickoff: sql<string | null>`max(${nflGames.kickoff})`,
      })
      .from(nflGames)
      .where(sql`${nflGames.seasonId} = ${season.id}`)
      .then((r) => r[0]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(matchups)
      .where(sql`${matchups.seasonId} = ${season.id}`)
      .then((r) => r[0]),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(ownerSeasons)
      .where(sql`${ownerSeasons.seasonId} = ${season.id}`)
      .then((r) => r[0]),
  ]);

  const gameCount = gameStats?.games ?? 0;
  const weekCount = gameStats?.weeks ?? 0;
  const latestKickoff = gameStats?.latestKickoff
    ? new Date(gameStats.latestKickoff).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;
  const matchupsGenerated = matchupCount?.n ?? 0;
  const teamsAssigned = assignmentCount?.n ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={season.name}
        title="Schedule & matchups"
        description="Pull the real NFL schedule from ESPN, then derive the owner head-to-head matchups from it."
        actions={
          <LinkButton href="/admin/assignments" variant="secondary" size="sm">
            Team assignments →
          </LinkButton>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="NFL games loaded"
          value={gameCount}
          hint={weekCount > 0 ? `across ${weekCount} weeks` : 'not pulled yet'}
        />
        <StatTile label="Matchups generated" value={matchupsGenerated} />
        <StatTile label="Teams assigned" value={`${teamsAssigned} / 32`} />
        <StatTile
          label="Latest kickoff"
          value={latestKickoff ? '✓' : '—'}
          hint={latestKickoff ?? 'no schedule data'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run the pipeline</CardTitle>
          <CardDescription>
            Build <span className="font-medium text-foreground">{season.name}</span> from the real
            NFL schedule, then turn it into owner head-to-head matchups. These actions only affect
            the season shown above ({season.name}).
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {/* What the button does + when to use it. */}
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-sm">
            <div className="flex gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <Download className="size-4" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-foreground">
                  What &ldquo;Pull / refresh NFL schedule&rdquo; does
                </p>
                <p className="text-muted">
                  Fetches the full NFL regular season ({season.regularSeasonWeeks} weeks, ~272 games)
                  for {season.name} from ESPN and saves it here. Your owner matchups, weekly byes,
                  and the standings are all derived from this schedule — so it&rsquo;s the first step
                  every season, and nothing downstream works until it&rsquo;s loaded.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <CalendarClock className="size-4" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-1">
                <p className="font-semibold text-foreground">When to run it</p>
                <ul className="flex list-disc flex-col gap-1 pl-4 text-muted">
                  <li>
                    Once when a new season starts, after the NFL publishes its schedule (usually
                    mid-May).
                  </li>
                  <li>
                    Again whenever the NFL revises a game (flex scheduling, postponements). Re-running
                    is safe — it updates kickoff times and opponents in place and never creates
                    duplicates.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          {/* The order the two steps must run in. */}
          <div className="flex gap-3 text-sm">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
              <ListChecks className="size-4" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-1">
              <p className="font-semibold text-foreground">The order that matters</p>
              <ol className="flex list-decimal flex-col gap-1 pl-4 text-muted">
                <li>
                  <span className="font-medium text-foreground">Pull / refresh NFL schedule</span> —
                  the button below (targets {season.name}).
                </li>
                <li>
                  <span className="font-medium text-foreground">Finish team assignments</span> — every
                  one of the 32 owners needs a team before matchups can be complete.
                </li>
                <li>
                  <span className="font-medium text-foreground">Generate owner matchups</span> —
                  converts each NFL game into an owner-vs-owner matchup. Games where a team
                  isn&rsquo;t assigned yet are skipped until you set that owner, so re-run this after
                  finishing assignments.
                </li>
              </ol>
            </div>
          </div>

          <PipelineActions />
        </CardBody>
      </Card>

      {teamsAssigned < 32 ? (
        <p className="text-xs text-subtle">
          {teamsAssigned} of 32 teams are assigned. Finish{' '}
          <span className="font-medium text-muted">team assignments</span> so every NFL game maps to
          an owner matchup.
        </p>
      ) : null}
    </div>
  );
}
