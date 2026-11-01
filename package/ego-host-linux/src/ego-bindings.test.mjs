import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  createEgoBindings,
  createRoundLogger,
  rawCdpGate,
} from "./ego-bindings.mjs";
import { proxyServer } from "./test-support.mjs";

/** Bindings on a fake daemon: `answers[method](params)` gives each reply. */
async function bindings({ answers = {}, hello = {}, onFrame } = {}) {
  const server = await proxyServer(onFrame);
  const calls = [];
  const control = {
    path: server.path,
    call: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
    onEvent: () => {},
  };
  const ego = await createEgoBindings({
    control,
    hello: { spaces: [], ...hello },
  });
  return {
    ego,
    calls,
    close() {
      ego.close();
      server.close();
    },
  };
}

async function captureStderr(fn) {
  const write = mock.method(process.stderr, "write", () => true);
  try {
    const result = await fn();
    return { result, stderr: write.mock.calls.map((c) => c.arguments[0]) };
  } finally {
    write.mock.restore();
  }
}

describe("CDP through the daemon proxy", () => {
  it("sends raw messages and passes replies to onCDPMessage", async () => {
    const { ego, close } = await bindings({
      hello: { spaces: [{ id: 1, ownership: "agent", control: "agent" }] },
      onFrame: (text, reply) => {
        const { id } = JSON.parse(text);
        reply({ id, result: { product: "Chrome/150" } });
      },
    });
    try {
      ego.useTaskSpace(1);
      const reply = new Promise((resolve) => {
        ego.onCDPMessage = resolve;
      });
      ego.sendCDPMessage(
        JSON.stringify({ id: 7, method: "Browser.getVersion" }),
      );
      assert.deepEqual(JSON.parse(await reply), {
        id: 7,
        result: { product: "Chrome/150" },
      });
    } finally {
      close();
    }
  });
});

describe("useTaskSpace", () => {
  it("says once that a browser restart closed the space's tabs", async () => {
    const { ego, close } = await bindings({
      hello: {
        spaces: [{ id: 5, lostTabs: ["https://news.test/story"] }, { id: 6 }],
      },
    });
    try {
      const { stderr } = await captureStderr(() => {
        ego.useTaskSpace(6);
        ego.useTaskSpace(5);
        ego.useTaskSpace(5);
      });
      assert.equal(stderr.length, 1);
      assert.match(stderr[0], /task space 5 lost its tabs/);
      assert.match(stderr[0], /https:\/\/news\.test\/story/);
      assert.match(stderr[0], /ego-browser restore 5/);
    } finally {
      close();
    }
  });
});

describe("handOffTaskSpace", () => {
  async function handOff(hello, answers = {}, options) {
    const { ego, calls, close } = await bindings({
      hello,
      answers: {
        handOffTaskSpace: "3 has been handed off to the user.",
        ...answers,
      },
    });
    try {
      ego.useTaskSpace(3);
      const { result, stderr } = await captureStderr(() =>
        options === undefined
          ? ego.handOffTaskSpace()
          : ego.handOffTaskSpace(options),
      );
      return { result, stderr, calls };
    } finally {
      close();
    }
  }

  it("warns that nobody can see a headless browser", async () => {
    const { result, stderr } = await handOff({ headless: true });
    assert.equal(result, "3 has been handed off to the user.");
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /headless/);
    assert.match(stderr[0], /ego-browser close --force 3/);
    assert.match(stderr[0], /ego-browser relay 3/);
  });

  it("stays quiet when the browser has a window", async () => {
    const { stderr } = await handOff({ headless: false, display: "desktop" });
    assert.deepEqual(stderr, []);
  });

  it("starts a viewer on a virtual display and prints its link", async () => {
    const { result, stderr, calls } = await handOff(
      { headless: false, display: "virtual" },
      {
        startViewer: {
          url: "http://127.0.0.1:6080/vnc.html?path=x",
          ssh: "ssh -N -L 6080:127.0.0.1:6080 me@box",
          expiresAt: Date.now() + 30 * 60_000,
        },
      },
    );
    assert.equal(result, "3 has been handed off to the user.");
    assert.deepEqual(calls.find((c) => c.method === "startViewer").params, {
      spaceId: 3,
    });
    assert.match(stderr[0], /http:\/\/127\.0\.0\.1:6080\/vnc\.html/);
    assert.match(stderr[0], /ssh -N -L 6080/);
  });

  it("says when the viewer cannot start", async () => {
    const { stderr } = await handOff(
      { display: "virtual" },
      {
        startViewer: {
          error: "The viewer needs x11vnc",
          error_code: "EGO_VIEWER_UNAVAILABLE",
        },
      },
    );
    assert.match(stderr[0], /no viewer could start: The viewer needs x11vnc/);
  });

  it("relay keeps control and returns the capture paths", async () => {
    const relay = {
      dir: "/s/relay/3-1",
      screenshot: "/s/relay/3-1/screenshot.png",
      snapshot: "/s/relay/3-1/snapshot.txt",
    };
    const { result, stderr, calls } = await handOff(
      { headless: true },
      { relay },
      { relay: true },
    );
    assert.deepEqual(result, { relay });
    assert.equal(
      calls.some((c) => c.method === "handOffTaskSpace"),
      false,
    );
    assert.match(stderr[0], /screenshot\.png/);
  });

  it("rejects options that are not an object", async () => {
    const { ego, close } = await bindings();
    try {
      await assert.rejects(ego.handOffTaskSpace("now"), {
        error_code: "EGO_INVALID_ARGUMENT",
      });
    } finally {
      close();
    }
  });
});

