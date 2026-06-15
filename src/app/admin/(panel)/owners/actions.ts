'use server';

/**
 * Server actions backing the admin Owners CRUD pages. Every action re-checks
 * `requireAdmin()` first (defense-in-depth on top of middleware), validates its
 * input with zod (the server is the source of truth), mutates via the Drizzle
 * client, then `revalidatePath('/admin/owners')`.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, owners } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';

/** Shape returned to `useActionState` for inline error rendering. */
export type OwnerFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
};

/**
 * Validation rules (mirrors the `owners` table column limits):
 *  - name: required, 1–128 chars
 *  - email: optional; if present must be a valid email; empty string → null
 *  - phone: optional, ≤ 32 chars; empty string → null
 *  - dkUsername: optional, ≤ 128 chars; empty string → null
 */
const ownerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(128, 'Name must be 128 characters or fewer.'),
  email: z
    .union([z.literal(''), z.string().trim().email('Enter a valid email address.').max(256)])
    .transform((v) => (v === '' ? null : v)),
  phone: z
    .string()
    .trim()
    .max(32, 'Phone must be 32 characters or fewer.')
    .transform((v) => (v === '' ? null : v)),
  dkUsername: z
    .string()
    .trim()
    .max(128, 'DraftKings username must be 128 characters or fewer.')
    .transform((v) => (v === '' ? null : v)),
});

/** Collapse zod issues into the first error message per field. */
function toFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Pull the raw owner fields out of submitted form data. */
function readForm(formData: FormData) {
  return {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    dkUsername: String(formData.get('dkUsername') ?? ''),
  };
}

export async function createOwner(
  _prev: OwnerFormState,
  formData: FormData,
): Promise<OwnerFormState> {
  await requireAdmin();

  const parsed = ownerSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: 'Please fix the errors below.', fieldErrors: toFieldErrors(parsed.error) };
  }

  await db.insert(owners).values(parsed.data);

  revalidatePath('/admin/owners');
  redirect('/admin/owners');
}

export async function updateOwner(
  _prev: OwnerFormState,
  formData: FormData,
): Promise<OwnerFormState> {
  await requireAdmin();

  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return { error: 'Invalid owner.' };
  }

  const parsed = ownerSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: 'Please fix the errors below.', fieldErrors: toFieldErrors(parsed.error) };
  }

  await db.update(owners).set(parsed.data).where(eq(owners.id, id));

  revalidatePath('/admin/owners');
  redirect('/admin/owners');
}

export async function deleteOwner(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return;

  await db.delete(owners).where(eq(owners.id, id));

  revalidatePath('/admin/owners');
}
