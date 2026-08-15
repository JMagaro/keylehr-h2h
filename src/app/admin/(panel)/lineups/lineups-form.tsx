'use client';

/**
 * Client form for Admin → Lineups: paste a DraftKings roster payload.
 * Drives `pasteLineupsAction` via useActionState, matching the other admin forms.
 */
import { useActionState } from 'react';

import { Field, Input, Textarea } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import { pasteLineupsAction, type LineupFormState } from './actions';

export function PasteLineupsForm({ seasonId, week }: { seasonId: number; week: number }) {
  const [state, formAction] = useActionState<LineupFormState, FormData>(pasteLineupsAction, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="seasonId" value={seasonId} />
      <input type="hidden" name="week" value={week} />

      <Field
        label="DraftKings roster JSON"
        htmlFor="lineupJson"
        required
        hint="Paste whatever DraftKings returned — the whole response is fine. Roster rows are found structurally, so the exact shape does not matter."
      >
        <Textarea
          id="lineupJson"
          name="json"
          rows={8}
          placeholder='e.g. {"leaderBoard":[{"userName":"...","roster":{"scorecards":[{"draftableId":1,"rosterPosition":"QB","displayName":"Josh Allen","teamAbbreviation":"BUF"}, ...]}}]}'
          required
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Entry name"
          htmlFor="lineupEntryName"
          hint="Only needed when the payload is a single roster with no entry name in it."
        >
          <Input id="lineupEntryName" name="entryName" placeholder="(optional)" />
        </Field>
        <Field label="DK contest id" htmlFor="lineupContestId" hint="Optional — stored for traceability.">
          <Input id="lineupContestId" name="contestId" placeholder="(optional)" inputMode="numeric" />
        </Field>
      </div>

      <Field
        label="DK draft group id"
        htmlFor="lineupDraftGroupId"
        hint="Needed to score this capture. DraftKings' roster payload gives only player ids — no team, no position — so without the draft group there is nothing to resolve them against. It is the number in the roster URL: scores/v2/entries/152064/… → 152064."
      >
        <Input
          id="lineupDraftGroupId"
          name="draftGroupId"
          placeholder="e.g. 152064"
          inputMode="numeric"
        />
      </Field>

      <Field
        label="Source URL"
        htmlFor="lineupSourceUrl"
        hint="Optional but valuable — the DraftKings URL this payload came from. DK's roster endpoint is undocumented, so recording it here is how it stays known."
      >
        <Input
          id="lineupSourceUrl"
          name="sourceUrlTemplate"
          placeholder="https://api.draftkings.com/scores/v1/…"
        />
      </Field>

      <StatusBanner state={state} />

      <div>
        <SubmitButton pendingText="Capturing…">Capture lineups</SubmitButton>
      </div>
    </form>
  );
}

function StatusBanner({ state }: { state: LineupFormState }) {
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
      <div className="rounded-md border border-win/30 bg-win-soft px-3 py-2 text-sm text-win">
        <p role="status">{state.message ?? 'Done.'}</p>
        {state.unmatched && state.unmatched.length > 0 ? (
          <>
            {/* Unmatched names are surfaced by name, never silently dropped — an owner whose
                DK entry name changed is the most likely cause. */}
            <p className="mt-2 font-medium">Unmatched DraftKings entry names:</p>
            <ul className="mt-1 list-inside list-disc">
              {state.unmatched.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              Fix these in Admin → Assignments, which is where each owner&apos;s DK entry name
              lives, then paste again.
            </p>
          </>
        ) : null}
      </div>
    );
  }
  return null;
}
