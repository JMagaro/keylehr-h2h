/*
 * popup.js — the KeyLehr H2H — DraftKings Sync popup.
 *
 * Two-screen flow:
 *   • Settings screen — App Base URL + Ingest Token + "Test connection" (GET /api/seasons) + Save.
 *     Shown first-run (when unconfigured) or via the gear icon.
 *   • Main screen — a connection chip, the detected DK contest, a Season dropdown (from
 *     /api/seasons), an auto-filled Week + the dates it covers (from /api/current-week), a
 *     "Preseason" toggle, a big "Sync Week N" button, the result banner, a persistent
 *     "Last synced" line, and a "Paste manually" fallback.
 *
 * The Week and the Preseason toggle are DETECTED from the app's synced NFL schedule, not guessed
 * from the contest name — and the selected week's date range is shown before you sync, because
 * `scores` upserts on (owner, week) and the wrong week silently overwrites a real one. See
 * fetchWeekInfo / renderWeekInfo.
 *
 * Preseason mode: the Week input means "preseason week 1–3" and the POSTed week is offset into
 * the exhibition namespace (101–103). That single number is all the server needs — it flags the
 * scores `isExhibition`, so they never touch standings or payouts. Exhibition weeks can no
 * longer be CREATED — this remains for the data that already exists.
 *
 * ONE button does both halves of a week's data, because both come from a single DraftKings
 * read and there is no case where you want one without the other:
 *
 *   SCORES  → POST `entries` to <AppBaseURL>/api/ingest/draftkings   (official, settles the week)
 *   LINEUPS → POST `rawLineups` to <AppBaseURL>/api/ingest/lineups   (feeds the /live estimate)
 *
 * `captureRosters` in page-hook.js fetches the leaderboard to get entry keys, so it hands
 * those rows back and the score sync reuses them rather than fetching the same page twice.
 *
 * Scores go first and lineups are BEST EFFORT: a roster failure must never block or cast doubt
 * on a score sync, so lineups report into their own card and a failure there leaves the score
 * result standing. If roster capture fails outright, the flow falls back to the plain
 * leaderboard read — the path that existed before lineups did.
 *
 *   (a) Sync (PRIMARY) — the above, from the active DK contest tab.
 *   (b) Paste manually (fallback) — user pastes the DK leaderboard JSON; the same robust
 *       extractor runs locally and the entries are POSTed. Scores only.
 */

/**
 * Preseason (exhibition) week namespace — mirrors src/lib/schedule/preseason.ts.
 *
 * A preseason week is POSTed at an OFFSET (101/102/103) so it can never collide with a
 * regular-season (1–18) or playoff (19–22) week. The server needs nothing else to know it's
 * an exhibition: `ingestLeaderboard` derives `isExhibition` from the week alone, and every
 * standings/stats query excludes those rows. The user still types 1–3 — the offset is applied
 * here so the storage detail never reaches the UI.
 */
const PRESEASON_WEEK_BASE = 100;
const MAX_PRESEASON_WEEK = 3;
const MAX_REGULAR_WEEK = 25;

const DEFAULTS = {
  appBaseUrl: 'http://localhost:3000',
  ingestToken: '',
  seasonId: '',
  week: '',
  preseason: false, // exhibition mode — Week means "preseason week 1–3"
  lastSync: null, // { week, time (ms), matched, total }
  // A few DK entry keys from the last sync. Used only by the roster-endpoint probe, which
  // needs a real entry key to test the per-entry candidate URLs.
  lastEntryKeys: null, // string[] | null
  // Last LINEUP capture (live scoring) — a different thing from lastSync, which is scores.
  lastLineupCapture: null, // { week, time (ms), matched, expected, revealed, slots }
};

const els = {
  gearBtn: document.getElementById('gearBtn'),
  // settings screen
  settingsScreen: document.getElementById('settingsScreen'),
  appBaseUrl: document.getElementById('appBaseUrl'),
  ingestToken: document.getElementById('ingestToken'),
  testBtn: document.getElementById('testBtn'),
  saveBtn: document.getElementById('saveBtn'),
  testResult: document.getElementById('testResult'),
  // main screen
  mainScreen: document.getElementById('mainScreen'),
  statusChip: document.getElementById('statusChip'),
  chipText: document.getElementById('chipText'),
  contestCard: document.getElementById('contestCard'),
  contestBody: document.getElementById('contestBody'),
  seasonSelect: document.getElementById('seasonSelect'),
  week: document.getElementById('week'),
  preseasonToggle: document.getElementById('preseasonToggle'),
  weekInfo: document.getElementById('weekInfo'),
  syncBtn: document.getElementById('syncBtn'),
  syncSpinner: document.getElementById('syncSpinner'),
  syncLabel: document.getElementById('syncLabel'),
  status: document.getElementById('status'),
  lastSynced: document.getElementById('lastSynced'),
  pasteJson: document.getElementById('pasteJson'),
  pasteBtn: document.getElementById('pasteBtn'),
  // lineup capture (live scoring) — status only; the Sync button drives it
  lineupsStatus: document.getElementById('lineupsStatus'),
  lastCaptured: document.getElementById('lastCaptured'),
  // live sync
  liveToggle: document.getElementById('liveToggle'),
  liveInterval: document.getElementById('liveInterval'),
  liveStatus: document.getElementById('liveStatus'),
  liveStopBtn: document.getElementById('liveStopBtn'),
  // roster-endpoint diagnosis (Phase 0 of live scoring)
  probeBtn: document.getElementById('probeBtn'),
  probeSpinner: document.getElementById('probeSpinner'),
  probeLabel: document.getElementById('probeLabel'),
  probeResult: document.getElementById('probeResult'),
  probeRaw: document.getElementById('probeRaw'),
  probeCopyBtn: document.getElementById('probeCopyBtn'),
};

// In-memory popup state.
const state = {
  settings: { ...DEFAULTS },
  seasons: [], // [{ id, name, status, currentWeek, regularSeasonWeeks }]
  currentSeasonId: null,
  contest: null, // { id, name } when a DK contest is detected in the active tab
  // { detected, requested } from /api/current-week — the schedule's answer for which week
  // it is and what dates the selected week covers. null when the app can't say.
  weekInfo: null,
  busy: false, // a sync is in flight
};

/* -------------------------------------------------------------------------- */
/* settings persistence                                                        */
/* -------------------------------------------------------------------------- */

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (s) => {
      state.settings = {
        appBaseUrl: s.appBaseUrl || DEFAULTS.appBaseUrl,
        ingestToken: s.ingestToken || '',
        seasonId: s.seasonId || '',
        week: s.week || '',
        preseason: Boolean(s.preseason),
        lastSync: s.lastSync || null,
        lastEntryKeys: Array.isArray(s.lastEntryKeys) ? s.lastEntryKeys : null,
        lastLineupCapture: s.lastLineupCapture || null,
      };
      resolve(state.settings);
    });
  });
}

