/**
 * Season detail page — summary, standings, and playoff bracket for a single season.
 * Route: /history/[year]  (year = calendar year, e.g. /history/2024)
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Crown, GitFork, ListOrdered, Trophy } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { TeamLogo } from "@/components/team-logo";
import { PlayoffBracket } from "@/components/playoff-bracket";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import {
  getSeasonOptions,
  getStandingsView,
  type PlayoffTag,
  type StandingsViewRow,
} from "@/lib/standings/query";
import { getPlayoffBracket } from "@/lib/playoffs/service";
import { getSeasonHistoryById } from "@/lib/history";
import type { Conference, Division } from "@/lib/standings";
import { formatPoints } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string }>;
}): Promise<Metadata> {
  const { year } = await params;
  return {
    title: `${year} Season`,
    description: `KeyLehr H2H ${year} season — standings, records, and playoff bracket.`,
  };
}

const CONFERENCES: Conference[] = ["AFC", "NFC"];
const DIVISIONS: Division[] = ["East", "North", "South", "West"];

function record(w: number, l: number, t: number): string {
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function PlayoffBadge({ tag }: { tag: PlayoffTag }) {
  if (!tag) return null;
  if (tag.kind === "bye") return <Badge variant="bye">1 · Bye</Badge>;
  if (tag.kind === "div") return <Badge variant="div">Div</Badge>;
  return <Badge variant="wc">WC</Badge>;
}

function DivisionTable({
  conference,
  division,
  rows,
}: {
  conference: Conference;
  division: Division;
  rows: StandingsViewRow[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-subtle">
        {division}
      </h3>
      <Table>
        <caption className="sr-only">{conference} {division} standings</caption>
        <THead>
          <TR>
            <TH align="center" className="w-10">#</TH>
            <TH>Team &amp; Owner</TH>
            <TH align="right">W</TH>
            <TH align="right">L</TH>
            <TH align="right">T</TH>
            <TH align="right" className="hidden sm:table-cell">PCT</TH>
            <TH align="right">PF</TH>
            <TH align="right" className="hidden sm:table-cell">PA</TH>
            <TH align="right" className="hidden sm:table-cell">STRK</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.ownerSeasonId}>
              <TD align="center" className="tabular-nums text-subtle">{r.rank}</TD>
              <TD>
                <div className="flex items-center gap-2">
                  <TeamLogo src={r.logoEspn} alt={`${r.teamName} logo`} size={24} />
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground">
                      {r.teamKey} · {r.teamName}
                    </span>
                    <span className="text-xs text-muted">{r.ownerName}</span>
                  </div>
                  <PlayoffBadge tag={r.playoff} />
                </div>
              </TD>
              <TD align="right" className="tabular-nums font-medium">{r.wins}</TD>
              <TD align="right" className="tabular-nums">{r.losses}</TD>
              <TD align="right" className="tabular-nums">{r.ties}</TD>
              <TD align="right" className="hidden tabular-nums sm:table-cell">
                {r.winPct.toFixed(3)}
              </TD>
              <TD align="right" className="tabular-nums">{formatPoints(r.pointsFor)}</TD>
              <TD align="right" className="hidden tabular-nums sm:table-cell">
                {formatPoints(r.pointsAgainst)}
              </TD>
              <TD align="right" className="hidden tabular-nums sm:table-cell">
                {r.streak || "—"}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function HighlightCard({
  label,
  holder,
  value,
}: {
  label: string;
  holder: { ownerName: string; teamName: string; logoEspn: string | null };
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-subtle">
        {label}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        <TeamLogo src={holder.logoEspn} alt={`${holder.teamName} logo`} size={20} />
        <span className="truncate text-sm font-medium text-foreground">{holder.ownerName}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-accent">{value}</span>
      </div>
    </div>
  );
}

export default async function SeasonDetailPage({
  params,
}: {
  params: Promise<{ year: string }>;
}) {
  const { year: yearStr } = await params;
  const year = Number(yearStr);
  if (Number.isNaN(year)) notFound();

  const seasons = await getSeasonOptions();
  const season = seasons.find((s) => s.year === year);
  if (!season) notFound();

  const [history, standingsView, bracket] = await Promise.all([
    getSeasonHistoryById(season.id),
    getStandingsView(season.id),
    getPlayoffBracket(season.id),
  ]);

  const top = history?.topFinisher ?? null;

  return (
    <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
      <Link
        href="/history"
        className="flex w-fit items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        Back to History
      </Link>

      <PageHeader
        eyebrow={season.name}
        title={`${year} Season`}
        description={
          history
            ? `${history.ownerCount} owners · ${history.weeksPlayed} week${history.weeksPlayed === 1 ? "" : "s"} played`
            : "No data recorded for this season yet."
        }
        actions={
          <Badge variant={season.status === "completed" ? "accent" : "neutral"}>
            {season.status === "active"
              ? "In progress"
              : season.status === "upcoming"
                ? "Upcoming"
                : "Final"}
          </Badge>
        }
      />

      {/* Season highlights */}
      {history && (top || history.highestWeek || history.pointsLeader) && (
        <section aria-label="Season highlights" className="flex flex-col gap-4">
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            Season highlights
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {top && (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 sm:col-span-2">
                <TeamLogo src={top.logoEspn} alt={`${top.teamName} logo`} size={44} />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-foreground">
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
                  <span className="text-sm text-muted">
                    {top.teamKey} · {record(top.wins, top.losses, top.ties)} ·{" "}
                    {formatPoints(top.pointsFor)} PF
                  </span>
                </div>
              </div>
            )}
            {history.highestWeek && (
              <HighlightCard
                label="Highest week"
                holder={history.highestWeek}
                value={`${formatPoints(history.highestWeek.points)} · Wk ${history.highestWeek.week}`}
              />
            )}
            {history.pointsLeader && (
              <HighlightCard
                label="Points leader"
                holder={history.pointsLeader}
                value={`${formatPoints(history.pointsLeader.pointsFor)} PF`}
              />
            )}
            {history.bestRecord && (
              <HighlightCard
                label="Best record"
                holder={history.bestRecord}
                value={record(
                  history.bestRecord.wins,
                  history.bestRecord.losses,
                  history.bestRecord.ties,
                )}
              />
            )}
          </div>
        </section>
      )}

      {/* Standings */}
      <section aria-label="Standings" className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <ListOrdered className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">Standings</h2>
        </div>
        {!standingsView.hasData ? (
          <EmptyState
            icon={ListOrdered}
            title="No standings for this season"
            description="This season has no recorded scores yet."
          />
        ) : (
          <div className="flex flex-col gap-10">
            {CONFERENCES.map((conf) => (
              <section
                key={conf}
                aria-label={`${conf} standings`}
                className="flex flex-col gap-5"
              >
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold tracking-tight text-foreground">{conf}</h3>
                  <Badge variant="accent">Conference</Badge>
                </div>
                <div className="grid gap-6 lg:grid-cols-2">
                  {DIVISIONS.map((div) => (
                    <DivisionTable
                      key={`${conf}-${div}`}
                      conference={conf}
                      division={div}
                      rows={standingsView.byConference[conf][div]}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      {/* Playoff bracket */}
      <section aria-label="Playoff bracket" className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <GitFork className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            Playoff bracket
          </h2>
        </div>
        {!bracket.hasData ? (
          <EmptyState
            icon={GitFork}
            title="No bracket for this season"
            description="The playoff bracket will appear once the regular season ends and the bracket is generated."
          />
        ) : (
          <PlayoffBracket bracket={bracket} />
        )}
      </section>
    </Container>
  );
}
