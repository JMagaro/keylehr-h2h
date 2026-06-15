/**
 * Admin → Sync — Server Component. Tells the commissioner, per week, whether the
 * DraftKings score sync completed or needs a re-sync, driven by the
 * `scoreImportRuns` audit log plus the matchup/score/game facts. Season is chosen
 * via `?season=<id>`, defaulting to the most recent season that has data.
 */
import type { Metadata } from 'next';
import { RefreshCw } from 'lucide-react';

import { Badge, type BadgeVariant } from '@/components/badge';
import { Card, CardBody } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { StatTile } from '@/components/stat-tile';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { requireAdmin } from '@/lib/auth-helpers';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';
import {
  getSeasonSyncStatus,
  type SyncHealth,
  type WeekSyncStatus,
} from '@/lib/scores/status';

import { formatRelativeTime } from './relative-time';

export const metadata: Metadata = { title: 'Sync status', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Display config per health: label, badge color, and whether it needs action. */
const HEALTH_META: Record<
  SyncHealth,
  { label: string; variant: BadgeVariant; needsAttention: boolean }
> = {
  complete: { label: 'Complete', variant: 'win', needsAttention: false },
  partial: { label: 'Partial', variant: 'tie', needsAttention: true },
  live: { label: 'Live', variant: 'tie', needsAttention: false },
  needs_sync: { label: 'Needs sync', variant: 'loss', needsAttention: true },
  upcoming: { label: 'Upcoming', variant: 'neutral', needsAttention: false },
  no_schedule: { label: 'No schedule', variant: 'neutral', needsAttention: false },
};

function HealthBadge({ health }: { health: SyncHealth }) {
  const meta = HEALTH_META[health];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

/** The "detail" cell: unmatched names / error, or a re-sync hint when needed. */
function WeekDetail({ week }: { week: WeekSyncStatus }) {
  const meta = HEALTH_META[week.health];
  const { lastRun } = week;

  if (lastRun?.status === 'failed' && lastRun.error) {
    return (
      <span className="text-loss">
        {lastRun.error}
        <span className="mt-0.5 block text-xs text-muted">
          Re-sync this week&rsquo;s contest in the extension.
        </span>
      </span>
    );
  }

  if (meta.needsAttention) {
    const bits: string[] = [];
    if (lastRun && lastRun.unmatched > 0) {
      bits.push(`${lastRun.unmatched} unmatched entr${lastRun.unmatched === 1 ? 'y' : 'ies'}`);
    }
    if (week.scoredOwners < week.expectedOwners) {
      bits.push(`${week.expectedOwners - week.scoredOwners} owner(s) missing a score`);
    }
    return (
      <span className="text-muted">
        {bits.length > 0 ? bits.join(' · ') : 'Scores incomplete'}
        <span className="mt-0.5 block text-xs text-subtle">
          Re-sync this week&rsquo;s contest in the extension.
        </span>
      </span>
    );
  }

  return <span className="text-subtle">—</span>;
}

export default async function AdminSyncPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();
  const now = new Date();

  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  const requested = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const requestedId = requested ? Number(requested) : NaN;
  const validRequested =
    !Number.isNaN(requestedId) && seasons.some((s) => s.id === requestedId);
  const defaultId = await getDefaultStandingsSeasonId();
  const selectedId = validRequested ? requestedId : (defaultId ?? seasons[0]?.id);

  const selectedSeason = seasons.find((s) => s.id === selectedId) ?? null;
  const status =
    selectedId !== undefined ? await getSeasonSyncStatus(selectedId, now) : null;

  const needingAttention = status?.summary.weeksNeedingAttention ?? 0;
  const lastSyncAt = status?.summary.lastSyncAt ?? null;
  const weeksComplete = status?.summary.byHealth.complete ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Sync status"
        description="Per-week DraftKings score sync health for the selected season. Green weeks are fully scored; amber/red weeks need a re-sync."
        actions={
          selectedId !== undefined ? (
            <SeasonSelector seasons={seasons} selectedId={selectedId} />
          ) : null
        }
      />

      {status === null || seasons.length === 0 ? (
        <EmptyState
          icon={RefreshCw}
          title="No seasons to show"
          description="Create a season and assign owners to begin tracking weekly score syncs."
        />
      ) : (
        <>
          {needingAttention > 0 ? (
            <Card className="border-loss/40 bg-loss-soft">
              <CardBody className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-loss">
                  ⚠️ {needingAttention} week{needingAttention === 1 ? '' : 's'} need a re-sync
                </p>
                <p className="text-xs text-muted">
                  Re-pull the affected weeks&rsquo; DraftKings contests from the extension.
                </p>
              </CardBody>
            </Card>
          ) : (
            <Card className="border-win/40 bg-win-soft">
              <CardBody>
                <p className="text-sm font-semibold text-win">All weeks synced ✓</p>
              </CardBody>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <StatTile
              label="Weeks complete"
              value={`${weeksComplete} / ${status.regularSeasonWeeks}`}
            />
            <StatTile
              label="Needs attention"
              value={needingAttention}
              hint={needingAttention > 0 ? 'partial or failed' : 'all clear'}
            />
            <StatTile
              label="Last sync"
              value={lastSyncAt ? formatRelativeTime(lastSyncAt, now) : '—'}
              hint={lastSyncAt ? lastSyncAt.toLocaleString() : 'no syncs yet'}
            />
          </div>

          <Table>
            <caption className="sr-only">
              {selectedSeason?.name ?? 'Season'} weekly sync status
            </caption>
            <THead>
              <TR>
                <TH align="center" className="w-14">
                  Week
                </TH>
                <TH>Status</TH>
                <TH align="right">Scored</TH>
                <TH>Last synced</TH>
                <TH>Source</TH>
                <TH>Detail</TH>
              </TR>
            </THead>
            <TBody>
              {status.weeks.map((week) => (
                <TR key={week.week}>
                  <TD align="center" className="tabular-nums font-semibold">
                    {week.week}
                  </TD>
                  <TD>
                    <HealthBadge health={week.health} />
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {week.health === 'no_schedule'
                      ? '—'
                      : `${week.scoredOwners}/${week.expectedOwners}`}
                  </TD>
                  <TD className="text-muted">
                    {week.lastRun ? formatRelativeTime(week.lastRun.createdAt, now) : '—'}
                  </TD>
                  <TD className="text-muted">{week.lastRun?.triggeredBy ?? '—'}</TD>
                  <TD className="max-w-md whitespace-normal">
                    <WeekDetail week={week} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}
    </div>
  );
}
