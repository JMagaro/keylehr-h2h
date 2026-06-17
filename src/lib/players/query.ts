/**
 * Player-signals orchestration — the DB/network layer that feeds the My Team spotlight
 * strip and the lineup-builder wizard. Joins free external player signals (Sleeper +
 * ESPN news) to this season's NFL schedule (who plays whom / who is on bye) and runs the
 * pure recommender. Everything here is server-only.
 *
 * Honesty: these are availability / news / consensus signals, NOT point projections or
 * DraftKings salaries (free sources don't provide those). The UI states this plainly.
 *
 * Server-only: imports `@/db` (Neon/Node runtime) — never import into a 'use client' module.
 */
import { and, desc, eq } from 'drizzle-orm';

import { db, nflGames, nflTeams, seasons } from '@/db';
import {
  getSleeperPlayers,
  getSleeperTrending,
  type FantasyPosition,
  type SleeperPlayer,
} from './sleeper';
import { getLeagueNews, type NewsHeadline } from './espn-news';
import {
  isInactiveTag,
  recommend,
  RISK_META,
  type Reason,
  type Recommendation,
  type RiskLevel,
  type WeekMatchup,
} from './recommend';

/* -------------------------------------------------------------------------- */
/* Season / week selection                                                    */
/* -------------------------------------------------------------------------- */

export interface BuilderSeason {
  id: number;
  year: number;
  name: string;
  status: 'upcoming' | 'active' | 'completed';
  currentWeek: number;
  regularSeasonWeeks: number;
}

/**
 * The season the builder should default to — the one you'd actually be setting lineups
 * for: an `active` season first, else the next `upcoming` one, else the most recent.
 */
export async function getBuilderSeasons(): Promise<BuilderSeason[]> {
  const rows = await db
    .select({
      id: seasons.id,
      year: seasons.year,
      name: seasons.name,
      status: seasons.status,
      currentWeek: seasons.currentWeek,
      regularSeasonWeeks: seasons.regularSeasonWeeks,
    })
    .from(seasons)
    .orderBy(desc(seasons.year));
  return rows;
}

export function pickDefaultBuilderSeason(list: BuilderSeason[]): BuilderSeason | null {
  return (
    list.find((s) => s.status === 'active') ??
    list.find((s) => s.status === 'upcoming') ??
    list[0] ??
    null
  );
}

/* -------------------------------------------------------------------------- */
/* Schedule → week matchup map                                                */
/* -------------------------------------------------------------------------- */

interface TeamMeta {
  key: string;
  location: string;
  name: string;
  logo: string | null;
}

async function getTeamMeta(): Promise<Map<number, TeamMeta>> {
  const rows = await db
    .select({
      id: nflTeams.id,
      key: nflTeams.key,
      location: nflTeams.location,
      name: nflTeams.name,
      logo: nflTeams.logoEspn,
    })
    .from(nflTeams);
  return new Map(rows.map((r) => [r.id, { key: r.key, location: r.location, name: r.name, logo: r.logo }]));
}

/**
 * Build the per-team matchup map for a season+week from the synced NFL schedule, plus
 * the set of teams on bye. Team key → opponent key (+ home/away). A team absent from the
 * map is on bye that week.
 */
async function getWeekMatchups(
  seasonId: number,
  week: number,
  teamMeta: Map<number, TeamMeta>,
): Promise<{ matchups: Map<string, WeekMatchup>; byeKeys: string[] }> {
  const games = await db
    .select({ home: nflGames.homeTeamId, away: nflGames.awayTeamId })
    .from(nflGames)
    .where(and(eq(nflGames.seasonId, seasonId), eq(nflGames.week, week)));

  const matchups = new Map<string, WeekMatchup>();
  for (const g of games) {
    const home = teamMeta.get(g.home);
    const away = teamMeta.get(g.away);
    if (!home || !away) continue;
    matchups.set(home.key, { opponentKey: away.key, isHome: true });
    matchups.set(away.key, { opponentKey: home.key, isHome: false });
  }

  const byeKeys: string[] = [];
  for (const t of teamMeta.values()) {
    if (!matchups.has(t.key)) byeKeys.push(t.key);
  }
  byeKeys.sort();
  return { matchups, byeKeys };
}

