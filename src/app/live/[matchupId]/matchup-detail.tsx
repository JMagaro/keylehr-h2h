/**
 * The head-to-head detail view: two rosters mirrored around a centre slot rail, the layout
 * every fantasy app uses because it makes "who is beating whom, at which position" readable
 * at a glance.
 *
 * ON A PHONE THAT LAYOUT CANNOT WORK, and it is not a matter of tightening it up. Three
 * columns at 390px leave each player roughly 70px once the logo and the points column are
 * subtracted — enough for "J. Jeffe…" and nothing else, with the stat line gone entirely. So
 * below `sm` the same data renders STACKED: one block per roster slot, both players full width
 * beneath it, each keeping its name, stat line and game state. A two-tone legend says which
 * row belongs to which owner, since stacking removes the left/right cue the mirror gives you
 * for free. The mirrored rail returns from `sm` up.
 *
 * Two layouts, ONE data source: everything below is computed once and rendered twice. Do not
 * let the variants drift into computing different things.
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
import { formatMinutes, lineupMinutes, type LineupMinutes } from '@/lib/live/minutes';
import {
  formatWinProbability,
  projectLineup,
  winProbability,
  type LineupProjection,
  type WinProbability,
} from '@/lib/live/projection';
import { formatPoints, cn } from '@/lib/utils';

/** Roster order, so both sides line up row for row. */
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DST'];

/** A single-slot gap at or above this is worth calling out as the difference-maker. */
const DIFFERENCE_MAKER_POINTS = 5;

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

/** The name, or an explicit statement that DraftKings is still hiding it. */
function PlayerName({ slot }: { slot: LiveSlot }) {
  return slot.name ? (
    <>{slot.name}</>
  ) : (
    <span className="italic text-muted">Hidden until kickoff</span>
  );
}

/** The owner's running total plus, while anything is left to play, DK's projected final. */
function ScoreValue({
  team,
  projection,
  size,
}: {
  team: LiveTeam;
  projection: LineupProjection | null;
  size: 'lg' | 'xl';
}) {
  const numberClass = size === 'xl' ? 'text-3xl' : 'text-2xl';
  if (!team.hasSnapshot) {
    // Never 0.00 for an uncaptured roster — see assemble.ts.
    return <span className={cn(numberClass, 'font-bold text-muted')}>—</span>;
  }

  // Same rule as everywhere else on this page: never render a number we do not have. With no
  // captured `dkProjection` the "projection" is just the current score relabelled, which reads
  // as "we expect them to finish exactly here" — a claim we cannot make. Show nothing instead.
  const hasBasis = projection !== null && !projection.isFinal && projection.projectedSlots > 0;
  // Some slots projectable and some not: the figure is real but excludes the rest, so it is a
  // FLOOR. Marked the way the running total is described in assemble.ts rather than passed off
  // as complete.
  const isFloor = hasBasis && projection.unprojectedSlots > 0;

  return (
    <span className="flex flex-col items-center">
      <span className={cn(numberClass, 'font-bold tabular-nums')}>{formatPoints(team.points)}</span>
      {hasBasis ? (
        // DraftKings' own projection model, recomputed live from ESPN's clock:
        // score + pregame × (minutes left / 60). See lib/live/projection.ts.
        <span
          className="text-[11px] text-muted"
          title={
            isFloor
              ? `At least this much — ${projection.unprojectedSlots} slot(s) still to play have no DraftKings projection, so their points are not counted here.`
              : 'Projected final, from DraftKings’ own projection and the game clock.'
          }
        >
          proj {formatPoints(projection.projected)}
          {isFloor ? '+' : ''}
        </span>
      ) : null}
    </span>
  );
}

/** "58m left · 7 playing · 2 to play" — what makes a running total readable. */
function teamMetaLine(team: LiveTeam, minutes: LineupMinutes): string {
  if (!team.hasSnapshot) return 'Lineup not captured';
  const parts = [
    // 40 points with 300 minutes left is a completely different position from 40 with 12.
    `${formatMinutes(minutes.minutesLeft)} left`,
    `${team.scored + team.noStats} playing`,
  ];
  if (team.pending + team.concealed > 0) parts.push(`${team.pending + team.concealed} to play`);
  return parts.join(' · ');
}

/**
 * The vs / win-probability strip between the two scores.
 *
 * An ESTIMATE from projected margin and time left — labelled, never dressed up as a
 * measurement. See lib/live/projection.ts for the model.
 */
