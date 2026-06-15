import type { Metadata } from 'next';
import { ShieldCheck } from 'lucide-react';
import { asc } from 'drizzle-orm';

import { db, users } from '@/db';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth-helpers';

import { deleteUser } from './actions';
import { UserForm } from './user-form';

export const metadata: Metadata = { title: 'Users', robots: { index: false } };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Format a timestamp as a short, locale-stable date (e.g. "Jun 15, 2026"). */
const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

export default async function UsersPage() {
  await requireAdmin();

  // Never select `passwordHash` — it must not reach the client.
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.email));

  const count = rows.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Users"
        description="Admins who can sign in to this panel. Add or remove them here — no redeploy needed."
      />

      <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted">
        The commissioner account configured via environment variables
        (<code className="text-foreground">ADMIN_EMAIL</code>) is always active and is{' '}
        <strong className="text-foreground">not</strong> listed here. The admins below are
        additional logins stored in the database.
      </p>

      {count === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No additional admins"
          description="Only the env commissioner account can sign in. Add another admin below."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Email</TH>
              <TH>Role</TH>
              <TH>Created</TH>
              <TH align="right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((user) => (
              <TR key={user.id}>
                <TD className="font-medium">{user.name ?? '—'}</TD>
                <TD className="text-muted">{user.email}</TD>
                <TD className="text-muted">{user.role}</TD>
                <TD className="text-muted">{DATE_FMT.format(user.createdAt)}</TD>
                <TD align="right">
                  <form action={deleteUser} className="flex justify-end">
                    <input type="hidden" name="id" value={user.id} />
                    <Button
                      type="submit"
                      variant="danger"
                      size="sm"
                      aria-label={`Remove ${user.email}`}
                    >
                      Remove
                    </Button>
                  </form>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add admin</CardTitle>
          <CardDescription>
            Grant another person access to this panel. They sign in with this email and password.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <UserForm />
        </CardBody>
      </Card>
    </div>
  );
}
