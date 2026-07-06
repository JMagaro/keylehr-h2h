/**
 * Head-to-Head Records — Server Component. Shows one selected owner's all-time
 * W-L-T record against every opponent they've faced across all seasons.
 *
 * Owner is chosen via `?owner=<ownerId>`, defaulting to the first owner
 * alphabetically. All aggregation is done from `getAllTimeRivalries()`, which
 * de-duplicates by PERSON across seasons (same owner, different team each year,
 * rolls up to a single record).
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Swords, ArrowLeft, ChevronDown } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { Card, CardBody } from "@/components/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import { OwnerSelector } from "@/components/owner-selector";
import { getAllTimeRivalries, type OwnerIdentity } from "@/lib/history";
import { formatPoints, winPct } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Head-to-Head Records | History",
  description:
    "All-time head-to-head record for any KeyLehr H2H owner against every opponent, aggregated across every season.",
};

function record(w: number, l: number, t: number): string {
  return t > 0 ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function pct(w: number, l: number, t: number): string {
  return (winPct(w, l, t) * 100).toFixed(1) + "%";
}

interface OpponentGame {
  seasonId: number;
  year: number;
  week: number;
  /** Selected owner's points / opponent's points for this meeting. */
  points: number;
  oppPoints: number;
}

interface OpponentRow {
  opponent: OwnerIdentity;
  wins: number;
  losses: number;
  ties: number;
  meetings: number;
  games: OpponentGame[];
}

