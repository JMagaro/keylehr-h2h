'use client';

/**
 * A single team row in the Assignments table: an owner <Select> + a DraftKings
 * entry-name <Input>, saved together by one form posting to `assignTeam`.
 * `useActionState` surfaces per-row success / error feedback without navigating.
 */
import { useActionState } from 'react';

import { Input, Select } from '@/components/ui/input';
import { SubmitButton } from '@/components/ui/submit-button';
import { TD, TR } from '@/components/data-table';
import { TeamLogo } from '@/components/team-logo';

import { assignTeam, type AssignmentState } from './actions';

export interface OwnerOption {
  id: number;
  name: string;
}

export function AssignmentRow({
  seasonId,
  teamId,
  teamLabel,
  teamName,
  logoEspn,
  owners,
  currentOwnerId,
  currentDkEntryName,
}: {
  seasonId: number;
  teamId: number;
  teamLabel: string;
  teamName: string;
  logoEspn: string | null;
  owners: OwnerOption[];
  currentOwnerId: number | null;
  currentDkEntryName: string | null;
}) {
  const [state, formAction] = useActionState<AssignmentState, FormData>(assignTeam, {});
  const ownerSelectId = `owner-${teamId}`;
  const dkInputId = `dk-${teamId}`;

  return (
    <TR>
      <TD className="font-medium">
        <span className="flex items-center gap-2">
          <TeamLogo src={logoEspn} alt={`${teamName} logo`} size={22} />
          {teamLabel}
        </span>
      </TD>
      <TD colSpan={2} className="whitespace-normal">
        <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="seasonId" value={seasonId} />
          <input type="hidden" name="nflTeamId" value={teamId} />

          <label htmlFor={ownerSelectId} className="sr-only">
            Owner for {teamLabel}
          </label>
          <Select
            id={ownerSelectId}
            name="ownerId"
            defaultValue={currentOwnerId ?? ''}
            className="sm:w-48"
          >
            <option value="">— unassigned —</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>

          <label htmlFor={dkInputId} className="sr-only">
            DraftKings entry name for {teamLabel}
          </label>
          <Input
            id={dkInputId}
            name="dkEntryName"
            defaultValue={currentDkEntryName ?? ''}
            placeholder="DraftKings entry name"
            maxLength={128}
            className="sm:w-56"
          />

          <SubmitButton variant="secondary" size="sm" pendingText="Saving…">
            Save
          </SubmitButton>

          <span className="min-w-0 text-xs" aria-live="polite">
            {state.error ? (
              <span className="text-loss">{state.error}</span>
            ) : state.ok ? (
              <span className="text-win">Saved</span>
            ) : null}
          </span>
        </form>
      </TD>
    </TR>
  );
}
