/*
 * popup.js — the KeyLehr H2H — DraftKings Sync popup.
 *
 * Two-screen flow:
 *   • Settings screen — App Base URL + Ingest Token + "Test connection" (GET /api/seasons) + Save.
 *     Shown first-run (when unconfigured) or via the gear icon.
 *   • Main screen — a connection chip, the detected DK contest, a Season dropdown (from
 *     /api/seasons), an auto-filled Week, a big "Sync Week N" button, the result banner, a
 *     persistent "Last synced" line, and a tucked-away "Paste manually" fallback.
 *
 * Sync still POSTs normalized `entries` to <AppBaseURL>/api/ingest/draftkings with the bearer
 * token (POST shape unchanged). Two paths:
 *   (a) Sync (PRIMARY) — parse the contestId from the active DK contest tab URL, ask the content
 *       script to run a MAIN-world authenticated fetch of the DK embed leaderboard endpoint,
 *       receive ALL extracted entries, and POST them.
 *   (b) Paste manually (fallback) — user pastes the DK leaderboard JSON; the same robust
 *       extractor runs locally and the entries are POSTed.
 */

const DEFAULTS = {
  appBaseUrl: 'http://localhost:3000',
  ingestToken: '',
  seasonId: '',
  week: '',
  lastSync: null, // { week, time (ms), matched, total }
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
  syncBtn: document.getElementById('syncBtn'),
  syncSpinner: document.getElementById('syncSpinner'),
  syncLabel: document.getElementById('syncLabel'),
  status: document.getElementById('status'),
  lastSynced: document.getElementById('lastSynced'),
  pasteJson: document.getElementById('pasteJson'),
  pasteBtn: document.getElementById('pasteBtn'),
  // live sync
  liveToggle: document.getElementById('liveToggle'),
  liveInterval: document.getElementById('liveInterval'),
  liveStatus: document.getElementById('liveStatus'),
  liveStopBtn: document.getElementById('liveStopBtn'),
};

// In-memory popup state.
const state = {
  settings: { ...DEFAULTS },
  seasons: [], // [{ id, name, status, currentWeek, regularSeasonWeeks }]
  currentSeasonId: null,
  contest: null, // { id, name } when a DK contest is detected in the active tab
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
        lastSync: s.lastSync || null,
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
  renderLastSynced();
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
 * Auto-fill the Week input. Priority:
 *   1. trailing "#N" parsed from the detected contest name,
 *   2. the selected season's currentWeek,
 * but only when the user has not already typed a week this session (we treat an empty input or
 * the persisted value as "not user-touched"; user edits set a flag).
 */
function maybeAutofillWeek() {
  if (weekUserEdited) return;
  const fromName = state.contest ? weekFromContestName(state.contest.name) : null;
  const season = selectedSeason();
  const fallback = season ? season.currentWeek : Number(state.settings.week) || null;
  const value = fromName != null ? fromName : fallback;
  if (value != null) {
    els.week.value = String(value);
  }
  updateSyncButton();
}

let weekUserEdited = false;

/* -------------------------------------------------------------------------- */
/* sync button state                                                           */
/* -------------------------------------------------------------------------- */

function currentWeek() {
  const n = Number(els.week.value);
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}

function updateSyncButton() {
  const week = currentWeek();
  els.syncLabel.textContent = week ? `Sync Week ${week}` : 'Sync';
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

async function postIngest(payload) {
  const url = `${appBase()}/api/ingest/draftkings`;
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
    const msg = (json && (json.error || JSON.stringify(json.issues))) || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

function renderSuccess(sent, json) {
  const unmatched = json.unmatched || [];
  const title = `✅ Week ${json.week} synced — sent ${sent}, matched ${json.matched}, unmatched ${unmatched.length}`;
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
  els.lastSynced.textContent = `Last synced: Week ${ls.week} · ${hh}:${mm} · matched ${ls.matched}/${ls.total}`;
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
  if (week == null) return setResultBanner('❌ Week must be 1–25.', [], 'err');
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
  setBanner(`Fetching the full leaderboard for contest ${contestId}…`, 'info');

  const cap = await requestCapture(tab.id, contestId);

  if (!cap.ok) {
    setBusy(false);
    let title = '❌ Couldn’t read leaderboard — open the contest’s Standings tab and retry';
    if (cap.status === 401 || cap.status === 403) {
      title = `❌ DraftKings ${cap.status} — log in to DraftKings in this tab and retry`;
    }
    return setResultBanner(title, [cap.error], 'err');
  }

  const entries = cap.entries || [];
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

  setBanner(`Captured ${entries.length} entries from contest ${contestId}. Syncing Week ${week}…`, 'info');

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
  if (week == null) return setResultBanner('❌ Week must be 1–25.', [], 'err');

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
  setBanner(`Parsed ${entries.length} entries from pasted JSON. Syncing Week ${week}…`, 'info');

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
    ? `last synced Week ${ls.week} at ${fmtClock(ls.time)}` +
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
});

els.week.addEventListener('input', () => {
  weekUserEdited = true;
  updateSyncButton();
});

// Save the week on change so it survives reopen (until auto-fill overrides next open).
els.week.addEventListener('change', () => {
  const w = currentWeek();
  if (w != null) persist({ week: String(w) });
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
