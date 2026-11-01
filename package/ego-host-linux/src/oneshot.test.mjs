import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TIMEOUT_MS,
  EXIT,
  UsageError,
  exitCodeFor,
  markdownTable,
  normalizeUrl,
  parseDuration,
  parseOneShotArgs,
  runOneShot,
} from "./oneshot.mjs";

test("parseOneShotArgs reads a URL with the defaults", () => {
  const options = parseOneShotArgs("read", ["https://example.com/post"]);
  assert.equal(options.command, "read");
  assert.equal(options.url, "https://example.com/post");
  assert.equal(options.profileId, "ephemeral");
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(options.json, false);
  assert.equal(options.mode, "article");
});

test("parseOneShotArgs takes --json, --profile, --timeout and = forms", () => {
  const options = parseOneShotArgs("read", [
    "--json",
    "--profile",
    "Default",
    "--timeout=90s",
    "--max-chars",
    "500",
    "example.com",
  ]);
  assert.equal(options.json, true);
  assert.equal(options.profileId, "Default");
  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.maxChars, 500);
  assert.equal(options.url, "https://example.com/");
});

test("parseOneShotArgs: shot, tables and snapshot options", () => {
  const shot = parseOneShotArgs("shot", [
    "https://a.test",
    "--full",
    "-o",
    "/tmp/x.png",
  ]);
  assert.equal(shot.fullPage, true);
  assert.equal(shot.out, "/tmp/x.png");
  const tables = parseOneShotArgs("tables", [
    "https://a.test",
    "--csv",
    "--index",
    "2",
    "--out",
    "/tmp/t",
  ]);
  assert.equal(tables.csv, true);
  assert.equal(tables.index, 2);
  assert.equal(tables.out, "/tmp/t");
  const snapshot = parseOneShotArgs("snapshot", ["https://a.test", "--full"]);
  assert.equal(snapshot.fullPage, true);
});

test("parseOneShotArgs: search joins the query words", () => {
  const options = parseOneShotArgs("search", [
    "linux",
    "browser",
    "--max",
    "5",
    "--engine",
    "bing",
  ]);
  assert.equal(options.query, "linux browser");
  assert.equal(options.max, 5);
  assert.equal(options.engine, "bing");
  assert.equal(options.url, undefined);
});

test("parseOneShotArgs rejects bad input with UsageError", () => {
  const bad = [
    ["read", []],
    ["read", ["https://a.test", "https://b.test"]],
    ["read", ["https://a.test", "--full"]],
    ["read", ["https://a.test", "--mode", "summary"]],
    ["read", ["ftp://a.test/file"]],
    ["read", ["https://a.test", "--profile"]],
    ["shot", ["https://a.test", "--timeout", "soon"]],
    ["tables", ["https://a.test", "--out", "/tmp/t"]],
    ["tables", ["https://a.test", "--index", "-1"]],
    ["search", []],
    ["search", ["q", "--engine", "yahoo"]],
    ["search", ["q", "--max", "0"]],
    ["open", ["https://a.test"]],
  ];
  for (const [command, args] of bad) {
    assert.throws(
      () => parseOneShotArgs(command, args),
      UsageError,
      `${command} ${args.join(" ")}`,
    );
  }
});

test("parseDuration accepts s, ms, m and h within bounds", () => {
  assert.equal(parseDuration("30"), 30_000);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("1500ms"), 1500);
  assert.equal(parseDuration("2m"), 120_000);
  assert.equal(parseDuration("2h", "--ttl", 24 * 3_600_000), 7_200_000);
  assert.throws(() => parseDuration("10ms"), UsageError);
  assert.throws(() => parseDuration("2h"), UsageError);
  assert.throws(() => parseDuration("x"), UsageError);
});

