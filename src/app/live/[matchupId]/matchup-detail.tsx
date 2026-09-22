/**
 * The head-to-head detail view: two rosters mirrored around a centre slot rail, the layout
 * every fantasy app uses because it makes "who is beating whom, at which position" readable
 * at a glance.
 *
 * THE PHONE MIRRORS TOO, and getting there is about WHERE THINGS SIT, not about tightening.
 * This layout was previously stacked below `sm` on the reasoning that three columns at 390px
 * leave each player ~70px — true of the desktop cell, which spends 22px on a team logo and 56
 * on a points column, both as COLUMNS, so both are charged against every line of the cell.
 * Mobile narrows the points column to 40px and moves it INBOARD against the centre rail, and
 * puts the team logo inline on the name line, where it costs ~17px of one line instead of its
 * width on three. That leaves ~115px of text on a 390px phone: an abbreviated name, the game
 * state and the stat line — the shape every fantasy app ships.
 *
 * WHAT THE MIRROR BUYS BACK. Stacking had to say whose player each row was — two owners
 * routinely start the same player, so the same name, stat line and points appeared twice in a
 * slot. Position answers that for free here, which is why the per-row owner label is gone and
 * the header legend above the list carries the whole job.
 *
 * Two layouts, ONE data source: everything below is computed once and rendered twice. Do not
 * let the variants drift into computing different things. The mobile cell is deliberately
 * NOT the desktop cell at a smaller size — see `MobilePlayerCell` vs `PlayerCell`.
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
  projectLineup,
  projectLineupForOdds,
  winProbability,
  winProbabilityPercent,
  type LineupProjection,
  type WinProbability,
} from '@/lib/live/projection';
import { formatPoints, cn } from '@/lib/utils';

import { isFloorTotal, rosterSummaryParts } from '../roster-summary';

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
      <span
        className={cn(numberClass, 'font-bold tabular-nums')}
        // The RUNNING TOTAL can be a floor too, not just the projection: a hidden pick is
        // scoring points this number cannot see. Same trailing "+" the projection already
        // uses below, so one mark means one thing on this page.
        title={
          isFloorTotal(team)
            ? 'At least this much — some picks are hidden or unmatched, so their points are not counted here.'
            : undefined
        }
      >
        {formatPoints(team.points)}
        {isFloorTotal(team) ? <span className="text-muted">+</span> : null}
      </span>
      {/*
        ALWAYS rendered, only sometimes INVISIBLE. A finished side genuinely has nothing to
        project, so hasBasis is correctly false — but omitting this line entirely used to
        shrink that side's column to one line while a still-live opponent kept two, so the
        row lost its shared baseline: on desktop the two scores re-centered at different
        heights, on mobile the owner-name/meta rows below drifted out of alignment. Reserving
        the SPACE (not a fake number) is the fix, matching MobilePlayerCell's min-h trick for
        the same class of problem below.
      */}
      <span
        className={cn('text-[11px] text-muted', !hasBasis && 'invisible')}
        title={
          hasBasis
            ? // DraftKings' own projection model, recomputed live from ESPN's clock:
              // score + pregame × (minutes left / 60). See lib/live/projection.ts.
              isFloor
              ? `At least this much — ${projection!.unprojectedSlots} slot(s) still to play have no DraftKings projection, so their points are not counted here.`
              : 'Projected final, from DraftKings’ own projection and the game clock.'
            : undefined
        }
      >
        {hasBasis ? (
          <>
            proj {formatPoints(projection!.projected)}
            {isFloor ? '+' : ''}
          </>
        ) : (
          ' '
        )}
      </span>
    </span>
  );
}

/** "58m left · 7 playing · 2 unknown" — what makes a running total readable. */
function teamMetaLine(team: LiveTeam, minutes: LineupMinutes): string {
  if (!team.hasSnapshot) return 'Lineup not captured';
  return [
    // 40 points with 300 minutes left is a completely different position from 40 with 12.
    `${formatMinutes(minutes.minutesLeft)} left`,
    // Hidden picks are reported as "unknown", never folded into "to play" — see
    // ../roster-summary for why that distinction is the whole story of a stale capture.
    ...rosterSummaryParts(team),
  ].join(' · ');
}

/**
 * The win-probability meter, full width below both scores — ESPN's layout, not squeezed into
 * the narrow "vs" gap between the two `ScoreValue`s.
 *
 * An ESTIMATE from projected margin and time left — labelled, never dressed up as a
 * measurement. See lib/live/projection.ts for the model, and `projectLineupForOdds` for why a
 * concealed pick no longer silently biases this number toward whichever side has fewer of them.
 *
 * COLOR IS NEVER THE ONLY CHANNEL. The app's win/loss pair fails a colorblind-separation check
 * outright (measured, not eyeballed — the same category of problem the roster mirror's
 * `SideMarker` chip hit). So the fill reinforces a reading that is already complete without it:
 * each end carries the team's own logo (identity) and its percentage printed as text
 * (magnitude), and the bar's own width split is a third, color-independent cue. A viewer who
 * cannot tell the two fills apart still gets the whole story.
 */
