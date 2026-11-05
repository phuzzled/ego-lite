import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { pruneSdkLedgers, sdkStateDir } from "./sdk-ledgers.mjs";

describe("pruneSdkLedgers", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ego-ledgers-"));
    for (const name of [
      "space-3.json",
      "space-7.json",
      "space-9.json",
      "space-12.json",
      "space-x.json",
      "notes.txt",
    ]) {
      writeFileSync(join(dir, name), "{}");
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes the ledgers of closed spaces and keeps live and future ones", () => {
    const removed = pruneSdkLedgers({ dir, liveIds: [7], nextId: 10 });
    assert.deepEqual(removed, [3, 9]);
    assert.deepEqual(readdirSync(dir).sort(), [
      "notes.txt",
      "space-12.json",
      "space-7.json",
      "space-x.json",
    ]);
  });

  it("only reports in a dry run", () => {
    assert.deepEqual(
      pruneSdkLedgers({ dir, liveIds: [], nextId: 100, dryRun: true }),
      [3, 7, 9, 12],
    );
    assert.equal(readdirSync(dir).length, 6);
  });

  it("does nothing without the state folder", () => {
    assert.deepEqual(
      pruneSdkLedgers({ dir: join(dir, "missing"), liveIds: [], nextId: 5 }),
      [],
    );
  });

  it("uses EGO_BROWSER_STATE_DIR, else ~/.ego-browser/state", () => {
    assert.equal(sdkStateDir({ EGO_BROWSER_STATE_DIR: "/s" }), "/s");
    assert.match(sdkStateDir({}), /\.ego-browser[/\\]state$/);
  });
});
