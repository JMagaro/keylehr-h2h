import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, resolving Tailwind conflicts (last wins). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format DraftKings points (stored as a numeric string) for display, e.g. "241.68". */
export function formatPoints(points: string | number | null | undefined): string {
  if (points === null || points === undefined || points === '') return '—';
  const n = typeof points === 'string' ? Number(points) : points;
  if (Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format cents as USD, e.g. 15500 → "$155". */
export function formatMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/** Win percentage from a W-L-T record, e.g. (10, 7, 0) → 0.588. Ties count as half a win. */
export function winPct(wins: number, losses: number, ties = 0): number {
  const games = wins + losses + ties;
  if (games === 0) return 0;
  return (wins + ties / 2) / games;
}
