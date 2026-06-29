'use client';

/**
 * OwnerSelector — a small accessible `<select>` that navigates to the same
 * route with a different `?owner=<id>` query param. Used by /history/head-to-head
 * to switch which owner's H2H record is displayed without a client data layer.
 */
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

interface OwnerOption {
  ownerId: number;
  ownerName: string;
}

interface OwnerSelectorProps {
  owners: OwnerOption[];
  selectedId: number;
}

export function OwnerSelector({ owners, selectedId }: OwnerSelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium text-muted">Owner</span>
      <select
        aria-label="Select owner"
        value={selectedId}
        disabled={isPending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(() => {
            router.push(`${pathname}?owner=${id}`);
          });
        }}
        className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
      >
        {owners.map((o) => (
          <option key={o.ownerId} value={o.ownerId}>
            {o.ownerName}
          </option>
        ))}
      </select>
    </label>
  );
}
