/**
 * Admin → Preseason — run a preseason EXHIBITION game. Sync a preseason week's schedule,
 * generate the owner exhibition matchups, and enter scores. Everything is flagged
 * `isExhibition` and never affects the real standings. Season via `?season=`, preseason week
 * via `?pre=`.
 */
import type { Metadata } from 'next';
import { CalendarClock } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { requireAdmin } from '@/lib/auth-helpers';
import { getSeasonOptions } from '@/lib/standings/query';
import { getPreseasonView } from '@/lib/preseason/query';
import { toExhibitionWeek, MAX_PRESEASON_WEEK } from '@/lib/schedule/preseason';
import { formatPoints } from '@/lib/utils';

import { PasteScoresForm, PreseasonWeekSelect, SyncForm } from './preseason-forms';

export const metadata: Metadata = { title: 'Preseason', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminPreseasonPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const seasons = await getSeasonOptions();
  if (seasons.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Preseason" description="Run a preseason exhibition game." />
        <EmptyState icon={CalendarClock} title="No seasons yet" description="Create a season first." />
      </div>
    );
  }

  const reqSeason = Number(Array.isArray(sp.season) ? sp.season[0] : sp.season);
  const seasonId = seasons.some((s) => s.id === reqSeason) ? reqSeason : seasons[0].id;
  const reqPre = Number(Array.isArray(sp.pre) ? sp.pre[0] : sp.pre);
  const preseasonWeek = Number.isInteger(reqPre) && reqPre >= 1 && reqPre <= MAX_PRESEASON_WEEK ? reqPre : 2;

  // Show whatever exhibition matchups exist for the CHOSEN preseason week (if synced).
  const view = await getPreseasonView(seasonId, toExhibitionWeek(preseasonWeek));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Preseason (exhibition)"
        description="Run a for-fun preseason game. Matchups + scores are flagged as exhibition and never affect standings, seeding, or payouts."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <SeasonSelector seasons={seasons} selectedId={seasonId} />
            <PreseasonWeekSelect seasonId={seasonId} selected={preseasonWeek} />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>1 · Sync schedule</CardTitle>
            <CardDescription>Pull the preseason week + generate exhibition matchups.</CardDescription>
          </CardHeader>
          <CardBody>
            <SyncForm seasonId={seasonId} preseasonWeek={preseasonWeek} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>2 · Enter scores</CardTitle>
            <CardDescription>Paste each team&apos;s DraftKings total.</CardDescription>
          </CardHeader>
          <CardBody>
            <PasteScoresForm seasonId={seasonId} preseasonWeek={preseasonWeek} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Exhibition matchups — Preseason week {preseasonWeek}</CardTitle>
            <Badge variant="tie">Exhibition · doesn&apos;t count</Badge>
          </div>
          <CardDescription>What the public /preseason page shows.</CardDescription>
        </CardHeader>
        <CardBody>
          {!view.hasData || view.games.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No exhibition matchups yet"
              description="Use “Sync & generate matchups” above (owners must be assigned for this season)."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Home</TH>
                  <TH align="right">Pts</TH>
                  <TH>Away</TH>
                  <TH align="right">Pts</TH>
                  <TH>Winner</TH>
                </TR>
              </THead>
              <TBody>
                {view.games.map((g) => (
                  <TR key={g.id}>
                    <TD className={g.home.isWinner ? 'font-semibold text-foreground' : ''}>
                      {g.home.teamKey} · {g.home.ownerName}
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {g.home.points !== null ? formatPoints(g.home.points) : '—'}
                    </TD>
                    <TD className={g.away.isWinner ? 'font-semibold text-foreground' : ''}>
                      {g.away.teamKey} · {g.away.ownerName}
                    </TD>
                    <TD align="right" className="tabular-nums">
                      {g.away.points !== null ? formatPoints(g.away.points) : '—'}
                    </TD>
                    <TD>
                      {g.isTie ? (
                        <Badge variant="tie">Tie</Badge>
                      ) : g.winnerOwnerSeasonId !== null ? (
                        <Badge variant="win">
                          {(g.home.isWinner ? g.home : g.away).teamKey}
                        </Badge>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