function OddsLine({
  odds,
  home,
  away,
}: {
  odds: WinProbability | null;
  home: LiveTeam;
  away: LiveTeam;
}) {
  if (!odds) return <span className="text-xs text-muted">vs</span>;
  // Both branches lead with whoever is ahead, so the name and the number always agree.
  const leader = odds.home >= 0.5 ? home : away;
  const text = odds.settled
    ? `${leader.ownerName} won`
    : `${formatWinProbability(Math.max(odds.home, 1 - odds.home), false)} ${leader.ownerName}`;
  return (
    <span className="flex flex-col items-center text-xs text-muted">
      <span>vs</span>
      <span className="mt-0.5 text-center text-[11px]">{text}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Desktop (sm and up): the mirrored layout                                    */
/* -------------------------------------------------------------------------- */

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
          <PlayerName slot={slot} />
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

function TeamHeader({
  team,
  align,
  minutes,
}: {
  team: LiveTeam;
  align: 'left' | 'right';
  minutes: LineupMinutes;
}) {
  const right = align === 'right';
  return (
    <div className={cn('flex items-center gap-3', right && 'flex-row-reverse text-right')}>
      <TeamLogo src={team.logoEspn} alt={team.teamKey ? `${team.teamKey} logo` : ''} size={40} />
      <div className="min-w-0">
        <div className="truncate font-semibold">{team.ownerName}</div>
        <div className="text-xs text-muted">{teamMetaLine(team, minutes)}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mobile (below sm): the stacked layout                                       */
/* -------------------------------------------------------------------------- */

/** Which owner a stacked row belongs to. Replaces the left/right cue the mirror gives free. */
type Side = 'home' | 'away';

function SideMarker({ side }: { side: Side }) {
  return (
    <span
      className={cn(
        'h-3.5 w-1 shrink-0 rounded-full',
        side === 'home' ? 'bg-accent' : 'bg-border-strong',
      )}
      aria-hidden="true"
    />
  );
}

/** One owner's line in the stacked scoreboard: logo, name, meta, score. */
function MobileTeamRow({
  team,
  side,
  minutes,
  projection,
}: {
  team: LiveTeam;
  side: Side;
  minutes: LineupMinutes;
  projection: LineupProjection | null;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <SideMarker side={side} />
      <TeamLogo src={team.logoEspn} alt={team.teamKey ? `${team.teamKey} logo` : ''} size={32} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{team.ownerName}</div>
        <div className="truncate text-xs text-muted">{teamMetaLine(team, minutes)}</div>
      </div>
      <div className="shrink-0 text-right">
        <ScoreValue team={team} projection={projection} size="lg" />
      </div>
    </div>
  );
}

/** One player, full width — the whole point of stacking is that nothing has to truncate. */
function MobilePlayerRow({
  slot,
  side,
  ctx,
  index,
}: {
  slot: LiveSlot | null;
  side: Side;
  ctx: LiveTeamContext | undefined;
  index: LiveStatIndex;
}) {
  // Nothing to draw. The mirrored layout renders an invisible spacer here to keep the two
  // sides aligned; stacked there is no alignment to preserve, and nine "No slot" rows for an
  // owner who simply has no capture is noise the scoreboard already explained.
  if (!slot) return null;

  const pts = pointsCell(slot);
  const summary = statSummary(slot);
  const line = gameLine(slot, ctx, index);

  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-1">
        <SideMarker side={side} />
      </span>
      <TeamLogo
        src={ctx?.logoEspn ?? null}
        alt={slot.teamKey ? `${slot.teamKey} logo` : ''}
        size={20}
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          <PlayerName slot={slot} />
        </div>
        {summary ? <div className="text-xs text-muted">{summary}</div> : null}
        <div className="text-[11px] text-muted/80">
          {line || (slot.status === 'concealed' ? 'DraftKings has not revealed this pick' : '')}
        </div>
      </div>
      <div
        className={cn(
          'shrink-0 tabular-nums',
          pts.muted ? 'text-muted' : 'font-semibold',
          pts.tone,
        )}
      >
        {pts.value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

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

  // The biggest single-slot gap is usually the story of a matchup, and it is otherwise easy
  // to miss in nine near-identical rows. Only counted where BOTH sides are actually scored —
  // a gap against an unknown is not a gap.
  let biggestGapIndex = -1;
  let biggestGap = 0;
  rows.forEach(([h, a], i) => {
    if (h?.points === null || a?.points === null || !h || !a) return;
    const gap = Math.abs((h.points ?? 0) - (a.points ?? 0));
    if (gap > biggestGap) {
      biggestGap = gap;
      biggestGapIndex = i;
    }
  });
  const isDifferenceMaker = (i: number) =>
    i === biggestGapIndex && biggestGap >= DIFFERENCE_MAKER_POINTS;

  const bothCaptured = home.hasSnapshot && away.hasSnapshot;
  const homeMinutes = lineupMinutes(home.slots, index.teamState);
  const awayMinutes = lineupMinutes(away.slots, index.teamState);
  const homeProj = home.hasSnapshot ? projectLineup(home, index.teamState) : null;
  const awayProj = away.hasSnapshot ? projectLineup(away, index.teamState) : null;
  // Only meaningful when BOTH sides are known — a probability against an unknown is not one.
  const odds =
    homeProj && awayProj
      ? winProbability(
          homeProj.projected,
          awayProj.projected,
          homeMinutes.minutesLeft + awayMinutes.minutesLeft,
        )
      : null;

  // Kept short and allowed to wrap. The long form ("…so their total is unknown rather than
  // zero") ran to three uppercase lines on a phone and burst out of the card, while saying
  // what the row above already says: that side reads "Lineup not captured" and scores "—".
  const notCapturedBadge = !bothCaptured ? (
    <Badge variant="tie" className="max-w-full">
      {!home.hasSnapshot && !away.hasSnapshot
        ? 'Neither lineup captured'
        : '1 lineup not captured'}
    </Badge>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-4 p-4 sm:p-5">
          {/* Mobile: stacked, so neither name nor score has to compete for width. */}
          <div className="flex flex-col gap-3 sm:hidden">
            <MobileTeamRow team={home} side="home" minutes={homeMinutes} projection={homeProj} />
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
              <OddsLine odds={odds} home={home} away={away} />
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            </div>
            <MobileTeamRow team={away} side="away" minutes={awayMinutes} projection={awayProj} />
          </div>

          {/* sm and up: the mirrored scoreboard. */}
          <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 sm:grid">
            <TeamHeader team={home} align="left" minutes={homeMinutes} />
            <div className="flex items-center gap-3">
              <ScoreValue team={home} projection={homeProj} size="xl" />
              <OddsLine odds={odds} home={home} away={away} />
              <ScoreValue team={away} projection={awayProj} size="xl" />
            </div>
            <TeamHeader team={away} align="right" minutes={awayMinutes} />
          </div>

          {notCapturedBadge}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="p-5 text-sm text-muted">No captured rosters for this matchup yet.</p>
          ) : (
            <>
              {/* Stacking removes the left/right cue, so the two-tone key earns its one line. */}
              <div className="flex items-center gap-4 border-b border-border/60 px-3 py-2 text-xs text-muted sm:hidden">
                <span className="flex min-w-0 items-center gap-1.5">
                  <SideMarker side="home" />
                  <span className="truncate">{home.ownerName}</span>
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <SideMarker side="away" />
                  <span className="truncate">{away.ownerName}</span>
                </span>
              </div>

              <div className="divide-y divide-border/60">
                {rows.map(([h, a], i) => (
                  <div
                    key={`${h?.slot ?? ''}-${a?.slot ?? ''}-${i}`}
                    className={cn(isDifferenceMaker(i) && 'bg-accent/5')}
                  >
                    {/* Mobile: slot heading, then both players full width beneath it. */}
                    <div className="px-3 py-2 sm:hidden">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                          {h?.slot ?? a?.slot ?? ''}
                        </span>
                        {isDifferenceMaker(i) ? (
                          <span className="text-[10px] font-semibold uppercase text-accent">
                            +{formatPoints(biggestGap)} swing
                          </span>
                        ) : null}
                      </div>
                      <MobilePlayerRow
                        slot={h}
                        side="home"
                        ctx={h?.teamKey ? teamContext[h.teamKey] : undefined}
                        index={index}
                      />
                      <MobilePlayerRow
                        slot={a}
                        side="away"
                        ctx={a?.teamKey ? teamContext[a.teamKey] : undefined}
                        index={index}
                      />
                    </div>

                    {/* sm and up: mirrored around the slot rail. */}
                    <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:grid">
                      <PlayerCell
                        slot={h}
                        ctx={h?.teamKey ? teamContext[h.teamKey] : undefined}
                        index={index}
                        align="left"
                      />
                      <div className="flex w-12 shrink-0 flex-col items-center">
                        <span className="text-[11px] font-semibold text-muted">
                          {h?.slot ?? a?.slot ?? ''}
                        </span>
                        {isDifferenceMaker(i) ? (
                          <span className="text-[9px] font-semibold uppercase text-accent">
                            +{formatPoints(biggestGap)}
                          </span>
                        ) : null}
                      </div>
                      <PlayerCell
                        slot={a}
                        ctx={a?.teamKey ? teamContext[a.teamKey] : undefined}
                        index={index}
                        align="right"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
