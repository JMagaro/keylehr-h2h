/**
 * CLI: create (or update the password of) a DB-backed admin account.
 *
 * Handy for bootstrapping the first extra admin without going through the UI,
 * or for resetting a forgotten password. The password is stored only as a raw
 * bcrypt hash (`$2…`) — `src/auth.ts` compares against it directly.
 *
 * Usage:
 *   npm run admin:create -- --email=you@example.com --password=secret123 [--name="Jane Doe"]
 *
 * Requires DATABASE_URL (loaded from .env.local/.env via @/load-env). The env
 * commissioner (ADMIN_EMAIL) is separate and always works regardless of this table.
 */
import '@/load-env'; // must precede any import that reads process.env (e.g. @/db)

import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import { db, users } from '@/db';

interface CliOptions {
  email: string;
  password: string;
  name?: string;
}

/** Parse `--key=value` / `--key value` flags from argv. */
function parseArgs(argv: string[]): CliOptions {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      raw[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      raw[arg.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }

  const email = (raw.email ?? '').trim().toLowerCase();
  const password = raw.password ?? '';
  const name = raw.name?.trim() || undefined;

  if (!email || !email.includes('@')) {
    throw new Error('Missing/invalid --email. Usage: --email=you@example.com --password=... [--name="..."]');
  }
  if (password.length < 8) {
    throw new Error('--password must be at least 8 characters.');
  }

  return { email, password, name };
}

async function main(): Promise<void> {
  const { email, password, name } = parseArgs(process.argv.slice(2));

  const passwordHash = await bcrypt.hash(password, 12);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    await db
      .update(users)
      .set({ passwordHash, ...(name !== undefined ? { name } : {}) })
      .where(eq(users.id, existing.id));
    console.log(`Updated admin ${email} (id=${existing.id}).`);
  } else {
    const [inserted] = await db
      .insert(users)
      .values({ email, name: name ?? null, passwordHash, role: 'admin' })
      .returning({ id: users.id });
    console.log(`Created admin ${email} (id=${inserted.id}).`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('\nadmin:create failed:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
