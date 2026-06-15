/**
 * Badge — small status pill. Variants cover league semantics:
 *   div  → division leader/marker      wc → wild card
 *   bye  → bye week                    win / loss / tie → H2H results
 *   accent / neutral → generic emphasis
 */
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'div'
  | 'wc'
  | 'bye'
  | 'win'
  | 'loss'
  | 'tie';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-surface text-muted border-border',
  accent: 'bg-accent/12 text-accent border-accent/25',
  div: 'bg-accent/12 text-accent border-accent/25',
  wc: 'bg-tie-soft text-tie border-tie/30',
  bye: 'bg-surface text-subtle border-border-strong',
  win: 'bg-win-soft text-win border-win/30',
  loss: 'bg-loss-soft text-loss border-loss/30',
  tie: 'bg-tie-soft text-tie border-tie/30',
};

export function Badge({ variant = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
