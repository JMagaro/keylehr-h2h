/**
 * History — Server Component. Renders the LIVE league archive across every season
 * that has data: a "Champions & seasons" rundown (top finisher + that season's
 * notable records), all-time leaders (most wins / most points / best single week),
 * and notable all-time rivalries (most-played + most lopsided head-to-head), all
 * aggregated by PERSON across seasons. Queries Postgres directly.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { ScrollText, Trophy, Crown, Flame, Swords, Users, LineChart, Star, TrendingUp, TrendingDown, AlertCircle, DollarSign, Medal, Target, Zap } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardBody } from "@/components/card";
import { TeamLogo } from "@/components/team-logo";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import { OwnerTrendsPanel } from "@/components/owner-trend-chart";
import { TiedFootnote } from "./tied-footnote";
import { formatPoints, formatMoney, winPct } from "@/lib/utils";
import {
  getSeasonHistory,
  getAllTimeLeaders,
  getAllTimeRivalries,
  getOwnerSeasonTrends,
  getStreakLeaders,
  getMissedSubmissions,
  getNetEarnings,
  getPlayoffStats,
  getWeeklyHighScores,
  getGameExtremes,
  getChampionLeaders,
  type SeasonHistory,
  type AllTimeLeader,
  type ChampionLeader,
  type Rivalry,
  type StreakRecord,
  type MissedSubmission,
  type NetEarningsLeader,
  type PlayoffStat,
  type WeeklyHighStat,
  type GameExtreme,
} from "@/lib/history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export const metadata: Metadata = {
  title: "History",
  description:
    "KeyLehr H2H league history — past champions, season records, all-time owner leaders, and the most storied head-to-head rivalries across every season.",
};

/** A record-holder line: crest + owner + value, used inside season cards. */
function RecordLine({
  label,
  holder,
  value,
}: {
  label: string;
  holder: { ownerName: string; teamName: string; logoEspn: string | null } | null;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</span>
      {holder ? (
        <span className="flex min-w-0 items-center gap-2">
          <TeamLogo src={holder.logoEspn} alt={`${holder.teamName} logo`} size={18} />
          <span className="truncate text-sm font-medium text-foreground">{holder.ownerName}</span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-accent">{value}</span>
        </span>
      ) : (
        <span className="text-sm text-muted">—</span>
      )}
    </div>
  );
}

