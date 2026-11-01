import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rawCdpGate } from "./ego-bindings.mjs";

describe("rawCdpGate", () => {
  it("requires a selected task space", () => {
    const result = rawCdpGate(undefined, new Map());
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
  });

  it("reports a missing task space", () => {
    const result = rawCdpGate(5, new Map());
    assert.equal(result.error, "Task space not found: 5");
    assert.equal(result.error_code, "EGO_TASK_SPACE_NOT_FOUND");
  });

  it("reports a task space no longer owned by the agent", () => {
    const spaces = new Map([[1, { ownership: "user", control: "agent" }]]);
    assert.equal(rawCdpGate(1, spaces).error_code, "EGO_TASK_SPACE_INACTIVE");
  });

  it("reports user in control with the reason", () => {
    const spaces = new Map([
      [1, { ownership: "agent", control: "user", controlReason: "captcha" }],
      [2, { ownership: "agent", control: "user" }],
    ]);
    const first = rawCdpGate(1, spaces);
    assert.equal(first.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    assert.equal(first.error, "captcha");
    assert.equal(rawCdpGate(2, spaces).error, "manual_takeover");
  });

  it("allows an agent-owned, agent-controlled space", () => {
    const spaces = new Map([[1, { ownership: "agent", control: "agent" }]]);
    assert.equal(rawCdpGate(1, spaces), null);
  });
});
