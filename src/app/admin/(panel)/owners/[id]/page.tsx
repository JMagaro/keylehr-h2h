import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';

import { db, owners } from '@/db';
import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { requireAdmin } from '@/lib/auth-helpers';

import { deleteOwner, updateOwner } from '../actions';
import { OwnerForm } from '../owner-form';

export const metadata: Metadata = { title: 'Edit owner', robots: { index: false } };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function EditOwnerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();

  const { id } = await params;
  const ownerId = Number(id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) notFound();

  const [owner] = await db.select().from(owners).where(eq(owners.id, ownerId)).limit(1);
  if (!owner) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Admin · Owners" title={owner.name} description="Edit this owner's details." />

      <Link href="/admin/owners" className="text-sm text-accent hover:underline">
        ← Back to owners
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Owner details</CardTitle>
          <CardDescription>Name is required; everything else is optional.</CardDescription>
        </CardHeader>
        <CardBody>
          <OwnerForm
            action={updateOwner}
            defaults={{
              id: owner.id,
              name: owner.name,
              email: owner.email,
              phone: owner.phone,
              dkUsername: owner.dkUsername,
            }}
            submitLabel="Save changes"
            pendingLabel="Saving…"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delete owner</CardTitle>
          <CardDescription>
            Permanently remove {owner.name} and any of their season assignments. This cannot be
            undone.
          </CardDescription>
        </CardHeader>
        <CardBody>
          <form action={deleteOwner}>
            <input type="hidden" name="id" value={owner.id} />
            <Button type="submit" variant="danger" aria-label={`Delete ${owner.name}`}>
              Delete owner
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
