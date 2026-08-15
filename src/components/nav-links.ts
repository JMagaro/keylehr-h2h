/**
 * Shared primary navigation definition. Mirrors the site's information architecture:
 * Dashboard, My Team, Live, Standings, Playoffs, Lineup Builder, Cohen's Corner, History,
 * Rules. Used by both the top nav and the footer so links stay in sync. Nested routes (e.g.
 * the builder under /my-team) rely on the nav's longest-prefix active-link matching.
 *
 * There is no Preseason entry: /live renders any week, exhibition weeks included, so a
 * separate read-only page for them was a second thing to maintain that showed less. The
 * SETUP tool for exhibitions remains at Admin → Preseason.
 */
export interface NavLink {
  href: string;
  label: string;
}

export const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/my-team', label: 'My Team' },
  { href: '/live', label: 'Live' },
  { href: '/standings', label: 'Standings' },
  { href: '/playoffs', label: 'Playoffs' },
  { href: '/my-team/builder', label: 'Lineup Builder' },
  { href: '/cohens-corner', label: "Cohen's Corner" },
  { href: '/history', label: 'History' },
  { href: '/rules', label: 'Rules' },
] as const;
