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
import type { Conference, TieH2hRecord, TiebreakerReason } from "@/lib/standings";
import { eq } from "drizzle-orm";
import { db, seasons as seasonsTable } from "@/db";
import { getSeasonRules } from "@/lib/rules/schema";
import { formatPoints } from "@/lib/utils";

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
  if (row.kind === "wild_card") return <Badge variant="wc">WC</Badge>;
  return null;
}

const REASON_LABEL: Record<Exclude<TiebreakerReason, "none">, string> = {
  h2h: "Head-to-head record",
  pf: "Points For",
  pa: "Points Against",
};

interface TieGroup {
  letter: string;
  legend: string;
}

function teamLabel(r: PlayoffSeedRow): string {
  return r.teamKey;
}

/**
 * The legend text for one tied group. For a straightforward 2-owner tie — the common case,
 * and the only one precise enough to state plainly — names the actual matchup or numbers:
 * the head-to-head record, or both owners' real Points For/Against. A larger group falls back
 * to the bare rule name(s) that applied anywhere in its recursive resolution (`fallbackReasons`
 * — see `rankCohortWithReasons` in tiebreakers.ts for why a 3+ group can involve more than one
 * rule), since no single sentence states a multi-step resolution precisely.
 */
function describeTie(
  group: PlayoffSeedRow[],
  winner: PlayoffSeedRow,
  reason: TiebreakerReason,
  h2h: TieH2hRecord | null,
  fallbackReasons: TiebreakerReason[],
): string {
  const other = group.length === 2 ? group.find((r) => r.ownerSeasonId !== winner.ownerSeasonId) : undefined;

  if (other && reason === "h2h" && h2h) {
    const record = `${h2h.wins}-${h2h.losses}${h2h.ties ? `-${h2h.ties}` : ""}`;
    return `${REASON_LABEL.h2h}: ${teamLabel(winner)} ${record} over ${teamLabel(other)}`;
  }
  if (other && reason === "pf") {
    return `${REASON_LABEL.pf}: ${teamLabel(winner)} ${formatPoints(winner.pointsFor)} vs ${teamLabel(other)} ${formatPoints(other.pointsFor)}`;
  }
  if (other && reason === "pa") {
    return `${REASON_LABEL.pa}: ${teamLabel(winner)} ${formatPoints(winner.pointsAgainst)} vs ${teamLabel(other)} ${formatPoints(other.pointsAgainst)}`;
  }

  const order: Exclude<TiebreakerReason, "none">[] = ["h2h", "pf", "pa"];
  const present = order.filter((r) => fallbackReasons.includes(r));
  return present.length ? present.map((r) => REASON_LABEL[r]).join(", then ") : "Seeding tiebreaker";
}

/**
 * Letters tied owners (A, B, C…) and, for each group, explains the actual matchup or numbers
 * that decided it. A row can carry more than one letter (see below), so the result maps each
 * owner to a LIST.
 *
 * Three separate things get explained, lettered in the order they are actually decided —
 * conflating any two would letter owners together who were never actually compared:
 *
 *  1. WITHIN one division, who wins it at all — lettered FIRST, because this is logically
 *     upstream of everything else (you cannot rank the division winners against each other,
 *     or seed the wild-card pool, until you know who each division's winner even is). Found
 *     by (division, win%) since the two owners end up far apart once seeded: e.g. two 4-0
 *     owners in the same division, one seeded 1st, the other not guaranteed a spot at all.
 *  2. The four division winners, ranked against EACH OTHER for seeds 1-4.
 *  3. Everyone else (wild cards + out-of-field), ranked against each other for seeds 5+.
 *
 * (2) and (3) only compare within their own competition — a division winner and a wild card
 * are never tiebroken against each other just because they share a record, since the division
 * winner outseeds every wild card by rule regardless of record. A tie spanning the seed
 * cutline WITHIN one competition (e.g. the last wild card vs. the first team out) still gets
 * one letter across both — that's a real tie, and usually the single most-asked-about one on
 * the page alongside the division case. A group entirely outside the playoff field (nobody in
 * it made it) gets no letter at all — there's no "why them and not you" story when neither did.
 */
