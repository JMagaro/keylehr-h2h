/**
 * Rules — Server Component. Unlike the other public pages, this renders real static
 * content: a summary of the current season's league rules. Values mirror the league's
 * default rule set (see src/lib/rules/schema.ts) and the product docs. Framed clearly
 * as the CURRENT season's rules; the commissioner can adjust per season.
 */
import type { Metadata } from "next";
import {
  AlertTriangle,
  CalendarOff,
  CircleDollarSign,
  ListChecks,
  type LucideIcon,
  Scale,
  Tag,
  Trophy,
} from "lucide-react";
import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import {
  Card,
  CardBody,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/card";

export const metadata: Metadata = {
  title: "Rules",
  description:
    "KeyLehr H2H league rules — scoring, tiebreakers (head-to-head → Points For → Points Against), missed-lineup penalties, bye-week handling, DraftKings entry-name requirements, the playoff format, and the payout structure.",
};

interface RuleSection {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  items: React.ReactNode[];
}

const SECTIONS: RuleSection[] = [
  {
    id: "format",
    title: "Format & scoring",
    description: "How a week is played and scored.",
    icon: ListChecks,
    items: [
      "32 owners, one season. Each owner is assigned exactly one NFL team and plays that team's real NFL schedule.",
      "Weekly scoring is DFS, not the NFL game. Your weekly score is the fantasy points of your DraftKings lineup — the NFL schedule only decides who you face.",
      "Head-to-head: if your NFL team plays another owner's NFL team that week, you face that owner. Higher DraftKings points wins the matchup.",
      "Records are tracked as W-L-T with Points For and Points Against. The regular season runs 18 weeks.",
    ],
  },
  {
    id: "tiebreakers",
    title: "Standings tiebreakers",
    description: "Applied in order when records are level.",
    icon: Scale,
    items: [
      "1. Head-to-head record between the tied owners.",
      "2. Points For (higher wins).",
      "3. Points Against (higher wins).",
    ],
  },
  {
    id: "missed-lineup",
    title: "Missed lineups",
    description: "Failing to submit a valid DraftKings lineup.",
    icon: AlertTriangle,
    items: [
      "An owner who fails to submit a valid lineup takes an automatic loss for that week.",
      "Their opponent is credited with the league-average score for that week (rather than their own actual points or a forfeit).",
    ],
  },
  {
    id: "bye-week",
    title: "Bye weeks",
    description: "When your NFL team is idle.",
    icon: CalendarOff,
    items: [
      "If your assigned NFL team is on a bye, you have no head-to-head matchup that week.",
      "Bye-week points do not count toward your Points For total.",
      "Bye-week scores are not eligible for the weekly high-score prize.",
    ],
  },
  {
    id: "dk-entry",
    title: "DraftKings entry name",
    description: "How your scores are matched to you.",
    icon: Tag,
    items: [
      "Each owner locks a DraftKings entry name for the season. The weekly contest leaderboard is matched to owners by that exact entry name.",
      "Use your locked entry name consistently every week so your scores import correctly.",
    ],
  },
  {
    id: "playoffs",
    title: "Playoff format",
    description: "NFL-style postseason.",
    icon: Trophy,
    items: [
      "Seven seeds per conference: four division winners plus three wild cards.",
      "The #1 seed in each conference earns a first-round bye.",
      "The bracket reseeds each round (highest remaining seed plays lowest), mirroring the NFL.",
      "Playoff-matchup ties are broken by regular-season Points For.",
    ],
  },
  {
    id: "payouts",
    title: "Payouts",
    description: "Entry fee and prize structure for the season.",
    icon: CircleDollarSign,
    items: [
      "Entry fee: $155 per owner.",
      "Champion: $2,000 · Runner-up: $1,000 · Third: $300 · Fourth: $150.",
      "Most regular-season points: $400.",
      "Weekly high score: $50 each week (18 weeks). Season high score: $50.",
    ],
  },
];

export default function RulesPage() {
  return (
    <Container width="wide" as="div" className="flex flex-col gap-8 py-10">
      <PageHeader
        eyebrow="Season 4 · 2026 rules"
        title="League Rules"
        description="The current season's rules for KeyLehr H2H. The commissioner may adjust settings between seasons; this page reflects the rules in effect for Season 4 (2026)."
      />

      <div className="grid gap-6 md:grid-cols-2">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Card key={section.id} id={section.id}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <CardTitle>{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardBody>
                <ul className="flex flex-col gap-2 text-sm text-muted">
                  {section.items.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-2 size-1.5 shrink-0 rounded-full bg-accent"
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-subtle">
        Rules are configured per season. Figures above reflect the league&apos;s standard
        settings for the current season and are operated by KeyLehr Gaming Ventures.
      </p>
    </Container>
  );
}
