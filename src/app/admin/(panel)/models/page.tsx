/**
 * Admin → Models — operate and inspect the lineup-model performance tracker.
 *
 * Snapshot the three models' recommended lineups for a week (near lock), then grade them
 * against actual player results after the games. Shows the cumulative per-model performance
 * and the raw per-week snapshot/grade rows. Season via `?season=`, week via `?week=`.
 */
import type { Metadata } from 'next';
import { LineChart } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { WeekSelector } from '@/components/week-selector';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { requireAdmin } from '@/lib/auth-helpers';
import { getBuilderSeasons, pickDefaultBuilderSeason } from '@/lib/players/query';
import { getModelPerformance, getWeekSnapshots } from '@/lib/players/performance';

import { GradeForm, SnapshotForm } from './models-forms';

export const metadata: Metadata = { title: 'Models', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function num(n: number | null, digits = 1): string {
  return n == null ? '—' : n.toFixed(digits);
}

export default async function AdminModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const seasons = await getBuilderSeasons();
  if (seasons.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Models" description="Lineup-model performance tracker." />
        <EmptyState icon={LineChart} title="No seasons yet" description="Create a season first." />
      </div>
    );
  }

  const reqSeason = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const reqSeasonId = reqSeason ? Number(reqSeason) : NaN;
  const season =
    seasons.find((s) => s.id === reqSeasonId) ?? pickDefaultBuilderSeason(seasons) ?? seasons[0];

  const reqWeek = Number(Array.isArray(sp.week) ? sp.week[0] : sp.week);
  const week =
    Number.isInteger(reqWeek) && reqWeek >= 1 && reqWeek <= season.regularSeasonWeeks
      ? reqWeek
      : Math.min(Math.max(season.currentWeek, 1), season.regularSeasonWeeks);

  const [perf, snaps] = await Promise.all([
    getModelPerformance(season.id),
    getWeekSnapshots(season.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Lineup Models"
        description="Snapshot the three models near lock, grade them against actual results, and track performance over time."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <SeasonSelector seasons={seasons} selectedId={season.id} />
            <WeekSelector weeks={season.regularSeasonWeeks} selectedWeek={week} seasonId={season.id} />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Snapshot</CardTitle>
            <CardDescription>Capture this week&apos;s recommended lineups.</CardDescription>
          </CardHeader>
          <CardBody>
            <SnapshotForm seasonId={season.id} week={week} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Grade</CardTitle>
            <CardDescription>Score snapshots against actual results.</CardDescription>
          </CardHeader>
          <CardBody>
            <GradeForm seasonId={season.id} week={week} />
          </CardBody>
        </Card>
      </div>

      {/* Cumulative performance */}
      <Card>
        <CardHeader>
          <CardTitle>Model performance · {season.name}</CardTitle>
          <CardDescription>
            Averaged over graded weeks. &ldquo;% of optimal&rdquo; = how close the model got to the
            best possible lineup from its considered players (salary weeks only).
          </CardDescription>
        </CardHeader>
        <CardBody>
          <Table>
            <THead>
              <TR>
                <TH>Model</TH>
                <TH align="center">Stage</TH>
                <TH align="right">Weeks</TH>
                <TH align="right">Avg pts</TH>
                <TH align="right">% of optimal</TH>
                <TH align="right">vs chalk</TH>
              </TR>
            </THead>
            <TBody>
              {perf.map((m) => (
                <TR key={m.risk}>
                  <TD>
                    <span className="font-semibold text-foreground">{m.codename}</span>{' '}
                    <span className="text-xs text-subtle">v{m.version}</span>
                  </TD>
                  <TD align="center">
                    <Badge variant={m.stage === 'trained' ? 'accent' : 'neutral'}>{m.stage}</Badge>
                  </TD>
                  <TD align="right" className="tabular-nums">{m.weeksGraded}</TD>
                  <TD align="right" className="tabular-nums">{num(m.avgActual)}</TD>
                  <TD align="right" className="tabular-nums">
                    {m.avgOptimalPct == null ? '—' : `${num(m.avgOptimalPct)}%`}
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {m.avgVsChalk == null ? '—' : (m.avgVsChalk >= 0 ? '+' : '') + num(m.avgVsChalk)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardBody>
      </Card>

      {/* Raw snapshots */}
      <Card>
        <CardHeader>
          <CardTitle>Snapshots</CardTitle>
          <CardDescription>Per-week, per-model rows. Graded rows show actual points.</CardDescription>
        </CardHeader>
        <CardBody>
          {snaps.length === 0 ? (
            <EmptyState
              icon={LineChart}
              title="No snapshots yet"
              description="Snapshot a week above. Tracking begins once the season's slates go live."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH align="center">Wk</TH>
                  <TH>Model</TH>
                  <TH align="center">Mode</TH>
                  <TH align="center">Graded</TH>
                  <TH align="right">Actual</TH>
                  <TH align="right">Optimal</TH>
                  <TH align="right">Chalk</TH>
                </TR>
              </THead>
              <TBody>
                {snaps.map((s) => (
                  <TR key={`${s.week}-${s.risk}`}>
                    <TD align="center" className="tabular-nums text-subtle">{s.week}</TD>
                    <TD className="text-muted">{s.modelVersion}</TD>
                    <TD align="center">
                      <Badge variant={s.salaryMode ? 'accent' : 'neutral'}>
                        {s.salaryMode ? 'salary' : 'signal'}
                      </Badge>
                    </TD>
                    <TD align="center" className="text-subtle">
                      {s.gradedAt ? `${s.playersGraded ?? 0}/9` : '—'}
                    </TD>
                    <TD align="right" className="tabular-nums">{num(s.actualPoints ? Number(s.actualPoints) : null)}</TD>
                    <TD align="right" className="tabular-nums">{num(s.optimalPoints ? Number(s.optimalPoints) : null)}</TD>
                    <TD align="right" className="tabular-nums">{num(s.chalkPoints ? Number(s.chalkPoints) : null)}</TD>
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
