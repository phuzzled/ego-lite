import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { TaskSpaceRegistry } from "./task-spaces.mjs";

function fakeBrowser() {
  const browser = {
    nextTarget: 1,
    created: [],
    closed: [],
    activated: [],
    infos: new Map(),
    async createTarget(url, { anchor } = {}) {
      const targetId = `T${browser.nextTarget++}`;
      browser.created.push({ url, anchor, targetId });
      return targetId;
    },
    async closeTarget(targetId) {
      browser.closed.push(targetId);
    },
    async activateTarget(targetId) {
      browser.activated.push(targetId);
    },
    targetInfo(targetId) {
      return browser.infos.get(targetId);
    },
  };
  return browser;
}

describe("TaskSpaceRegistry", () => {
  let browser;
  let registry;

  beforeEach(() => {
    browser = fakeBrowser();
    registry = new TaskSpaceRegistry({ browser });
  });

  it("createTaskSpace opens one about:blank tab and returns a descriptor", async () => {
    const result = await registry.createTaskSpace("work");
    assert.deepEqual(result, { taskId: "work", id: 1, name: "work" });
    assert.equal(browser.created.length, 1);
    assert.equal(browser.created[0].url, "about:blank");
    assert.equal(registry.listTabs(1).tabs.length, 1);
  });

  it("rejects an unknown profile id", async () => {
    const result = await registry.createTaskSpace("work", "nope");
    assert.deepEqual(result, {
      error: "Profile not found",
      error_code: "EGO_PROFILE_NOT_FOUND",
    });
    assert.equal(browser.created.length, 0);
  });

  it("accepts the default profile", async () => {
    const result = await registry.createTaskSpace("work", "Default");
    assert.equal(result.id, 1);
  });

  it("reports an error and leaves no space when the tab cannot be created", async () => {
    browser.createTarget = async () => {
      throw new Error("boom");
    };
    const result = await registry.createTaskSpace("work");
    assert.equal(result.error_code, "EGO_BROWSER_UNAVAILABLE");
    assert.deepEqual(registry.listTaskSpaces().taskSpaces, []);
  });

  it("lists task spaces with ownership transitions", async () => {
    await registry.createTaskSpace("work");
    browser.infos.set("T1", { url: "about:blank", title: "Blank" });
    let [space] = registry.listTaskSpaces().taskSpaces;
    assert.equal(space.taskId, "work");
    assert.equal(space.id, 1);
    assert.equal(space.createdBy, "agent");
    assert.equal(space.ownership, "agent");
    assert.deepEqual(space.recentTabTitles, ["Blank"]);

    await registry.handOffTaskSpace(1);
    [space] = registry.listTaskSpaces().taskSpaces;
    assert.equal(space.ownership, "agentDelegatedToUser");

    registry.takeOverTaskSpace(1);
    registry.completeTaskSpace(1);
    [space] = registry.listTaskSpaces().taskSpaces;
    assert.equal(space.ownership, "user");
  });

  it("gate: not found", () => {
    assert.deepEqual(registry.gate(42), {
      error: "Task space not found: 42",
      error_code: "EGO_TASK_SPACE_NOT_FOUND",
    });
  });

  it("gate: inactive after complete", async () => {
    await registry.createTaskSpace("work");
    registry.completeTaskSpace(1);
    assert.equal(registry.gate(1).error_code, "EGO_TASK_SPACE_INACTIVE");
    assert.equal(registry.listTabs(1).error_code, "EGO_TASK_SPACE_INACTIVE");
  });

  it("gate: user in control after handoff", async () => {
    await registry.createTaskSpace("work");
    await registry.handOffTaskSpace(1);
    const gate = registry.gate(1);
    assert.equal(gate.error, "manual_takeover");
    assert.equal(gate.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    assert.deepEqual(browser.activated, ["T1"]);
  });

  it("gate returns null for an agent-controlled space", async () => {
    await registry.createTaskSpace("work");
    assert.equal(registry.gate(1), null);
  });

  it("takeOver returns control, but is inactive after complete", async () => {
    await registry.createTaskSpace("work");
    await registry.handOffTaskSpace(1);
    registry.takeOverTaskSpace(1);
    assert.equal(registry.gate(1), null);

    registry.completeTaskSpace(1);
    assert.equal(
      registry.takeOverTaskSpace(1).error_code,
      "EGO_TASK_SPACE_INACTIVE",
    );
  });

  it("listTabs marks the active tab", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/");
    browser.infos.set("T2", { url: "https://a.test/", title: "A" });
    const { tabs } = registry.listTabs(1);
    assert.deepEqual(
      tabs.map((tab) => [tab.index, tab.targetId, tab.active]),
      [
        [0, "T1", false],
        [1, "T2", true],
      ],
    );
    assert.equal(tabs[1].url, "https://a.test/");
    assert.equal(tabs[1].title, "A");
    registry.setActiveTarget(1, "T1");
    assert.equal(registry.listTabs(1).tabs[0].active, true);
  });

  it("a popup joins its opener's space", async () => {
    await registry.createTaskSpace("one");
    await registry.createTaskSpace("two");
    registry.handleTargetCreated({
      type: "page",
      targetId: "POPUP",
      openerId: "T2",
    });
    assert.equal(registry.spaceOfTarget("POPUP"), 2);
    registry.handleTargetCreated({
      type: "page",
      targetId: "STRAY",
      openerId: "unknown",
    });
    assert.equal(registry.spaceOfTarget("STRAY"), null);
  });

  it("destroying the active tab moves active to the last remaining tab", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/");
    await registry.createTab(1, "https://b.test/");
    registry.setActiveTarget(1, "T2");
    registry.handleTargetDestroyed("T2");
    const { tabs } = registry.listTabs(1);
    assert.deepEqual(
      tabs.map((tab) => tab.targetId),
      ["T1", "T3"],
    );
    assert.equal(tabs.find((tab) => tab.active).targetId, "T3");
  });

  it("remembers the tabs a browser restart closed until a new tab opens", async () => {
    await registry.createTaskSpace("work");
    browser.infos.set("T1", { url: "https://news.test/story" });
    const saved = registry.snapshotState();
    assert.deepEqual(saved.spaces[0].tabUrls, {
      T1: "https://news.test/story",
    });

    const restarted = new TaskSpaceRegistry({ browser: fakeBrowser(), saved });
    restarted.pruneTargets([]);
    const space = restarted.describe(1);
    assert.deepEqual(space.targets, []);
    assert.deepEqual(space.lostTabs, ["https://news.test/story"]);

    await restarted.createTab(1, "about:blank");
    assert.equal(restarted.describe(1).lostTabs, undefined);
  });

  it("pruneTargets drops dead targets", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/");
    registry.pruneTargets(["T1"]);
    const { tabs } = registry.listTabs(1);
    assert.deepEqual(
      tabs.map((tab) => tab.targetId),
      ["T1"],
    );
    assert.equal(tabs[0].active, true);
  });

  it("closeTaskSpace closes all its targets and removes the space", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/");
    const result = await registry.closeTaskSpace(1);
    assert.equal(result, "1 task space closed.");
    assert.deepEqual(browser.closed.sort(), ["T1", "T2"]);
    assert.equal(registry.gate(1).error_code, "EGO_TASK_SPACE_NOT_FOUND");
  });

  it("closeTaskSpace closes a handed-off space only with force", async () => {
    await registry.createTaskSpace("work");
    await registry.handOffTaskSpace(1);
    const refused = await registry.closeTaskSpace(1);
    assert.equal(refused.error_code, "EGO_TASK_SPACE_USER_IN_CONTROL");
    const result = await registry.closeTaskSpace(1, { force: true });
    assert.equal(result, "1 task space closed.");
    assert.equal(registry.describe(1), null);
  });

  it("round-trips saved state and keeps ids increasing", async () => {
    await registry.createTaskSpace("one");
    await registry.createTaskSpace("two");
    const saved = registry.snapshotState();

    const restored = new TaskSpaceRegistry({ browser, saved });
    assert.deepEqual(
      restored.listTaskSpaces().taskSpaces.map((space) => space.id),
      [1, 2],
    );
    const next = await restored.createTaskSpace("three");
    assert.equal(next.id, 3);

    const lowCounter = new TaskSpaceRegistry({
      browser,
      saved: { ...saved, nextId: 1 },
    });
    assert.equal((await lowCounter.createTaskSpace("x")).id, 3);
  });

  it("calls save and onChange on mutation", async () => {
    let saves = 0;
    let changes = 0;
    const tracked = new TaskSpaceRegistry({
      browser,
      save: () => saves++,
      onChange: () => changes++,
    });
    await tracked.createTaskSpace("work");
    assert.ok(saves > 0);
    assert.equal(saves, changes);
  });
});
