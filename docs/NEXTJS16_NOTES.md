# Next.js 16.2.9 + React 19 + Tailwind v4 — Conventions Cheat Sheet

> Extracted from the docs bundled in `node_modules/next/dist/docs/` for **this project's exact
> versions**. Next.js 16 has breaking changes vs. 13/14 — read this before writing routes,
> components, or data-access code. Do not rely on older Next.js knowledge.

## Project-wide decisions (this repo)

- **`cacheComponents` is OFF** for v1 (default). We render data pages dynamically from Postgres.
  We do **not** use the `'use cache'` / `cacheLife` model yet; the legacy `export const dynamic` /
  `revalidate` segment config is therefore still valid.
- **All DB access uses the Node.js runtime** (`export const runtime = 'nodejs'` where ambiguous).
  Neon's serverless driver runs on Node; never put DB calls behind `runtime = 'edge'`.
- Pages that read live league data (standings, dashboard) use `export const dynamic = 'force-dynamic'`
  or `export const revalidate = <seconds>` so they reflect the latest scores.

## 1. Async request APIs

`params` and `searchParams` are **Promises** in pages/layouts. `cookies()`, `headers()`,
`draftMode()` are **async**.

```tsx
export default async function Page({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { slug } = await params
  const sp = await searchParams
}
```

```tsx
import { cookies, headers } from 'next/headers'
const cookieStore = await cookies()   // .get/.getAll/.has; .set/.delete only in actions/handlers
const headersList = await headers()   // read-only
```

## 2. Route handlers (`app/api/.../route.ts`)

```tsx
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  return Response.json({ ok: true })
}
export async function POST(request: Request) {
  const body = await request.json()
  return Response.json({ created: true }, { status: 201 })
}
```

Dynamic params via typed context:

```tsx
import type { RouteContext } from 'next'
export async function GET(_req: Request, ctx: RouteContext<'/items/[id]'>) {
  const { id } = await ctx.params
}
```

GET handlers are **NOT cached by default**. Opt in with `export const dynamic = 'force-static'`.

## 3. Server vs Client Components

Server Components are the default; they may be `async` and access the DB/secrets directly.
Add `'use client'` only for state, effects, event handlers, or browser APIs. Data passed
Server→Client must be serializable.

## 4. Server Actions

```tsx
'use server'
import { revalidatePath } from 'next/cache'
export async function createOwner(formData: FormData) {
  // ...mutate DB...
  revalidatePath('/admin/owners')
}
```

Use from a `<form action={createOwner}>` or via `useActionState` in a client component.

## 5. Data fetching & caching (cacheComponents OFF)

- `fetch()` is not cached by default. Control with `{ cache: 'no-store' }`,
  `{ cache: 'force-cache' }`, or `{ next: { revalidate: N, tags: [...] } }`.
- Segment config still valid: `export const dynamic = 'force-dynamic' | 'force-static'`,
  `export const revalidate = 3600`, `export const fetchCache = ...`.
- For our ESPN schedule fetch, use `{ next: { revalidate: 3600 } }` (hourly) — it changes rarely.

## 6. `next.config.ts`

```tsx
import type { NextConfig } from 'next'
const nextConfig: NextConfig = {
  images: { remotePatterns: [{ protocol: 'https', hostname: 'a.espncdn.com' }] },
}
export default nextConfig
```

## 7. Metadata

Static `export const metadata: Metadata = {...}` or async `generateMetadata({ params })`.

## 8. Environment variables

Server-only vars are plain (`DATABASE_URL`); only `NEXT_PUBLIC_*` reach the client (inlined at
build). Secrets live in `.env.local` (git-ignored).

## 9. Runtime: Node vs Edge

`export const runtime = 'nodejs'` (default) for anything touching Postgres/Neon. `'edge'` is
lightweight but lacks Node APIs and is unsuitable for our DB layer.

## 10. Middleware

`middleware.ts` at project root; use for `/admin` auth gating via `NextResponse.redirect`.

## 11. Tailwind v4

No `tailwind.config.js`. Config is CSS-based in `globals.css`:

```css
@import "tailwindcss";
@theme { --color-primary: #3b82f6; }   /* usable as bg-primary, text-primary, etc. */
```

Dark mode via `@theme` inside `@media (prefers-color-scheme: dark)` (or a `.dark` variant).

## Top pitfalls coming from Next 13/14

1. `params`/`searchParams` are Promises — always `await`.
2. `cookies()`/`headers()`/`draftMode()` are async.
3. `fetch()` is not cached by default.
4. No `tailwind.config.js` — use `@theme` in CSS.
5. Edge runtime can't run the DB client — keep DB on Node.
6. Server Actions and async Server Components must be `async`.
