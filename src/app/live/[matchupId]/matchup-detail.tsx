/**
 * The head-to-head detail view: two rosters mirrored around a centre slot rail, the layout
 * every fantasy app uses because it makes "who is beating whom, at which position" readable
 * at a glance.
 *
 * Each player row carries what you actually need mid-game: the points, a plain-English stat
 * line, and their game's state — which for a player yet to kick off means their opponent and
 * kickoff time, since "0.00" would be meaningless there.
 *
 * The display rule from src/lib/live/assemble.ts holds throughout: a number we do not have is
 * never drawn as a number.
 */
import { Badge } from '@/components/badge';
import { Card, CardBody } from '@/components/card';
import { TeamLogo } from '@/components/team-logo';
import type { LiveMatchup, LiveSlot, LiveTeam } from '@/lib/live/assemble';
import type { LiveTeamContext } from '@/lib/live/query';
import type { LiveStatIndex } from '@/lib/live/stats';
import { formatPoints, cn } from '@/lib/utils';

/** Roster order, so both sides line up row for row. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST'];

function slotRank(slot: string | null): number {
  const i = SLOT_ORDER.indexOf((slot ?? '').toUpperCase());
  return i < 0 ? SLOT_ORDER.length : i;
}

/**
 * Pair the two rosters into rows.
 *
 * Pairing is POSITIONAL after sorting, not by player: the two lineups are independent, and a
 * row simply shows each side's Nth slot. Sorting first is what makes "QB vs QB" hold.
 */
function pairSlots(home: LiveSlot[], away: LiveSlot[]): [LiveSlot | null, LiveSlot | null][] {
  const h = [...home].sort((a, b) => slotRank(a.slot) - slotRank(b.slot));
  const a = [...away].sort((x, y) => slotRank(x.slot) - slotRank(y.slot));
  const rows: [LiveSlot | null, LiveSlot | null][] = [];
  for (let i = 0; i < Math.max(h.length, a.length); i += 1) rows.push([h[i] ?? null, a[i] ?? null]);
  return rows;
}

