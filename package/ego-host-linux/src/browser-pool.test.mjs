import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { BrowserPool } from "./browser-pool.mjs";

let nextPid = 100;

/** A browser double: a child process and a CdpConnection-like `cdp`. */
function fakeInstance(targets = []) {
  const child = new EventEmitter();
  child.pid = nextPid++;
  child.exitCode = null;
  child.kill = (signal) => {
    child.killed = signal;
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  const listeners = new Set();
  const sent = [];
  const cdp = {
    sent,
    closed: false,
    send: async (method) => {
      sent.push(method);
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Browser.close") {
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("exit", 0);
        });
      }
      return {};
    },
    onMessage: (listener) => listeners.add(listener),
    emit: (message) => {
      for (const listener of listeners)
        listener(JSON.stringify(message), message);
    },
    close() {
      cdp.closed = true;
    },
  };
  return { child, cdp, mux: { clientCount: 0, close() {} } };
}

describe("BrowserPool", () => {
  it("starts a profile's browser once, even when asked twice at once", async () => {
    let starts = 0;
    const pool = new BrowserPool({
      start: async () => {
        starts += 1;
        return fakeInstance();
      },
    });
    const [a, b] = await Promise.all([
      pool.ensure("work"),
      pool.ensure("work"),
    ]);
    assert.equal(a, b);
    assert.equal(starts, 1);
    assert.deepEqual(pool.running(), ["work"]);
    assert.deepEqual(a.cdp.sent, [
      "Target.setDiscoverTargets",
      "Target.getTargets",
    ]);
  });

  it("refuses a browser past maxBrowsers with EGO_RESOURCE_LIMIT", async () => {
    const pool = new BrowserPool({
      start: async () => fakeInstance(),
      limits: () => ({ maxBrowsers: 2 }),
    });
    await pool.ensure("Default");
    await pool.ensure("work");
    await assert.rejects(pool.ensure("home"), (error) => {
      assert.equal(error.error_code, "EGO_RESOURCE_LIMIT");
      assert.match(error.message, /2 browsers are running/);
      return true;
    });
    // A running browser is still handed out.
    assert.ok(await pool.ensure("work"));
  });

  it("knows which browser holds each tab", async () => {
    const instances = {
      Default: fakeInstance([
        { targetId: "A", type: "page", url: "about:blank" },
      ]),
      work: fakeInstance([
        { targetId: "B", type: "page", url: "https://a.test/" },
      ]),
    };
    const events = [];
    const pool = new BrowserPool({
      start: async (id) => instances[id],
      onTarget: (method, profileId, params) =>
        events.push([method, profileId, params.targetInfo?.targetId]),
    });
    await pool.ensure("Default");
    await pool.ensure("work");
    assert.equal(pool.ownerOf("A").profileId, "Default");
    assert.equal(pool.ownerOf("B").profileId, "work");
    assert.equal(pool.targetInfo("B").url, "https://a.test/");
    instances.work.cdp.emit({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "C", type: "page", url: "" } },
    });
    assert.equal(pool.ownerOf("C").profileId, "work");
    assert.deepEqual(events, [["Target.targetCreated", "work", "C"]]);
    assert.deepEqual(pool.pids().length, 2);
  });

  it("reports the tabs lost when a browser dies", async () => {
    const instance = fakeInstance([
      { targetId: "B", type: "page", url: "https://mail.test/" },
      { targetId: "W", type: "service_worker", url: "https://mail.test/sw.js" },
    ]);
    const exits = [];
    const pool = new BrowserPool({
      start: async () => instance,
      onExit: (...args) => exits.push(args),
    });
    await pool.ensure("work");
    instance.child.emit("exit", 1);
    assert.deepEqual(exits, [
      ["work", [{ targetId: "B", url: "https://mail.test/" }], false],
    ]);
    assert.deepEqual(pool.running(), []);
    assert.equal(instance.cdp.closed, true);
  });

  it("stops a browser with Browser.close first, so its cookies are written", async () => {
    const instance = fakeInstance();
    const exits = [];
    const pool = new BrowserPool({
      start: async () => instance,
      onExit: (...args) => exits.push(args),
    });
    await pool.ensure("work");
    assert.equal(await pool.stop("work"), true);
    assert.ok(instance.cdp.sent.includes("Browser.close"));
    assert.equal(instance.child.killed, undefined);
    assert.deepEqual(exits, [["work", [], true]]);
    assert.equal(await pool.stop("work"), false);
  });
});
