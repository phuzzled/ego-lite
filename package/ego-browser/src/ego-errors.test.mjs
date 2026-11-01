import test from "node:test";
import assert from "node:assert/strict";

import {
  attachHint,
  buildEgoError,
  egoErrorCode,
  errorHint,
  httpErrorHint,
  withHint,
  invokeEgo,
  isEgoErrorCode,
  isEgoUserControlError,
  probeAgentControl,
  resolveEgoError,
} from "../dist/src/ego-errors.js";

test("probeAgentControl treats both native user-control shapes as waiting", async () => {
  assert.equal(
    await probeAgentControl(async () => ({
      error: "manual_takeover",
      error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
    })),
    false,
  );
  assert.equal(
    await probeAgentControl(async () => {
      throw Object.assign(new Error("manual_takeover"), {
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      });
    }),
    false,
  );
});

test("probeAgentControl propagates non-user-control native errors", async () => {
  await assert.rejects(
    () =>
      probeAgentControl(async () => ({
        error: "renderer failed",
        error_code: "EGO_SNAPSHOT_FAILED",
      })),
    /renderer failed/,
  );
});

test("invokeEgo recognizes a permission reason from a resolved native error", async () => {
  await assert.rejects(
    () =>
      invokeEgo("task.listTabs", () =>
        Promise.resolve({
          error: "location",
          error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
        }),
      ),
    (error) => {
      assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      assert.match(
        error.message,
        /^task\.listTabs: A browser permission prompt/,
      );
      assert.match(error.message, /location access/);
      assert.match(error.message, /takeOverTaskSpace\(spaceId\)/);
      return true;
    },
  );
});

