import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { validate } from "./json-schema.mjs";
import {
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOL_DEFINITIONS,
  runMcpStdio,
} from "./mcp-server.mjs";

const BIN = fileURLToPath(new URL("../bin/ego-browser.mjs", import.meta.url));

// --- a fake SDK session -----------------------------------------------------

function fakeBrowser() {
  const log = {
    created: [],
    reused: [],
    closed: [],
    sessionClosed: 0,
    opened: 0,
    actions: [],
  };
  const spaces = new Map();
  let nextId = 10;
  const makePage = (label) => ({
    label,
    waitForResponse: async () => ({ status: 200 }),
    goto: async (url) => log.actions.push(["goto", label, url]),
    waitForSettled: async () => ({ settled: true }),
    dismissConsent: async () => ({ found: false, action: "none" }),
    evaluate: async (expression) =>
      expression === "BOT"
        ? null
        : expression.includes("throw")
          ? Promise.reject(new Error("boom"))
          : { value: 42 },
    url: async () => "https://a.test/",
    title: async () => "A page",
    snapshot: async () => `[page ${label}]\n@1 button "Go"`,
    click: async (target) => {
      log.actions.push(["click", target]);
      if (target === "@99") {
        throw Object.assign(new Error("Stale ref @99"), {
          error_code: "EGO_STALE_REF",
          hint: "Refs last one page state. Take a new snapshot and use the new ref.",
        });
      }
      return { popups: [{ label: "p2" }] };
    },
    fill: async (target, value) => log.actions.push(["fill", target, value]),
    read: async () => ({
      url: "https://a.test/",
      title: "A page",
      markdown: "Hello world",
      words: 2,
      truncated: false,
    }),
    tables: async () => [
      { index: 0, headers: ["a"], rows: [{ a: "1" }], rowCount: 1 },
    ],
    search: async () => ({
      engine: null,
      query: "q",
      results: [],
      blocked: [{ engine: "bing", reason: "captcha", hint: "Try later." }],
    }),
    screenshot: async ({ path }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return path;
    },
    waitForSelector: async () => true,
    fillSecret: async (_target, secret) => ({
      filled: true,
      secret,
      origin: "https://a.test",
    }),
  });
  const makeTask = (id) => ({
    spaceId: id,
    page: (label) => makePage(label),
    newPage: async () => makePage("p2"),
    finish: async () => {
      spaces.delete(id);
      return { spaceId: id, closedSpace: true };
    },
    handOff: async () => {},
    pages: async () => [makePage("p1")],
  });
  const sdk = {
    taskSpace: async (nameOrId, options) => {
      if (typeof nameOrId === "number") {
        if (!spaces.has(nameOrId)) {
          throw Object.assign(new Error("Task space not found"), {
            error_code: "EGO_TASK_SPACE_NOT_FOUND",
          });
        }
        if (spaces.get(nameOrId).userControl) {
          const message = spaces.get(nameOrId).userControl;
          throw Object.assign(
            new Error(
              typeof message === "string"
                ? message
                : "task.restorePages: manual_takeover",
            ),
            { error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" },
          );
        }
        log.reused.push(nameOrId);
        return makeTask(nameOrId);
      }
      const id = nextId++;
      spaces.set(id, { name: nameOrId, options });
      log.created.push({ name: nameOrId, options });
      return makeTask(id);
    },
    takeOverTaskSpace: async (id) => makeTask(id),
  };
  const session = {
    hello: { display: "headless" },
    control: {
      call: async (method, params) => {
        if (method === "listTaskSpaces") {
          return {
            taskSpaces: [...spaces].map(([id, s]) => ({
              id,
              name: s.name,
              ownership: "agent",
            })),
          };
        }
        if (method === "closeTaskSpace") {
          log.closed.push(params.id);
          if (params.id === 999) {
            return {
              error: "user controls it",
              error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
            };
          }
          spaces.delete(params.id);
          return `task space ${params.id} closed`;
        }
        return null;
      },
    },
    round: async (fn) => ({ value: await fn(sdk), output: "" }),
    runScript: async (source) => {
      if (source.includes("throw")) {
        throw Object.assign(new Error("script failed"), {
          output: "partial\n",
        });
      }
      return "printed\n";
    },
    close: async () => {
      log.sessionClosed += 1;
    },
  };
  return { session, log, spaces };
}

function makeServer(browser = fakeBrowser(), options = {}) {
  let opens = 0;
  const server = new McpServer({
    version: "test",
    openSession: async () => {
      opens += 1;
      browser.log.opened = opens;
      return browser.session;
    },
    ...options,
  });
  return { server, browser };
}

const call = (server, name, args, id = 1) =>
  server.handle({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

// --- protocol ------------------------------------------------------------------

test("initialize negotiates the protocol version and lists tools capability", async () => {
  const { server } = makeServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    },
  });
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, {
    tools: { listChanged: false },
  });
  assert.equal(response.result.serverInfo.name, "ego-browser");
  assert.match(response.result.instructions, /browser_open/);

  const other = await server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  });
  assert.equal(other.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test("notifications get no response; ping answers; unknown methods fail", async () => {
  const { server } = makeServer();
  assert.equal(
    await server.handle({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    null,
  );
  assert.deepEqual(
    (await server.handle({ jsonrpc: "2.0", id: 3, method: "ping" })).result,
    {},
  );
  const unknown = await server.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "nope/nothing",
  });
  assert.equal(unknown.error.code, -32601);
  const invalid = await server.handle({ id: 5, method: "ping" });
  assert.equal(invalid.error.code, -32600);
});

test("tools/list returns every tool with an object input schema", async () => {
  const { server } = makeServer();
  const response = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  const names = response.result.tools.map((t) => t.name);
  for (const name of [
    "browser_open",
    "browser_snapshot",
    "browser_act",
    "browser_read",
    "browser_tables",
    "browser_search",
    "browser_screenshot",
    "browser_evaluate",
    "browser_wait_for",
    "browser_fill_secret",
    "browser_handoff",
    "browser_takeover",
    "browser_spaces",
    "browser_close_space",
    "browser_finish",
    "browser_run",
  ]) {
    assert.ok(names.includes(name), name);
  }
  for (const definition of response.result.tools) {
    assert.equal(definition.inputSchema.type, "object");
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.ok(definition.description.length > 20);
  }
});

test("tools/call: unknown tool is a protocol error, bad arguments a tool error", async () => {
  const { server, browser } = makeServer();
  const unknown = await call(server, "browser_fly", {});
  assert.equal(unknown.error.code, -32602);
  const bad = await call(server, "browser_open", { url: 5, extra: true });
  assert.equal(bad.result.isError, true);
  const text = bad.result.content[0].text;
  assert.match(text, /arguments\.url must be string/);
  assert.match(text, /arguments\.extra is not a known argument/);
  assert.match(text, /error_code: EGO_INVALID_ARGUMENT/);
  assert.match(text, /hint: /);
  const missing = await call(server, "browser_search", {});
  assert.match(missing.result.content[0].text, /arguments\.query is required/);
  // Validation happens before the browser is touched.
  assert.equal(browser.log.opened, 0);
});

test("browser_open creates one space per task and reuses it", async () => {
  const { server, browser } = makeServer();
  const first = await call(server, "browser_open", { url: "https://a.test/" });
  assert.equal(first.result.isError, undefined);
  assert.match(first.result.content[0].text, /space: 10 \(task "main"\)/);
  assert.match(first.result.content[0].text, /page: p1/);
  assert.match(first.result.content[1].text, /@1 button/);
  await call(server, "browser_snapshot", {});
  await call(server, "browser_open", {
    url: "https://b.test/",
    task: "second",
  });
  assert.equal(browser.log.created.length, 2);
  assert.deepEqual(browser.log.reused, [10]);
  assert.equal(browser.log.created[0].options.ttlMs, 30 * 60_000);
  assert.equal(browser.log.created[0].options.restorePages, true);
  assert.match(browser.log.created[0].name, /^mcp main /);
  assert.equal(browser.log.opened, 1);
});

test("browser_act reports the receipt; SDK errors carry error_code and hint", async () => {
  const { server, browser } = makeServer();
  await call(server, "browser_open", { url: "https://a.test/" });
  const ok = await call(server, "browser_act", {
    action: "click",
    target: "@1",
  });
  assert.match(ok.result.content[0].text, /click done; opened page\(s\): p2/);
  const stale = await call(server, "browser_act", {
    action: "click",
    target: "@99",
  });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /error_code: EGO_STALE_REF/);
  assert.match(stale.result.content[0].text, /hint: Refs last one page state/);
  const noValue = await call(server, "browser_act", {
    action: "fill",
    target: "@2",
  });
  assert.equal(noValue.result.isError, true);
  assert.match(noValue.result.content[0].text, /fill needs a value/);
  assert.deepEqual(
    browser.log.actions.filter((a) => a[0] === "fill"),
    [],
  );
});

