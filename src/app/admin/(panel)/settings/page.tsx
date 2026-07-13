import type { Metadata } from 'next';

import { Card } from '@/components/card';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/badge';
import { requireAdmin } from '@/lib/auth-helpers';
import { getCurrentSeason } from '@/lib/season';
import { getSeasonRules } from '@/lib/rules/schema';
import { formatMoney } from '@/lib/utils';

import { SeasonMetaForm, SeasonRulesForm } from './settings-forms';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIEBREAKER_LABELS: Record<string, string> = {
  h2h: 'Head-to-head',
  pf: 'Points for',
  pa: 'Points against',
};

const PLAYOFF_TIEBREAKER_LABELS: Record<string, string> = {
  regular_season_pf: 'Regular-season points for',
  higher_seed: 'Higher seed',
};

const MISSED_RESULT_LABELS: Record<string, string> = {
  auto_loss: 'Automatic loss',
  none: 'None',
};

const MISSED_OPP_LABELS: Record<string, string> = {
  league_average: 'League average',
  league_median: 'League median',
  zero: 'Zero',
  actual: 'Actual',
};

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  await requireAdmin();

  const season = await getCurrentSeason();

  if (!season) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow="Admin"
          title="Settings"
          description="Per-season league rules and season meta."
        />
        <Card>
          <div className="p-5 text-sm text-muted">
            No season found — seed one to begin editing settings.
          </div>
        </Card>
      </div>
    );
  }

  const rules = getSeasonRules(season.rules);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Settings"
        description={`${season.name} · per-season league rules and season meta.`}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <SeasonMetaForm
            defaults={{
              seasonId: season.id,
              name: season.name,
              status: season.status,
              currentWeek: season.currentWeek,
              regularSeasonWeeks: season.regularSeasonWeeks,
              entryFeeCents: season.entryFeeCents,
            }}
          />
        </Card>

        <Card>
          <SeasonRulesForm seasonId={season.id} rules={rules} />
        </Card>
      </div>

      <Card>
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              Effective rules
            </h2>
            <Badge variant={season.rules ? 'accent' : 'neutral'}>
              {season.rules ? 'Customized' : 'Using defaults'}
            </Badge>
          </div>
          <p className="text-xs text-muted">
            Read-only summary of the rules in effect for {season.name}. Rules are per-season and
            inherit the league defaults until changed above.
          </p>

          <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
                Format
              </h3>
              <dl className="divide-y divide-border">
                <SummaryRow label="Regular-season weeks" value={rules.regularSeasonWeeks} />
                <SummaryRow
                  label="Tiebreakers"
                  value={rules.tiebreakers.map((t) => TIEBREAKER_LABELS[t]).join(' → ')}
                />
                <SummaryRow label="Entry fee" value={formatMoney(season.entryFeeCents)} />
              </dl>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
                Playoffs
              </h3>
              <dl className="divide-y divide-border">
                <SummaryRow label="Teams / conference" value={rules.playoffs.teamsPerConference} />
                <SummaryRow
                  label="Division winners / conf."
                  value={rules.playoffs.divisionWinnersPerConference}
                />
                <SummaryRow
                  label="Wild cards / conf."
                  value={rules.playoffs.wildCardsPerConference}
                />
                <SummaryRow label="Top-seed byes" value={rules.playoffs.topSeedByes} />
                <SummaryRow
                  label="Matchup tiebreaker"
                  value={PLAYOFF_TIEBREAKER_LABELS[rules.playoffs.tieBreaker]}
                />
              </dl>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
                Bye & missed lineup
              </h3>
              <dl className="divide-y divide-border">
                <SummaryRow
                  label="Bye counts toward PF"
                  value={rules.byeWeek.countsTowardPointsFor ? 'Yes' : 'No'}
                />
                <SummaryRow
                  label="Bye eligible for weekly high"
                  value={rules.byeWeek.eligibleForWeeklyHigh ? 'Yes' : 'No'}
                />
                <SummaryRow
                  label="Missed lineup result"
                  value={MISSED_RESULT_LABELS[rules.missedLineup.result]}
                />
                <SummaryRow
                  label="Opponent scores"
                  value={MISSED_OPP_LABELS[rules.missedLineup.opponentScores]}
                />
              </dl>
            </section>

            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-subtle">
                Payouts
              </h3>
              <dl className="divide-y divide-border">
                <SummaryRow
                  label={`Weekly high (×${rules.payouts.weeklyHighWeeks})`}
                  value={formatMoney(rules.payouts.weeklyHighCents)}
                />
                <SummaryRow label="Season high" value={formatMoney(rules.payouts.seasonHighCents)} />
                <SummaryRow
                  label="Most reg.-season points"
                  value={formatMoney(rules.payouts.mostRegularSeasonPointsCents)}
                />
                <SummaryRow label="Champion" value={formatMoney(rules.payouts.championCents)} />
                <SummaryRow label="Runner-up" value={formatMoney(rules.payouts.runnerUpCents)} />
                <SummaryRow label="Third" value={formatMoney(rules.payouts.thirdCents)} />
                <SummaryRow label="Fourth" value={formatMoney(rules.payouts.fourthCents)} />
              </dl>
            </section>
          </div>
        </div>
      </Card>
    </div>
  );
}
