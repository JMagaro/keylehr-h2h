'use client';

/**
 * Shared create/edit form for an owner. Drives `createOwner` or `updateOwner`
 * via `useActionState`, surfacing server-side validation errors inline. The
 * server action is the source of truth — these inputs only carry hints.
 */
import { useActionState } from 'react';

import { Field, Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import { type OwnerFormState } from './actions';

type OwnerAction = (prev: OwnerFormState, formData: FormData) => Promise<OwnerFormState>;

export type OwnerFormDefaults = {
  id?: number;
  name?: string;
  email?: string | null;
  phone?: string | null;
  dkUsername?: string | null;
};

export function OwnerForm({
  action,
  defaults,
  submitLabel,
  pendingLabel,
}: {
  action: OwnerAction;
  defaults?: OwnerFormDefaults;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction] = useActionState<OwnerFormState, FormData>(action, {});
  const fieldErrors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {defaults?.id !== undefined ? (
        <input type="hidden" name="id" value={defaults.id} />
      ) : null}

      <Field label="Name" htmlFor="name" required error={fieldErrors.name}>
        <Input
          id="name"
          name="name"
          type="text"
          maxLength={128}
          required
          autoComplete="name"
          defaultValue={defaults?.name ?? ''}
          aria-invalid={fieldErrors.name ? true : undefined}
        />
      </Field>

      <Field
        label="Email"
        htmlFor="email"
        hint="Optional."
        error={fieldErrors.email}
      >
        <Input
          id="email"
          name="email"
          type="email"
          maxLength={256}
          autoComplete="email"
          defaultValue={defaults?.email ?? ''}
          aria-invalid={fieldErrors.email ? true : undefined}
        />
      </Field>

      <Field label="Phone" htmlFor="phone" hint="Optional." error={fieldErrors.phone}>
        <Input
          id="phone"
          name="phone"
          type="tel"
          maxLength={32}
          autoComplete="tel"
          defaultValue={defaults?.phone ?? ''}
          aria-invalid={fieldErrors.phone ? true : undefined}
        />
      </Field>

      <Field
        label="DraftKings username"
        htmlFor="dkUsername"
        hint="Optional. The handle used in weekly contests."
        error={fieldErrors.dkUsername}
      >
        <Input
          id="dkUsername"
          name="dkUsername"
          type="text"
          maxLength={128}
          defaultValue={defaults?.dkUsername ?? ''}
          aria-invalid={fieldErrors.dkUsername ? true : undefined}
        />
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-sm text-loss"
        >
          {state.error}
        </p>
      ) : null}

      <SubmitButton pendingText={pendingLabel} className="mt-1 self-start">
        {submitLabel}
      </SubmitButton>
    </form>
  );
}