function persist(partial) {
  Object.assign(state.settings, partial);
  return new Promise((resolve) => chrome.storage.local.set(partial, resolve));
}

function isConfigured() {
  return Boolean(
    (state.settings.appBaseUrl || '').trim() && (state.settings.ingestToken || '').trim(),
  );
}

function appBase() {
  return (state.settings.appBaseUrl || '').trim().replace(/\/+$/, '');
}

/* -------------------------------------------------------------------------- */
/* origin host-permission (optional_host_permissions) handling                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the match pattern (`https://host/*`) for the origin of a configured base URL.
 * Strips any path/query and keeps the scheme + host(+port). Returns '' if unparseable.
 */
function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return '';
  }
}

/** Just the human-readable origin (scheme://host) for messages. */
function originLabel(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl;
  }
}

/** Promise wrapper around chrome.permissions.contains for an origin pattern. */
function hasOriginPermission(pattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.contains({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(Boolean(granted));
      });
    } catch {
      resolve(false);
    }
  });
}

/** Promise wrapper around chrome.permissions.request for an origin pattern. */
function requestOriginPermission(pattern) {
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(Boolean(granted));
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Ensure we hold host permission for the given base URL's origin, prompting the user once if
 * needed. Origins already covered by manifest `host_permissions` (localhost, draftkings) resolve
 * immediately. Returns { ok: true } on success, or { ok: false, error } with a clear message.
 *
 * NOTE: chrome.permissions.request must run in the same user-gesture turn as a click handler, so
 * call this directly from a click handler (Test / Save / Sync / Paste) — not after an await of an
 * unrelated async chain that breaks the gesture, which is why each flow calls it up front.
 */
async function ensureOriginPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) {
    return { ok: false, error: 'App Base URL must be a valid http(s) URL.' };
  }
  if (await hasOriginPermission(pattern)) return { ok: true };

  const label = originLabel(baseUrl);
  const granted = await requestOriginPermission(pattern);
  if (granted) return { ok: true };
  return { ok: false, error: `Grant access to ${label} to sync.` };
}

/* -------------------------------------------------------------------------- */
/* screen switching                                                            */
/* -------------------------------------------------------------------------- */

function showSettings() {
  els.appBaseUrl.value = state.settings.appBaseUrl || DEFAULTS.appBaseUrl;
  els.ingestToken.value = state.settings.ingestToken || '';
  els.testResult.textContent = '';
  els.testResult.className = 'test-result';
  els.settingsScreen.hidden = false;
  els.mainScreen.hidden = true;
  els.appBaseUrl.focus();
}

function showMain() {
  els.settingsScreen.hidden = true;
  els.mainScreen.hidden = false;
  // Restore preseason mode BEFORE anything auto-fills the week — the mode decides both
  // the input's range and which auto-fill hints apply.
  els.preseasonToggle.checked = Boolean(state.settings.preseason);
  els.week.max = String(maxWeekForMode());
  renderLastSynced();
  renderLastCaptured();
  refreshChipAndSeasons();
  detectContest();
  refreshLive();
}

/* -------------------------------------------------------------------------- */
/* status / banner helpers                                                     */
/* -------------------------------------------------------------------------- */

/** kind: 'ok' (green) | 'warn' | 'err' (red) | 'info' (neutral). */
function setBanner(message, kind) {
  els.status.textContent = message;
  els.status.className = 'status show ' + (kind || 'info');
}

function clearBanner() {
  els.status.textContent = '';
  els.status.className = 'status';
}

/** A prominent multi-line success/failure banner with an emoji title. */
function setResultBanner(title, detailLines, kind) {
  const lines = [title, ...(detailLines || []).filter(Boolean)];
  setBanner(lines.join('\n'), kind);
}

/* -------------------------------------------------------------------------- */
/* /api/seasons fetch (dropdown + "Test connection")                           */
/* -------------------------------------------------------------------------- */

/** GET /api/seasons with the bearer token. Returns { seasons, currentSeasonId }; throws on error. */
async function fetchSeasons(base, token) {
  const url = `${base}/api/seasons`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (e) {
    const err = new Error(`Could not reach ${url}. Is the app running and the URL allowed? (${e.message})`);
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json && json.error) || res.statusText || `HTTP ${res.status}`;
    const err = new Error(res.status === 401 ? 'Token rejected (401).' : msg);
    err.status = res.status;
    throw err;
  }
  return json || { seasons: [], currentSeasonId: null };
}

/**
 * Ask the app which week it is, and what dates a given week covers.
 *
 * The app derives both from the synced NFL schedule, which is the only source that actually
 * knows. Guessing here was unreliable in two ways that both bit us: a contest name need not
 * contain "#N", and the preseason toggle was never detected at all — it just remembered its
 * last state, which put a capture in week 102 while the scores went to 103.
 *
 * Never throws: week detection is a convenience, and losing it must not stop a sync.
 */
