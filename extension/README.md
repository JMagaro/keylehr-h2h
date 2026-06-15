# KeyLehr H2H — DraftKings Sync (Chrome extension)

A Manifest V3 Chrome extension that reads the shared **private** DraftKings contest
leaderboard from the commissioner's **already-logged-in** DraftKings session and posts it to
the KeyLehr H2H app's ingest endpoint (`POST /api/ingest/draftkings`). The app then matches
each entry to a league owner and writes that week's scores.

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
  no-`embed` `scores/v1/...` path or any `scores/v2/...` path.

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
- A big **Sync Week N** button (disabled until a contest is detected and a season is selected).
- The result banner, plus a persistent **Last synced: Week N · HH:MM · matched Y/Z** line.
- A **Paste manually** expander for the JSON fallback.

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
`Authorization: Bearer <Ingest Token>` and show a prominent result banner.

### 1. Sync  *(primary — one click)*

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
   - robustly extracts **all** entries from the response, and
   - POSTs them to the app.

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

## Result messages

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

The app matches each `entryName` (case-insensitive, trimmed) to `owner_seasons.dkEntryName`
(falling back to `owners.dkUsername`).

---

## Privacy / security notes

- The extension only reads DraftKings pages you open and posts to the App Base URL you set.
- Beyond DraftKings + `localhost:3000` (the only pre-granted hosts), the extension holds host
  access **only** to the deployed origin you explicitly approve at the one-time Chrome permission
  prompt — nothing else.
- The Ingest Token is stored in `chrome.storage.local` and sent only to your app origin.
- No data leaves your machine except the leaderboard POST to your own app.
- This uses DK's undocumented data and is against DK's ToS — treat it as best-effort and keep
  the paste fallback handy.

---

## Files

| File                | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `manifest.json`     | MV3 manifest (permissions, content script, popup).                         |
| `popup.html/.css/.js` | The popup UI + the two sync paths + result banners.                      |
| `content-script.js` | Injects the page hook; bridges the popup's capture request ⇄ the hook; reads the contest name from the gamecenter DOM (`DETECT_CONTEST`). |
| `page-hook.js`      | Runs in the page's MAIN world; authenticated fetch of the embed endpoint + robust entry extraction. |
