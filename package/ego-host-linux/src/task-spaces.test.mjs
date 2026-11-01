import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_CONFIG } from "./config.mjs";
import { MAX_MEMO_BYTES, TaskSpaceRegistry } from "./task-spaces.mjs";

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

  it("rejects a name that another space already has", async () => {
    await registry.createTaskSpace("work");
    const [second, third] = await Promise.all([
      registry.createTaskSpace("work"),
      registry.createTaskSpace("other"),
    ]);
    assert.equal(second.error_code, "EGO_TASK_SPACE_NAME_IN_USE");
    assert.equal(third.id, 2);
    assert.equal(registry.listTaskSpaces().taskSpaces.length, 2);
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

describe("TaskSpaceRegistry limits", () => {
  const limited = (overrides, memoryMb = () => null) => {
    const browser = fakeBrowser();
    return new TaskSpaceRegistry({
      browser,
      limits: () => ({ ...DEFAULT_CONFIG, ...overrides }),
      memoryMb,
    });
  };

  it("refuses a task space past maxTaskSpaces, counting agent spaces only", async () => {
    const registry = limited({ maxTaskSpaces: 1 });
    await registry.createTaskSpace("one");
    const refused = await registry.createTaskSpace("two");
    assert.equal(refused.error_code, "EGO_RESOURCE_LIMIT");
    assert.match(refused.error, /ego-browser gc/);
    assert.equal(registry.describe(2), null);
    registry.completeTaskSpace(1);
    assert.equal((await registry.createTaskSpace("two")).id, 2);
  });

  it("refuses pages past the per-space and total limits", async () => {
    const registry = limited({ maxPagesPerSpace: 2, maxTotalPages: 3 });
    await registry.createTaskSpace("a");
    await registry.createTab(1, "about:blank");
    assert.equal(
      (await registry.createTab(1, "about:blank")).error_code,
      "EGO_RESOURCE_LIMIT",
    );
    await registry.createTaskSpace("b");
    const total = await registry.createTab(2, "about:blank");
    assert.equal(total.error_code, "EGO_RESOURCE_LIMIT");
    assert.match(total.error, /3 pages are open/);
  });

  it("refuses new pages above the memory budget; 0 turns a limit off", async () => {
    const registry = limited({ maxRssMb: 1000 }, () => 1500);
    const refused = await registry.createTaskSpace("a");
    assert.equal(refused.error_code, "EGO_RESOURCE_LIMIT");
    assert.match(refused.error, /1500 MB/);
    const unlimited = limited({ maxRssMb: 0, maxTaskSpaces: 0 }, () => 1500);
    assert.equal((await unlimited.createTaskSpace("a")).id, 1);
    assert.deepEqual(
      { ...unlimited.usage(), memoryMb: undefined },
      { taskSpaces: 1, agentTaskSpaces: 1, pages: 1, memoryMb: undefined },
    );
  });
});

describe("TaskSpaceRegistry TTL and gc", () => {
  const HOUR = 60 * 60_000;
  let clock;
  let browser;
  let registry;

  beforeEach(() => {
    clock = 1_000_000;
    browser = fakeBrowser();
    registry = new TaskSpaceRegistry({
      browser,
      now: () => clock,
      limits: () => ({
        ...DEFAULT_CONFIG,
        defaultTtlMs: 24 * HOUR,
        handOffTtlMs: HOUR,
      }),
    });
  });

  it("closes agent spaces idle past their TTL, and use resets the clock", async () => {
    await registry.createTaskSpace("default ttl");
    await registry.createTaskSpace("short", undefined, { ttlMs: HOUR });
    clock += 2 * HOUR;
    assert.deepEqual(
      (await registry.gc({ dryRun: true })).map((a) => [a.id, a.action]),
      [[2, "closed"]],
    );
    assert.notEqual(registry.describe(2), null, "dry run closes nothing");
    registry.touch(1);
    clock += 23 * HOUR;
    const actions = await registry.gc();
    assert.deepEqual(
      actions.map((a) => [a.id, a.action]),
      [[2, "closed"]],
    );
    assert.equal(registry.describe(2), null);
    assert.notEqual(registry.describe(1), null);
    clock += 2 * HOUR;
    assert.deepEqual(
      (await registry.gc()).map((a) => a.id),
      [1],
    );
  });

  it("never closes user-owned spaces", async () => {
    await registry.createTaskSpace("done");
    registry.completeTaskSpace(1);
    clock += 100 * HOUR;
    assert.deepEqual(await registry.gc(), []);
  });

  it("returns an unseen hand-off to the agent after handOffTtlMs", async () => {
    await registry.createTaskSpace("login");
    await registry.handOffTaskSpace(1);
    clock += 2 * HOUR;
    assert.deepEqual(await registry.gc({ handOffVisible: true }), []);
    const [action] = await registry.gc({ handOffVisible: false });
    assert.equal(action.action, "returned");
    assert.equal(registry.describe(1).control, "agent");
    assert.equal(registry.gate(1), null);
  });

  it("checks ttlMs", async () => {
    for (const ttlMs of [0, -5, 1.5, 31 * 24 * HOUR]) {
      const result = await registry.createTaskSpace(`t${ttlMs}`, undefined, {
        ttlMs,
      });
      assert.equal(result.error_code, "EGO_INVALID_ARGUMENT");
    }
  });
});

describe("TaskSpaceRegistry memo and restore", () => {
  let browser;
  let registry;

  beforeEach(() => {
    browser = fakeBrowser();
    registry = new TaskSpaceRegistry({ browser });
  });

  it("stores JSON per space, deletes with null, clears on complete", async () => {
    await registry.createTaskSpace("work");
    assert.deepEqual(registry.memo(1, "step", undefined, false), {
      found: false,
      value: null,
    });
    registry.memo(1, "step", { at: 5, file: "/r.csv" }, true);
    assert.deepEqual(registry.memo(1, "step", undefined, false), {
      found: true,
      value: { at: 5, file: "/r.csv" },
    });
    const saved = registry.snapshotState();
    const restored = new TaskSpaceRegistry({ browser, saved });
    assert.equal(restored.memo(1, "step", undefined, false).found, true);
    registry.memo(1, "step", null, true);
    assert.equal(registry.memo(1, "step", undefined, false).found, false);
    registry.memo(1, "k", 1, true);
    registry.completeTaskSpace(1);
    assert.equal(registry.describe(1).memo, undefined);
  });

  it("refuses a memo store past its size and bad keys", async () => {
    await registry.createTaskSpace("work");
    const big = registry.memo(1, "big", "x".repeat(MAX_MEMO_BYTES), true);
    assert.equal(big.error_code, "EGO_RESOURCE_LIMIT");
    assert.equal(
      registry.memo(1, "", 1, true).error_code,
      "EGO_INVALID_ARGUMENT",
    );
    await registry.handOffTaskSpace(1);
    assert.equal(
      registry.memo(1, "k", undefined, false).error_code,
      "EGO_TASK_SPACE_USER_IN_CONTROL",
    );
  });

  it("marks a space stale and reopens only its http(s) tabs", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/list");
    await registry.createTab(1, "https://b.test/form");
    browser.infos.set("T1", { url: "about:blank" });
    browser.infos.set("T2", { url: "https://a.test/list" });
    browser.infos.set("T3", { url: "https://b.test/form" });
    const saved = registry.snapshotState();

    const after = fakeBrowser();
    after.nextTarget = 10;
    const restarted = new TaskSpaceRegistry({ browser: after, saved });
    restarted.pruneTargets([]);
    assert.equal(restarted.describe(1).stale, true);
    const result = await restarted.restoreTabs(1);
    assert.deepEqual(
      result.tabs.map((tab) => tab.url),
      ["https://a.test/list", "https://b.test/form"],
    );
    assert.deepEqual(result.skipped, ["about:blank"]);
    assert.deepEqual(
      after.created.map((c) => c.url),
      ["https://a.test/list", "https://b.test/form"],
    );
    const space = restarted.describe(1);
    assert.equal(space.stale, undefined);
    assert.equal(space.lostTabs, undefined);
    assert.deepEqual(await restarted.restoreTabs(1), { tabs: [], skipped: [] });
  });

  it("keeps the last known URLs when the browser dies before the last save", async () => {
    await registry.createTaskSpace("work");
    await registry.createTab(1, "https://a.test/list");
    browser.infos.set("T2", { url: "https://a.test/list" });
    registry.snapshotState(); // the batched save while the browser runs
    browser.infos.clear(); // the browser is gone: no target info
    const saved = registry.snapshotState(); // the save on shutdown
    assert.deepEqual(Object.values(saved.spaces[0].tabUrls), [
      "https://a.test/list",
    ]);
    const restarted = new TaskSpaceRegistry({ browser: fakeBrowser(), saved });
    restarted.pruneTargets([]);
    assert.ok(restarted.describe(1).lostTabs.includes("https://a.test/list"));
  });
});
