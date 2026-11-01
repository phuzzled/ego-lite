import test from "node:test";
import assert from "node:assert/strict";

import {
  formatSnapshotStats,
  pendingDataRequests,
  probePageState,
  settleProbeExpression,
  snapshotStats,
  snapshotWarnings,
  waitForSettledInPage,
} from "../../dist/src/driver/page-settle.js";

/**
 * A fake Page whose DOM, load state and requests change on a fake clock.
 * `mutateAt(ms)` schedules DOM changes; `requests` lists fetches by time.
 */
function fakePage({
  readyStateAt = () => "complete",
  mutationTimes = [],
  requests = [],
  url = "https://example.test/app",
} = {}) {
  let now = 0;
  let installedAt;
  const probes = [];
  const tracked = [];
  const services = {
    async cdp(method, params) {
      assert.equal(method, "Runtime.evaluate");
      assert.match(params.expression, /egoBrowser\.settle/);
      probes.push(now);
      installedAt ??= now;
      const seen = mutationTimes.filter((t) => t > installedAt && t <= now);
      const last = seen.length ? Math.max(...seen) : installedAt;
      return {
        result: {
          type: "object",
          value: {
            __egoSettleProbe: true,
            url,
            readyState: readyStateAt(now),
            quietMs: now - last,
            mutations: seen.length,
            ageMs: now + 200,
          },
        },
      };
    },
    async ensureNetworkTracking(sessionIds) {
      tracked.push(...sessionIds);
    },
    inflightRequests() {
      return requests
        .filter((request) => request.start <= now && now < request.end)
        .map((request) => ({
          type: request.type,
          startedAt: request.start,
          ...(request.respondedAt !== undefined && now >= request.respondedAt
            ? { responded: true }
            : {}),
        }));
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  return { services, probes, tracked, now: () => now };
}

test("a static page settles after one quiet window", async () => {
  const page = fakePage();
  const result = await waitForSettledInPage(page.services, "session:page", {
    quietMs: 500,
  });
  assert.equal(result.settled, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.readyState, "complete");
  assert.equal(result.pendingRequests, 0);
  assert(
    result.waitedMs >= 500 && result.waitedMs < 600,
    `static page waited ${result.waitedMs} ms`,
  );
  assert.deepEqual(page.tracked, ["session:page"]);
});

test("a page that keeps changing returns settled: false at the timeout", async () => {
  const mutationTimes = Array.from({ length: 100 }, (_, i) => i * 200);
  const page = fakePage({ mutationTimes });
  const result = await waitForSettledInPage(page.services, "session:page", {
    timeout: 3_000,
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "dom still changing");
  assert(result.mutationsSeen >= 14, `saw ${result.mutationsSeen}`);
  assert.equal(result.waitedMs, 3_000, "the wait ends exactly at its timeout");
});

test("content rendered after a slow fetch, with background polling, settles once drawn", async () => {
  const page = fakePage({
    // Rows appear when the slow request finishes at 1.5 s.
    mutationTimes: [1_500, 1_510, 1_520],
    requests: [
      { type: "Fetch", start: 0, end: 1_500 },
      // A 200 ms poll whose requests each take 20 ms.
      ...Array.from({ length: 50 }, (_, i) => ({
        type: "XHR",
        start: i * 200 + 50,
        end: i * 200 + 70,
      })),
      // Long-lived streams never count as loading.
      { type: "EventSource", start: 0, end: Infinity },
      { type: "WebSocket", start: 0, end: Infinity },
    ],
  });
  const result = await waitForSettledInPage(page.services, "session:page", {
    timeout: 8_000,
  });
  assert.equal(result.settled, true);
  assert(
    result.waitedMs >= 2_020 && result.waitedMs < 2_400,
    `settled after the rows plus a quiet window: ${result.waitedMs}`,
  );
  assert.equal(result.mutationsSeen, 3);
});

test("an answered request whose body the page never reads is not pending", async () => {
  const page = fakePage({
    requests: [
      // Answered at 300 ms, but loadingFinished never comes.
      { type: "Fetch", start: 0, respondedAt: 300, end: Infinity },
    ],
  });
  const result = await waitForSettledInPage(page.services, "session:page", {
    timeout: 3_000,
  });
  assert.equal(result.settled, true);
  assert.equal(result.pendingRequests, 0);
  assert(
    result.waitedMs < 700,
    `answered requests do not hold the page: ${result.waitedMs}`,
  );
});

test("a probe that times out at the deadline keeps the last real reason", async () => {
  let now = 0;
  const services = {
    async cdp(_method, _params, _sessionId, timeoutMs) {
      if (timeoutMs < 50)
        throw new Error("CDP request timed out: Runtime.evaluate");
      return {
        result: {
          value: {
            __egoSettleProbe: true,
            url: "https://example.test/",
            readyState: "complete",
            quietMs: 0,
            mutations: 1,
            ageMs: 900,
          },
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const result = await waitForSettledInPage(services, "session:page", {
    timeout: 1_030,
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "dom still changing");
});

test("a long poll older than five seconds does not block settling", async () => {
  const page = fakePage({
    requests: [{ type: "Fetch", start: -10_000, end: Infinity }],
  });
  const result = await waitForSettledInPage(page.services, "session:page");
  assert.equal(result.settled, true);
  assert.equal(
    pendingDataRequests(page.services, ["session:page"]),
    0,
    "an old fetch is a long poll",
  );
});

test("a pending fetch keeps the page unsettled and is named in the reason", async () => {
  const page = fakePage({
    requests: [{ type: "Fetch", start: 0, end: 4_000 }],
  });
  const result = await waitForSettledInPage(page.services, "session:page", {
    timeout: 1_000,
  });
  assert.equal(result.settled, false);
  assert.equal(result.reason, "1 fetch/XHR request still pending");
  assert.equal(result.pendingRequests, 1);
});

test("until and minCount wait for enough matches", async () => {
  const page = fakePage();
  const counts = [];
  const result = await waitForSettledInPage(
    page.services,
    "session:page",
    { until: "loc=role:row", minCount: 5, timeout: 5_000 },
    async (selector) => {
      assert.equal(selector, "loc=role:row");
      const count = Math.min(5, Math.floor(page.now() / 300));
      counts.push(count);
      return count;
    },
  );
  assert.equal(result.settled, true);
  assert.equal(result.matches, 5);
  assert(result.waitedMs >= 1_500, `waited for the rows: ${result.waitedMs}`);

  const missing = await waitForSettledInPage(
    fakePage().services,
    "session:page",
    { until: "#never", timeout: 700 },
    async () => 0,
  );
  assert.equal(missing.settled, false);
  assert.equal(missing.reason, "#never matched 0 of 1");
});

test("a loading document is not settled", async () => {
  const page = fakePage({
    readyStateAt: (now) => (now < 2_000 ? "interactive" : "complete"),
  });
  const short = await waitForSettledInPage(page.services, "session:page", {
    timeout: 1_000,
  });
  assert.equal(short.settled, false);
  assert.equal(short.reason, "document is still interactive");
  const later = await waitForSettledInPage(page.services, "session:page", {
    timeout: 5_000,
  });
  assert.equal(later.settled, true);
});

test("a probe that fails while the document is replaced is retried", async () => {
  let now = 0;
  let calls = 0;
  const services = {
    async cdp() {
      calls += 1;
      if (calls <= 2) throw new Error("Execution context was destroyed.");
      return {
        result: {
          value: {
            __egoSettleProbe: true,
            url: "https://example.test/",
            readyState: "complete",
            quietMs: 900,
            mutations: 0,
            ageMs: 900,
          },
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const result = await waitForSettledInPage(services, "session:page");
  assert.equal(result.settled, true);
  assert.equal(calls, 3);
  assert.equal(
    await probePageState({ ...services, cdp: async () => ({}) }, "s"),
    undefined,
  );
});

test("the probe installs one shared observer and reads text only when asked", () => {
  assert.match(settleProbeExpression(false), /MutationObserver/);
  assert.doesNotMatch(settleProbeExpression(false), /innerText/);
  assert.match(settleProbeExpression(true), /innerText/);
  assert.doesNotMatch(
    settleProbeExpression(true),
    /attributes: true/,
    "attribute churn (hover, focus, animation classes) is not content",
  );
});

test("snapshot stats and warnings flag a page caught before its content", () => {
  const young = {
    url: "https://example.test/app",
    readyState: "complete",
    quietMs: 2_000,
    mutations: 0,
    ageMs: 900,
    nodes: 18,
    textChars: 40,
  };
  const stats = snapshotStats(young, 3, 0);
  assert.deepEqual(stats, {
    nodes: 18,
    refs: 3,
    textChars: 40,
    readyState: "complete",
    domChanging: false,
    pendingRequests: 0,
  });
  const warnings = snapshotWarnings(stats, young);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /^page may still be rendering: the page loaded 900 ms ago and has little text\. Wait for the content \(page\.waitForSelector or page\.waitForSettled\), then snapshot again\.$/,
  );
  assert.equal(
    formatSnapshotStats(stats, warnings),
    `[stats nodes=18 refs=3 text=40 readyState=complete pendingRequests=0 domChanging=no]\n[warning ${warnings[0]}]`,
  );

  const changing = { ...young, ageMs: 9_000, quietMs: 120, mutations: 4 };
  const changingStats = snapshotStats(changing, 3);
  assert.equal(changingStats.domChanging, true);
  assert.match(
    snapshotWarnings(changingStats, changing)[0],
    /the DOM changed in the last 500 ms and the page has little text/,
  );
  assert.doesNotMatch(
    formatSnapshotStats(changingStats, []),
    /pendingRequests/,
    "untracked network state is omitted, not reported as 0",
  );

  const loading = { ...young, readyState: "loading", textChars: 5_000 };
  assert.match(
    snapshotWarnings(snapshotStats(loading, 9), loading)[0],
    /the document is still loading/,
  );

  const done = { ...young, ageMs: 9_000, textChars: 4_000 };
  assert.deepEqual(snapshotWarnings(snapshotStats(done, 40), done), []);
  const old = { ...young, ageMs: 60_000 };
  assert.deepEqual(
    snapshotWarnings(snapshotStats(old, 1), old),
    [],
    "a quiet, old, short page is just short",
  );
  const blank = { ...young, url: "about:blank", textChars: 0 };
  assert.deepEqual(snapshotWarnings(snapshotStats(blank, 0), blank), []);
});
