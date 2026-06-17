/**
 * Rules — Server Component. Renders the CURRENT season's league rules, driven live
 * by the per-season settings the commissioner edits in /admin/settings (stored in
 * `seasons.rules` and resolved through `getSeasonRules`). Configurable values —
 * tiebreakers, playoff field, bye-week handling, missed-lineup penalties, and the
 * full payout table — update here automatically when Settings change. Narrative
 * sections (format/scoring, DraftKings entry name) describe league structure the
 * schema does not model and are intentionally static.
 */
import type { Metadata } from "next";
import {
  AlertTriangle,
  CalendarDays,
  CalendarOff,
  CircleDollarSign,
  Coins,
  ListChecks,
  type LucideIcon,
  Medal,
  Scale,
  Tag,
  Ticket,
  Trophy,
} from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";
import { getCurrentSeason } from "@/lib/season";
import { getSeasonRules, DEFAULT_SEASON_RULES, type SeasonRules } from "@/lib/rules/schema";
import { formatMoney } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Rules",
  description:
    "KeyLehr H2H league rules — scoring, tiebreakers, missed-lineup penalties, bye-week handling, DraftKings entry-name requirements, the playoff format, and the payout structure for the current season.",
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* -------------------------------------------------------------------------- */
/* Human-readable labels for the enum-style rule values.                      */
/* -------------------------------------------------------------------------- */

const TIEBREAKERS: Record<
  SeasonRules["tiebreakers"][number],
  { label: string; desc: string }
> = {
  h2h: {
    label: "Head-to-head record",
    desc: "Record in games played between the tied owners.",
  },
  pf: { label: "Points For", desc: "Total fantasy points scored — higher wins." },
  pa: { label: "Points Against", desc: "Total fantasy points allowed — higher wins." },
};

const PLAYOFF_TIE: Record<SeasonRules["playoffs"]["tieBreaker"], string> = {
  regular_season_pf: "regular-season Points For",
  higher_seed: "the higher seed",
};

const MISSED_RESULT: Record<SeasonRules["missedLineup"]["result"], string> = {
  auto_loss: "an automatic loss for that week",
  none: "no automatic penalty",
};

const MISSED_OPPONENT: Record<SeasonRules["missedLineup"]["opponentScores"], string> = {
  league_average: "the league-average score for that week",
  zero: "zero points",
  actual: "their own actual points",
};

/* -------------------------------------------------------------------------- */
/* Small presentational helpers.                                              */
/* -------------------------------------------------------------------------- */

/** A headline metric in the summary band. */
function Metric({
  icon: Icon,
  value,
  label,
  hint,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 p-5">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        {label}
      </span>
      <span className="text-2xl font-bold tracking-tight text-foreground">{value}</span>
      <span className="text-xs text-muted">{hint}</span>
    </div>
  );
}

/** A rule section card with an icon header and a bulleted body. */
function RuleCard({
  id,
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card id={id} className={className}>
      <CardHeader>
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-0.5">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardBody>{children}</CardBody>
    </Card>
  );
}

