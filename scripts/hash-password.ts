/**
 * Generate the commissioner password hash for ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   npm run admin:hash -- "your-password-here"
 *
 * Emits the bcrypt hash **base64-encoded**. We base64 it because a raw bcrypt
 * hash starts with `$2…`, and dotenv-expand (used by `@next/env` for local
 * `.env` files) mangles `$`-prefixed values. The base64 form has no `$`, so it
 * works in `.env.local`, in CI, and pasted into Vercel's env settings alike.
 * (`src/auth.ts` also accepts a raw `$2…` hash, e.g. if you paste one directly
 * into Vercel.) The plain password is never stored.
 */
import bcrypt from 'bcryptjs';

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: npm run admin:hash -- "your-password-here"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Refusing to hash: choose a password of at least 8 characters.');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 12);
  const encoded = Buffer.from(hash, 'utf8').toString('base64');
  console.log('\nADMIN_PASSWORD_HASH=' + encoded + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