async function fetchWeekInfo(seasonId, storedWeek) {
  try {
    const qs = storedWeek != null ? `&week=${encodeURIComponent(storedWeek)}` : '';
    const res = await fetch(`${appBase()}/api/current-week?season=${seasonId}${qs}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${state.settings.ingestToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** "Sep 11 – Sep 15" — enough to confirm a week at a glance, without the noise of a year. */
function formatDateRange(firstIso, lastIso) {
  if (!firstIso) return '';
  const opts = { month: 'short', day: 'numeric' };
  const first = new Date(firstIso).toLocaleDateString('en-US', opts);
  if (!lastIso) return first;
  const last = new Date(lastIso).toLocaleDateString('en-US', opts);
  return first === last ? first : `${first} – ${last}`;
}

/* -------------------------------------------------------------------------- */
/* connection chip + season dropdown                                           */
/* -------------------------------------------------------------------------- */

function setChip(kind, text) {
  els.chipText.textContent = text;
  els.statusChip.className = 'chip ' + kind;
}

function hostLabel() {
  try {
    return new URL(appBase()).host || appBase();
  } catch {
    return appBase();
  }
}

/** Load seasons into the dropdown and update the connection chip. */
async function refreshChipAndSeasons() {
  if (!isConfigured()) {
    setChip('bad', '● Not configured');
    els.seasonSelect.innerHTML = '<option value="">—</option>';
    updateSyncButton();
    return;
  }

  setChip('checking', '● Connecting…');
  els.seasonSelect.innerHTML = '<option value="">Loading…</option>';
  els.seasonSelect.disabled = true;

  try {
    const data = await fetchSeasons(appBase(), state.settings.ingestToken);
    state.seasons = Array.isArray(data.seasons) ? data.seasons : [];
    state.currentSeasonId = data.currentSeasonId ?? null;
    populateSeasonDropdown();
    setChip('ok', `● Connected to ${hostLabel()}`);
    // Now that a season is selected, ask the app which week it is. This drives BOTH the week
    // number and the preseason toggle, so neither is a guess any more.
    await refreshWeekInfo();
  } catch (e) {
    state.seasons = [];
    setChip('bad', e.status === 401 ? '● Token rejected — open Settings' : '● Not connected — open Settings');
    els.seasonSelect.innerHTML = '<option value="">Unavailable</option>';
  } finally {
    els.seasonSelect.disabled = false;
    updateSyncButton();
  }
}

function populateSeasonDropdown() {
  els.seasonSelect.innerHTML = '';
  if (!state.seasons.length) {
    els.seasonSelect.innerHTML = '<option value="">No seasons</option>';
    return;
  }
  // Default to the saved season if still present, else the server's currentSeasonId, else first.
  const savedId = Number(state.settings.seasonId) || null;
  const haveSaved = savedId && state.seasons.some((s) => s.id === savedId);
  const defaultId = haveSaved ? savedId : state.currentSeasonId || state.seasons[0].id;

  for (const s of state.seasons) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.name;
    if (s.id === defaultId) opt.selected = true;
    els.seasonSelect.appendChild(opt);
  }
  // Persist + apply the default's currentWeek if no week chosen yet.
  if (defaultId && String(defaultId) !== String(state.settings.seasonId)) {
    persist({ seasonId: String(defaultId) });
  }
  maybeAutofillWeek();
}

function selectedSeason() {
  const id = Number(els.seasonSelect.value);
  return state.seasons.find((s) => s.id === id) || null;
}

/* -------------------------------------------------------------------------- */
/* contest detection + week auto-fill                                          */
/* -------------------------------------------------------------------------- */

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

/** Parse the DK contest id from a gamecenter / draft contest URL. Returns '' if not found. */
function parseContestId(url) {
  if (!url) return '';
  const m =
    url.match(/draftkings\.com\/contest\/gamecenter\/(\d+)/i) ||
    url.match(/draftkings\.com\/draft\/contest\/(\d+)/i) ||
    url.match(/draftkings\.com\/[^?#]*\/contest\/(?:gamecenter\/)?(\d+)/i);
  return m ? m[1] : '';
}

/** Ask the content script for the contest name (no fetch). Resolves '' if unavailable. */
function requestDetect(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'DETECT_CONTEST' }, (response) => {
        if (chrome.runtime.lastError) return resolve('');
        resolve((response && response.contestName) || '');
      });
    } catch {
      resolve('');
    }
  });
}

/** Parse a trailing "#<number>" from a contest name → week number. Returns null if none. */
function weekFromContestName(name) {
  if (!name) return null;
  const m = String(name).match(/#\s*(\d{1,2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}

/** Read the active tab, detect a DK contest, and render the contest card. */
async function detectContest() {
  els.contestCard.classList.remove('detected');
  els.contestBody.textContent = 'Checking the active tab…';
  state.contest = null;

  const tab = await getActiveTab();
  const onDk = /^https:\/\/[^/]*draftkings\.com\//i.test((tab && tab.url) || '');
  const contestId = onDk ? parseContestId(tab.url) : '';

  if (!contestId) {
    els.contestBody.innerHTML =
      '<span class="prompt">Open your league’s DraftKings contest → <strong>Standings</strong> tab.</span>';
    updateSyncButton();
    return;
  }

  // Show the id immediately, then enrich with the contest name from the DOM.
  state.contest = { id: contestId, name: '' };
  renderContestCard();
  updateSyncButton();

  const name = tab.id ? await requestDetect(tab.id) : '';
  if (state.contest && state.contest.id === contestId) {
    state.contest.name = name || '';
    renderContestCard();
    maybeAutofillWeek();
  }
}

function renderContestCard() {
  if (!state.contest) return;
  els.contestCard.classList.add('detected');
  const name = state.contest.name;
  const nameHtml = name
    ? `<div class="contest-name">${escapeHtml(name)}</div>`
    : '<div class="contest-name">DraftKings contest</div>';
  els.contestBody.innerHTML = nameHtml + `<div class="contest-id">Contest ${escapeHtml(state.contest.id)}</div>`;
}

/**
 * Auto-fill the Week input (and the Preseason toggle). Priority:
 *   1. the app's answer from /api/current-week — derived from the synced NFL schedule, and the
 *      only source that knows BOTH the week and whether it is an exhibition one;
 *   2. a trailing "#N" parsed from the detected contest name;
 *   3. the selected season's currentWeek.
 *
 * 2 and 3 are fallbacks for when the app cannot answer, and both are known-unreliable — see
 * fetchWeekInfo. They can still offer a wrong week; renderWeekInfo is what surfaces that.
 *
 * Only runs when the user has not already typed a week this session (we treat an empty input or
 * the persisted value as "not user-touched"; user edits set a flag).
 */
function maybeAutofillWeek() {
  if (weekUserEdited) return;

  // The app's answer wins when we have one: it comes from the synced NFL schedule, which is
  // the only source that actually knows what week it is AND whether that week is preseason.
  const detected = state.weekInfo && state.weekInfo.detected;
  if (detected) {
    els.preseasonToggle.checked = Boolean(detected.isExhibition);
    els.week.max = String(maxWeekForMode());
    els.week.value = String(detected.inputWeek);
    updateSyncButton();
    renderWeekInfo();
    return;
  }

  // ---- fallbacks, used only when the app cannot say (no synced schedule, app unreachable) --

  // In preseason mode both hints are meaningless: a contest's trailing "#18" and the
  // season's currentWeek are regular-season numbers, and either would land outside the
  // 1–3 preseason range. Fall back to the saved preseason week, else 2 (the usual one).
  if (preseasonMode()) {
    const saved = Number(state.settings.week);
    const valid = Number.isInteger(saved) && saved >= 1 && saved <= MAX_PRESEASON_WEEK;
    els.week.value = String(valid ? saved : 2);
    updateSyncButton();
    renderWeekInfo();
    return;
  }

  const fromName = state.contest ? weekFromContestName(state.contest.name) : null;
  const season = selectedSeason();
  const fallback = season ? season.currentWeek : Number(state.settings.week) || null;
  const value = fromName != null ? fromName : fallback;
  if (value != null) {
    els.week.value = String(value);
  }
  updateSyncButton();
  renderWeekInfo();
}

/**
 * Load week info for the selected season and re-render.
 *
 * Called whenever the season or the typed week changes, so the date range always describes
 * the week that would actually be synced.
 */
async function refreshWeekInfo() {
  const season = selectedSeason();
  if (!season || !isConfigured()) {
    state.weekInfo = null;
    renderWeekInfo();
    return;
  }
  state.weekInfo = await fetchWeekInfo(season.id, currentWeek());
  maybeAutofillWeek();
  renderWeekInfo();
}

/**
 * Show the dates the selected week covers, and warn when it is not the week the schedule
 * says we are in.
 *
 * The warning exists because the failure is otherwise silent and destructive: `scores` upserts
 * on (owner, week), so syncing a contest against the wrong week overwrites that week's real
 * scores with no error at all.
 */
function renderWeekInfo() {
  const info = state.weekInfo;
  const week = currentWeek();
  if (!info || week == null) {
    els.weekInfo.textContent = '';
    return;
  }

  const lines = [];
  let warn = false;

  const range = info.requested && info.requested.week === week ? info.requested : null;
  if (range) {
    const dates = formatDateRange(range.firstKickoff, range.lastKickoff);
    lines.push(`${range.label}${dates ? ` · ${dates}` : ''} · ${range.gameCount} games`);
  } else {
    // No games stored for this week at all — either a typo, or the schedule isn't synced.
    lines.push(`${weekLabel(week)} — no NFL games found for this week.`);
    warn = true;
  }

  if (info.detected && info.detected.week !== week) {
    const d = info.detected;
    const dates = formatDateRange(d.firstKickoff, d.lastKickoff);
    lines.push(
      `⚠ The schedule says it is ${d.label}${dates ? ` (${dates})` : ''}. ` +
        'Syncing the wrong week overwrites that week’s scores.',
    );
    warn = true;
  }

  els.weekInfo.className = warn ? 'week-info warn' : 'week-info';
  els.weekInfo.textContent = lines.join('\n');
}

/** Apply preseason mode to the Week input + re-derive a sensible week for the new mode. */
function applyPreseasonMode() {
  els.week.max = String(maxWeekForMode());
  // The typed number means something different in each mode, so never carry it across
  // (a regular week 7 is not preseason week 7).
  weekUserEdited = false;
  maybeAutofillWeek();
}

let weekUserEdited = false;

/* -------------------------------------------------------------------------- */
/* sync button state                                                           */
/* -------------------------------------------------------------------------- */

/** True when the popup is in preseason (exhibition) mode. */
function preseasonMode() {
  return Boolean(els.preseasonToggle.checked);
}

/** Highest week the Week input accepts in the current mode. */
function maxWeekForMode() {
  return preseasonMode() ? MAX_PRESEASON_WEEK : MAX_REGULAR_WEEK;
}

/**
 * The week value to POST: the typed week, offset into the exhibition namespace when
 * preseason mode is on. Returns null when the input isn't valid for the current mode —
 * which is what disables the Sync button, so an out-of-range week can't be sent.
 */
function currentWeek() {
  const n = Number(els.week.value);
  if (!Number.isInteger(n) || n < 1 || n > maxWeekForMode()) return null;
  return preseasonMode() ? PRESEASON_WEEK_BASE + n : n;
}

/** Human label for a POSTed week, e.g. 102 → "Preseason Wk 2"; 7 → "Week 7". */
function weekLabel(week) {
  return week > PRESEASON_WEEK_BASE
    ? `Preseason Wk ${week - PRESEASON_WEEK_BASE}`
    : `Week ${week}`;
}

function updateSyncButton() {
  const week = currentWeek();
  els.syncLabel.textContent = week ? `Sync ${weekLabel(week)}` : 'Sync';
  const ready = !state.busy && isConfigured() && state.contest && selectedSeason() && week != null;
  els.syncBtn.disabled = !ready;
}

function setBusy(busy) {
  state.busy = busy;
  els.syncSpinner.hidden = !busy;
  els.seasonSelect.disabled = busy;
  els.week.disabled = busy;
  els.pasteBtn.disabled = busy;
  updateSyncButton();
}

/* -------------------------------------------------------------------------- */
/* POST to ingest (shape unchanged)                                            */
/* -------------------------------------------------------------------------- */

/**
 * POST JSON to an ingest endpoint with the bearer token.
 * Shared by the score sync (`/api/ingest/draftkings`) and the lineup capture
 * (`/api/ingest/lineups`), which authenticate identically.
 */
async function postIngestTo(path, payload) {
  const url = `${appBase()}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${state.settings.ingestToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(
      `Could not reach ${url}. Is the app running and is the URL allowed in host_permissions? (${e.message})`,
    );
  }

  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    // ALWAYS produce a message. An error page (a 404 from a deployment that predates the
    // endpoint, say) is HTML, so `res.json()` fails and `json` is null — and `statusText` is
    // an empty string over HTTP/2, which is what most hosts serve. Falling through to those
    // rendered "Saving failed —" with nothing after the dash: a failure that told the user
    // nothing at all. The status code is the one thing always worth saying.
    let msg = json && (json.error || (json.issues && JSON.stringify(json.issues)));
    if (!msg) msg = res.statusText ? `${res.statusText} (HTTP ${res.status})` : `HTTP ${res.status}`;
    if (res.status === 404) {
      msg += ` — ${url} does not exist. If the App Base URL points at a deployment, that ` +
        'version may predate this endpoint; try http://localhost:3000.';
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function postIngest(payload) {
  return postIngestTo('/api/ingest/draftkings', payload);
}

function renderSuccess(sent, json) {
  const unmatched = json.unmatched || [];
  const title = `✅ ${weekLabel(json.week)} synced — sent ${sent}, matched ${json.matched}, unmatched ${unmatched.length}`;
  const lines = [];
  if (typeof json.byes === 'number' && json.byes > 0) lines.push(`Byes: ${json.byes}`);
  if (unmatched.length) {
    lines.push('Unmatched DK names:');
    lines.push('• ' + unmatched.join('\n• '));
  }
  setResultBanner(title, lines, unmatched.length ? 'warn' : 'ok');

  // Persist + show "Last synced".
  const total = typeof json.total === 'number' ? json.total : sent;
  const lastSync = { week: json.week, time: Date.now(), matched: json.matched, total };
  persist({ lastSync });
  renderLastSynced();
}

function failBanner(err, sent) {
  const sentNote = `(captured ${sent} ${sent === 1 ? 'entry' : 'entries'} before the post)`;
  if (err.status === 401) {
    return setResultBanner('❌ 401 — check the Ingest Token in Settings', [sentNote], 'err');
  }
  if (err.status) {
    return setResultBanner(`❌ Server ${err.status}`, [err.message, sentNote], 'err');
  }
  return setResultBanner('❌ Sync failed', [err.message, sentNote], 'err');
}

function renderLastSynced() {
  const ls = state.settings.lastSync;
  if (!ls || !ls.week) {
    els.lastSynced.hidden = true;
    return;
  }
  const time = new Date(ls.time);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  els.lastSynced.hidden = false;
  els.lastSynced.textContent = `Last synced: ${weekLabel(ls.week)} · ${hh}:${mm} · matched ${ls.matched}/${ls.total}`;
}

/* -------------------------------------------------------------------------- */
/* capture bridge                                                              */
/* -------------------------------------------------------------------------- */

function requestCapture(tabId, contestId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_LEADERBOARD', contestId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            'Could not talk to the DraftKings page. Open a draftkings.com contest page and ' +
            'reload it, then retry. Detail: ' + chrome.runtime.lastError.message,
        });
        return;
      }
      resolve(response || { ok: false, error: 'No response from the DraftKings page.' });
    });
  });
}

