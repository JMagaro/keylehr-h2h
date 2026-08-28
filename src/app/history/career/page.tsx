/**
 * Owner Career — Server Component. One consolidated, all-time view of a single person:
 * their record, titles, playoff history, money, rivalries and season-by-season history.
 *
 * WHY THIS PAGE EXISTS: /history answers "who is the best all-time" across eleven
 * league-wide leaderboards, and /my-team answers "how is this person doing THIS season".
 * Nothing answered "who is this person, all-time" — you had to scan eleven tables and join
 * them on a name, and several of those tables are top-10 capped, so a mid-pack owner
 * appeared in none of them and could not see themselves at all.
 *
 * That last point is why the owner picker lists EVERYONE rather than linking from the
 * leaderboards: discovery for the owners who are not on a leaderboard is the whole gap.
 *
 * Owner is chosen via `?owner=<ownerId>` — a query param, not a dynamic segment, because
 * /history/[year] already owns that slot and /history/12 would be ambiguous with a year.
 *
 * All data comes from `getOwnerCareer()`, which composes the existing all-time aggregates
 * in src/lib/history.ts (each of which already carries the required isExhibition filter).
 * Deeper per-opponent detail deliberately stays on /history/head-to-head; this page shows
 * the top rivals and links there rather than duplicating it.
 */
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowLeft,
  Crown,
  Flame,
  Handshake,
  Scale,
  Skull,
  Star,
  Swords,
  Trophy,
  UserRound,
} from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { StatTile } from "@/components/stat-tile";
import { TeamLogo } from "@/components/team-logo";
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from "@/components/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import { OwnerSelector } from "@/components/owner-selector";
import {
  getOwnerCareer,
  getOwnerDirectory,
  type OwnerCareer,
  type OwnerCareerGame,
  type OwnerCareerRival,
} from "@/lib/history";
import { formatPoints } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Owner Career | History",
  description:
    "One owner's complete KeyLehr H2H career: record, titles, playoff history, rivalries and season-by-season results.",
};

function record(w: number, l: number, t: number): string {
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function signed(n: number, digits = 1): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
}

/** One opponent line, from the selected owner's point of view. */
function RivalRow({ rival }: { rival: OwnerCareerRival }) {
  const leads = rival.wins > rival.losses;
  const trails = rival.losses > rival.wins;
  return (
    <TR>
      <TD>
        <Link
          href={`/history/career?owner=${rival.opponent.ownerId}`}
          className="font-medium text-foreground hover:text-accent hover:underline"
        >
          {rival.opponent.ownerName}
        </Link>
      </TD>
      <TD align="center" className="tabular-nums text-muted">{rival.meetings}</TD>
      <TD align="right">
        <Badge variant={leads ? "win" : trails ? "loss" : "neutral"}>
          {record(rival.wins, rival.losses, rival.ties)}
        </Badge>
      </TD>
    </TR>
  );
}

/**
 * The Robbery / The Heist. Rendered only when the game exists — an owner with no losses
 * (or no wins) has no such game, and an empty card claiming one would be a fabrication.
 */
function ExtremeGameCard({
  label,
  hint,
  icon: Icon,
  game,
  tone,
}: {
  label: string;
  hint: string;
  icon: typeof Flame;
  game: OwnerCareerGame;
  tone: "win" | "loss";
}) {
  return (
    <Card className="h-full">
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-accent" aria-hidden="true" />
          <h3 className="text-sm font-semibold tracking-tight text-foreground">{label}</h3>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-foreground">
            {formatPoints(game.points)}
          </span>
          <span className="text-sm text-muted">vs</span>
          <span className="text-lg font-semibold tabular-nums text-muted">
            {formatPoints(game.oppPoints)}
          </span>
          <Badge variant={tone}>{tone === "win" ? "W" : "L"}</Badge>
        </div>
        <p className="text-xs text-muted">
          {game.year} · Week {game.week} · vs{" "}
          <Link
            href={`/history/career?owner=${game.opponent.ownerId}`}
            className="font-medium text-foreground hover:text-accent hover:underline"
          >
            {game.opponent.ownerName}
          </Link>
        </p>
        <p className="text-xs text-subtle">{hint}</p>
      </CardBody>
    </Card>
  );
}

