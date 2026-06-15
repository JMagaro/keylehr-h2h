/**
 * My Team — Server Component scaffold. No data / per-owner auth wired yet. Will show
 * the signed-in owner's assigned NFL team, schedule, weekly DK scores, and record.
 */
import type { Metadata } from "next";
import { UserRound } from "lucide-react";
import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = {
  title: "My Team",
  description:
    "Your KeyLehr H2H team — your assigned NFL team, head-to-head schedule, weekly DraftKings lineup scores, and season record.",
};

export default function MyTeamPage() {
  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow="Season 4 · 2026"
        title="My Team"
        description="Your assigned NFL team, weekly head-to-head matchups, your DraftKings lineup scores, and your season record — all in one place."
      />
      <EmptyState
        icon={UserRound}
        title="Your team page is on the way"
        description="Season starts soon — once team assignments and per-owner access are live, your matchups and weekly scores will populate here."
      />
    </Container>
  );
}