/* -------------------------------------------------------------------------- */
/* roster-endpoint diagnosis (Phase 0 of live scoring)                         */
/* -------------------------------------------------------------------------- */

function requestProbe(tabId, contestId, entryKey) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: 'PROBE_ROSTER_ENDPOINT', contestId, entryKey },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error:
              'Could not talk to the DraftKings page. Open a contest gamecenter tab and ' +
              'reload it, then retry. Detail: ' + chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(response || { ok: false, error: 'No response from the DraftKings page.' });
      },
    );
  });
}

/**
 * Probe DK for a roster endpoint.
 *
 * Two ways this succeeds: a candidate template returns a parseable roster, OR every template
 * fails but the recorder shows what DK's own gamecenter requested. The second is the reliable
 * path — DK's UI has to call the real endpoint to draw a lineup.
 */
async function onProbe() {
  if (state.busy) return;

  const tab = await getActiveTab();
  const contestId = parseContestId((tab && tab.url) || '');
  if (!contestId) {
    els.probeResult.className = 'probe-result err';
    els.probeResult.textContent =
      'Open your league’s DraftKings contest gamecenter tab first, then retry.';
    return;
  }

  // An entry key makes the per-entry templates testable. The last sync stored them; without
  // one we still probe the bulk template and always collect recorder output.
  let entryKey = '';
  try {
    const keys = state.settings.lastEntryKeys;
    if (Array.isArray(keys) && keys.length) entryKey = String(keys[0]);
  } catch {
    // ignore — probing without an entry key is still useful
  }

  state.busy = true;
  els.probeBtn.disabled = true;
  els.probeSpinner.hidden = false;
  els.probeLabel.textContent = 'Probing…';
  els.probeResult.className = 'probe-result';
  els.probeResult.textContent = 'Trying candidate endpoints…';
  els.probeRaw.hidden = true;
  els.probeCopyBtn.hidden = true;

  const result = await requestProbe(tab.id, contestId, entryKey);

  state.busy = false;
  els.probeBtn.disabled = false;
  els.probeSpinner.hidden = true;
  els.probeLabel.textContent = 'Probe roster endpoint';

  renderProbeResult(result);
}

