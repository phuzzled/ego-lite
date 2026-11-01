import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { CdpMux } from "./cdp-mux.mjs";

/** Upstream that records what the mux sends and lets the test answer. */
function fakeUpstream() {
  const listeners = new Set();
  const closers = new Set();
  const upstream = {
    sent: [],
    send(text) {
      upstream.sent.push(JSON.parse(text));
    },
    onMessage: (listener) => listeners.add(listener),
    onClose: (listener) => closers.add(listener),
    emit(message) {
      const text =
        typeof message === "string" ? message : JSON.stringify(message);
      for (const listener of listeners) listener(text);
    },
    close() {
      for (const closer of closers) closer();
    },
    last() {
      return upstream.sent.at(-1);
    },
  };
  return upstream;
}

/** A client on a duplex stream pair, as the daemon socket gives. */
function streamClient(mux) {
  const toMux = new PassThrough();
  const fromMux = new PassThrough();
  const socket = toMux;
  socket.write = fromMux.write.bind(fromMux);
  socket.destroy = () => {
    socket.destroyed = true;
    toMux.emit("close");
  };
  mux.attachStream(socket);
  const received = [];
  fromMux.setEncoding("utf8");
  fromMux.on("data", (chunk) => {
    for (const text of chunk.split("\0").filter(Boolean)) {
      received.push(JSON.parse(text));
    }
  });
  return {
    received,
    send(message) {
      toMux.push(`${JSON.stringify(message)}\0`);
    },
    close() {
      toMux.emit("close");
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("CdpMux", () => {
  it("rewrites ids so two clients may use the same id", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    const b = streamClient(mux);
    a.send({ id: 1, method: "Browser.getVersion" });
    b.send({ id: 1, method: "Browser.getVersion" });
    await tick();
    const [first, second] = upstream.sent;
    assert.notEqual(first.id, second.id);
    upstream.emit(`{"id":${second.id},"result":{"who":"b"}}`);
    upstream.emit(`{"id":${first.id},"result":{"who":"a"}}`);
    await tick();
    assert.deepEqual(a.received, [{ id: 1, result: { who: "a" } }]);
    assert.deepEqual(b.received, [{ id: 1, result: { who: "b" } }]);
  });

  it("gives a session's events only to the client that attached it", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    const b = streamClient(mux);
    a.send({
      id: 5,
      method: "Target.attachToTarget",
      params: { targetId: "T1", flatten: true },
    });
    await tick();
    const attach = upstream.last();
    upstream.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "S1", targetInfo: { targetId: "T1", type: "page" } },
    });
    upstream.emit({ id: attach.id, result: { sessionId: "S1" } });
    upstream.emit({
      method: "Page.loadEventFired",
      params: {},
      sessionId: "S1",
    });
    await tick();
    assert.deepEqual(
      a.received.map((m) => m.method ?? m.id),
      ["Target.attachedToTarget", 5, "Page.loadEventFired"],
    );
    assert.deepEqual(b.received, []);
  });

  it("refuses commands on another client's session", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    const b = streamClient(mux);
    a.send({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "T1", flatten: true },
    });
    await tick();
    upstream.emit({ id: upstream.last().id, result: { sessionId: "S1" } });
    const sentBefore = upstream.sent.length;
    b.send({
      id: 2,
      method: "Runtime.evaluate",
      params: { expression: "1" },
      sessionId: "S1",
    });
    b.send({
      id: 3,
      method: "Target.detachFromTarget",
      params: { sessionId: "S1" },
    });
    await tick();
    assert.equal(upstream.sent.length, sentBefore);
    assert.equal(b.received[0].error.code, -32001);
    assert.equal(b.received[1].error.code, -32001);
  });

  it("routes auto-attached child sessions to the parent's owner", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    streamClient(mux);
    a.send({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "T1", flatten: true },
    });
    await tick();
    upstream.emit({ id: upstream.last().id, result: { sessionId: "S1" } });
    upstream.emit({
      method: "Target.attachedToTarget",
      sessionId: "S1",
      params: {
        sessionId: "S2",
        targetInfo: { targetId: "F1", type: "iframe" },
      },
    });
    upstream.emit({
      method: "DOM.documentUpdated",
      params: {},
      sessionId: "S2",
    });
    a.send({ id: 2, method: "DOM.getDocument", sessionId: "S2" });
    await tick();
    assert.equal(upstream.last().sessionId, "S2");
    assert.deepEqual(
      a.received.map((m) => m.method ?? m.id),
      [1, "Target.attachedToTarget", "DOM.documentUpdated"],
    );
  });

  it("answers setDiscoverTargets itself and replays known targets", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    mux.start();
    assert.equal(upstream.last().method, "Target.setDiscoverTargets");
    upstream.emit({ id: upstream.last().id, result: {} });
    upstream.emit({
      method: "Target.targetCreated",
      params: {
        targetInfo: { targetId: "T1", type: "page", url: "about:blank" },
      },
    });
    const a = streamClient(mux);
    const b = streamClient(mux);
    const sentBefore = upstream.sent.length;
    a.send({
      id: 9,
      method: "Target.setDiscoverTargets",
      params: { discover: true },
    });
    await tick();
    assert.equal(upstream.sent.length, sentBefore, "not forwarded");
    assert.deepEqual(
      a.received.map((m) => m.method ?? m.id),
      ["Target.targetCreated", 9],
    );
    upstream.emit({
      method: "Target.targetDestroyed",
      params: { targetId: "T1" },
    });
    await tick();
    assert.equal(a.received.at(-1).method, "Target.targetDestroyed");
    assert.deepEqual(b.received, [], "no discovery, no target events");
  });

  it("detaches a leaving client's sessions", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    a.send({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "T1", flatten: true },
    });
    await tick();
    upstream.emit({ id: upstream.last().id, result: { sessionId: "S1" } });
    a.close();
    await tick();
    assert.equal(upstream.last().method, "Target.detachFromTarget");
    assert.deepEqual(upstream.last().params, { sessionId: "S1" });
    assert.equal(mux.clientCount, 0);
  });

  it("detaches a session whose client left before the reply", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    a.send({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "T1", flatten: true },
    });
    await tick();
    const attachId = upstream.last().id;
    a.close();
    upstream.emit({ id: attachId, result: { sessionId: "S9" } });
    assert.deepEqual(upstream.last().params, { sessionId: "S9" });
  });

  it("sends download events only to clients that asked for them", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const a = streamClient(mux);
    const b = streamClient(mux);
    a.send({
      id: 1,
      method: "Browser.setDownloadBehavior",
      params: { behavior: "allow", eventsEnabled: true },
    });
    await tick();
    upstream.emit({
      method: "Browser.downloadWillBegin",
      params: { guid: "g" },
    });
    await tick();
    assert.equal(a.received.at(-1).method, "Browser.downloadWillBegin");
    assert.deepEqual(b.received, []);
  });

  it("gives the daemon a local CdpConnection", async () => {
    const upstream = fakeUpstream();
    const mux = new CdpMux(upstream);
    const cdp = mux.localConnection();
    const reply = cdp.send("Browser.getVersion");
    upstream.emit({
      id: upstream.last().id,
      result: { product: "Chrome/150" },
    });
    assert.deepEqual(await reply, { product: "Chrome/150" });
    upstream.close();
    assert.equal(cdp.closed, true);
  });
});
