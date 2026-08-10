/**
 * Preseason — the exhibition game view. Shows the owner-vs-owner exhibition matchups for a
 * season's preseason week with scores + winners, clearly labeled as NOT counting toward the
 * standings. Exhibition data is the one thing the standings/stats queries exclude; this page
 * is the deliberate place it's read (see src/lib/preseason/query.ts).
 */
import type { Metadata } from 'next';
import { CalendarClock, Trophy } from 'lucide-react';

import { Container } from '@/components/container';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/badge';
import { Card, CardBody } from '@/components/card';
import { TeamLogo } from '@/components/team-logo';
import { SeasonSelector } from '@/components/season-selector';
import { getPreseasonSeasonOptions, getPreseasonView } from '@/lib/preseason/query';
import { formatPoints, cn } from '@/lib/utils';

export const metadata: Metadata = {
  title: 'Preseason',
  description:
    'KeyLehr H2H preseason exhibition games — owner-vs-owner matchups and scores that do not count toward the regular-season standings.',
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function PreseasonPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const seasons = await getPreseasonSeasonOptions();

  const header = (
    <PageHeader
      eyebrow="Exhibition"
      title="Preseason"
      description="Owner-vs-owner preseason exhibition games. Just for fun — these do not count toward the standings, seeding, or payouts."
      actions={
        seasons.length > 1 ? (
          <SeasonSelector seasons={seasons} selectedId={pickSeasonId(sp, seasons)} />
        ) : undefined
      }
    />
  );

  if (seasons.length === 0) {
    return (
      <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
        {header}
        <EmptyState
          icon={CalendarClock}
          title="No preseason game set up yet"
          description="When the commissioner runs a preseason exhibition (Admin → Preseason), the matchups and scores show up here — clearly separate from the real season."
        />
      </Container>
    );
  }

  const seasonId = pickSeasonId(sp, seasons);
  const view = await getPreseasonView(seasonId);

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      {header}

      <Card className="border-tie/30 bg-tie-soft/40">
        <CardBody className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-tie-soft text-tie">
            <CalendarClock className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm text-foreground">
            <span className="font-semibold">Exhibition{view.label ? ` · ${view.label}` : ''}.</span>{' '}
            A warm-up game — results here <span className="font-semibold">never</span> affect
            standings, playoff seeding, records, or payouts.
          </p>
        </CardBody>
      </Card>

      {!view.hasData || view.games.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No exhibition matchups for this season yet"
          description="Once the preseason schedule is synced and matchups are generated, they'll appear here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {view.games.map((g) => {
            const decided = g.winnerOwnerSeasonId !== null || g.isTie;
            return (
              <Card key={g.id} className="min-w-0">
                <CardBody className="flex flex-col gap-2">
                  {[g.home, g.away].map((p) => (
                    <div key={p.ownerSeasonId} className="flex items-center gap-3">
                      <TeamLogo src={p.logoEspn} alt={`${p.teamName} logo`} size={28} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={cn(
                            'flex items-center gap-1.5 truncate text-sm',
                            p.isWinner ? 'font-bold text-foreground' : 'font-medium text-muted',
                          )}
                        >
                          {p.teamKey} · {p.ownerName}
                          {p.isWinner ? (
                            <Trophy className="size-3.5 text-win" aria-hidden="true" />
                          ) : null}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'shrink-0 text-sm tabular-nums',
                          p.isWinner ? 'font-bold text-foreground' : 'text-muted',
                        )}
                      >
                        {p.points !== null ? formatPoints(p.points) : '—'}
                      </span>
                    </div>
                  ))}
                  {decided ? (
                    <div className="pt-1">
                      {g.isTie ? (
                        <Badge variant="tie">Tie</Badge>
                      ) : (
                        <Badge variant="win">
                          {(g.home.isWinner ? g.home : g.away).teamName} win
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-subtle">Not yet scored</span>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </Container>
  );
}

function pickSeasonId(
  sp: { [key: string]: string | string[] | undefined },
  seasons: { id: number }[],
): number {
  const raw = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const req = raw ? Number(raw) : NaN;
  return !Number.isNaN(req) && seasons.some((s) => s.id === req) ? req : seasons[0].id;
}
