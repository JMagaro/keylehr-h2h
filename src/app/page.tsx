/**
 * Dashboard (landing) — KeyLehr H2H.
 *
 * Server Component. Renders a LIVE summary for the most-recent season that has
 * data: a hero, a few StatTiles, a compact "Top of the standings" mini-table,
 * and links into /standings and /playoffs. When the league's current season is
 * an empty upcoming one, it also shows a "starts soon" note above the results.
 */
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Flame,
  ListOrdered,
  Trophy,
  UserRound,
  Users,
  Wand2,
} from "lucide-react";

import { Container } from "@/components/container";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";
import { StatTile } from "@/components/stat-tile";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { TeamLogo } from "@/components/team-logo";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import {
  getDefaultStandingsSeasonId,
  getSeasonOptions,
  getStandingsView,
  getTopStandings,
  getHighestWeeklyScore,
} from "@/lib/standings/query";
import { getCurrentSeason } from "@/lib/season";
import { formatPoints } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DashboardPage() {
  const [currentSeason, dataSeasonId, seasons] = await Promise.all([
    getCurrentSeason(),
    getDefaultStandingsSeasonId(),
    getSeasonOptions(),
  ]);

  const dataSeason = seasons.find((s) => s.id === dataSeasonId) ?? null;

  // The current season has no data when it isn't the data season (e.g. an empty
  // upcoming Season 4 while results live on Season 3).
  const showUpcomingNote =
    currentSeason !== null &&
    currentSeason.status !== "completed" &&
    currentSeason.id !== dataSeasonId;

  const [view, topRows, highScore] = dataSeasonId
    ? await Promise.all([
        getStandingsView(dataSeasonId),
        getTopStandings(dataSeasonId, 6),
        getHighestWeeklyScore(dataSeasonId),
      ])
    : [null, [], null];

  const heroLabel = dataSeason?.name ?? currentSeason?.name ?? "KeyLehr H2H";

  return (
    <>
      {/* Hero — transparent so the stadium backdrop shows through strongest here. */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_color-mix(in_oklab,_var(--color-accent)_18%,_transparent),_transparent_60%)]"
        />
        <Container width="wide" as="div" className="relative py-16 sm:py-20 lg:py-24">
          <div className="flex max-w-2xl flex-col gap-6">
            <Image
              src="/keylehr-wordmark.png"
              alt="KeyLehr Gaming"
              width={909}
              height={227}
              priority
              className="h-20 w-auto self-start drop-shadow-lg sm:h-24"
            />
            <Badge variant="accent" className="w-fit">
              {heroLabel}
            </Badge>
            <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              Your team. Your lineup.{" "}
              <span className="text-accent">Head-to-head all season.</span>
            </h1>
            <p className="max-w-xl text-base text-muted sm:text-lg">
              KeyLehr H2H is a 32-owner Daily Fantasy Football league. Every owner is
              assigned an NFL team and plays its real schedule — but each week your
              score is your DraftKings lineup, not the NFL game. Win the week, climb
              the standings, chase the bracket.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/standings"
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg shadow-sm transition-colors hover:bg-accent-strong"
              >
                View standings
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <Link
                href="/my-team/builder"
                className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface"
              >
                <Wand2 className="size-4 text-accent" aria-hidden="true" />
                Build a lineup
              </Link>
              <Link
                href="/playoffs"
                className="inline-flex items-center gap-2 rounded-lg border border-border-strong bg-card px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-surface"
              >
                Playoff picture
              </Link>
            </div>
          </div>
        </Container>
      </section>

      {/* Upcoming-season note (shown when the current season has no data yet). */}
      {showUpcomingNote && currentSeason ? (
        <section aria-label="Upcoming season">
          <Container width="wide" as="div" className="pt-8">
            <Card className="border-accent/30 bg-accent/5">
              <CardBody className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-accent/12 text-accent">
                    <CalendarDays className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-semibold text-foreground">
                      {currentSeason.name} starts soon
                    </p>
                    <p className="text-sm text-muted">
                      Owners are still being assigned. The results below are from the
                      most recent completed season.
                    </p>
                  </div>
                </div>
                <Badge variant="neutral" className="w-fit">
                  {currentSeason.status === "active" ? "In progress" : "Upcoming"}
                </Badge>
              </CardBody>
            </Card>
          </Container>
        </section>
      ) : null}

      {/* Season status strip */}
      <section aria-label="Season status">
        <Container width="wide" as="div" className="py-8">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile
              label="Season"
              value={dataSeason?.name ?? "—"}
              hint={dataSeason ? `${dataSeason.year} campaign` : "No data yet"}
              icon={Trophy}
            />
            <StatTile
              label="Owners"
              value={view?.hasData ? view.ownerCount : "—"}
              hint="Two conferences"
              icon={Users}
            />
            <StatTile
              label="Weeks played"
              value={view?.hasData ? view.weeksPlayed : "—"}
              hint="Regular season"
              icon={CalendarDays}
            />
            <StatTile
              label="Top weekly score"
              value={highScore ? formatPoints(highScore.points) : "—"}
              hint={
                highScore
                  ? `${highScore.ownerName} · Wk ${highScore.week}`
                  : "Awaiting scores"
              }
              icon={Flame}
            />
          </div>
        </Container>
      </section>

      {/* Live overview */}
      <section aria-label="League overview">
        <Container width="wide" as="div" className="grid gap-6 pb-16 [&>*]:min-w-0 lg:grid-cols-2">
          {/* Top of the standings */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Top of the standings</CardTitle>
                <Badge variant="neutral">W · L · T</Badge>
              </div>
              <CardDescription>
                The best records league-wide{dataSeason ? ` for ${dataSeason.name}` : ""}.
              </CardDescription>
            </CardHeader>
            <CardBody>
              {topRows.length === 0 ? (
                <EmptyState
                  icon={ListOrdered}
                  title="No standings yet"
                  description="Live data will populate here once weekly scores begin posting."
                />
              ) : (
                <Table>
                  <caption className="sr-only">Top of the standings</caption>
                  <THead>
                    <TR>
                      <TH align="center" className="w-8">
                        #
                      </TH>
                      <TH>Team &amp; Owner</TH>
                      <TH align="right">Rec</TH>
                      <TH align="right">PF</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {topRows.map((r, i) => (
                      <TR key={r.ownerSeasonId}>
                        <TD align="center" className="tabular-nums text-subtle">
                          {i + 1}
                        </TD>
                        <TD>
                          <div className="flex items-center gap-2">
                            <TeamLogo src={r.logoEspn} alt={`${r.teamName} logo`} size={22} />
                            <div className="flex flex-col">
                              <span className="font-semibold text-foreground">
                                {r.teamKey} · {r.teamName}
                              </span>
                              <span className="text-xs text-muted">{r.ownerName}</span>
                            </div>
                          </div>
                        </TD>
                        <TD align="right" className="tabular-nums">
                          {r.wins}-{r.losses}
                          {r.ties ? `-${r.ties}` : ""}
                        </TD>
                        <TD align="right" className="tabular-nums">
                          {formatPoints(r.pointsFor)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardBody>
          </Card>

          {/* Explore links */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Explore the league</CardTitle>
                <Badge variant="accent">Live</Badge>
              </div>
              <CardDescription>
                Standings and the playoff picture computed live from weekly DraftKings
                scores — plus team analytics and a weekly lineup builder.
              </CardDescription>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <Link
                href={dataSeasonId ? `/standings?season=${dataSeasonId}` : "/standings"}
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface"
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <ListOrdered className="size-5" aria-hidden="true" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold text-foreground">Standings</span>
                    <span className="text-sm text-muted">
                      By conference &amp; division, with playoff tags.
                    </span>
                  </span>
                </span>
                <ArrowRight
                  className="size-4 text-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link
                href={dataSeasonId ? `/playoffs?season=${dataSeasonId}` : "/playoffs"}
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface"
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <Trophy className="size-5" aria-hidden="true" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold text-foreground">Playoff picture</span>
                    <span className="text-sm text-muted">
                      Seven seeds per conference, as if today.
                    </span>
                  </span>
                </span>
                <ArrowRight
                  className="size-4 text-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link
                href="/my-team"
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface"
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <UserRound className="size-5" aria-hidden="true" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold text-foreground">My Team</span>
                    <span className="text-sm text-muted">
                      Per-team scores, trends &amp; results for any owner.
                    </span>
                  </span>
                </span>
                <ArrowRight
                  className="size-4 text-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
              <Link
                href="/my-team/builder"
                className="group flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface"
              >
                <span className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full bg-accent/10 text-accent">
                    <Wand2 className="size-5" aria-hidden="true" />
                  </span>
                  <span className="flex flex-col">
                    <span className="font-semibold text-foreground">Lineup builder</span>
                    <span className="text-sm text-muted">
                      Weekly target &amp; fade picks by risk level.
                    </span>
                  </span>
                </span>
                <ArrowRight
                  className="size-4 text-muted transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </Link>
            </CardBody>
          </Card>
        </Container>
      </section>
    </>
  );
}
