import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  RoundLog,
  formatEntry,
  readLogs,
  redactUrl,
  sanitizeEntry,
} from "./round-log.mjs";

const tempEnv = () => ({
  XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "ego-lite-logs-")),
});

describe("sanitizeEntry", () => {
  it("keeps known short fields and drops everything else", () => {
    const clean = sanitizeEntry({
      ts: 1.6,
      space: 3,
      action: "Input.insertText",
      ok: true,
      text: "hunter2",
      params: { value: "secret" },
      target: `@1${"x".repeat(200)}`,
      error_code: "line\nbreak",
    });
    assert.deepEqual(Object.keys(clean).sort(), [
      "action",
      "error_code",
      "ok",
      "space",
      "target",
      "ts",
    ]);
    assert.equal(clean.ts, 2);
    assert.equal(clean.target.length, 80);
    assert.equal(clean.error_code, "line break");
  });
});

describe("redactUrl", () => {
  it("drops credentials, query and fragment", () => {
    assert.equal(
      redactUrl("https://u:p@bank.test/a/b?token=x#y"),
      "https://bank.test/a/b",
    );
    assert.equal(redactUrl("data:text/html,secret"), "data:");
    assert.equal(redactUrl("not a url"), "");
  });
});

describe("RoundLog", () => {
  it("tightens loose folders and files and never follows a link", () => {
    const env = tempEnv();
    const state = join(env.XDG_STATE_HOME, "ego-lite");
    const dir = join(state, "rounds");
    mkdirSync(dir, { recursive: true, mode: 0o777 });
    chmodSync(state, 0o755);
    chmodSync(dir, 0o777);
    writeFileSync(join(dir, "7.jsonl"), "", { mode: 0o644 });
    chmodSync(join(dir, "7.jsonl"), 0o644);
    const victim = join(env.XDG_STATE_HOME, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(dir, "8.jsonl"));
    const log = new RoundLog({ env });
    log.append([
      { space: 7, action: "page.goto", ok: true },
      { space: 8, action: "page.goto", ok: true },
    ]);
    log.event("start");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "7.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(state, "events.jsonl")).mode & 0o777, 0o600);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  });

  it("writes one file per space plus daemon events, private to the user", () => {
    const env = tempEnv();
    let clock = 100;
    const log = new RoundLog({ env, now: () => clock++ });
    log.append([
      { round: "1.1", space: 7, action: "page.goto", ok: true, ms: 12 },
      { round: "1.1", action: "listTaskSpaces", ok: true },
    ]);
    log.event("gc-closed", { space: 7 });
    const dir = join(env.XDG_STATE_HOME, "ego-lite", "rounds");
    assert.match(readFileSync(join(dir, "7.jsonl"), "utf8"), /page\.goto/);
    assert.match(
      readFileSync(join(dir, "none.jsonl"), "utf8"),
      /listTaskSpaces/,
    );
    assert.equal(statSync(join(dir, "7.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);

    const all = readLogs({ env });
    assert.deepEqual(
      all.map((entry) => entry.action ?? entry.event),
      ["page.goto", "listTaskSpaces", "gc-closed"],
    );
    assert.deepEqual(
      readLogs({ env, space: 7 }).map((entry) => entry.action),
      ["page.goto"],
    );
    assert.equal(readLogs({ env, limit: 1 }).length, 1);
  });

  it("rotates a file that grew past its size", () => {
    const env = tempEnv();
    const log = new RoundLog({ env, maxBytes: 200 });
    for (let i = 0; i < 10; i += 1) {
      log.append([{ space: 1, action: `step-${i}`, ok: true }]);
    }
    const dir = join(env.XDG_STATE_HOME, "ego-lite", "rounds");
    assert.ok(existsSync(join(dir, "1.jsonl.1")));
    // One rotated file is kept, so the newest entries survive.
    const kept = readLogs({ env, space: 1, limit: 0 }).map((e) => e.action);
    assert.ok(kept.length > 2 && kept.length < 10);
    assert.equal(kept.at(-1), "step-9");
  });
});

describe("formatEntry", () => {
  it("prints actions, rounds and daemon events on one line", () => {
    assert.match(
      formatEntry({
        ts: 0,
        round: "1.2",
        space: 3,
        action: "click",
        ok: false,
        error_code: "CDP_ERROR",
        ms: 5,
      }),
      /round 1\.2 {2}space 3 {2}click {2}FAILED CDP_ERROR {2}5ms$/,
    );
    assert.match(
      formatEntry({
        ts: 0,
        kind: "round",
        event: "end",
        exit: 1,
        ms: 900,
        count: 4,
      }),
      /round end exit=1 900ms actions=4/,
    );
    assert.match(
      formatEntry({ ts: 0, kind: "daemon", event: "start" }),
      /daemon {2}start/,
    );
  });
});
