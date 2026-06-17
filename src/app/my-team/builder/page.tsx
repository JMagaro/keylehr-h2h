/**
 * Lineup Builder — a guided wizard that turns free public signals into a DraftKings
 * Classic shortlist for a chosen week + risk level. Pick season → week → risk and get a
 * suggested QB/RB×2/WR×3/TE/FLEX/DST lineup, deeper target lists by position, and players
 * to fade.
 *
 * Transparency by design: these are availability / consensus / waiver signals, NOT point
 * projections or DraftKings salaries (free sources don't provide those). The page says so,
 * and every pick shows the reasons it surfaced.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarOff,
  CircleDollarSign,
  Info,
  ListChecks,
  Sparkles,
  Trophy,
  Users,
} from 'lucide-react';

import { Container } from '@/components/container';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { PlayerCard } from '@/components/player-card';
import {
  LineupBuilderControls,
  type RiskOption,
} from '@/components/lineup-builder-controls';
import {
  getBuilderData,
  getBuilderSeasons,
  pickDefaultBuilderSeason,
  RISK_LEVELS,
  type RiskLevel,
} from '@/lib/players/query';
import { RISK_META } from '@/lib/players/recommend';
import { MODEL_REGISTRY } from '@/lib/players/models';
import { getModelPerformance } from '@/lib/players/performance';
import { DK_CLASSIC_SALARY_CAP } from '@/lib/draftkings/draftables';

export const metadata: Metadata = {
  title: 'Lineup Builder',
  description:
    'A guided DraftKings lineup builder for KeyLehr H2H — pick a week and risk level and get player targets and fades from free public signals (Sleeper trends + injuries, ESPN news, the NFL schedule).',
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function param(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

const RISK_OPTIONS: RiskOption[] = RISK_LEVELS.map((value) => ({
  value,
  label: RISK_META[value].label,
  tagline: `${MODEL_REGISTRY[value].codename} v${MODEL_REGISTRY[value].version}`,
}));

export default async function LineupBuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getBuilderSeasons();

  const backLink = (
    <Link
      href="/my-team"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to My Team
    </Link>
  );

  if (seasons.length === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
        <PageHeader eyebrow="My Team" title="Lineup Builder" actions={backLink} />
        <EmptyState
          icon={Sparkles}
          title="No seasons yet"
          description="Create a season first, then come back to build weekly lineups."
        />
      </Container>
    );
  }

  // Resolve season / week / risk from query params with sensible defaults.
  const reqSeasonId = Number(param(sp, 'season'));
  const season =
    seasons.find((s) => s.id === reqSeasonId) ?? pickDefaultBuilderSeason(seasons) ?? seasons[0];

  const reqWeek = Number(param(sp, 'week'));
  const week =
    Number.isInteger(reqWeek) && reqWeek >= 1 && reqWeek <= season.regularSeasonWeeks
      ? reqWeek
      : Math.min(Math.max(season.currentWeek, 1), season.regularSeasonWeeks);

  const reqRisk = param(sp, 'risk');
  const risk: RiskLevel = (RISK_LEVELS as string[]).includes(reqRisk ?? '')
    ? (reqRisk as RiskLevel)
    : 'balanced';

  // Optional ?dg=<draftGroupId> to try a DraftKings slate before it's saved in admin.
  const dgOverride = param(sp, 'dg') ?? null;

  const [data, performance] = await Promise.all([
    getBuilderData(season, week, risk, dgOverride),
    getModelPerformance(season.id),
  ]);
  const salary = data.salary;
  const model = MODEL_REGISTRY[risk];
  const money = (n: number) => `$${n.toLocaleString('en-US')}`;

  const controls = (
    <LineupBuilderControls
      seasons={seasons.map((s) => ({ id: s.id, name: s.name }))}
      selectedSeasonId={season.id}
      weeks={season.regularSeasonWeeks}
      selectedWeek={week}
      risks={RISK_OPTIONS}
      selectedRisk={risk}
    />
  );

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow={`${season.name} · Week ${week}`}
        title="Lineup Builder"
        description="Pick a week and a risk level — get a DraftKings lineup shortlist built from live, free public signals."
        actions={backLink}
      />

      <Card>
        <CardBody>{controls}</CardBody>
      </Card>

      {/* Risk explainer + honest-signal note */}
      <Card>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Info className="size-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-foreground">
                {model.codename} <span className="text-subtle">v{model.version}</span>
              </p>
              <Badge variant="neutral" title="Hand-weighted heuristic model — will graduate to a trained model once a season of results is collected.">
                {model.stage}
              </Badge>
              <span className="text-sm text-muted">· {data.riskMeta.label} — {data.riskMeta.tagline}</span>
            </div>
            <p className="text-sm text-muted">{data.riskMeta.description}</p>
            <p className="text-xs text-subtle">
              Built from free public sources — Sleeper consensus ranks, waiver add/drop trends and
              injury tags, plus the NFL schedule. These reflect availability &amp; momentum, not
              precise point projections{salary.enabled ? '' : ' or DraftKings salaries'}, so treat
              it as a smart shortlist{salary.enabled ? '.' : ' to pair with DK’s salary view.'}
            </p>
          </div>
        </CardBody>
      </Card>

      {/* Salary / cap status */}
      <Card className={salary.enabled ? 'border-accent/30' : undefined}>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
              salary.enabled ? 'bg-win-soft text-win' : 'bg-surface text-subtle'
            }`}
          >
            <CircleDollarSign className="size-5" aria-hidden="true" />
          </span>
          {salary.enabled ? (
            <div className="flex flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                <p className="text-sm font-semibold text-foreground">
                  Salary-cap optimized · DraftKings Classic
                </p>
                <span className="text-sm tabular-nums text-muted">
                  <span className="font-semibold text-foreground">{money(salary.totalSalary)}</span>{' '}
                  / {money(salary.salaryCap)} ·{' '}
                  <span className={salary.remaining >= 0 ? 'text-win' : 'text-loss'}>
                    {money(salary.remaining)} left
                  </span>
                </span>
              </div>
              <p className="text-xs text-subtle">
                The suggested lineup is a valid roster under the {money(salary.salaryCap)} cap,
                maximizing model fit. Salaries pulled live from the DraftKings slate
                {salary.source === 'auto'
                  ? ' (auto-detected main NFL slate)'
                  : salary.source === 'admin'
                    ? ' (pinned in Admin → Slates)'
                    : ' (via ?dg= override)'}{' '}
                · draft group {salary.draftGroupId} · matched {salary.matched}/{salary.matchTotal}{' '}
                players.
                {!salary.feasible
                  ? ' ⚠️ Not enough cheap options on this slate to fill every slot under the cap — showing the closest valid attempt.'
                  : ''}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-semibold text-foreground">Salary-cap optimization is off</p>
              <p className="text-sm text-muted">
                We auto-detect DraftKings&apos; main NFL slate for the live week, but there&apos;s no
                slate to optimize against right now (the offseason gap, or a week that isn&apos;t the
                current one). The lineup below is a best-plays shortlist, not yet a cap-valid{' '}
                {money(DK_CLASSIC_SALARY_CAP)} roster.
              </p>
              <p className="text-xs text-subtle">
                To force one now: pin a draft group in <strong>Admin → Slates</strong>, or append{' '}
                <code className="rounded bg-surface px-1">?dg=&lt;id&gt;</code> to this URL.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      {!data.signalsAvailable ? (
        <EmptyState
          icon={Sparkles}
          title="Player signals are temporarily unavailable"
          description="The free Sleeper/ESPN feeds didn't respond just now. They reload automatically — try again in a moment."
        />
      ) : data.gameCount === 0 ? (
        <EmptyState
          icon={CalendarOff}
          title={`No NFL schedule for Week ${week}`}
          description="The schedule for this week hasn't been synced yet. Pick another week, or pull the schedule from the commissioner panel."
        />
      ) : (
        <>
          {/* Suggested lineup */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <ListChecks className="size-5" aria-hidden="true" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <CardTitle>Suggested lineup</CardTitle>
                  <CardDescription>
                    A full DraftKings Classic roster (QB · RB · RB · WR · WR · WR · TE · FLEX · DST)
                    for the {data.riskMeta.label.toLowerCase()} profile
                    {salary.enabled
                      ? ` — optimized under the ${money(salary.salaryCap)} cap (${money(salary.totalSalary)} used).`
                      : ', filled by best fit.'}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardBody className="flex flex-col divide-y divide-border">
              {data.lineup.map((s, i) =>
                s.pick ? (
                  <PlayerCard key={`${s.slot}-${i}`} data={s.pick} slotLabel={s.slot} showFit />
                ) : (
                  <div key={`${s.slot}-${i}`} className="flex items-center gap-3 py-2">
                    <span className="w-10 shrink-0 text-center text-[11px] font-bold uppercase tracking-wide text-subtle">
                      {s.slot}
                    </span>
                    <span className="text-sm text-subtle">No eligible player this week</span>
                  </div>
                ),
              )}
            </CardBody>
          </Card>

          {/* Targets by position */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-accent" aria-hidden="true" />
              <h2 className="text-lg font-bold tracking-tight text-foreground">More targets by position</h2>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              {data.targetsByPosition.map((group) => (
                <Card key={group.position} className="min-w-0">
                  <CardHeader>
                    <CardTitle>{group.label}</CardTitle>
                  </CardHeader>
                  <CardBody className="flex flex-col divide-y divide-border pt-0">
                    {group.players.map((p) => (
                      <PlayerCard key={p.id} data={p} showFit />
                    ))}
                  </CardBody>
                </Card>
              ))}
            </div>
          </section>

          {/* Fades + byes */}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-loss-soft text-loss">
                    <AlertTriangle className="size-5" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <CardTitle>Fade this week</CardTitle>
                    <CardDescription>Notable names who are hurt, dropped, or on bye.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="flex flex-col divide-y divide-border pt-0">
                {data.fades.length ? (
                  data.fades.map((p) => <PlayerCard key={p.id} data={p} />)
                ) : (
                  <p className="py-3 text-sm text-muted">No notable fades this week.</p>
                )}
              </CardBody>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-subtle">
                    <CalendarOff className="size-5" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <CardTitle>On bye — Week {week}</CardTitle>
                    <CardDescription>These teams don&apos;t play; their players are excluded.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardBody>
                {data.byeTeams.length ? (
                  <div className="flex flex-wrap gap-2">
                    {data.byeTeams.map((key) => (
                      <span
                        key={key}
                        className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-semibold tabular-nums text-muted"
                      >
                        {key}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted">No teams on bye this week.</p>
                )}
              </CardBody>
            </Card>
          </div>
        </>
      )}

      {/* Model performance — accumulates as weeks are graded against actual results */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Trophy className="size-5" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-0.5">
              <CardTitle>Model performance</CardTitle>
              <CardDescription>
                How each model&apos;s lineups actually scored, graded against real player results.
                These are versioned <strong>heuristic</strong> models today; once a season of results
                is collected they&apos;ll be trained on that data and graduate to <strong>v1.0</strong>.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          {performance.every((m) => m.weeksGraded === 0) ? (
            <p className="text-sm text-muted">
              No graded weeks yet — tracking begins once the season&apos;s slates go live and a week is
              snapshotted &amp; graded (Admin → Models). Each model&apos;s actual results will show here.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              {performance.map((m) => (
                <div key={m.risk} className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {m.codename} <span className="text-subtle">v{m.version}</span>
                    </span>
                    <Badge variant={m.stage === 'trained' ? 'accent' : 'neutral'}>{m.stage}</Badge>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">
                    {m.avgActual == null ? '—' : m.avgActual.toFixed(1)}
                    <span className="ml-1 text-sm font-normal text-subtle">avg pts</span>
                  </span>
                  <span className="text-xs text-muted">
                    {m.weeksGraded} week{m.weeksGraded === 1 ? '' : 's'} graded
                    {m.avgOptimalPct != null ? ` · ${m.avgOptimalPct.toFixed(0)}% of optimal` : ''}
                    {m.avgVsChalk != null
                      ? ` · ${m.avgVsChalk >= 0 ? '+' : ''}${m.avgVsChalk.toFixed(1)} vs chalk`
                      : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </Container>
  );
}
