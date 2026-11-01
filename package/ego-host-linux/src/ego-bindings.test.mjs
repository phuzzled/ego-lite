import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { createEgoBindings, rawCdpGate } from "./ego-bindings.mjs";
import { webSocketServer } from "./test-support.mjs";

describe("useTaskSpace", () => {
  it("says once that a browser restart closed the space's tabs", async () => {
    const server = await webSocketServer();
    const hello = {
      wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
      spaces: [{ id: 5, lostTabs: ["https://news.test/story"] }, { id: 6 }],
    };
    const control = { call: async () => null, onEvent: () => {} };
    const ego = await createEgoBindings({ control, hello });
    const write = mock.method(process.stderr, "write", () => true);
    try {
      ego.useTaskSpace(6);
      ego.useTaskSpace(5);
      ego.useTaskSpace(5);
      const stderr = write.mock.calls.map((call) => call.arguments[0]);
      assert.equal(stderr.length, 1);
      assert.match(stderr[0], /task space 5 lost its tabs/);
      assert.match(stderr[0], /https:\/\/news\.test\/story/);
    } finally {
      write.mock.restore();
      ego.close();
      server.close();
    }
  });
});

describe("handOffTaskSpace", () => {
  async function handOff(headless) {
    const server = await webSocketServer();
    const control = {
      call: async (method) =>
        method === "handOffTaskSpace"
          ? "3 has been handed off to the user."
          : null,
      onEvent: () => {},
    };
    const hello = {
      wsUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
      spaces: [],
      headless,
    };
    const ego = await createEgoBindings({ control, hello });
    const write = mock.method(process.stderr, "write", () => true);
    try {
      ego.useTaskSpace(3);
      const result = await ego.handOffTaskSpace();
      return { result, stderr: write.mock.calls.map((c) => c.arguments[0]) };
    } finally {
      write.mock.restore();
      ego.close();
      server.close();
    }
  }

  it("warns that nobody can see a headless browser", async () => {
    const { result, stderr } = await handOff(true);
    assert.equal(result, "3 has been handed off to the user.");
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /headless/);
    assert.match(stderr[0], /ego-browser close --force 3/);
  });

  it("stays quiet when the browser has a window", async () => {
    const { stderr } = await handOff(false);
    assert.deepEqual(stderr, []);
  });
});

describe("rawCdpGate", () => {
  it("requires a selected task space", () => {
    const result = rawCdpGate(undefined, new Map());
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
  });

  it("reports a missing task space", () => {
    const result = rawCdpGate(5, new Map());
    assert.equal(result.error, "Task space not found: 5");
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  });

  it("reports a task space no longer owned by the agent", () => {
    const spaces = new Map([[1, { ownership: "user", control: "agent" }]]);
    assert.equal(rawCdpGate(1, spaces).error_code, "EGO_TASK_SPACE_INACTIVE");
  });

  it("reports user in control with the reason", () => {
    const spaces = new Map([
      [1, { ownership: "agent", control: "user", controlReason: "captcha" }],
      [2, { ownership: "agent", control: "user" }],
    ]);
    const first = rawCdpGate(1, spaces);
    assert.equal(first.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    assert.equal(first.error, "captcha");
    assert.equal(rawCdpGate(2, spaces).error, "manual_takeover");
  });

  it("allows an agent-owned, agent-controlled space", () => {
    const spaces = new Map([[1, { ownership: "agent", control: "agent" }]]);
    assert.equal(rawCdpGate(1, spaces), null);
  });
});
