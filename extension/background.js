/*
 * background.js — MV3 service worker for Live Sync (background polling).
 *
 * WHAT THIS DOES
 *   The popup's one-click "Capture & Sync" is unchanged (popup → content-script → page-hook).
 *   This worker adds an OPTIONAL "Live Sync" mode: a chrome.alarms timer that re-runs the same
 *   capture+POST every N minutes so scores keep updating during games even after the popup is
 *   closed (as long as Chrome is running). It STOPS automatically when the contest is completed.
 *
 * WHY A SERVICE-WORKER FETCH ISN'T ENOUGH
 *   The DK leaderboard endpoint needs the user's authenticated DK session. Only a fetch issued
 *   from the draftkings.com PAGE context (MAIN world) reliably carries the session cookies
 *   (SameSite). A bare service-worker fetch would NOT. So each poll uses
 *   chrome.scripting.executeScript({ world: 'MAIN' }) to run the credentialed fetch + extract
 *   INSIDE an open DK contest tab, then this worker POSTs the result to the ingest API.
 *   => Live Sync REQUIRES an open DK contest tab. If none is found, we pause and notify.
 *
 * SLEEP-HONEST
 *   chrome.alarms only fire while Chrome is awake and running. If the computer sleeps or Chrome
 *   closes, the alarm pauses and resumes when awake. That is the accepted tradeoff for the
 *   no-stored-credentials model (the credentialed fetch must run in YOUR browser session).
 */

'use strict';

const ALARM_NAME = 'keylehr-live-sync';
const STORAGE_KEY = 'liveSync';
const DK_TAB_GLOB = 'https://*.draftkings.com/contest/gamecenter/*';

/* -------------------------------------------------------------------------- */
/* live-sync state (persisted in chrome.storage.local under `liveSync`)        */
/* -------------------------------------------------------------------------- */
/*
 * liveSync = {
 *   on: boolean,            // is live sync enabled
 *   intervalMinutes: num,   // poll cadence (>=1)
 *   seasonId: number,       // app season id to POST
 *   week: number,           // app week to POST
 *   contestId: string,      // DK contest id
 *   tabId: number|null,     // preferred DK tab id (best-effort; we re-find if gone)
 *   appBaseUrl: string,     // app origin (no trailing slash)
 *   ingestToken: string,    // bearer token
 *   phase: 'running'|'paused'|'completed'|'off',
 *   lastSync: { week, time, matched, total } | null,
 *   lastError: string | null,
 *   nextRunAt: number | null, // ms epoch of the next scheduled alarm
 * }
 */

function getLive() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (s) => resolve((s && s[STORAGE_KEY]) || null));
  });
}

function setLive(partial) {
  return getLive().then(
    (cur) =>
      new Promise((resolve) => {
        const next = Object.assign({}, cur || {}, partial);
        chrome.storage.local.set({ [STORAGE_KEY]: next }, () => resolve(next));
      }),
  );
}

/* -------------------------------------------------------------------------- */
/* badge + notifications                                                       */
/* -------------------------------------------------------------------------- */

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    // action API not available in some contexts — ignore.
  }
}

function notify(title, message) {
  try {
    // chrome.notifications requires the "notifications" permission to show a toast; we keep
    // permissions minimal, so this is a no-op if absent. The badge is the always-on signal.
    if (chrome.notifications && chrome.notifications.create) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
      });
    }
  } catch {
    // ignore
  }
}

/** Tell any open popup that state changed (best-effort; ignored if no popup listening). */
function broadcastState() {
  try {
    chrome.runtime.sendMessage({ type: 'LIVE_STATE_CHANGED' }, () => void chrome.runtime.lastError);
  } catch {
    // ignore
  }
}

