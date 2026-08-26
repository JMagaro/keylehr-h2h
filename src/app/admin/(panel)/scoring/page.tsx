/**
 * Admin → Scoring — does our engine agree with DraftKings, player by player?
 *
 * /live computes DK Classic points from ESPN box scores. If one of those rules were wrong,
 * nothing would ever say so — the page would render slightly wrong numbers forever and look
 * perfectly healthy doing it. This is the standing check.
 *
 * It costs nothing to run: every roster capture already stores DraftKings' own per-player
 * score AND stat line, so both sides of the comparison are in the database. Computed on
 * demand rather than stored — a saved copy would be a third thing to keep in sync.
 *
 * The verdicts, and why they are separate, are documented in src/lib/live/reconcile.ts.
 *
 * NOTHING HERE WRITES. See docs/SCORING.md §15.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2, ScanSearch, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { requireAdmin } from '@/lib/auth-helpers';
import {
  getCapturedWeeks,
  getReconcilableSeasons,
  reconcileWeekFromDb,
} from '@/lib/live/reconcile-query';
import type { ReconcileVerdict, SlotReconciliation } from '@/lib/live/reconcile';
import { exhibitionWeekLabel, isExhibitionWeek } from '@/lib/schedule/preseason';
import { formatPoints, cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Scoring accuracy', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** A cold week fans out to ~16 ESPN summaries before anything can be compared. */
export const maxDuration = 30;

