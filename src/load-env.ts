/**
 * Environment loader for `tsx` CLI scripts and tooling.
 *
 * Next.js loads `.env.local` automatically, but standalone scripts run through
 * `tsx` (seed, schedule pull, etc.) do not. Import this module FOR ITS SIDE
 * EFFECT as the very first import in such a script — before any module that
 * reads `process.env` (e.g. the `@/db` client) — so the connection string is in
 * place before those modules initialize.
 *
 *   import '@/load-env';
 *   import { db } from '@/db';
 *
 * Loads `.env.local` first (Next.js convention for local secrets), then `.env`.
 * dotenv does not override already-set variables, so `.env.local` wins, and real
 * shell/CI environment variables win over both.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });
config();
