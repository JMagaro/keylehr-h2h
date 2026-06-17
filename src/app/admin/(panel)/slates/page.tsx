/**
 * Admin → Slates — set the DraftKings draft group id per regular-season week so the
 * Lineup Builder can pull player salaries and optimize under the cap.
 *
 * This is an OVERRIDE/fallback: the builder auto-detects DraftKings' main NFL slate for
 * the current week on its own, so the commissioner only needs this to pin a specific slate
 * (e.g. a Showdown) or to backfill a particular week. Season via `?season=<id>`.
 */
import type { Metadata } from 'next';
import { CircleDollarSign } from 'lucide-react';

import { eq } from 'drizzle-orm';

import { Card, CardBody, CardHeader, CardTitle, CardDescription } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SeasonSelector } from '@/components/season-selector';
import { db, seasons as seasonsTable, weeklyContests } from '@/db';
import { requireAdmin } from '@/lib/auth-helpers';
import { getDefaultStandingsSeasonId, getSeasonOptions } from '@/lib/standings/query';

import { DraftGroupForm, type SlateDefault } from './slates-form';

export const metadata: Metadata = { title: 'Slates', robots: { index: false } };
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function AdminSlatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await requireAdmin();

  const sp = await searchParams;
  const seasons = await getSeasonOptions();

  const requested = Array.isArray(sp.season) ? sp.season[0] : sp.season;
  const requestedId = requested ? Number(requested) : NaN;
  const validRequested = !Number.isNaN(requestedId) && seasons.some((s) => s.id === requestedId);
  const defaultId = await getDefaultStandingsSeasonId();
  const selectedId = validRequested ? requestedId : (defaultId ?? seasons[0]?.id);

  if (selectedId === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Slates" description="Set DraftKings draft groups per week." />
        <EmptyState
          icon={CircleDollarSign}
          title="No seasons to show"
          description="Create a season first, then set the weekly DraftKings slates here."
        />
      </div>
    );
  }

  const [season] = await db
    .select({ regularSeasonWeeks: seasonsTable.regularSeasonWeeks })
    .from(seasonsTable)
    .where(eq(seasonsTable.id, selectedId))
    .limit(1);
  const weeks = season?.regularSeasonWeeks ?? 18;

  const rows = await db
    .select({ week: weeklyContests.week, dg: weeklyContests.dkDraftGroupId })
    .from(weeklyContests)
    .where(eq(weeklyContests.seasonId, selectedId));
  const dgByWeek = new Map(rows.map((r) => [r.week, r.dg ?? '']));

  const defaults: SlateDefault[] = Array.from({ length: weeks }, (_, i) => {
    const week = i + 1;
    return { week, draftGroupId: dgByWeek.get(week) ?? '' };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="DraftKings Slates"
        description="Per-week draft group id for the Lineup Builder's salary-cap optimization."
        actions={<SeasonSelector seasons={seasons} selectedId={selectedId} />}
      />

      <Card>
        <CardBody className="flex flex-col gap-2 text-sm text-muted">
          <p>
            The Lineup Builder <strong>auto-detects DraftKings&rsquo; main NFL slate</strong> for the
            current week, so you usually don&rsquo;t need to set anything here. Use this only to{' '}
            <strong>pin a specific slate</strong> (e.g. a Showdown or a Thursday-only slate) or to
            backfill a particular week.
          </p>
          <p className="text-subtle">
            The draft group id is the number in a DraftKings draft URL
            (<code className="rounded bg-surface px-1">…/draft/nfl/&lt;draftGroupId&gt;</code>). You
            can paste the whole URL — we&rsquo;ll extract the id. Leave a week blank to fall back to
            auto-detection.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly draft groups</CardTitle>
          <CardDescription>One per regular-season week. Blank = auto-detect.</CardDescription>
        </CardHeader>
        <CardBody>
          <DraftGroupForm seasonId={selectedId} defaults={defaults} />
        </CardBody>
      </Card>
    </div>
  );
}
