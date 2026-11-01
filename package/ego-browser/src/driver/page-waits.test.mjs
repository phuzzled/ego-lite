import test from "node:test";
import assert from "node:assert/strict";

import {
  navigateInPage,
  waitForLoadStateInPage,
  waitForSelectorInPage,
  waitForURLInPage,
} from "../../dist/src/driver/page-waits.js";

test("waitForSelectorInPage refreshes iframe sessions while it polls", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method, _params, sessionId) {
      if (method === "Runtime.evaluate") {
        return sessionId === "session:frame-current"
          ? { result: { objectId: "object:ready" } }
          : { result: { type: "undefined" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async () => {
    discoveries += 1;
    return discoveries === 1
      ? new Map()
      : new Map([["frame-current", "session:frame-current"]]);
  };

  assert.equal(
    await waitForSelectorInPage(
      services,
      "session:page",
      new Map(),
      "#ready",
      { state: "visible", timeout: 2_000 },
      getIframeSessions,
    ),
    true,
  );
  assert.equal(discoveries, 2);
});

test("waitForSelectorInPage retries when a discovered iframe disappears during resolution", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method, _params, sessionId) {
      if (
        method === "Runtime.evaluate" &&
        sessionId === "session:frame-stale"
      ) {
        throw new Error("Frame with the given frameId is not found.");
      }
      if (method === "Runtime.evaluate") {
        return sessionId === "session:frame-current"
          ? { result: { objectId: "object:ready" } }
          : { result: { type: "undefined" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: true } };
      }
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async () => {
    discoveries += 1;
    return discoveries === 1
      ? new Map([["frame-stale", "session:frame-stale"]])
      : new Map([["frame-current", "session:frame-current"]]);
  };

  assert.equal(
    await waitForSelectorInPage(
      services,
      "session:page",
      new Map(),
      "#ready",
      { state: "visible", timeout: 500 },
      getIframeSessions,
    ),
    true,
  );
  assert.equal(discoveries, 2);
});

test("waitForSelectorInPage rethrows a lost page session instead of reporting hidden", async () => {
  let now = 0;
  const services = {
    async cdp() {
      throw new Error("Target closed");
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#spinner",
        { state: "hidden", timeout: 500 },
        async () => new Map(),
      ),
    /Target closed/,
  );
});

for (const [state, interruptedMethod] of [
  ["visible", "Runtime.evaluate"],
  ["hidden", "Runtime.callFunctionOn"],
]) {
  test(`waitForSelectorInPage retries context changes before reporting ${state}`, async () => {
    let now = 0;
    let discoveries = 0;
    let interrupted = false;
    let visibilityChecks = 0;
    const services = {
      async cdp(method) {
        if (method === interruptedMethod && !interrupted) {
          interrupted = true;
          throw new Error("Cannot find context with specified id");
        }
        if (method === "Runtime.evaluate") {
          return { result: { objectId: "object:ready" } };
        }
        if (method === "Runtime.callFunctionOn") {
          visibilityChecks += 1;
          return { result: { value: state === "visible" } };
        }
        if (method === "Runtime.releaseObject") return {};
        throw new Error(`unexpected CDP method: ${method}`);
      },
      now: () => now,
      async sleep(ms) {
        now += ms;
      },
    };

    assert.equal(
      await waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#ready",
        { state, timeout: 500 },
        async () => {
          discoveries += 1;
          return new Map();
        },
      ),
      true,
    );
    assert.equal(discoveries, 2, "a context change refreshes frame sessions");
    assert.equal(visibilityChecks, 1, "the wait verifies the requested state");
  });
}

test("waitForSelectorInPage bounds repeated context changes by its timeout", async () => {
  let now = 0;
  let attempts = 0;
  const services = {
    async cdp() {
      attempts += 1;
      throw new Error("Cannot find context with specified id");
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#ready",
        { state: "visible", timeout: 500 },
        async () => new Map(),
      ),
    /page\.waitForSelector timed out after 500ms: #ready/,
  );
  assert(attempts > 1);
  assert.equal(now, 500);
});

