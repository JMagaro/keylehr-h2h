# KeyLehr H2H — DraftKings Sync (Chrome extension)

**Current version: 1.3.0** (`manifest.json`). 1.3.0 is **one button**: **Sync** now posts the week's
scores *and* captures every owner's roster from a single DraftKings read — the separate "Capture
lineups" button is gone. See [Lineups](#lineups-captured-automatically-by-sync). 1.2.0 added roster
capture; 1.1.0 added the endpoint probe, now relabelled
[Troubleshooting](#troubleshooting--draftkings-endpoints). The POST contracts are unchanged and
**no new permissions** were added.

> **Why one button.** Both halves come from the same leaderboard read — `captureRosters` has to
> fetch it anyway to get entry keys — and there is no case where you want one without the other.
> **Scores go first and lineups are best-effort:** scores are the official number that settles a
> week, lineups only feed an estimate, so a roster failure must never block a score sync or cast
> doubt on one that succeeded. Lineups report into their own card, and if roster capture fails
> outright the flow falls back to the plain leaderboard read — the path that existed before
> lineups did.

A Manifest V3 Chrome extension that reads the shared **private** DraftKings contest
leaderboard from the commissioner's **already-logged-in** DraftKings session and posts it to
the KeyLehr H2H app's ingest endpoint (`POST /api/ingest/draftkings`). The app then matches
each entry to a league owner and writes that week's scores. The same session also backs roster
capture, which posts to `POST /api/ingest/lineups` and **never writes a score**.

> **Why an extension and not a server pull?** The weekly scoring contest is private. A server
> can't read a private DK leaderboard without the user's authenticated session, and DK's API is
> undocumented, against ToS, and bot-protected. Running in the commissioner's own browser tab
> sidesteps all of that — the extension issues the leaderboard request **from the open DK
> contest tab**, so the browser's DK session cookies are sent. This is best-effort; the
> **paste** path is the guaranteed fallback.

---

## The DraftKings data path this targets

- **Contest gamecenter / standings page (what you open in the browser):**
  `https://www.draftkings.com/contest/gamecenter/{contestId}`
  (alternate form: `/draft/contest/{contestId}`). The extension reads `{contestId}` straight
  from this tab URL — **each week is a different contest id.** Open the contest's
  **Standings / Leaderboard** tab and make sure you're logged in.

- **The leaderboard endpoint the extension fetches (the important part):**

  ```
  https://api.draftkings.com/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard
  ```

  The **`&embed=leaderboard`** query param is **essential**. Without it, DK returns only the
  single top `leader` entry — that was the original "captured 1 of 32" bug. Do **not** use the
  no-`embed` `scores/v1/...` path for the leaderboard.

- **The roster endpoint (used by the lineup half of Sync):**

  ```
  https://api.draftkings.com/scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster
  ```

  The first path segment is the **draft group** id, not the contest id — that distinction is why
  every contest-id-based guess failed. There is **no bulk equivalent**: the plausible
  `…/leaderboards/{contestId}?embed=leaderboard,roster` answers `200` with an empty entry map
  (`entryByEntryKey: {}`), confirmed again on a live contest. See
  [Lineups](#lineups-captured-automatically-by-sync).

- **Why the fetch runs in the DK page (not the popup):** this endpoint requires the user's
  authenticated DK session. The extension injects `page-hook.js` into the DK page's **MAIN
  world** and issues `fetch(url, { credentials: 'include' })` there, so the browser's
  draftkings.com cookies are attached. A fetch from the popup/background would not carry the
  session reliably.

- **Robust entry extraction:** DK's envelope nests the entries differently across
  endpoints/versions — under `leaderBoard` (an array) or
  `leaderBoardUserEntries.entryByEntryKey` (an object keyed by entryKey), etc. The extension
  recursively walks the envelope and collects every object that has **both** a name-ish and a
  points-ish field (handling arrays *and* keyed-object maps), keeps the top-level `leader` as a
  fallback single entry, and de-dupes by `entryKey` then by name.

- **Per-entry field aliases (normalized to the app's fields):**

  | Meaning      | DK field names seen in the wild                                              | App field   |
  | ------------ | ---------------------------------------------------------------------------- | ----------- |
  | Entry/user   | `userName`, `user_name`, `displayName`, `entryName`, `teamName`              | `entryName` |
  | Points       | `fantasyPoints`, `fantasy_points`, `points`, `score`, `fpts` (strings → num) | `points`    |
  | Rank         | `rank`, `currentRank`                                                         | `rank`      |
  | Entry id/key | `entryKey`, `entry_key`, `entryId`                                            | `entryKey`  |

---

## Install (Load unpacked)

1. Open **`chrome://extensions`** in Chrome (or any Chromium browser: Edge, Brave).
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked**.
4. Select **this `extension/` folder** (the one containing `manifest.json`).
5. The extension **KeyLehr H2H — DraftKings Sync** appears. Pin it for easy access.

> If you change the **App Base URL** to something other than `http://localhost:3000` (e.g. your
> deployed `https://your-app.vercel.app`), Chrome prompts **once** for host permission for that
> origin — accept it. The manifest pre-grants only `http://localhost:3000/*` and
> `https://*.draftkings.com/*`; every other origin is requested at runtime (see
> **[Setting up additional admins / using the deployed app](#setting-up-additional-admins--using-the-deployed-app)**).

---

## Setting up additional admins / using the deployed app

The extension is not published to the Chrome Web Store — each admin loads the same `extension/`
folder unpacked and points it at the **deployed** app. There is no per-person account: everyone
shares one **Ingest Token** (the server's `INGEST_TOKEN`), and every sync is recorded in the app's
audit log, so multiple people can sync the same week safely (it's idempotent — re-syncing just
overwrites that week's scores).

**How the deployed-domain permission works.** The manifest's `host_permissions` are intentionally
minimal — only DraftKings + `localhost:3000`. Any other origin (your Vercel URL) lives in
`optional_host_permissions: ["https://*/*","http://*/*"]`, which Chrome will **not** grant until
the extension *requests* it at runtime. So the first time you **Test connection**, **Save**, or
**Sync** with a deployed App Base URL, the popup calls `chrome.permissions.request({ origins:
["https://your-app.vercel.app/*"] })` and Chrome shows a one-time "Allow this site?" prompt. Once
you approve, the grant persists and you won't be asked again. If you decline, the popup shows
**"Grant access to https://your-app.vercel.app to sync"** and the fetch is skipped (nothing
breaks — just re-try and approve).

**Per-admin setup (each person does this once):**

1. **Load the extension.** Get the `extension/` folder (clone the repo or copy it). Open
   **`chrome://extensions`** → toggle **Developer mode** ON (top-right) → **Load unpacked** →
   select the `extension/` folder. Pin it.
2. **Open Settings** (the ⚙ gear, or it opens automatically on first run) and set:
   - **App Base URL** = the deployed URL, e.g. `https://keylehr-h2h.vercel.app` (no trailing path).
   - **Ingest Token** = the **shared** token — the same value the server has in its `INGEST_TOKEN`
     env var. Ask the commissioner for it; everyone uses the identical token.
3. **Approve the permission prompt.** Click **Test connection** (or **Save**). Chrome shows a
   one-time prompt to access the deployed domain — click **Allow**. You should then see
   **✓ Connected — N seasons found**. (Declining shows the "Grant access…" message; just retry.)
4. **Log into DraftKings and use Capture & Sync.** In the same browser, log in to DraftKings,
   open the shared contest's **`/contest/gamecenter/{contestId}`** Standings tab, open the popup,
   and click **Sync Week N**. See **[Use — two sync paths](#use--two-sync-paths)** below.

> Multiple admins syncing the same week is safe: the token is shared, ingest is idempotent, and
> each sync is logged in the app's audit log so the commissioner can see who synced what.

---

## Configure (one-time, persists via chrome.storage)

The popup has **two screens**: a one-time **Settings** screen and the everyday **Main** screen.

### Settings screen (first run, or via the ⚙ gear icon)

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| **App Base URL** | `http://localhost:3000` for local dev, or your deployed app's origin.       |
| **Ingest Token** | The `INGEST_TOKEN` value from the app's `.env.local` (or Vercel env).       |

Click **Test connection** to `GET <App Base URL>/api/seasons` with the token — you'll see
**✓ Connected — N seasons found** or a **✗** error. Click **Save** to go to the Main screen. The
Season is now chosen from a dropdown on the Main screen (no more numeric Season ID), and the Week
auto-fills (see below) — no manual Contest ID needed.

### Main screen

- A **connection chip** at top: green **● Connected to localhost:3000**, or red
  **● Not connected — open Settings** (click it to jump to Settings).
- A **Detected contest** card: when the active tab is a DK contest
  (`/contest/gamecenter/{id}` or `/draft/contest/{id}`) it shows the parsed **contest id** and, if
  the content script could read it, the **contest name**. Otherwise it shows a friendly prompt to
  open your league's DraftKings contest → Standings tab.
- A **Season** dropdown (populated from `/api/seasons`, defaulting to the app's current season).
- A **Week** input, **auto-filled** by parsing a trailing `#<number>` from the contest name
  (e.g. "…#18" → 18), falling back to the selected season's `currentWeek`. Editable.
- A **Preseason** checkbox — see [Preseason (exhibition) syncs](#preseason-exhibition-syncs).
- A big **Sync Week N** button (disabled until a contest is detected and a season is selected).
  This is the only button you need: it does **scores and lineups**.
- The result banner, plus a persistent **Last synced: Week N · HH:MM · matched Y/Z** line.
- A **Lineups — for live scoring** card. **No button** — Sync drives it; the card reports the
  lineup half's outcome on its own so it can never be confused with the score result. It shows a
  persistent **Last capture: Week N · HH:MM · Y/Z lineups · R/S players revealed** line. See
  [below](#lineups-captured-automatically-by-sync).
- A **Live Sync** card — **optional**; `/live` does not need it (see the Live Sync section below).
- A **Troubleshooting — DraftKings endpoints** expander — not part of normal use. See
  [below](#troubleshooting--draftkings-endpoints).
- A **Paste manually** expander for the JSON fallback (scores only).

### Preseason (exhibition) syncs

> **The app can no longer create an exhibition week.** Admin → Preseason and `syncPreseasonWeek`
> were removed — the league decided it doesn't want exhibitions. This toggle still works, and still
> posts the offset week, so **existing** exhibition weeks (week 102) can be re-scored and stay
> visible on `/live`. But if no exhibition matchups exist for the week, the scores land with nothing
> to score them against and `/live` shows no games. Treat this section as maintenance for data that
> already exists, not a way to start a new preseason.

(Byes are not a hazard here: exhibition weeks never produce one.)

Then tick **Preseason** in the popup. The Week input now means *preseason week* and accepts
**1–3**; the extension POSTs it offset into the exhibition namespace (`100 + week` →
101/102/103), and the labels switch to "Sync Preseason Wk 2".

That offset week is the *only* signal the server needs: `ingestLeaderboard` derives
`isExhibition` from it, so the scores appear on **/live** — which renders exhibition weeks like any
other — but never reach standings, seeding, playoffs, payouts, or all-time records. The lineup half
of Sync carries the same offset week, so exhibition rosters stay in the same isolated namespace.
Live Sync works unchanged in this mode — it
carries the offset week through, and its auto-stop reads the contest's completion state
(status field / no time-or-points remaining), which is week-agnostic.

Two guards worth knowing:

- The regular (1–25) and exhibition (101–103) week ranges are **disjoint**, so a typo can't
  silently land a preseason score in a real week — the API rejects anything in between with
  *"Week must be 1–25 (regular/playoff) or 101–103 (preseason exhibition)."*
- Switching the checkbox **re-derives the week** rather than carrying the number across; a
  regular week 7 is not preseason week 7. Contest-name and `currentWeek` auto-fill hints are
  ignored in preseason mode, since both are regular-season numbers.

> `popup.js` **mirrors** `PRESEASON_WEEK_BASE` / `MAX_PRESEASON_WEEK` from
> `src/lib/schedule/preseason.ts` (and `MAX_REGULAR_WEEK` from `src/lib/ingest/week-schema.ts`,
> which both ingest endpoints share). If those ever change, change them in both places —
> `src/lib/schedule/preseason.test.ts` pins the namespace invariants server-side only.

---

## The `/api/seasons` endpoint (used by the popup)

`GET <App Base URL>/api/seasons` with `Authorization: Bearer <Ingest Token>` (same token as the
ingest route) returns:

```json
{
  "seasons": [{ "id": 3, "name": "Season 3 (2025)", "status": "active", "currentWeek": 18, "regularSeasonWeeks": 18 }],
  "currentSeasonId": 3
}
```

Seasons are ordered active → upcoming → completed, then by year. The popup uses it both to
populate the Season dropdown and as the **Test connection** probe.

---

## Use — two sync paths

Both POST normalized `entries` to `<App Base URL>/api/ingest/draftkings` with
`Authorization: Bearer <Ingest Token>` and show a prominent result banner. **Sync additionally**
POSTs rosters to `/api/ingest/lineups`; the paste path does not.

### 1. Sync  *(primary — one click, both halves)*

1. In the same browser, log in to DraftKings and open the shared contest's
   **`/contest/gamecenter/{contestId}`** page. **This tab must be the active tab** — the
   extension reads the contest id from its URL.
2. Click the **Standings / Leaderboard** tab.
3. Open the extension popup. The contest auto-detects and the Week auto-fills; click
   **Sync Week N**. The extension:
   - uses the `{contestId}` parsed from the active tab URL,
   - runs an authenticated `fetch` of
     `…/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard` **from the DK page**
     (so your DK session cookies are sent),
   - fetches one roster per entry off the entry keys that same read returned,
   - robustly extracts **all** entries from the response, and
   - POSTs the scores to `/api/ingest/draftkings`, **then** the rosters to `/api/ingest/lineups`.

   The single leaderboard read serves both halves — DraftKings is not asked for the same page
   twice. If the roster fan-out fails, the flow falls back to the plain leaderboard read and the
   score sync proceeds regardless.

### 2. Paste manually  *(guaranteed fallback)*

Use this if Sync can't reach the endpoint (not logged in, DK changed something, etc.). Expand
**Paste manually** on the Main screen.

1. On the DK standings page, open **DevTools → Network** (F12).
2. Reload, filter for `leaderboard`, and click the request whose path contains
   `scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard`. **Make sure the URL
   includes `&embed=leaderboard`** — otherwise you only get the single leader.
3. **Copy** the full JSON response and paste it into the popup's **Paste leaderboard JSON** box,
   then click **Paste JSON & Sync**. The same robust extractor runs on the pasted JSON.

   Accepted paste shapes (any of):
   - the full DK envelope (the extractor finds the nested `leaderBoard` array or
     `leaderBoardUserEntries.entryByEntryKey` map),
   - a raw array: `[{"userName":"Brandon","fantasyPoints":241.68,"rank":1}, ...]`,
   - the app's normalized shape: `{"entries":[{"entryName":"Brandon","points":241.68}]}`.

---

### 3. Live Sync  *(optional — keep DraftKings' own totals fresh)*

> **You probably don't need this.** The app's **`/live`** page computes its own running estimate
> from public NFL stats and keeps moving with this computer switched off — that is the entire point
> of capturing rosters. Turn Live Sync on only when you want DraftKings' **official** totals
> refreshed during games too, and accept that it needs the machine awake and Chrome open.

The one-click **Sync** above is a single snapshot. **Live Sync** re-runs that same capture+POST
automatically every few minutes so the leaderboard keeps updating while games are in progress —
and it **stops itself when the contest is final**.

**How to start it:**

1. Log in to DraftKings and open the contest's **`/contest/gamecenter/{contestId}`**
   **Standings / Leaderboard** tab. **Leave this DK tab open** (see the requirement below).
2. Open the popup, make sure the contest is detected and the **Season** + **Week** are correct.
3. In the **Live Sync** card, set the cadence (**every N min**, default **5**, min **1**) and flip
   the **Live Sync** toggle **ON**. It runs the first sync immediately, then repeats on a
   `chrome.alarms` timer.

Once on, the popup shows live status and the toolbar icon gets a badge:

- **`live`** badge · `● Live: last synced Week N at HH:MM (32 matched) · next in Mm` — running.
- **`⏸`** badge · `⏸ Paused — open your DraftKings contest tab to resume.` — no DK contest tab
  was found; the loop keeps retrying and resumes the moment you reopen the tab.
- **`✓`** badge · `✓ Completed — live sync stopped` — the contest finished; one final sync ran.

You can stop it any time with the toggle or the **Stop Live Sync** button. State is persisted in
`chrome.storage`, so reopening the popup reflects the current status, and the worker pushes updates
to an open popup after each poll.

**Why an open DK tab is required.** The credentialed leaderboard fetch must run in the DK page's
**MAIN world** so your DraftKings session cookies are sent (SameSite — a bare service-worker fetch
would not carry them). Each poll uses `chrome.scripting.executeScript({ world: 'MAIN' })` to run
the same `fetch(...&embed=leaderboard, { credentials: 'include' })` + extractor **inside an open
gamecenter tab**, then the background worker POSTs the result to `/api/ingest/draftkings`. So Live
Sync needs a `*.draftkings.com/contest/gamecenter/*` tab open. If none is found it pauses (above)
rather than failing.

**Auto-stop (contest completed).** After each poll the worker inspects the leaderboard data and
stops when the contest is final — detected by **either** an explicit contest *status* field reading
completed/final/finished/closed, **or** every entry showing **no time/points remaining** (DK's
`pmr` / `timeRemaining` / points-remaining fields are `0` for all entries that carry them). On
completion it does one final sync, clears the alarm, sets the **`✓`** badge, and shows
**"✓ Completed — live sync stopped"**.

> **Tip — testing.** A fast-resolving DraftKings **Madden** contest is ideal for exercising Live
> Sync end-to-end (open tab → toggle on → watch it poll → auto-stop on completion) without waiting
> for a full NFL Sunday.

**Sleep-honest (the tradeoff).** `chrome.alarms` only fire while **Chrome is running and the
computer is awake**. If the machine **sleeps** or you **quit Chrome**, the alarm **pauses** and
**resumes** when Chrome is awake again — it does not catch up missed ticks while asleep. This is
the accepted tradeoff for the **no-stored-credentials** model: the credentialed DK fetch runs in
*your* live browser session (via the open DK tab), so nothing runs when your browser isn't. For
unattended 24/7 polling you'd need a stored-credentials server pull, which this project
deliberately avoids. Keep the machine awake / Chrome open during the window you want covered.

## Lineups (captured automatically by Sync)

> **Since v1.3.0 there is no separate button** — **Sync** does this. This does **not** write a
> score. It records *who each owner started* so the app can compute a running estimate from public
> NFL stats all week — see
> [`../docs/SCORING.md` §15](../docs/SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).
> The DraftKings leaderboard remains the only source of `scores`.

**Why it exists.** The leaderboard sync needs your live DK session, so the official numbers only
move when someone syncs. Rosters are the one thing only DraftKings knows — capture them **once**
(authenticated, from your browser), and everything after that is computed from ESPN's free, keyless
boxscore. No stored credentials, no cron, machine can be off in between. That is why **`/live`
keeps updating when this extension is closed** and your computer is asleep.

**How to run it:** click **Sync**. That's it — same tab, same Season/Week, same **Preseason** toggle.
The lineup half runs off the same leaderboard read and reports into the **Lineups** card.

The extension then, all inside the DK page's MAIN world so your session cookies are attached:

1. resolves the contest's **draft group id** from `contests/v1/contests/{contestId}`,
2. fetches the leaderboard **once** to get every **entry key** — the score half reuses these very
   rows, so DraftKings is not asked for the same page twice,
3. fetches one roster per entry from
   `scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster`, at **concurrency 4** with
   150–300 ms of jitter, and
4. POSTs the rosters **raw** to `<App Base URL>/api/ingest/lineups` as `rawLineups`.

> **You do not need to click into anyone's lineup.** Entry keys come from the leaderboard.

**Why one request per entry.** DraftKings has **no bulk roster endpoint**. The obvious
`…/leaderboards/{contestId}?embed=leaderboard,roster` answers **HTTP 200 with an empty
`entryByEntryKey` map** — it looks like it worked and returns nothing. The fan-out is deliberately
unhurried: it is the commissioner's own session against their own contest, and there is no deadline —
the whole point of the feature is that everything *after* the capture needs no authentication at all.

**Rosters are posted raw, on purpose.** The server owns the one tested normalizer
(`src/lib/lineups/normalize.ts`), run against a real captured payload. A second copy in the extension
would be a second thing to keep correct.

### Concealed players — read this before reporting a bug

DraftKings hides a player from opponents until **that player's game kicks off**. Concealed slots come
back with no name (`draftableId: 0`). So a capture can honestly report:

```text
✅ Week 1 lineups saved — 32/32 owners.
18 of 288 players revealed — the rest are still concealed until their game starts.
```

That is a **complete** capture, not a broken one:

- A concealed player has scored nothing by definition, so **no points are ever missing — only
  names.** Capture again after later kickoffs and they fill in.
- Concealment tracks swappability exactly, so any player you *can* see is already **locked** and can
  no longer be late-swapped. Revealed data never goes stale.

**Re-capturing is the intended workflow**, not a repair: DK Classic allows late swap, every capture
is stored as a new version keyed by its capture time, and the newest one wins.

### Result messages (Lineups card)

These appear in the **Lineups** card, never in the score banner — deliberately, so a roster problem
is visible without casting doubt on a score sync that worked. If roster capture failed outright you
get `Lineups not captured — <reason>` followed by **"Scores were synced anyway."**

- `✅ Week N lineups saved — Y/Z owners.` plus the revealed count, and, when relevant:
  - `Unmatched DK names: …` — fix the owner's DK entry name in Admin → Assignments and re-capture.
  - `Failed to read N: …` — those entries' roster requests errored; the rest still saved.
  - `No entry key on the leaderboard for: …` — no roster could be requested for them.
  - `⚠ Teams could not be resolved from DraftKings' public slate — re-run later.` — the capture
    stored but the server resolved **zero** team keys, which means it is not yet scorable.
- `DraftKings 401/403 — log in to DraftKings in this tab and retry.`
- `❌ Saving failed — <detail>` — the app rejected the post; the message reports how many lineups
  were captured first.

## Troubleshooting — DraftKings endpoints

> **Not part of normal use — Sync does everything.** In the popup this is the
> **"Troubleshooting — DraftKings endpoints"** expander (called *Diagnose roster endpoint* before
> v1.3.0; it was clicked by mistake in place of the real button, which is a UI problem, not a user
> one). It reads nothing into the app and posts nothing anywhere.
>
> **Use it for exactly one situation:** lineup capture starts failing, which would mean DraftKings
> changed its API. Run it and send the output to whoever maintains the app. **This is how the
> roster endpoint above was found** in the first place.

**The problem it exists to solve.** Live in-progress scoring needs each owner's DK **roster**, not
just their total. DraftKings' roster endpoint is undocumented, and the entire `scores/*` namespace
requires a session — keyless it returns `SCO101 Invalid userKey` even for a public contest (see
[`../docs/DRAFTKINGS.md` §11](../docs/DRAFTKINGS.md#11-endpoint-inventory--what-is-public-and-what-needs-auth)).
So the endpoint cannot be found from outside a logged-in browser, and guessing from the outside is
a dead end.

**How to run it:**

1. Open a contest **gamecenter** tab and **reload it** — the recorder has to be installed before
   the page loads (see below).
2. **Click an entry** in the gamecenter so DK actually draws a lineup.
3. Open the popup → expand **Diagnose roster endpoint** → **Probe roster endpoint**.
4. Click **Copy full result** and paste the report into `docs/DRAFTKINGS.md` §11.

> **If DraftKings has moved the endpoint**, update `ROSTER_URL_TEMPLATE` in `page-hook.js` *and*
> `docs/DRAFTKINGS.md` §11 with whatever the report names. Captures also record the winning URL in
> the database (`lineup_capture_runs.sourceUrlTemplate`), so the answer survives even if nobody
> edits a doc. A raw payload can always be pasted into **Admin → Lineups** in the meantime — it is
> parsed structurally, so the shape does not matter. See
> [`../docs/SCORING.md` §15](../docs/SCORING.md#15-live-in-progress-scoring-an-estimate-never-a-score).

**What it does — two ways to win:**

- **Candidate templates.** It walks six candidate roster URLs from inside the DK page (credentialed,
  same MAIN-world trick as the leaderboard capture), then structurally counts roster-slot-shaped
  objects anywhere in each response — the same "identify rows by shape, not by path" approach the
  leaderboard extractor uses. The first template is the jackpot: if
  `…/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard,roster` works, all 32 lineups
  arrive in **one** request instead of 32. Templates containing `{entryKey}` are **skipped** unless
  a real entry key is available — run a normal leaderboard **Sync** first, which stashes the first
  five entry keys in `chrome.storage` as `lastEntryKeys` for exactly this purpose.
- **The request recorder.** `page-hook.js` wraps `fetch` and `XMLHttpRequest.open` in the DK page
  and logs **`api.draftkings.com` URLs only**. Whatever DK's own gamecenter calls to render a
  lineup *is* the right endpoint, by definition — so even when every template fails, the report
  names the answer. This is the reliable path; the templates are just a shortcut.

The result panel reports **Found it** (with the winning template and roster-row count), or
**No template worked** plus the recorded URLs. The copy-pasteable report contains, in order: every
candidate template with its HTTP status, a sample of the roster rows and a truncated raw payload if
one succeeded, and the recorded `api.draftkings.com` URLs.

**Recorder safety.** It is a passive observer: every wrapper calls straight through and swallows
its own errors, so a bug in it cannot break the DraftKings page. It keeps **URLs only** — never
headers, bodies, or cookies — caps the list at 200 entries, de-dupes so a polling SPA cannot flood
it, and hands back at most the newest 60. It lives only in the page you opened and is gone when
you close the tab.

> **If the recorded list is empty**, the hook was installed after the requests fired. Reload the
> gamecenter tab, click an entry, and probe again.

## Result messages (score sync)

The popup always shows a prominent banner reporting **how many entries were captured before the
post**, so a "1 of 32" situation is obvious at a glance.

- **Success (GREEN):**
  `✅ Week 18 synced — sent 32, matched 32, unmatched 0`
  If any names didn't match an owner, the banner stays green-with-amber and lists the
  **unmatched DK names** below the title (fix the owner's `dkEntryName` in the app and re-sync —
  re-syncing is idempotent). Owners on a bye that week get a non-counting `isBye` row
  automatically.

- **Failure (RED), with the reason:**
  - `❌ Couldn't read leaderboard — open the contest's Standings tab and retry` — the fetch
    failed or returned no entries.
  - `❌ DraftKings 401 — log in to DraftKings in this tab and retry` (also `403`).
  - `❌ No contest detected` — the active tab isn't a DK `/contest/gamecenter/{id}` page, or no
    contest id could be parsed from the URL (the Sync button stays disabled until one is detected).
  - `❌ 401 — check the Ingest Token` — the app rejected the bearer token.
  - `❌ Server <status>` / `❌ Sync failed` — other server/network errors (the message includes
    how many entries were captured before the post).

> **A failure always says something.** `postIngestTo` used to render **"Saving failed —"** with
> nothing after the dash: an error page (a 404 from a deployment predating the endpoint, say) is
> HTML, so `res.json()` fails, and `statusText` is an empty string over HTTP/2 — which is what most
> hosts serve. It now always falls back to the status code, and a `404` additionally names the URL
> and suggests the App Base URL may point at an older deployment.

The app matches each `entryName` (case-insensitive, trimmed) to `owner_seasons.dkEntryName`
(falling back to `owners.dkUsername`).

---

## Privacy / security notes

- The extension only reads DraftKings pages you open and posts to the App Base URL you set.
- The **request recorder** added in v1.1.0 keeps `api.draftkings.com` **URLs only**, in memory, in
  the DK tab you opened — never headers, bodies, or cookies, and it is never sent anywhere. It is
  read only when you click **Probe roster endpoint**, and it dies with the tab.
- **Roster capture** (v1.2.0, folded into **Sync** at v1.3.0) added **no new permissions**: it
  reuses the same DraftKings host access and the same MAIN-world fetch the leaderboard sync already
  uses. It reads league members' rosters from a contest you are in and sends them only to your own
  app. Note that it stores only what DraftKings already revealed — concealed players are recorded
  without an identity, so the app cannot expose a lineup DK was still hiding.
- Beyond DraftKings + `localhost:3000` (the only pre-granted hosts), the extension holds host
  access **only** to the deployed origin you explicitly approve at the one-time Chrome permission
  prompt — nothing else.
- The Ingest Token is stored in `chrome.storage.local` and sent only to your app origin.
- No data leaves your machine except the leaderboard/roster POSTs to your own app.
- This uses DK's undocumented data and is against DK's ToS — treat it as best-effort and keep
  the paste fallback handy.

---

## Files

| File                | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `manifest.json`     | MV3 manifest (permissions, content script, popup, background service worker). **Version lives here** — currently `1.3.0`. |
| `popup.html/.css/.js` | The popup UI + the two sync paths + the **Lineups** status card + the Live Sync card + the **Troubleshooting** panel + result banners. `onSync()` drives both halves; `saveCapturedLineups(cap, season, week, contestId)` POSTs the already-fetched rosters and reports into the Lineups card. `postIngestTo(path, payload)` is the shared poster for both ingest endpoints and **always** produces an error message. |
| `background.js`     | MV3 service worker. Drives **Live Sync**: a `chrome.alarms` poll that runs the credentialed capture in an open DK tab's MAIN world (`chrome.scripting.executeScript`), POSTs to ingest, and auto-stops when the contest is completed. Reflects state via `chrome.storage` + badge. |
| `content-script.js` | Injects the page hook; bridges popup ⇄ hook through a generic tagged round-trip (`askPage`), used by `CAPTURE_LEADERBOARD`, `PROBE_ROSTER_ENDPOINT` (45s — it hits several DK URLs in sequence) and `CAPTURE_ROSTERS` (180s — one request per entry, so it is the longest round-trip the popup makes); reads the contest name from the gamecenter DOM (`DETECT_CONTEST`). |
| `page-hook.js`      | Runs in the page's MAIN world. Authenticated fetch of the embed endpoint + robust entry extraction; the passive `api.draftkings.com` **request recorder** and `probeRosterEndpoint()` (v1.1.0); and (v1.2.0) `captureRosters()` / `fetchRoster()` / `slotIsRevealed()` behind `ROSTER_URL_TEMPLATE`. **v1.3.0:** `captureRosters()` returns the leaderboard `entries` alongside `lineups`, which is what lets one read serve both halves of Sync. |

**Stored settings** (`chrome.storage.local`, `DEFAULTS` in `popup.js`): `appBaseUrl`,
`ingestToken`, `seasonId`, `week`, `preseason`, `lastSync`, `lastEntryKeys` (v1.1.0 — up to five DK
entry keys from the last sync, used **only** by the roster-endpoint probe), and `lastLineupCapture`
(v1.2.0 — `{ week, time, matched, expected, revealed, slots }` from the last roster capture, shown
as the "Last capture" line).