/* -------------------------------------------------------------------------- */
/* Serializable view models (passed to client/presentational components)      */
/* -------------------------------------------------------------------------- */

export interface PlayerCardData {
  id: string;
  name: string;
  position: FantasyPosition;
  teamKey: string;
  teamLogo: string | null;
  injuryStatus: string | null;
  posRank: number;
  fit: number;
  reasons: Reason[];
  opponentKey: string | null;
  isHome: boolean;
  addCount: number;
  dropCount: number;
}

function toCard(rec: Recommendation, teamLogoByKey: Map<string, string | null>): PlayerCardData {
  return {
    id: rec.player.id,
    name: rec.player.name,
    position: rec.player.position,
    teamKey: rec.player.teamKey,
    teamLogo: teamLogoByKey.get(rec.player.teamKey) ?? null,
    injuryStatus: rec.player.injuryStatus,
    posRank: rec.posRank,
    fit: rec.fit,
    reasons: rec.reasons,
    opponentKey: rec.opponentKey,
    isHome: rec.isHome,
    addCount: rec.addCount,
    dropCount: rec.dropCount,
  };
}

function teamLogoMap(teamMeta: Map<number, TeamMeta>): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const t of teamMeta.values()) m.set(t.key, t.logo);
  return m;
}

/* -------------------------------------------------------------------------- */
/* Builder data                                                               */
/* -------------------------------------------------------------------------- */

export interface BuilderResult {
  season: BuilderSeason;
  week: number;
  risk: RiskLevel;
  riskMeta: (typeof RISK_META)[RiskLevel];
  /** Number of NFL games this week (0 ⇒ schedule not loaded for this week). */
  gameCount: number;
  byeTeams: string[];
  signalsAvailable: boolean;
  lineup: { slot: string; pick: PlayerCardData | null }[];
  targetsByPosition: { position: FantasyPosition; label: string; players: PlayerCardData[] }[];
  fades: PlayerCardData[];
}

const POSITION_LABELS: Record<FantasyPosition, string> = {
  QB: 'Quarterbacks',
  RB: 'Running backs',
  WR: 'Wide receivers',
  TE: 'Tight ends',
  K: 'Kickers',
  DST: 'Defenses',
};

const BUILDER_POSITIONS: FantasyPosition[] = ['QB', 'RB', 'WR', 'TE', 'DST'];

export async function getBuilderData(
  season: BuilderSeason,
  week: number,
  risk: RiskLevel,
): Promise<BuilderResult> {
  const teamMeta = await getTeamMeta();
  const [{ matchups, byeKeys }, players, trendingAdd, trendingDrop] = await Promise.all([
    getWeekMatchups(season.id, week, teamMeta),
    getSleeperPlayers(),
    getSleeperTrending('add'),
    getSleeperTrending('drop'),
  ]);

  const signalsAvailable = players.length > 0;
  const logoByKey = teamLogoMap(teamMeta);

  const result = recommend(players, { matchups, trendingAdd, trendingDrop }, risk);

  const lineup = result.suggestedLineup.map((s) => ({
    slot: s.slot,
    pick: s.pick ? toCard(s.pick, logoByKey) : null,
  }));

  const targetsByPosition = BUILDER_POSITIONS.map((position) => ({
    position,
    label: POSITION_LABELS[position],
    players: result.targetsByPosition[position].map((r) => toCard(r, logoByKey)),
  })).filter((g) => g.players.length > 0);

  const fades = result.fades.map((r) => toCard(r, logoByKey));

  return {
    season,
    week,
    risk,
    riskMeta: RISK_META[risk],
    gameCount: matchups.size / 2,
    byeTeams: byeKeys,
    signalsAvailable,
    lineup,
    targetsByPosition,
    fades,
  };
}

/* -------------------------------------------------------------------------- */
/* My Team spotlight strip                                                    */
/* -------------------------------------------------------------------------- */

export interface SpotlightData {
  signalsAvailable: boolean;
  /** Healthy, relevant players with the strongest waiver buzz. */
  spotlight: PlayerCardData[];
  /** Relevant players to be wary of (injured-out or being dropped). */
  fadeRisks: PlayerCardData[];
  news: NewsHeadline[];
}