function renderProbeResult(result) {
  const lines = [];

  if (!result || result.ok === false) {
    els.probeResult.className = 'probe-result err';
    els.probeResult.textContent = (result && result.error) || 'Probe failed.';
  } else if (result.winner) {
    els.probeResult.className = 'probe-result ok';
    els.probeResult.innerHTML =
      '<strong>Found it.</strong> ' +
      escapeHtml(String(result.winner.rosterSlotCount)) +
      ' roster rows from:<br><code>' +
      escapeHtml(result.winner.template) +
      '</code>';
  } else {
    els.probeResult.className = 'probe-result warn';
    els.probeResult.innerHTML =
      '<strong>No template worked.</strong> Check the recorded DraftKings URLs below — ' +
      'click an entry in the gamecenter to load a lineup, then probe again.';
  }

  // Build a copy-pasteable report for docs/DRAFTKINGS.md.
  if (result && result.contestId) {
    lines.push('=== IDS ===');
    lines.push(`contestId    ${result.contestId}`);
    lines.push(`draftGroupId ${result.draftGroupId ?? '(unresolved)'}`);
    lines.push(`entryKey     ${result.entryKey ?? '(none — run a Sync first)'}`);
    lines.push('');
  }
  if (result && result.results) {
    lines.push('=== CANDIDATE TEMPLATES ===');
    for (const r of result.results) {
      if (r.skipped) {
        lines.push(`SKIP  ${r.template}\n      ${r.note}`);
      } else if (r.ok) {
        lines.push(`OK    HTTP ${r.status}  rosterRows=${r.rosterSlotCount}\n      ${r.template}`);
      } else {
        lines.push(
          `FAIL  HTTP ${r.status || '-'}  ${r.error || ''}\n      ${r.template}` +
            (r.body ? `\n      body: ${r.body}` : ''),
        );
      }
    }
  }
  if (result && result.winner) {
    lines.push('', '=== SAMPLE ROSTER ROWS ===', JSON.stringify(result.winner.sample, null, 2));
  }
  // Dump the raw payload of EVERY 200, not just a winner. A 200 that yielded zero roster rows
  // is the interesting case — it means the endpoint answered but our structural detector did
  // not recognise the shape, and only the payload can tell us why.
  if (result && result.results) {
    for (const r of result.results) {
      if (!r.ok || !r.rawPreview) continue;
      lines.push(
        '',
        `=== RAW PAYLOAD (truncated) — rosterRows=${r.rosterSlotCount} ===`,
        r.template,
        r.rawPreview,
      );
    }
  }
  if (result && result.recordedUrls && result.recordedUrls.length) {
    lines.push('', '=== api.draftkings.com URLs THIS PAGE REQUESTED ===');
    for (const r of result.recordedUrls) lines.push(`${r.method}  ${r.url}`);
  } else {
    lines.push('', '(no api.draftkings.com requests recorded — reload the gamecenter tab so the');
    lines.push('recorder is installed before the page loads, then click an entry and re-probe)');
  }

  els.probeRaw.value = lines.join('\n');
  els.probeRaw.hidden = false;
  els.probeCopyBtn.hidden = false;
}

/* -------------------------------------------------------------------------- */
/* (a) Sync (PRIMARY)                                                          */
/* -------------------------------------------------------------------------- */