test("read, tables, evaluate, screenshot, fill_secret and run", async () => {
  const { server } = makeServer();
  const read = await call(server, "browser_read", { url: "https://a.test/" });
  assert.match(
    read.result.content[0].text,
    /^# A page\nurl: https:\/\/a\.test\//,
  );
  const tables = await call(server, "browser_tables", {});
  assert.deepEqual(JSON.parse(tables.result.content[0].text)[0].rows, [
    { a: "1" },
  ]);
  const evaluated = await call(server, "browser_evaluate", {
    expression: "1+1",
  });
  assert.deepEqual(JSON.parse(evaluated.result.content[0].text), { value: 42 });
  const shot = await call(server, "browser_screenshot", {});
  assert.equal(shot.result.content[0].type, "image");
  assert.equal(shot.result.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(shot.result.content[0].data, "base64")[1], 0x50);
  const secret = await call(server, "browser_fill_secret", {
    target: "@3",
    secret: "github",
  });
  assert.match(
    secret.result.content[0].text,
    /secret github typed on https:\/\/a\.test/,
  );
  const run = await call(server, "browser_run", { script: "console.log(1)" });
  assert.equal(run.result.content[0].text, "printed\n");
  const failed = await call(server, "browser_run", { script: "throw 1" });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[1].text, /partial/);
});

