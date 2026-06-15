import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { asc, eq } from 'drizzle-orm';

import { db, nflTeams, owners, ownerSeasons } from '@/db';
import { Card, CardBody } from '@/components/card';
import { PageHeader } from '@/components/page-header';
import { LinkButton } from '@/components/ui/button';
import { Table, THead, TBody, TR, TH } from '@/components/data-table';
import { Badge } from '@/components/badge';
import { EmptyState } from '@/components/empty-state';
import { requireAdmin } from '@/lib/auth-helpers';
import { getCurrentSeason } from '@/lib/season';

import { AssignmentRow, type OwnerOption } from './assignment-row';

export const metadata: Metadata = { title: 'Team assignments', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Canonical NFL grouping order: conferences, then divisions within each. */
const CONFERENCES = ['AFC', 'NFC'] as const;
const DIVISIONS = ['East', 'North', 'South', 'West'] as const;

export default async function AssignmentsPage() {
  await requireAdmin();
  const season = await getCurrentSeason();

  if (!season) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader eyebrow="Admin" title="Team assignments" />
        <EmptyState
          icon={Users}
          title="No season found"
          description="Seed a season before assigning teams."
        />
      </div>
    );
  }

  // All owners (alphabetical) and all teams, plus this season's current assignments.
  const [allOwners, teams, assignments] = await Promise.all([
    db
      .select({ id: owners.id, name: owners.name })
      .from(owners)
      .orderBy(asc(owners.name)),
    db
      .select({
        id: nflTeams.id,
        location: nflTeams.location,
        name: nflTeams.name,
        conference: nflTeams.conference,
        division: nflTeams.division,
        logoEspn: nflTeams.logoEspn,
      })
      .from(nflTeams),
    db
      .select({
        nflTeamId: ownerSeasons.nflTeamId,
        ownerId: ownerSeasons.ownerId,
        dkEntryName: ownerSeasons.dkEntryName,
      })
      .from(ownerSeasons)
      .where(eq(ownerSeasons.seasonId, season.id)),
  ]);

  // No owners at all → can't assign anything yet.
  if (allOwners.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          eyebrow={season.name}
          title="Team assignments"
          description="Assign each NFL team to a league owner for the season."
        />
        <EmptyState
          icon={Users}
          title="No owners yet"
          description="Add the league owners first, then come back to assign each one an NFL team."
          action={<LinkButton href="/admin/owners">Manage owners</LinkButton>}
        />
      </div>
    );
  }

  const ownerOptions: OwnerOption[] = allOwners;

  // team id -> assignment, and the set of assigned owner ids for the summary.
  const byTeam = new Map<number, { ownerId: number; dkEntryName: string | null }>();
  const assignedOwnerIds = new Set<number>();
  for (const a of assignments) {
    byTeam.set(a.nflTeamId, { ownerId: a.ownerId, dkEntryName: a.dkEntryName });
    assignedOwnerIds.add(a.ownerId);
  }

  const assignedTeamCount = byTeam.size;
  const unassignedOwners = allOwners.filter((o) => !assignedOwnerIds.has(o.id));

  // Group teams into the canonical conference → division order.
  type TeamRow = (typeof teams)[number];
  const groups = CONFERENCES.flatMap((conference) =>
    DIVISIONS.map((division) => ({
      conference,
      division,
      teams: teams
        .filter((t) => t.conference === conference && t.division === division)
        .sort((a, b) => `${a.location} ${a.name}`.localeCompare(`${b.location} ${b.name}`)) as TeamRow[],
    })),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={season.name}
        title="Team assignments"
        description="Assign each NFL team to a league owner and set their DraftKings entry name for the season."
      />

      <Card>
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-foreground">
              {assignedTeamCount} / 32 teams assigned
            </p>
            {unassignedOwners.length > 0 ? (
              <p className="text-sm text-muted">
                Not yet assigned:{' '}
                {unassignedOwners.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 ? ', ' : ''}
                    <span className="text-foreground">{o.name}</span>
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-sm text-muted">Every owner has a team. </p>
            )}
          </div>
          <LinkButton href="/admin/schedule" variant="secondary" size="sm">
            Regenerate matchups →
          </LinkButton>
        </CardBody>
      </Card>

      <p className="text-xs text-subtle">
        Changing an owner moves them off any team they previously held this season, and frees the
        team of its previous owner. After editing assignments, regenerate owner matchups from the{' '}
        <span className="font-medium text-muted">Schedule</span> page so the head-to-head schedule
        reflects the new rosters.
      </p>

      {groups.map((group) => (
        <section key={`${group.conference}-${group.division}`} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-foreground">
              {group.conference} {group.division}
            </h2>
            <Badge variant="div">{group.teams.length} teams</Badge>
          </div>
          <Table>
            <THead>
              <TR>
                <TH>Team</TH>
                <TH colSpan={2}>Owner &amp; DraftKings entry</TH>
              </TR>
            </THead>
            <TBody>
              {group.teams.map((team) => {
                const current = byTeam.get(team.id) ?? null;
                return (
                  <AssignmentRow
                    key={team.id}
                    seasonId={season.id}
                    teamId={team.id}
                    teamLabel={`${team.location} ${team.name}`}
                    teamName={team.name}
                    logoEspn={team.logoEspn}
                    owners={ownerOptions}
                    currentOwnerId={current?.ownerId ?? null}
                    currentDkEntryName={current?.dkEntryName ?? null}
                  />
                );
              })}
            </TBody>
          </Table>
        </section>
      ))}
    </div>
  );
}