/** The headline numbers. Split out so the empty-career case can skip it wholesale. */
function CareerTiles({ career }: { career: OwnerCareer }) {
  const { luck } = career;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="All-time record"
          value={record(career.wins, career.losses, career.ties)}
          hint={`${(career.winPct * 100).toFixed(1)}% · ${career.seasonsPlayed} season${career.seasonsPlayed === 1 ? "" : "s"}`}
          icon={Swords}
        />
        <StatTile
          label="Championships"
          value={career.championships}
          hint={career.championYears.length > 0 ? career.championYears.join(" · ") : "No titles yet"}
          icon={Crown}
        />
        <StatTile
          label="Playoff appearances"
          value={career.playoffAppearances}
          hint={
            career.playoffWins + career.playoffLosses > 0
              ? `${career.playoffWins}-${career.playoffLosses} in the bracket`
              : "No playoff games played"
          }
          icon={Trophy}
        />
        <StatTile
          label="Best week ever"
          value={career.bestWeek ? formatPoints(career.bestWeek.points) : "—"}
          hint={
            career.bestWeek
              ? `${career.bestWeek.year} · Week ${career.bestWeek.week}`
              : "No scored weeks yet"
          }
          icon={Flame}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Points for / game"
          value={formatPoints(career.pointsForPerGame)}
          hint={`${formatPoints(career.pointsFor)} all-time`}
        />
        <StatTile
          label="Points against / game"
          value={formatPoints(career.pointsAgainstPerGame)}
          hint={`${formatPoints(career.pointsAgainst)} all-time`}
        />
        <StatTile
          label="Differential / game"
          value={signed(career.pointsDiffPerGame, 2)}
          hint={career.pointsDiffPerGame >= 0 ? "Outscoring the schedule" : "Outscored by the schedule"}
        />
        <StatTile
          label="Weekly highs"
          value={career.weeklyHighs}
          hint={
            luck
              ? `Schedule luck ${signed(luck.luck)} wins`
              : "Weeks topping the whole league"
          }
          icon={Star}
        />
      </div>
    </>
  );
}

