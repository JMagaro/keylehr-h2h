'use client';

/**
 * Keeps /live moving without a websocket: a periodic `router.refresh()`, which re-runs the
 * server component and picks up whatever the 30s stat cache has.
 *
 * Paused while the tab is hidden. Without that, every backgrounded tab keeps refreshing all
 * afternoon — the browser throttles the timer but does not stop it, and the point of the
 * shared cache is that viewers are cheap, not that they are free.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw } from 'lucide-react';

const REFRESH_MS = 30_000;

export function LiveRefresh({ fetchedAt }: { fetchedAt: number }) {
  const router = useRouter();
  const [now, setNow] = useState(fetchedAt);
  // `router.refresh()` inside a transition gives us in-flight state for free, and it clears
  // itself when the new server render commits — no effect resetting a boolean on `fetchedAt`.
  const [refreshing, startTransition] = useTransition();

  // Mirrored into a ref so the interval below never closes over a stale value. An effect that
  // only writes a ref triggers no re-render.
  const refreshingRef = useRef(false);
  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  // Tick the "updated Ns ago" label once a second, independent of the data refresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden || refreshingRef.current) return;
      refresh();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  const label = seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;

  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span>Updated {label}</span>
      <button
        type="button"
        onClick={refresh}
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-muted-soft"
        aria-label="Refresh now"
      >
        <RefreshCw className={refreshing ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />
        Refresh
      </button>
    </div>
  );
}
