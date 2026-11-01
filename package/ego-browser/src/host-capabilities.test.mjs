import test from "node:test";
import assert from "node:assert/strict";

import {
  hostCapabilities,
  hostSupports,
  unsupportedOnHost,
} from "../dist/src/host-capabilities.js";
import { errorHint } from "../dist/src/ego-errors.js";

test("a host without getHostCapabilities has no extensions", () => {
  assert.deepEqual(hostCapabilities({}), {});
  assert.deepEqual(hostCapabilities(undefined), {});
  assert.equal(hostSupports("taskSpaceMemo", "taskSpaceMemo", {}), false);
});

test("capabilities are read once per binding object and need the binding", () => {
  let calls = 0;
  const ego = {
    getHostCapabilities() {
      calls += 1;
      return { host: "linux", taskSpaceMemo: true, logEvent: true };
    },
    taskSpaceMemo() {},
  };
  assert.equal(hostCapabilities(ego).host, "linux");
  assert.equal(hostCapabilities(ego).taskSpaceMemo, true);
  assert.equal(calls, 1);
  assert.equal(hostSupports("taskSpaceMemo", "taskSpaceMemo", ego), true);
  assert.equal(
    hostSupports("logEvent", "logEvent", ego),
    false,
    "a flag without its binding is not support",
  );
});

test("a throwing or async getHostCapabilities counts as none", () => {
  assert.deepEqual(
    hostCapabilities({
      getHostCapabilities() {
        throw new Error("boom");
      },
    }),
    {},
  );
  assert.deepEqual(
    hostCapabilities({ getHostCapabilities: async () => ({ logEvent: true }) }),
    {},
  );
});

test("unsupported features and resource limits carry a hint", () => {
  const error = unsupportedOnHost("task.memo", "keep a file");
  assert.equal(error.error_code, "EGO_UNSUPPORTED_ON_HOST");
  assert.match(
    error.message,
    /task\.memo is not supported on this browser host: keep a file/,
  );
  assert.match(error.hint, /Linux host/);
  assert.match(
    errorHint({ error_code: "EGO_RESOURCE_LIMIT", message: "limit" }),
    /ego-browser gc/,
  );
});

test("a getHostCapabilities that rejects never leaves an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    // A native binding that answers unknown methods with a rejection.
    const ego = {
      getHostCapabilities: () => Promise.reject(new Error("unknown method")),
    };
    assert.deepEqual(hostCapabilities(ego), {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
