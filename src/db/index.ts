/**
 * Drizzle database client (Neon serverless Postgres).
 *
 * IMPORTANT: this module must only be imported from server-side code (Server
 * Components, Server Actions, Route Handlers, scripts). It runs on the Node.js
 * runtime — never import it into a `'use client'` module or an edge route.
 */
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Fail loud and early when a query is attempted without configuration, rather
  // than emitting a confusing driver error deep in a request.
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.',
  );
}

const sql = neon(connectionString);

export const db = drizzle({ client: sql, schema, casing: 'snake_case' });

export * from './schema';
export { schema };
