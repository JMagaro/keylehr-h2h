/**
 * The ESPN summary fetch — specifically its retry, which exists because a dropped request
 * does not degrade gracefully.
 *
 * `buildLiveStatIndex` skips a game whose summary failed, so every player in it loses their
 * `teamState` and renders as `?`. The assembled index is then memoised for 30s, so one blip
 * paints question marks across up to nine rosters for everyone until the window rolls. The
 * reported symptom was exactly that: "question marks on random players, need to keep
 * re-loading until it shows".
 *
 * `fetch` is stubbed rather than hit — these assert the retry POLICY, and a test that depended
 * on ESPN actually failing could not be written at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { EspnBoxscoreError, buildSummaryUrl, fetchGameSummary } from './espn-boxscore';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  vi.restoreAllMocks();
});

/**
 * A stub returning the given outcomes in order; each is a status, or an Error to throw.
 *
 * The parameters are declared even though the body ignores them: that is what gives
 * `mock.calls[n][1]` a type, so the assertions below can inspect the fetch OPTIONS — which
 * is the point of half these tests (no signal, accept-only headers, TTL passthrough).
 */
function stubFetch(outcomes: (number | Error)[]) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const next = outcomes.shift();
    if (next === undefined) throw new Error('fetch called more times than the test allows');
    if (next instanceof Error) throw next;
    return {
      ok: next >= 200 && next < 300,
      status: next,
      json: async () => ({ header: { id: '42' } }),
    } as unknown as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('buildSummaryUrl', () => {
  it('encodes the event id', () => {
    expect(buildSummaryUrl('401872933')).toContain('event=401872933');
  });
});

describe('fetchGameSummary — retry policy', () => {
  it('returns immediately on success, without a second request', async () => {
    const fetchMock = stubFetch([200]);
    await expect(fetchGameSummary('1')).resolves.toMatchObject({ header: { id: '42' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transient 503 — the case that was painting question marks', async () => {
    const fetchMock = stubFetch([503, 200]);
    await expect(fetchGameSummary('1')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from a dropped connection', async () => {
    const fetchMock = stubFetch([new TypeError('fetch failed'), 200]);
    await expect(fetchGameSummary('1')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers from a timeout', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    const fetchMock = stubFetch([abort, 200]);
    await expect(fetchGameSummary('1')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries rate limiting', async () => {
    const fetchMock = stubFetch([429, 429, 200]);
    await expect(fetchGameSummary('1')).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after three attempts and reports the last status', async () => {
    const fetchMock = stubFetch([500, 500, 500]);
    await expect(fetchGameSummary('1')).rejects.toBeInstanceOf(EspnBoxscoreError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a 404 — a wrong event id is wrong every time', async () => {
    // Retrying a permanent failure only burns the route's 30s budget, and with 16 games in
    // flight that is the difference between a partial page and a timed-out one.
    const fetchMock = stubFetch([404]);
    await expect(fetchGameSummary('bogus')).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 403 either — that is the User-Agent trap, not a blip', async () => {
    const fetchMock = stubFetch([403]);
    await expect(fetchGameSummary('1')).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still sends ONLY an accept header — a realistic UA makes ESPN 403', async () => {
    const fetchMock = stubFetch([200]);
    await fetchGameSummary('1');
    const init = fetchMock.mock.calls[0][1];
    expect(Object.keys(init?.headers as Record<string, string>)).toEqual(['accept']);
  });

  it('carries a signal on EVERY attempt — without it the retry is a no-op', async () => {
    // Not merely a timeout. Next's dedupe-fetch memoises by (url, method, headers, …) for the
    // whole render pass and stores the entry before the promise settles, so an identical
    // retry re-awaits the same REJECTED promise — or gets a clone of the same 503 — and never
    // reaches the network. A signal is the documented opt-out. `cache: 'no-store'` is not:
    // dedupe-fetch deliberately excludes `cache` from its key.
    const fetchMock = stubFetch([503, 200]);
    await fetchGameSummary('1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('passes the caller’s TTL through to the Data Cache', async () => {
    const fetchMock = stubFetch([200]);
    await fetchGameSummary('1', 45);
    const init = fetchMock.mock.calls[0][1] as { next?: { revalidate?: number } } | undefined;
    expect(init?.next?.revalidate).toBe(45);
  });
});