test("normalizeUrl adds https and refuses other schemes", () => {
  assert.equal(
    normalizeUrl("en.wikipedia.org/wiki/Linux"),
    "https://en.wikipedia.org/wiki/Linux",
  );
  assert.equal(normalizeUrl("http://a.test/"), "http://a.test/");
  assert.throws(() => normalizeUrl("javascript:alert(1)"), UsageError);
  assert.throws(() => normalizeUrl("file:///etc/passwd"), UsageError);
});

test("exitCodeFor maps blocked, HTTP and timeout errors", () => {
  assert.equal(exitCodeFor({ error_code: "EGO_SITE_BLOCKED" }), EXIT.blocked);
  assert.equal(
    exitCodeFor({ error_code: "EGO_NAVIGATION_HTTP_ERROR" }),
    EXIT.http,
  );
  assert.equal(exitCodeFor({ code: "EGO_NAVIGATION_TIMEOUT" }), EXIT.timeout);
  assert.equal(
    exitCodeFor({ error_code: "EGO_ONE_SHOT_TIMEOUT" }),
    EXIT.timeout,
  );
  assert.equal(exitCodeFor(new Error("boom")), EXIT.error);
});

test("markdownTable escapes pipes and keeps header order", () => {
  const text = markdownTable({
    index: 0,
    caption: "Prices",
    headers: ["Name", "Price"],
    rows: [{ Name: "a|b", Price: "1" }],
    rowCount: 1,
  });
  assert.match(text, /### Table 0: Prices \(1 rows\)/);
  assert.match(text, /\| Name \| Price \|/);
  assert.match(text, /\| a\\\|b \| 1 \|/);
});

// --- runOneShot against a fake SDK session ---------------------------------

function fakePage(overrides = {}) {
  const calls = [];
  const page = {
    label: "p1",
    calls,
    waitForResponse: async () => ({ status: 200, resourceType: "Document" }),
    goto: async (url) => {
      calls.push(["goto", url]);
      return {};
    },
    waitForSettled: async () => ({ settled: true }),
    dismissConsent: async () => ({
      found: true,
      action: "reject",
      framework: "onetrust",
    }),
    evaluate: async () => null,
    read: async () => ({
      url: "https://a.test/",
      title: "A",
      markdown: "# A\n\nHello",
      words: 2,
      truncated: false,
      links: [],
      source: "article",
    }),
    url: async () => "https://a.test/",
    title: async () => "A",
    snapshot: async () => ({ text: "[page] A\n@1 link", warnings: [] }),
    tables: async () => [],
    screenshot: async ({ path }) => path,
    search: async () => ({
      engine: "bing",
      query: "q",
      results: [],
      blocked: [],
    }),
    ...overrides,
  };
  return page;
}

function fakeSession(page, { taskSpace } = {}) {
  const log = { finished: 0, closedViaControl: [], closed: 0, created: [] };
  const task = {
    spaceId: 41,
    page: () => page,
    finish: async () => {
      log.finished += 1;
      return { closedSpace: true };
    },
  };
  const sdk = {
    taskSpace:
      taskSpace ??
      (async (name, options) => {
        log.created.push({ name, options });
        return task;
      }),
  };
  return {
    log,
    session: {
      control: {
        call: async (method, params) => {
          if (method === "closeTaskSpace") log.closedViaControl.push(params.id);
          return "closed";
        },
      },
      round: async (fn) => ({ value: await fn(sdk), output: "" }),
      close: async () => {
        log.closed += 1;
      },
    },
  };
}

function streams() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
}

