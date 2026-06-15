/**
 * Admin → Dashboard — Server Component. The commissioner's one-screen "data
 * status" view: per season, exactly what data IS there and what is MISSING, so
 * setting up a new season (or spotting a gap mid-season) is a single glance.
 *
 * Season is chosen via `?season=<id>`; it DEFAULTS to the current season (the one
 * being set up / played) so a fresh, empty season surfaces everything that still
 * needs doing, falling back to the most-recent season that has data.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardBody, CardHeader, CardTitle } from '@/components/card';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { TeamLogo } from '@/components/team-logo';
import { LinkButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getCurrentSeason } from '@/lib/season';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';
import { getSeasonDataStatus, type SeasonDataStatus } from '@/lib/admin/data-status';

import { MissingList } from './missing-list';

export const metadata: Metadata = { title: 'Dashboard', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* -------------------------------------------------------------------------- */
/* Checklist row primitives                                                    */
/* -------------------------------------------------------------------------- */

/** One checklist item, ✓ green when ok / ⚠️ amber-red when not. */
function StatusRow({
  ok,
  title,
  count,
  label,
  fixHref,
  fixLabel,
  children,
}: {
  ok: boolean;
  title: string;
  /** Short "X / target" or count shown on the right. */
  count: string;
  /** One-line status label under the title. */
  label: string;
  fixHref: string;
  fixLabel: string;
  /** Optional missing-item detail (expandable list / inline note). */
  children?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 border-l-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between',
        ok ? 'border-win/50 bg-win-soft/30' : 'border-loss/50 bg-loss-soft/30',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold',
            ok ? 'bg-win/15 text-win' : 'bg-loss/15 text-loss',
          )}
        >
          {ok ? '✓' : '!'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <span className="sr-only">{ok ? 'complete' : 'needs attention'}</span>
          </div>
          <p className={cn('text-xs', ok ? 'text-win' : 'text-loss')}>{label}</p>
          {children ? <div className="mt-2">{children}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 pl-9 sm:pl-0">
        <span className="text-sm font-semibold tabular-nums text-foreground">{count}</span>
        {!ok ? (
          <LinkButton href={fixHref} variant="secondary" size="sm">
            {fixLabel}
          </LinkButton>
        ) : null}
      </div>
    </li>
  );
}

