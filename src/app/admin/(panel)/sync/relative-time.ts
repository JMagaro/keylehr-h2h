/**
 * Compact relative-time formatting for the sync page ("just now", "5m ago",
 * "3h ago", "2d ago"). Coarse on purpose — the commissioner only needs a glanceable
 * sense of how stale a sync is, not a precise duration.
 *
 * @param then  The past timestamp.
 * @param now   Reference "now" (passed from the Server Component for determinism).
 */
export function formatRelativeTime(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 0) return 'just now'; // clock skew / future timestamp
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
