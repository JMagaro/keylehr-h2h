/**
 * Shared primary navigation definition. Mirrors the existing site's information
 * architecture: Dashboard, Standings, Playoff Picture, My Team, History, Rules.
 * Used by both the top nav and the footer so links stay in sync.
 */
export interface NavLink {
  href: string;
  label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/standings', label: 'Standings' },
  { href: '/playoffs', label: 'Playoff Picture' },
  { href: '/my-team', label: 'My Team' },
  { href: '/history', label: 'History' },
  { href: '/rules', label: 'Rules' },
] as const;
