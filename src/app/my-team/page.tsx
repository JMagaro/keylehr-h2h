/**
 * My Team — per-team analytics dashboard. Public "browse any team" view: pick a
 * season and a team and see that team's record, scoring trends, schedule/results,
 * head-to-head record, and playoff-odds trend. All numbers come from the same
 * engine the standings pages use (see src/lib/team/query.ts).
 */
import type { Metadata } from "next";
import {
  AlertTriangle,
  CalendarDays,
  Flame,
  Gauge,
  LineChart,
  Target,
  TrendingUp,
  Trophy,
  UserRound,
} from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { TeamLogo } from "@/components/team-logo";
import { StatTile } from "@/components/stat-tile";
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import { SeasonSelector } from "@/components/season-selector";
import { TeamSelector } from "@/components/team-selector";
import { WeeklyScoresChart, TrendLineChart, type TrendPoint } from "@/components/team-charts";
import { ExpandableChart } from "@/components/expandable-chart";
import {
  getSeasonOptions,
  getDefaultStandingsSeasonId,
} from "@/lib/standings/query";
import { getTeamDirectory, getTeamDashboard } from "@/lib/team/query";
import { formatPoints } from "@/lib/utils";

export const metadata: Metadata = {
  title: "My Team",
  description:
    "Per-team dashboard for KeyLehr H2H — weekly DraftKings scores vs the league, rank over time, schedule & results, head-to-head records, and playoff-odds trend for any team.",
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function MyTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  const reqSeason = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const reqSeasonId = reqSeason ? Number(reqSeason) : NaN;
  const validSeason = !Number.isNaN(reqSeasonId) && seasons.some((s) => s.id === reqSeasonId);
  const defaultSeasonId = await getDefaultStandingsSeasonId();
  const seasonId = validSeason ? reqSeasonId : (defaultSeasonId ?? seasons[0]?.id);
  const season = seasons.find((s) => s.id === seasonId) ?? null;

  const directory = seasonId !== undefined ? await getTeamDirectory(seasonId) : [];

  const reqTeam = Array.isArray(sp.team) ? sp.team[0] : sp.team;
  const reqTeamId = reqTeam ? Number(reqTeam) : NaN;
  const validTeam = !Number.isNaN(reqTeamId) && directory.some((t) => t.ownerSeasonId === reqTeamId);
  const teamId = validTeam ? reqTeamId : directory[0]?.ownerSeasonId;

  const dashboard =
    seasonId !== undefined && teamId !== undefined
      ? await getTeamDashboard(seasonId, teamId)
      : null;

  const selectors = (
    <div className="flex flex-wrap items-center gap-3">
      {seasonId !== undefined ? <SeasonSelector seasons={seasons} selectedId={seasonId} /> : null}
      {directory.length > 0 && teamId !== undefined ? (
        <TeamSelector teams={directory} selectedId={teamId} seasonId={seasonId!} />
      ) : null}
    </div>
  );

  if (!dashboard) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
        <PageHeader
          eyebrow={season?.name ?? "My Team"}
          title="My Team"
          description="Pick a team to see its weekly scores, trends, schedule, and head-to-head record."
          actions={selectors}
        />
        <EmptyState
          icon={UserRound}
          title="No team data for this season yet"
          description="This season has no owners or scored games yet. Pick another season above, or check back once weekly DraftKings scores begin posting."
        />
      </Container>
    );
  }

  const h = dashboard.header;
  const record = `${h.wins}-${h.losses}${h.ties ? `-${h.ties}` : ""}`;
  const tag = h.playoff;
  const teamCount = directory.length;

  const rankTrend: TrendPoint[] = dashboard.weeks.map((w) => ({ label: w.week, value: w.rank }));
  const oddsTrend: TrendPoint[] | null = dashboard.odds
    ? dashboard.odds.weeks.map((wk, i) => ({ label: wk, value: dashboard.odds!.series[i] }))
    : null;

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow={season?.name ?? "My Team"}
        title="My Team"
        description="Weekly scoring, trends, schedule, and results — for any team in the league."
        actions={selectors}
      />

      {/* Team identity banner */}
      <Card className="overflow-hidden">
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <TeamLogo src={h.logoEspn} alt={`${h.teamName} logo`} size={56} />
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h2 className="text-2xl font-bold tracking-tight text-foreground">
                  {h.teamKey} · {h.teamName}
                </h2>
                {tag ? (
                  <Badge variant={tag.kind === "bye" ? "bye" : tag.kind === "div" ? "div" : "wc"}>
                    {tag.kind === "bye" ? `#${tag.seed} · Bye` : tag.kind === "div" ? "Div" : `WC #${tag.seed}`}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm text-muted">
                {h.ownerName} · {h.conference} {h.division}
                {h.dkEntryName ? ` · DK: ${h.dkEntryName}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-6 sm:gap-8">
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-subtle">Record</span>
              <span className="flex items-center gap-2">
                <span className="text-xl font-bold tabular-nums text-foreground">{record}</span>
                {dashboard.stats.forfeits > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-loss-soft px-2 py-0.5 text-xs font-semibold text-loss"
                    title="Weeks this team missed its lineup (automatic loss)"
                  >
                    <AlertTriangle className="size-3" aria-hidden="true" />
                    {dashboard.stats.forfeits} {dashboard.stats.forfeits === 1 ? "forfeit" : "forfeits"}
                  </span>
                ) : null}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-subtle">Div rank</span>
              <span className="text-xl font-bold tabular-nums text-foreground">#{h.rank}</span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-subtle">Streak</span>
              <span className="text-xl font-bold tabular-nums text-foreground">{h.streak || "—"}</span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Points For"
          value={formatPoints(h.pointsFor)}
          hint={`${formatPoints(h.pointsAgainst)} against`}
          icon={Target}
        />
        <StatTile
          label="Avg / week"
          value={dashboard.stats.avgScore !== null ? formatPoints(dashboard.stats.avgScore) : "—"}
          hint={`${dashboard.stats.gamesPlayed} games`}
          icon={Gauge}
        />
        <StatTile
          label="Best week"
          value={dashboard.stats.bestWeek ? formatPoints(dashboard.stats.bestWeek.points) : "—"}
          hint={dashboard.stats.bestWeek ? `Week ${dashboard.stats.bestWeek.week}` : "—"}
          icon={Flame}
        />
        <StatTile
          label="Consistency"
          value={dashboard.stats.consistency !== null ? `±${formatPoints(dashboard.stats.consistency)}` : "—"}
          hint="Std-dev (lower = steadier)"
          icon={TrendingUp}
        />
      </div>

      {/* Weekly scoring chart */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <LineChart className="size-5" aria-hidden="true" />
            </span>
            <div className="flex flex-col gap-0.5">
              <CardTitle>Weekly scores vs. league average</CardTitle>
              <CardDescription>
                Each bar is this team&apos;s DraftKings points that week, colored by result; the
                dashed line is the league average.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <ExpandableChart title="Weekly scores vs. league average">
            <WeeklyScoresChart weeks={dashboard.weeks} />
          </ExpandableChart>
        </CardBody>
      </Card>

      {/* Rank + odds trends */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <TrendingUp className="size-5" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-0.5">
                <CardTitle>League rank over the season</CardTitle>
                <CardDescription>Overall standing through each week (1 = first).</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            <ExpandableChart title="League rank over the season">
              <TrendLineChart
                data={rankTrend}
                min={1}
                max={Math.max(teamCount, 2)}
                invert
                valuePrefix="#"
                seriesLabel="Rank"
                ariaLabel="League rank over the season"
              />
            </ExpandableChart>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Trophy className="size-5" aria-hidden="true" />
              </span>
              <div className="flex flex-col gap-0.5">
                <CardTitle>Playoff odds trend</CardTitle>
                <CardDescription>Monte-Carlo playoff probability by week.</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardBody>
            {oddsTrend ? (
              <ExpandableChart title="Playoff odds trend">
                <TrendLineChart
                  data={oddsTrend}
                  min={0}
                  max={100}
                  valueSuffix="%"
                  seriesLabel="Playoff odds"
                  ariaLabel="Playoff odds trend"
                />
              </ExpandableChart>
            ) : (
              <p className="text-sm text-muted">No playoff-odds snapshots for this season yet.</p>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Schedule & results */}
      <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="size-4 text-accent" aria-hidden="true" />
            <h3 className="text-sm font-semibold tracking-tight text-foreground">Schedule &amp; results</h3>
          </div>
          <Table>
            <caption className="sr-only">Schedule and results</caption>
            <THead>
              <TR>
                <TH align="center" className="w-10">Wk</TH>
                <TH>Opponent</TH>
                <TH align="right">For</TH>
                <TH align="right">Agst</TH>
                <TH align="center">Res</TH>
              </TR>
            </THead>
            <TBody>
              {dashboard.weeks.map((w) => (
                <TR key={w.week}>
                  <TD align="center" className="tabular-nums text-subtle">{w.week}</TD>
                  <TD>
                    {w.isBye ? (
                      <span className="text-muted">Bye</span>
                    ) : (
                      <div className="flex flex-col">
                        <span className="font-medium text-foreground">
                          {w.oppTeamKey} · {w.oppOwnerName}
                        </span>
                        {w.thisForfeit ? (
                          <span className="flex items-center gap-1 text-xs font-medium text-loss">
                            <AlertTriangle className="size-3" aria-hidden="true" /> Missed lineup —
                            auto-loss
                          </span>
                        ) : w.oppForfeit ? (
                          <span className="text-xs text-subtle">Opponent missed lineup</span>
                        ) : null}
                      </div>
                    )}
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {w.points !== null ? formatPoints(w.points) : "—"}
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {w.oppPoints !== null ? formatPoints(w.oppPoints) : "—"}
                  </TD>
                  <TD align="center">
                    {w.result ? (
                      <span
                        className={
                          "inline-flex items-center gap-1 font-semibold " +
                          (w.result === "W" ? "text-win" : w.result === "L" ? "text-loss" : "text-tie")
                        }
                      >
                        {w.result}
                        {w.thisForfeit ? (
                          <span className="rounded bg-loss-soft px-1 text-[10px] font-bold text-loss">
                            FF
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
      </div>
    </Container>
  );
}
