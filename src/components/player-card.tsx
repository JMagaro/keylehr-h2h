/**
 * PlayerCard — presentational row for a single player recommendation. Shared by the
 * My Team spotlight strip and the lineup-builder wizard. Pure/serializable props
 * (PlayerCardData), so it renders in a Server Component with no client JS.
 *
 * Shows the team crest, name, a position badge, the reason chips the engine produced
 * (consensus rank, availability, momentum, matchup), and — when relevant — a compact
 * "fit" meter for the chosen risk profile.
 */
import { cn } from '@/lib/utils';
import { TeamLogo } from '@/components/team-logo';
import type { PlayerCardData } from '@/lib/players/query';
import type { ReasonTone } from '@/lib/players/recommend';

const TONE_CLASS: Record<ReasonTone, string> = {
  good: 'bg-win-soft text-win border-win/30',
  warn: 'bg-tie-soft text-tie border-tie/30',
  bad: 'bg-loss-soft text-loss border-loss/30',
  neutral: 'bg-surface text-muted border-border',
};

function ReasonChip({ label, tone }: { label: string; tone: ReasonTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none',
        TONE_CLASS[tone],
      )}
    >
      {label}
    </span>
  );
}

interface PlayerCardProps {
  data: PlayerCardData;
  /** Optional leading slot label (e.g. "FLEX") for the builder lineup. */
  slotLabel?: string;
  /** Show the 0–100 fit meter (builder targets); off for the spotlight strip. */
  showFit?: boolean;
  className?: string;
}

export function PlayerCard({ data, slotLabel, showFit = false, className }: PlayerCardProps) {
  return (
    <div className={cn('flex items-center gap-3 py-2', className)}>
      {slotLabel ? (
        <span className="w-10 shrink-0 text-center text-[11px] font-bold uppercase tracking-wide text-subtle">
          {slotLabel}
        </span>
      ) : null}
      <TeamLogo src={data.teamLogo} alt={`${data.teamKey} logo`} size={28} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{data.name}</span>
          <span className="shrink-0 rounded bg-surface px-1 py-0.5 text-[10px] font-bold uppercase tracking-wide text-subtle">
            {data.position}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-subtle">{data.teamKey}</span>
          {data.salary != null ? (
            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-accent">
              ${data.salary.toLocaleString('en-US')}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {data.reasons.map((r, i) => (
            <ReasonChip key={`${r.label}-${i}`} label={r.label} tone={r.tone} />
          ))}
        </div>
      </div>
      {showFit ? (
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-bold tabular-nums text-foreground">{Math.round(data.fit)}</span>
          <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.max(4, Math.min(100, data.fit))}%` }}
            />
          </span>
        </div>
      ) : null}
    </div>
  );
}
