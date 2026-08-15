/*
 * content-script.js — ISOLATED world, runs on https://*.draftkings.com/* at document_start.
 *
 * Responsibilities:
 *   1. Inject page-hook.js into the page's MAIN world. The hook exposes a function that performs
 *      an authenticated fetch of the DK embed leaderboard endpoint (so the browser's DK session
 *      cookies are sent) and posts the result back via window.postMessage.
 *   2. Bridge the popup's CAPTURE_LEADERBOARD request → page-hook fetch → response, by relaying
 *      a tagged window.postMessage round-trip.
 *
 * Why the fetch must happen in the page (MAIN world) and not here / the popup:
 *   The embed endpoint (https://api.draftkings.com/scores/v1/leaderboards/{id}?format=json&embed=leaderboard)
 *   requires the user's authenticated DK session. Only a fetch issued from the draftkings.com
 *   page context reliably carries those cookies. The isolated content-script world and the
 *   popup/background do not.
 */
(function () {
  'use strict';

  const TAG = 'KEYLEHR_DK_SYNC';

  // ---- 1. inject the MAIN-world hook ---------------------------------------
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-hook.js');
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  } catch {
    // If injection fails the popup will report a capture failure and the paste path still works.
  }

  // ---- 1b. read the contest name from the gamecenter DOM -------------------
  // Best-effort: DK's gamecenter header shows the contest title (e.g. "KeyLehr H2H #18").
  // We probe a few likely selectors and fall back to the document title, then strip DK's
  // boilerplate suffix. Returns '' when nothing usable is found (never throws).
  function readContestName() {
    try {
      const selectors = [
        '[data-testid="contest-name"]',
        '[data-test-id="contest-name"]',
        '[class*="ContestName"]',
        '[class*="contest-name"]',
        '[class*="contestName"]',
        '[class*="GameCenterHeader"] h1',
        '.gamecenter-header h1',
        'header h1',
        'h1',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el && el.textContent ? el.textContent.trim() : '';
        if (text && text.length <= 200) return text;
      }
      // Fallback: the page title, minus DK's "| DraftKings" style suffix.
      const title = (document.title || '').replace(/\s*[|—-]\s*DraftKings.*$/i, '').trim();
      return title && title.length <= 200 ? title : '';
    } catch {
      return '';
    }
  }

  // ---- 2. bridge popup ⇄ page-hook -----------------------------------------
  // Map of requestId → { resolve } for in-flight capture round-trips.
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== TAG) return;
    if (
      data.kind !== 'capture-result' &&
      data.kind !== 'probe-result' &&
      data.kind !== 'roster-capture-result'
    ) {
      return;
    }
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    entry.resolve(data.result);
  });

  /** Generic tagged round-trip to the MAIN world. */
  function askPage(kind, payload, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      pending.set(requestId, { resolve });

      setTimeout(() => {
        if (pending.has(requestId)) {
          pending.delete(requestId);
          resolve({
            ok: false,
            error:
              'The DraftKings page did not respond. Reload the contest Standings tab and retry.',
          });
        }
      }, timeoutMs || 20000);

      window.postMessage(Object.assign({ source: TAG, kind, requestId }, payload), '*');
    });
  }

  function captureViaPage(contestId) {
    return askPage('capture-request', { contestId: String(contestId) }, 20000);
  }

  // ---- 3. respond to the popup ---------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return undefined;

    // Lightweight "detect only": no network fetch — just report the contest name read from the
    // gamecenter DOM. The popup parses the contest id from the tab URL itself. Used to populate
    // the Detected-contest card the moment the popup opens.
    if (msg.type === 'DETECT_CONTEST') {
      sendResponse({ ok: true, contestName: readContestName() });
      return undefined; // responded synchronously
    }

    // Roster-endpoint diagnosis (Phase 0). Probing hits several DK URLs in sequence, so it
    // gets a longer timeout than a single capture.
    if (msg.type === 'PROBE_ROSTER_ENDPOINT') {
      askPage('probe-request', { contestId: String(msg.contestId), entryKey: msg.entryKey || '' }, 45000).then(
        (result) => sendResponse(result),
      );
      return true;
    }

    // Roster capture for live scoring: one authenticated request per entry (DK has no bulk
    // roster endpoint), so this is by far the longest round-trip the popup makes. 32 entries
    // at concurrency 4 with jitter is a few seconds; the ceiling is generous so a slow slate
    // reports a real result instead of a timeout.
    if (msg.type === 'CAPTURE_ROSTERS') {
      askPage('roster-capture-request', { contestId: String(msg.contestId) }, 180000).then(
        (result) => sendResponse(result),
      );
      return true;
    }

    if (msg.type === 'CAPTURE_LEADERBOARD') {
      const contestName = readContestName();
      captureViaPage(msg.contestId).then((result) => {
        // Attach the contest name we read from the DOM so the popup can show/auto-fill from it.
        if (result && typeof result === 'object') {
          sendResponse(Object.assign({}, result, { contestName }));
        } else {
          sendResponse(result);
        }
      });
      return true; // keep the message channel open for the async response
    }

    return undefined;
  });
})();