/* -------------------------------------------------------------------------- */
/* the in-page capture: runs in the DK tab's MAIN world via executeScript      */
/* -------------------------------------------------------------------------- */
/*
 * This function is SERIALIZED and injected into the DK page (MAIN world). It must be fully
 * self-contained (no closures over this file). It mirrors page-hook.js's authenticated fetch +
 * robust extractor, and ADDITIONALLY computes a `completed` signal from the leaderboard data so
 * the worker can auto-stop when the contest is final.
 *
 * Returns: { ok, contestId, entries, completed } or { ok:false, status?, error }.
 */
function dkCaptureInPage(contestId) {
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
  // Fields DK uses for "points/minutes remaining" — when ALL entries show 0/absent, the contest
  // is over (no live scoring left). `pmr` = "players minutes remaining".
  const REMAINING_KEYS = [
    'pmr',
    'PMR',
    'timeRemaining',
    'TimeRemaining',
    'minutesRemaining',
    'pointsRemaining',
    'remaining',
  ];

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
    // Keep a per-entry "remaining" hint for completion detection (not POSTed).
    const rem = toNumber(firstValue(obj, REMAINING_KEYS));
    out.__remaining = rem; // number or null (null = field absent)
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

  // Completion: prefer an explicit contest status field; else fall back to "no time remaining for
  // any entry". A `null` remaining (field absent) does NOT by itself prove completion — we only
  // declare completed via remaining when at least one entry actually carried a numeric remaining
  // field and EVERY such field is 0.
  function statusSaysCompleted(envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    const candidates = [];
    const stack = [envelope];
    let guard = 0;
    while (stack.length && guard < 200) {
      guard++;
      const v = stack.pop();
      if (!v || typeof v !== 'object') continue;
      for (const k of Object.keys(v)) {
        const val = v[k];
        if (
          /(^|_)(contest)?status$|gameSetStatus|contestState/i.test(k) &&
          (typeof val === 'string' || typeof val === 'number')
        ) {
          candidates.push(String(val).toLowerCase());
        } else if (val && typeof val === 'object' && stack.length < 100) {
          stack.push(val);
        }
      }
    }
    return candidates.some((s) => /complete|completed|final|finished|closed/.test(s));
  }

  function computeCompleted(envelope, entries) {
    if (statusSaysCompleted(envelope)) return true;
    if (!entries.length) return false;
    let sawNumericRemaining = false;
    let allZero = true;
    for (const e of entries) {
      const r = e.__remaining;
      if (typeof r === 'number') {
        sawNumericRemaining = true;
        if (r > 0) allZero = false;
      }
    }
    return sawNumericRemaining && allZero;
  }

  const id = String(contestId || '').trim();
  if (!/^\d+$/.test(id)) {
    return Promise.resolve({
      ok: false,
      error: 'No valid contest id (could not parse it from the tab URL).',
    });
  }
  const url =
    'https://api.draftkings.com/scores/v1/leaderboards/' +
    encodeURIComponent(id) +
    '?format=json&embed=leaderboard';

  return fetch(url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } })
    .then((res) => {
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error:
            'DraftKings returned ' +
            res.status +
            (res.status === 401 || res.status === 403
              ? ' — make sure you are logged in to DraftKings in this tab.'
              : '.'),
        };
      }
      return res.json().then((envelope) => {
        const entries = extractEntries(envelope);
        if (!entries.length) {
          return { ok: false, error: 'Fetched the leaderboard but found no entries.' };
        }
        const completed = computeCompleted(envelope, entries);
        // Strip the internal hint before returning across the executeScript boundary.
        const clean = entries.map((e) => {
          const o = { entryName: e.entryName, points: e.points };
          if (e.rank !== undefined) o.rank = e.rank;
          if (e.entryKey !== undefined) o.entryKey = e.entryKey;
          return o;
        });
        return { ok: true, contestId: id, entries: clean, completed };
      });
    })
    .catch((e) => ({
      ok: false,
      error: 'Network error fetching the DK leaderboard: ' + (e && e.message ? e.message : e),
    }));
}

