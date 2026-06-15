'use client';

/**
 * Client wrapper for the two Schedule pipeline buttons. Each button is its own
 * `useActionState` form so they show independent pending state, and a shared
 * banner area surfaces the most recent result (success or error) returned by the
 * server action.
 */
import { useActionState } from 'react';

import { SubmitButton } from '@/components/ui/submit-button';

import {
  pullScheduleAction,
  generateMatchupsAction,
  INITIAL_SCHEDULE_STATE,
  type ScheduleActionState,
} from './actions';

function ResultBanner({ state }: { state: ScheduleActionState }) {
  if (state.status === 'idle') return null;
  const isError = state.status === 'error';
  return (
    <p
      role="status"
      aria-live="polite"
      className={
        isError
          ? 'rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-sm text-loss'
          : 'rounded-md border border-win/30 bg-win-soft px-3 py-2 text-sm text-win'
      }
    >
      {state.message}
    </p>
  );
}

export function PipelineActions() {
  const [pullState, pullAction] = useActionState<ScheduleActionState, FormData>(
    pullScheduleAction,
    INITIAL_SCHEDULE_STATE,
  );
  const [genState, genAction] = useActionState<ScheduleActionState, FormData>(
    generateMatchupsAction,
    INITIAL_SCHEDULE_STATE,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <form action={pullAction}>
          <SubmitButton pendingText="Pulling from ESPN…">Pull / refresh NFL schedule</SubmitButton>
        </form>
        <form action={genAction}>
          <SubmitButton variant="secondary" pendingText="Generating…">
            Generate owner matchups
          </SubmitButton>
        </form>
      </div>
      <ResultBanner state={pullState} />
      <ResultBanner state={genState} />
      <p className="text-xs text-subtle">
        Both steps are idempotent — re-running them is safe. Pull the schedule first, finish team
        assignments, then generate matchups.
      </p>
    </div>
  );
}
