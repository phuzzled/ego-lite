import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "./config.mjs";
import { TaskSpaceRegistry, browserOfProfile } from "./task-spaces.mjs";

const profiles = {
  list: () => ({ profiles: [] }),
  resolve: (id) =>
    !id || id === "Default"
      ? { id: "Default", name: "Default", kind: "default" }
      : id === "ephemeral"
        ? { id: "ephemeral", name: "Ephemeral", kind: "ephemeral" }
        : id === "work"
          ? { id: "work", name: "Work", kind: "named" }
          : null,
};

function fakeBrowser() {
  const browser = {
    nextTarget: 1,
    created: [],
    closed: [],
    shown: [],
    contexts: [],
    disposed: [],
    async createTarget(url, options = {}) {
      const targetId = `T${browser.nextTarget++}`;
      browser.created.push({ url, targetId, ...options });
      return targetId;
    },
    async closeTarget(targetId) {
      browser.closed.push(targetId);
    },
    async activateTarget() {},
    async showTarget(targetId) {
      browser.shown.push(targetId);
    },
    targetInfo: () => undefined,
    async createContext() {
      const id = `C${browser.contexts.length + 1}`;
      browser.contexts.push(id);
      return id;
    },
    async disposeContext(id) {
      browser.disposed.push(id);
    },
  };
  return browser;
}

describe("TaskSpaceRegistry profiles", () => {
  it("opens a named profile's tabs in that profile's browser", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("signed-in", "work");
    assert.equal(browser.created[0].profileId, "work");
    assert.equal(browser.created[0].browserContextId, undefined);
    const [space] = registry.listTaskSpaces().taskSpaces;
    assert.equal(space.profileId, "work");
    assert.equal(space.profileName, "Work");
    assert.deepEqual([...registry.browsersInUse()], ["work"]);
    assert.deepEqual(registry.spacesOfProfile("work"), [1]);
    assert.equal(registry.browserOfSpace(1), "work");
  });

  it("gives each ephemeral space its own context in the Default browser", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("a", "ephemeral");
    await registry.createTaskSpace("b", "ephemeral");
    await registry.createTab(1, "https://example.test/");
    assert.deepEqual(
      browser.created.map(({ profileId, browserContextId }) => ({
        profileId,
        browserContextId,
      })),
      [
        { profileId: "Default", browserContextId: "C1" },
        { profileId: "Default", browserContextId: "C2" },
        { profileId: "Default", browserContextId: "C1" },
      ],
    );
    assert.equal(browserOfProfile("ephemeral"), "Default");
    assert.equal(browserOfProfile(undefined), "Default");
  });

  it("deletes an ephemeral space and its cookies at finish()", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("throwaway", "ephemeral");
    assert.equal(
      await registry.completeTaskSpace(1),
      "1 task space completed.",
    );
    assert.deepEqual(browser.disposed, ["C1"]);
    assert.equal(registry.describe(1), null);
  });

  it("disposes the context when an ephemeral space closes", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("throwaway", "ephemeral");
    await registry.closeTaskSpace(1);
    assert.deepEqual(browser.disposed, ["C1"]);
  });

  it("does not bring back a saved ephemeral space after a restart", () => {
    const registry = new TaskSpaceRegistry({
      browser: fakeBrowser(),
      profiles,
      saved: {
        nextId: 3,
        spaces: [
          { id: 1, name: "a", profileId: "ephemeral", targets: [] },
          { id: 2, name: "b", profileId: "work", targets: [] },
        ],
      },
    });
    assert.deepEqual(
      registry.listTaskSpaces().taskSpaces.map((space) => space.id),
      [2],
    );
  });

  it("rejects an unknown profile without opening a tab", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    assert.equal(
      (await registry.createTaskSpace("x", "missing")).error_code,
      "EGO_PROFILE_NOT_FOUND",
    );
    assert.equal(browser.created.length, 0);
  });

  it("passes the browser limit through when a profile's browser cannot start", async () => {
    const browser = fakeBrowser();
    browser.createTarget = async () => {
      throw Object.assign(new Error("too many browsers"), {
        error_code: "EGO_RESOURCE_LIMIT",
      });
    };
    const registry = new TaskSpaceRegistry({ browser, profiles });
    const result = await registry.createTaskSpace("x", "work");
    assert.equal(result.error_code, "EGO_RESOURCE_LIMIT");
    assert.equal(registry.listTaskSpaces().taskSpaces.length, 0);
  });

  it("remembers the URLs of tabs lost with a profile's browser", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("signed-in", "work");
    registry.loseTargets(["T1"], () => "https://mail.test/inbox");
    const space = registry.describe(1);
    assert.deepEqual(space.targets, []);
    assert.deepEqual(space.lostTabs, ["https://mail.test/inbox"]);
    assert.equal(space.stale, true);
  });

  it("shows the handed-off tab with showTarget when the browser has it", async () => {
    const browser = fakeBrowser();
    const registry = new TaskSpaceRegistry({ browser, profiles });
    await registry.createTaskSpace("login", "work");
    await registry.handOffTaskSpace(1);
    assert.deepEqual(browser.shown, ["T1"]);
  });
});

describe("TaskSpaceRegistry concurrent creates", () => {
  const slow = () => {
    const browser = fakeBrowser();
    const wait = () => new Promise((done) => setTimeout(done, 5));
    const { createContext, createTarget } = browser;
    browser.createContext = async () => (await wait(), createContext());
    browser.createTarget = async (...args) => (
      await wait(),
      createTarget(...args)
    );
    return browser;
  };

  it("holds the space and page limits and unique names", async () => {
    const registry = new TaskSpaceRegistry({
      browser: slow(),
      profiles,
      limits: () => ({ ...DEFAULT_CONFIG, maxTaskSpaces: 3, maxTotalPages: 0 }),
    });
    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        registry.createTaskSpace(`one-shot ${i}`, "ephemeral"),
      ),
    ]);
    assert.equal(results.filter((r) => r.id).length, 3);
    assert.equal(
      results.filter((r) => r.error_code === "EGO_RESOURCE_LIMIT").length,
      3,
    );
    const named = new TaskSpaceRegistry({ browser: slow(), profiles });
    const same = await Promise.all([
      named.createTaskSpace("same", "ephemeral"),
      named.createTaskSpace("same", "ephemeral"),
    ]);
    assert.deepEqual(same.map((r) => r.error_code ?? "ok").sort(), [
      "EGO_TASK_SPACE_NAME_IN_USE",
      "ok",
    ]);
  });

  it("counts tabs Chrome is still creating against the page limits", async () => {
    const registry = new TaskSpaceRegistry({
      browser: slow(),
      profiles,
      limits: () => ({ ...DEFAULT_CONFIG, maxPagesPerSpace: 3 }),
    });
    await registry.createTaskSpace("a");
    const tabs = await Promise.all(
      Array.from({ length: 4 }, () => registry.createTab(1, "about:blank")),
    );
    assert.equal(tabs.filter((t) => t.targetId).length, 2);
    assert.equal(registry.describe(1).targets.length, 3);
  });
});
