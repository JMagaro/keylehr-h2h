import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { asc, eq, sql } from 'drizzle-orm';

import { db, owners, ownerSeasons } from '@/db';
import { Badge } from '@/components/badge';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Button, LinkButton } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth-helpers';
import { getCurrentSeason } from '@/lib/season';
import { getSeasonRules } from '@/lib/rules/schema';
import { formatMoney } from '@/lib/utils';

import { createOwner, deleteOwner, togglePaid } from './actions';
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

  // Payment is tracked for the CURRENT season only — see `paidAt` in src/db/schema.ts.
  // This page lists every owner who has ever played, so anyone without a row for this
  // season has nothing to pay yet and is rendered as such, never as unpaid.
  const season = await getCurrentSeason();
  const seasonEntries = season
    ? await db
        .select({ id: ownerSeasons.id, ownerId: ownerSeasons.ownerId, paidAt: ownerSeasons.paidAt })
        .from(ownerSeasons)
        .where(eq(ownerSeasons.seasonId, season.id))
    : [];
  const entryByOwnerId = new Map(seasonEntries.map((e) => [e.ownerId, e]));

  const paidCount = seasonEntries.filter((e) => e.paidAt !== null).length;
  // Canonical column first, JSONB mirror only as a fallback — docs/RULES.md §6.
  const entryFeeCents = season
    ? (season.entryFeeCents ?? getSeasonRules(season.rules).payouts.entryFeeCents)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Owners"
        description={`${count} ${count === 1 ? 'owner' : 'owners'} · the league targets ${LEAGUE_TARGET} (one per NFL team).`}
      />

      {season ? (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-foreground">
                {season.name} entry fees
              </span>
              <span className="text-xs text-muted">
                {paidCount} of {seasonEntries.length} paid ·{' '}
                {formatMoney(paidCount * entryFeeCents)} collected of{' '}
                {formatMoney(seasonEntries.length * entryFeeCents)} at{' '}
                {formatMoney(entryFeeCents)} each
              </span>
            </div>
            <Badge variant={paidCount === seasonEntries.length && seasonEntries.length > 0 ? 'win' : 'neutral'}>
              {seasonEntries.length === 0
                ? 'No owners assigned yet'
                : paidCount === seasonEntries.length
                  ? 'All paid'
                  : `${seasonEntries.length - paidCount} outstanding`}
            </Badge>
          </CardBody>
        </Card>
      ) : null}

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
              <TH align="center">Paid?</TH>
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
                <TD align="center">
                  {(() => {
                    const entry = entryByOwnerId.get(owner.id);
                    // Not in this season → nothing owed. An em dash, never an unpaid state,
                    // or the outstanding count above would count people who owe nothing.
                    if (!entry) return <span className="text-subtle">—</span>;
                    const paid = entry.paidAt !== null;
                    return (
                      <form action={togglePaid} className="flex justify-center">
                        <input type="hidden" name="ownerSeasonId" value={entry.id} />
                        <input type="hidden" name="paid" value={String(paid)} />
                        <Button
                          type="submit"
                          variant={paid ? 'secondary' : 'primary'}
                          size="sm"
                          title={
                            paid && entry.paidAt
                              ? `Paid ${entry.paidAt.toLocaleDateString('en-US')} — click to undo`
                              : 'Click to mark paid'
                          }
                          aria-label={
                            paid
                              ? `Mark ${owner.name} as not paid`
                              : `Mark ${owner.name} as paid`
                          }
                        >
                          {paid ? '✓ Paid' : 'Mark paid'}
                        </Button>
                      </form>
                    );
                  })()}
                </TD>
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
