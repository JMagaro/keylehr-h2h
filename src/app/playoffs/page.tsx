/**
 * Playoffs — Server Component. The public postseason hub for the selected season,
 * composing three pieces top to bottom:
 *
 *   1. Playoff Picture — the LIVE "as if the season ended today" seeding: 7 seeds
 *      per conference, each tagged DIV / WC / Bye.
 *   2. Odds Tracker — each owner's playoff probability by week, from the
 *      Monte-Carlo odds simulation (538-style multi-line chart).
 *   3. Bracket — the round-by-round bracket once it's generated, ending in the
 *      Champion. Until generated, a friendly empty state.
 *
 * Season is chosen via `?season=<id>`, defaulting to the most recent season that
 * has data.
 */
import type { Metadata } from "next";
import { GitFork, LineChart, Trophy } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/badge";
import { SeasonSelector } from "@/components/season-selector";
import { TeamLogo } from "@/components/team-logo";
import { PlayoffBracket } from "@/components/playoff-bracket";
import { PlayoffOddsChart } from "@/components/playoff-odds-chart";
import { Table, THead, TBody, TR, TH, TD } from "@/components/data-table";
import {
  getSeasonOptions,
  getDefaultStandingsSeasonId,
  getPlayoffPicture,
  type PlayoffSeedRow,
} from "@/lib/standings/query";
import { getPlayoffBracket } from "@/lib/playoffs/service";
import { getOddsTrend } from "@/lib/odds/query";
import type { Conference } from "@/lib/standings";
import { eq } from "drizzle-orm";
import { db, seasons as seasonsTable } from "@/db";
import { getSeasonRules } from "@/lib/rules/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = {
  title: "Playoffs",
  description:
    "The KeyLehr H2H postseason — live playoff seeding, each owner's playoff odds by week from a Monte-Carlo simulation, and the round-by-round bracket through to the champion.",
};

const CONFERENCES: Conference[] = ["AFC", "NFC"];

/** A section heading shared by the three composed blocks. */
function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
      <p className="max-w-2xl text-sm text-muted">{description}</p>
    </div>
  );
}

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
    <section aria-label={`${conference} playoff seeding`} className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-bold tracking-tight text-foreground">{conference}</h3>
        <Badge variant="accent">{seeds.length} Seeds</Badge>
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

  // Load the three sections in parallel for the selected season.
  const [picture, bracket, trend] =
    selectedId !== undefined
      ? await Promise.all([
          getPlayoffPicture(selectedId),
          getPlayoffBracket(selectedId),
          getOddsTrend(selectedId),
        ])
      : ([
          { hasData: false, byConference: { AFC: [], NFC: [] } },
          {
            hasData: false,
            rounds: [],
            championOwnerSeasonId: null,
            championOwnerName: null,
            championTeamName: null,
          },
          { weeks: [], owners: [] },
        ] as [
          Awaited<ReturnType<typeof getPlayoffPicture>>,
          Awaited<ReturnType<typeof getPlayoffBracket>>,
          Awaited<ReturnType<typeof getOddsTrend>>,
        ]);

  const hasOdds = trend.weeks.length > 0 && trend.owners.length > 0;

  // Resolve the season's playoff rules so the seeding copy reflects the configured
  // format (the bracket/seeding engine is already rule-driven, so static copy here
  // could drift if the commissioner changes the playoff structure in Settings).
  const seasonRow =
    selectedId !== undefined
      ? (await db.select({ rules: seasonsTable.rules }).from(seasonsTable).where(eq(seasonsTable.id, selectedId)).limit(1))[0]
      : undefined;
  const playoffRules = getSeasonRules(seasonRow?.rules).playoffs;
  const byeCount = playoffRules.topSeedByes;
  const pictureDescription =
    `${playoffRules.teamsPerConference} seeds per conference — ${playoffRules.divisionWinnersPerConference} division ` +
    `winners and ${playoffRules.wildCardsPerConference} wild cards. ` +
    (byeCount > 0
      ? `The top ${byeCount === 1 ? "seed earns" : `${byeCount} seeds earn`} a first-round bye. `
      : "") +
    "Shown as if the season ended today.";

  return (
    <Container width="wide" as="div" className="flex flex-col gap-12 py-10">
      <PageHeader
        eyebrow={selectedSeason ? selectedSeason.name : "Playoffs"}
        title="Playoffs"
        description="The live playoff picture, each owner's playoff odds by week, and the round-by-round bracket through to the champion."
        actions={
          selectedId !== undefined ? (
            <SeasonSelector seasons={seasons} selectedId={selectedId} />
          ) : null
        }
      />

      {/* 1. Playoff Picture — live seeding. */}
      <section aria-label="Playoff picture" className="flex flex-col gap-6">
        <SectionHeading title="Playoff Picture" description={pictureDescription} />
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
      </section>

      {/* 2. Odds Tracker — playoff probability by week. */}
      <section aria-label="Playoff odds tracker" className="flex flex-col gap-6">
        <SectionHeading
          title="Odds Tracker"
          description="Each team's playoff probability by week, from a Monte-Carlo simulation. Search or hover a team to highlight its line; filter by conference to cut the clutter."
        />
        {!hasOdds ? (
          <EmptyState
            icon={LineChart}
            title="No playoff-odds snapshots yet"
            description="Odds are computed once the season has scored games. They'll appear here as the simulation runs each week."
          />
        ) : (
          <PlayoffOddsChart trend={trend} />
        )}
      </section>

      {/* 3. Bracket — round-by-round through to the champion. */}
      <section aria-label="Playoff bracket" className="flex flex-col gap-6">
        <SectionHeading
          title="Bracket"
          description="Wild Card through the Championship, filling in round by round as games are scored — ending with the league champion."
        />
        {!bracket.hasData ? (
          <EmptyState
            icon={GitFork}
            title="No bracket yet for this season"
            description="The bracket will appear once the regular season ends and the bracket is generated."
          />
        ) : (
          <PlayoffBracket bracket={bracket} />
        )}
      </section>
    </Container>
  );
}
