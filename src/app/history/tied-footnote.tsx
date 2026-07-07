"use client";
import { useState, useRef, useEffect } from "react";

export function TiedFootnote({ items }: { items: { name: string; detail: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="group relative w-fit">
      <p
        className="cursor-pointer text-xs text-muted underline decoration-dotted underline-offset-2"
        onClick={() => setOpen((o) => !o)}
      >
        + {items.length} more tied
      </p>
      <div
        className={`absolute bottom-full left-0 z-10 mb-1 min-w-[14rem] rounded-lg border border-border bg-card px-3 py-2 shadow-lg ${
          open ? "block" : "hidden group-hover:block"
        }`}
      >
        {items.map(({ name, detail }) => (
          <div key={name} className="flex items-center justify-between gap-6 whitespace-nowrap py-0.5">
            <span className="text-xs text-foreground">{name}</span>
            <span className="tabular-nums text-xs text-muted">{detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
