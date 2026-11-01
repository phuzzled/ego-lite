import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CdpRouter } from "./cdp-router.mjs";

/** A CdpConnection double that records what it is sent. */
function connection(name, log) {
  const listeners = new Set();
  const closers = new Set();
  return {
    name,
    closed: false,
    sendRaw: (text) => {
      let message = text;
      try {
        message = JSON.parse(text);
      } catch {
        // Keep malformed text as is.
      }
      log.push([name, message]);
    },
    onMessage: (listener) => listeners.add(listener),
    onClose: (listener) => closers.add(listener),
    receive: (message) => {
      for (const listener of listeners) listener(JSON.stringify(message));
    },
    close() {
      this.closed = true;
      for (const closer of closers) closer();
    },
  };
}

function router({ fail = false } = {}) {
  const log = [];
  const received = [];
  const connections = { Default: connection("Default", log) };
  const route = new CdpRouter({
    initial: connections.Default,
    connect: async (browser) => {
      if (fail) throw new Error("profile browser did not start");
      connections[browser] = connection(browser, log);
      return connections[browser];
    },
  });
  route.onMessage((text) => received.push(JSON.parse(text)));
  return { route, log, received, connections };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("CdpRouter", () => {
  it("sends everything to Default while only Default is in use", () => {
    const { route, log } = router();
    route.send(
      JSON.stringify({ id: 1, method: "Browser.getVersion" }),
      "Default",
    );
    route.send("not json", "Default");
    assert.deepEqual(
      log.map(([browser]) => browser),
      ["Default", "Default"],
    );
    assert.deepEqual(route.browsers, ["Default"]);
  });

  it("queues commands for a profile's browser until it is connected", async () => {
    const { route, log } = router();
    route.send(JSON.stringify({ id: 1, method: "Target.getTargets" }), "work");
    assert.equal(log.length, 0);
    await settle();
    assert.deepEqual(log, [["work", { id: 1, method: "Target.getTargets" }]]);
  });

  it("routes a session to the browser that attached it", async () => {
    const { route, log, connections } = router();
    route.prepare("work");
    await settle();
    route.send(
      JSON.stringify({
        id: 5,
        method: "Target.attachToTarget",
        params: { targetId: "W1", flatten: true },
      }),
      "Default",
      (targetId) => (targetId === "W1" ? "work" : undefined),
    );
    assert.equal(log.at(-1)[0], "work");
    connections.work.receive({ id: 5, result: { sessionId: "S-work" } });
    route.send(
      JSON.stringify({ id: 6, method: "Page.navigate", sessionId: "S-work" }),
      "Default",
    );
    assert.equal(log.at(-1)[0], "work");
    // A session the router never saw belongs to Default.
    route.send(
      JSON.stringify({ id: 7, method: "Page.reload", sessionId: "S-old" }),
      "work",
    );
    assert.equal(log.at(-1)[0], "Default");
    // Auto-attached sessions are learned from events.
    connections.work.receive({
      method: "Target.attachedToTarget",
      params: { sessionId: "S-frame", targetInfo: { targetId: "F" } },
    });
    route.send(
      JSON.stringify({
        id: 8,
        method: "Runtime.evaluate",
        sessionId: "S-frame",
      }),
      "Default",
    );
    assert.equal(log.at(-1)[0], "work");
    route.send(
      JSON.stringify({
        id: 9,
        method: "Target.detachFromTarget",
        params: { sessionId: "S-work" },
      }),
      "Default",
    );
    assert.equal(log.at(-1)[0], "work");
  });

  it("passes replies of every browser to the one listener", async () => {
    const { route, received, connections } = router();
    route.prepare("work");
    await settle();
    connections.Default.receive({ id: 1, result: {} });
    connections.work.receive({ id: 2, result: {} });
    assert.deepEqual(
      received.map((message) => message.id),
      [1, 2],
    );
  });

  it("answers queued commands with an error when the browser cannot start", async () => {
    const { route, received } = router({ fail: true });
    route.send(
      JSON.stringify({ id: 3, method: "Target.setDiscoverTargets" }),
      "work",
    );
    route.send(JSON.stringify({ id: 4, method: "Target.getTargets" }), "work");
    await settle();
    await settle();
    assert.equal(received.length, 2);
    assert.equal(received[0].id, 3);
    assert.match(
      received[1].error.message,
      /Cannot reach the browser of profile work/,
    );
  });

  it("closes every connection", async () => {
    const { route, connections } = router();
    route.prepare("work");
    await settle();
    route.close();
    assert.equal(connections.Default.closed, true);
    assert.equal(connections.work.closed, true);
    assert.equal(route.closed, true);
  });
});
