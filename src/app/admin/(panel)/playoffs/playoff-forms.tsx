'use client';

/**
 * Client form wrappers for the admin Playoffs page. Each drives a server action
 * via `useActionState`, surfacing inline success/error. The actions + the
 * playoff service remain the source of truth.
 */
import { useActionState } from 'react';

import { Field, Input, Select } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import {
  advanceBracketAction,
  generateBracketAction,
  setContestIdsAction,
  setWinnerAction,
  type PlayoffFormState,
} from './actions';

type PlayoffAction = (
  prev: PlayoffFormState,
  formData: FormData,
) => Promise<PlayoffFormState>;

function StatusBanner({ state }: { state: PlayoffFormState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-sm text-loss"
      >
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p
        role="status"
        className="rounded-md border border-win/30 bg-win-soft px-3 py-2 text-sm text-win"
      >
        {state.message ?? 'Saved.'}
      </p>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Generate bracket                                                            */
/* -------------------------------------------------------------------------- */

export function GenerateBracketForm({ seasonId }: { seasonId: number }) {
  const action: PlayoffAction = generateBracketAction;
  const [state, formAction] = useActionState<PlayoffFormState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <p className="text-sm text-muted">
        Seed the wild-card round from the configured regular-season standings. Idempotent — safe to
        re-run. The seeding uses this season&rsquo;s playoff rules (teams/byes), not hardcoded values.
      </p>
      <div>
        <SubmitButton>Generate bracket</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Advance bracket                                                             */
/* -------------------------------------------------------------------------- */

export function AdvanceBracketForm({ seasonId }: { seasonId: number }) {
  const action: PlayoffAction = advanceBracketAction;
  const [state, formAction] = useActionState<PlayoffFormState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <p className="text-sm text-muted">
        Resolve every fully-scored round and generate the next. The champion is recorded
        automatically when the title game resolves. Ingesting playoff scores (weeks 19&ndash;22) and
        re-running this advances the bracket the same way.
      </p>
      <div>
        <SubmitButton variant="secondary">Advance bracket</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Playoff-week contest ids                                                    */
/* -------------------------------------------------------------------------- */

export type ContestDefault = { week: number; round: string; dkContestId: string };

export function ContestIdsForm({
  seasonId,
  defaults,
}: {
  seasonId: number;
  defaults: ContestDefault[];
}) {
  const action: PlayoffAction = setContestIdsAction;
  const [state, formAction] = useActionState<PlayoffFormState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="seasonId" value={seasonId} />
      <p className="text-sm text-muted">
        Set the DraftKings contest id for each playoff week so the extension syncs playoff scores
        exactly like a regular-season week.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {defaults.map((c) => (
          <Field key={c.week} label={`Week ${c.week} — ${c.round}`} htmlFor={`contest_${c.week}`}>
            <Input
              id={`contest_${c.week}`}
              name={`contest_${c.week}`}
              type="text"
              inputMode="numeric"
              placeholder="DK contest id"
              defaultValue={c.dkContestId}
            />
          </Field>
        ))}
      </div>
      <div>
        <SubmitButton>Save contest ids</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-game winner override                                                    */
/* -------------------------------------------------------------------------- */

export type OverrideOption = { ownerSeasonId: number; label: string };

export function WinnerOverrideForm({
  seasonId,
  playoffMatchupId,
  options,
  currentWinnerOwnerSeasonId,
}: {
  seasonId: number;
  playoffMatchupId: number;
  options: OverrideOption[];
  currentWinnerOwnerSeasonId: number | null;
}) {
  const action: PlayoffAction = setWinnerAction;
  const [state, formAction] = useActionState<PlayoffFormState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="playoffMatchupId" value={playoffMatchupId} />
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            name="winnerOwnerSeasonId"
            aria-label="Winner override"
            defaultValue={currentWinnerOwnerSeasonId ?? ''}
          >
            <option value="">— pick winner —</option>
            {options.map((o) => (
              <option key={o.ownerSeasonId} value={o.ownerSeasonId}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <SubmitButton size="sm" variant="ghost">
          Set
        </SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}