/** An unordered list of rule statements with accent bullets. */
function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm text-muted">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** One prize line: label (+ optional sub-note) on the left, amount on the right. */
function PrizeRow({
  rank,
  label,
  sub,
  amount,
  emphasize,
}: {
  rank?: string;
  label: string;
  sub?: string;
  amount: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        {rank ? (
          <span
            className={
              "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums " +
              (emphasize ? "bg-accent text-accent-fg" : "bg-surface text-subtle")
            }
            aria-hidden="true"
          >
            {rank}
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col">
          <span className={emphasize ? "font-semibold text-foreground" : "font-medium text-foreground"}>
            {label}
          </span>
          {sub ? <span className="text-xs text-muted">{sub}</span> : null}
        </div>
      </div>
      <span className="shrink-0 tabular-nums font-semibold text-foreground">{amount}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default async function RulesPage() {
  const season = await getCurrentSeason();
  const rules = season ? getSeasonRules(season.rules) : DEFAULT_SEASON_RULES;

  // The entry fee the commissioner edits lives on the season row; fall back to the
  // rules payout mirror (then the default) when there is no season yet.
  const entryFeeCents = season?.entryFeeCents ?? rules.payouts.entryFeeCents;

  // Weeks come from the season column — that is the value the scoring/standings
  // engine actually uses (the rules JSONB mirror is editable separately).
  const weeks = season?.regularSeasonWeeks ?? rules.regularSeasonWeeks;

  const p = rules.payouts;
  const weeklyHighTotalCents = p.weeklyHighCents * p.weeklyHighWeeks;
  const totalPrizePoolCents =
    p.championCents +
    p.runnerUpCents +
    p.thirdCents +
    p.fourthCents +
    p.mostRegularSeasonPointsCents +
    p.seasonHighCents +
    weeklyHighTotalCents;

  const playoffTeams = rules.playoffs.teamsPerConference * 2;
  const byes = rules.playoffs.topSeedByes;

  const seasonLabel = season?.name ?? "Current season";

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow={`${seasonLabel} rules`}
        title="League Rules"
        description="How KeyLehr H2H is played and paid out this season. These rules are configured per season by the commissioner — change them in Settings and this page updates automatically."
      />

      {/* Summary band — the at-a-glance shape of the season. */}
      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-y divide-border lg:grid-cols-4 lg:divide-y-0">
          <Metric
            icon={CalendarDays}
            value={String(weeks)}
            label="Regular season"
            hint={`${weeks}-week head-to-head schedule`}
          />
          <Metric
            icon={Trophy}
            value={String(playoffTeams)}
            label="Playoff field"
            hint={`${rules.playoffs.teamsPerConference} seeds per conference`}
          />
          <Metric
            icon={Ticket}
            value={formatMoney(entryFeeCents)}
            label="Entry fee"
            hint="Per owner, per season"
          />
          <Metric
            icon={Coins}
            value={formatMoney(totalPrizePoolCents)}
            label="Prize pool"
            hint="Total payouts across the season"
          />
        </div>
      </Card>

      {/* Rule sections. */}
      <div className="grid gap-6 md:grid-cols-2">
        <RuleCard
          id="format"
          icon={ListChecks}
          title="Format & scoring"
          description="How a week is played and scored."
        >
          <Bullets
            items={[
              "32 owners, one season. Each owner is assigned exactly one NFL team and plays that team's real NFL schedule.",
              "Weekly scoring is DFS, not the NFL game. Your weekly score is the fantasy points of your DraftKings lineup — the NFL schedule only decides who you face.",
              "Head-to-head: if your NFL team plays another owner's NFL team that week, you face that owner. Higher DraftKings points wins the matchup.",
              <>
                Records are tracked as W-L-T with Points For and Points Against. The regular
                season runs <strong className="font-semibold text-foreground">{weeks} weeks</strong>.
              </>,
            ]}
          />
        </RuleCard>

        <RuleCard
          id="tiebreakers"
          icon={Scale}
          title="Standings tiebreakers"
          description="Applied in order when records are level."
        >
          <ol className="flex flex-col gap-3">
            {rules.tiebreakers.map((key, i) => (
              <li key={key} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold tabular-nums text-accent"
                >
                  {i + 1}
                </span>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{TIEBREAKERS[key].label}</span>
                  <span className="text-xs text-muted">{TIEBREAKERS[key].desc}</span>
                </div>
              </li>
            ))}
          </ol>
        </RuleCard>

        <RuleCard
          id="missed-lineup"
          icon={AlertTriangle}
          title="Missed lineups"
          description="Failing to submit a valid DraftKings lineup."
        >
          <Bullets
            items={[
              <>
                An owner who fails to submit a valid lineup takes{" "}
                <strong className="font-semibold text-foreground">{MISSED_RESULT[rules.missedLineup.result]}</strong>.
              </>,
              <>
                Their opponent is credited with{" "}
                <strong className="font-semibold text-foreground">
                  {MISSED_OPPONENT[rules.missedLineup.opponentScores]}
                </strong>{" "}
                (rather than their own actual points).
              </>,
            ]}
          />
        </RuleCard>

        <RuleCard
          id="bye-week"
          icon={CalendarOff}
          title="Bye weeks"
          description="When your NFL team is idle."
        >
          <Bullets
            items={[
              "If your assigned NFL team is on a bye, you have no head-to-head matchup that week.",
              <>
                Bye-week points{" "}
                <strong className="font-semibold text-foreground">
                  {rules.byeWeek.countsTowardPointsFor ? "count" : "do not count"}
                </strong>{" "}
                toward your Points For total.
              </>,
              <>
                Bye-week scores{" "}
                <strong className="font-semibold text-foreground">
                  {rules.byeWeek.eligibleForWeeklyHigh ? "are" : "are not"}
                </strong>{" "}
                eligible for the weekly high-score prize.
              </>,
            ]}
          />
        </RuleCard>

        <RuleCard
          id="dk-entry"
          icon={Tag}
          title="DraftKings entry name"
          description="How your scores are matched to you."
        >
          <Bullets
            items={[
              "Each owner locks a DraftKings entry name for the season. The weekly contest leaderboard is matched to owners by that exact entry name.",
              "Use your locked entry name consistently every week so your scores import correctly.",
            ]}
          />
        </RuleCard>

        <RuleCard
          id="playoffs"
          icon={Trophy}
          title="Playoff format"
          description="NFL-style postseason."
        >
          <Bullets
            items={[
              <>
                <strong className="font-semibold text-foreground">{rules.playoffs.teamsPerConference} seeds</strong>{" "}
                per conference: {rules.playoffs.divisionWinnersPerConference} division winners plus{" "}
                {rules.playoffs.wildCardsPerConference} wild cards.
              </>,
              byes > 0 ? (
                <>
                  The top {byes === 1 ? "seed" : `${byes} seeds`} in each conference{" "}
                  earn{byes === 1 ? "s" : ""} a first-round bye.
                </>
              ) : (
                "No first-round byes — every seed plays in the first round."
              ),
              "The bracket reseeds each round (highest remaining seed plays lowest), mirroring the NFL.",
              <>Playoff-matchup ties are broken by {PLAYOFF_TIE[rules.playoffs.tieBreaker]}.</>,
            ]}
          />
        </RuleCard>
      </div>

      {/* Payouts — the featured, full-width prize table. */}
      <Card id="payouts">
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <CircleDollarSign className="size-5" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-0.5">
              <CardTitle>Payouts</CardTitle>
              <CardDescription>
                Entry fee {formatMoney(entryFeeCents)} per owner · {formatMoney(totalPrizePoolCents)} paid out.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-6">
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
            {/* Final standings prizes. */}
            <div className="flex flex-col gap-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Medal className="size-4 text-accent" aria-hidden="true" /> Final standings
              </h3>
              <div className="divide-y divide-border">
                <PrizeRow rank="1" label="Champion" amount={formatMoney(p.championCents)} emphasize />
                <PrizeRow rank="2" label="Runner-up" amount={formatMoney(p.runnerUpCents)} />
                <PrizeRow rank="3" label="Third place" amount={formatMoney(p.thirdCents)} />
                <PrizeRow rank="4" label="Fourth place" amount={formatMoney(p.fourthCents)} />
              </div>
            </div>

            {/* Season-long & weekly awards. */}
            <div className="flex flex-col gap-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Coins className="size-4 text-accent" aria-hidden="true" /> Season &amp; weekly awards
              </h3>
              <div className="divide-y divide-border">
                <PrizeRow
                  label="Most regular-season points"
                  amount={formatMoney(p.mostRegularSeasonPointsCents)}
                />
                <PrizeRow
                  label="Weekly high score"
                  sub={`${formatMoney(p.weeklyHighCents)} × ${p.weeklyHighWeeks} weeks`}
                  amount={formatMoney(weeklyHighTotalCents)}
                />
                <PrizeRow label="Season high score" amount={formatMoney(p.seasonHighCents)} />
              </div>
            </div>
          </div>

          {/* Total purse. */}
          <div className="flex items-center justify-between gap-3 rounded-lg border border-accent/30 bg-accent/5 px-4 py-3">
            <span className="text-sm font-semibold text-foreground">Total prize pool</span>
            <span className="text-lg font-bold tabular-nums text-accent">
              {formatMoney(totalPrizePoolCents)}
            </span>
          </div>
        </CardBody>
      </Card>

      <p className="text-xs text-subtle">
        Rules are configured per season and operated by KeyLehr Gaming Ventures. The figures above
        reflect the settings in effect for {seasonLabel}.
      </p>
    </Container>
  );
}
