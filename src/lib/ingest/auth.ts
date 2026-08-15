/**
 * Bearer-token auth shared by every ingest route.
 *
 * Extracted from `src/app/api/ingest/draftkings/route.ts` when the roster-capture endpoint
 * was added, so both routes enforce the same contract. Behaviour is unchanged.
 *
 * The token is `INGEST_TOKEN`. A server with no token configured rejects EVERYTHING rather
 * than falling open — a misconfigured deploy must not become an unauthenticated write path.
 */

/** Constant-time string comparison that avoids leaking length via early return. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Compare against the longer length so timing does not depend on the shorter input.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <INGEST_TOKEN>`. */
export function isAuthorized(request: Request): boolean {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) return false; // Misconfigured server → reject everything.
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}