/**
 * The "around the league" strip for My Team: who's heating up (waiver adds), who to be
 * wary of (injuries / drops), and a few ESPN headlines. Season-independent player signals
 * (these reflect *now*, not a past completed season).
 */
export async function getSpotlightData(): Promise<SpotlightData> {
  const teamMeta = await getTeamMeta();
  const logoByKey = teamLogoMap(teamMeta);
  const [players, trendingAdd, trendingDrop, news] = await Promise.all([
    getSleeperPlayers(),
    getSleeperTrending('add', { limit: 40 }),
    getSleeperTrending('drop', { limit: 40 }),
    getLeagueNews(6),
  ]);

  const signalsAvailable = players.length > 0;
  const byId = new Map(players.map((p) => [p.id, p]));

  // Positional ranks for nice "WR8" labels.
  const posRanks = positionalRanks(players);

  const spotlight: PlayerCardData[] = [...trendingAdd.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ p: byId.get(id), count }))
    .filter((x): x is { p: SleeperPlayer; count: number } => !!x.p && !isInactiveTag(x.p.injuryStatus))
    .slice(0, 6)
    .map(({ p, count }) =>
      spotlightCard(p, posRanks.get(p.id) ?? 999, logoByKey, {
        addCount: count,
        dropCount: trendingDrop.get(p.id) ?? 0,
      }),
    );

  // Fade risks: relevant players who are injured-out OR being dropped heavily.
  const fadeRisks: PlayerCardData[] = players
    .map((p) => ({ p, posRank: posRanks.get(p.id) ?? 999, drop: trendingDrop.get(p.id) ?? 0 }))
    .filter(({ p, posRank, drop }) => posRank <= 36 && (isInactiveTag(p.injuryStatus) || drop >= 5000))
    .sort((a, b) => b.drop - a.drop || a.posRank - b.posRank)
    .slice(0, 6)
    .map(({ p, posRank, drop }) =>
      spotlightCard(p, posRank, logoByKey, { addCount: trendingAdd.get(p.id) ?? 0, dropCount: drop }),
    );

  return { signalsAvailable, spotlight, fadeRisks, news };
}

function positionalRanks(players: SleeperPlayer[]): Map<string, number> {
  const byPos = new Map<FantasyPosition, SleeperPlayer[]>();
  for (const p of players) {
    const arr = byPos.get(p.position) ?? [];
    arr.push(p);
    byPos.set(p.position, arr);
  }
  const ranks = new Map<string, number>();
  for (const arr of byPos.values()) {
    arr.sort((a, b) => a.searchRank - b.searchRank);
    arr.forEach((p, i) => ranks.set(p.id, i + 1));
  }
  return ranks;
}

function spotlightCard(
  p: SleeperPlayer,
  posRank: number,
  logoByKey: Map<string, string | null>,
  counts: { addCount: number; dropCount: number },
): PlayerCardData {
  const reasons: Reason[] = [{ label: `${p.position}${posRank}`, tone: posRank <= 12 ? 'good' : 'neutral' }];
  if (isInactiveTag(p.injuryStatus)) {
    reasons.push({
      label: p.injuryNote ? `${p.injuryStatus} · ${p.injuryNote}` : (p.injuryStatus ?? 'Out'),
      tone: 'bad',
    });
  } else if (p.injuryStatus) {
    reasons.push({ label: p.injuryStatus, tone: 'warn' });
  }
  if (counts.addCount >= 3000) reasons.push({ label: 'Trending ↑', tone: 'good' });
  if (counts.dropCount >= 3000) reasons.push({ label: 'Trending ↓', tone: 'bad' });
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    teamKey: p.teamKey,
    teamLogo: logoByKey.get(p.teamKey) ?? null,
    injuryStatus: p.injuryStatus,
    posRank,
    fit: 0,
    reasons,
    opponentKey: null,
    isHome: false,
    addCount: counts.addCount,
    dropCount: counts.dropCount,
  };
}

// Re-export for the page layer.
export { RISK_LEVELS } from './recommend';
export type { RiskLevel } from './recommend';