function weekLabel(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

const VERDICT_LABEL: Record<ReconcileVerdict, string> = {
  agree: 'Agrees',
  ruleDrift: 'Rule bug',
  statDrift: 'Source differs',
  unmapped: 'Unknown stat',
  unmatched: 'No ESPN match',
  notComparable: 'Skipped',
};

function verdictVariant(v: ReconcileVerdict): 'win' | 'loss' | 'tie' | 'neutral' {
  if (v === 'ruleDrift') return 'loss';
  if (v === 'unmapped' || v === 'unmatched') return 'tie';
  if (v === 'agree') return 'win';
  return 'neutral';
}

/** The per-stat evidence — the whole reason a total-only comparison isn't enough. */
function Differences({ finding }: { finding: SlotReconciliation }) {
  if (finding.differences.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {finding.differences.map((d, i) => (
        <li key={`${d.dkKey}-${i}`} className="font-mono text-[11px] text-muted">
          {d.dkKey}
          {d.ourKey && d.ourKey !== d.dkKey ? ` (${d.ourKey})` : ''}: DK {d.dkValue} ={' '}
          {formatPoints(d.dkPoints)} · ours {d.ourValue ?? '—'} ={' '}
          {d.ourPoints === null ? '—' : formatPoints(d.ourPoints)}
        </li>
      ))}
    </ul>
  );
}

export default async function AdminScoringPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const seasons = await getReconcilableSeasons();

  if (seasons.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow="Admin"
          title="Scoring accuracy"
          description="Compares our ESPN-derived scoring against DraftKings' own numbers."
        />
        <EmptyState
          icon={ScanSearch}
          title="No captured rosters yet"
          description="Run a Sync from the Chrome extension. The audit reads the DraftKings numbers that captures already store, so there is nothing extra to collect."
        />
      </div>
    );
  }

  const reqSeason = Number(Array.isArray(sp.season) ? sp.season[0] : sp.season);
  const seasonId = seasons.some((s) => s.id === reqSeason) ? reqSeason : seasons[0].id;

  const weeks = await getCapturedWeeks(seasonId);
  const reqWeek = Number(Array.isArray(sp.week) ? sp.week[0] : sp.week);
  const week = weeks.includes(reqWeek) ? reqWeek : weeks[0];

  const header = (
    <PageHeader
      eyebrow="Admin"
      title="Scoring accuracy"
      description="Every captured player, scored from ESPN and compared against DraftKings' own number for the same player. Uses data the weekly sync already collects."
      actions={<SeasonSelector seasons={seasons} selectedId={seasonId} />}
    />
  );

  if (week === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={ScanSearch}
          title="No captured rosters in this season"
          description="Pick another season, or run a Sync from the Chrome extension."
        />
      </div>
    );
  }

  const report = await reconcileWeekFromDb(seasonId, week);
  const judged = report.total - report.notComparable;
  const clean = !report.needsAttention && report.statDrift === 0;

  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* Only weeks that actually have captures — there is nothing to audit in the others. */}
      <div className="flex flex-wrap gap-2">
        {weeks.map((w) => (
          <Link
            key={w}
            href={`/admin/scoring?season=${seasonId}&week=${w}`}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
              w === week
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border text-muted hover:border-border-strong hover:text-foreground',
            )}
          >
            {weekLabel(w)}
          </Link>
        ))}
      </div>

      <Card className={clean ? 'border-win/30' : report.needsAttention ? 'border-loss/40' : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {clean ? (
              <CheckCircle2 className="size-5 text-win" aria-hidden="true" />
            ) : (
              <TriangleAlert
                className={cn('size-5', report.needsAttention ? 'text-loss' : 'text-tie')}
                aria-hidden="true"
              />
            )}
            {weekLabel(week)} — {judged} of {report.total} slots compared, max difference{' '}
            {formatPoints(report.maxAbsDelta)}
          </CardTitle>
          <CardDescription>
            {clean
              ? 'Every comparable player matches DraftKings. The scoring engine is behaving.'
              : report.needsAttention
                ? 'Something here needs a human — see the table below.'
                : 'No scoring bugs. The differences below are ESPN and DraftKings disagreeing about what happened, which is not ours to fix.'}{' '}
            {report.owners} owner{report.owners === 1 ? '' : 's'} captured
            {report.capturedAt
              ? `, read from DraftKings ${report.capturedAt.toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : ''}
            . {report.gamesLoaded}/{report.gamesTotal} games loaded from ESPN.
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <span>
            <span className="font-semibold text-win">{report.agree}</span> agree
          </span>
          <span>
            <span className={cn('font-semibold', report.ruleDrift > 0 && 'text-loss')}>
              {report.ruleDrift}
            </span>{' '}
            rule bugs
          </span>
          <span>
            <span className="font-semibold">{report.statDrift}</span> source differences
          </span>
          <span>
            <span className={cn('font-semibold', report.unmapped > 0 && 'text-tie')}>
              {report.unmapped}
            </span>{' '}
            unknown stats
          </span>
          <span>
            <span className={cn('font-semibold', report.unmatched > 0 && 'text-tie')}>
              {report.unmatched}
            </span>{' '}
            unmatched
          </span>
          <span className="text-muted">
            {report.notComparable} skipped (concealed at capture, or the game had not finished
            when DraftKings was read)
          </span>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Findings</CardTitle>
          <CardDescription>
            A <span className="font-semibold">rule bug</span> means DraftKings and ESPN agree on
            what happened and we priced it differently — that is ours, in{' '}
            <span className="font-mono text-xs">src/lib/dfs/rules.ts</span>. A{' '}
            <span className="font-semibold">source difference</span> means the two feeds saw
            different plays, which is not. An{' '}
            <span className="font-semibold">unknown stat</span> means DraftKings paid for
            something this audit cannot name yet — teach it in{' '}
            <span className="font-mono text-xs">src/lib/live/reconcile.ts</span> before drawing
            conclusions.
          </CardDescription>
        </CardHeader>
        <CardBody>
          {report.findings.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing to report"
              description={`All ${judged} comparable players match DraftKings exactly.`}
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Player</TH>
                  <TH>Slot</TH>
                  <TH>Ours</TH>
                  <TH>DraftKings</TH>
                  <TH>Diff</TH>
                  <TH>Verdict</TH>
                </TR>
              </THead>
              <TBody>
                {report.findings.map((f, i) => (
                  <TR key={`${f.playerName ?? 'unknown'}-${i}`}>
                    <TD>
                      <div className="font-medium">{f.playerName ?? '—'}</div>
                      <div className="text-xs text-muted">{f.teamKey ?? ''}</div>
                    </TD>
                    <TD>{f.slot ?? '—'}</TD>
                    <TD className="tabular-nums">
                      {f.ourPoints === null ? '—' : formatPoints(f.ourPoints)}
                    </TD>
                    <TD className="tabular-nums">
                      {f.dkPoints === null ? '—' : formatPoints(f.dkPoints)}
                    </TD>
                    <TD className="tabular-nums">
                      {f.delta === null ? '—' : `${f.delta > 0 ? '+' : ''}${formatPoints(f.delta)}`}
                    </TD>
                    <TD>
                      <Badge variant={verdictVariant(f.verdict)}>{VERDICT_LABEL[f.verdict]}</Badge>
                      <p className="mt-1 max-w-md text-xs text-muted">{f.explanation}</p>
                      <Differences finding={f} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