/** A single unassigned-team chip (logo optional). */
function TeamChip({ logoEspn, name }: { logoEspn: string | null; name: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5">
      <TeamLogo src={logoEspn} alt="" size={14} />
      {name}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

function DataStatusChecklist({ status }: { status: SeasonDataStatus }) {
  const { owners, assignments, dkEntryNames, schedule, matchups, scores, awards } = status;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Season data status</CardTitle>
        <p className="text-sm text-muted">
          What is set up for {status.season.name}, and what still needs doing. Green is
          good; amber rows have a fix link.
        </p>
      </CardHeader>
      <ul className="flex flex-col divide-y divide-border">
        <StatusRow
          ok={owners.ok}
          title="Owners"
          count={`${owners.count} / ${owners.target}`}
          label={owners.label}
          fixHref="/admin/owners"
          fixLabel="Manage owners"
        />

        <StatusRow
          ok={assignments.ok}
          title="Team assignments"
          count={`${assignments.assigned} / ${assignments.target}`}
          label={assignments.label}
          fixHref="/admin/assignments"
          fixLabel="Assign teams"
        >
          {assignments.unassignedTeams.length > 0 ? (
            <MissingList
              summary={`${assignments.unassignedTeams.length} team${assignments.unassignedTeams.length === 1 ? '' : 's'} unassigned:`}
              items={assignments.unassignedTeams.map((t) => (
                <TeamChip key={t.key} logoEspn={t.logoEspn} name={t.name} />
              ))}
            />
          ) : null}
        </StatusRow>

        <StatusRow
          ok={dkEntryNames.ok}
          title="DK entry names"
          count={`${dkEntryNames.withName} / ${dkEntryNames.total}`}
          label={dkEntryNames.label}
          fixHref="/admin/assignments"
          fixLabel="Set DK names"
        >
          {dkEntryNames.missing.length > 0 ? (
            <MissingList
              summary={`${dkEntryNames.missing.length} owner${dkEntryNames.missing.length === 1 ? '' : 's'} missing a DK entry name (needed for score sync):`}
              items={dkEntryNames.missing.map((m, i) => (
                <span
                  key={`${m.ownerName}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5"
                >
                  {m.ownerName}{' '}
                  <span className="text-subtle">({m.teamKey})</span>
                </span>
              ))}
            />
          ) : null}
        </StatusRow>

        <StatusRow
          ok={schedule.ok}
          title="NFL schedule"
          count={`${schedule.games} / ${schedule.expected}`}
          label={schedule.label}
          fixHref="/admin/schedule"
          fixLabel="Pull schedule"
        />

        <StatusRow
          ok={matchups.ok}
          title="Matchups"
          count={String(matchups.count)}
          label={matchups.label}
          fixHref="/admin/schedule"
          fixLabel="Generate matchups"
        />

        <StatusRow
          ok={scores.ok}
          title="Weekly scores"
          count={`${scores.weeksComplete} / ${scores.regularSeasonWeeks}`}
          label={scores.label}
          fixHref="/admin/sync"
          fixLabel="Review sync"
        >
          {scores.incompleteWeeks.length > 0 ? (
            <p className="text-xs text-loss">
              Incomplete score weeks: {scores.incompleteWeeks.join(', ')}
            </p>
          ) : null}
        </StatusRow>

        <StatusRow
          ok={awards.ok}
          title="Champion recorded"
          count={awards.championRecorded ? 'Yes' : 'No'}
          label={awards.label}
          fixHref="/admin/settings"
          fixLabel="Record champion"
        />
      </ul>
    </Card>
  );
}

export default async function AdminDashboard({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  // Default to the CURRENT season (the one being set up / played) so a fresh,
  // empty season surfaces everything that needs doing; fall back to the most
  // recent season that has data, then the newest season of any kind.
  const requested = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const requestedId = requested ? Number(requested) : NaN;
  const validRequested =
    !Number.isNaN(requestedId) && seasons.some((s) => s.id === requestedId);

  const current = await getCurrentSeason();
  const defaultDataSeasonId = await getDefaultStandingsSeasonId();
  const selectedId = validRequested
    ? requestedId
    : (current?.id ?? defaultDataSeasonId ?? seasons[0]?.id);

  if (selectedId === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow="Admin"
          title="Dashboard"
          description="No season found — seed one to begin."
        />
      </div>
    );
  }

  const status = await getSeasonDataStatus(selectedId);
  const { scores } = status;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Dashboard"
        description={`${status.season.name} · status: ${status.season.status} · current week ${status.season.currentWeek}`}
        actions={<SeasonSelector seasons={seasons} selectedId={selectedId} />}
      />

      {/* Sync alert — kept from the previous dashboard, now scoped to the
          selected season. */}
      {scores.weeksNeedingAttention > 0 ? (
        <Card className="border-loss/40 bg-loss-soft">
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-loss">
              ⚠️ {scores.weeksNeedingAttention} week
              {scores.weeksNeedingAttention === 1 ? '' : 's'} need a re-sync
              {scores.incompleteWeeks.length > 0
                ? ` (weeks ${scores.incompleteWeeks.join(', ')})`
                : ''}
            </p>
            <LinkButton href="/admin/sync" size="sm">
              Review sync status
            </LinkButton>
          </CardBody>
        </Card>
      ) : scores.weeksComplete > 0 ? (
        <p className="text-xs font-medium text-win">
          All scored weeks are in sync ✓{' '}
          <Link href="/admin/sync" className="text-accent hover:underline">
            View sync status →
          </Link>
        </p>
      ) : null}

      <DataStatusChecklist status={status} />

      <Card>
        <CardBody className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">Quick links</h2>
          <p className="text-xs text-muted">
            Setup order: add owners → assign teams &amp; DK names → pull schedule &amp;
            generate matchups → set each week&rsquo;s DraftKings contest.
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <LinkButton href="/admin/owners" variant="secondary" size="sm">
              Manage owners
            </LinkButton>
            <LinkButton href="/admin/assignments" variant="secondary" size="sm">
              Assign teams
            </LinkButton>
            <LinkButton href="/admin/schedule" variant="secondary" size="sm">
              Schedule &amp; matchups
            </LinkButton>
            <LinkButton href="/admin/sync" variant="secondary" size="sm">
              Sync status
            </LinkButton>
            <LinkButton href="/admin/settings" variant="secondary" size="sm">
              Settings
            </LinkButton>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-subtle">
        Signed in as commissioner.{' '}
        <Link href="/" className="text-accent hover:underline">
          View public site →
        </Link>
      </p>
    </div>
  );
}
