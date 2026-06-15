/**
 * Admin → Playoffs — Server Component.
 *
 * The commissioner's control panel for the postseason: generate the wild-card
 * bracket from the configured regular-season seeding, set the DraftKings contest
 * ids for the playoff weeks (so the extension syncs playoff scores like any
 * week), advance the bracket, manually override a game winner, and see the live
 * bracket status + champion.
 *
 * Season is chosen via `?season=<id>`, defaulting to the most recent season with
 * data. Everything is driven by `src/lib/playoffs/service.ts`, which reads the
 * playoff structure from the season's rules — nothing here hardcodes the format.
 */
import type { Metadata } from 'next';
import { Trophy } from 'lucide-react';

import { eq } from 'drizzle-orm';

import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { db, weeklyContests } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { getPlayoffBracket, PLAYOFF_ROUND_WEEKS } from '@/lib/playoffs/service';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';
import type { PlayoffRound } from '@/lib/standings';

import {
  AdvanceBracketForm,
  ContestIdsForm,
  GenerateBracketForm,
  WinnerOverrideForm,
  type ContestDefault,
  type OverrideOption,
} from './playoff-forms';

export const metadata: Metadata = { title: 'Playoffs', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUND_LABELS: Record<PlayoffRound, string> = {
  wild_card: 'Wild Card',
  divisional: 'Divisional',
  conference: 'Conference',
  championship: 'Super Bowl',
};

const PLAYOFF_WEEKS: { week: number; round: PlayoffRound }[] = [
  { week: PLAYOFF_ROUND_WEEKS.wild_card, round: 'wild_card' },
  { week: PLAYOFF_ROUND_WEEKS.divisional, round: 'divisional' },
  { week: PLAYOFF_ROUND_WEEKS.conference, round: 'conference' },
  { week: PLAYOFF_ROUND_WEEKS.championship, round: 'championship' },
];

function fmtPts(p: number | null): string {
  return p === null ? '—' : p.toFixed(2);
}

export default async function AdminPlayoffsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  const requested = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const requestedId = requested ? Number(requested) : NaN;
  const validRequested = !Number.isNaN(requestedId) && seasons.some((s) => s.id === requestedId);
  const defaultId = await getDefaultStandingsSeasonId();
  const selectedId = validRequested ? requestedId : (defaultId ?? seasons[0]?.id);

  if (selectedId === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Playoffs" description="Generate, sync, and advance the playoff bracket." />
        <EmptyState
          icon={Trophy}
          title="No seasons to show"
          description="Create a season and assign owners to begin tracking the playoffs."
        />
      </div>
    );
  }

  const selectedSeason = seasons.find((s) => s.id === selectedId) ?? null;

  // Current playoff-week contest ids.
  const contestRows = await db
    .select({ week: weeklyContests.week, dkContestId: weeklyContests.dkContestId })
    .from(weeklyContests)
    .where(eq(weeklyContests.seasonId, selectedId));
  const contestIdByWeek = new Map(contestRows.map((r) => [r.week, r.dkContestId ?? '']));
  const contestDefaults: ContestDefault[] = PLAYOFF_WEEKS.map(({ week, round }) => ({
    week,
    round: ROUND_LABELS[round],
    dkContestId: contestIdByWeek.get(week) ?? '',
  }));

  const bracket = await getPlayoffBracket(selectedId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Playoffs"
        description="Generate the bracket from the configured seeding, sync playoff-week contests, advance rounds, and crown the champion."
        actions={<SeasonSelector seasons={seasons} selectedId={selectedId} />}
      />

      {/* Champion banner / status. */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Trophy className="size-5 text-accent" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                {selectedSeason?.name ?? 'Season'} champion
              </p>
              <p className="text-sm text-muted">
                {bracket.championOwnerName
                  ? `${bracket.championTeamName} — ${bracket.championOwnerName}`
                  : 'No champion recorded yet.'}
              </p>
            </div>
          </div>
          <Badge variant={bracket.championOwnerName ? 'win' : 'neutral'}>
            {bracket.championOwnerName ? 'Crowned' : bracket.hasData ? 'In progress' : 'No bracket'}
          </Badge>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Generate bracket</CardTitle>
            <CardDescription>Seed the wild-card round from the regular-season standings.</CardDescription>
          </CardHeader>
          <CardBody>
            <GenerateBracketForm seasonId={selectedId} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Advance bracket</CardTitle>
            <CardDescription>Resolve scored rounds and crown the champion.</CardDescription>
          </CardHeader>
          <CardBody>
            <AdvanceBracketForm seasonId={selectedId} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Playoff-week DraftKings contests</CardTitle>
          <CardDescription>
            Weeks {PLAYOFF_WEEKS.map((w) => w.week).join(', ')} — the extension uses these to sync
            playoff scores the same way as the regular season.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <ContestIdsForm seasonId={selectedId} defaults={contestDefaults} />
        </CardBody>
      </Card>

      {/* Live bracket + per-game override. */}
      <Card>
        <CardHeader>
          <CardTitle>Bracket status</CardTitle>
          <CardDescription>
            Read-only results per round. Use the override to set a game&rsquo;s winner manually (e.g.
            a forfeit or a game the sheet has no points for); it re-advances the bracket.
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-6">
          {!bracket.hasData ? (
            <EmptyState
              icon={Trophy}
              title="No bracket yet"
              description="Generate the bracket above once the regular season is scored."
            />
          ) : (
            bracket.rounds.map((rnd) => (
              <section key={rnd.round} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {ROUND_LABELS[rnd.round]}{' '}
                  <span className="text-xs font-normal text-subtle">· week {rnd.week}</span>
                </h3>
                <Table>
                  <THead>
                    <TR>
                      <TH>Conf</TH>
                      <TH>High seed</TH>
                      <TH align="right">Pts</TH>
                      <TH>Low seed</TH>
                      <TH align="right">Pts</TH>
                      <TH>Winner</TH>
                      <TH>Override</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {rnd.games.map((g) => {
                      const options: OverrideOption[] = [];
                      if (g.high.ownerSeasonId !== null) {
                        options.push({
                          ownerSeasonId: g.high.ownerSeasonId,
                          label: `${g.high.seed ?? '?'} ${g.high.teamName ?? '—'} / ${g.high.ownerName ?? '—'}`,
                        });
                      }
                      if (g.low.ownerSeasonId !== null) {
                        options.push({
                          ownerSeasonId: g.low.ownerSeasonId,
                          label: `${g.low.seed ?? '?'} ${g.low.teamName ?? '—'} / ${g.low.ownerName ?? '—'}`,
                        });
                      }
                      return (
                        <TR key={g.id}>
                          <TD className="text-muted">{g.conference ?? 'SB'}</TD>
                          <TD className={g.high.isWinner ? 'font-semibold text-foreground' : ''}>
                            {g.high.seed ?? '?'} {g.high.teamName ?? '—'}
                            <span className="block text-xs text-subtle">{g.high.ownerName ?? '—'}</span>
                          </TD>
                          <TD align="right" className="tabular-nums">
                            {fmtPts(g.high.points)}
                          </TD>
                          <TD className={g.low.isWinner ? 'font-semibold text-foreground' : ''}>
                            {g.low.seed ?? '?'} {g.low.teamName ?? '—'}
                            <span className="block text-xs text-subtle">{g.low.ownerName ?? '—'}</span>
                          </TD>
                          <TD align="right" className="tabular-nums">
                            {fmtPts(g.low.points)}
                          </TD>
                          <TD>
                            {g.winnerOwnerSeasonId === null ? (
                              <span className="text-subtle">—</span>
                            ) : (
                              <Badge variant="win">
                                {g.high.isWinner
                                  ? (g.high.teamName ?? 'High')
                                  : (g.low.teamName ?? 'Low')}
                              </Badge>
                            )}
                          </TD>
                          <TD className="min-w-56">
                            <WinnerOverrideForm
                              seasonId={selectedId}
                              playoffMatchupId={g.id}
                              options={options}
                              currentWinnerOwnerSeasonId={g.winnerOwnerSeasonId}
                            />
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              </section>
            ))
          )}
        </CardBody>
      </Card>
    </div>
  );
}
