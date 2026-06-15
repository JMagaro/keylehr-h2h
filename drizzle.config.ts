import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load Next.js-style local env first (.env.local), then fall back to .env.
// dotenv does not override already-set vars, so .env.local takes precedence.
config({ path: '.env.local' });
config();

/**
 * drizzle-kit configuration.
 *
 *  - `npm run db:generate`  generate SQL migrations from src/db/schema.ts
 *  - `npm run db:migrate`   apply pending migrations to DATABASE_URL
 *  - `npm run db:push`      push the schema directly (dev convenience)
 *  - `npm run db:studio`    open Drizzle Studio
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
