'use client';

import { useActionState } from 'react';

import { Field, Input } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';

import { loginAction, type LoginState } from './actions';

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Email" htmlFor="email" required>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password" required>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
      {state?.error ? (
        <p className="rounded-md border border-loss/30 bg-loss-soft px-3 py-2 text-sm text-loss">
          {state.error}
        </p>
      ) : null}
      <SubmitButton pendingText="Signing in…" className="mt-1 w-full">
        Sign in
      </SubmitButton>
    </form>
  );
}
