/**
 * Standings — Server Component. Renders LIVE per-conference, per-division
 * head-to-head standings for the selected season, with playoff tags (DIV / WC /
 * #1 BYE) computed from the conference seeding. Season is chosen via
 * `?season=<id>`, defaulting to the most recent season that has data.
 */
import type { Metadata } from "next";
import { ListOrdered } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { SeasonSelector } from "@/components/season-selector";
import { TeamLogo } from "@/components/team-logo";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import {
  getSeasonOptions,
  getDefaultStandingsSeasonId,
  getStandingsView,
  type PlayoffTag,
  type StandingsViewRow,
} from "@/lib/standings/query";
import type { Conference, Division } from "@/lib/standings";
import { formatPoints } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Standings",
  description:
    "Head-to-head standings for KeyLehr H2H — W-L-T records, Points For / Against, and streaks across both conferences, grouped by division with live playoff seeding tags.",
};

const CONFERENCES: Conference[] = ["AFC", "NFC"];
const DIVISIONS: Division[] = ["East", "North", "South", "West"];

/** Render the playoff tag for a standings row as a Badge, or nothing. */
function PlayoffBadge({ tag }: { tag: PlayoffTag }) {
  if (!tag) return null;
  if (tag.kind === "bye") {
    return <Badge variant="bye">1 · Bye</Badge>;
  }
  if (tag.kind === "div") {
    return <Badge variant="div">Div</Badge>;
  }
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
  const caption = `${conference} ${division}`;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-subtle">
        {division}
      </h3>
      <Table>
        <caption className="sr-only">{caption} standings</caption>
        <THead>
          <TR>
            <TH align="center" className="w-10">
              #
            </TH>
            <TH>Team &amp; Owner</TH>
            <TH>DK Entry</TH>
            <TH align="right">W</TH>
            <TH align="right">L</TH>
            <TH align="right">T</TH>
            <TH align="right">PCT</TH>
            <TH align="right">PF</TH>
            <TH align="right">PA</TH>
            <TH align="right">STRK</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.ownerSeasonId}>
              <TD align="center" className="tabular-nums text-subtle">
                {r.rank}
              </TD>
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
              <TD className="text-muted">{r.dkEntryName ?? "—"}</TD>
              <TD align="right" className="tabular-nums font-medium">
                {r.wins}
              </TD>
              <TD align="right" className="tabular-nums">
                {r.losses}
              </TD>
              <TD align="right" className="tabular-nums">
                {r.ties}
              </TD>
              <TD align="right" className="tabular-nums">
                {r.winPct.toFixed(3)}
              </TD>
              <TD align="right" className="tabular-nums">
                {formatPoints(r.pointsFor)}
              </TD>
              <TD align="right" className="tabular-nums">
                {formatPoints(r.pointsAgainst)}
              </TD>
              <TD align="right" className="tabular-nums">
                {r.streak || "—"}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export default async function StandingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  const requested = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const requestedId = requested ? Number(requested) : NaN;
  const validRequested =
    !Number.isNaN(requestedId) && seasons.some((s) => s.id === requestedId);
  const defaultId = await getDefaultStandingsSeasonId();
  const selectedId = validRequested ? requestedId : (defaultId ?? seasons[0]?.id);

  const selectedSeason = seasons.find((s) => s.id === selectedId) ?? null;
  const view =
    selectedId !== undefined
      ? await getStandingsView(selectedId)
      : { hasData: false } as Awaited<ReturnType<typeof getStandingsView>>;

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow={selectedSeason ? selectedSeason.name : "Standings"}
        title="Standings"
        description="Head-to-head records by conference and division, with Points For / Against and current streaks. Tiebreakers run head-to-head → Points For → Points Against."
        actions={
          selectedId !== undefined ? (
            <SeasonSelector seasons={seasons} selectedId={selectedId} />
          ) : null
        }
      />

      {!view.hasData ? (
        <EmptyState
          icon={ListOrdered}
          title="No standings yet for this season"
          description="This season has no owners or scored games yet. Pick another season above, or check back once weekly DraftKings scores begin posting."
        />
      ) : (
        <div className="flex flex-col gap-12">
          {CONFERENCES.map((conf) => (
            <section key={conf} aria-label={`${conf} standings`} className="flex flex-col gap-5">
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold tracking-tight text-foreground">
                  {conf}
                </h2>
                <Badge variant="accent">Conference</Badge>
              </div>
              <div className="grid gap-6 lg:grid-cols-2">
                {DIVISIONS.map((div) => (
                  <DivisionTable
                    key={`${conf}-${div}`}
                    conference={conf}
                    division={div}
                    rows={view.byConference[conf][div]}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}
