/**
 * One live matchup: two owners, their running estimates, and an expandable 9-slot breakdown.
 *
 * The display rule that drives every branch here: a number we don't have is never rendered as
 * a number. `—` plus a reason, never `0.00`. See src/lib/live/assemble.ts.
 */
import { Badge } from '@/components/badge';
import { Card, CardBody } from '@/components/card';
import { TeamLogo } from '@/components/team-logo';
import type { LiveMatchup, LiveSlot, LiveTeam } from '@/lib/live/assemble';
import { formatPoints, cn } from '@/lib/utils';

/** Roster-slot display order, so both sides of a matchup line up row for row. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST'];

function slotRank(slot: string | null): number {
  const i = SLOT_ORDER.indexOf((slot ?? '').toUpperCase());
  return i < 0 ? SLOT_ORDER.length : i;
}

function sortSlots(slots: LiveSlot[]): LiveSlot[] {
  return [...slots].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
}

/** What to show in the points column, and why, for each non-scored state. */
function slotDisplay(slot: LiveSlot): { value: string; note: string; muted: boolean } {
  switch (slot.status) {
    case 'scored':
      return { value: formatPoints(slot.points ?? 0), note: slot.gameDetail ?? '', muted: false };
    case 'pending':
      return { value: '—', note: slot.gameDetail ?? 'Yet to play', muted: true };
    case 'concealed':
      // DraftKings hides opponents' players until kickoff. Say that plainly rather than
      // letting a blank row read as a missing pick.
      return { value: '—', note: 'Hidden until kickoff', muted: true };
    case 'noStats':
      // A real 0.00 — they are playing and have not recorded anything. Shown muted so it
      // reads differently from a scored 0, but it IS a number, not a gap.
      return { value: formatPoints(0), note: 'No stats yet', muted: true };
    case 'unresolved':
      return { value: '?', note: 'Game not loaded', muted: true };
  }
}

function SlotRow({ slot }: { slot: LiveSlot }) {
  const { value, note, muted } = slotDisplay(slot);
  return (
    <tr className="border-t border-border/50">
      <td className="py-1.5 pr-2 text-xs font-medium text-muted">{slot.slot ?? '—'}</td>
      <td className="py-1.5 pr-2 text-sm">
        {slot.name ?? <span className="text-muted italic">Hidden</span>}
        {slot.teamKey ? <span className="ml-1.5 text-xs text-muted">{slot.teamKey}</span> : null}
      </td>
      <td className="py-1.5 pr-2 text-xs text-muted">{note}</td>
      <td
        className={cn(
          'py-1.5 text-right text-sm tabular-nums',
          muted ? 'text-muted' : 'font-semibold',
          slot.status === 'unresolved' && 'text-tie',
        )}
      >
        {value}
      </td>
    </tr>
  );
}

function TeamSide({ team }: { team: LiveTeam }) {
  return (
    <div className="flex items-center gap-3">
      <TeamLogo src={team.logoEspn} alt={team.teamKey ? `${team.teamKey} logo` : ''} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{team.ownerName}</div>
        <div className="text-xs text-muted">
          {team.hasSnapshot ? (
            <>
              {team.scored + team.noStats} playing
              {team.pending + team.concealed > 0 ? ` · ${team.pending + team.concealed} to play` : ''}
              {team.unresolved > 0 ? ` · ${team.unresolved} unresolved` : ''}
            </>
          ) : (
            'Lineup not captured'
          )}
        </div>
      </div>
      <div className="text-right">
        {team.hasSnapshot ? (
          <span className="text-lg font-bold tabular-nums">{formatPoints(team.points)}</span>
        ) : (
          // NOT 0.00. An uncaptured lineup is unknown, and a zero here would be
          // indistinguishable from a forfeit.
          <span className="text-lg font-bold text-muted">—</span>
        )}
      </div>
    </div>
  );
}

export function MatchupCard({ matchup }: { matchup: LiveMatchup }) {
  const { home, away } = matchup;
  const bothCaptured = home.hasSnapshot && away.hasSnapshot;
  const leader =
    bothCaptured && home.points !== away.points ? (home.points > away.points ? 'home' : 'away') : null;

  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className={cn('rounded-md px-1', leader === 'home' && 'bg-win-soft/40')}>
          <TeamSide team={home} />
        </div>
        <div className={cn('rounded-md px-1', leader === 'away' && 'bg-win-soft/40')}>
          <TeamSide team={away} />
        </div>

        {bothCaptured ? (
          <details className="group">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:text-foreground">
              <span className="group-open:hidden">Show players</span>
              <span className="hidden group-open:inline">Hide players</span>
            </summary>
            <div className="mt-2 grid gap-4 md:grid-cols-2">
              {[home, away].map((team) => (
                <div key={team.ownerSeasonId}>
                  <div className="mb-1 text-xs font-semibold">{team.ownerName}</div>
                  <table className="w-full">
                    <tbody>
                      {sortSlots(team.slots).map((s, i) => (
                        <SlotRow key={`${s.slot}-${s.name ?? 'hidden'}-${i}`} slot={s} />
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </details>
        ) : (
          <Badge variant="tie">
            {!home.hasSnapshot && !away.hasSnapshot
              ? 'Neither lineup captured'
              : `${(!home.hasSnapshot ? home : away).ownerName}'s lineup not captured`}
          </Badge>
        )}
      </CardBody>
    </Card>
  );
}
