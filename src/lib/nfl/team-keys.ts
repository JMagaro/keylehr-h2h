/**
 * The single normalizer from an external provider's team abbreviation to our
 * `nfl_teams.key`.
 *
 * This existed as three separate private copies (DraftKings draftables, Sleeper players,
 * and the live-scoring stat adapters) before being pulled up here. They must not drift:
 * a mismatch silently fails to join a player to their stats or their salary, and shows up
 * as a mysterious zero rather than an error.
 *
 * Our canonical keys follow ESPN's abbreviations, so ESPN input is a pass-through — the
 * fixups below cover the providers that disagree:
 *   - Sleeper and DraftKings both emit "WAS" where we use "WSH".
 *   - DraftKings emits "JAC" where we (and ESPN) use "JAX".
 *   - "LA" is ambiguous in some feeds and resolves to the Rams.
 * The relocations (OAK/SD/STL) are mapped defensively so a stale historical row can't
 * produce an unmatched key.
 */

/** Provider abbreviations that differ from our `nfl_teams.key`. */
const TEAM_KEY_FIX: Record<string, string> = {
  WAS: 'WSH',
  JAC: 'JAX',
  LA: 'LAR',
  OAK: 'LV',
  SD: 'LAC',
  STL: 'LAR',
};

/**
 * Normalize a provider team abbreviation to our `nfl_teams.key`.
 * Unknown abbreviations pass through uppercased rather than throwing — an unrecognized
 * team should degrade to "no match", not crash a live page mid-Sunday.
 */
export function normalizeTeamKey(team: string): string {
  const u = team.trim().toUpperCase();
  return TEAM_KEY_FIX[u] ?? u;
}
