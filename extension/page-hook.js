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

  /* ==========================================================================
   * DraftKings request recorder (roster-endpoint discovery)
   *
   * DK's roster endpoint is not documented and every `scores/*` URL requires the user's
   * session, so it cannot be discovered from outside the browser. Rather than guess forever,
   * we watch what DK's OWN gamecenter asks for: whatever it calls to render a lineup IS the
   * right endpoint, by definition.
   *
   * HOW: PerformanceObserver over Resource Timing. This is a READ-ONLY browser API — it
   * observes requests the page makes without touching `window.fetch` or XMLHttpRequest.
   *
   * An earlier version wrapped `window.fetch` instead. Don't do that again: this file is
   * strict-mode, so when page code calls bare `fetch(url)` the wrapper receives
   * `this === undefined`, and native fetch rejects a non-Window receiver with
   * "Illegal invocation" — breaking every request the DraftKings SPA makes. Resource Timing
   * has no such failure mode, catches fetch AND XHR, and `buffered: true` replays requests
   * that happened before this script ran.
   *
   * Only URLs are recorded — never headers, bodies, or cookies. Resource Timing cannot see
   * those, which is another reason to prefer it.
   * ========================================================================== */
  const RECORDER_LIMIT = 200;
  const recordedUrls = [];

  function recordUrl(url, initiatorType) {
    try {
      const s = String(url);
      if (s.indexOf('api.draftkings.com') === -1) return;
      // Keep the newest occurrence only, so a polling SPA doesn't flood the list.
      const existing = recordedUrls.findIndex((r) => r.url === s);
      if (existing !== -1) recordedUrls.splice(existing, 1);
      recordedUrls.push({ url: s, method: initiatorType || 'resource', at: Date.now() });
      if (recordedUrls.length > RECORDER_LIMIT) recordedUrls.shift();
    } catch {
      // never let the recorder throw into page code
    }
  }

  try {
    if (typeof PerformanceObserver === 'function') {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) recordUrl(entry.name, entry.initiatorType);
      });
      // `buffered: true` delivers resource entries recorded before this observer existed.
      observer.observe({ type: 'resource', buffered: true });
    } else if (typeof performance !== 'undefined' && performance.getEntriesByType) {
      // Very old browsers: one-shot snapshot instead of live observation.
      for (const entry of performance.getEntriesByType('resource')) {
        recordUrl(entry.name, entry.initiatorType);
      }
    }
  } catch {
    // ignore — recording is best-effort and must never affect the page
  }

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

  /* ==========================================================================
   * Roster-endpoint probe
   *
   * Walks a list of candidate DK URLs and reports which one returns a parseable roster.
   * Today the winner is copied by hand out of the popup into docs/DRAFTKINGS.md §11. (Recording
   * it server-side on a `lineup_capture_runs` row is PLANNED — no such table exists yet.)
   *
   * Template 1 is the jackpot: if `embed=leaderboard,roster` works, all 32 lineups arrive in
   * ONE request instead of 32.
   * ========================================================================== */
  const ROSTER_TEMPLATES = [
    // CONFIRMED from DraftKings' own gamecenter traffic (captured by the recorder):
    //   scores/v2/entries/152064/5218553095?format=json&embed=roster
    // Note the first path segment is the DRAFT GROUP id, not the contest id — that is why
    // every contestId-based guess failed.
    'https://api.draftkings.com/scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster',
    // The bulk jackpot: all 32 lineups in one request. DK's own page requests this too, so it
    // is worth re-checking with the raw payload in hand even though a first pass found no
    // roster-shaped rows.
    'https://api.draftkings.com/scores/v1/leaderboards/{contestId}?format=json&embed=leaderboard,roster',
    'https://api.draftkings.com/scores/v1/entries/{draftGroupId}/{entryKey}?format=json&embed=roster',
    'https://api.draftkings.com/scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster,scorecard',
  ];

  /**
   * Resolve a contest id to its draft group id.
   *
   * `contests/v1/contests/{id}` is PUBLIC — it answers without a session (verified) — but we
   * call it from the page anyway so the probe needs no extra plumbing.
   */
  async function resolveDraftGroupId(contestId) {
    try {
      const res = await fetch(
        'https://api.draftkings.com/contests/v1/contests/' +
          encodeURIComponent(contestId) +
          '?format=json',
        { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return null;
      const body = await res.json();
      const dg = body && body.contestDetail && body.contestDetail.draftGroupId;
      return dg === undefined || dg === null ? null : String(dg);
    } catch {
      return null;
    }
  }

  // Field aliases for a drafted-player row. DK's shapes vary across endpoints/versions, so —
  // exactly like the leaderboard extractor — we identify rows structurally, not by path.
  const ROSTER_ID_KEYS = ['draftableId', 'DraftableId', 'playerId', 'PlayerId', 'playerDkId'];
  const ROSTER_SLOT_KEYS = [
    'rosterPosition',
    'RosterPosition',
    'rosterSlotName',
    'rosterSlotId',
    'position',
    'Position',
  ];
  const ROSTER_NAME_KEYS = ['displayName', 'DisplayName', 'playerName', 'fullName', 'name', 'Name'];

  /** Does this object look like one drafted player in a lineup? */
  function looksLikeRosterSlot(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const hasId = firstValue(obj, ROSTER_ID_KEYS) !== undefined;
    if (!hasId) return false;
    const hasSlot = firstValue(obj, ROSTER_SLOT_KEYS) !== undefined;
    const hasName = firstValue(obj, ROSTER_NAME_KEYS) !== undefined;
    return hasSlot || hasName;
  }

  /** Recursively count roster-slot-shaped objects anywhere in an envelope. */
  function collectRosterSlots(value, depth, acc) {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (looksLikeRosterSlot(item)) acc.push(item);
        else collectRosterSlots(item, depth + 1, acc);
      }
      return;
    }
    const keys = Object.keys(value);
    const slotKeys = keys.filter((k) => looksLikeRosterSlot(value[k]));
    if (slotKeys.length >= 2 && slotKeys.length >= keys.length / 2) {
      for (const k of slotKeys) acc.push(value[k]);
      return;
    }
    for (const k of keys) collectRosterSlots(value[k], depth + 1, acc);
  }

  /* ==========================================================================
   * Roster capture (live scoring)
   *
   * WHY ONE REQUEST PER ENTRY: DraftKings has no bulk roster endpoint. The obvious
   * `scores/v1/leaderboards/{contestId}?embed=leaderboard,roster` answers 200 with an EMPTY
   * `entryByEntryKey` map — it looks like it works and returns nothing. So we fan out over the
   * entry keys the leaderboard already gives us, at a deliberately unhurried pace.
   *
   * You do NOT have to click into anyone's lineup first. The entry keys come from the
   * leaderboard; the roster endpoint takes it from there.
   *
   * CONCEALMENT: DK hides a player until that player's game kicks off — those slots come back
   * as `draftableId: 0` with no name. That is not a partial capture. A concealed player has by
   * definition scored nothing, so no POINTS are ever missing from a capture; only names are,
   * and re-capturing later fills them in. Concealment tracks swappability exactly, which also
   * means anyone we CAN see is already locked and can no longer be swapped.
   * ========================================================================== */

  // Confirmed from DraftKings' own gamecenter traffic. First path segment is the DRAFT GROUP
  // id, not the contest id.
  const ROSTER_URL_TEMPLATE =
    'https://api.draftkings.com/scores/v2/entries/{draftGroupId}/{entryKey}?format=json&embed=roster';

  // Gentle by design: this is the commissioner's own session against their own contest, and
  // there is no deadline — the whole point of the feature is that scoring afterwards needs no
  // authentication at all.
  const ROSTER_CONCURRENCY = 4;
  const ROSTER_JITTER_MIN_MS = 150;
  const ROSTER_JITTER_MAX_MS = 300;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function rosterJitterMs() {
    return ROSTER_JITTER_MIN_MS + Math.random() * (ROSTER_JITTER_MAX_MS - ROSTER_JITTER_MIN_MS);
  }

  /**
   * Is this drafted-player row a real player, or a concealed placeholder?
   * Mirrors the server's rule in src/lib/lineups/normalize.ts: `draftableId: 0` means ABSENT,
   * not "player number zero".
   */
  function slotIsRevealed(obj) {
    const id = firstValue(obj, ROSTER_ID_KEYS);
    if (id !== undefined && String(id).trim() !== '' && String(id).trim() !== '0') return true;
    return firstValue(obj, ROSTER_NAME_KEYS) !== undefined;
  }

  /** Fetch one entry's roster. Never throws — a per-entry failure must not sink the capture. */
  async function fetchRoster(draftGroupId, entryKey) {
    const url = ROSTER_URL_TEMPLATE.replace(
      '{draftGroupId}',
      encodeURIComponent(draftGroupId),
    ).replace('{entryKey}', encodeURIComponent(entryKey));

    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
    } catch (e) {
      return { ok: false, error: 'Network error: ' + (e && e.message ? e.message : e) };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: 'DraftKings returned ' + res.status + '.' };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: res.status, error: 'Response was not JSON.' };
    }

    const slots = [];
    collectRosterSlots(body, 0, slots);
    if (!slots.length) {
      return { ok: false, status: res.status, error: 'No roster rows in the response.' };
    }
    return {
      ok: true,
      roster: body,
      slotCount: slots.length,
      revealedCount: slots.filter(slotIsRevealed).length,
    };
  }

  /**
   * Capture every entry's lineup for a contest.
   *
   * Rosters are returned RAW. Normalizing them is the server's job — there is one tested
   * normalizer there, run against a real captured payload, and a second copy here would be a
   * second thing to keep correct.
   */
  async function captureRosters(contestId) {
    const id = String(contestId || '').trim();
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: 'No valid contest id (could not parse it from the tab URL).' };
    }

    const draftGroupId = await resolveDraftGroupId(id);
    if (!draftGroupId) {
      return {
        ok: false,
        error:
          'Could not resolve the draft group id for contest ' +
          id +
          '. Open the contest gamecenter tab and retry.',
      };
    }

    // The leaderboard is where entry keys come from — the same fetch the weekly score sync
    // already does.
    const board = await capture(id);
    if (!board.ok) return board;

    const withKeys = board.entries.filter((e) => e.entryKey);
    const missingKeys = board.entries.filter((e) => !e.entryKey).map((e) => e.entryName);
    if (!withKeys.length) {
      return {
        ok: false,
        error:
          'The leaderboard returned ' +
          board.entries.length +
          ' entries but no entry keys, so no rosters can be requested.',
      };
    }

    // Stamped ONCE, before any request, and used for every roster in this batch. Late-swap
    // resolution compares this against each player's kickoff, so all nine slots of a lineup
    // must share one honest "as of" time.
    const capturedAt = new Date().toISOString();

    const lineups = [];
    const failures = [];
    let cursor = 0;

    async function worker() {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= withKeys.length) return;
        const entry = withKeys[i];
        await sleep(rosterJitterMs());
        const result = await fetchRoster(draftGroupId, entry.entryKey);
        if (result.ok) {
          lineups.push({
            entryName: entry.entryName,
            entryKey: entry.entryKey,
            roster: result.roster,
            slotCount: result.slotCount,
            revealedCount: result.revealedCount,
          });
        } else {
          failures.push({
            entryName: entry.entryName,
            entryKey: entry.entryKey,
            status: result.status,
            error: result.error,
          });
        }
      }
    }

    const pool = [];
    for (let i = 0; i < Math.min(ROSTER_CONCURRENCY, withKeys.length); i += 1) pool.push(worker());
    await Promise.all(pool);

    if (!lineups.length) {
      return {
        ok: false,
        error:
          'Fetched ' +
          withKeys.length +
          ' entries but every roster request failed. First error: ' +
          ((failures[0] && failures[0].error) || 'unknown'),
        failures,
      };
    }

    return {
      ok: true,
      contestId: id,
      draftGroupId,
      capturedAt,
      sourceUrlTemplate: ROSTER_URL_TEMPLATE,
      expected: board.entries.length,
      lineups,
      failures,
      missingKeys,
      // The leaderboard rows this capture already had to fetch, so the caller can sync SCORES
      // from the same read instead of asking DraftKings for the same page twice.
      entries: board.entries,
    };
  }

  /**
   * Try every candidate template and report what each one did.
   * Never throws — a probe is a diagnostic, so every failure mode is data.
   */
  async function probeRosterEndpoint(contestId, entryKey) {
    const id = String(contestId || '').trim();
    if (!/^\d+$/.test(id)) {
      return { ok: false, error: 'No valid contest id (could not parse it from the tab URL).' };
    }
    const key = String(entryKey || '').trim();
    const draftGroupId = await resolveDraftGroupId(id);

    const results = [];
    for (const template of ROSTER_TEMPLATES) {
      const needsEntryKey = template.indexOf('{entryKey}') !== -1;
      if (needsEntryKey && !key) {
        results.push({
          template,
          skipped: true,
          note: 'Needs an entry key — run a leaderboard sync first so entry keys are known.',
        });
        continue;
      }
      const needsDraftGroup = template.indexOf('{draftGroupId}') !== -1;
      if (needsDraftGroup && !draftGroupId) {
        results.push({
          template,
          skipped: true,
          note: 'Could not resolve the draft group id from contests/v1/contests/{contestId}.',
        });
        continue;
      }
      const url = template
        .replace('{contestId}', encodeURIComponent(id))
        .replace('{draftGroupId}', encodeURIComponent(draftGroupId || ''))
        .replace('{entryKey}', encodeURIComponent(key));

      let res;
      try {
        res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
      } catch (e) {
        results.push({ template, url, ok: false, error: 'Network error: ' + (e && e.message ? e.message : e) });
        continue;
      }

      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 300);
        } catch {
          // ignore
        }
        results.push({ template, url, ok: false, status: res.status, body });
        continue;
      }

      let envelope;
      try {
        envelope = await res.json();
      } catch {
        results.push({ template, url, ok: false, status: res.status, error: 'Response was not JSON.' });
        continue;
      }

      const slots = [];
      collectRosterSlots(envelope, 0, slots);
      results.push({
        template,
        url,
        ok: true,
        status: res.status,
        rosterSlotCount: slots.length,
        // A small sample so the shape can be read by eye and typed server-side.
        sample: slots.slice(0, 3),
        // Truncated raw payload for the diagnose panel.
        rawPreview: JSON.stringify(envelope).slice(0, 4000),
      });
    }

    const winner = results.find((r) => r.ok && r.rosterSlotCount > 0) || null;
    return {
      ok: true,
      contestId: id,
      draftGroupId: draftGroupId || null,
      entryKey: key || null,
      winner,
      results,
    };
  }

  // ---- bridge: answer the content script's capture-request -----------------
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG) return;

    // Roster-endpoint diagnosis: probe candidate URLs and hand back the recorded
    // api.draftkings.com traffic so the real endpoint can be identified either way.
    if (data.kind === 'probe-request') {
      probeRosterEndpoint(data.contestId, data.entryKey)
        .then((result) => {
          window.postMessage(
            {
              source: TAG,
              kind: 'probe-result',
              requestId: data.requestId,
              result: Object.assign({}, result, { recordedUrls: recordedUrls.slice(-60) }),
            },
            '*',
          );
        })
        .catch((e) => {
          window.postMessage(
            {
              source: TAG,
              kind: 'probe-result',
              requestId: data.requestId,
              result: {
                ok: false,
                error: 'Probe failed: ' + (e && e.message ? e.message : e),
                recordedUrls: recordedUrls.slice(-60),
              },
            },
            '*',
          );
        });
      return;
    }

    // Roster capture: leaderboard → entry keys → one authenticated roster request per entry.
    if (data.kind === 'roster-capture-request') {
      captureRosters(data.contestId)
        .then((result) => {
          window.postMessage(
            { source: TAG, kind: 'roster-capture-result', requestId: data.requestId, result },
            '*',
          );
        })
        .catch((e) => {
          window.postMessage(
            {
              source: TAG,
              kind: 'roster-capture-result',
              requestId: data.requestId,
              result: {
                ok: false,
                error: 'Roster capture failed: ' + (e && e.message ? e.message : e),
              },
            },
            '*',
          );
        });
      return;
    }

    if (data.kind !== 'capture-request') return;
    capture(data.contestId)
      .then((result) => {
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
      })
      // Without this, anything `capture` fails to swallow becomes an "Uncaught (in promise)"
      // in the page console AND leaves the popup hanging until its 20s timeout. Answer the
      // request instead, so the failure is reported where the user can see it.
      .catch((e) => {
        window.postMessage(
          {
            source: TAG,
            kind: 'capture-result',
            requestId: data.requestId,
            result: { ok: false, error: 'Capture failed: ' + (e && e.message ? e.message : e) },
          },
          '*',
        );
      });
  });

  // Expose the extractor on window so it can be reused (e.g. for testing). Harmless otherwise.
  try {
    window.__keylehrExtractEntries = extractEntries;
  } catch {
    // ignore
  }
})();