function kickoffLabel(kickoff: Date | null): string {
  if (!kickoff) return 'TBD';
  return kickoff.toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The line under a player's name.
 *
 * Live/finished: ESPN's status ("8:30 - 3rd Quarter", "Final").
 * Not started:  opponent + kickoff, mirroring how every fantasy app shows an unplayed slot.
 */
function gameLine(slot: LiveSlot, ctx: LiveTeamContext | undefined, index: LiveStatIndex): string {
  if (!slot.teamKey) return '';
  const state = index.teamState[slot.teamKey];
  if (state && state.state !== 'pre' && state.detail) return state.detail;
  if (!ctx) return slot.gameDetail ?? '';
  const vs = ctx.opponentKey ? `${ctx.isHome ? '' : '@'}${ctx.opponentKey}` : '';
  return `${vs} ${kickoffLabel(ctx.kickoff)}`.trim();
}

/** A short, human stat line built from the scoring breakdown, e.g. "8 REC · 100 RecYds · 1 TD". */
const SHORT_LABEL: Record<string, string> = {
  passYards: 'PaYds',
  passTd: 'PaTD',
  passInterceptions: 'INT',
  rushYards: 'RuYds',
  rushTd: 'RuTD',
  receptions: 'REC',
  recYards: 'RecYds',
  recTd: 'RecTD',
  fumblesLost: 'FUM',
  returnTd: 'RetTD',
  twoPointConversions: '2PT',
  sacks: 'SACK',
  interceptions: 'INT',
  fumbleRecoveries: 'FR',
  safeties: 'SAF',
  blockedKicks: 'BLK',
  defensiveTds: 'DefTD',
  specialTeamsTds: 'STTD',
  pointsAllowed: 'PA',
};

function statSummary(slot: LiveSlot): string {
  return slot.components
    // Bonuses are derived from stats already listed; repeating them adds noise, not information.
    .filter((c) => !c.key.startsWith('bonus.'))
    .map((c) => `${c.quantity} ${SHORT_LABEL[c.key] ?? c.label}`)
    .join(' · ');
}

function pointsCell(slot: LiveSlot): { value: string; muted: boolean; tone?: string } {
  switch (slot.status) {
    case 'scored':
      return { value: formatPoints(slot.points ?? 0), muted: false };
    case 'noStats':
      return { value: formatPoints(0), muted: true };
    case 'pending':
    case 'concealed':
      return { value: '—', muted: true };
    case 'unresolved':
      return { value: '?', muted: true, tone: 'text-tie' };
  }
}

function PlayerCell({
  slot,
  ctx,
  index,
  align,
}: {
  slot: LiveSlot | null;
  ctx: LiveTeamContext | undefined;
  index: LiveStatIndex;
  align: 'left' | 'right';
}) {
  if (!slot) return <div className="min-h-[3rem]" />;

  const right = align === 'right';
  const pts = pointsCell(slot);
  const summary = statSummary(slot);
  const line = gameLine(slot, ctx, index);

  return (
    <div className={cn('flex min-h-[3rem] items-center gap-2 py-2', right && 'flex-row-reverse')}>
      <TeamLogo src={ctx?.logoEspn ?? null} alt={slot.teamKey ? `${slot.teamKey} logo` : ''} size={22} />
      <div className={cn('min-w-0 flex-1', right && 'text-right')}>
        <div className="truncate text-sm font-medium">
          {slot.name ?? <span className="text-muted italic">Hidden until kickoff</span>}
        </div>
        <div className="truncate text-xs text-muted">
          {summary || line || (slot.status === 'concealed' ? 'DraftKings has not revealed this pick' : '')}
        </div>
        {summary && line ? <div className="truncate text-[11px] text-muted/80">{line}</div> : null}
      </div>
      <div
        className={cn(
          'w-14 shrink-0 tabular-nums',
          right ? 'text-left' : 'text-right',
          pts.muted ? 'text-muted' : 'font-semibold',
          pts.tone,
        )}
      >
        {pts.value}
      </div>
    </div>
  );
}

function TeamHeader({ team, align }: { team: LiveTeam; align: 'left' | 'right' }) {
  const right = align === 'right';
  return (
    <div className={cn('flex items-center gap-3', right && 'flex-row-reverse text-right')}>
      <TeamLogo src={team.logoEspn} alt={team.teamKey ? `${team.teamKey} logo` : ''} size={40} />
      <div className="min-w-0">
        <div className="truncate font-semibold">{team.ownerName}</div>
        <div className="text-xs text-muted">
          {team.hasSnapshot
            ? `${team.scored + team.noStats} playing · ${team.pending + team.concealed} to play`
            : 'Lineup not captured'}
        </div>
      </div>
    </div>
  );
}

function TeamScore({ team }: { team: LiveTeam }) {
  if (!team.hasSnapshot) {
    // Never 0.00 for an uncaptured roster — see assemble.ts.
    return <span className="text-3xl font-bold text-muted">—</span>;
  }
  return <span className="text-3xl font-bold tabular-nums">{formatPoints(team.points)}</span>;
}

export function MatchupDetail({
  matchup,
  index,
  teamContext,
}: {
  matchup: LiveMatchup;
  index: LiveStatIndex;
  teamContext: Record<string, LiveTeamContext>;
}) {
  const { home, away } = matchup;
  const rows = pairSlots(home.slots, away.slots);
  const bothCaptured = home.hasSnapshot && away.hasSnapshot;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <TeamHeader team={home} align="left" />
            <div className="flex items-center gap-3">
              <TeamScore team={home} />
              <span className="text-xs text-muted">vs</span>
              <TeamScore team={away} />
            </div>
            <TeamHeader team={away} align="right" />
          </div>

          {!bothCaptured ? (
            <Badge variant="tie">
              {!home.hasSnapshot && !away.hasSnapshot
                ? 'Neither lineup captured — nothing here is a comparison'
                : `${(!home.hasSnapshot ? home : away).ownerName}'s lineup not captured, so their total is unknown rather than zero`}
            </Badge>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="p-5 text-sm text-muted">No captured rosters for this matchup yet.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {rows.map(([h, a], i) => (
                <div
                  key={`${h?.slot ?? ''}-${a?.slot ?? ''}-${i}`}
                  className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-3"
                >
                  <PlayerCell slot={h} ctx={h?.teamKey ? teamContext[h.teamKey] : undefined} index={index} align="left" />
                  <div className="w-12 shrink-0 text-center text-[11px] font-semibold text-muted">
                    {h?.slot ?? a?.slot ?? ''}
                  </div>
                  <PlayerCell slot={a} ctx={a?.teamKey ? teamContext[a.teamKey] : undefined} index={index} align="right" />
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