async function onSync() {
  if (state.busy) return;
  clearBanner();

  if (!isConfigured()) {
    setResultBanner('❌ Not configured', ['Open Settings and set the App Base URL + Ingest Token.'], 'err');
    return;
  }
  const season = selectedSeason();
  const week = currentWeek();
  if (!season) return setResultBanner('❌ Pick a season.', [], 'err');
  if (week == null) return setResultBanner(`❌ Week must be 1–${maxWeekForMode()}.`, [], 'err');
  if (!state.contest) {
    return setResultBanner(
      '❌ No contest detected',
      ['Open your league’s DraftKings contest Standings tab and reopen this popup.'],
      'err',
    );
  }

  // Ensure host permission for the app origin (prompts once for deployed URLs). Must run early,
  // inside this click's user gesture, so chrome.permissions.request can show the prompt.
  const perm = await ensureOriginPermission(appBase());
  if (!perm.ok) {
    return setResultBanner('❌ Permission needed', [perm.error], 'err');
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id) return setResultBanner('❌ No active tab.', [], 'err');

  const contestId = state.contest.id;
  setBusy(true);
  setBanner(`Reading contest ${contestId} — leaderboard and lineups…`, 'info');

  // ONE leaderboard read serves both halves. `captureRosters` has to fetch the leaderboard
  // anyway to get entry keys, so it hands those rows back and the score sync reuses them
  // instead of asking DraftKings for the same page twice.
  const rosterCap = await requestRosterCapture(tab.id, contestId);

  // Roster capture is BEST EFFORT; the score sync is not. Scores are the official number that
  // settles the week, so a lineup failure must never block them — fall back to the plain
  // leaderboard read, which is the path that worked before lineups existed.
  const cap = rosterCap.ok
    ? { ok: true, contestId: rosterCap.contestId, entries: rosterCap.entries || [] }
    : await requestCapture(tab.id, contestId);

  if (!cap.ok) {
    setBusy(false);
    let title = '❌ Couldn’t read leaderboard — open the contest’s Standings tab and retry';
    if (cap.status === 401 || cap.status === 403) {
      title = `❌ DraftKings ${cap.status} — log in to DraftKings in this tab and retry`;
    }
    return setResultBanner(title, [cap.error], 'err');
  }

  const entries = cap.entries || [];

  // Stash a few entry keys. The roster-endpoint probe needs one to test the per-entry
  // templates, and DK's leaderboard is the only place they come from.
  try {
    const keys = entries.map((e) => e.entryKey).filter(Boolean).slice(0, 5);
    if (keys.length) persist({ lastEntryKeys: keys });
  } catch {
    // non-fatal — probing still works against the bulk template
  }

  if (!entries.length) {
    setBusy(false);
    return setResultBanner(
      '❌ Couldn’t read leaderboard — open the contest’s Standings tab and retry',
      ['Fetched the leaderboard but found 0 entries.'],
      'err',
    );
  }

  // If we learned the contest name during capture, update the card.
  if (cap.contestName && state.contest && state.contest.id === contestId && !state.contest.name) {
    state.contest.name = cap.contestName;
    renderContestCard();
  }

  setBanner(`Captured ${entries.length} entries from contest ${contestId}. Syncing ${weekLabel(week)}…`, 'info');

  const payload = {
    seasonId: season.id,
    week,
    contestId: cap.contestId || contestId,
    entries,
  };

  try {
    const json = await postIngest(payload);
    renderSuccess(entries.length, json);
    await persist({ seasonId: String(season.id), week: String(week) });
  } catch (e) {
    failBanner(e, entries.length);
  } finally {
    setBusy(false);
  }

  // Lineups go up AFTER scores, and their outcome is reported separately in the Lineups card.
  // Deliberate: scores settle the week, lineups only feed an estimate, so a roster problem
  // must be visible without casting doubt on a score sync that succeeded.
  if (rosterCap.ok) {
    await saveCapturedLineups(rosterCap, season, week, contestId);
  } else {
    setLineupsStatus(
      `Lineups not captured — ${rosterCap.error || 'unknown error'}\nScores were synced anyway.`,
      'err',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* (a2) Capture lineups (live scoring)                                         */
/* -------------------------------------------------------------------------- */
/*
 * The one authenticated step in live scoring. It records WHO each owner started; the running
 * score is computed server-side all week from public NFL stats, so nothing has to stay on.
 *
 * DraftKings has no bulk roster endpoint, so the page hook fans out one request per entry
 * (leaderboard → entry keys → N rosters, concurrency 4). Rosters are POSTed RAW — the server
 * owns the one tested normalizer.
 */

function requestRosterCapture(tabId, contestId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_ROSTERS', contestId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            'Could not talk to the DraftKings page. Open a draftkings.com contest page and ' +
            'reload it, then retry. Detail: ' + chrome.runtime.lastError.message,
        });
        return;
      }
      resolve(response || { ok: false, error: 'No response from the DraftKings page.' });
    });
  });
}

function setLineupsStatus(text, kind) {
  els.lineupsStatus.className = 'live-status' + (kind ? ` ${kind}` : '');
  els.lineupsStatus.textContent = text;
}

function renderLastCaptured() {
  const lc = state.settings.lastLineupCapture;
  if (!lc || !lc.week) {
    els.lastCaptured.hidden = true;
    return;
  }
  const time = new Date(lc.time);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  els.lastCaptured.hidden = false;
  els.lastCaptured.textContent =
    `Last capture: ${weekLabel(lc.week)} · ${hh}:${mm} · ` +
    `${lc.matched}/${lc.expected} lineups · ${lc.revealed}/${lc.slots} players revealed`;
}

/**
 * POST an already-fetched roster capture and report the outcome.
 *
 * Split from the fetching half so the one Sync button can do both halves off a single
 * DraftKings read: `captureRosters` returns the leaderboard rows AND the rosters, the scores
 * go up first, and this reports the lineup half separately.
 */
async function saveCapturedLineups(cap, season, week, contestId) {
  const captured = cap.lineups || [];
  const failures = cap.failures || [];
  const slots = captured.reduce((n, l) => n + (l.slotCount || 0), 0);
  const revealed = captured.reduce((n, l) => n + (l.revealedCount || 0), 0);

  setLineupsStatus(
    `Captured ${captured.length}/${cap.expected} lineups (${revealed}/${slots} players revealed). Saving…`,
  );

  const payload = {
    seasonId: season.id,
    week,
    contestId: cap.contestId || contestId,
    draftGroupId: cap.draftGroupId,
    capturedAt: cap.capturedAt,
    sourceUrlTemplate: cap.sourceUrlTemplate,
    rawLineups: captured.map((l) => ({
      entryName: l.entryName,
      entryKey: l.entryKey,
      roster: l.roster,
    })),
  };

  try {
    const json = await postIngestTo('/api/ingest/lineups', payload);
    const unmatched = json.unmatched || [];
    const lines = [
      `✅ ${weekLabel(week)} lineups saved — ${json.matched}/${cap.expected} owners.`,
      // Concealed players are EXPECTED before kickoff, not a failure: DK hides them from
      // opponents, and a player who has not played has scored nothing. Say so plainly so
      // "18/288 revealed" doesn't read as a broken capture.
      `${revealed} of ${slots} players revealed — the rest are still concealed until their game starts.`,
    ];
    if (json.enrichedSlots === 0 && revealed > 0) {
      lines.push('⚠ Teams could not be resolved from DraftKings’ public slate — re-run later.');
    }
    if (unmatched.length) lines.push(`Unmatched DK names: ${unmatched.join(', ')}`);
    if (failures.length) {
      lines.push(`Failed to read ${failures.length}: ${failures.map((f) => f.entryName).join(', ')}`);
    }
    if (cap.missingKeys && cap.missingKeys.length) {
      lines.push(`No entry key on the leaderboard for: ${cap.missingKeys.join(', ')}`);
    }
    setLineupsStatus(
      lines.join('\n'),
      unmatched.length || failures.length ? 'paused' : 'done',
    );

    await persist({
      lastLineupCapture: {
        week,
        time: Date.now(),
        matched: json.matched,
        expected: cap.expected,
        revealed,
        slots,
      },
      seasonId: String(season.id),
      week: String(week),
    });
    renderLastCaptured();
  } catch (e) {
    const detail = e.status === 401 ? 'Check the Ingest Token in Settings.' : e.message;
    setLineupsStatus(
      `❌ Saving failed — ${detail || 'no detail returned'}\n` +
        `Posted to ${appBase()}.\n` +
        `(captured ${captured.length} lineups before the post — the DraftKings half worked)`,
      'err',
    );
  }
  // No busy handling here: the Sync flow owns it and has already cleared it. Lineups report
  // into their own card so their outcome never overwrites the score result.
}

