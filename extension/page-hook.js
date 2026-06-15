/*
 * page-hook.js — runs in the PAGE's MAIN world (injected by content-script.js).
 *
 * It performs the authenticated leaderboard fetch and extracts ALL entries.
 *
 * THE ENDPOINT (essential):
 *   https://api.draftkings.com/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard
 *   The `&embed=leaderboard` param is REQUIRED — without it DK returns only the single `leader`
 *   entry (that was the 1-of-32 bug). We must NOT use the no-embed v1 path or any v2 path.
 *
 * WHY HERE: this endpoint needs the user's authenticated DK session. A fetch issued from the
 *   draftkings.com page context (MAIN world) carries the browser's DK cookies via
 *   credentials:'include'; a fetch from the popup/background would not.
 *
 * This script must NOT touch chrome.* APIs (the page world has none). It communicates with the
 * content script only via tagged window.postMessage.
 */
(function () {
  'use strict';

  const TAG = 'KEYLEHR_DK_SYNC';

  // ---- per-entry field aliases ---------------------------------------------
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

  /** Does this object look like a per-entry leaderboard row (has a name AND points)? */
  function looksLikeEntry(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const name = firstValue(obj, NAME_KEYS);
    const points = firstValue(obj, POINTS_KEYS);
    return name !== undefined && points !== undefined;
  }

  /** Normalize a raw DK entry object to our { entryName, points, rank?, entryKey? } shape. */
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

  /**
   * Recursively collect every entry-looking object anywhere in the parsed envelope.
   *
   * DK's embed response nests the entries under different shapes across endpoints/versions:
   *   - `leaderBoard` (array of entries)
   *   - `leaderBoardUserEntries.entryByEntryKey` (object keyed by entryKey → entry)
   *   - other arrays/objects of entry objects.
   * Rather than hardcode one path, we walk the whole tree (depth-limited) and gather any object
   * that has both a name-ish and points-ish field. Works for arrays AND keyed-object maps.
   */
  function collectEntries(value, depth, acc) {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (looksLikeEntry(item)) acc.push(item);
        else collectEntries(item, depth + 1, acc);
      }
      return;
    }
    // An object: it could be a keyed MAP of entries (e.g. entryByEntryKey), or a container that
    // merely holds a stray single entry like the top-level `leader`. Only treat it as a map of
    // entries when MOST of its values are entries (>= 2 and a majority); otherwise keep descending
    // so a lone `leader` sibling doesn't short-circuit the real leaderboard array/map.
    const keys = Object.keys(value);
    const entryKeys = keys.filter((k) => looksLikeEntry(value[k]));
    if (entryKeys.length >= 2 && entryKeys.length >= keys.length / 2) {
      for (const k of entryKeys) acc.push(value[k]);
      return;
    }
    for (const k of keys) collectEntries(value[k], depth + 1, acc);
  }

  /**
   * Extract a normalized, de-duped entry list from a parsed DK envelope.
   * Also includes the top-level `leader` object as a fallback single entry.
   * De-dupes by entryKey, then by lowercased name.
   */
  function extractEntries(envelope) {
    const raw = [];
    collectEntries(envelope, 0, raw);

    // Fallback: keep the top-level single `leader` entry if present (covers no-embed responses
    // and guarantees we always surface at least the leader).
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

  // ---- the authenticated capture -------------------------------------------
  async function capture(contestId) {
    const id = String(contestId || '').trim();
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: 'No valid contest id (could not parse it from the tab URL).' };
    }

    const url =
      'https://api.draftkings.com/scores/v1/leaderboards/' +
      encodeURIComponent(id) +
      '?format=json&embed=leaderboard';

    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      return {
        ok: false,
        error: 'Network error fetching the DK leaderboard: ' + (e && e.message ? e.message : e),
      };
    }

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

    let envelope;
    try {
      envelope = await res.json();
    } catch {
      return { ok: false, error: 'DraftKings response was not valid JSON.' };
    }

    const entries = extractEntries(envelope);
    if (!entries.length) {
      return {
        ok: false,
        error:
          'Fetched the leaderboard but found no entries. Open the contest Standings tab and retry.',
      };
    }
    return { ok: true, url, contestId: id, entries };
  }

  // ---- bridge: answer the content script's capture-request -----------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG || data.kind !== 'capture-request') return;
    capture(data.contestId).then((result) => {
      try {
        window.postMessage(
          { source: TAG, kind: 'capture-result', requestId: data.requestId, result },
          '*',
        );
      } catch {
        window.postMessage(
          {
            source: TAG,
            kind: 'capture-result',
            requestId: data.requestId,
            result: { ok: false, error: 'Could not serialize the capture result.' },
          },
          '*',
        );
      }
    });
  });

  // Expose the extractor on window so it can be reused (e.g. for testing). Harmless otherwise.
  try {
    window.__keylehrExtractEntries = extractEntries;
  } catch {
    // ignore
  }
})();
