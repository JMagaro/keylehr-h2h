import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { asc, eq, sql } from 'drizzle-orm';

import { db, owners, ownerSeasons } from '@/db';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Button, LinkButton } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth-helpers';

import { createOwner, deleteOwner } from './actions';
import { OwnerForm } from './owner-form';

export const metadata: Metadata = { title: 'Owners', robots: { index: false } };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Target league size — 32 owners, one per NFL team. */
const LEAGUE_TARGET = 32;

export default async function OwnersPage() {
  await requireAdmin();

  const rows = await db
    .select({
      id: owners.id,
      name: owners.name,
      email: owners.email,
      phone: owners.phone,
      dkUsername: owners.dkUsername,
      seasonCount: sql<number>`count(${ownerSeasons.id})::int`,
    })
    .from(owners)
    .leftJoin(ownerSeasons, eq(ownerSeasons.ownerId, owners.id))
    .groupBy(owners.id)
    .orderBy(asc(owners.name));

  const count = rows.length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Owners"
        description={`${count} ${count === 1 ? 'owner' : 'owners'} · the league targets ${LEAGUE_TARGET} (one per NFL team).`}
      />

      {count === 0 ? (
        <EmptyState
          icon={Users}
          title="No owners yet"
          description="Add your league members below to get started."
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Email</TH>
              <TH>Phone</TH>
              <TH>DraftKings username</TH>
              <TH align="right"># seasons</TH>
              <TH align="right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((owner) => (
              <TR key={owner.id}>
                <TD className="font-medium">{owner.name}</TD>
                <TD className="text-muted">{owner.email ?? '—'}</TD>
                <TD className="text-muted">{owner.phone ?? '—'}</TD>
                <TD className="text-muted">{owner.dkUsername ?? '—'}</TD>
                <TD align="right">{owner.seasonCount}</TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-2">
                    <LinkButton href={`/admin/owners/${owner.id}`} variant="secondary" size="sm">
                      Edit
                    </LinkButton>
                    <form action={deleteOwner}>
                      <input type="hidden" name="id" value={owner.id} />
                      <Button
                        type="submit"
                        variant="danger"
                        size="sm"
                        aria-label={`Delete ${owner.name}`}
                      >
                        Delete
                      </Button>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle>New owner</CardTitle>
          <CardDescription>
            Add a league member. Name is required; everything else is optional.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <OwnerForm action={createOwner} submitLabel="Add owner" pendingLabel="Adding…" />
        </CardBody>
      </Card>
    </div>
  );
}
