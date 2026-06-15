/**
 * Playoff Picture — Server Component. Renders the LIVE "as if the season ended
 * today" seeding for the selected season: 7 seeds per conference in order, with
 * DIV / WC tags and a first-round bye for the #1 seed. Season is chosen via
 * `?season=<id>`, defaulting to the most recent season that has data.
 */
import type { Metadata } from "next";
import { Trophy } from "lucide-react";

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
  getPlayoffPicture,
  type PlayoffSeedRow,
} from "@/lib/standings/query";
import type { Conference } from "@/lib/standings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Playoff Picture",
  description:
    "The KeyLehr H2H playoff picture — NFL-style seeding with four division winners and three wild cards per conference, and a bye for the #1 seed, computed live from the standings.",
};

const CONFERENCES: Conference[] = ["AFC", "NFC"];

function SeedTag({ row }: { row: PlayoffSeedRow }) {
  if (row.isBye) return <Badge variant="bye">Bye</Badge>;
  if (row.kind === "division_winner") return <Badge variant="div">Div</Badge>;
  return <Badge variant="wc">WC</Badge>;
}

function ConferenceSeeds({
  conference,
  seeds,
}: {
  conference: Conference;
  seeds: PlayoffSeedRow[];
}) {
  return (
    <section aria-label={`${conference} playoff seeding`} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold tracking-tight text-foreground">{conference}</h2>
        <Badge variant="accent">7 Seeds</Badge>
      </div>
      <Table>
        <caption className="sr-only">{conference} playoff seeding</caption>
        <THead>
          <TR>
            <TH align="center" className="w-12">
              Seed
            </TH>
            <TH>Team &amp; Owner</TH>
            <TH align="right">Record</TH>
            <TH align="center">Status</TH>
          </TR>
        </THead>
        <TBody>
          {seeds.map((row) => (
            <TR
              key={row.ownerSeasonId}
              className={row.isBye ? "bg-accent/5" : undefined}
            >
              <TD align="center" className="text-lg font-bold tabular-nums text-accent">
                {row.seed}
              </TD>
              <TD>
                <div className="flex items-center gap-2">
                  <TeamLogo src={row.logoEspn} alt={`${row.teamName} logo`} size={24} />
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground">
                      {row.teamKey} · {row.teamName}
                    </span>
                    <span className="text-xs text-muted">
                      {row.ownerName} · {row.conference} {row.division}
                    </span>
                  </div>
                </div>
              </TD>
              <TD align="right" className="tabular-nums">
                {row.wins}-{row.losses}
                {row.ties ? `-${row.ties}` : ""}
              </TD>
              <TD align="center">
                <SeedTag row={row} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </section>
  );
}

export default async function PlayoffsPage({
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
  const picture =
    selectedId !== undefined
      ? await getPlayoffPicture(selectedId)
      : { hasData: false } as Awaited<ReturnType<typeof getPlayoffPicture>>;

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow={selectedSeason ? selectedSeason.name : "Playoff Picture"}
        title="Playoff Picture"
        description="Seven seeds per conference — four division winners and three wild cards. The #1 seed earns a first-round bye. Shown as if the season ended today."
        actions={
          selectedId !== undefined ? (
            <SeasonSelector seasons={seasons} selectedId={selectedId} />
          ) : null
        }
      />

      {!picture.hasData ? (
        <EmptyState
          icon={Trophy}
          title="No playoff picture yet for this season"
          description="This season has no owners or scored games yet. Pick another season above, or check back as the playoff race develops."
        />
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          {CONFERENCES.map((conf) => (
            <ConferenceSeeds key={conf} conference={conf} seeds={picture.byConference[conf]} />
          ))}
        </div>
      )}
    </Container>
  );
}