test("browser_search reports a blocked search as an error with a hint", async () => {
  const { server } = makeServer();
  const result = await call(server, "browser_search", { query: "q" });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /EGO_SITE_BLOCKED/);
  assert.match(result.result.content[0].text, /hint: Try later\./);
});

test("browser_finish closes the space and forgets the task", async () => {
  const { server, browser } = makeServer();
  await call(server, "browser_open", { url: "https://a.test/" });
  const finished = await call(server, "browser_finish", {});
  assert.equal(JSON.parse(finished.result.content[0].text).closedSpace, true);
  assert.equal(browser.spaces.size, 0);
  await server.shutdown();
  assert.deepEqual(browser.log.closed, []);
});

test("a space closed elsewhere is forgotten and recreated", async () => {
  const { server, browser } = makeServer();
  await call(server, "browser_open", { url: "https://a.test/" });
  browser.spaces.clear();
  const gone = await call(server, "browser_snapshot", {});
  assert.match(gone.result.content[0].text, /EGO_TASK_SPACE_NOT_FOUND/);
  await call(server, "browser_snapshot", {});
  assert.equal(browser.log.created.length, 2);
});

test("a task the user controls fails with a clean error and a hint", async () => {
  const { server, browser } = makeServer();
  await call(server, "browser_open", { url: "https://a.test/" });
  browser.spaces.get(10).userControl = true;
  const res = await call(server, "browser_snapshot", {});
  assert.equal(res.result.isError, true);
  const text = res.result.content[0].text;
  assert.doesNotMatch(text, /task\.restorePages/);
  assert.match(
    text,
    /The user controls space 10 \(task "main", reason: manual_takeover\)/,
  );
  assert.match(text, /error_code: EGO_TASK_SPACE_USER_IN_CONTROL/);
  assert.match(text, /hint: .*browser_takeover/);
  // The SDK's long message for scripts (with JavaScript to run) is dropped.
  browser.spaces.get(10).userControl =
    "page.snapshot: Control of this task space is with the user.\nWait, then:\n  const task = await takeOverTaskSpace(10);";
  const long = await call(server, "browser_snapshot", {});
  const longText = long.result.content[0].text;
  assert.match(longText, /The user controls space 10 \(task "main"\)\./);
  assert.doesNotMatch(longText, /takeOverTaskSpace|const task/);
  // The task is kept, so browser_takeover can still find it.
  browser.spaces.get(10).userControl = false;
  const back = await call(server, "browser_snapshot", {});
  assert.equal(back.result.isError, undefined);
});

test("browser_spaces marks this session's tasks; close_space closes by id", async () => {
  const { server, browser } = makeServer();
  await call(server, "browser_open", {
    url: "https://a.test/",
    task: "research",
  });
  const list = JSON.parse(
    (await call(server, "browser_spaces", {})).result.content[0].text,
  );
  assert.deepEqual(list, [
    { id: 10, name: list[0].name, ownership: "agent", task: "research" },
  ]);
  const closed = await call(server, "browser_close_space", { space: 10 });
  assert.match(closed.result.content[0].text, /closed/);
  const refused = await call(server, "browser_close_space", { space: 999 });
  assert.equal(refused.result.isError, true);
  assert.match(
    refused.result.content[0].text,
    /EGO_TASK_SPACE_USER_IN_CONTROL/,
  );
  await server.shutdown();
  assert.deepEqual(browser.log.closed, [10, 999]);
});

test("a hung tool call times out with a hint and the next call still runs", async () => {
  const browser = fakeBrowser();
  const { server } = makeServer(browser, { toolTimeoutMs: 30 });
  const original = browser.session.round;
  browser.session.round = () => new Promise(() => {});
  const hung = await call(server, "browser_snapshot", {});
  assert.equal(hung.result.isError, true);
  assert.match(hung.result.content[0].text, /EGO_TOOL_TIMEOUT/);
  browser.session.round = original;
  const next = await call(server, "browser_snapshot", {});
  assert.equal(next.result.isError, undefined);
});

