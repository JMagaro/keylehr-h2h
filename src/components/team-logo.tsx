/**
 * TeamLogo — a small, square team crest rendered with `next/image`.
 *
 * Used wherever an assigned NFL team is listed (standings, playoffs, dashboard,
 * admin assignments). Logos are remote transparent PNGs (primarily the ESPN
 * crest). When `src` is null/empty (a team without metadata) a neutral
 * placeholder square is shown instead so layout never shifts.
 */
import Image from 'next/image';

import { cn } from '@/lib/utils';

export interface TeamLogoProps {
  /** The logo URL (typically `nflTeams.logoEspn`). Null → neutral placeholder. */
  src: string | null | undefined;
  /** Accessible label, e.g. "Dolphins logo". */
  alt: string;
  /** Square edge length in px. Defaults to 22 (tasteful, row-friendly). */
  size?: number;
  className?: string;
}

export function TeamLogo({ src, alt, size = 22, className }: TeamLogoProps) {
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-block shrink-0 rounded-full border border-border bg-surface',
          className,
        )}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      className={cn('shrink-0 object-contain', className)}
      style={{ width: size, height: size }}
    />
  );
}
