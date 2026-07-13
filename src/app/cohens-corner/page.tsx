import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";

import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "Cohen's Corner",
  description:
    "In-season analytics for KeyLehr H2H — weekly breakdowns, trends, and insights from Scott Cohen.",
};

export default function CohensCornerPage() {
  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow="In-Season Analytics"
        title="Cohen's Corner"
        description="Weekly breakdowns, trends, and insights — curated by Scott Cohen."
      />
      <EmptyState
        icon={FlaskConical}
        title="Scott's in the lab"
        description="Analytics content is coming soon. Check back during the season."
      />
    </Container>
  );
}
