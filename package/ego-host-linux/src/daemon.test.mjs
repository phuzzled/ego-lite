import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireLock, isDaemonProcess, readSaved } from "./daemon.mjs";

const tempLock = () =>
  join(mkdtempSync(join(tmpdir(), "ego-lite-lock-")), "daemon.lock");

describe("readSaved", () => {
  it("keeps a corrupt spaces.json aside and says so", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ego-lite-saved-")), "s.json");
    const lines = [];
    assert.equal(
      readSaved(file, (line) => lines.push(line)),
      undefined,
    );
    assert.deepEqual(lines, []);
    writeFileSync(file, "{corrupt");
    assert.equal(
      readSaved(file, (line) => lines.push(line)),
      undefined,
    );
    assert.equal(readFileSync(`${file}.corrupt`, "utf8"), "{corrupt");
    assert.equal(existsSync(file), false);
    assert.match(lines[0], /not valid JSON; kept it as .*s\.json\.corrupt/);
  });
});

describe("acquireLock", () => {
  it("takes a free lock and records its pid", () => {
    const file = tempLock();
    assert.equal(acquireLock(file), true);
    assert.equal(readFileSync(file, "utf8"), String(process.pid));
  });

  it("leaves a lock held by a live daemon", () => {
    const file = tempLock();
    writeFileSync(file, "4242");
    assert.equal(
      acquireLock(file, (pid) => pid === 4242),
      false,
    );
    assert.equal(readFileSync(file, "utf8"), "4242");
  });

  it("takes over a lock whose owner is gone", () => {
    const file = tempLock();
    writeFileSync(file, "4242");
    assert.equal(
      acquireLock(file, () => false),
      true,
    );
    assert.equal(readFileSync(file, "utf8"), String(process.pid));
  });
});

describe("isDaemonProcess", () => {
  it(
    "rejects a live process that is not a daemon (a pid reused after reboot)",
    { skip: !existsSync("/proc/self") && "needs /proc" },
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, 30000)",
      ]);
      try {
        await new Promise((resolve) => child.once("spawn", resolve));
        assert.equal(isDaemonProcess(child.pid), false);
      } finally {
        child.kill();
      }
    },
  );

  it(
    "accepts a running daemon",
    { skip: !existsSync("/proc/self") && "needs /proc" },
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "setTimeout(() => {}, 30000)",
        "daemon",
      ]);
      try {
        await new Promise((resolve) => child.once("spawn", resolve));
        assert.equal(isDaemonProcess(child.pid), true);
      } finally {
        child.kill();
      }
    },
  );

  it("rejects a dead pid", () => {
    assert.equal(isDaemonProcess(2 ** 22 + 1), false);
  });
});
