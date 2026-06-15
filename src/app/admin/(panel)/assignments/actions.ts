'use server';

/**
 * Server actions backing the admin Assignments page. Each owner is assigned to
 * exactly one NFL team per season via `owner_seasons`, which enforces two unique
 * constraints we must respect:
 *   - `owner_seasons_season_owner_uq` on (seasonId, ownerId)  — one team per owner
 *   - `owner_seasons_season_team_uq`  on (seasonId, nflTeamId) — one owner per team
 *
 * Assigning an owner to a team therefore has to free BOTH the owner's previous
 * team and the team's previous owner before inserting, or one of those unique
 * indexes would reject the write. We do the two deletes + insert as a single
 * `db.batch([...])`, which the Neon HTTP driver sends as one atomic SQL
 * transaction over one round-trip — so a concurrent request can never observe
 * (or collide with) a half-applied state.
 *
 * IMPORTANT (Neon HTTP driver): `db.transaction(async (tx) => ...)` is TYPED on
 * `drizzle-orm/neon-http` but THROWS at runtime ("No transactions support in
 * neon-http driver") — interactive transactions need a websocket pool. The HTTP
 * driver instead exposes `db.batch([...])`, which wraps the statements in a real
 * server-side transaction. We use `db.batch` here to get the atomicity we need
 * without interactive logic (our statements are unconditional given a non-null
 * owner, so a static batch is sufficient).
 *
 * Every action re-checks `requireAdmin()` (defense-in-depth on top of
 * middleware), validates input with zod (the server is the source of truth),
 * then `revalidatePath('/admin/assignments')`.
 */
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db, ownerSeasons } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';

/** Shape returned to `useActionState` for inline feedback on a row. */
export type AssignmentState = {
  /** Set on success so the row can flash a confirmation. */
  ok?: boolean;
  error?: string;
};

/**
 * Validation:
 *  - seasonId / nflTeamId: required positive integers.
 *  - ownerId: empty string / "0" → null (unassign the team).
 *  - dkEntryName: optional, ≤ 128 chars; empty string → null.
 */
const assignSchema = z.object({
  seasonId: z.coerce.number().int().positive(),
  nflTeamId: z.coerce.number().int().positive(),
  ownerId: z
    .union([z.literal(''), z.coerce.number().int()])
    .transform((v) => (v === '' || v === 0 ? null : v)),
  dkEntryName: z
    .string()
    .trim()
    .max(128, 'DraftKings entry name must be 128 characters or fewer.')
    .transform((v) => (v === '' ? null : v)),
});

function readForm(formData: FormData) {
  return {
    seasonId: String(formData.get('seasonId') ?? ''),
    nflTeamId: String(formData.get('nflTeamId') ?? ''),
    ownerId: String(formData.get('ownerId') ?? ''),
    dkEntryName: String(formData.get('dkEntryName') ?? ''),
  };
}

/**
 * Create / move / clear a single team's owner assignment for a season.
 *
 * - ownerId blank → delete any `owner_seasons` row for (season, team); the team
 *   becomes unassigned.
 * - ownerId set → within a transaction, delete any existing row for
 *   (season, ownerId) [moves the owner off a previous team] and for
 *   (season, nflTeamId) [frees this team of its previous owner], then insert the
 *   new (season, owner, team, dkEntryName). The two deletes + insert run
 *   atomically so neither unique index can be violated by a concurrent write.
 *
 */
export async function assignTeam(
  _prev: AssignmentState,
  formData: FormData,
): Promise<AssignmentState> {
  await requireAdmin();

  const parsed = assignSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid assignment.' };
  }

  const { seasonId, nflTeamId, ownerId, dkEntryName } = parsed.data;

  try {
    if (ownerId === null) {
      // Unassign: free the team. (No owner constraint to worry about.)
      await db
        .delete(ownerSeasons)
        .where(and(eq(ownerSeasons.seasonId, seasonId), eq(ownerSeasons.nflTeamId, nflTeamId)));
    } else {
      // Move/assign atomically: free the owner's old team AND this team's old
      // owner, then claim. Both deletes are required to satisfy the two unique
      // indexes; `db.batch` applies all three statements in one server-side
      // transaction so the swap is atomic.
      await db.batch([
        db
          .delete(ownerSeasons)
          .where(and(eq(ownerSeasons.seasonId, seasonId), eq(ownerSeasons.ownerId, ownerId))),
        db
          .delete(ownerSeasons)
          .where(and(eq(ownerSeasons.seasonId, seasonId), eq(ownerSeasons.nflTeamId, nflTeamId))),
        db.insert(ownerSeasons).values({ seasonId, ownerId, nflTeamId, dkEntryName }),
      ]);
    }
  } catch (err) {
    console.error('assignTeam failed', err);
    return { error: 'Could not save the assignment. Please try again.' };
  }

  revalidatePath('/admin/assignments');
  return { ok: true };
}

/**
 * Update only the DraftKings entry name on an already-assigned team. No-op (with
 * a friendly error) if the team has no owner yet — the entry name belongs to an
 * `owner_seasons` row, which only exists once a team is assigned.
 */
export async function updateDkEntryName(
  _prev: AssignmentState,
  formData: FormData,
): Promise<AssignmentState> {
  await requireAdmin();

  const parsed = assignSchema
    .pick({ seasonId: true, nflTeamId: true, dkEntryName: true })
    .safeParse(readForm(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid entry name.' };
  }

  const { seasonId, nflTeamId, dkEntryName } = parsed.data;

  const updated = await db
    .update(ownerSeasons)
    .set({ dkEntryName })
    .where(and(eq(ownerSeasons.seasonId, seasonId), eq(ownerSeasons.nflTeamId, nflTeamId)))
    .returning({ id: ownerSeasons.id });

  if (updated.length === 0) {
    return { error: 'Assign an owner to this team before setting a DraftKings entry name.' };
  }

  revalidatePath('/admin/assignments');
  return { ok: true };
}
