/**
 * Branded 404 — shown for any unmatched route. Keeps the site chrome (nav/footer
 * come from the root layout) and offers a way back rather than the bare default.
 */
import type { Metadata } from "next";
import { Compass } from "lucide-react";

import { Container } from "@/components/container";
import { EmptyState } from "@/components/empty-state";
import { LinkButton } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-20">
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="That page doesn't exist or may have moved. Try the dashboard, standings, or your team."
        action={
          <LinkButton href="/" variant="primary" size="md">
            Back to Dashboard
          </LinkButton>
        }
      />
    </Container>
  );
}
