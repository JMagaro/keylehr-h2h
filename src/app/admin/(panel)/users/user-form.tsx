'use client';

/**
 * "Add admin" form. Drives `createUser` via `useActionState`, surfacing
 * server-side validation errors inline. The server action is the source of
 * truth — these inputs only carry hints. On success the form is reset.
 */
import { useActionState, useEffect, useRef } from 'react';

import { Field, Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import { createUser, type UserFormState } from './actions';

export function UserForm() {
  const [state, formAction] = useActionState<UserFormState, FormData>(createUser, {});
  const fieldErrors = state.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state.ok]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-4">
      <Field label="Name" htmlFor="name" hint="Optional. Shown in the admin list." error={fieldErrors.name}>
        <Input
          id="name"
          name="name"
          type="text"
          maxLength={128}
          autoComplete="name"
          aria-invalid={fieldErrors.name ? true : undefined}
        />
      </Field>

      <Field label="Email" htmlFor="email" required error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          maxLength={256}
          required
          autoComplete="email"
          aria-invalid={fieldErrors.email ? true : undefined}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="password"
        required
        hint="At least 8 characters. Stored only as a bcrypt hash."
        error={fieldErrors.password}
      >
        <Input
          id="password"
          name="password"
          type="password"
          minLength={8}
          required
          autoComplete="new-password"
          aria-invalid={fieldErrors.password ? true : undefined}
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

      {state.ok ? (
        <p
          role="status"
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-muted"
        >
          Admin added.
        </p>
      ) : null}

      <SubmitButton pendingText="Adding…" className="mt-1 self-start">
        Add admin
      </SubmitButton>
    </form>
  );
}
