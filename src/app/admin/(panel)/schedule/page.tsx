import type { Metadata } from 'next';
import { CalendarDays } from 'lucide-react';
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
            Pull the schedule whenever the NFL revises it (upserts are idempotent). Generate
            matchups after the schedule loads and team assignments are complete — games where a
            team is unassigned are skipped until that owner is set.
          </CardDescription>
        </CardHeader>
        <CardBody>
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
