import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { createEgoBindings } from "./ego-bindings.mjs";
import { proxyServer } from "./test-support.mjs";

async function bindings({ answers = {}, spaces = [] } = {}) {
  const server = await proxyServer();
  const calls = [];
  const control = {
    path: server.path,
    call: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
    onEvent: () => {},
  };
  const ego = await createEgoBindings({ control, hello: { spaces } });
  return {
    ego,
    calls,
    close() {
      ego.close();
      server.close();
    },
  };
}

describe("identity bindings", () => {
  it("advertises profiles and fillSecret", async () => {
    const { ego, close } = await bindings();
    try {
      const capabilities = ego.getHostCapabilities();
      assert.equal(capabilities.profiles, true);
      assert.equal(capabilities.ephemeralProfile, true);
      assert.equal(capabilities.fillSecret, true);
    } finally {
      close();
    }
  });

  it("says that finish() deleted an ephemeral space", async () => {
    const { ego, close } = await bindings({
      spaces: [
        { id: 4, ownership: "agent", control: "agent", profileId: "ephemeral" },
      ],
      answers: { completeTaskSpace: "4 task space completed." },
    });
    const write = mock.method(process.stderr, "write", () => true);
    try {
      ego.useTaskSpace(4);
      assert.equal(await ego.completeTaskSpace(), "4 task space completed.");
      const said = write.mock.calls.map((call) => call.arguments[0]).join("");
      assert.match(said, /ephemeral profile, so finish\(\) deleted it/);
    } finally {
      write.mock.restore();
      close();
    }
  });

  it("fillSecret sends only the secret's name, for the active tab", async () => {
    const { ego, calls, close } = await bindings({
      spaces: [{ id: 2, ownership: "agent", control: "agent" }],
      answers: {
        listTabs: { tabs: [{ targetId: "T9", active: true }] },
        fillSecret: (params) => ({
          filled: true,
          secret: params.name,
          origin: "https://github.com",
        }),
      },
    });
    try {
      ego.useTaskSpace(2);
      const result = await ego.fillSecret("github-password");
      assert.deepEqual(result, {
        filled: true,
        secret: "github-password",
        origin: "https://github.com",
      });
      const fill = calls.find((call) => call.method === "fillSecret");
      assert.deepEqual(fill.params, {
        id: 2,
        name: "github-password",
        targetId: "T9",
        clear: true,
      });
    } finally {
      close();
    }
  });

  it("fillSecret checks its arguments and needs a selected space", async () => {
    const { ego, close } = await bindings();
    try {
      await assert.rejects(ego.fillSecret(), { name: "TypeError" });
      await assert.rejects(ego.fillSecret(""), { name: "TypeError" });
      await assert.rejects(ego.fillSecret("x", { targetId: 3 }), {
        name: "TypeError",
      });
      assert.equal(
        (await ego.fillSecret("x")).error_code,
        "EGO_TASK_SPACE_NOT_SELECTED",
      );
    } finally {
      close();
    }
  });
});