function buildTieGroups(rows: PlayoffSeedRow[]): {
  letterByOwner: Map<number, string[]>;
  groups: TieGroup[];
} {
  const letterByOwner = new Map<number, string[]>();
  const groups: TieGroup[] = [];

  function addLetter(ownerSeasonId: number, letter: string) {
    const existing = letterByOwner.get(ownerSeasonId);
    if (existing) existing.push(letter);
    else letterByOwner.set(ownerSeasonId, [letter]);
  }

  // (1): division-title ties, decided before anything else. `divisionTieReason` is only ever
  // set on the winner, which is exactly the signal that this division's title was contested.
  const winnersWithDivisionTie = rows.filter(
    (r) => r.kind === "division_winner" && r.divisionTieReason !== "none",
  );
  for (const winner of winnersWithDivisionTie) {
    const group = rows.filter((r) => r.division === winner.division && r.winPct === winner.winPct);
    const letter = String.fromCharCode(65 + groups.length);
    const legend = `Won the division — ${describeTie(group, winner, winner.divisionTieReason, winner.divisionTieH2h, [winner.divisionTieReason])}`;
    groups.push({ letter, legend });
    for (const row of group) addLetter(row.ownerSeasonId, letter);
  }

  // (2) and (3): consecutive runs within each competition's own seed order.
  function scanPool(segment: PlayoffSeedRow[]) {
    let i = 0;
    while (i < segment.length) {
      let j = i + 1;
      while (j < segment.length && segment[j].winPct === segment[i].winPct) j++;
      const group = segment.slice(i, j);
      if (group.length > 1 && group.some((r) => r.kind !== "out_of_field")) {
        const letter = String.fromCharCode(65 + groups.length);
        const winner = group[0]; // segment is already best-first
        const legend = describeTie(
          group,
          winner,
          winner.tieReason,
          winner.tieH2h,
          group.map((r) => r.tieReason),
        );
        groups.push({ letter, legend });
        for (const row of group) addLetter(row.ownerSeasonId, letter);
      }
      i = j;
    }
  }
  scanPool(rows.filter((r) => r.kind === "division_winner"));
  scanPool(rows.filter((r) => r.kind !== "division_winner"));

  return { letterByOwner, groups };
}

function TieLetters({ letters }: { letters?: string[] }) {
  if (!letters || letters.length === 0) return null;
  return (
    <>
      {letters.map((letter) => (
        <span
          key={letter}
          className="inline-flex size-4 items-center justify-center rounded-full border border-border-strong text-[10px] font-bold text-muted"
          aria-label={`Tiebreaker group ${letter}`}
        >
          {letter}
        </span>
      ))}
    </>
  );
}

function SeedRow({
  row,
  letters,
  variant,
}: {
  row: PlayoffSeedRow;
  letters?: string[];
  variant: "field" | "bubble";
}) {
  return (
    <TR className={row.isBye ? "bg-accent/5" : undefined}>
      <TD
        align="center"
        className={
          variant === "field"
            ? "text-lg font-bold tabular-nums text-accent"
            : "tabular-nums text-muted"
        }
      >
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
        <span className="inline-flex items-center gap-1.5">
          <TieLetters letters={letters} />
          {row.wins}-{row.losses}
          {row.ties ? `-${row.ties}` : ""}
        </span>
      </TD>
      <TD align="center">
        <SeedTag row={row} />
      </TD>
    </TR>
  );
}

function ConferenceSeeds({
  conference,
  seeds,
}: {
  conference: Conference;
  seeds: PlayoffSeedRow[];
}) {
  const field = seeds.filter((s) => s.kind !== "out_of_field");
  const bubble = seeds.filter((s) => s.kind === "out_of_field");
  const { letterByOwner, groups } = buildTieGroups(seeds);

  return (
    <section aria-label={`${conference} playoff seeding`} className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-bold tracking-tight text-foreground">{conference}</h3>
        <Badge variant="accent">{field.length} Seeds</Badge>
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
          {field.map((row) => (
            <SeedRow
              key={row.ownerSeasonId}
              row={row}
              letters={letterByOwner.get(row.ownerSeasonId)}
              variant="field"
            />
          ))}
        </TBody>
      </Table>

      {bubble.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-foreground">
            Also in the picture ({bubble.length})
          </summary>
          <Table className="mt-3">
            <caption className="sr-only">{conference} owners outside the playoff field</caption>
            <TBody>
              {bubble.map((row) => (
                <SeedRow
                  key={row.ownerSeasonId}
                  row={row}
                  letters={letterByOwner.get(row.ownerSeasonId)}
                  variant="bubble"
                />
              ))}
            </TBody>
          </Table>
        </details>
      )}

      {groups.length > 0 && (
        <p className="text-xs text-muted">
          {groups.map(({ letter, legend }, i) => (
            <span key={letter}>
              {i > 0 && "  ·  "}
              <span className="font-semibold">{letter}</span> — {legend}
            </span>
          ))}
        </p>
      )}
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
  const seasonRules = getSeasonRules(seasonRow?.rules);
  const playoffRules = seasonRules.playoffs;
  const byeCount = playoffRules.topSeedByes;
  const tiebreakerOrder = seasonRules.tiebreakers.map((r) => REASON_LABEL[r]).join(", then ");
  const pictureDescription =
    `${playoffRules.teamsPerConference} seeds per conference — ${playoffRules.divisionWinnersPerConference} division ` +
    `winners and ${playoffRules.wildCardsPerConference} wild cards. ` +
    (byeCount > 0
      ? `The top ${byeCount === 1 ? "seed earns" : `${byeCount} seeds earn`} a first-round bye. `
      : "") +
    `Shown as if the season ended today. Ties are broken by ${tiebreakerOrder} — ` +
    "the lettered groups below show exactly where that applied.";

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
