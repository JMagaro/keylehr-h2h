# League rules (`seasons.rules`)

Every structural league rule is **per season**, stored as JSONB in `seasons.rules`, validated by
`seasonRulesSchema` in [`src/lib/rules/schema.ts`](../src/lib/rules/schema.ts). That file is the
source of truth for the shape and the defaults; this document explains what each key *means*,
which module reads it, and which UI edits it.

Two things to internalize before changing anything here:

- **`rules = NULL` is normal and is not "unconfigured".** `getSeasonRules(stored)` fills every
  missing key from `DEFAULT_SEASON_RULES`, so a season with no JSONB behaves exactly like the
  defaults. The 2023–2025 seasons carry **no `rules` row at all** — they run entirely on the
  schema defaults. That makes the defaults load-bearing for validated history: changing a default
  in `schema.ts` silently rewrites three frozen seasons. `npm run verify` fails if that happens.
- **Two keys are ignored mirrors.** See [§6](#6-the-two-ignored-mirrors).

## 1. Where rules come from and where they go

```text
Admin → Settings                      seasons.rules (JSONB, nullable)
  ├─ "Season" card    ──────────────▶ seasons.regularSeasonWeeks / entryFeeCents  (COLUMNS)
  └─ "Rules" card     ──────────────▶ seasons.rules                               (JSONB)
                                              │
                                              │  getSeasonRules() — parse + fill defaults
                                              ▼
                        getSeasonStandingsData() → rankingOptions + playoffConfig
                        assembleMatchupResults() → missedLineup handling
                        computeSeasonAwards()    → payouts
                        /rules, /playoffs        → published copy
```

`Admin → Settings` also has an **"Apply 2025 & earlier rules"** preset button
(`applyDefaultRulesAction`) that writes `DEFAULT_SEASON_RULES` to a season, preserving the
canonical `regularSeasonWeeks` / `entryFeeCents` mirrors.

## 2. Format

| Key | Type / valid values | Default | Read by | Edited in |
| --- | ------------------- | ------- | ------- | --------- |
| `regularSeasonWeeks` | integer `1..25` | `18` | **Nothing, as an authority** — every consumer reads the `seasons.regularSeasonWeeks` column and only falls back to this mirror if the column is null. See [§6](#6-the-two-ignored-mirrors). | Not editable in the Rules form; Admin → Settings edits the **column** on the Season card. |
| `tiebreakers` | array of `h2h` \| `pf` \| `pa` | `['h2h','pf','pa']` | `standings/query.ts` → `rankingOptions.tiebreakers` → `rankCohort` / `rankStandings` / all seeding | Admin → Settings, three ordered selects. Rendered on `/rules`. |

`tiebreakers` sets the order applied **within** a cohort of owners tied on win percentage. The
win-percentage grouping itself is not configurable — it is the league rule. `pa` is effectively
inert (an exact Points-For tie does not happen with real decimal scores). See
[`SCORING.md` §10](SCORING.md#10-tiebreakers).

## 3. Playoffs (`playoffs.*`)

| Key | Type / valid values | Default | Read by | Edited in |
| --- | ------------------- | ------- | ------- | --------- |
| `playoffs.teamsPerConference` | integer `1..16` | `7` | `seeding.ts` (field size), `playoffs.ts` (first-round pairings), `playoffs/service.ts` | Admin → Settings; shown on `/rules` and `/playoffs` |
| `playoffs.divisionWinnersPerConference` | integer `0..8` | `4` | `seeding.ts` — how many division leaders seed *as* winners; surplus leaders drop into the wild-card pool | Admin → Settings; shown on `/rules` and `/playoffs` |
| `playoffs.wildCardsPerConference` | integer `0..12` | `3` | `seeding.ts` — wild-card slots, capped by `teamsPerConference` | Admin → Settings; shown on `/rules` and `/playoffs` |
| `playoffs.topSeedByes` | integer `0..4` | `1` | `seeding.ts` (`isBye` on a seed), `playoffs.ts` (who sits out round 1) | Admin → Settings; shown on `/rules` and `/playoffs` |
| `playoffs.tieBreaker` | `regular_season_pf` \| `higher_seed` | `regular_season_pf` | `playoffs/service.ts` `loadTieRule` → `resolveGameWinner` | Admin → Settings; shown on `/rules` |

**`playoffs.tieBreaker` options** (documented nowhere before):

- `regular_season_pf` — an exactly tied postseason matchup goes to the owner with more
  **regular-season Points For**. The league rule.
- `higher_seed` — the better seed advances.

The bracket reseeds each round (best remaining seed plays worst remaining seed), mirroring the
NFL. That is structural, not a rule key.

## 4. Bye weeks (`byeWeek.*`)

| Key | Type | Default | Read by | Edited in |
| --- | ---- | ------- | ------- | --------- |
| `byeWeek.countsTowardPointsFor` | boolean | `false` | `standings/query.ts` → `rankingOptions.byePointsFor` → `computeStandings` | Admin → Settings checkbox; stated on `/rules` |
| `byeWeek.eligibleForWeeklyHigh` | boolean | `false` | `getHighestWeeklyScore` (dashboard tile) and `computeSeasonAwards` (the real $50 prize) | Admin → Settings checkbox; stated on `/rules` |

Both are **off** for this league, which is why a bye-week score is invisible in the standings and
cannot win the weekly-high prize. `countsTowardPointsFor` only ever adds to Points For — a bye
produces no matchup, so it can never affect W-L-T or win%. `assembleMatchupResults` accumulates
the per-owner bye total regardless; `query.ts` only passes it to the engine when the rule is on.

## 5. Missed lineups (`missedLineup.*`)

| Key | Valid values | Default | Read by | Edited in |
| --- | ------------ | ------- | ------- | --------- |
| `missedLineup.result` | `auto_loss` \| `none` | `auto_loss` | `assembleMatchupResults` — sets `MatchupResult.forfeitBy` only when `auto_loss` | Admin → Settings; conditionally rendered on `/rules` |
| `missedLineup.opponentScores` | `league_average` \| `league_median` \| `zero` \| `actual` | `league_average` | `assembleMatchupResults` — sets `MatchupResult.opponentFacesPoints` | Admin → Settings; rendered as prose on `/rules` |

**`missedLineup.result`:**

- `auto_loss` — the owner who missed takes an automatic loss regardless of points.
- `none` — no special handling; the matchup resolves on points like any other.

**`missedLineup.opponentScores`** — what the *non-forfeiting opponent* plays against, for both
their W/L and their Points Against:

- `league_average` — that week's **mean** score among owners with an active matchup, excluding
  forfeits and byes.
- `league_median` — that week's **median** of the same population.
- `zero` — the opponent faces 0 (an automatic win).
- `actual` — no special handling; the forfeiter's own raw points stand. This short-circuits
  before `forfeitBy` is set, so it also suppresses the auto-loss.

Because the opponent can *lose* to the benchmark, a single missed lineup can produce a **double
loss**. That is the league's rule — see [`SCORING.md` §9](SCORING.md#9-standings).

### The rule genuinely differs by season — do not "fix" it

> **2023–2025 were played and scored on `league_average`. 2026 onward uses `league_median`.**

This is a real rule change the league made, not an inconsistency to clean up. 2023–2025 were
validated 32/32 against the commissioner's own spreadsheets under the average, and are frozen.
"Consistency-fixing" history to the median would rewrite three validated seasons, and it is a
realistic thing for a well-meaning future contributor to do — which is exactly why:

- `scripts/snapshot-standings.ts` captures `missedLineup.opponentScores` per season in the
  committed baseline, and
- `npm run verify`'s **engine no-op proofs** check explicitly assert that every frozen season
  still resolves to `league_average`. The gate fails, loudly and by year, if anyone changes it.

Remember that 2023–2025 have `rules = NULL`, so they inherit the **schema default**. Changing
`opponentScores`'s default in `schema.ts` is therefore equivalent to editing history.

### Not modelled: the fine ladder

`/rules` publishes a **$25 / $50 missed-lineup fine ladder** (first incident $25; second
incident an additional $25, a remainder-of-season suspension, and possible ban). That copy is
**hardcoded in `src/app/rules/page.tsx`** and marked as such in the source. It has:

- no key in `seasonRulesSchema`,
- no ledger — fines are not recorded in `season_awards` or anywhere else, and
- no enforcement — the second-offense suspension is not implemented. A commissioner who wants to
  enforce it sets `scores.isForfeit = true` manually for the remaining weeks, which the read path
  always honors as an override ([`SCORING.md` §3](SCORING.md#3-the-derivation-principle)).

The auto-loss bullet inside that block *is* conditional on `missedLineup.result`; only the dollar
amounts and the suspension text are static.

## 6. The two ignored mirrors

`seasons` carries two values in **both** a column and the rules JSONB. The column is canonical:

| Value | Canonical | Mirror | Why they drift |
| ----- | --------- | ------ | -------------- |
| Regular-season weeks | `seasons.regularSeasonWeeks` | `rules.regularSeasonWeeks` | The Settings "Season" card writes the column; `updateSeasonRules` deliberately **preserves** the JSONB value rather than exposing a second, divergent editor. Nothing ever syncs column → mirror. |
| Entry fee | `seasons.entryFeeCents` | `rules.payouts.entryFeeCents` | Same: the Season card writes the column, `updateSeasonRules` preserves the mirror. |

Every consumer reads the column and treats the mirror only as a null-fallback:
`standings/query.ts`, `awards/service.ts`, `history.ts`, `/rules`. If you add a consumer, follow
that pattern — `seasonRow.regularSeasonWeeks ?? rules.regularSeasonWeeks`.

`history.ts` used to read the mirror exclusively, which meant changing the season length to 17
would have left `/rules`, `/standings` and the odds engine honoring it while `/history` kept
scoring week 18 into "highest week", "most weekly highs" and every owner's expected wins.

> **Known trap:** the read-only "Effective rules" summary at the bottom of Admin → Settings shows
> `rules.regularSeasonWeeks` (the mirror) while the Season card above it edits the column. If the
> two ever diverge, that panel will show the stale number. The entry-fee row on the same panel
> correctly reads the column.

## 7. Payouts (`payouts.*`)

All amounts are **whole USD cents** (non-negative integers). Render with `formatMoney` from
`src/lib/utils.ts`.

| Key | Default | Meaning | Read by | Edited in |
| --- | ------- | ------- | ------- | --------- |
| `payouts.entryFeeCents` | `15500` ($155) | Per-owner entry fee. **Ignored mirror** — see [§6](#6-the-two-ignored-mirrors). | `/rules` and `history.ts` net-earnings, both as a fallback behind `seasons.entryFeeCents` | Admin → Settings **Season** card (as the column) |
| `payouts.weeklyHighCents` | `5000` ($50) | Prize for the top score in a single regular-season week. | `computeSeasonAwards` → `weekly_high` rows | Admin → Settings Rules card |
| `payouts.weeklyHighWeeks` | `18` | How many weeks carry a weekly-high prize. | `computeSeasonAwards`; the effective cap is `min(weeklyHighWeeks, regularSeasonWeeks)` | Admin → Settings Rules card |
| `payouts.seasonHighCents` | `5000` ($50) | Prize for the best single-week score of the season. Stacks with that week's weekly high. | `computeSeasonAwards` → `season_high` | Admin → Settings Rules card |
| `payouts.mostRegularSeasonPointsCents` | `40000` ($400) | Prize for the most regular-season Points For. | `computeSeasonAwards` → `most_points`, sourced from `computeStandings`' `pointsFor` so it matches `/standings` | Admin → Settings Rules card |
| `payouts.championCents` | `200000` ($2,000) | Playoff champion. | `computeSeasonAwards` → `champion` | Admin → Settings Rules card |
| `payouts.runnerUpCents` | `100000` ($1,000) | Loser of the championship game. | `computeSeasonAwards` → `runner_up` | Admin → Settings Rules card |
| `payouts.thirdCents` | `30000` ($300) | Third place. | `computeSeasonAwards` → `third` | Admin → Settings Rules card |
| `payouts.fourthCents` | `15000` ($150) | Fourth place. | `computeSeasonAwards` → `fourth` | Admin → Settings Rules card |

`/rules` computes the published prize pool as
`champion + runnerUp + third + fourth + mostRegularSeasonPoints + seasonHigh + (weeklyHigh × weeklyHighWeeks)`.

Payout behavior worth knowing:

- **Exact ties split the pot evenly**, one `season_awards` row per tied owner, with the cent
  remainder distributed lowest-`ownerSeasonId`-first so the rows sum to exactly the prize
  (`splitCents` in `src/lib/awards/compute.ts`).
- **Third and fourth are not derivable** — the bracket has no consolation game. They are emitted
  only when `import:awards --third=<ownerSeasonId>` names which conference-round loser placed
  third.
- Missed lineups, bye weeks (unless `byeWeek.eligibleForWeeklyHigh`), preseason exhibition
  scores, playoff weeks, and zero-point owners are all excluded from the high-score prizes.
- **2023–2025 are refused** by `recomputeSeasonAwards` without an explicit force flag.

If `weeklyHighWeeks` and `seasons.regularSeasonWeeks` ever diverge, the **stricter** of the two
wins for the weekly-high cap. Which of them *should* be authoritative is an open league question.

## 8. `/rules` renders the current season only

`src/app/rules/page.tsx` resolves its season with `getCurrentSeason()` — the active season, else
the soonest upcoming, else a completed one — and has **no season selector**. So the page always
states the rule for one season, and readers cannot use it to look up what 2024 was scored under.
Given the missed-lineup rule now genuinely differs by era, that is a real limitation worth
knowing about; the per-season truth is in the DB and in
`scripts/fixtures/standings-baseline.json`.

Narrative sections on that page (format & scoring, DraftKings entry-name requirements,
commissioner authority, the tiebreaker worked examples, the Venmo handles) describe league
structure the schema does not model and are intentionally static.

## 9. Adding a rule key

1. Add it to `seasonRulesSchema` **with a default** — `getSeasonRules` must never throw on a
   season that predates the key.
2. Decide whether it belongs in the JSONB at all, or as a `seasons` column. Anything the scoring
   engine reads on a hot path, or that a human edits outside the Rules form, belongs in a column
   — otherwise you have created a third mirror.
3. Thread it through `getSeasonStandingsData` (which returns `rankingOptions` + `playoffConfig`)
   rather than reading `seasons.rules` in a new place.
4. Add the input to `settings-forms.tsx` **and** the field to `updateSeasonRules` in
   `settings/actions.ts` — that action rebuilds the whole object, so an unhandled key silently
   reverts to its current value on every save.
5. Render it on `/rules` if owners are meant to know it.
6. Run `npm run verify`. If the frozen-season snapshot moves, your default changed history.
