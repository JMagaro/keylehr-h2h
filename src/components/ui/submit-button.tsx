'use client';

/**
 * Submit button that reflects the enclosing form's pending state (React 19
 * `useFormStatus`). Use inside any `<form action={serverAction}>`.
 */
import { useFormStatus } from 'react-dom';

import { buttonClasses, type ButtonSize, type ButtonVariant } from './button';

export function SubmitButton({
  children,
  pendingText,
  variant = 'primary',
  size = 'md',
  className,
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClasses(variant, size, className)}>
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
