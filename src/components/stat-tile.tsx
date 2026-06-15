/**
 * StatTile — compact KPI block: label, big value, optional hint and leading icon.
 * Purely presentational; pass an already-formatted value string/number.
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: React.ReactNode;
  /** Small caption under the value (e.g. context or trend). */
  hint?: React.ReactNode;
  /** Optional Lucide icon shown in the corner. */
  icon?: LucideIcon;
}

export function StatTile({ label, value, hint, icon: Icon, className, ...rest }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-sm',
        className,
      )}
      {...rest}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
        {Icon ? <Icon className="size-4 shrink-0 text-accent" aria-hidden="true" /> : null}
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
