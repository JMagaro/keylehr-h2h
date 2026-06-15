/**
 * Auth.js (NextAuth v5) — full server-side configuration.
 *
 * v1 uses a single commissioner/admin login backed by environment variables:
 *  - ADMIN_EMAIL          the commissioner's email
 *  - ADMIN_PASSWORD_HASH  a bcrypt hash of the password (generate with `npm run admin:hash`)
 *  - AUTH_SECRET          session signing secret
 *
 * Sessions are stateless JWTs (no database adapter), which keeps the auth layer
 * simple until per-owner logins are added. This module imports bcrypt and must
 * run on the Node.js runtime (it is used by the API route, not middleware).
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

import { authConfig } from '@/auth.config';
import { db, users } from '@/db';

/**
 * Resolve the configured admin password hash to a usable bcrypt hash.
 *
 * Bcrypt hashes start with `$2…`, and dotenv-expand (used by `@next/env` when
 * loading local `.env` files) mangles `$`-prefixed values. To stay robust across
 * environments we accept EITHER form:
 *   - a base64-encoded bcrypt hash (recommended; what `npm run admin:hash` emits —
 *     no `$`, so it survives local `.env` parsing), or
 *   - a raw `$2…` bcrypt hash (fine on Vercel, whose env vars aren't dotenv-parsed).
 */
function resolveAdminHash(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('$2')) return value; // already a raw bcrypt hash
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded.startsWith('$2') ? decoded : '';
  } catch {
    return '';
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '').trim().toLowerCase();
        const password = String(credentials?.password ?? '');

        if (!email || !password) return null;

        // 1) DB-backed admins first. The stored `passwordHash` is a raw bcrypt
        //    hash (`$2…`), so `bcrypt.compare` works directly — no base64 dance
        //    (that's only needed for the dotenv-mangled ENV var).
        try {
          const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
          if (user) {
            const ok = await bcrypt.compare(password, user.passwordHash);
            if (!ok) return null;
            return {
              id: String(user.id),
              email: user.email,
              name: user.name ?? 'Admin',
              role: user.role,
            };
          }
        } catch {
          // A DB hiccup must not lock out the env bootstrap admin below.
        }

        // 2) Fall back to the env bootstrap (commissioner) admin so the
        //    commissioner can always sign in — even before any DB users exist.
        const adminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
        const adminHash = resolveAdminHash(process.env.ADMIN_PASSWORD_HASH ?? '');

        // Misconfiguration → deny rather than silently allow.
        if (!adminEmail || !adminHash) return null;
        if (email !== adminEmail) return null;

        const ok = await bcrypt.compare(password, adminHash);
        if (!ok) return null;

        return { id: 'admin', email: adminEmail, name: 'Commissioner', role: 'admin' };
      },
    }),
  ],
});