test("waitForSelectorInPage reports its own timeout at the deadline", async () => {
  let now = 0;
  const discoveryTimeouts = [];
  const services = {
    async cdp(method) {
      if (method === "Runtime.evaluate")
        return { result: { type: "undefined" } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  const getIframeSessions = async (timeoutMs) => {
    discoveryTimeouts.push(timeoutMs);
    if (timeoutMs < 250) {
      const error = new Error("CDP request timed out: Target.getTargets");
      error.code = "EGO_CDP_REQUEST_TIMEOUT";
      throw error;
    }
    return new Map();
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#missing",
        { state: "visible", timeout: 500 },
        getIframeSessions,
      ),
    /page\.waitForSelector timed out after 500ms: #missing/,
  );
  assert(
    discoveryTimeouts.every((timeoutMs) => timeoutMs <= 500),
    `frame discovery must never exceed the public timeout: ${discoveryTimeouts}`,
  );
});

test("waitForSelectorInPage throttles iframe discovery while polling", async () => {
  let now = 0;
  let discoveries = 0;
  const services = {
    async cdp(method) {
      if (method === "Runtime.evaluate")
        return { result: { type: "undefined" } };
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForSelectorInPage(
        services,
        "session:page",
        new Map(),
        "#missing",
        { state: "visible", timeout: 2_000 },
        async () => {
          discoveries += 1;
          return new Map();
        },
      ),
    /timed out/,
  );
  assert(
    discoveries <= 5,
    `expected at most one discovery per 500ms over 2s, got ${discoveries}`,
  );
});

test("waitForURLInPage recovers from a transient execution-context change", async () => {
  let now = 0;
  let attempt = 0;
  const calls = [];
  const services = {
    async cdp(method, params, sessionId, timeoutMs) {
      calls.push([method, params, sessionId, timeoutMs]);
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Execution context was destroyed");
      }
      return {
        result: {
          value:
            attempt === 2
              ? "https://example.test/loading"
              : "https://example.test/ready",
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(services, "session:page", /\/ready$/g, {
    timeout: 500,
  });

  assert.equal(attempt, 3);
  assert(
    calls.every(
      ([method, , sessionId, timeoutMs]) =>
        method === "Runtime.evaluate" &&
        sessionId === "session:page" &&
        timeoutMs > 0 &&
        timeoutMs <= 500,
    ),
  );
});

test("waitForURLInPage supports Playwright-style URL globs", async () => {
  let now = 0;
  let attempt = 0;
  const services = {
    async cdp() {
      attempt += 1;
      return {
        result: {
          value:
            attempt === 1
              ? "https://example.test/releases/draft/nested/item?channel=canary"
              : "https://example.test/releases/ready/item?channel=stable",
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(
    services,
    "session:page",
    "**/releases/{draft,ready}/*?channel=*",
    { timeout: 500 },
  );

  assert.equal(attempt, 2, "a single star must not cross a path separator");
});

test("waitForURLInPage passes a URL object to a synchronous predicate", async () => {
  let now = 0;
  let attempt = 0;
  const seen = [];
  const services = {
    async cdp() {
      attempt += 1;
      return {
        result: {
          value: `https://example.test/jobs?id=${attempt === 1 ? 41 : 42}`,
        },
      };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await waitForURLInPage(
    services,
    "session:page",
    (url) => {
      assert(url instanceof URL);
      seen.push(url.href);
      return url.searchParams.get("id") === "42";
    },
    { timeout: 500 },
  );

  assert.deepEqual(seen, [
    "https://example.test/jobs?id=41",
    "https://example.test/jobs?id=42",
  ]);
});

test("document load waits do not sleep past the budget after a slow probe", async () => {
  let now = 0;
  let calls = 0;
  const services = {
    async cdp(_method, _params, _sessionId, timeoutMs) {
      calls += 1;
      if (calls === 1) {
        assert.equal(timeoutMs, 100);
        now = 99;
      } else {
        assert.equal(timeoutMs, 1);
      }
      return { result: { value: "loading" } };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };

  await assert.rejects(
    () =>
      waitForLoadStateInPage(services, "session:page", "load", {
        timeout: 100,
      }),
    /page\.waitForLoadState\(load\) timed out after 100ms/,
  );

  assert.equal(now, 100);
});

test("network-idle discovery stays within the Page wait timeout", async () => {
  let discoveryTimeout;
  const services = {
    async pageNetworkSessions(sessionId, timeoutMs) {
      assert.equal(sessionId, "session:page");
      discoveryTimeout = timeoutMs;
      return [sessionId];
    },
    async ensureNetworkTracking() {},
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => 0,
    async sleep() {},
  };

  await waitForLoadStateInPage(services, "session:page", "networkidle", {
    timeout: 123,
    idleMs: 10,
  });

  assert.equal(discoveryTimeout, 123);
});

test("network-idle gives tracking only the budget left after discovery", async () => {
  let now = 0;
  let trackingTimeout;
  const services = {
    async pageNetworkSessions(_sessionId, timeoutMs) {
      assert.equal(timeoutMs, 100);
      now = 90;
      return ["session:page"];
    },
    async ensureNetworkTracking(_sessionIds, timeoutMs) {
      trackingTimeout = timeoutMs;
    },
    networkActivity() {
      return { tracking: true, inflight: 0, lastActivityAt: -1_000 };
    },
    now: () => now,
    async sleep() {},
  };

  await waitForLoadStateInPage(services, "session:page", "networkidle", {
    timeout: 100,
    idleMs: 10,
  });

  assert.equal(trackingTimeout, 10);
});

test("network-idle reports its public timeout when discovery exhausts the budget", async () => {
  let now = 0;
  const services = {
    async pageNetworkSessions() {
      now = 50;
      const error = new Error("CDP request timed out: Page.getFrameTree");
      error.code = "EGO_CDP_REQUEST_TIMEOUT";
      throw error;
    },
    async ensureNetworkTracking() {},
    networkActivity() {
      throw new Error(
        "network activity must not be read after discovery fails",
      );
    },
    now: () => now,
    async sleep() {},
  };

  await assert.rejects(
    () =>
      waitForLoadStateInPage(services, "session:page", "networkidle", {
        timeout: 50,
        idleMs: 10,
      }),
    /page\.waitForLoadState\(networkidle\) timed out after 50ms/,
  );
});

test("navigateInPage explains an HTTP error status with an empty body", async () => {
  const services = {
    async cdp(method) {
      if (method === "Page.navigate") {
        return {
          frameId: "frame",
          loaderId: "loader",
          errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => 0,
    async sleep() {},
  };
  await assert.rejects(
    navigateInPage(services, "session:page", "https://example.com/404", {
      timeoutMs: 5_000,
      waitUntil: "load",
    }),
    (error) => {
      assert.match(
        error.message,
        /the server answered an HTTP error status \(4xx or 5xx\) with an empty body \(net::ERR_HTTP_RESPONSE_CODE_FAILURE\)/,
      );
      assert.equal(error.error_code, "EGO_NAVIGATION_HTTP_ERROR");
      assert.equal(error.status, undefined);
      assert.match(error.hint, /page\.fetch\(url\)/);
      return true;
    },
  );
});

test("navigateInPage reads the HTTP status from Chromium's error page", async () => {
  let now = 0;
  let probes = 0;
  const services = {
    async cdp(method, params) {
      if (method === "Page.navigate") {
        return {
          frameId: "frame",
          loaderId: "loader",
          errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE",
        };
      }
      if (method === "Runtime.evaluate") {
        assert.match(params.expression, /chrome-error:/);
        probes += 1;
        // The error page commits shortly after Page.navigate returns.
        return {
          result: {
            type: "string",
            value:
              probes === 1
                ? ""
                : "This page can't be found\n\nHTTP ERROR 404\nReload",
          },
        };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  await assert.rejects(
    navigateInPage(services, "session:page", "https://example.com/404", {
      timeoutMs: 5_000,
      waitUntil: "load",
    }),
    (error) => {
      assert.equal(error.error_code, "EGO_NAVIGATION_HTTP_ERROR");
      assert.equal(error.status, 404);
      assert.equal(error.url, "https://example.com/404");
      assert.match(error.message, /the server answered HTTP 404/);
      assert.match(error.hint, /The server answered 404\. Check the URL/);
      assert.match(
        error.stack,
        /\n  status: 404\n  hint: The server answered 404/,
      );
      return true;
    },
  );
  assert.equal(probes, 2);
});

test("navigateInPage keeps an HTTP error even when the status probe uses the whole budget", async () => {
  let now = 0;
  const services = {
    async cdp(method) {
      if (method === "Page.navigate") {
        return { errorText: "net::ERR_HTTP_RESPONSE_CODE_FAILURE" };
      }
      now += 400;
      return { result: { type: "string", value: "" } };
    },
    now: () => now,
    async sleep(ms) {
      now += ms;
    },
  };
  await assert.rejects(
    navigateInPage(services, "session:page", "https://example.com/500", {
      timeoutMs: 600,
      waitUntil: "load",
    }),
    { error_code: "EGO_NAVIGATION_HTTP_ERROR" },
  );
});

test("navigateInPage retries once when the network changed during the load", async () => {
  const navigations = [];
  const services = {
    async cdp(method, params) {
      if (method === "Page.navigate") {
        navigations.push(params.url);
        return { errorText: "net::ERR_NETWORK_CHANGED" };
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
    now: () => 0,
    async sleep() {},
  };
  await assert.rejects(
    navigateInPage(services, "session:page", "https://example.com/", {
      timeoutMs: 5_000,
      waitUntil: "commit",
    }),
    { message: "page.goto failed: net::ERR_NETWORK_CHANGED" },
  );
  assert.deepEqual(navigations, [
    "https://example.com/",
    "https://example.com/",
  ]);
});

test("navigateInPage keeps other navigation errors unchanged", async () => {
  const services = {
    async cdp() {
      return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
    },
    now: () => 0,
    async sleep() {},
  };
  await assert.rejects(
    navigateInPage(services, "session:page", "https://nope.invalid", {
      timeoutMs: 5_000,
      waitUntil: "load",
    }),
    (error) => {
      assert.equal(
        error.message,
        "page.goto failed: net::ERR_NAME_NOT_RESOLVED",
      );
      assert.equal(error.error_code, "EGO_NAVIGATION_FAILED");
      assert.match(error.hint, /Check the host name and the network/);
      return true;
    },
  );
});
