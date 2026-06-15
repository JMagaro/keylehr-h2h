/**
 * Admin panel chrome. Wraps every authenticated admin page (the login page lives
 * outside this route group, so it renders without this chrome). `requireAdmin`
 * is defense-in-depth on top of `middleware.ts`.
 */
import Link from 'next/link';

import { signOut } from '@/auth';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth-helpers';

const ADMIN_NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/owners', label: 'Owners' },
  { href: '/admin/assignments', label: 'Assignments' },
  { href: '/admin/schedule', label: 'Schedule' },
  { href: '/admin/sync', label: 'Sync' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/users', label: 'Users' },
] as const;

export default async function AdminPanelLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdmin();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 md:flex-row md:px-6 md:py-8">
      <aside className="md:w-56 md:shrink-0">
        <div className="mb-4 flex items-center justify-between md:block">
          <Link href="/admin" className="text-base font-semibold tracking-tight text-foreground">
            KeyLehr H2H <span className="text-accent">Admin</span>
          </Link>
        </div>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {ADMIN_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-6 hidden border-t border-border pt-4 md:block">
          <p className="px-3 text-xs text-subtle">{session.user?.email}</p>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/admin/login' });
            }}
          >
            <Button type="submit" variant="ghost" size="sm" className="mt-1 w-full justify-start">
              Sign out
            </Button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