/* -------------------------------------------------------------------------- */
/* (b) Paste manually (fallback)                                               */
/* -------------------------------------------------------------------------- */

async function onPaste() {
  if (state.busy) return;
  clearBanner();

  if (!isConfigured()) {
    setResultBanner('❌ Not configured', ['Open Settings and set the App Base URL + Ingest Token.'], 'err');
    return;
  }
  const season = selectedSeason();
  const week = currentWeek();
  if (!season) return setResultBanner('❌ Pick a season.', [], 'err');
  if (week == null) return setResultBanner(`❌ Week must be 1–${maxWeekForMode()}.`, [], 'err');

  const text = els.pasteJson.value.trim();
  if (!text) return setResultBanner('❌ Paste some leaderboard JSON first.', [], 'err');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return setResultBanner('❌ That is not valid JSON', [e.message], 'err');
  }

  const entries = extractEntries(parsed);
  if (!entries.length) {
    return setResultBanner(
      '❌ Couldn’t find any leaderboard entries in that JSON',
      ['Paste the DK leaderboard response (full envelope, raw array, or {"entries":[...]}).'],
      'err',
    );
  }

  // Ensure host permission for the app origin before POSTing (prompts once for deployed URLs).
  const perm = await ensureOriginPermission(appBase());
  if (!perm.ok) {
    return setResultBanner('❌ Permission needed', [perm.error], 'err');
  }

  setBusy(true);
  setBanner(`Parsed ${entries.length} entries from pasted JSON. Syncing ${weekLabel(week)}…`, 'info');

  const payload = {
    seasonId: season.id,
    week,
    contestId: state.contest ? state.contest.id : undefined,
    entries,
  };

  try {
    const json = await postIngest(payload);
    renderSuccess(entries.length, json);
    await persist({ seasonId: String(season.id), week: String(week) });
  } catch (e) {
    failBanner(e, entries.length);
  } finally {
    setBusy(false);
  }
}

/* -------------------------------------------------------------------------- */
/* (c) Live Sync (background polling via the service worker)                    */
/* -------------------------------------------------------------------------- */
/*
 * The popup just configures + reflects state; the actual polling runs in background.js so it
 * keeps going after the popup closes. We send LIVE_START/LIVE_STOP messages and render the
 * persisted `liveSync` state, refreshing when the worker broadcasts LIVE_STATE_CHANGED.
 */

function sendBg(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function liveIntervalMinutes() {
  const n = Number(els.liveInterval.value);
  return Number.isInteger(n) && n >= 1 ? n : 5;
}

function fmtClock(ms) {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/** Render the Live Sync card from a persisted `liveSync` state object (or null). */
function renderLive(live) {
  const on = Boolean(live && live.on);
  els.liveToggle.checked = on;
  els.liveStopBtn.hidden = !on && !(live && live.phase === 'completed');

  if (live && live.intervalMinutes && !on) {
    els.liveInterval.value = String(live.intervalMinutes);
  }
  els.liveInterval.disabled = on;

  if (!live || (!on && live.phase !== 'completed')) {
    els.liveStatus.className = 'live-status';
    els.liveStatus.textContent =
      'Live Sync off — toggle on to keep scores updating during games.';
    return;
  }

  const ls = live.lastSync;
  const synced = ls
    ? `last synced ${weekLabel(ls.week)} at ${fmtClock(ls.time)}` +
      (typeof ls.matched === 'number' ? ` (${ls.matched} matched)` : '')
    : 'no sync yet';

  if (live.phase === 'completed') {
    els.liveStatus.className = 'live-status done';
    els.liveStatus.textContent = `✓ Completed — live sync stopped · ${synced}`;
    return;
  }
  if (live.phase === 'paused') {
    els.liveStatus.className = 'live-status paused';
    els.liveStatus.textContent = '⏸ Paused — open your DraftKings contest tab to resume.';
    return;
  }

  // running
  let next = '';
  if (live.nextRunAt && live.nextRunAt > Date.now()) {
    const mins = Math.max(1, Math.round((live.nextRunAt - Date.now()) / 60000));
    next = ` · next in ${mins}m`;
  }
  const errNote = live.lastError ? `\n⚠ ${live.lastError}` : '';
  els.liveStatus.className = 'live-status' + (live.lastError ? ' err' : ' on');
  els.liveStatus.textContent = `● Live: ${synced}${next}${errNote}`;
}

async function refreshLive() {
  const resp = await sendBg({ type: 'LIVE_GET_STATE' });
  renderLive(resp && resp.live);
}

async function onLiveToggle() {
  if (els.liveToggle.checked) {
    // Validate the same prerequisites Sync needs.
    if (!isConfigured()) {
      els.liveToggle.checked = false;
      return setResultBanner('❌ Not configured', ['Open Settings first.'], 'err');
    }
    const season = selectedSeason();
    const week = currentWeek();
    if (!season || week == null || !state.contest) {
      els.liveToggle.checked = false;
      return setResultBanner(
        '❌ Can’t start Live Sync',
        ['Detect a DK contest, pick a season, and set the week first.'],
        'err',
      );
    }
    // Ensure host permission for the app origin (within this gesture).
    const perm = await ensureOriginPermission(appBase());
    if (!perm.ok) {
      els.liveToggle.checked = false;
      return setResultBanner('❌ Permission needed', [perm.error], 'err');
    }

    const tab = await getActiveTab();
    const config = {
      intervalMinutes: liveIntervalMinutes(),
      seasonId: season.id,
      week,
      contestId: state.contest.id,
      tabId: tab && tab.id ? tab.id : null,
      appBaseUrl: appBase(),
      ingestToken: state.settings.ingestToken,
    };
    clearBanner();
    setBanner(`Live Sync starting — polling every ${config.intervalMinutes} min…`, 'info');
    const resp = await sendBg({ type: 'LIVE_START', config });
    renderLive(resp && resp.live);
  } else {
    const resp = await sendBg({ type: 'LIVE_STOP' });
    renderLive(resp && resp.live);
  }
}

async function onLiveStop() {
  const resp = await sendBg({ type: 'LIVE_STOP' });
  renderLive(resp && resp.live);
}

// The background worker broadcasts when state changes (a poll ran, paused, completed, etc.).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'LIVE_STATE_CHANGED') {
    refreshLive();
  }
  return undefined;
});

/* -------------------------------------------------------------------------- */
/* "Test connection" + Save (settings screen)                                  */
/* -------------------------------------------------------------------------- */

