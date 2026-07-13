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
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Container } from '@/components/container';
import { NAV_LINKS } from '@/components/nav-links';

/** True when `href` is a prefix-match of the current route (exact for "/"). */
function matchesHref(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The single nav href that should highlight: the LONGEST matching prefix. This keeps a
 * nested route (e.g. /my-team/builder) from also lighting up its parent (/my-team).
 */
function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const link of NAV_LINKS) {
    if (matchesHref(pathname, link.href) && (best === null || link.href.length > best.length)) {
      best = link.href;
    }
  }
  return best;
}

export function SiteNav() {
  const pathname = usePathname();
  const activeHref = activeNavHref(pathname);
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
          aria-label="KeyLehr DFS — home"
          className="flex items-center gap-2.5 font-semibold tracking-tight text-foreground"
        >
          <Image
            src="/keylehr-gaming-logo-transparent.png"
            alt=""
            width={1536}
            height={1024}
            priority
            className="h-8 w-auto drop-shadow-sm"
          />
          <span className="text-base">
            KeyLehr <span className="text-accent">DFS</span>
          </span>
        </Link>

        {/* Desktop links */}
        <ul className="hidden items-center gap-1 lg:flex">
          {NAV_LINKS.map((link) => {
            const active = link.href === activeHref;
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
          className="inline-flex size-10 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-foreground lg:hidden"
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
        <div id="mobile-nav" className="border-t border-border bg-elevated lg:hidden">
          <Container width="wide" as="ul" className="flex flex-col gap-1 py-3">
            {NAV_LINKS.map((link) => {
              const active = link.href === activeHref;
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
