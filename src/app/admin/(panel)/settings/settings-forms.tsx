'use client';

/**
 * Client form wrappers for the admin Settings page. Each drives its server
 * action via `useActionState`, surfacing inline success/error and pending
 * state. The server actions + `seasonRulesSchema` remain the source of truth;
 * these inputs only carry sensible defaults and light client-side bounds.
 */
import { useActionState } from 'react';

import { CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { Field, Input, Select } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import type { SeasonRules } from '@/lib/rules/schema';

import { updateSeasonMeta, updateSeasonRules, type SettingsFormState } from './actions';

type SettingsAction = (
  prev: SettingsFormState,
  formData: FormData,
) => Promise<SettingsFormState>;

/** Convert whole cents to a dollar string for a money <input>, e.g. 15500 → "155". */
function centsToDollarInput(cents: number): string {
  return (cents / 100).toString();
}

/** Inline success / error banner shared by both forms. */
function StatusBanner({ state }: { state: SettingsFormState }) {
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
        Saved.
      </p>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Season meta                                                                 */
/* -------------------------------------------------------------------------- */

export type SeasonMetaDefaults = {
  seasonId: number;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
  currentWeek: number;
  regularSeasonWeeks: number;
  entryFeeCents: number;
};

export function SeasonMetaForm({ defaults }: { defaults: SeasonMetaDefaults }) {
  const action: SettingsAction = updateSeasonMeta;
  const [state, formAction] = useActionState<SettingsFormState, FormData>(action, {});

  return (
    <>
      <CardHeader>
        <CardTitle>Season</CardTitle>
        <CardDescription>
          Core season meta. The entry fee is the canonical per-owner amount used across payouts.
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="seasonId" value={defaults.seasonId} />

          <Field label="Name" htmlFor="name" required>
            <Input
              id="name"
              name="name"
              type="text"
              maxLength={64}
              required
              defaultValue={defaults.name}
            />
          </Field>

          <Field label="Status" htmlFor="status" required>
            <Select id="status" name="status" defaultValue={defaults.status} required>
              <option value="upcoming">Upcoming</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
            </Select>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Current week" htmlFor="currentWeek" required>
              <Input
                id="currentWeek"
                name="currentWeek"
                type="number"
                min={1}
                max={25}
                step={1}
                required
                defaultValue={defaults.currentWeek}
              />
            </Field>

            <Field label="Regular-season weeks" htmlFor="regularSeasonWeeks" required>
              <Input
                id="regularSeasonWeeks"
                name="regularSeasonWeeks"
                type="number"
                min={1}
                max={25}
                step={1}
                required
                defaultValue={defaults.regularSeasonWeeks}
              />
            </Field>
          </div>

          <Field
            label="Entry fee (USD)"
            htmlFor="entryFeeDollars"
            required
            hint="Per owner, in dollars (e.g. 155 or 155.50). Stored as cents."
          >
            <Input
              id="entryFeeDollars"
              name="entryFeeDollars"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              required
              defaultValue={centsToDollarInput(defaults.entryFeeCents)}
            />
          </Field>

          <StatusBanner state={state} />

          <SubmitButton pendingText="Saving…" className="mt-1 self-start">
            Save season
          </SubmitButton>
        </form>
      </CardBody>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Season rules                                                                */
/* -------------------------------------------------------------------------- */

const TIEBREAKER_LABELS: Record<SeasonRules['tiebreakers'][number], string> = {
  h2h: 'Head-to-head',
  pf: 'Points for',
  pa: 'Points against',
};

/** A labelled dollar (USD) input pre-filled from a cents value. */
function MoneyField({
  label,
  name,
  cents,
}: {
  label: string;
  name: string;
  cents: number;
}) {
  return (
    <Field label={label} htmlFor={name} hint="USD">
      <Input
        id={name}
        name={name}
        type="number"
        min={0}
        step="0.01"
        inputMode="decimal"
        defaultValue={centsToDollarInput(cents)}
      />
    </Field>
  );
}

export function SeasonRulesForm({
  seasonId,
  rules,
}: {
  seasonId: number;
  rules: SeasonRules;
}) {
  const action: SettingsAction = updateSeasonRules;
  const [state, formAction] = useActionState<SettingsFormState, FormData>(action, {});

  const order = rules.tiebreakers;
  const allKeys: SeasonRules['tiebreakers'] = ['h2h', 'pf', 'pa'];

  return (
    <>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>
          Per-season league rules. Values inherit the league defaults until changed here.
        </CardDescription>
      </CardHeader>
      <CardBody>
        <form action={formAction} className="flex flex-col gap-6">
          <input type="hidden" name="seasonId" value={seasonId} />

          {/* Regular season */}
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-foreground">Regular season</legend>
            <Field
              label="Regular-season weeks"
              htmlFor="rulesRegularSeasonWeeks"
              hint="Used by standings/scoring. NFL is 18."
            >
              <Input
                id="rulesRegularSeasonWeeks"
                name="regularSeasonWeeks"
                type="number"
                min={1}
                max={25}
                step={1}
                defaultValue={rules.regularSeasonWeeks}
              />
            </Field>
          </fieldset>

          {/* Tiebreakers */}
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-foreground">Standings tiebreakers</legend>
            <p className="text-xs text-muted">Applied top to bottom. Each rank must be distinct.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Field key={i} label={`Tiebreaker ${i + 1}`} htmlFor={`tiebreaker${i}`}>
                  <Select id={`tiebreaker${i}`} name={`tiebreaker${i}`} defaultValue={order[i]}>
                    {allKeys.map((key) => (
                      <option key={key} value={key}>
                        {TIEBREAKER_LABELS[key]}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </fieldset>

          {/* Playoffs */}
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-foreground">Playoffs</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Teams per conference" htmlFor="teamsPerConference">
                <Input
                  id="teamsPerConference"
                  name="teamsPerConference"
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  defaultValue={rules.playoffs.teamsPerConference}
                />
              </Field>
              <Field label="Division winners / conference" htmlFor="divisionWinnersPerConference">
                <Input
                  id="divisionWinnersPerConference"
                  name="divisionWinnersPerConference"
                  type="number"
                  min={0}
                  max={8}
                  step={1}
                  defaultValue={rules.playoffs.divisionWinnersPerConference}
                />
              </Field>
              <Field label="Wild cards / conference" htmlFor="wildCardsPerConference">
                <Input
                  id="wildCardsPerConference"
                  name="wildCardsPerConference"
                  type="number"
                  min={0}
                  max={12}
                  step={1}
                  defaultValue={rules.playoffs.wildCardsPerConference}
                />
              </Field>
              <Field label="Top-seed byes" htmlFor="topSeedByes">
                <Input
                  id="topSeedByes"
                  name="topSeedByes"
                  type="number"
                  min={0}
                  max={4}
                  step={1}
                  defaultValue={rules.playoffs.topSeedByes}
                />
              </Field>
            </div>
            <Field label="Matchup tiebreaker" htmlFor="playoffTieBreaker">
              <Select
                id="playoffTieBreaker"
                name="playoffTieBreaker"
                defaultValue={rules.playoffs.tieBreaker}
              >
                <option value="regular_season_pf">Regular-season points for</option>
                <option value="higher_seed">Higher seed</option>
              </Select>
            </Field>
          </fieldset>

          {/* Bye week */}
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-foreground">Bye week</legend>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                name="byeCountsTowardPointsFor"
                defaultChecked={rules.byeWeek.countsTowardPointsFor}
                className="h-4 w-4 rounded border-border text-accent focus-visible:ring-2 focus-visible:ring-accent"
              />
              Bye-week points count toward Points For
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                name="byeEligibleForWeeklyHigh"
                defaultChecked={rules.byeWeek.eligibleForWeeklyHigh}
                className="h-4 w-4 rounded border-border text-accent focus-visible:ring-2 focus-visible:ring-accent"
              />
              Bye-week score eligible for the weekly high prize
            </label>
          </fieldset>

          {/* Missed lineup */}
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-foreground">Missed lineup</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Result for owner" htmlFor="missedResult">
                <Select id="missedResult" name="missedResult" defaultValue={rules.missedLineup.result}>
                  <option value="auto_loss">Automatic loss</option>
                  <option value="none">None</option>
                </Select>
              </Field>
              <Field label="Opponent scores" htmlFor="missedOpponentScores">
                <Select
                  id="missedOpponentScores"
                  name="missedOpponentScores"
                  defaultValue={rules.missedLineup.opponentScores}
                >
                  <option value="league_average">League average</option>
                  <option value="zero">Zero</option>
                  <option value="actual">Actual</option>
                </Select>
              </Field>
            </div>
          </fieldset>

          {/* Payouts */}
          <fieldset className="flex flex-col gap-4">
            <legend className="text-sm font-semibold text-foreground">Payouts</legend>
            <p className="text-xs text-muted">
              All amounts in USD. The entry fee is edited in the Season card above.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <MoneyField label="Weekly high" name="weeklyHighDollars" cents={rules.payouts.weeklyHighCents} />
              <Field label="Weekly high weeks" htmlFor="weeklyHighWeeks" hint="Count of paid weeks">
                <Input
                  id="weeklyHighWeeks"
                  name="weeklyHighWeeks"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={rules.payouts.weeklyHighWeeks}
                />
              </Field>
              <MoneyField label="Season high" name="seasonHighDollars" cents={rules.payouts.seasonHighCents} />
              <MoneyField
                label="Most regular-season points"
                name="mostRegularSeasonPointsDollars"
                cents={rules.payouts.mostRegularSeasonPointsCents}
              />
              <MoneyField label="Champion" name="championDollars" cents={rules.payouts.championCents} />
              <MoneyField label="Runner-up" name="runnerUpDollars" cents={rules.payouts.runnerUpCents} />
              <MoneyField label="Third" name="thirdDollars" cents={rules.payouts.thirdCents} />
              <MoneyField label="Fourth" name="fourthDollars" cents={rules.payouts.fourthCents} />
            </div>
          </fieldset>

          <StatusBanner state={state} />

          <SubmitButton pendingText="Saving…" className="self-start">
            Save rules
          </SubmitButton>
        </form>
      </CardBody>
    </>
  );
}
