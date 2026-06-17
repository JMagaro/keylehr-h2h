/**
 * Shared state shape for the Schedule pipeline actions.
 *
 * This lives in its own module (NOT the `'use server'` actions file) because a
 * `'use server'` file may only export async functions — exporting the
 * `INITIAL_SCHEDULE_STATE` object or the `ScheduleActionState` type from there is
 * a hard production-build error ("A 'use server' file can only export async
 * functions"). Keeping these here lets both the server actions and the client
 * form component import them safely.
 */

/** Result surfaced back to the user after a pipeline action runs. */
export type ScheduleActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

export const INITIAL_SCHEDULE_STATE: ScheduleActionState = { status: 'idle' };