test("runOneShot read prints Markdown, rejects consent and finishes the space", async () => {
  const page = fakePage();
  const { session, log } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("read", ["https://a.test"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, 0);
  assert.equal(io.out.join(""), "# A\n\nHello\n");
  assert.equal(log.finished, 1);
  assert.equal(log.closed, 1);
  assert.equal(log.created[0].options.profileId, "ephemeral");
  assert.ok(log.created[0].options.ttlMs > DEFAULT_TIMEOUT_MS);
});

test("runOneShot --json prints the full object", async () => {
  const { session } = fakeSession(fakePage());
  const io = streams();
  const code = await runOneShot(
    parseOneShotArgs("read", ["https://a.test", "--json"]),
    { openSession: async () => session, ...io },
  );
  assert.equal(code, 0);
  const json = JSON.parse(io.out.join(""));
  assert.equal(json.title, "A");
  assert.equal(json.status, 200);
  assert.deepEqual(json.consent, { action: "reject", framework: "onetrust" });
});

test("runOneShot exits 4 on an HTTP error and still finishes the space", async () => {
  const page = fakePage({
    waitForResponse: async () => ({ status: 404, resourceType: "Document" }),
  });
  const { session, log } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(
    parseOneShotArgs("read", ["https://a.test", "--json"]),
    { openSession: async () => session, ...io },
  );
  assert.equal(code, EXIT.http);
  assert.equal(log.finished, 1);
  assert.equal(log.closed, 1);
  const json = JSON.parse(io.out.join(""));
  assert.equal(json.ok, false);
  assert.equal(json.error_code, "EGO_NAVIGATION_HTTP_ERROR");
  assert.equal(json.status, 404);
  assert.match(io.err.join(""), /hint: /);
});

test("runOneShot exits 3 on a bot check", async () => {
  const page = fakePage({
    evaluate: async () => "a captcha or challenge form",
  });
  const { session, log } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(
    parseOneShotArgs("snapshot", ["https://a.test"]),
    {
      openSession: async () => session,
      ...io,
    },
  );
  assert.equal(code, EXIT.blocked);
  assert.equal(log.finished, 1);
  assert.match(io.err.join(""), /EGO_SITE_BLOCKED/);
});

test("runOneShot finishes the space when a step throws", async () => {
  const page = fakePage({
    goto: async () => {
      throw Object.assign(
        new Error("page.goto failed: net::ERR_NAME_NOT_RESOLVED"),
        {
          error_code: "EGO_NAVIGATION_FAILED",
          hint: "Check the host name and the network.",
        },
      );
    },
  });
  const { session, log } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(
    parseOneShotArgs("shot", ["https://nope.test"]),
    {
      openSession: async () => session,
      ...io,
    },
  );
  assert.equal(code, EXIT.error);
  assert.equal(log.finished, 1);
  assert.equal(log.closed, 1);
  assert.match(io.err.join(""), /hint: Check the host name/);
  assert.equal(io.out.join(""), "");
});

test("runOneShot closes the space through the daemon when finish() fails", async () => {
  const page = fakePage({
    read: async () => {
      throw new Error("read failed");
    },
  });
  const { session, log } = fakeSession(page);
  const task = {
    spaceId: 77,
    page: () => page,
    finish: async () => {
      throw new Error("finish failed");
    },
  };
  session.round = async (fn) => ({
    value: await fn({ taskSpace: async () => task }),
    output: "",
  });
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("read", ["https://a.test"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, EXIT.error);
  assert.deepEqual(log.closedViaControl, [77]);
});

test("runOneShot exits 5 on its timeout and closes the space", async () => {
  const page = fakePage({ goto: () => new Promise(() => {}) });
  const { session, log } = fakeSession(page);
  const io = streams();
  const options = parseOneShotArgs("read", ["https://a.test"]);
  options.timeoutMs = 50; // below the CLI minimum, for the test only
  const code = await runOneShot(options, {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, EXIT.timeout);
  assert.deepEqual(log.closedViaControl, [41]);
  assert.equal(log.closed, 1);
  assert.match(io.err.join(""), /EGO_ONE_SHOT_TIMEOUT/);
});

test("runOneShot on Ctrl-C closes the space and exits 130", async () => {
  const page = fakePage({ goto: () => new Promise(() => {}) });
  const { session, log } = fakeSession(page);
  const io = streams();
  let fire;
  const code = await Promise.all([
    runOneShot(parseOneShotArgs("read", ["https://a.test"]), {
      openSession: async () => session,
      onInterrupt: (handler) => {
        fire = handler;
        return () => {};
      },
      ...io,
    }),
    new Promise((resolve) => setTimeout(() => resolve(fire()), 20)),
  ]).then(([value]) => value);
  assert.equal(code, 130);
  assert.deepEqual(log.closedViaControl, [41]);
});

test("runOneShot exits 1 with the reason when the daemon cannot start", async () => {
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("read", ["https://a.test"]), {
    openSession: async () => {
      throw Object.assign(new Error("ego lite daemon did not start"), {
        error_code: "EGO_BROWSER_UNAVAILABLE",
      });
    },
    ...io,
  });
  assert.equal(code, EXIT.error);
  assert.match(io.err.join(""), /daemon did not start/);
});

test("runOneShot search exits 3 when every engine is blocked", async () => {
  const page = fakePage({
    search: async () => ({
      engine: null,
      query: "q",
      results: [],
      blocked: [
        { engine: "bing", reason: "captcha", hint: "Use another engine." },
      ],
    }),
  });
  const { session, log } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("search", ["q"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, EXIT.blocked);
  assert.equal(log.finished, 1);
});

test("runOneShot search prints numbered results", async () => {
  const page = fakePage({
    search: async () => ({
      engine: "bing",
      query: "q",
      results: [
        { rank: 1, title: "One", url: "https://one.test/", snippet: "first" },
      ],
      blocked: [],
    }),
  });
  const { session } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("search", ["q"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, 0);
  assert.equal(io.out.join(""), "1. One\n   https://one.test/\n   first\n");
});

test("runOneShot tables --csv --out writes one file per table", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oneshot-test-"));
  try {
    const page = fakePage({
      tables: async () => [
        {
          index: 0,
          headers: ["a"],
          rows: [{ a: "1" }],
          rowCount: 1,
          csv: "a\n1",
        },
        {
          index: 1,
          headers: ["b"],
          rows: [{ b: "2" }],
          rowCount: 1,
          csv: "b\n2",
        },
      ],
    });
    const { session } = fakeSession(page);
    const io = streams();
    const code = await runOneShot(
      parseOneShotArgs("tables", ["https://a.test", "--csv", "--out", dir]),
      { openSession: async () => session, ...io },
    );
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, "table-1.csv"), "utf8"), "b\n2\n");
    assert.equal(io.out.join("").trim().split("\n").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOneShot tables --out never writes through a symbolic link", async () => {
  const { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "oneshot-test-"));
  try {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(dir, "table-0.csv"));
    const page = fakePage({
      tables: async () => [
        { index: 0, headers: ["a"], rows: [], rowCount: 0, csv: "a" },
      ],
    });
    const { session } = fakeSession(page);
    const io = streams();
    const code = await runOneShot(
      parseOneShotArgs("tables", ["https://a.test", "--csv", "--out", dir]),
      { openSession: async () => session, ...io },
    );
    assert.notEqual(code, 0);
    assert.match(io.err.join(""), /symbolic link/);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runOneShot shot saves to a private folder by default", async () => {
  const { statSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const page = fakePage({});
  const { session } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("shot", ["https://a.test"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, 0);
  const saved = io.out.join("").trim();
  assert.match(saved, /ego-browser-shot-[^/]+\/a\.test-\d+\.png$/);
  assert.equal(statSync(dirname(saved)).mode & 0o777, 0o700);
});

test("runOneShot retries a navigation once after a network blip", async () => {
  let attempts = 0;
  const page = fakePage({
    goto: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error("page.goto failed: net::ERR_NETWORK_CHANGED"),
          { error_code: "EGO_NAVIGATION_FAILED" },
        );
      }
      return {};
    },
  });
  const { session } = fakeSession(page);
  const io = streams();
  const code = await runOneShot(parseOneShotArgs("read", ["https://a.test"]), {
    openSession: async () => session,
    ...io,
  });
  assert.equal(code, 0);
  assert.equal(attempts, 2);
});