async function onTest() {
  const base = els.appBaseUrl.value.trim().replace(/\/+$/, '');
  const token = els.ingestToken.value.trim();
  if (!base) return setTestResult('checking', 'Set the App Base URL first.');
  if (!token) return setTestResult('checking', 'Set the Ingest Token first.');

  // Request host permission for this origin first so the GET can reach a deployed URL.
  const perm = await ensureOriginPermission(base);
  if (!perm.ok) return setTestResult('bad', `✗ ${perm.error}`);

  setTestResult('checking', 'Testing…');
  els.testBtn.disabled = true;
  try {
    const data = await fetchSeasons(base, token);
    const n = (data.seasons || []).length;
    setTestResult('ok', `✓ Connected — ${n} season${n === 1 ? '' : 's'} found`);
  } catch (e) {
    setTestResult('bad', `✗ ${e.message}`);
  } finally {
    els.testBtn.disabled = false;
  }
}

function setTestResult(kind, text) {
  els.testResult.textContent = text;
  els.testResult.className = 'test-result ' + kind;
}

async function onSave() {
  const appBaseUrl = els.appBaseUrl.value.trim().replace(/\/+$/, '');
  const ingestToken = els.ingestToken.value.trim();
  if (!appBaseUrl) return setTestResult('bad', 'Set the App Base URL.');
  if (!ingestToken) return setTestResult('bad', 'Set the Ingest Token.');

  // Request host permission for the app origin now (within this click) so the Main screen's
  // /api/seasons fetch reaches a deployed URL on first try. If denied, stay on Settings.
  const perm = await ensureOriginPermission(appBaseUrl);
  if (!perm.ok) return setTestResult('bad', `✗ ${perm.error}`);

  await persist({ appBaseUrl, ingestToken });
  showMain();
}

/* -------------------------------------------------------------------------- */
/* robust extractor (shared shape with page-hook.js) — paste path             */
/* -------------------------------------------------------------------------- */

const NAME_KEYS = [
  'userName',
  'user_name',
  'UserName',
  'displayName',
  'screenName',
  'entryName',
  'EntryName',
  'teamName',
  'draftGroupPlayerName',
];
const POINTS_KEYS = [
  'fantasyPoints',
  'fantasy_points',
  'FantasyPoints',
  'fantasyPointsTotal',
  'points',
  'Points',
  'score',
  'Score',
  'fpts',
];
const RANK_KEYS = ['rank', 'Rank', 'currentRank', 'standing'];
const ENTRY_KEY_KEYS = ['entryKey', 'entry_key', 'EntryKey', 'entryId', 'EntryId'];

function firstValue(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toOptionalInt(v) {
  const n = toNumber(v);
  return n === null ? undefined : Math.trunc(n);
}

function toOptionalString(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
}

function looksLikeEntry(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return firstValue(obj, NAME_KEYS) !== undefined && firstValue(obj, POINTS_KEYS) !== undefined;
}

function normalizeEntry(obj) {
  const name = toOptionalString(firstValue(obj, NAME_KEYS));
  const points = toNumber(firstValue(obj, POINTS_KEYS));
  if (!name || points === null) return null;
  const out = { entryName: name.trim(), points };
  const rank = toOptionalInt(firstValue(obj, RANK_KEYS));
  if (rank !== undefined) out.rank = rank;
  const entryKey = toOptionalString(firstValue(obj, ENTRY_KEY_KEYS));
  if (entryKey !== undefined) out.entryKey = entryKey;
  return out;
}

function collectEntries(value, depth, acc) {
  if (depth > 8 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (looksLikeEntry(item)) acc.push(item);
      else collectEntries(item, depth + 1, acc);
    }
    return;
  }
  const keys = Object.keys(value);
  const entryKeys = keys.filter((k) => looksLikeEntry(value[k]));
  if (entryKeys.length >= 2 && entryKeys.length >= keys.length / 2) {
    for (const k of entryKeys) acc.push(value[k]);
    return;
  }
  for (const k of keys) collectEntries(value[k], depth + 1, acc);
}

function extractEntries(envelope) {
  const raw = [];
  if (envelope && typeof envelope === 'object' && Array.isArray(envelope.entries)) {
    for (const e of envelope.entries) raw.push(e);
  }
  collectEntries(envelope, 0, raw);

  if (envelope && typeof envelope === 'object') {
    const leader = envelope.leader || envelope.Leader;
    if (looksLikeEntry(leader)) raw.push(leader);
  }

  const byKey = new Map();
  const byName = new Map();
  const out = [];
  for (const obj of raw) {
    const e = normalizeEntry(obj);
    if (!e) continue;
    const keyId = e.entryKey ? 'k:' + e.entryKey : null;
    const nameId = 'n:' + e.entryName.toLowerCase();
    if (keyId && byKey.has(keyId)) continue;
    if (!keyId && byName.has(nameId)) continue;
    if (keyId) byKey.set(keyId, e);
    byName.set(nameId, e);
    out.push(e);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* misc                                                                        */
/* -------------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------------- */
/* wire up                                                                     */
/* -------------------------------------------------------------------------- */

els.gearBtn.addEventListener('click', showSettings);
els.testBtn.addEventListener('click', onTest);
els.saveBtn.addEventListener('click', onSave);
els.syncBtn.addEventListener('click', onSync);
els.pasteBtn.addEventListener('click', onPaste);
els.liveToggle.addEventListener('change', onLiveToggle);
els.liveStopBtn.addEventListener('click', onLiveStop);

// Chip click → open Settings when not connected.
els.statusChip.addEventListener('click', () => {
  if (els.statusChip.classList.contains('bad')) showSettings();
});

els.seasonSelect.addEventListener('change', () => {
  const season = selectedSeason();
  if (season) persist({ seasonId: String(season.id) });
  maybeAutofillWeek();
  refreshWeekInfo();
});

els.week.addEventListener('input', () => {
  weekUserEdited = true;
  updateSyncButton();
  // Re-fetch so the dates describe the week actually typed — this is the moment a wrong
  // week is most likely to be entered, so it is the moment to show what it covers.
  refreshWeekInfo();
});

// Save the week on change so it survives reopen (until auto-fill overrides next open).
// Store the TYPED value, not the POSTed one — in preseason mode those differ by the offset,
// and persisting 102 would refill an input whose valid range is 1–3.
els.week.addEventListener('change', () => {
  if (currentWeek() != null) persist({ week: els.week.value });
});

els.preseasonToggle.addEventListener('change', () => {
  persist({ preseason: preseasonMode() });
  applyPreseasonMode();
  refreshWeekInfo();
});

// ---- roster-endpoint diagnosis ----
els.probeBtn.addEventListener('click', onProbe);

els.probeCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.probeRaw.value);
    els.probeCopyBtn.textContent = 'Copied ✓';
    setTimeout(() => {
      els.probeCopyBtn.textContent = 'Copy full result';
    }, 1500);
  } catch {
    // Clipboard can be blocked; the textarea is selectable as a fallback.
    els.probeRaw.select();
  }
});

// ---- init ----
(async function init() {
  await loadSettings();
  if (isConfigured()) {
    showMain();
  } else {
    showSettings();
  }
})();
