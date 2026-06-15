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
import { cn } from '@/lib/utils';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';
import {
  getSeasonSyncStatus,
  incompleteWeeks,
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

/** Color-coded cell styling for the at-a-glance week grid, keyed by health. */
const GRID_CELL: Record<SyncHealth, string> = {
  // green — fully scored, clean run
  complete: 'border-win/40 bg-win-soft text-win hover:border-win/70',
  // amber — final but partial scores
  partial: 'border-tie/40 bg-tie-soft text-tie hover:border-tie/70',
  // amber — in progress
  live: 'border-tie/40 bg-tie-soft text-tie hover:border-tie/70',
  // red — final but missing / failed
  needs_sync: 'border-loss/40 bg-loss-soft text-loss hover:border-loss/70',
  // gray — games not yet played
  upcoming: 'border-border bg-surface text-subtle hover:border-border-strong',
  // hollow / dashed — no matchups generated yet
  no_schedule:
    'border-dashed border-border-strong bg-transparent text-subtle hover:border-foreground/40',
};

/** One compact, focusable, anchor-linked cell in the week status grid. */
function WeekGridCell({ week }: { week: WeekSyncStatus }) {
  const meta = HEALTH_META[week.health];
  const counts =
    week.health === 'no_schedule'
      ? '—'
      : `${week.scoredOwners}/${week.expectedOwners}`;
  const label = `Week ${week.week} — ${meta.label.toLowerCase()}, ${counts}`;

  return (
    <a
      href={`#week-${week.week}`}
      title={label}
      aria-label={label}
      className={cn(
        'flex flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-2 text-center transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        GRID_CELL[week.health],
      )}
    >
      <span className="text-sm font-bold tabular-nums leading-none">{week.week}</span>
      <span className="text-[10px] font-medium tabular-nums leading-none opacity-90">
        {counts}
      </span>
    </a>
  );
}

/** Tiny legend swatch + label, mirroring the grid cell colors. */
function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={cn('inline-block size-3 rounded-sm border', swatch)} aria-hidden="true" />
      {label}
    </span>
  );
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
  const incomplete = status ? incompleteWeeks(status) : [];

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
          {/* At-a-glance week status grid + the impossible-to-miss callout. */}
          <Card>
            <CardBody className="flex flex-col gap-4">
              {incomplete.length > 0 ? (
                <div className="rounded-lg border border-loss/40 bg-loss-soft px-4 py-3">
                  <p className="text-sm font-semibold text-loss">
                    ⚠️ Incomplete weeks:{' '}
                    {incomplete.map((wk, i) => (
                      <span key={wk}>
                        {i > 0 ? ', ' : ''}
                        <a
                          href={`#week-${wk}`}
                          className="underline decoration-loss/40 underline-offset-2 hover:decoration-loss"
                        >
                          {wk}
                        </a>
                      </span>
                    ))}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    These weeks&rsquo; NFL games are final but scores are missing or partial —
                    re-pull their DraftKings contests from the extension.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-win/40 bg-win-soft px-4 py-3">
                  <p className="text-sm font-semibold text-win">All weeks complete ✓</p>
                  <p className="mt-0.5 text-xs text-muted">
                    Every week whose games are over is fully scored. Nothing to re-sync.
                  </p>
                </div>
              )}

              <div
                className="grid grid-cols-6 gap-2 sm:grid-cols-9 lg:grid-cols-[repeat(18,minmax(0,1fr))]"
                role="list"
                aria-label="Week sync status grid"
              >
                {status.weeks.map((week) => (
                  <div role="listitem" key={week.week}>
                    <WeekGridCell week={week} />
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <LegendItem swatch="border-win/40 bg-win-soft" label="Complete" />
                <LegendItem swatch="border-tie/40 bg-tie-soft" label="Partial / live" />
                <LegendItem swatch="border-loss/40 bg-loss-soft" label="Needs sync" />
                <LegendItem swatch="border-border bg-surface" label="Upcoming" />
                <LegendItem
                  swatch="border-dashed border-border-strong bg-transparent"
                  label="No schedule"
                />
              </div>
            </CardBody>
          </Card>

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
                <TR key={week.week} id={`week-${week.week}`} className="scroll-mt-24 target:bg-accent/5">
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
