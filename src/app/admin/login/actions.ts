'use server';

/** Server action backing the admin login form. */
import { AuthError } from 'next-auth';

import { signIn } from '@/auth';

export type LoginState = { error?: string } | undefined;

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  try {
    // On success this throws a NEXT_REDIRECT to /admin, which must propagate.
    await signIn('credentials', { email, password, redirectTo: '/admin' });
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: 'Invalid email or password.' };
    }
    throw error; // re-throw the redirect (and anything unexpected)
  }
}
