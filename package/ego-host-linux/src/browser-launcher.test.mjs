import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { orphanBrowserPid, profileLockPid } from "./browser-launcher.mjs";

const PROFILE = "/home/u/.local/share/ego-lite/profile";
const lockTo = (target) => (path) => {
  assert.equal(path, `${PROFILE}/SingletonLock`);
  return target;
};
const noLock = () => {
  throw Object.assign(new Error("missing"), { code: "ENOENT" });
};
const cmdline =
  (...args) =>
  () =>
    `${args.join("\0")}\0`;

describe("profileLockPid", () => {
  it("reads the pid from the SingletonLock link", () => {
    assert.equal(profileLockPid(PROFILE, lockTo("atlas-4242")), 4242);
    assert.equal(profileLockPid(PROFILE, lockTo("my-host-name-7")), 7);
  });

  it("returns null without a lock", () => {
    assert.equal(profileLockPid(PROFILE, noLock), null);
    assert.equal(profileLockPid(PROFILE, lockTo("garbage")), null);
  });
});

describe("orphanBrowserPid", () => {
  it("finds a browser started by this host for this profile", () => {
    const read = cmdline(
      "/opt/google/chrome/chrome",
      "--remote-debugging-port=0",
      `--user-data-dir=${PROFILE}`,
      "about:blank",
    );
    assert.equal(orphanBrowserPid(PROFILE, lockTo("atlas-99"), read), 99);
  });

  it("reads a command line that Chrome joined with spaces", () => {
    const read = () =>
      `/opt/google/chrome/chrome --remote-debugging-port=0 --user-data-dir=${PROFILE} about:blank`;
    assert.equal(orphanBrowserPid(PROFILE, lockTo("atlas-99"), read), 99);
    const longer = () =>
      `/opt/google/chrome/chrome --remote-debugging-port=0 --user-data-dir=${PROFILE}-2`;
    assert.equal(orphanBrowserPid(PROFILE, lockTo("atlas-99"), longer), null);
  });

  it("leaves other processes alone", () => {
    // A recycled pid, or a browser the user started on another profile.
    const unrelated = cmdline("/usr/bin/bash");
    const otherProfile = cmdline(
      "/opt/google/chrome/chrome",
      "--remote-debugging-port=0",
      "--user-data-dir=/tmp/other",
    );
    const noDevTools = cmdline(
      "/opt/google/chrome/chrome",
      `--user-data-dir=${PROFILE}`,
    );
    for (const read of [unrelated, otherProfile, noDevTools]) {
      assert.equal(orphanBrowserPid(PROFILE, lockTo("atlas-99"), read), null);
    }
  });

  it("returns null when the lock or the process is gone", () => {
    const gone = () => {
      throw new Error("ENOENT");
    };
    assert.equal(orphanBrowserPid(PROFILE, noLock, gone), null);
    assert.equal(orphanBrowserPid(PROFILE, lockTo("atlas-99"), gone), null);
  });
});
