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
  Shield,
  Ticket,
  Trophy,
  Zap,
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
  pa: { label: "Points Against", desc: "Total fantasy points allowed — lower wins." },
};

const PLAYOFF_TIE: Record<SeasonRules["playoffs"]["tieBreaker"], string> = {
  regular_season_pf: "regular-season Points For",
  higher_seed: "the higher seed",
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

/** A single tiebreaker scenario: label, situation description, and outcome. */
function ExampleBlock({
  label,
  scenario,
  outcome,
}: {
  label: string;
  scenario: string;
  outcome: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-surface p-3">
      <p className="text-xs font-semibold text-foreground">{label}</p>
      <p className="text-xs text-muted">{scenario}</p>
      <p className="text-xs font-medium text-accent">→ {outcome}</p>
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
        description="How KeyLehr H2H is played and paid out this season."
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
              "32 owners, one season. Each owner is assigned exactly one NFL team — assignments are made randomly by the commissioners before the season begins.",
              "Teams and divisions follow the real NFL: AFC and NFC, each split into East, North, South, and West. Your schedule is your team's actual NFL schedule.",
              "Your weekly score is the fantasy points of your DraftKings lineup — the NFL schedule only decides who you face.",
              "Head-to-head: if your NFL team plays another owner's NFL team that week, you face that owner. Higher DraftKings points wins the matchup; identical scores result in a tie.",
              <>
                Records are tracked as W-L-T with Points For and Points Against. The regular
                season runs <strong className="font-semibold text-foreground">{weeks} weeks</strong>.
              </>,
            ]}
          />
        </RuleCard>

        <RuleCard
          id="missed-lineup"
          icon={AlertTriangle}
          title="Missed lineups"
          description="What happens when you miss a lineup."
        >
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Whether it's your first or second incident, your opponent scores against the{" "}
              <strong className="font-semibold text-foreground">weekly median</strong> — the median score among all owners with an active matchup that week, excluding forfeits and bye weeks.
            </p>
            <div className="flex flex-col gap-1.5 rounded-lg bg-surface p-3">
              <p className="text-xs font-semibold text-foreground">1st incident</p>
              <ul className="flex flex-col gap-1.5 text-xs text-muted">
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>$25 fine</span>
                </li>
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>Automatic loss for that week</span>
                </li>
              </ul>
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg bg-surface p-3">
              <p className="text-xs font-semibold text-foreground">2nd incident</p>
              <ul className="flex flex-col gap-1.5 text-xs text-muted">
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>Additional $25 fine ($50 total)</span>
                </li>
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>Remainder of year suspension with automatic losses for all remaining games</span>
                </li>
                <li className="flex gap-2">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>Possible ban from all future KeyLehr Gaming Ventures leagues</span>
                </li>
              </ul>
            </div>
          </div>
        </RuleCard>

        <RuleCard
          id="dk"
          icon={Zap}
          title="DraftKings"
          description="Scoring format and entry name requirements."
          className="md:col-span-2"
        >
          <div className="grid gap-x-10 gap-y-6 md:grid-cols-2">
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Scoring format</p>
              <Bullets
                items={[
                  <>
                    Every week uses{" "}
                    <a
                      href="https://www.draftkings.com/help/rules/1"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      DraftKings Classic NFL scoring
                    </a>
                    {" "}— except the Super Bowl, which uses{" "}
                    <a
                      href="https://www.draftkings.com/help/rules/1/96"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      Showdown Captain Mode
                    </a>
                    {" "}(a single-game format with a Captain slot that scores 1.5× points) — click each for full scoring and lineup details.
                  </>,
                  "Scores follow DraftKings official results. If DraftKings issues a stat correction after initial scoring, the corrected score is honored.",
                ]}
              />
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Lineup &amp; entry name</p>
              <Bullets
                items={[
                  "You must submit an initial lineup before the first game kickoff of the NFL week. Individual player slots can be swapped up until that player's own game kickoff.",
                  "Each owner locks a DraftKings entry name for the season. The weekly contest leaderboard is matched to owners by that exact entry name.",
                  "Submitting under a different name is not treated as a missed lineup, but your score will not import — you are responsible for using the correct name each week.",
                ]}
              />
            </div>
          </div>
        </RuleCard>

        <RuleCard
          id="tiebreakers"
          icon={Scale}
          title="Standings tiebreakers"
          description="Applied in order when records are level."
          className="md:col-span-2"
        >
          <div className="flex flex-col gap-5">
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

            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Divisional tiebreakers</p>
              <p className="text-sm text-muted">
                When tied owners share a division, divisional tiebreakers (using the order above) are resolved first
                to determine the division winner. The remaining tied owners then re-enter a separate wild-card tiebreaker.
              </p>
            </div>

            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-subtle">Multi-team H2H examples</p>
              <p className="text-sm text-muted">
                For H2H to decide a multi-team tie, one owner must hold a winning series against{" "}
                <strong className="font-semibold text-foreground">every</strong> other tied owner. A single series
                loss eliminates the H2H advantage — the tie then falls to Points For.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <ExampleBlock
                  label="Ex 1 — 3-way tie, undefeated winner"
                  scenario="Colts, Dolphins, and Broncos all finish 9-8. Colts beat both Dolphins and Broncos; Dolphins and Broncos never played each other."
                  outcome="Colts advance via H2H (2–0 vs. the group)."
                />
                <ExampleBlock
                  label="Ex 2 — 3-way tie, no undefeated winner"
                  scenario="Colts, Dolphins, and Broncos all finish 9-8. Colts beat Dolphins but lost to Broncos; Dolphins and Broncos never played."
                  outcome="No owner is undefeated — falls to Points For."
                />
                <ExampleBlock
                  label="Ex 3 — 4-way tie, no undefeated winner"
                  scenario="Colts, Dolphins, Broncos, and Bengals all finish 9-8. Colts beat Dolphins and Broncos but lost to Bengals; Dolphins beat Bengals."
                  outcome="No owner is undefeated — falls to Points For."
                />
                <ExampleBlock
                  label="Ex 4 — 4-way tie, two spots available"
                  scenario="Using Ex 3 facts with two wild-card spots open. No undefeated owner — Points For gives spot 1 to the Bengals. The tiebreaker restarts for Colts, Dolphins, and Broncos. Within this sub-group, Colts beat both and are 2–0."
                  outcome="Bengals take spot 1 via Points For. Colts take spot 2 via H2H after the restart."
                />
                <ExampleBlock
                  label="Ex 5 — 5-way tie, 3-1 is not enough"
                  scenario="Five teams tied. Team 1 went 3-1 vs. the group (one loss). No team is 4-0 against the others."
                  outcome="3-1 does not qualify as undefeated — falls to Points For. One loss eliminates H2H regardless of group size."
                />
              </div>
            </div>
          </div>
        </RuleCard>

        <RuleCard
          id="bye-week"
          icon={CalendarOff}
          title="Bye weeks"
          description="When your NFL team is idle."
        >
          <Bullets
            items={[
              "If your assigned NFL team is on a bye, you have no head-to-head matchup that week and do not need to submit a DraftKings lineup.",
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
          id="playoffs"
          icon={Trophy}
          title="Playoff format"
          description="Seeding, byes, and bracket structure."
        >

          <Bullets
            items={[
              <>
                {rules.playoffs.teamsPerConference} seeds per conference:{" "}
                {rules.playoffs.divisionWinnersPerConference} division winners plus{" "}
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
              "The bracket reseeds each round — the best remaining seed plays the worst remaining seed — mirroring the NFL.",
              <>Playoff-matchup ties are broken by {PLAYOFF_TIE[rules.playoffs.tieBreaker]}.</>,
            ]}
          />
        </RuleCard>

        <RuleCard
          id="commissioner"
          icon={Shield}
          title="Commissioner"
          description="Authority, integrity, and dispute resolution."
          className="md:col-span-2"
        >
          <Bullets
            items={[
              "The commissioners have final say on any situation not explicitly covered by these rules. Decisions will be made in the best interest of the league.",
              "Owners may not deliberately submit a weak lineup or otherwise underperform to benefit another owner's standing or seeding. Suspected collusion is subject to commissioner review and may result in matchup forfeiture, prize ineligibility, or removal from the league.",
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
                Entry fee {formatMoney(entryFeeCents)} per owner* · {formatMoney(totalPrizePoolCents)} paid out.
              </CardDescription>
              <p className="text-xs text-muted pt-0.5">
                Pay via Venmo:{" "}
                <a
                  href="https://venmo.com/u/joshua-lehr-2"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  @joshua-lehr-2
                </a>
                {" "}or{" "}
                <a
                  href="https://venmo.com/u/ryan-kealy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent underline-offset-2 hover:underline"
                >
                  @ryan-kealy
                </a>
              </p>
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
                  sub={`${formatMoney(p.weeklyHighCents)} × ${p.weeklyHighWeeks} weeks · bye weeks ineligible`}
                  amount={formatMoney(weeklyHighTotalCents)}
                />
                <PrizeRow label="Season high score" sub="Best single-week score across the entire regular season — can stack with that week's weekly high prize" amount={formatMoney(p.seasonHighCents)} />
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

          <p className="text-xs text-subtle">
            * {formatMoney(500)} per owner is allocated to KeyLehr Gaming Ventures to offset operational expenses, including platform technology and league trophy costs.
          </p>
        </CardBody>
      </Card>

    </Container>
  );
}
