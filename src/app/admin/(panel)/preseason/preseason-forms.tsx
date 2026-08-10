'use client';

/**
 * Client forms for Admin → Preseason: choose the preseason week, sync + generate the
 * exhibition matchups, and paste in scores. Each drives a server action via useActionState.
 */
import { useActionState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTransition } from 'react';

import { Field } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { MAX_PRESEASON_WEEK } from '@/lib/schedule/preseason';

import {
  pasteScoresAction,
  syncPreseasonAction,
  type PreseasonFormState,
} from './actions';

function StatusBanner({ state }: { state: PreseasonFormState }) {
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

/** Navigates `?season=&pre=N` to switch the active preseason week. */
export function PreseasonWeekSelect({
  seasonId,
  selected,
}: {
  seasonId: number;
  selected: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const weeks = Array.from({ length: MAX_PRESEASON_WEEK }, (_, i) => i + 1);
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium text-muted">Preseason week</span>
      <select
        aria-label="Preseason week"
        value={selected}
        disabled={isPending}
        onChange={(e) =>
          startTransition(() => router.push(`${pathname}?season=${seasonId}&pre=${e.target.value}`))
        }
        className="rounded-lg border border-border-strong bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm transition-colors hover:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60"
      >
        {weeks.map((w) => (
          <option key={w} value={w}>
            {w === 1 ? 'Week 1 (HOF)' : `Week ${w}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SyncForm({ seasonId, preseasonWeek }: { seasonId: number; preseasonWeek: number }) {
  const [state, formAction] = useActionState<PreseasonFormState, FormData>(syncPreseasonAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="preseasonWeek" value={preseasonWeek} />
      <p className="text-sm text-muted">
        Pull the NFL preseason week {preseasonWeek} schedule from ESPN and generate the owner-vs-owner
        exhibition matchups. Owners must be assigned for this season first (Admin → Assignments).
      </p>
      <div>
        <SubmitButton>Sync &amp; generate matchups</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}

export function PasteScoresForm({
  seasonId,
  preseasonWeek,
}: {
  seasonId: number;
  preseasonWeek: number;
}) {
  const [state, formAction] = useActionState<PreseasonFormState, FormData>(pasteScoresAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="preseasonWeek" value={preseasonWeek} />
      <Field label="Scores — one “Team, points” per line" htmlFor="scores">
        <textarea
          id="scores"
          name="scores"
          rows={8}
          placeholder={'Bills, 142.5\nCowboys, 118.2\n…'}
          className="w-full rounded-lg border border-border-strong bg-card px-3 py-2 font-mono text-sm text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-accent/40"
        />
      </Field>
      <p className="text-xs text-subtle">
        Team names must match the NFL team (e.g. “Bills”). Comma or tab separated. Owners with no
        line are left unscored. (The DraftKings extension also scores this week automatically if you
        set its contest.)
      </p>
      <div>
        <SubmitButton variant="secondary">Save exhibition scores</SubmitButton>
      </div>
      <StatusBanner state={state} />
    </form>
  );
}
