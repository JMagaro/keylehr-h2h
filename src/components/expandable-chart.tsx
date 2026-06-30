'use client';

/**
 * ExpandableChart — wraps a chart so it can be opened in a large modal for a closer look.
 * Renders the chart inline plus a small "expand" button; clicking opens an accessible
 * dialog (Escape / backdrop / button to close) showing the SAME chart at full width.
 *
 * The chart inside scales to its container via its SVG viewBox, so the modal just gives it
 * more room — no separate "large" variant needed.
 */
import { useEffect, useState } from 'react';
import { Expand, X } from 'lucide-react';

export function ExpandableChart({
  title,
  children,
  modalWidthClassName = 'max-w-5xl',
}: {
  title: string;
  children: React.ReactNode;
  /** Tailwind max-width class for the expanded modal. Wider panels (e.g. multi-chart) can opt into more room. */
  modalWidthClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Expand ${title}`}
        title="Expand"
        className="absolute -top-1 right-0 z-10 inline-flex size-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface hover:text-foreground"
      >
        <Expand className="size-4" aria-hidden="true" />
      </button>

      {children}

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className={`w-full ${modalWidthClassName} rounded-xl border border-border bg-card p-5 shadow-xl`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h3 className="text-base font-semibold tracking-tight text-foreground">{title}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
