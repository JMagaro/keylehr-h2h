/**
 * One live matchup in the week list — a summary, and a single click target.
 *
 * The WHOLE card is the link, matching the season cards on /history. The per-player breakdown
 * lives on the detail page rather than in an inline expander here: a <details> toggle nested
 * inside a link fights the link, and the detail page has room to show each player's stat line
 * and game state properly.
 *
 * The display rule that drives every branch here: a number we don't have is never rendered as
 * a number. `—` plus a reason, never `0.00`. See src/lib/live/assemble.ts.
 */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { Badge } from '@/components/badge';
import { Card, CardBody } from '@/components/card';
import { TeamLogo } from '@/components/team-logo';
import type { LiveMatchup, LiveTeam } from '@/lib/live/assemble';
import { formatPoints, cn } from '@/lib/utils';

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
  // Any captured side is worth showing. Requiring BOTH hid every roster we had whenever an
  // opponent was missing — which is the normal state mid-capture, and was the state for all
  // six owners in the first real capture.
  const anyCaptured = home.hasSnapshot || away.hasSnapshot;
  // Only claim a leader when both totals are real. Comparing a number to an unknown is not a
  // comparison.
  const leader =
    bothCaptured && home.points !== away.points ? (home.points > away.points ? 'home' : 'away') : null;

  return (
    <Link
      href={`/live/${matchup.id}`}
      className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Card className="h-full transition-colors group-hover:border-accent/50">
        <CardBody className="flex flex-col gap-3">
          <div className={cn('rounded-md px-1', leader === 'home' && 'bg-win-soft/40')}>
            <TeamSide team={home} />
          </div>
          <div className={cn('rounded-md px-1', leader === 'away' && 'bg-win-soft/40')}>
            <TeamSide team={away} />
          </div>

          <div className="flex items-center justify-between gap-2">
            {!bothCaptured ? (
              <Badge variant="tie">
                {!anyCaptured
                  ? 'Neither lineup captured'
                  : `${(!home.hasSnapshot ? home : away).ownerName}'s lineup not captured`}
              </Badge>
            ) : (
              <span />
            )}
            <span className="inline-flex items-center gap-0.5 text-xs font-medium text-muted group-hover:text-foreground">
              Players
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </span>
          </div>
        </CardBody>
      </Card>
    </Link>
  );
}
