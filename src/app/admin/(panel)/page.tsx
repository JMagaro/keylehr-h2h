import type { Metadata } from 'next';
import Link from 'next/link';
import { sql } from 'drizzle-orm';

import { db, owners, ownerSeasons, nflGames, matchups } from '@/db';
import { Card, CardBody } from '@/components/card';
import { StatTile } from '@/components/stat-tile';
import { PageHeader } from '@/components/page-header';
import { LinkButton } from '@/components/ui/button';
import { getCurrentSeason } from '@/lib/season';
import { getDefaultStandingsSeasonId } from '@/lib/standings/query';
import { getSeasonSyncStatus } from '@/lib/scores/status';

export const metadata: Metadata = { title: 'Dashboard', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const season = await getCurrentSeason();

  // Sync health for the alert banner. Prefer the current season if it has data;
  // otherwise fall back to the most-recent season WITH data (the same default the
  // /admin/sync page selects), so a fresh/empty current season never hides a stale
  // sync on the season people are actually scoring.
  const defaultDataSeasonId = await getDefaultStandingsSeasonId();
  const syncSeasonId = season?.id ?? defaultDataSeasonId ?? null;
  const syncSummary = syncSeasonId
    ? (await getSeasonSyncStatus(syncSeasonId, new Date())).summary
    : null;

  const [ownerCount] = await db.select({ n: sql<number>`count(*)::int` }).from(owners);
  const assignmentCount = season
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(ownerSeasons)
        .where(sql`${ownerSeasons.seasonId} = ${season.id}`)
        .then((r) => r[0])
    : { n: 0 };
  const gameCount = season
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(nflGames)
        .where(sql`${nflGames.seasonId} = ${season.id}`)
        .then((r) => r[0])
    : { n: 0 };
  const matchupCount = season
    ? await db
        .select({ n: sql<number>`count(*)::int` })
        .from(matchups)
        .where(sql`${matchups.seasonId} = ${season.id}`)
        .then((r) => r[0])
    : { n: 0 };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Dashboard"
        description={
          season
            ? `${season.name} · status: ${season.status} · current week ${season.currentWeek}`
            : 'No season found — seed one to begin.'
        }
      />

      {syncSummary && syncSummary.weeksNeedingAttention > 0 ? (
        <Card className="border-loss/40 bg-loss-soft">
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-loss">
              ⚠️ {syncSummary.weeksNeedingAttention} week
              {syncSummary.weeksNeedingAttention === 1 ? '' : 's'} need a re-sync
            </p>
            <LinkButton href="/admin/sync" size="sm">
              Review sync status
            </LinkButton>
          </CardBody>
        </Card>
      ) : syncSummary ? (
        <p className="text-xs font-medium text-win">
          All weeks synced ✓{' '}
          <Link href="/admin/sync" className="text-accent hover:underline">
            View sync status →
          </Link>
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Owners" value={ownerCount?.n ?? 0} />
        <StatTile label="Team assignments" value={`${assignmentCount.n} / 32`} />
        <StatTile label="NFL games loaded" value={gameCount.n} />
        <StatTile label="Matchups generated" value={matchupCount.n} />
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">Setup checklist</h2>
          <ol className="flex flex-col gap-2 text-sm text-muted">
            <li>1. Add the league owners (name + DraftKings username).</li>
            <li>2. Assign each owner to an NFL team for {season?.name ?? 'the season'}.</li>
            <li>3. Pull the NFL schedule, then generate owner matchups.</li>
            <li>4. Review the rules in Settings, then set each week&rsquo;s DraftKings contest.</li>
          </ol>
          <div className="mt-2 flex flex-wrap gap-2">
            <LinkButton href="/admin/owners" size="sm">
              Manage owners
            </LinkButton>
            <LinkButton href="/admin/assignments" variant="secondary" size="sm">
              Assign teams
            </LinkButton>
            <LinkButton href="/admin/schedule" variant="secondary" size="sm">
              Schedule &amp; matchups
            </LinkButton>
            <LinkButton href="/admin/settings" variant="secondary" size="sm">
              Settings
            </LinkButton>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-subtle">
        Signed in as commissioner. <Link href="/" className="text-accent hover:underline">View public site →</Link>
      </p>
    </div>
  );
}
