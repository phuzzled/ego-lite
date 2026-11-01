import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { freeDisplay, startVirtualDisplay, xauthEntry } from "./display.mjs";

describe("xauthEntry", () => {
  it("encodes a FamilyWild MIT-MAGIC-COOKIE-1 entry", () => {
    const cookie = Buffer.alloc(16, 0xab);
    const entry = xauthEntry(93, cookie);
    let offset = 0;
    const u16 = () => {
      const value = entry.readUInt16BE(offset);
      offset += 2;
      return value;
    };
    const field = () => {
      const length = u16();
      const value = entry.subarray(offset, offset + length);
      offset += length;
      return value;
    };
    assert.equal(u16(), 0xffff);
    assert.equal(field().length, 0);
    assert.equal(field().toString(), "93");
    assert.equal(field().toString(), "MIT-MAGIC-COOKIE-1");
    assert.deepEqual(field(), cookie);
    assert.equal(offset, entry.length);
  });
});

describe("freeDisplay", () => {
  it("skips displays with a socket or a lock", () => {
    const taken = new Set(["/tmp/.X11-unix/X90", "/tmp/.X91-lock"]);
    assert.equal(
      freeDisplay(90, 95, (path) => taken.has(path)),
      92,
    );
    assert.equal(
      freeDisplay(90, 91, () => true),
      null,
    );
  });
});

describe("startVirtualDisplay", () => {
  it("explains how to install Xvfb when it is missing", async () => {
    await assert.rejects(
      startVirtualDisplay({ runDir: "/nonexistent", xvfb: null }),
      {
        error_code: "EGO_DISPLAY_UNAVAILABLE",
        message: /apt-get install -y xvfb/,
      },
    );
  });

  it("starts Xvfb without TCP and with a private cookie file", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ego-lite-display-"));
    const spawned = [];
    const spawn = (command, args) => {
      const child = new EventEmitter();
      child.exitCode = 1;
      child.signalCode = null;
      child.kill = () => {};
      spawned.push({ command, args });
      return child;
    };
    await assert.rejects(
      startVirtualDisplay({
        runDir,
        xvfb: "/usr/bin/Xvfb",
        spawn,
        timeoutMs: 200,
      }),
      { error_code: "EGO_DISPLAY_UNAVAILABLE" },
    );
    const { command, args } = spawned[0];
    assert.equal(command, "/usr/bin/Xvfb");
    assert.deepEqual(
      args.slice(args.indexOf("-nolisten"), args.indexOf("-nolisten") + 2),
      ["-nolisten", "tcp"],
    );
    const auth = args[args.indexOf("-auth") + 1];
    assert.equal(auth, join(runDir, "Xauthority"));
    // The failed attempts remove the cookie file again.
    assert.throws(() => readFileSync(auth));
    assert.equal(statSync(runDir).mode & 0o777, 0o700);
    assert.equal(spawned.length, 5);
  });
});
