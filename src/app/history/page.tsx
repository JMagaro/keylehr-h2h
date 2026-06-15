/**
 * History — Server Component scaffold. No data wired yet. Will show prior champions,
 * payouts, season awards, and all-time records once past seasons are migrated.
 */
import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "History",
  description:
    "KeyLehr H2H league history — past champions, season awards, payouts, and all-time owner records across every season.",
};

export default function HistoryPage() {
  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow="League archive"
        title="History"
        description="Champions, runners-up, season awards, and all-time owner records from every KeyLehr H2H season."
      />
      <EmptyState
        icon={ScrollText}
        title="History is being archived"
        description="Prior seasons are being migrated in — past champions and all-time records will populate here once available."
      />
    </Container>
  );
}