/** One opponent's summary row, expandable (no client JS) to the game-by-game log. */
function OpponentDetail({ row }: { row: OpponentRow }) {
  const wPct = winPct(row.wins, row.losses, row.ties);
  const leads = row.wins > row.losses;
  const trails = row.losses > row.wins;

  return (
    <details className="group rounded-xl border border-border bg-card shadow-sm open:shadow-md">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:gap-4">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-medium text-foreground">{row.opponent.ownerName}</span>
        </span>

        <span className="flex shrink-0 items-center gap-4 text-sm">
          <span className="tabular-nums font-semibold">
            <span className={leads ? "text-win" : "text-foreground"}>{row.wins}</span>
            <span className="px-0.5 text-subtle">-</span>
            <span className={trails ? "text-loss" : "text-foreground"}>{row.losses}</span>
            {row.ties > 0 ? <span className="text-subtle">{`-${row.ties}`}</span> : null}
          </span>
          <span className="hidden tabular-nums text-muted sm:inline">
            {row.meetings} mtg{row.meetings === 1 ? "" : "s"}
          </span>
          <Badge variant={leads ? "win" : trails ? "loss" : "neutral"}>
            {(wPct * 100).toFixed(1)}%
          </Badge>
          <ChevronDown
            className="size-4 shrink-0 text-subtle transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>

      <div className="border-t border-border px-4 py-3">
        <Table>
          <caption className="sr-only">
            Game-by-game results vs. {row.opponent.ownerName}
          </caption>
          <THead>
            <TR>
              <TH>Season</TH>
              <TH align="center">Week</TH>
              <TH align="right">You</TH>
              <TH align="right">Opp</TH>
              <TH align="right">Result</TH>
            </TR>
          </THead>
          <TBody>
            {row.games.map((g) => {
              const won = g.points > g.oppPoints;
              const tied = g.points === g.oppPoints;
              return (
                <TR key={`${g.seasonId}:${g.week}`}>
                  <TD className="tabular-nums">{g.year}</TD>
                  <TD align="center" className="tabular-nums text-muted">
                    {g.week}
                  </TD>
                  <TD align="right" className="tabular-nums font-semibold text-foreground">
                    {formatPoints(g.points)}
                  </TD>
                  <TD align="right" className="tabular-nums text-muted">
                    {formatPoints(g.oppPoints)}
                  </TD>
                  <TD align="right">
                    <Badge variant={won ? "win" : tied ? "tie" : "loss"}>
                      {won ? "W" : tied ? "T" : "L"}
                    </Badge>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </details>
  );
}

export default async function HeadToHeadPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rivalryData = await getAllTimeRivalries();

  // All owners sorted alphabetically for the selector.
  const allOwners = [...rivalryData.ownersById.values()].sort((a, b) =>
    a.ownerName.localeCompare(b.ownerName),
  );

  if (allOwners.length === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
        <PageHeader
          eyebrow={
            <Link href="/history" className="flex items-center gap-1 hover:underline">
              <ArrowLeft className="size-3" aria-hidden="true" />
              History
            </Link>
          }
          title="Head-to-Head Records"
          description="All-time record for any owner against every opponent, across all seasons."
        />
        <EmptyState
          icon={Swords}
          title="No data yet"
          description="Head-to-head records will appear once games have been played and scored."
        />
      </Container>
    );
  }

  // Resolve selected owner — default to first alphabetically.
  const rawParam = Array.isArray(sp.owner) ? sp.owner[0] : sp.owner;
  const requestedId = rawParam ? parseInt(rawParam, 10) : NaN;
  const selectedId =
    !Number.isNaN(requestedId) && rivalryData.ownersById.has(requestedId)
      ? requestedId
      : allOwners[0]!.ownerId;

  const selectedOwner = rivalryData.ownersById.get(selectedId)!;

  // Per-opponent rows: filter rivalries involving the selected owner and flip
  // the A/B orientation so wins/losses are always from the selected owner's POV.
  const opponents: OpponentRow[] = rivalryData.rivalries
    .filter(
      (r) =>
        r.ownerA.ownerId === selectedId || r.ownerB.ownerId === selectedId,
    )
    .map((r) => {
      const isA = r.ownerA.ownerId === selectedId;
      return {
        opponent: isA ? r.ownerB : r.ownerA,
        wins: isA ? r.aWins : r.bWins,
        losses: isA ? r.bWins : r.aWins,
        ties: r.ties,
        meetings: r.meetings,
        games: r.games.map((g) => ({
          seasonId: g.seasonId,
          year: g.year,
          week: g.week,
          points: isA ? g.aPoints : g.bPoints,
          oppPoints: isA ? g.bPoints : g.aPoints,
        })),
      };
    })
    .sort(
      (a, b) =>
        b.meetings - a.meetings ||
        a.opponent.ownerName.localeCompare(b.opponent.ownerName),
    );

  // Overall record across all opponents.
  const overall = rivalryData.ownerRecord(selectedId);

  return (
    <Container width="wide" as="div" className="flex flex-col gap-10 py-10">
      <PageHeader
        eyebrow={
          <Link
            href="/history"
            className="flex items-center gap-1 hover:underline"
          >
            <ArrowLeft className="size-3" aria-hidden="true" />
            History
          </Link>
        }
        title="Head-to-Head Records"
        description="All-time record for any owner against every opponent, aggregated across all seasons."
        actions={
          <OwnerSelector
            owners={allOwners.map((o) => ({
              ownerId: o.ownerId,
              ownerName: o.ownerName,
            }))}
            selectedId={selectedId}
          />
        }
      />

      {/* Overall summary card */}
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-lg font-bold tracking-tight text-foreground">
                {selectedOwner.ownerName}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-2xl font-bold tabular-nums text-foreground">
                {record(overall.wins, overall.losses, overall.ties)}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                All-time record
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-2xl font-bold tabular-nums text-foreground">
                {pct(overall.wins, overall.losses, overall.ties)}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Win %
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-2xl font-bold tabular-nums text-foreground">
                {overall.meetings}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Games
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Per-opponent breakdown */}
      <section aria-label="Head-to-head breakdown" className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Swords className="size-5 text-accent" aria-hidden="true" />
          <h2 className="text-xl font-bold tracking-tight text-foreground">
            vs. Every Opponent
          </h2>
          <Badge variant="neutral">{opponents.length} opponent{opponents.length === 1 ? "" : "s"}</Badge>
        </div>

        {opponents.length === 0 ? (
          <EmptyState
            icon={Swords}
            title="No matchups recorded"
            description="This owner hasn't played any scored head-to-head games yet against any opponent."
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Click an opponent to see the game-by-game results behind the record.
            </p>
            {opponents.map((row) => (
              <OpponentDetail key={row.opponent.ownerId} row={row} />
            ))}
          </div>
        )}
      </section>
    </Container>
  );
}
