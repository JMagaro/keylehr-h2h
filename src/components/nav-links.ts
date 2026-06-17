/**
 * Shared primary navigation definition. Mirrors the site's information architecture:
 * Dashboard, Standings, Playoffs, My Team, Lineup Builder, History, Rules. Used by both
 * the top nav and the footer so links stay in sync. Nested routes (e.g. the builder under
 * /my-team) rely on the nav's longest-prefix active-link matching.
 */
export interface NavLink {
  href: string;
  label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/standings', label: 'Standings' },
  { href: '/playoffs', label: 'Playoffs' },
  { href: '/my-team', label: 'My Team' },
  { href: '/my-team/builder', label: 'Lineup Builder' },
  { href: '/history', label: 'History' },
  { href: '/rules', label: 'Rules' },
] as const;
