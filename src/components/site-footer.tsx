/**
 * SiteFooter — brand, the primary nav links, and operator/legal line. Server
 * component (no interactivity); shares NAV_LINKS with the top nav.
 */
import Image from 'next/image';
import Link from 'next/link';
import { Container } from '@/components/container';
import { NAV_LINKS } from '@/components/nav-links';

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex max-w-sm flex-col gap-2">
            <Link href="/" className="flex items-center gap-2.5 font-semibold text-foreground">
              <Image
                src="/keylehr-shield.png"
                alt=""
                width={32}
                height={25}
                className="h-7 w-auto"
              />
              KeyLehr <span className="text-accent">H2H</span>
            </Link>
            <p className="text-sm text-muted">
              A 32-owner head-to-head Daily Fantasy Football league. Play your team&apos;s NFL
              schedule; your weekly DraftKings lineup is your score.
            </p>
          </div>

          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="text-muted transition-colors hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-6 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>&copy; {year} KeyLehr Gaming Ventures. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <p>Not affiliated with the NFL or DraftKings. For league members only.</p>
            <Link href="/admin/login" className="shrink-0 text-subtle transition-colors hover:text-foreground">
              Commissioner
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  );
}
