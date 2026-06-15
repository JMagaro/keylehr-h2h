/**
 * PlayoffBracket — presentational, server-rendered playoff bracket.
 *
 * Renders the shape returned by `getPlayoffBracket` (a `PlayoffBracketView`) as a
 * left-to-right column layout: Wild Card → Divisional → Conference → Championship.
 * The wild-card → conference rounds are split into an AFC stack and an NFC stack
 * (the games in those rounds carry a `conference`); the cross-conference
 * Championship sits in its own final column, followed by a prominent Champion
 * callout.
 *
 * Each game is a compact card with both participants (TeamLogo + owner + team +
 * seed + score). The winner is highlighted (accent border/bg + a check), the
 * loser muted. Byes — the top seed(s) sitting out the wild-card round — are shown
 * as a labeled "BYE" slot derived from the divisional-round participants who have
 * no wild-card game. Undecided games read clearly (seed line, "TBD" for an
 * unfilled slot, no score until scored).
 *
 * Server Component: no client state. Horizontally scrollable on small screens.
 */
import { Check, Crown } from 'lucide-react';

import { Badge } from '@/components/badge';
import { TeamLogo } from '@/components/team-logo';
import { cn } from '@/lib/utils';
import type {
  BracketGame,
  BracketParticipant,
  PlayoffBracketView,
} from '@/lib/playoffs/service';
import type { Conference, PlayoffRound } from '@/lib/standings';

export interface PlayoffBracketProps {
  bracket: PlayoffBracketView;
  className?: string;
}

const ROUND_LABELS: Record<PlayoffRound, string> = {
  wild_card: 'Wild Card',
  divisional: 'Divisional',
  conference: 'Conference',
  championship: 'Championship',
};

/** The per-conference rounds, in order (the Championship is cross-conference). */
const CONFERENCE_ROUNDS: PlayoffRound[] = ['wild_card', 'divisional', 'conference'];
const CONFERENCES: Conference[] = ['AFC', 'NFC'];

/* -------------------------------------------------------------------------- */
/* One participant row                                                         */
/* -------------------------------------------------------------------------- */

function ParticipantRow({
  p,
  decided,
}: {
  p: BracketParticipant;
  /** Whether the game has a winner (so the non-winner can be visibly muted). */
  decided: boolean;
}) {
  // An unfilled slot in a not-yet-seeded later-round game.
  if (p.ownerSeasonId === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-subtle">
        <span
          aria-hidden="true"
          className="size-5 shrink-0 rounded-full border border-dashed border-border-strong"
        />
        <span className="italic">TBD</span>
      </div>
    );
  }

  const muted = decided && !p.isWinner;

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-sm',
        p.isWinner && 'bg-accent/10 font-semibold text-foreground',
        muted && 'text-muted opacity-70',
      )}
    >
      {p.seed !== null ? (
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold tabular-nums',
            p.isWinner ? 'bg-accent text-accent-fg' : 'bg-surface text-subtle',
          )}
          aria-label={`Seed ${p.seed}`}
        >
          {p.seed}
        </span>
      ) : (
        <span aria-hidden="true" className="size-5 shrink-0" />
      )}
      <TeamLogo src={p.logoEspn} alt={p.teamName ? `${p.teamName} logo` : 'Team logo'} size={20} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate">{p.ownerName ?? 'TBD'}</span>
        {p.teamKey ? (
          <span className="truncate text-[11px] font-normal text-muted">
            {p.teamKey} · {p.teamName}
          </span>
        ) : null}
      </span>
      <span className="ml-auto flex items-center gap-1 pl-2">
        {p.points !== null ? (
          <span className="tabular-nums">{p.points.toFixed(2)}</span>
        ) : (
          <span aria-hidden="true" className="text-subtle">
            —
          </span>
        )}
        {p.isWinner ? (
          <Check className="size-4 text-accent" aria-label="Winner" />
        ) : (
          <span aria-hidden="true" className="size-4" />
        )}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One game card                                                               */
/* -------------------------------------------------------------------------- */

function GameCard({ game }: { game: BracketGame }) {
  const decided = game.winnerOwnerSeasonId !== null;
  return (
    <div
      className={cn(
        'w-60 overflow-hidden rounded-lg border bg-card shadow-sm',
        decided ? 'border-accent/40' : 'border-border',
      )}
    >
      <ParticipantRow p={game.high} decided={decided} />
      <div className="border-t border-border" />
      <ParticipantRow p={game.low} decided={decided} />
    </div>
  );
}

