/**
 * Admin → Lineups — capture status for DraftKings rosters.
 *
 * Rosters power the /live estimate: capture each owner's lineup once (authenticated), then
 * the app recomputes points from ESPN's public boxscore during games, so no machine has to
 * sit polling DraftKings all week.
 *
 * Season via `?season=`, week via `?week=` (regular 1–25 or preseason exhibition 101–103).
 *
 * NOTHING on this page is a score. See docs/SCORING.md §15.
 */
import type { Metadata } from 'next';
import { ClipboardList } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { Table, TBody, TD, TH, THead, TR } from '@/components/data-table';
import { requireAdmin } from '@/lib/auth-helpers';
import { getCaptureStatus } from '@/lib/lineups/query';
import { isExhibitionWeek, exhibitionWeekLabel } from '@/lib/schedule/preseason';
import { getSeasonOptions } from '@/lib/standings/query';
import {
  MAX_EXHIBITION_WEEK,
  MAX_REGULAR_WEEK,
  MIN_EXHIBITION_WEEK,
} from '@/lib/ingest/week-schema';

import { PasteLineupsForm } from './lineups-form';

export const metadata: Metadata = { title: 'Lineups', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function weekLabel(week: number): string {
  return isExhibitionWeek(week) ? exhibitionWeekLabel(week) : `Week ${week}`;
}

function formatWhen(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function AdminLineupsPage({
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
        <PageHeader eyebrow="Admin" title="Lineups" description="Capture DraftKings rosters." />
        <EmptyState icon={ClipboardList} title="No seasons yet" description="Create a season first." />
      </div>
    );
  }

  const reqSeason = Number(Array.isArray(sp.season) ? sp.season[0] : sp.season);
  const seasonId = seasons.some((s) => s.id === reqSeason) ? reqSeason : seasons[0].id;

  const reqWeek = Number(Array.isArray(sp.week) ? sp.week[0] : sp.week);
  const legalWeek =
    Number.isInteger(reqWeek) &&
    ((reqWeek >= 1 && reqWeek <= MAX_REGULAR_WEEK) ||
      (reqWeek >= MIN_EXHIBITION_WEEK && reqWeek <= MAX_EXHIBITION_WEEK));
  const week = legalWeek ? reqWeek : 1;

  const status = await getCaptureStatus(seasonId, week);
  const captured = status.lineups.length;

  // "Captured 32/32" means 32 owners have a roster — NOT that all 288 players are known.
  // DraftKings conceals a player until that player's game kicks off, so a capture taken at
  // the 1pm lock legitimately hides the whole late slate. Counting both separately is the
  // difference between "this worked" and "this is still filling in".
  const totalSlots = status.lineups.reduce((n, l) => n + l.slots.length, 0);
  const revealedSlots = status.lineups.reduce(
    (n, l) => n + l.slots.filter((s) => s.revealed).length,
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Lineups (roster capture)"
        description="Captured DraftKings rosters power the live estimate. They never affect standings, seeding, or payouts — the DraftKings leaderboard remains the official score."
        actions={<SeasonSelector seasons={seasons} selectedId={seasonId} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {weekLabel(week)} — captured {captured}/{status.expected}
          </CardTitle>
          <CardDescription>
            {captured > 0 ? (
              <>
                {revealedSlots}/{totalSlots} players revealed. DraftKings hides a player from
                opponents until that player&apos;s game kicks off, so a capture taken at lock
                shows only the early slate — a concealed player has scored nothing yet, so no
                points are missing, only names.{' '}
              </>
            ) : null}
            Rosters in effect are the newest capture per owner. DraftKings Classic allows late
            swap, so re-capturing later in the week is what keeps the estimate honest.
          </CardDescription>
        </CardHeader>
        <CardBody>
          {captured === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No lineups captured for this week"
              description="Use the Chrome extension, or paste a DraftKings roster payload below."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Owner</TH>
                  <TH>Team</TH>
                  <TH>Slots</TH>
                  <TH>Revealed</TH>
                  <TH>Captured</TH>
                </TR>
              </THead>
              <TBody>
                {status.lineups.map((l) => {
                  // Fewer than nine SLOTS means the payload was partial — a real problem,
                  // unlike concealed players, which are expected before kickoff.
                  const short = l.slots.length < 9;
                  const revealed = l.slots.filter((s) => s.revealed).length;
                  const pending = l.slots.length - revealed;
                  return (
                    <TR key={l.ownerSeasonId}>
                      <TD>{l.ownerName}</TD>
                      <TD>{l.teamKey ?? '—'}</TD>
                      <TD>
                        {l.slots.length}
                        {short ? (
                          <Badge variant="tie" className="ml-2">
                            incomplete
                          </Badge>
                        ) : null}
                      </TD>
                      <TD>
                        {revealed}
                        {pending > 0 ? (
                          <span className="ml-2 text-xs text-muted">{pending} yet to play</span>
                        ) : null}
                      </TD>
                      <TD>{formatWhen(l.capturedAt)}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paste rosters</CardTitle>
          <CardDescription>
            Fallback for when the extension can&apos;t reach DraftKings. Paste the raw response —
            it is parsed structurally, so the exact shape does not matter.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <PasteLineupsForm seasonId={seasonId} week={week} />
        </CardBody>
      </Card>

      {status.runs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent capture runs</CardTitle>
            <CardDescription>
              Audit trail for {weekLabel(week)}. `Source URL` records which DraftKings endpoint
              actually worked.
            </CardDescription>
          </CardHeader>
          <CardBody>
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Status</TH>
                  <TH>Matched</TH>
                  <TH>By</TH>
                  <TH>Source URL</TH>
                </TR>
              </THead>
              <TBody>
                {status.runs.map((r) => (
                  <TR key={r.id}>
                    <TD>{formatWhen(r.createdAt)}</TD>
                    <TD>
                      <Badge variant={r.status === 'success' ? 'win' : r.status === 'partial' ? 'tie' : 'loss'}>
                        {r.status}
                      </Badge>
                    </TD>
                    <TD>
                      {r.entriesMatched}/{r.entriesTotal}
                      {r.entriesUnmatched > 0 ? ` (${r.entriesUnmatched} unmatched)` : ''}
                    </TD>
                    <TD>{r.triggeredBy ?? '—'}</TD>
                    <TD className="max-w-xs truncate text-xs text-muted">
                      {r.sourceUrlTemplate ?? '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
