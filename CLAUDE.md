@AGENTS.md

# Page feature checklist

Before finishing any editing session on a major page, verify these features are still present. After context compaction, re-read the full file before making any edits.

## /history (src/app/history/page.tsx)

**Champions & seasons**
- [ ] Season cards are fully clickable — wrapped in `<Link href={/history/${season.year}}>` (whole card, not just a text link)
- [ ] Champion badge + Regular-season #1 badge inside each card
- [ ] RecordLine rows: Highest week, Points leader, Best record

**All-time leaders** (two rows of 3 tables each)
- [ ] Row 1: Most wins · Most points · Best single week
- [ ] Row 2: Most championships · Playoff appearances (with separate App + W-L columns) · Most weekly highs
- [ ] `getChampionLeaders()` used for championships (not `leaders.byChampionships()`) — preserves season-accurate names

**Owner trends**
- [ ] Interactive line charts with owner search/highlight
- [ ] No team name or team key references in search or tooltip

**Head-to-head records**
- [ ] Clickable card linking to `/history/head-to-head`

**Records & milestones**
- [ ] Longest winning streak table
- [ ] Longest losing streak table
- [ ] Net earners table (green/red +/- formatting)
- [ ] Missed submissions — The Shame List

**Rivalries**
- [ ] Closest game card (`GameExtremeCard`)
- [ ] Biggest blowout card (`GameExtremeCard`)
- [ ] Most-played rivalry table
- [ ] Most lopsided rivalry table

---

# Session discipline

- **Always read the full file before editing it** — never rely solely on session summary or memory
- **Run `git diff HEAD` before any push** — scan for unexpected deletions
- **Run `npm run verify` before pushing** — validates data integrity
- **Commit after each logical feature** — keeps regressions small and visible
- **Delete iCloud duplicates before typechecking**: `find .next -name "* 2.*" -delete`
