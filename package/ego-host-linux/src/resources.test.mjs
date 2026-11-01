import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cached, processTree, processTreeMemoryMb } from "./resources.mjs";

/** /proc with: 10 chrome -> 11 zygote (name with spaces) -> 12 renderer; 20 other. */
function fakeProc() {
  const files = {
    "/proc/10/stat": "10 (chrome) S 1 10",
    "/proc/11/stat": "11 (chrome (zygote) x) S 10 10",
    "/proc/12/stat": "12 (chrome) S 11 10",
    "/proc/20/stat": "20 (bash) S 1 20",
    "/proc/10/smaps_rollup": "Rss: 300000 kB\nPss:   204800 kB\n",
    "/proc/11/smaps_rollup": "Pss: 102400 kB\n",
    "/proc/12/status": "Name: chrome\nVmRSS:   51200 kB\n",
    "/proc/20/smaps_rollup": "Pss: 999999 kB\n",
  };
  return {
    list: () => ["10", "11", "12", "20", "self", "meminfo"],
    read: (path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    },
  };
}

describe("processTree", () => {
  it("finds every descendant, also through odd process names", () => {
    assert.deepEqual(processTree(10, fakeProc()), [10, 11, 12]);
  });
});

describe("processTreeMemoryMb", () => {
  it("sums Pss, or VmRSS where smaps_rollup is missing", () => {
    assert.equal(processTreeMemoryMb(10, fakeProc()), 350);
  });

  it("returns null without /proc", () => {
    const none = {
      list: () => {
        throw new Error("no /proc");
      },
    };
    assert.equal(processTreeMemoryMb(10, none), null);
  });
});

describe("cached", () => {
  it("reads again only after the TTL", () => {
    let clock = 0;
    let reads = 0;
    const value = cached(
      () => ++reads,
      1_000,
      () => clock,
    );
    assert.equal(value(), 1);
    clock = 999;
    assert.equal(value(), 1);
    clock = 1_000;
    assert.equal(value(), 2);
  });
});