describe("host extensions", () => {
  it("createTaskSpace passes ttlMs and checks it", async () => {
    const { ego, calls, close } = await bindings({
      answers: { createTaskSpace: { id: 1, name: "a", taskId: "a" } },
    });
    try {
      await ego.createTaskSpace("a", undefined, { ttlMs: 60_000 });
      assert.deepEqual(calls.at(-1).params, {
        name: "a",
        profileId: undefined,
        ttlMs: 60_000,
      });
      await assert.rejects(ego.createTaskSpace("b", undefined, { ttlMs: -1 }), {
        error_code: "EGO_INVALID_ARGUMENT",
      });
    } finally {
      close();
    }
  });

  it("taskSpaceMemo reads, writes and refuses non-JSON values", async () => {
    const { ego, calls, close } = await bindings({
      answers: {
        memo: (params) => ({
          found: params.hasValue,
          value: params.value ?? null,
        }),
      },
    });
    try {
      assert.equal(
        (await ego.taskSpaceMemo("k")).error_code,
        "EGO_TASK_SPACE_NOT_SELECTED",
      );
      ego.useTaskSpace(2);
      await ego.taskSpaceMemo("k", { at: 1 });
      assert.deepEqual(calls.at(-1).params, {
        id: 2,
        key: "k",
        value: { at: 1 },
        hasValue: true,
      });
      await ego.taskSpaceMemo("k");
      assert.deepEqual(calls.at(-1).params, {
        id: 2,
        key: "k",
        hasValue: false,
      });
      await assert.rejects(
        ego.taskSpaceMemo("k", () => 1),
        {
          error_code: "EGO_INVALID_ARGUMENT",
        },
      );
    } finally {
      close();
    }
  });

  it("reports its capabilities", async () => {
    const { ego, close } = await bindings({ hello: { display: "virtual" } });
    try {
      const caps = ego.getHostCapabilities();
      assert.equal(caps.taskSpaceTtl, true);
      assert.equal(caps.handOffViewer, true);
    } finally {
      close();
    }
  });

  it("logs binding calls with their result code, without arguments", async () => {
    const { ego, calls, close } = await bindings({
      hello: { round: "9.1" },
      answers: {
        listTabs: { error: "x", error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" },
      },
    });
    try {
      ego.useTaskSpace(4);
      await ego.listTabs();
      await ego.flushLog();
      const { entries } = calls.find((c) => c.method === "log").params;
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, "listTabs");
      assert.equal(entries[0].space, 4);
      assert.equal(entries[0].round, "9.1");
      assert.equal(entries[0].ok, false);
      assert.equal(entries[0].error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    } finally {
      close();
    }
  });
});

describe("createRoundLogger", () => {
  it("logs actions from raw CDP with origin only, and counts keys", async () => {
    const sent = [];
    const control = {
      call: async (_m, params) => sent.push(...params.entries),
    };
    let clock = 1000;
    const logger = createRoundLogger(control, "1.1", () => clock);
    try {
      logger.command(
        JSON.stringify({
          id: 3,
          method: "Page.navigate",
          params: { url: "https://bank.test/reset/SECRET?token=abc" },
        }),
        2,
      );
      logger.command(
        JSON.stringify({
          id: 4,
          method: "Input.insertText",
          params: { text: "hunter2" },
        }),
        2,
      );
      logger.command(
        JSON.stringify({
          id: 5,
          method: "Input.dispatchKeyEvent",
          params: { type: "keyDown", text: "a" },
        }),
        2,
      );
      logger.command(
        JSON.stringify({ id: 6, method: "Runtime.evaluate", params: {} }),
        2,
      );
      clock = 1250;
      logger.reply(
        '{"id":3,"result":{"frameId":"F","errorText":"net::ERR_NAME_NOT_RESOLVED"}}',
      );
      logger.reply('{"id":4,"error":{"code":-32000,"message":"x"}}');
      logger.reply('{"id":6,"result":{}}');
      logger.add({ kind: "round", event: "end", exit: 0 });
      await logger.flush();
    } finally {
      logger.stop();
    }
    const text = JSON.stringify(sent);
    assert.doesNotMatch(text, /SECRET|token=abc|hunter2|"a"/);
    assert.deepEqual(
      sent.map((e) => [e.action, e.target, e.ok, e.error_code, e.ms]),
      [
        ["Page.navigate", "https://bank.test", false, "NAVIGATION_FAILED", 250],
        ["Input.insertText", undefined, false, "CDP_ERROR", 250],
        [undefined, undefined, undefined, undefined, undefined],
      ],
    );
    assert.equal(sent[2].count, 2);
    assert.equal(sent[2].message, "1 key events");
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