export default async function OwnerCareerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const directory = await getOwnerDirectory();

  const backToHistory = (
    <Link href="/history" className="flex items-center gap-1 hover:underline">
      <ArrowLeft className="size-3" aria-hidden="true" />
      History
    </Link>
  );

  if (directory.length === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
        <PageHeader
          eyebrow={backToHistory}
          title="Owner Career"
          description="Every owner's complete history in one place."
        />
        <EmptyState
          icon={UserRound}
          title="No owners yet"
          description="Career pages appear once owners have been assigned teams for a season."
        />
      </Container>
    );
  }

  // Resolve the selected owner — default to first alphabetically, matching /history/head-to-head.
  const rawParam = Array.isArray(sp.owner) ? sp.owner[0] : sp.owner;
  const requestedId = rawParam ? parseInt(rawParam, 10) : NaN;
  const selectedId =
    !Number.isNaN(requestedId) && directory.some((o) => o.ownerId === requestedId)
      ? requestedId
      : directory[0]!.ownerId;

  const career = await getOwnerCareer(selectedId);

  const header = (
    <PageHeader
      eyebrow={backToHistory}
      title={career ? career.owner.ownerName : "Owner Career"}
      description="Complete all-time career: record, titles, rivalries and every season played."
      actions={
        <OwnerSelector
          owners={directory.map((o) => ({ ownerId: o.ownerId, ownerName: o.ownerName }))}
          selectedId={selectedId}
        />
      }
    />
  );

  if (!career || career.seasonsPlayed === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
        {header}
        <EmptyState
          icon={UserRound}
          title="No seasons played yet"
          description="This owner has not played a scored season. Their career fills in from Week 1."
        />
      </Container>
    );
  }

  // Distinct crests worn, newest season first — a career at a glance.
  const crests = career.seasons.filter(
    (s, i, arr) => arr.findIndex((o) => o.teamKey === s.teamKey) === i,
  );

  return (
    <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
      {header}

      {/* Identity: who they are, what they've worn, what they've won. */}
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-bold tracking-tight text-foreground">
                {career.owner.ownerName}
              </span>
              {career.championYears.map((y) => (
                <Badge key={y} variant="div">
                  <Crown className="size-3" aria-hidden="true" /> {y}
                </Badge>
              ))}
            </div>
            <span className="text-xs text-muted">
              {career.seasonsPlayed} season{career.seasonsPlayed === 1 ? "" : "s"} ·{" "}
              {career.wins + career.losses + career.ties} regular-season games
            </span>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {crests.map((s) => (
              <span key={s.teamKey} className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1">
                <TeamLogo src={s.logoEspn} alt={`${s.teamName} logo`} size={20} />
                <span className="text-xs font-medium text-muted">{s.year}</span>
              </span>
            ))}
          </div>
        </CardBody>
      </Card>

      <CareerTiles career={career} />

      {/* Character: the stats that describe HOW the record happened. */}
      <section aria-label="Career notes" className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <Scale className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">Records &amp; notes</h2>
        </div>

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {career.luck ? (
            <StatTile
              label="Schedule luck"
              value={`${signed(career.luck.luck)} wins`}
              hint={`${career.luck.actualWins} actual vs ${career.luck.expectedWins.toFixed(1)} expected`}
            />
          ) : null}
          <StatTile
            label="Longest win streak"
            value={career.longestWinStreak?.streak ?? 0}
            hint={
              career.longestWinStreak
                ? `${career.longestWinStreak.startYear} Wk ${career.longestWinStreak.startWeek} → ${career.longestWinStreak.endYear} Wk ${career.longestWinStreak.endWeek}`
                : "No winning streak recorded"
            }
          />
          <StatTile
            label="Longest losing streak"
            value={career.longestLossStreak?.streak ?? 0}
            hint={
              career.longestLossStreak
                ? `${career.longestLossStreak.startYear} Wk ${career.longestLossStreak.startWeek} → ${career.longestLossStreak.endYear} Wk ${career.longestLossStreak.endWeek}`
                : "No losing streak recorded"
            }
          />
          <StatTile
            label="Best finish"
            value={
              career.bestFinish
                ? `${ordinal(career.bestFinish.finish)} of ${career.bestFinish.fieldSize}`
                : "—"
            }
            hint={
              career.bestFinish && career.averageFinish !== null
                ? `${career.bestFinish.year} · ${career.averageFinish.toFixed(1)} average across ${career.seasonsPlayed} season${career.seasonsPlayed === 1 ? "" : "s"}`
                : "No seasons finished yet"
            }
          />
        </div>

        {career.missedLineups > 0 ? (
          <p className="text-xs text-muted">
            <Skull className="mr-1 inline size-3.5 align-[-2px] text-loss" aria-hidden="true" />
            {career.missedLineups} missed lineup{career.missedLineups === 1 ? "" : "s"} all-time.
          </p>
        ) : null}

        {career.robbery || career.heist ? (
          <div className="grid gap-4 md:grid-cols-2">
            {career.robbery ? (
              <ExtremeGameCard
                label="The Robbery"
                hint="Their highest-scoring loss — everything went right, and it still wasn't enough."
                icon={Skull}
                game={career.robbery}
                tone="loss"
              />
            ) : null}
            {career.heist ? (
              <ExtremeGameCard
                label="The Heist"
                hint="Their lowest-scoring win — a week they got away with one."
                icon={Handshake}
                game={career.heist}
                tone="win"
              />
            ) : null}
          </div>
        ) : null}
      </section>

      {/* Rivalries: the headline pair, then the most-played. Depth lives on /history/head-to-head. */}
      <section aria-label="Rivalries" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Swords className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">Rivalries</h2>
          <Link
            href={`/history/head-to-head?owner=${career.owner.ownerId}`}
            className="text-xs font-medium text-accent hover:underline"
          >
            Full head-to-head →
          </Link>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>Nemesis</CardTitle>
              <CardDescription>Worst record against, minimum three meetings.</CardDescription>
            </CardHeader>
            <CardBody>
              {career.nemesis ? (
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/history/career?owner=${career.nemesis.opponent.ownerId}`}
                    className="truncate font-semibold text-foreground hover:text-accent hover:underline"
                  >
                    {career.nemesis.opponent.ownerName}
                  </Link>
                  <Badge variant="loss">
                    {record(career.nemesis.wins, career.nemesis.losses, career.nemesis.ties)}
                  </Badge>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No losing record against anyone they&apos;ve played three or more times.
                </p>
              )}
            </CardBody>
          </Card>

          <Card className="h-full">
            <CardHeader>
              <CardTitle>Favourite victim</CardTitle>
              <CardDescription>Best record against, minimum three meetings.</CardDescription>
            </CardHeader>
            <CardBody>
              {career.favouriteVictim ? (
                <div className="flex items-center justify-between gap-3">
                  <Link
                    href={`/history/career?owner=${career.favouriteVictim.opponent.ownerId}`}
                    className="truncate font-semibold text-foreground hover:text-accent hover:underline"
                  >
                    {career.favouriteVictim.opponent.ownerName}
                  </Link>
                  <Badge variant="win">
                    {record(
                      career.favouriteVictim.wins,
                      career.favouriteVictim.losses,
                      career.favouriteVictim.ties,
                    )}
                  </Badge>
                </div>
              ) : (
                <p className="text-sm text-muted">
                  No winning record against anyone they&apos;ve played three or more times.
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        {career.topRivals.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Most played</CardTitle>
              <CardDescription>The opponents they meet most often.</CardDescription>
            </CardHeader>
            <CardBody className="min-w-0">
              <Table>
                <caption className="sr-only">Most-played opponents</caption>
                <THead>
                  <TR>
                    <TH>Opponent</TH>
                    <TH align="center">Games</TH>
                    <TH align="right">Record</TH>
                  </TR>
                </THead>
                <TBody>
                  {career.topRivals.map((r) => (
                    <RivalRow key={r.opponent.ownerId} rival={r} />
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
        ) : null}
      </section>

      {/* Season by season. Finish is the league's real tiebreaker order, not a local re-sort. */}
      <section aria-label="Season by season" className="flex min-w-0 flex-col gap-4">
        <div className="flex items-center gap-3">
          <Trophy className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">Season by season</h2>
        </div>

        <Card>
          <CardBody className="min-w-0">
            <Table>
              <caption className="sr-only">
                {career.owner.ownerName}&apos;s record in every season played
              </caption>
              <THead>
                <TR>
                  <TH>Season</TH>
                  <TH>Team</TH>
                  <TH align="right">Record</TH>
                  <TH align="right">PF</TH>
                  <TH align="right">PA</TH>
                  <TH align="right">Finish</TH>
                </TR>
              </THead>
              <TBody>
                {career.seasons.map((s) => (
                  <TR key={s.seasonId}>
                    <TD>
                      <Link
                        href={`/history/${s.year}`}
                        className="font-medium text-foreground hover:text-accent hover:underline"
                      >
                        {s.year}
                      </Link>
                    </TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <TeamLogo src={s.logoEspn} alt={`${s.teamName} logo`} size={20} />
                        <span className="truncate text-muted">{s.teamName}</span>
                      </span>
                    </TD>
                    <TD align="right" className="tabular-nums font-semibold text-foreground">
                      {record(s.wins, s.losses, s.ties)}
                    </TD>
                    <TD align="right" className="tabular-nums text-muted">{formatPoints(s.pointsFor)}</TD>
                    <TD align="right" className="tabular-nums text-muted">{formatPoints(s.pointsAgainst)}</TD>
                    <TD align="right">
                      <span className="flex items-center justify-end gap-2">
                        <span className="tabular-nums text-muted">
                          {ordinal(s.finish)} of {s.fieldSize}
                        </span>
                        {s.isChampion ? (
                          <Badge variant="div">
                            <Crown className="size-3" aria-hidden="true" /> Champion
                          </Badge>
                        ) : s.madePlayoffs ? (
                          <Badge variant="wc">Playoffs</Badge>
                        ) : null}
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      </section>
    </Container>
  );
}
