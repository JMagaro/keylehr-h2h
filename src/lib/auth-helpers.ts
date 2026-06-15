/**
 * Server-side auth helpers for the admin area.
 *
 * Middleware already gates `/admin/*`, but pages/actions call `requireAdmin()`
 * as defense-in-depth (and to get the typed session) before reading or mutating
 * data. Server-only — do not import into client components.
 */
import { redirect } from 'next/navigation';

import { auth } from '@/auth';

/** Return the current session, or redirect to the login page if not an admin. */
export async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    redirect('/admin/login');
  }
  return session;
}