/* -------------------------------------------------------------------------- */
/* finding the DK contest tab                                                  */
/* -------------------------------------------------------------------------- */

function queryTabs(queryInfo) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => resolve(tabs || []));
    } catch {
      resolve([]);
    }
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (!tabId) return resolve(null);
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(tab || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function isGamecenterUrl(url) {
  return /^https:\/\/[^/]*draftkings\.com\/contest\/gamecenter\/\d+/i.test(url || '');
}

/**
 * Locate an open DK contest tab. Prefer the stored tabId (if it's still a gamecenter tab),
 * else find any gamecenter tab. Returns a tab object or null.
 */
async function findDkTab(live) {
  if (live && live.tabId) {
    const t = await getTab(live.tabId);
    if (t && isGamecenterUrl(t.url)) return t;
  }
  const tabs = await queryTabs({ url: DK_TAB_GLOB });
  if (tabs.length) return tabs[0];
  return null;
}

/* -------------------------------------------------------------------------- */
/* POST to ingest                                                              */
/* -------------------------------------------------------------------------- */

async function postIngest(live, entries) {
  const base = (live.appBaseUrl || '').replace(/\/+$/, '');
  const url = `${base}/api/ingest/draftkings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${live.ingestToken}`,
    },
    body: JSON.stringify({
      seasonId: live.seasonId,
      week: live.week,
      contestId: live.contestId,
      entries,
    }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json && (json.error || (json.issues && JSON.stringify(json.issues)))) || res.statusText;
    const err = new Error(msg || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json || {};
}

/* -------------------------------------------------------------------------- */
/* the poll                                                                    */
/* -------------------------------------------------------------------------- */

function runInPage(tabId, contestId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId },
          world: 'MAIN',
          func: dkCaptureInPage,
          args: [String(contestId)],
        },
        (results) => {
          if (chrome.runtime.lastError) {
            return resolve({
              ok: false,
              error: 'Could not run capture in the DK tab: ' + chrome.runtime.lastError.message,
            });
          }
          const out = results && results[0] && results[0].result;
          resolve(out || { ok: false, error: 'No result from the DK tab.' });
        },
      );
    } catch (e) {
      resolve({ ok: false, error: 'executeScript failed: ' + (e && e.message ? e.message : e) });
    }
  });
}

async function scheduleNext(live) {
  const minutes = Math.max(1, Number(live.intervalMinutes) || 5);
  const nextRunAt = Date.now() + minutes * 60 * 1000;
  await chrome.alarms.create(ALARM_NAME, { when: nextRunAt });
  return nextRunAt;
}

