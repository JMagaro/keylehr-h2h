'use client';

/**
 * Client forms for Admin → Models: trigger a snapshot or a grade for the selected week.
 * Each drives a server action via useActionState with an inline status banner.
 */
import { useActionState } from 'react';

import { SubmitButton } from '@/components/ui/submit-button';

import {
  gradeWeekAction,
  snapshotWeekAction,
  type ModelsFormState,
} from './actions';

function StatusBanner({ state }: { state: ModelsFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-sm text-loss">
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p role="status" className="rounded-md border border-win/30 bg-win-soft px-3 py-2 text-sm text-win">
        {state.message ?? 'Done.'}
      </p>
    );
  }
  return null;
}

export function SnapshotForm({ seasonId, week }: { seasonId: number; week: number }) {
  const [state, formAction] = useActionState<ModelsFormState, FormData>(snapshotWeekAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="week" value={week} />
      <p className="text-sm text-muted">
        Record what all three models recommend for week {week}, right now. Run near lineup lock.
        Re-running replaces the snapshot (and clears its grade).
      </p>
      <div>
        <SubmitButton>Snapshot week {week}</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}

export function GradeForm({ seasonId, week }: { seasonId: number; week: number }) {
  const [state, formAction] = useActionState<ModelsFormState, FormData>(gradeWeekAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="week" value={week} />
      <p className="text-sm text-muted">
        Score week {week}&apos;s snapshots against actual player results (Sleeper). Run after the
        games finish; safe to re-run as late stats settle.
      </p>
      <div>
        <SubmitButton variant="secondary">Grade week {week}</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}