test("invokeEgo recognizes a permission reason from a rejected native call", async () => {
  const nativeError = Object.assign(new Error("camera"), {
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  await assert.rejects(
    () => invokeEgo("snapshot", () => Promise.reject(nativeError)),
    (error) => {
      assert.equal(error.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
      assert.match(error.message, /^snapshot: A browser permission prompt/);
      assert.match(error.message, /camera access/);
      return true;
    },
  );
});

test("user-control reason lookup ignores inherited object properties", () => {
  const { message } = resolveEgoError({
    error: "constructor",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /Control of this task space is with the user/);
  assert.doesNotMatch(message, /constructor/);
});

test("unknown user-control reasons fall back without exposing the raw key", () => {
  const { message } = resolveEgoError({
    error: "future_permission_reason",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /Control of this task space is with the user/);
  assert.doesNotMatch(message, /future_permission_reason/);
});

test("the retired site-dialog handoff reason uses generic user-control guidance", () => {
  const { message } = resolveEgoError({
    error: "fallback_site_dialog_required_notice",
    error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
  });
  assert.match(message, /Control of this task space is with the user/);
  assert.doesNotMatch(message, /dialog that requires review/);
  assert.doesNotMatch(message, /fallback_site_dialog_required_notice/);
});

test("invokeEgo preserves non-user-control native failures", async () => {
  await assert.rejects(
    () =>
      invokeEgo("snapshot", () =>
        Promise.reject(
          Object.assign(new Error("snapshot renderer failed"), {
            error_code: "EGO_SNAPSHOT_FAILED",
          }),
        ),
      ),
    (error) => {
      assert.equal(error.error_code, "EGO_SNAPSHOT_FAILED");
      assert.equal(error.message, "snapshot: snapshot renderer failed");
      return true;
    },
  );
});

test("egoErrorCode extracts the code from every error shape", () => {
  // resolved { error, error_code } object
  assert.equal(
    egoErrorCode({ error: "nope", error_code: "EGO_BROWSER_UNAVAILABLE" }),
    "EGO_BROWSER_UNAVAILABLE",
  );
  // rejected / thrown Error carrying .error_code
  const err = Object.assign(new Error("boom"), {
    error_code: "EGO_SNAPSHOT_FAILED",
  });
  assert.equal(egoErrorCode(err), "EGO_SNAPSHOT_FAILED");
  // bare known code string (e.g. onSendCDPMessageError second arg)
  assert.equal(
    egoErrorCode("EGO_TASK_SPACE_USER_IN_CONTROL"),
    "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  // future code this build does not know about is still returned
  assert.equal(
    egoErrorCode({ error_code: "EGO_FUTURE_CODE" }),
    "EGO_FUTURE_CODE",
  );
  // no code present
  assert.equal(egoErrorCode({ error: "plain message" }), undefined);
  assert.equal(egoErrorCode("plain message"), undefined);
});

test("isEgoErrorCode narrows to known codes only", () => {
  assert.equal(isEgoErrorCode("EGO_TASK_SPACE_NOT_FOUND"), true);
  assert.equal(isEgoErrorCode("EGO_FUTURE_CODE"), false);
  assert.equal(isEgoErrorCode(undefined), false);
});

test("resolveEgoError overrides the native error message with the owned wording for an owned code", () => {
  const { code, message } = resolveEgoError({
    error: "Task space 7 is not assigned to an agent.",
    error_code: "EGO_TASK_SPACE_INACTIVE",
  });
  assert.equal(code, "EGO_TASK_SPACE_INACTIVE");
  // Owned id-less guidance replaces the native "Task space 7 ..." text.
  assert.match(message, /claimTaskSpace\(spaceId\)/);
  assert.doesNotMatch(message, /\b7\b/);
});

test("inactive guidance does not attribute an agent-finished task to the user", () => {
  // task.finish({ keep: [...] }) leaves the space user-owned; a later
  // takeOverTaskSpace() gets this code without any user action.
  const { message } = resolveEgoError("EGO_TASK_SPACE_INACTIVE");
  assert.doesNotMatch(message, /user has taken control/i);
  assert.match(message, /task\.finish\(\)/);
  assert.match(message, /takeOverTaskSpace\(\) cannot resume/);
  assert.match(message, /claimTaskSpace\(spaceId\)/);
});

test("user-control guidance names both the agent handoff and a browser takeover", () => {
  const { message } = resolveEgoError("EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.doesNotMatch(message, /user has taken control/i);
  assert.match(message, /task\.handOff\(\)/);
  assert.match(message, /takeover in the browser/);
});

test("resolveEgoError keeps the native error message for an unknown future code", () => {
  assert.deepEqual(
    resolveEgoError({
      error: "Some build-specific detail",
      error_code: "EGO_FUTURE_CODE",
    }),
    {
      code: "EGO_FUTURE_CODE",
      message: "Some build-specific detail",
    },
  );
});

test("resolveEgoError defers to the native error message for a code ego-browser does not own", () => {
  // EGO_OPERATION_FAILED is not owned: the client wording (e.g. which operation
  // failed) is more specific than any static line.
  assert.deepEqual(
    resolveEgoError({
      error: "Failed to create task space",
      error_code: "EGO_OPERATION_FAILED",
    }),
    {
      code: "EGO_OPERATION_FAILED",
      message: "Failed to create task space",
    },
  );
});

test("resolveEgoError falls back to the raw code for a bare non-owned code", () => {
  // ego-browser does not own NOT_SELECTED and a bare code carries no native error message,
  // so the stable code itself is the most specific thing to surface.
  assert.deepEqual(resolveEgoError("EGO_TASK_SPACE_NOT_SELECTED"), {
    code: "EGO_TASK_SPACE_NOT_SELECTED",
    message: "EGO_TASK_SPACE_NOT_SELECTED",
  });
});

test("resolveEgoError uses the id-less guidance block for a bare user-control code", () => {
  const { code, message } = resolveEgoError("EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(code, "EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.match(message, /Control of this task space is with the user/);
  assert.match(message, /takeOverTaskSpace\(spaceId\)/);
  assert.doesNotMatch(message, /<id>/);
});

test("resolveEgoError falls back to the raw code, then a generic message", () => {
  assert.deepEqual(resolveEgoError({ error_code: "EGO_FUTURE_CODE" }), {
    code: "EGO_FUTURE_CODE",
    message: "EGO_FUTURE_CODE",
  });
  assert.deepEqual(resolveEgoError({}), {
    code: undefined,
    message: "Unknown ego error",
  });
});

test("isEgoUserControlError keys on the stable code, not wording", () => {
  assert.equal(
    isEgoUserControlError(
      Object.assign(new Error("anything at all"), {
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      }),
    ),
    true,
  );
  // wording that mentions user control but lacks the code is not a match
  assert.equal(
    isEgoUserControlError(new Error("the user is controlling this")),
    false,
  );
  assert.equal(
    isEgoUserControlError({ error_code: "EGO_SNAPSHOT_FAILED" }),
    false,
  );
});

test("invokeEgo resolves native error objects and attaches error_code", async () => {
  await assert.rejects(
    () =>
      invokeEgo("listTabs", () => ({
        error: "Task space not selected",
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      })),
    (error) => {
      assert.equal(error.message, "listTabs: Task space not selected");
      assert.equal(error.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
      return true;
    },
  );
});

test("invokeEgo normalizes synchronous native throws", async () => {
  const nativeError = Object.assign(new Error("native setup failed"), {
    error_code: "EGO_OPERATION_FAILED",
  });
  await assert.rejects(
    () =>
      invokeEgo("createTab", () => {
        throw nativeError;
      }),
    (error) => {
      assert.equal(error.message, "createTab: native setup failed");
      assert.equal(error.error_code, "EGO_OPERATION_FAILED");
      return true;
    },
  );
});

test("invokeEgo passes through successful results", async () => {
  const ok = { tabs: [] };
  assert.equal(await invokeEgo("listTabs", () => ok), ok);
});

test("errorHint gives every common failure a next step", () => {
  const cases = [
    [{ error_code: "EGO_NAVIGATION_HTTP_ERROR", status: 404 }, /answered 404/],
    [{ message: "Selector #go matched 0 elements" }, /Take a new snapshot/],
    [
      { message: "page.click timed out after 3000ms: Element not found: x" },
      /Take a new snapshot/,
    ],
    [{ message: "Locator text=Save matched 3 elements" }, />> nth=N/],
    [{ message: "Stale ref: @4; take a new snapshot" }, /Refs last one page/],
    [{ error_code: "EGO_BROWSER_UNAVAILABLE" }, /ego-browser stop/],
    [{ error_code: "EGO_TASK_SPACE_USER_IN_CONTROL" }, /takeOverTaskSpace/],
    [{ message: "page label not found: p3" }, /task\.newPage\(\)/],
    [{ message: "page.goto failed: net::ERR_NAME_NOT_RESOLVED" }, /host name/],
    [
      { message: "page.waitForSelector timed out after 10000ms: .row" },
      /snapshot or screenshot/,
    ],
    [
      { message: "page.waitForLoadState(load) timed out after 100ms" },
      /snapshot or screenshot/,
    ],
    [
      { message: "Page changed during snapshot; take a new snapshot" },
      /waitForSettled/,
    ],
  ];
  for (const [error, expected] of cases) {
    assert.match(errorHint(error), expected, JSON.stringify(error));
  }
  assert.equal(errorHint({ message: "something unrelated" }), undefined);
  assert.equal(errorHint(null), undefined);
  assert.equal(
    errorHint({ message: "anything", hint: "explicit" }),
    "explicit",
    "an explicit hint wins",
  );
  // "matched 2 elements, but none can receive input" is not ambiguity.
  assert.match(
    errorHint({
      message: "Selector #a matched 2 elements, but none can receive input",
    }),
    /Take a new snapshot/,
  );
});

test("attachHint adds hint lines after the stack once", () => {
  const error = new Error("Selector #go matched 0 elements");
  assert.equal(attachHint(error), error);
  assert.match(error.hint, /Take a new snapshot/);
  assert.match(error.stack, /\n {4}at [\s\S]*\n {2}hint: Take a new snapshot/);
  attachHint(error);
  assert.equal(error.stack.match(/\n {2}hint: /g).length, 1);

  const plain = new Error("no hint for this one");
  attachHint(plain);
  assert.equal(plain.hint, undefined);
  assert.doesNotMatch(plain.stack, /hint:/);
  assert.equal(attachHint("not an error"), "not an error");
});

test("withHint builds a coded error with status and hint lines", () => {
  const error = withHint(
    "EGO_NAVIGATION_HTTP_ERROR",
    "page.goto failed: the server answered HTTP 404",
    httpErrorHint(404),
    { status: 404 },
  );
  assert.equal(error.error_code, "EGO_NAVIGATION_HTTP_ERROR");
  assert.equal(error.status, 404);
  assert.match(error.hint, /^The server answered 404\. Check the URL\./);
  assert.match(
    error.stack,
    /\n {2}error_code: EGO_NAVIGATION_HTTP_ERROR\n {2}status: 404\n {2}hint: The server answered 404/,
  );
  assert.match(httpErrorHint(), /The server answered an error/);
});

test("ego binding errors carry their code's hint", () => {
  const error = buildEgoError({
    error: "browser went away",
    error_code: "EGO_BROWSER_UNAVAILABLE",
  });
  assert.equal(error.error_code, "EGO_BROWSER_UNAVAILABLE");
  assert.match(error.hint, /ego-browser stop/);
});
