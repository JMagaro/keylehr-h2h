/**
 * EmptyState — placeholder shown when there's no data yet (the whole app until the
 * season's live pipeline is wired). Centered icon + title + message + optional action.
 */
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Lucide icon component. */
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  /** Optional CTA (link/button) rendered below the message. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center',
        className,
      )}
    >
      {Icon ? (
        <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      ) : null}
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-md text-sm text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