function record(w: number, l: number, t: number): string {
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function allTimeWinPct(l: AllTimeLeader): string {
  return (winPct(l.totalWins, l.totalLosses, l.totalTies) * 100).toFixed(1) + '%';
}

function SeasonCard({ season }: { season: SeasonHistory }) {
  const top = season.topFinisher;
  return (
    <Link href={`/history/${season.year}`} className="group block">
      <Card className="h-full transition-colors group-hover:border-accent/50">
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle>{season.seasonName}</CardTitle>
            <CardDescription>
              {season.ownerCount} owners
              {season.weeksPlayed > 0
                ? ` · ${season.weeksPlayed} week${season.weeksPlayed === 1 ? "" : "s"} played`
                : ""}
            </CardDescription>
          </div>
          <Badge variant={season.status === "completed" ? "accent" : "neutral"}>
            {season.status === "active"
              ? "In progress"
              : season.status === "upcoming"
                ? "Upcoming"
                : "Final"}
          </Badge>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {top ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
              <TeamLogo src={top.logoEspn} alt={`${top.teamName} logo`} size={36} />
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {top.ownerName}
                  </span>
                  <Badge variant={top.isChampion ? "div" : "accent"}>
                    {top.isChampion ? (
                      <>
                        <Crown className="size-3" aria-hidden="true" /> Champion
                      </>
                    ) : (
                      <>
                        <Trophy className="size-3" aria-hidden="true" /> Regular-season #1
                      </>
                    )}
                  </Badge>
                </div>
                <span className="text-xs text-muted">
                  {record(top.wins, top.losses, top.ties)} ·{" "}
                  {formatPoints(top.pointsFor)} pts
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">No standings recorded for this season yet.</p>
          )}

          <div className="divide-y divide-border">
            <RecordLine
              label="Highest week"
              holder={season.highestWeek}
              value={
                season.highestWeek
                  ? `${formatPoints(season.highestWeek.points)} (Wk ${season.highestWeek.week})`
                  : ""
              }
            />
            <RecordLine
              label="Points leader"
              holder={season.pointsLeader}
              value={season.pointsLeader ? `${formatPoints(season.pointsLeader.pointsFor)} pts` : ""}
            />
            <RecordLine
              label="Best record"
              holder={season.bestRecord}
              value={
                season.bestRecord
                  ? record(season.bestRecord.wins, season.bestRecord.losses, season.bestRecord.ties)
                  : ""
              }
            />
          </div>
          <div className="flex justify-end pt-1">
            <span className="text-xs font-medium text-accent group-hover:underline">
              View standings &amp; bracket →
            </span>
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}


/** A small all-time leaders table, generic over any row type with owner identity fields. */
function LeaderTable<T extends { ownerId: number; ownerName: string }>({
  title,
  description,
  icon: Icon,
  rows,
  limit = 10,
  valueHeader,
  valueOf,
  rankKey,
}: {
  title: string;
  description: string;
  icon: typeof Trophy;
  /** Full sorted array — component handles slicing to `limit`. */
  rows: T[];
  limit?: number;
  valueHeader: string;
  valueOf: (l: T) => string;
  /** When provided, rows sharing the same value get the same rank number. */
  rankKey?: (item: T) => number;
}) {
  const visible = rows.slice(0, limit);
  const lastVal = rankKey && visible.length === limit ? rankKey(visible[visible.length - 1]) : null;
  const hiddenItems = lastVal !== null
    ? rows.slice(limit).filter((r) => rankKey!(r) === lastVal).map((r) => ({ name: r.ownerName, detail: valueOf(r) }))
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      <p className="text-xs text-muted">{description}</p>
      <Table>
        <caption className="sr-only">{title}</caption>
        <THead>
          <TR>
            <TH align="center" className="w-8">
              #
            </TH>
            <TH>Owner</TH>
            <TH align="right">{valueHeader}</TH>
          </TR>
        </THead>
        <TBody>
          {visible.map((l, i) => {
            const rank = rankKey ? rows.findIndex((r) => rankKey(r) === rankKey(l)) + 1 : i + 1;
            return (
              <TR key={l.ownerId}>
                <TD align="center" className="tabular-nums text-subtle">
                  {rank}
                </TD>
                <TD>
                  <span className="font-medium text-foreground">{l.ownerName}</span>
                </TD>
                <TD align="right" className="tabular-nums font-semibold">
                  {valueOf(l)}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <TiedFootnote items={hiddenItems} />
    </div>
  );
}

function PlayoffTable({ rows, limit = 10 }: { rows: PlayoffStat[]; limit?: number }) {
  const visible = rows.slice(0, limit);
  const lastApp = visible.length === limit ? visible[visible.length - 1].appearances : null;
  const hiddenItems = lastApp !== null
    ? rows.slice(limit).filter((r) => r.appearances === lastApp).map((r) => ({
        name: r.ownerName,
        detail: `${r.appearances} App · ${r.playoffWins}-${r.playoffLosses}`,
      }))
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Target className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">Playoff appearances</h3>
      </div>
      <p className="text-xs text-muted">Times reaching the postseason, with all-time playoff record.</p>
      <Table>
        <caption className="sr-only">Playoff appearances all-time</caption>
        <THead>
          <TR>
            <TH align="center" className="w-8">#</TH>
            <TH>Owner</TH>
            <TH align="right">App</TH>
            <TH align="right">W-L</TH>
          </TR>
        </THead>
        <TBody>
          {visible.map((l) => {
            const rank = rows.findIndex((r) => r.appearances === l.appearances) + 1;
            return (
              <TR key={l.ownerId}>
                <TD align="center" className="tabular-nums text-subtle">{rank}</TD>
                <TD><span className="font-medium text-foreground">{l.ownerName}</span></TD>
                <TD align="right" className="tabular-nums font-semibold">{l.appearances}</TD>
                <TD align="right" className="tabular-nums text-muted">
                  {l.playoffWins}-{l.playoffLosses}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <TiedFootnote items={hiddenItems} />
    </div>
  );
}

/** A callout card for a single-game extreme (closest or biggest blowout). */
function GameExtremeCard({
  label,
  icon: Icon,
  game,
}: {
  label: string;
  icon: typeof TrendingUp;
  game: GameExtreme;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{label}</h3>
        <span className="ml-auto text-xs font-medium text-muted">{game.year} · Wk {game.week}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <TeamLogo src={game.winnerLogoEspn} alt={`${game.winnerTeamKey} logo`} size={20} />
          <span className="font-semibold text-foreground">{game.winnerOwnerName}</span>
          <span className="ml-auto tabular-nums font-semibold text-foreground">{game.winnerPoints.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2 opacity-60">
          <TeamLogo src={game.loserLogoEspn} alt={`${game.loserTeamKey} logo`} size={20} />
          <span className="text-foreground">{game.loserOwnerName}</span>
          <span className="ml-auto tabular-nums text-foreground">{game.loserPoints.toFixed(2)}</span>
        </div>
      </div>
      <p className="text-xs font-medium text-accent">
        {game.margin < 0.1 ? `Margin: ${game.margin.toFixed(2)} pts` : `Won by ${game.margin.toFixed(2)} pts`}
      </p>
    </div>
  );
}

/** A rivalry row: both owners + the all-time head-to-head record. */
function RivalryRow({ r }: { r: Rivalry }) {
  const aLeads = r.aWins > r.bWins;
  const bLeads = r.bWins > r.aWins;
  return (
    <TR>
      <TD>
        <span className={aLeads ? "font-semibold text-foreground" : "text-foreground"}>
          {r.ownerA.ownerName}
        </span>
      </TD>
      <TD align="center" className="tabular-nums font-semibold">
        <span className={aLeads ? "text-win" : bLeads ? "text-loss" : "text-muted"}>
          {r.aWins}
        </span>
        <span className="px-1 text-subtle">–</span>
        <span className={bLeads ? "text-win" : aLeads ? "text-loss" : "text-muted"}>
          {r.bWins}
        </span>
        {r.ties > 0 ? <span className="text-subtle">{` (${r.ties}T)`}</span> : null}
      </TD>
      <TD align="right">
        <span className={bLeads ? "font-semibold text-foreground" : "text-foreground"}>
          {r.ownerB.ownerName}
        </span>
      </TD>
      <TD align="right" className="tabular-nums text-muted">
        {r.meetings}
      </TD>
    </TR>
  );
}

function RivalryTable({
  title,
  description,
  icon: Icon,
  rows,
  limit = 8,
  tiedWith,
  detailOf,
}: {
  title: string;
  description: string;
  icon?: typeof Trophy;
  /** Full sorted array — component handles slicing to `limit`. */
  rows: Rivalry[];
  limit?: number;
  /** Returns true when a candidate beyond the limit is tied with the boundary row. */
  tiedWith?: (boundary: Rivalry, candidate: Rivalry) => boolean;
  /** Formats the detail string shown in the footnote tooltip. */
  detailOf?: (r: Rivalry) => string;
}) {
  const visible = rows.slice(0, limit);
  const boundary = tiedWith && visible.length === limit ? visible[visible.length - 1] : null;
  const hiddenItems = boundary
    ? rows.slice(limit).filter((r) => tiedWith!(boundary, r)).map((r) => ({
        name: `${r.ownerA.ownerName} vs. ${r.ownerB.ownerName}`,
        detail: detailOf ? detailOf(r) : `${r.meetings} games`,
      }))
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-4 text-accent" aria-hidden="true" />}
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      <p className="text-xs text-muted">{description}</p>
      <Table>
        <caption className="sr-only">{title}</caption>
        <THead>
          <TR>
            <TH>Owner</TH>
            <TH align="center">All-time</TH>
            <TH align="right">Owner</TH>
            <TH align="right">Games</TH>
          </TR>
        </THead>
        <TBody>
          {visible.map((r) => (
            <RivalryRow key={`${r.ownerA.ownerId}:${r.ownerB.ownerId}`} r={r} />
          ))}
        </TBody>
      </Table>
      <TiedFootnote items={hiddenItems} />
    </div>
  );
}

function streakSpan(r: StreakRecord): string {
  if (r.startYear === r.endYear) return `${r.startYear} Wk ${r.startWeek}–${r.endWeek}`;
  return `${r.startYear} Wk ${r.startWeek} – ${r.endYear} Wk ${r.endWeek}`;
}

function StreakTable({
  title,
  description,
  icon: Icon,
  rows,
  limit = 10,
  variant,
}: {
  title: string;
  description: string;
  icon: typeof TrendingUp;
  /** Full sorted array — component handles slicing to `limit`. */
  rows: StreakRecord[];
  limit?: number;
  variant: "win" | "loss";
}) {
  const visible = rows.slice(0, limit);
  const lastStreak = visible.length === limit ? visible[visible.length - 1].streak : null;
  const hiddenItems = lastStreak !== null
    ? rows.slice(limit).filter((r) => r.streak === lastStreak).map((r) => ({
        name: r.ownerName,
        detail: `${r.streak} · ${streakSpan(r)}`,
      }))
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      </div>
      <p className="text-xs text-muted">{description}</p>
      <Table>
        <caption className="sr-only">{title}</caption>
        <THead>
          <TR>
            <TH align="center" className="w-8">#</TH>
            <TH>Owner</TH>
            <TH align="center">Streak</TH>
            <TH align="right">Span</TH>
          </TR>
        </THead>
        <TBody>
          {visible.map((r) => {
            const rank = rows.findIndex((s) => s.streak === r.streak) + 1;
            return (
              <TR key={r.ownerId}>
                <TD align="center" className="tabular-nums text-subtle">{rank}</TD>
                <TD><span className="font-medium text-foreground">{r.ownerName}</span></TD>
                <TD align="center">
                  <span className={`tabular-nums font-bold ${variant === "win" ? "text-win" : "text-loss"}`}>
                    {r.streak}
                  </span>
                </TD>
                <TD align="right" className="tabular-nums text-xs text-muted">{streakSpan(r)}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <TiedFootnote items={hiddenItems} />
    </div>
  );
}

function NetEarnersTable({ rows }: { rows: NetEarningsLeader[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <DollarSign className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">Net earners</h3>
      </div>
      <p className="text-xs text-muted">
        Top 10 by net — prizes won minus entry fees paid across all seasons.
      </p>
      <Table>
        <caption className="sr-only">Net earners all-time</caption>
        <THead>
          <TR>
            <TH align="center" className="w-8">#</TH>
            <TH>Owner</TH>
            <TH align="right" className="hidden sm:table-cell">Earned</TH>
            <TH align="right" className="hidden sm:table-cell">Paid</TH>
            <TH align="right">Net</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={r.ownerId}>
              <TD align="center" className="tabular-nums text-subtle">{i + 1}</TD>
              <TD><span className="font-medium text-foreground">{r.ownerName}</span></TD>
              <TD align="right" className="hidden tabular-nums text-muted sm:table-cell">
                {formatMoney(r.earnedCents)}
              </TD>
              <TD align="right" className="hidden tabular-nums text-muted sm:table-cell">
                {formatMoney(r.paidCents)}
              </TD>
              <TD align="right" className={`tabular-nums font-semibold ${r.netCents >= 0 ? "text-win" : "text-loss"}`}>
                {r.netCents >= 0 ? "+" : ""}{formatMoney(r.netCents)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function MissedSubmissionsTable({ rows }: { rows: MissedSubmission[] }) {
  const visible = rows.filter((r) => r.count > 0);
  if (visible.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="size-4 text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold tracking-tight text-foreground">The Shame List</h3>
      </div>
      <p className="text-xs text-muted">
        Owners who forgot to set a lineup — at least once.
      </p>
      <Table>
        <caption className="sr-only">Missed submissions all-time</caption>
        <THead>
          <TR>
            <TH align="center" className="w-8">#</TH>
            <TH>Owner</TH>
            <TH align="right">Missed weeks</TH>
          </TR>
        </THead>
        <TBody>
          {visible.map((r) => {
            const rank = visible.findIndex((s) => s.count === r.count) + 1;
            return (
              <TR key={r.ownerId}>
                <TD align="center" className="tabular-nums text-subtle">{rank}</TD>
                <TD><span className="font-medium text-foreground">{r.ownerName}</span></TD>
                <TD align="right" className="tabular-nums font-semibold text-loss">{r.count}</TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

export default async function HistoryPage() {
  const [
    seasonHistory, leaders, rivalries, ownerTrends,
    streaks, missedSubmissions, earners,
    playoffStats, weeklyHighs, gameExtremes, championLeaders,
  ] = await Promise.all([
    getSeasonHistory(),
    getAllTimeLeaders(),
    getAllTimeRivalries(),
    getOwnerSeasonTrends(),
    getStreakLeaders(),
    getMissedSubmissions(),
    getNetEarnings(),
    getPlayoffStats(),
    getWeeklyHighScores(),
    getGameExtremes(),
    getChampionLeaders(),
  ]);

  const hasAnyData = seasonHistory.length > 0;
  const topWins = leaders.byWins();
  const topPoints = leaders.byPoints(10);
  const topWeeks = leaders.byBestWeek(10);
  const mostPlayed = rivalries.mostPlayed();
  const mostLopsided = rivalries.mostLopsided(3);

  return (
    <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
      <PageHeader
        eyebrow="League archive"
        title="History"
        description="Every champion, every record, every rivalry — the full KeyLehr H2H story across all seasons."
      />

      {!hasAnyData ? (
        <EmptyState
          icon={ScrollText}
          title="History is being archived"
          description="No completed seasons with data yet — past champions and all-time records will populate here once weekly scores begin posting."
        />
      ) : (
        <>
          {/* Champions & seasons */}
          <section aria-label="Champions and seasons" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-bold tracking-tight text-foreground">
                Champions &amp; seasons
              </h2>
              <Badge variant="accent">
                {seasonHistory.length} season{seasonHistory.length === 1 ? "" : "s"}
              </Badge>
            </div>
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
              {seasonHistory.map((s) => (
                <SeasonCard key={s.seasonId} season={s} />
              ))}
            </div>
          </section>

          {/* All-time leaders */}
          <section aria-label="All-time leaders" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Trophy className="size-5 text-accent" aria-hidden="true" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">All-time leaders</h2>
            </div>
            <p className="text-sm text-muted">Regular-season stats, aggregated across all seasons.</p>
            <div className="grid gap-6 lg:grid-cols-3">
              <LeaderTable
                title="Most wins"
                description="Total regular-season wins across every season."
                icon={Trophy}
                rows={topWins}
                valueHeader="Record"
                valueOf={(l) => `${record(l.totalWins, l.totalLosses, l.totalTies)} (${allTimeWinPct(l)})`}
                rankKey={(l) => l.totalWins}
              />
              <LeaderTable
                title="Most points"
                description="Total points scored in regular-season play, all-time."
                icon={Flame}
                rows={topPoints}
                valueHeader="Points"
                valueOf={(l) => formatPoints(l.totalPoints)}
              />
              {championLeaders.length > 0 ? (
                <LeaderTable<ChampionLeader>
                  title="Most championships"
                  description="Championship titles won across all seasons."
                  icon={Medal}
                  rows={championLeaders}
                  valueHeader="Titles"
                  valueOf={(l) => `${l.championships}`}
                />
              ) : (
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Medal className="size-4 text-accent" aria-hidden="true" />
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">Most championships</h3>
                  </div>
                  <p className="text-xs text-muted">No championship titles recorded yet.</p>
                </div>
              )}
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <LeaderTable
                title="Best single week"
                description="Highest single-week DraftKings score, all-time."
                icon={Crown}
                rows={topWeeks}
                valueHeader="Points"
                valueOf={(l) =>
                  l.bestWeek
                    ? `${formatPoints(l.bestWeek.points)} (${l.bestWeek.year} Wk ${l.bestWeek.week})`
                    : "—"
                }
              />
              <PlayoffTable rows={playoffStats} />
              <LeaderTable<WeeklyHighStat>
                title="Most weekly highs"
                description="Weeks an owner led the league in scoring."
                icon={Zap}
                rows={weeklyHighs}
                valueHeader="Weeks"
                valueOf={(l) => `${l.count}`}
                rankKey={(l) => l.count}
              />
            </div>
          </section>

          {/* Owner trends */}
          <section aria-label="Owner trends" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <LineChart className="size-5 text-accent" aria-hidden="true" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">Owner trends</h2>
            </div>
            <p className="text-sm text-muted">
              Every owner&apos;s win count and average points scored, season by season. Search, tap, or hover an
              owner below to highlight their line on both charts.
            </p>
            <OwnerTrendsPanel trends={ownerTrends} />
          </section>

          {/* Records & milestones */}
          <section aria-label="Records and milestones" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Star className="size-5 text-accent" aria-hidden="true" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">Records &amp; milestones</h2>
            </div>
            <p className="text-sm text-muted">Single-game records, individual season streaks, and financial results across all seasons.</p>
            <div className="grid gap-6 lg:grid-cols-2">
              <StreakTable
                title="Longest winning streak"
                description="Most consecutive regular-season wins within a single season."
                icon={TrendingUp}
                rows={streaks.longestWinStreak}
                variant="win"
              />
              <StreakTable
                title="Longest losing streak"
                description="Most consecutive regular-season losses within a single season."
                icon={TrendingDown}
                rows={streaks.longestLossStreak}
                variant="loss"
            />
            </div>
            {(gameExtremes.closest || gameExtremes.biggestBlowout) && (
              <div className="grid gap-4 sm:grid-cols-2">
                {gameExtremes.closest && (
                  <GameExtremeCard label="Closest game" icon={Target} game={gameExtremes.closest} />
                )}
                {gameExtremes.biggestBlowout && (
                  <GameExtremeCard label="Biggest blowout" icon={Flame} game={gameExtremes.biggestBlowout} />
                )}
              </div>
            )}
            <div className="grid gap-6 lg:grid-cols-2">
              <NetEarnersTable rows={earners.slice(0, 10)} />
              <MissedSubmissionsTable rows={missedSubmissions} />
            </div>
          </section>

          {/* Rivalries & head-to-head */}
          <section aria-label="Rivalries and head-to-head records" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Swords className="size-5 text-accent" aria-hidden="true" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">Rivalries &amp; head-to-head</h2>
            </div>

            {rivalries.rivalries.length === 0 ? (
              <EmptyState
                icon={Swords}
                title="No rivalries yet"
                description="Head-to-head rivalry records appear once owners have played each other."
              />
            ) : (
              <div className="grid gap-6 lg:grid-cols-2">
                <RivalryTable
                  title="Most-played"
                  description="The pairs of owners who've met most often, all-time."
                  icon={Users}
                  rows={mostPlayed}
                  tiedWith={(b, c) => c.meetings === b.meetings}
                  detailOf={(r) => `${r.aWins}-${r.bWins}${r.ties > 0 ? ` (${r.ties}T)` : ''} · ${r.meetings} games`}
                />
                <RivalryTable
                  title="Most lopsided"
                  description="The most one-sided rivalries, among pairs with at least 3 meetings."
                  icon={TrendingUp}
                  rows={mostLopsided}
                  tiedWith={(b, c) => {
                    const dom = (r: Rivalry) => r.aWins + r.bWins > 0 ? Math.abs(r.aWins - r.bWins) / (r.aWins + r.bWins) : 0;
                    return dom(c) === dom(b) && c.meetings === b.meetings;
                  }}
                  detailOf={(r) => `${Math.max(r.aWins, r.bWins)}-${Math.min(r.aWins, r.bWins)} (${r.meetings} games)`}
                />
              </div>
            )}

            <Link
              href="/history/head-to-head"
              className="group flex items-center justify-between rounded-xl border border-border bg-card p-5 shadow-sm transition-colors hover:border-border-strong hover:bg-surface"
            >
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-foreground group-hover:text-accent">
                  View all owner vs. opponent records →
                </span>
                <span className="text-sm text-muted">
                  Pick any owner to see their all-time W-L record against every opponent, aggregated across all seasons.
                </span>
              </div>
            </Link>
          </section>
        </>
      )}
    </Container>
  );
}