test("calls run one at a time", async () => {
  const browser = fakeBrowser();
  const { server } = makeServer(browser);
  let active = 0;
  let peak = 0;
  const original = browser.session.round;
  browser.session.round = async (fn) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await original(fn);
    } finally {
      active -= 1;
    }
  };
  await Promise.all(
    [1, 2, 3].map((id) => call(server, "browser_snapshot", {}, id)),
  );
  assert.equal(peak, 1);
});

// --- stdio transport and cleanup on disconnect -----------------------------

function stdioPair(server, options = {}) {
  const input = new PassThrough();
  const lines = [];
  const transport = runMcpStdio(server, {
    input,
    write: (text) =>
      lines.push(
        ...text
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l)),
      ),
    ...options,
  });
  const send = (message) =>
    input.write(
      `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
    );
  return { input, lines, transport, send };
}

test("stdio: answers line by line, reports parse errors, drains on disconnect", async () => {
  const { server, browser } = makeServer();
  const { input, lines, transport, send } = stdioPair(server);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send("{not json");
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "browser_open", arguments: { url: "https://a.test/" } },
  });
  input.end();
  await transport.done;
  assert.equal(lines.length, 3);
  assert.equal(
    lines.find((l) => l.id === 1).result.protocolVersion,
    "2025-06-18",
  );
  assert.equal(lines.find((l) => l.error?.code === -32700).id, null);
  assert.match(
    lines.find((l) => l.id === 2).result.content[0].text,
    /space: 10/,
  );
  // The disconnect closed the session's space and the SDK session.
  assert.deepEqual(browser.log.closed, [10]);
  assert.equal(browser.log.sessionClosed, 1);
});

test("stdio: stop() closes spaces at once; a handed-off space stays open", async () => {
  const browser = fakeBrowser();
  const { server } = makeServer(browser);
  const logLines = [];
  server.log = (line) => logLines.push(line);
  const { transport, send } = stdioPair(server);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "browser_open", arguments: { url: "https://a.test/" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.tasks.set("theirs", { spaceId: 999, name: "x" });
  await transport.stop();
  assert.deepEqual(browser.log.closed.sort(), [10, 999]);
  assert.ok(logLines.some((line) => /left task space 999/.test(line)));
  assert.equal(browser.log.sessionClosed, 1);
});

test("stdio: no browser session is opened when no tool runs", async () => {
  const { server, browser } = makeServer();
  const { input, transport, send } = stdioPair(server);
  send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  input.end();
  await transport.done;
  assert.equal(browser.log.opened, 0);
  assert.equal(browser.log.sessionClosed, 0);
});

test("ego-browser mcp speaks MCP on stdout and exits when stdin closes", async () => {
  const child = spawn(process.execPath, [BIN, "mcp", "--sdk-path", BIN], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, EGO_LITE_SOCKET: "/nonexistent/ego-test.sock" },
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exit = new Promise((resolve) => child.on("exit", resolve));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`,
  );
  child.stdin.end();
  assert.equal(await exit, 0);
  const messages = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].result.serverInfo.name, "ego-browser");
  assert.equal(messages[1].result.tools.length, TOOL_DEFINITIONS.length);
});

// --- the schema validator ---------------------------------------------------

test("validate covers types, enums, bounds, required, extras and anyOf", () => {
  const schema = {
    type: "object",
    properties: {
      n: { type: "integer", minimum: 1, maximum: 3 },
      s: { type: "string", minLength: 1, enum: ["a", "b"] },
      list: { type: "array", items: { type: "string" }, minItems: 1 },
      keep: {
        anyOf: [
          { type: "string", enum: ["all"] },
          { type: "array", items: { type: "string" } },
        ],
      },
    },
    required: ["n"],
    additionalProperties: false,
  };
  assert.deepEqual(
    validate(schema, { n: 2, s: "a", list: ["x"], keep: "all" }),
    [],
  );
  assert.deepEqual(validate(schema, { n: 2, keep: ["p1"] }), []);
  const errors = validate(schema, {
    n: 1.5,
    s: "",
    list: [1],
    keep: "some",
    z: 1,
  });
  assert.ok(errors.some((e) => /arguments\.n must be integer/.test(e)));
  assert.ok(errors.some((e) => /arguments\.s must not be empty/.test(e)));
  assert.ok(errors.some((e) => /arguments\.list\[0\] must be string/.test(e)));
  assert.ok(errors.some((e) => /arguments\.keep must be/.test(e)));
  assert.ok(errors.some((e) => /arguments\.z is not a known argument/.test(e)));
  assert.deepEqual(validate(schema, {}), ["arguments.n is required"]);
  assert.deepEqual(validate(schema, { n: 9 }), [
    "arguments.n must be at most 3",
  ]);
  assert.deepEqual(validate(schema, []), [
    "arguments must be object, not array",
  ]);
});