function WinProbabilityBar({
  odds,
  home,
  away,
}: {
  odds: WinProbability | null;
  home: LiveTeam;
  away: LiveTeam;
}) {
  // No basis yet (e.g. a side with nothing revealed at all to estimate from) — nothing printed,
  // matching this page's rule that a number we do not have is never rendered as one.
  if (!odds) return null;

  // Settled means this is no longer an estimate, so the TRUE 100/0 — never the 1–99 clamp
  // `winProbabilityPercent` applies for the live case specifically to avoid overstating
  // certainty while a game can still move. Same bar shape either way: the visual weight
  // shouldn't drop just because the number stopped being a guess.
  const homePct = odds.settled ? Math.round(odds.home * 100) : winProbabilityPercent(odds.home);
  const awayPct = 100 - homePct;

  return (
    <div className="flex flex-col items-center gap-1.5 border-t border-border/60 pt-2.5">
      <span
        className="rounded-full bg-accent/12 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
        title={
          odds.settled
            ? undefined
            : 'An estimate from projected score and time remaining — not a measurement.'
        }
      >
        {odds.settled ? 'Final' : 'Win Prob'}
      </span>
      <div className="flex w-full items-center gap-2">
        <TeamLogo src={home.logoEspn} alt={home.teamKey ? `${home.teamKey} logo` : ''} size={20} />
        <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">{homePct}%</span>
        {/*
          A single overflow-hidden TRACK (bg-loss, the away side) with one plain block child
          sized to the home share — not two flex children each width:calc(%). That pattern
          nests a percentage-width flex item inside a container whose OWN width comes from
          flex-1 one level up, which is exactly the double-indirection Safari has known bugs
          rendering (zero-size, no error). A plain block child's percentage resolves against
          its parent's already-settled width with no such ambiguity.
        */}
        <div
          className="h-2 flex-1 overflow-hidden rounded-full bg-loss"
          role="img"
          aria-label={`${home.ownerName} ${homePct}%, ${away.ownerName} ${awayPct}%`}
        >
          <div className="h-full rounded-full bg-win" style={{ width: `${homePct}%` }} />
        </div>
        <span className="w-8 shrink-0 text-xs font-semibold tabular-nums">{awayPct}%</span>
        <TeamLogo src={away.logoEspn} alt={away.teamKey ? `${away.teamKey} logo` : ''} size={20} />
      </div>
    </div>
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
          {summary ||
            line ||
            (slot.status === 'concealed' ? 'Hidden by DraftKings when the lineup was synced' : '')}
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

/*
 * Historical note, because it is the reason the mirror is worth the width it costs.
 *
 * The stacked layout had to label every row with its owner: two owners routinely start the
 * same player — in 2026 week 2 both sides of one matchup started Carson Wentz AND Bijan
 * Robinson — and stacked, that slot rendered as two identical rows, same name, same stat
 * line, same points. Colour chips alone could not fix it (and fail outright for the ~8% of
 * men with a red-green deficiency), so the owner's name had to appear on all nine rows.
 *
 * Mirroring makes position the cue, so that per-row label is gone and those pixels went to
 * the stat line instead. The header legend now carries the left/right mapping for the whole
 * list, which is why it is not optional decoration.
 */

/**
 * One side of the mobile scoreboard: logo outboard, score inboard, owner beneath.
 *
 * The two scores meet in the middle, which is what makes the margin between them readable
 * without doing arithmetic — the same reason the rosters below mirror.
 */
function MobileScoreSide({
  team,
  align,
  minutes,
  projection,
}: {
  team: LiveTeam;
  align: 'left' | 'right';
  minutes: LineupMinutes;
  projection: LineupProjection | null;
}) {
  const right = align === 'right';
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', right ? 'items-end' : 'items-start')}>
      <div className={cn('flex items-center gap-2', right && 'flex-row-reverse')}>
        <TeamLogo src={team.logoEspn} alt={team.teamKey ? `${team.teamKey} logo` : ''} size={32} />
        <ScoreValue team={team} projection={projection} size="xl" />
      </div>
      <div className="max-w-full truncate text-xs font-semibold">{team.ownerName}</div>
      {/*
        Belongs to THIS owner, so it sits under this owner. Stacking both lines in the middle
        made them read as one shared caption for the matchup.

        WRAPS, never truncates: at a mirrored ~170px "223m left · 7 playing · 2 unknown" takes
        two or three lines, and `truncate` once clipped it to "…2 unkn…" — losing precisely
        the clause that says the score above is incomplete.
      */}
      <div className={cn('text-[11px] leading-snug text-muted', right && 'text-right')}>
        {teamMetaLine(team, minutes)}
      </div>
    </div>
  );
}

/**
 * "Jaxon Smith-Njigba" → "J. Smith-Njigba".
 *
 * The mirrored cell gives a name ~130px. A surname alone would be ambiguous in a league that
 * rosters both Williamses in the screenshot that prompted this layout, so the initial stays.
 * Left alone: single-token names and defenses, where the first token IS the identity.
 */
function shortName(name: string, slot: string | null): string {
  if ((slot ?? '').toUpperCase() === 'DST') return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const [first, ...rest] = parts;
  if (first.length <= 2) return name; // already an initial, e.g. "J. Taylor"
  return `${first[0]}. ${rest.join(' ')}`;
}

/**
 * One player in the mobile mirror.
 *
 * Not the desktop cell shrunk: the points column moves INBOARD against the centre rail, and
 * the team logo rides the name line instead of taking a column — the two trades that make
 * three columns fit a phone at all. The away side reverses so both point columns meet in the
 * middle and both names sit at the outer edges — the arrangement that makes "who won this
 * slot" a single glance.
 */
function MobilePlayerCell({
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
  // An empty cell, NOT nothing: this side has no slot in a row the other side does fill, and
  // the mirror only reads if the two stay aligned.
  if (!slot) return <div aria-hidden="true" />;

  const right = align === 'right';
  const pts = pointsCell(slot);
  const summary = statSummary(slot);
  const line = gameLine(slot, ctx, index);

  return (
    <div className={cn('flex items-start gap-1.5', right && 'flex-row-reverse')}>
      {/*
        `min-h` so every row is the same height whatever it contains. A concealed pick has no
        name, no team and therefore no game line or stat line — one line of text against its
        neighbour's three — and without a floor here that row visibly collapsed, which read as
        a rendering fault rather than as "DraftKings is hiding this one".
      */}
      {/*
        `min-h` matches a full three-line cell (13px name + two 11px lines ≈ 2.9rem) so every
        row is the same height whatever it contains. A concealed pick has no name, no team and
        therefore no game line or stat line; without a floor here that row visibly collapsed
        against its neighbour's three lines, which read as a rendering fault rather than as
        "DraftKings is hiding this one".
      */}
      <div className={cn('min-h-[2.9rem] min-w-0 flex-1', right && 'text-right')}>
        {slot.name ? (
          /*
            The logo rides the NAME LINE rather than taking a column of its own.
            A column costs its width on all three lines and was what made the mirror
            impossible at this size; inline it costs ~17px on one line, and the game state
            and stat line below still get the cell's full width. It sits at the OUTER edge on
            both sides, so the logos form two clean columns down the screen edges and the
            mirror stays a mirror.
          */
          <div className={cn('flex items-center gap-1', right && 'flex-row-reverse')}>
            <TeamLogo
              src={ctx?.logoEspn ?? null}
              alt={slot.teamKey ? `${slot.teamKey} logo` : ''}
              size={14}
              className="shrink-0"
            />
            <span className="truncate text-[13px] font-semibold leading-tight">
              {shortName(slot.name, slot.slot)}
            </span>
          </div>
        ) : (
          /*
            SPLIT ACROSS THE TWO LINES a named player uses, not truncated into one.
            "Hidden until kickoff" needs ~135px at 13px semibold and the cell offers ~115px on
            a 390px phone, so `truncate` clipped it to "Hidden until kicko…". Breaking it where
            it makes sense gives the concealed slot the same shape as every other row and
            nothing is lost. `PlayerName` still carries the full phrase on desktop, which has
            the width for it.
          */
          <>
            <div className="truncate text-[13px] font-semibold italic leading-tight text-muted">
              Hidden
            </div>
            <div className="truncate text-[11px] leading-snug text-muted">until kickoff</div>
          </>
        )}
        {/* Game state above the stat line, matching how every fantasy app orders these: it
            is the thing that tells you whether the number beside it can still move. */}
        {line ? <div className="truncate text-[11px] leading-snug text-muted">{line}</div> : null}
        {/* WRAPS. The stat line is the reason for the cell's width; clipping it to one line
            would spend the space and then throw the content away. */}
        {summary ? <div className="text-[11px] leading-snug text-muted/80">{summary}</div> : null}
      </div>
      <div
        className={cn(
          'w-10 shrink-0 pt-0.5 text-[15px] tabular-nums leading-tight',
          right ? 'text-left' : 'text-right',
          pts.muted ? 'text-muted' : 'font-bold',
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
  // The DISPLAYED "proj" figure above (homeProj/awayProj) stays exactly as projectLineup
  // computes it — 0 for a concealed slot, never invented. Win probability is a different
  // number with a different job (already a labelled estimate), computed separately via
  // projectLineupForOdds so a hidden pick's own asymmetry stops biasing the margin — see the
  // doc comment there and on WinProbabilityBar.
  const homeOddsProj = home.hasSnapshot ? projectLineupForOdds(home, index.teamState) : null;
  const awayOddsProj = away.hasSnapshot ? projectLineupForOdds(away, index.teamState) : null;
  const odds =
    homeOddsProj?.hasBasis && awayOddsProj?.hasBasis
      ? winProbability(
          homeOddsProj.projected,
          awayOddsProj.projected,
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
          {/* Mobile: the same mirror as the rosters below, so the page reads one way. */}
          <div className="flex flex-col gap-2.5 sm:hidden">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
              <MobileScoreSide
                team={home}
                align="left"
                minutes={homeMinutes}
                projection={homeProj}
              />
              {/* Just "vs" here. The win-probability text is a name plus a percentage, and in
                  the centre column it would push both scores outward into their logos. */}
              <span className="pt-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                vs
              </span>
              <MobileScoreSide
                team={away}
                align="right"
                minutes={awayMinutes}
                projection={awayProj}
              />
            </div>
          </div>

          {/* sm and up: the mirrored scoreboard. */}
          <div className="hidden grid-cols-[1fr_auto_1fr] items-center gap-3 sm:grid">
            <TeamHeader team={home} align="left" minutes={homeMinutes} />
            <div className="flex items-center gap-3">
              <ScoreValue team={home} projection={homeProj} size="xl" />
              <span className="text-xs text-muted">vs</span>
              <ScoreValue team={away} projection={awayProj} size="xl" />
            </div>
            <TeamHeader team={away} align="right" minutes={awayMinutes} />
          </div>

          {/* One bar, shared by both breakpoints — its own row spans the full card width,
              which the narrow "vs" gap above never had room for. */}
          <WinProbabilityBar odds={odds} home={home} away={away} />

          {notCapturedBadge}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <p className="p-5 text-sm text-muted">No captured rosters for this matchup yet.</p>
          ) : (
            <>
              {/*
                The mirror's one instruction: who is on the left, who is on the right. The
                rows below carry no owner label at all — position is the cue — so this line
                is doing that job for all nine of them and is pinned to the same outer edges
                the names below sit on.
              */}
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-2 py-2 text-xs font-medium sm:hidden">
                <span className="flex min-w-0 items-center gap-1.5">
                  <SideMarker side="home" />
                  <span className="truncate">{home.ownerName}</span>
                </span>
                <span className="flex min-w-0 flex-row-reverse items-center gap-1.5">
                  <SideMarker side="away" />
                  <span className="truncate">{away.ownerName}</span>
                </span>
              </div>

              <div className="divide-y divide-border/60">
                {rows.map(([h, a], i) => (
                  <div key={`${h?.slot ?? ''}-${a?.slot ?? ''}-${i}`}>
                    {/* Mobile: mirrored around the same slot rail the desktop uses. */}
                    <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-1.5 px-2 py-2 sm:hidden">
                      <MobilePlayerCell
                        slot={h}
                        align="left"
                        ctx={h?.teamKey ? teamContext[h.teamKey] : undefined}
                        index={index}
                      />
                      {/*
                        The rail. Narrow on purpose — every pixel here comes off the names.

                        The slot, and ONLY the slot. THE DIFFERENCE-MAKER IS NOT SHOWN ON A
                        PHONE AT ALL — neither the margin nor the row tint — and that is the
                        whole feature, deliberately dropped here rather than half-kept.

                        It was tried both ways. The bare "+19.00" under "TE", on one row out
                        of nine with no label or unit, read as a stat belonging to that
                        position, and "+19.00 swing" does not fit 36px. Removing just the
                        number left a faintly tinted row with nothing to explain it, which
                        drew the same question one step quieter. A cue that has to be asked
                        about is not a cue. Desktop has room for the label, so it keeps both.
                      */}
                      <div className="w-9 pt-0.5 text-center">
                        <div className="text-[10px] font-semibold uppercase leading-tight tracking-wide text-muted">
                          {h?.slot ?? a?.slot ?? ''}
                        </div>
                      </div>
                      <MobilePlayerCell
                        slot={a}
                        align="right"
                        ctx={a?.teamKey ? teamContext[a.teamKey] : undefined}
                        index={index}
                      />
                    </div>

                    {/* sm and up: mirrored around the slot rail. The difference-maker tint
                        lives HERE rather than on the shared row, so it applies to the desktop
                        layout only — see the rail comment above for why mobile drops it. */}
                    <div
                      className={cn(
                        'hidden grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 sm:grid',
                        isDifferenceMaker(i) && 'bg-accent/5',
                      )}
                    >
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
