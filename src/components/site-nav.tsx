'use client';

/**
 * SiteNav — sticky, responsive primary navigation (client component for active-link
 * state via usePathname and the mobile menu toggle).
 *
 * - Desktop: brand + inline links with an animated active underline.
 * - Mobile: brand + hamburger that toggles an accessible disclosure panel.
 * - Accessibility: <nav aria-label>, aria-current on the active link, the toggle
 *   exposes aria-expanded/aria-controls, links close the menu on selection, and
 *   Escape closes it.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, Trophy, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Container } from '@/components/container';
import { NAV_LINKS } from '@/components/nav-links';

/** True when `href` is the active route (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the mobile menu whenever the route changes. Done during render (React's
  // recommended pattern) rather than in an effect to avoid a cascading re-render.
  const [navPath, setNavPath] = useState(pathname);
  if (navPath !== pathname) {
    setNavPath(pathname);
    setOpen(false);
  }

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 z-40 border-b border-border bg-elevated/90 backdrop-blur supports-[backdrop-filter]:bg-elevated/75"
    >
      <Container width="wide" as="div" className="flex h-16 items-center justify-between gap-4">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight text-foreground"
        >
          <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <Trophy className="size-4" aria-hidden="true" />
          </span>
          <span className="text-base">
            KeyLehr <span className="text-accent">DFS</span>
          </span>
        </Link>

        {/* Desktop links */}
        <ul className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => {
            const active = isActive(pathname, link.href);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted hover:bg-surface hover:text-foreground',
                  )}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Mobile toggle */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="inline-flex size-10 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-foreground md:hidden"
        >
          {open ? (
            <X className="size-5" aria-hidden="true" />
          ) : (
            <Menu className="size-5" aria-hidden="true" />
          )}
        </button>
      </Container>

      {/* Mobile disclosure panel */}
      {open ? (
        <div id="mobile-nav" className="border-t border-border bg-elevated md:hidden">
          <Container width="wide" as="ul" className="flex flex-col gap-1 py-3">
            {NAV_LINKS.map((link) => {
              const active = isActive(pathname, link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-accent/10 text-accent'
                        : 'text-muted hover:bg-surface hover:text-foreground',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </Container>
        </div>
      ) : null}
    </nav>
  );
}
