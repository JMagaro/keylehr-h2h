"use client";

/**
 * Route-level error boundary — replaces Next's bare default when a page throws at
 * runtime. Client component (required for error boundaries); `reset` retries the
 * failed render. Nav/footer still come from the root layout.
 */
import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { Container } from "@/components/container";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-20">
      <EmptyState
        icon={TriangleAlert}
        title="Something went wrong"
        description="We hit a snag loading this page. Try again in a moment — if it keeps happening, let the commissioner know."
        action={
          <Button onClick={reset} variant="primary" size="md">
            Try again
          </Button>
        }
      />
    </Container>
  );
}