/** A labeled "BYE" slot for a top seed sitting out the wild-card round. */
function ByeSlot({ p }: { p: BracketParticipant }) {
  return (
    <div className="flex w-60 items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface px-3 py-2 text-sm">
      {p.seed !== null ? (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-card text-[11px] font-bold tabular-nums text-subtle">
          {p.seed}
        </span>
      ) : null}
      <TeamLogo src={p.logoEspn} alt={p.teamName ? `${p.teamName} logo` : 'Team logo'} size={20} />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-medium text-foreground">{p.ownerName ?? 'TBD'}</span>
        {p.teamKey ? (
          <span className="truncate text-[11px] text-muted">
            {p.teamKey} · {p.teamName}
          </span>
        ) : null}
      </span>
      <Badge variant="bye" className="ml-auto">
        Bye
      </Badge>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Round column (within a conference)                                          */
/* -------------------------------------------------------------------------- */

function RoundColumn({
  round,
  games,
  byes,
}: {
  round: PlayoffRound;
  games: BracketGame[];
  /** Bye participants to show above this round's games (wild-card only). */
  byes?: BracketParticipant[];
}) {
  return (
    <div className="flex shrink-0 flex-col gap-4">
      <h4 className="text-xs font-semibold uppercase tracking-widest text-muted">
        {ROUND_LABELS[round]}
      </h4>
      <div className="flex flex-1 flex-col justify-center gap-4">
        {byes?.map((p) => <ByeSlot key={`bye-${p.ownerSeasonId}`} p={p} />)}
        {games.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Conference stack (wild card → divisional → conference)                      */
/* -------------------------------------------------------------------------- */

function ConferenceStack({
  conference,
  gamesByRound,
  byes,
}: {
  conference: Conference;
  gamesByRound: Map<PlayoffRound, BracketGame[]>;
  byes: BracketParticipant[];
}) {
  return (
    <section aria-label={`${conference} bracket`} className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-bold tracking-tight text-foreground">{conference}</h3>
        <Badge variant="accent">{conference}</Badge>
      </div>
      <div className="flex gap-6">
        {CONFERENCE_ROUNDS.map((round) => {
          const games = gamesByRound.get(round) ?? [];
          if (games.length === 0 && !(round === 'wild_card' && byes.length > 0)) return null;
          return (
            <RoundColumn
              key={round}
              round={round}
              games={games}
              byes={round === 'wild_card' ? byes : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Bracket                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Derive each conference's bye participants: the divisional-round participants
 * (by ownerSeasonId) who do NOT appear in that conference's wild-card games. The
 * top seed(s) earn a first-round bye and re-enter at the divisional round, so
 * this surfaces them in the wild-card column with a "BYE" tag.
 */
function deriveByes(
  conference: Conference,
  gamesByRound: Map<PlayoffRound, BracketGame[]>,
): BracketParticipant[] {
  const wildCard = gamesByRound.get('wild_card') ?? [];
  const divisional = gamesByRound.get('divisional') ?? [];
  const wildCardIds = new Set<number>();
  for (const g of wildCard) {
    if (g.high.ownerSeasonId !== null) wildCardIds.add(g.high.ownerSeasonId);
    if (g.low.ownerSeasonId !== null) wildCardIds.add(g.low.ownerSeasonId);
  }
  const seen = new Set<number>();
  const byes: BracketParticipant[] = [];
  for (const g of divisional) {
    for (const p of [g.high, g.low]) {
      if (
        p.ownerSeasonId !== null &&
        !wildCardIds.has(p.ownerSeasonId) &&
        !seen.has(p.ownerSeasonId)
      ) {
        seen.add(p.ownerSeasonId);
        byes.push(p);
      }
    }
  }
  // Top seeds first.
  byes.sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
  void conference;
  return byes;
}

export function PlayoffBracket({ bracket, className }: PlayoffBracketProps) {
  // Index each round's games by conference once.
  const byConference: Record<Conference, Map<PlayoffRound, BracketGame[]>> = {
    AFC: new Map(),
    NFC: new Map(),
  };
  let championshipGames: BracketGame[] = [];

  for (const r of bracket.rounds) {
    if (r.round === 'championship') {
      championshipGames = r.games;
      continue;
    }
    for (const g of r.games) {
      const conf = g.conference;
      if (conf === null) continue;
      const map = byConference[conf];
      const list = map.get(r.round) ?? [];
      list.push(g);
      map.set(r.round, list);
    }
  }

  const champion =
    bracket.championOwnerName !== null
      ? { ownerName: bracket.championOwnerName, teamName: bracket.championTeamName }
      : null;

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {/* Horizontally scrollable on small screens; lays out as columns on desktop. */}
      <div className="-mx-2 overflow-x-auto px-2 pb-2">
        <div className="flex min-w-max items-stretch gap-8">
          {/* AFC + NFC conference stacks, each feeding toward the championship. */}
          <div className="flex flex-col gap-10">
            {CONFERENCES.map((conf) => (
              <ConferenceStack
                key={conf}
                conference={conf}
                gamesByRound={byConference[conf]}
                byes={deriveByes(conf, byConference[conf])}
              />
            ))}
          </div>

          {/* Cross-conference championship column + champion callout. */}
          {(championshipGames.length > 0 || champion) && (
            <div className="flex shrink-0 flex-col justify-center gap-4">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted">
                {ROUND_LABELS.championship}
              </h3>
              {championshipGames.map((g) => (
                <GameCard key={g.id} game={g} />
              ))}
              {champion ? (
                <div
                  className="flex w-60 flex-col items-center gap-1 rounded-lg border border-accent bg-accent/10 px-4 py-5 text-center shadow-sm"
                  aria-label="League champion"
                >
                  <Crown className="size-7 text-accent" aria-hidden="true" />
                  <span className="text-xs font-semibold uppercase tracking-widest text-accent">
                    Champion
                  </span>
                  <span className="text-lg font-bold leading-tight text-foreground">
                    {champion.ownerName}
                  </span>
                  {champion.teamName ? (
                    <span className="text-sm text-muted">{champion.teamName}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
