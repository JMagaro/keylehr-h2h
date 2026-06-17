'use client';

/**
 * Client form for Admin → Slates: one input per regular-season week for the DraftKings
 * draft group id. Drives `setDraftGroupIdsAction` via `useActionState` with inline status.
 */
import { useActionState } from 'react';

import { Field, Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import { setDraftGroupIdsAction, type SlateFormState } from './actions';

export type SlateDefault = { week: number; draftGroupId: string };

function StatusBanner({ state }: { state: SlateFormState }) {
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

export function DraftGroupForm({
  seasonId,
  defaults,
}: {
  seasonId: number;
  defaults: SlateDefault[];
}) {
  const [state, formAction] = useActionState<SlateFormState, FormData>(setDraftGroupIdsAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="seasonId" value={seasonId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {defaults.map((d) => (
          <Field key={d.week} label={`Week ${d.week}`} htmlFor={`dg_${d.week}`}>
            <Input
              id={`dg_${d.week}`}
              name={`dg_${d.week}`}
              type="text"
              inputMode="numeric"
              placeholder="draft group id or URL"
              defaultValue={d.draftGroupId}
            />
          </Field>
        ))}
      </div>
      <div>
        <SubmitButton>Save draft groups</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}