/** Run one live-sync poll. `opts.final` marks this as the final sync after completion. */
async function doPoll() {
  let live = await getLive();
  if (!live || !live.on) {
    setBadge('');
    return;
  }

  const tab = await findDkTab(live);
  if (!tab || !tab.id) {
    live = await setLive({
      phase: 'paused',
      lastError: 'No open DraftKings contest tab found.',
      nextRunAt: await scheduleNext(live), // keep trying — they may open the tab
    });
    setBadge('⏸', '#f59e0b');
    notify('Live Sync paused', 'Open your DraftKings contest Standings tab to keep syncing.');
    broadcastState();
    return;
  }

  // Remember the working tab id for next time.
  if (tab.id !== live.tabId) live = await setLive({ tabId: tab.id });

  const cap = await runInPage(tab.id, live.contestId);

  if (!cap || !cap.ok) {
    live = await setLive({
      phase: 'running',
      lastError: (cap && cap.error) || 'Capture failed.',
      nextRunAt: await scheduleNext(live),
    });
    setBadge('!', '#f87171');
    broadcastState();
    return;
  }

  const entries = cap.entries || [];
  const completed = Boolean(cap.completed);

  // POST the captured entries.
  let matched = null;
  let total = entries.length;
  try {
    const json = await postIngest(live, entries);
    matched = typeof json.matched === 'number' ? json.matched : null;
    total = typeof json.total === 'number' ? json.total : entries.length;
  } catch (e) {
    // POST failed — keep running (transient app/network issues shouldn't kill live sync) unless
    // the contest is completed, in which case we still stop after recording the error.
    live = await setLive({
      phase: completed ? 'completed' : 'running',
      lastError: `Ingest POST failed: ${e.message}`,
      nextRunAt: completed ? null : await scheduleNext(live),
    });
    if (completed) {
      live = await setLive({ on: false });
      await chrome.alarms.clear(ALARM_NAME);
      setBadge('✓', '#22c55e');
    } else {
      setBadge('!', '#f87171');
    }
    broadcastState();
    return;
  }

  const lastSync = { week: live.week, time: Date.now(), matched, total };

  if (completed) {
    // Final sync done — stop the loop.
    await chrome.alarms.clear(ALARM_NAME);
    await setLive({
      on: false,
      phase: 'completed',
      lastSync,
      lastError: null,
      nextRunAt: null,
    });
    setBadge('✓', '#22c55e');
    notify('Live Sync complete', `Contest completed — final scores synced for Week ${live.week}.`);
    broadcastState();
    return;
  }

  // Still live — schedule the next poll.
  const nextRunAt = await scheduleNext(live);
  await setLive({ phase: 'running', lastSync, lastError: null, nextRunAt });
  setBadge('live', '#22c55e');
  broadcastState();
}

/* -------------------------------------------------------------------------- */
/* start / stop                                                                */
/* -------------------------------------------------------------------------- */

async function startLive(config) {
  const minutes = Math.max(1, Number(config.intervalMinutes) || 5);
  const live = await setLive({
    on: true,
    intervalMinutes: minutes,
    seasonId: config.seasonId,
    week: config.week,
    contestId: String(config.contestId),
    tabId: config.tabId || null,
    appBaseUrl: (config.appBaseUrl || '').replace(/\/+$/, ''),
    ingestToken: config.ingestToken || '',
    phase: 'running',
    lastError: null,
    nextRunAt: Date.now(),
  });
  setBadge('live', '#22c55e');
  broadcastState();
  // Run immediately, then the poll re-schedules the alarm.
  await doPoll();
  return live;
}

async function stopLive() {
  await chrome.alarms.clear(ALARM_NAME);
  const live = await setLive({ on: false, phase: 'off', nextRunAt: null });
  setBadge('');
  broadcastState();
  return live;
}

/* -------------------------------------------------------------------------- */
/* wiring                                                                      */
/* -------------------------------------------------------------------------- */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) {
    doPoll();
  }
});

// Restore the badge when the worker spins up (e.g. after Chrome restart). The alarm itself
// survives restarts; this just re-syncs the badge to the persisted phase.
async function restoreBadge() {
  const live = await getLive();
  if (!live || !live.on) {
    if (live && live.phase === 'completed') setBadge('✓', '#22c55e');
    else setBadge('');
    return;
  }
  if (live.phase === 'paused') setBadge('⏸', '#f59e0b');
  else setBadge('live', '#22c55e');
}

chrome.runtime.onStartup.addListener(restoreBadge);
chrome.runtime.onInstalled.addListener(restoreBadge);

// Messages from the popup.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;

  if (msg.type === 'LIVE_START') {
    startLive(msg.config || {}).then((live) => sendResponse({ ok: true, live }));
    return true;
  }
  if (msg.type === 'LIVE_STOP') {
    stopLive().then((live) => sendResponse({ ok: true, live }));
    return true;
  }
  if (msg.type === 'LIVE_GET_STATE') {
    getLive().then((live) => sendResponse({ ok: true, live }));
    return true;
  }
  if (msg.type === 'LIVE_POLL_NOW') {
    doPoll().then(() => getLive().then((live) => sendResponse({ ok: true, live })));
    return true;
  }
  return undefined;
});
