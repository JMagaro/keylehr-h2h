'use server';

/**
 * Server actions backing the admin Users page (DB-backed admin accounts).
 *
 * Every action re-checks `requireAdmin()` first (defense-in-depth on top of
 * middleware), validates input with zod (the server is the source of truth),
 * mutates via the Drizzle client, then `revalidatePath('/admin/users')`.
 *
 * The env bootstrap admin (ADMIN_EMAIL / ADMIN_PASSWORD_HASH) is NOT a row here;
 * it always works as a fallback and is never listed or removable on this page.
 */
import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, users } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';

/** Shape returned to `useActionState` for inline error rendering. */
export type UserFormState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Set after a successful insert so the form can reset/confirm. */
  ok?: boolean;
};

/**
 * Validation rules for a new admin (mirrors the `users` table column limits):
 *  - name: optional, ≤ 128 chars; empty string → null
 *  - email: required, valid email, lowercased, ≤ 256 chars
 *  - password: required, ≥ 8 chars (hashed with bcrypt before storage)
 */
const createUserSchema = z.object({
  name: z
    .string()
    .trim()
    .max(128, 'Name must be 128 characters or fewer.')
    .transform((v) => (v === '' ? null : v)),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required.')
    .email('Enter a valid email address.')
    .max(256, 'Email must be 256 characters or fewer.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    .max(256, 'Password must be 256 characters or fewer.'),
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

export async function createUser(
  _prev: UserFormState,
  formData: FormData,
): Promise<UserFormState> {
  await requireAdmin();

  const parsed = createUserSchema.safeParse({
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    password: String(formData.get('password') ?? ''),
  });
  if (!parsed.success) {
    return { error: 'Please fix the errors below.', fieldErrors: toFieldErrors(parsed.error) };
  }

  const { name, email, password } = parsed.data;

  // Friendly duplicate check before insert (the unique constraint is the real
  // guard; this just yields a nicer message in the common case).
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    return {
      error: 'That email is already an admin.',
      fieldErrors: { email: 'An admin with this email already exists.' },
    };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  try {
    await db.insert(users).values({ name, email, passwordHash, role: 'admin' });
  } catch (err) {
    // Race against the unique constraint, or any other insert failure.
    const message = err instanceof Error ? err.message : '';
    if (/unique|duplicate/i.test(message)) {
      return {
        error: 'That email is already an admin.',
        fieldErrors: { email: 'An admin with this email already exists.' },
      };
    }
    return { error: 'Could not add admin. Please try again.' };
  }

  revalidatePath('/admin/users');
  return { ok: true };
}

export async function deleteUser(formData: FormData): Promise<void> {
  await requireAdmin();

  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return;

  await db.delete(users).where(eq(users.id, id));

  revalidatePath('/admin/users');
}
