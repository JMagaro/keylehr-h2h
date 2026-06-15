/**
 * History — Server Component. Renders the LIVE league archive across every season
 * that has data: a "Champions & seasons" rundown (top finisher + that season's
 * notable records), all-time leaders (most wins / most points / best single week),
 * and notable all-time rivalries (most-played + most lopsided head-to-head), all
 * aggregated by PERSON across seasons. Queries Postgres directly.
 */
import type { Metadata } from "next";
import { ScrollText, Trophy, Crown, Flame, Swords } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { Card, CardHeader, CardTitle, CardDescription, CardBody } from "@/components/card";
import { TeamLogo } from "@/components/team-logo";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import { formatPoints } from "@/lib/utils";
import {
  getSeasonHistory,
  getAllTimeLeaders,
  getAllTimeRivalries,
  type SeasonHistory,
  type AllTimeLeader,
  type Rivalry,
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

function SeasonCard({ season }: { season: SeasonHistory }) {
  const top = season.topFinisher;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{season.seasonName}</CardTitle>
          <CardDescription>
            {season.ownerCount} owners · {season.weeksPlayed} week
            {season.weeksPlayed === 1 ? "" : "s"} played
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
                      <Trophy className="size-3" aria-hidden="true" /> Reg-season #1
                    </>
                  )}
                </Badge>
              </div>
              <span className="text-xs text-muted">
                {top.teamKey} · {record(top.wins, top.losses, top.ties)} ·{" "}
                {formatPoints(top.pointsFor)} PF
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
            value={season.pointsLeader ? `${formatPoints(season.pointsLeader.pointsFor)} PF` : ""}
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
      </CardBody>
    </Card>
  );
}

/** A small all-time leaders table (most wins / points / best week). */
function LeaderTable({
  title,
  description,
  icon: Icon,
  rows,
  valueHeader,
  valueOf,
}: {
  title: string;
  description: string;
  icon: typeof Trophy;
  rows: AllTimeLeader[];
  valueHeader: string;
  valueOf: (l: AllTimeLeader) => string;
}) {
  return (
    <div className="flex flex-col gap-3">
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
          {rows.map((l, i) => (
            <TR key={l.ownerId}>
              <TD align="center" className="tabular-nums text-subtle">
                {i + 1}
              </TD>
              <TD>
                <div className="flex items-center gap-2">
                  <TeamLogo src={l.logoEspn} alt={`${l.teamName ?? "team"} logo`} size={20} />
                  <span className="font-medium text-foreground">{l.ownerName}</span>
                </div>
              </TD>
              <TD align="right" className="tabular-nums font-semibold">
                {valueOf(l)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
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
        <div className="flex items-center gap-2">
          <TeamLogo src={r.ownerA.logoEspn} alt={`${r.ownerA.teamName ?? "team"} logo`} size={20} />
          <span className={aLeads ? "font-semibold text-foreground" : "text-foreground"}>
            {r.ownerA.ownerName}
          </span>
        </div>
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
        <div className="flex items-center justify-end gap-2">
          <span className={bLeads ? "font-semibold text-foreground" : "text-foreground"}>
            {r.ownerB.ownerName}
          </span>
          <TeamLogo src={r.ownerB.logoEspn} alt={`${r.ownerB.teamName ?? "team"} logo`} size={20} />
        </div>
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
  rows,
}: {
  title: string;
  description: string;
  rows: Rivalry[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="text-xs text-muted">{description}</p>
      <Table>
        <caption className="sr-only">{title}</caption>
        <THead>
          <TR>
            <TH>Owner</TH>
            <TH align="center">All-time</TH>
            <TH align="right">Owner</TH>
            <TH align="right">Mtgs</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <RivalryRow key={`${r.ownerA.ownerId}:${r.ownerB.ownerId}`} r={r} />
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export default async function HistoryPage() {
  const [seasonHistory, leaders, rivalries] = await Promise.all([
    getSeasonHistory(),
    getAllTimeLeaders(),
    getAllTimeRivalries(),
  ]);

  const hasAnyData = seasonHistory.length > 0;
  const topWins = leaders.byWins(10);
  const topPoints = leaders.byPoints(10);
  const topWeeks = leaders.byBestWeek(10);
  const mostPlayed = rivalries.mostPlayed(8);
  const mostLopsided = rivalries.mostLopsided(8, 3);

  return (
    <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
      <PageHeader
        eyebrow="League archive"
        title="History"
        description="Champions, season records, all-time owner leaders, and the most storied head-to-head rivalries from every KeyLehr H2H season."
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
            <h2 className="text-xl font-bold tracking-tight text-foreground">All-time leaders</h2>
            <div className="grid gap-6 lg:grid-cols-3">
              <LeaderTable
                title="Most wins"
                description="Total regular-season head-to-head wins across every season."
                icon={Trophy}
                rows={topWins}
                valueHeader="W-L-T"
                valueOf={(l) => record(l.totalWins, l.totalLosses, l.totalTies)}
              />
              <LeaderTable
                title="Most points"
                description="Total regular-season Points For across every season."
                icon={Flame}
                rows={topPoints}
                valueHeader="PF"
                valueOf={(l) => formatPoints(l.totalPoints)}
              />
              <LeaderTable
                title="Best single week"
                description="Highest single-week DraftKings score ever posted."
                icon={Crown}
                rows={topWeeks}
                valueHeader="Points"
                valueOf={(l) =>
                  l.bestWeek
                    ? `${formatPoints(l.bestWeek.points)} (${l.bestWeek.year} Wk ${l.bestWeek.week})`
                    : "—"
                }
              />
            </div>
          </section>

          {/* Rivalries */}
          <section aria-label="All-time rivalries" className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <Swords className="size-5 text-accent" aria-hidden="true" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">Rivalries</h2>
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
                  rows={mostPlayed}
                />
                <RivalryTable
                  title="Most lopsided"
                  description="The most one-sided rivalries (3+ meetings) by all-time win share."
                  rows={mostLopsided}
                />
              </div>
            )}
          </section>
        </>
      )}
    </Container>
  );
}
