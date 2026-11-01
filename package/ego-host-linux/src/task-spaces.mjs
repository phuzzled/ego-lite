/**
 * Task-space registry kept by the daemon.
 *
 * A task space is a named set of page targets with an owner. Membership is
 * tracked by target id, not by window, so popups join their opener's space and
 * window placement stays cosmetic. Result shapes and error codes follow
 * docs/native-bindings-api.md.
 *
 * Linux-host additions: a last-activity time and TTL per space (`gc`),
 * resource limits, a small memo store per space, the URLs of tabs lost
 * in a browser restart, which `restoreTabs` can reopen, and profiles
 * (profiles.mjs): a space is bound to its profile's browser for life, and an
 * `ephemeral` space has its own browser context, deleted with the space.
 */
import { DEFAULT_CONFIG, MAX_TTL_MS } from "./config.mjs";
import { egoError } from "./errors.mjs";

export const DEFAULT_PROFILE = Object.freeze({
  id: "Default",
  name: "Default",
  isDefault: true,
});

/** Profiles when the daemon passes none: only Default. */
const DEFAULT_ONLY = {
  list: () => ({ profiles: [{ ...DEFAULT_PROFILE }] }),
  resolve: (profileId) =>
    !profileId || profileId === "default" || profileId === DEFAULT_PROFILE.id
      ? { id: DEFAULT_PROFILE.id, name: DEFAULT_PROFILE.name, kind: "default" }
      : null,
};

/** Browser (profile) that runs a space's tabs: ephemeral ones live in Default. */
export function browserOfProfile(profileId) {
  return !profileId || profileId === "ephemeral"
    ? DEFAULT_PROFILE.id
    : profileId;
}

/** Largest memo store per space, as JSON text. */
export const MAX_MEMO_BYTES = 64 * 1024;
const MAX_MEMO_KEY = 200;
/** Save last-activity times at most this often. */
const ACTIVITY_SAVE_MS = 60_000;

export class TaskSpaceRegistry {
  #spaces = new Map();
  #nextId = 1;
  #browser;
  #save;
  #onChange;
  #now;
  #limits;
  #memoryMb;
  #profiles;

  /**
   * @param {object} options
   * @param {object} options.browser  createTarget/closeTarget/activateTarget/targetInfo
   * @param {object} [options.saved]  previously saved state
   * @param {(state: object) => void} [options.save]
   * @param {() => void} [options.onChange]
   * @param {() => number} [options.now]
   * @param {() => object} [options.limits]   current config (see config.mjs)
   * @param {() => number | null} [options.memoryMb]  browser memory use
   * @param {{ list(): object, resolve(id?: string): object | null }} [options.profiles]
   *   see ProfileStore in profiles.mjs
   */
  constructor({
    browser,
    saved,
    save = () => {},
    onChange = () => {},
    now = Date.now,
    limits = () => DEFAULT_CONFIG,
    memoryMb = () => null,
    profiles = DEFAULT_ONLY,
  }) {
    this.#browser = browser;
    this.#save = save;
    this.#onChange = onChange;
    this.#now = now;
    this.#limits = limits;
    this.#memoryMb = memoryMb;
    this.#profiles = profiles;
    if (saved && Array.isArray(saved.spaces)) {
      for (const space of saved.spaces) {
        // A browser context does not outlive the browser: a saved ephemeral
        // space is gone, with its cookies.
        if (space.profileId === "ephemeral") continue;
        this.#spaces.set(space.id, {
          ...space,
          targets: [...space.targets],
          lastActivity: space.lastActivity ?? this.#now(),
        });
      }
      this.#nextId = Math.max(saved.nextId || 1, this.#maxId() + 1);
    }
  }

  listProfiles() {
    return this.#profiles.list();
  }

  /** Ids of the spaces bound to a profile. */
  spacesOfProfile(profileId) {
    return [...this.#spaces.values()]
      .filter((space) => (space.profileId ?? DEFAULT_PROFILE.id) === profileId)
      .map((space) => space.id);
  }

  /** Browsers (profile ids) that run at least one space's tabs. */
  browsersInUse() {
    return new Set(
      [...this.#spaces.values()].map((space) =>
        browserOfProfile(space.profileId),
      ),
    );
  }

  /** Browser (profile id) that runs a space's tabs, or null. */
  browserOfSpace(id) {
    const space = this.#spaces.get(id);
    return space ? browserOfProfile(space.profileId) : null;
  }

  /** Drop targets that no longer exist, for example after a browser restart. */
  pruneTargets(liveTargetIds) {
    const live = new Set(liveTargetIds);
    for (const space of this.#spaces.values()) {
      const lost = space.targets.filter((targetId) => !live.has(targetId));
      if (lost.length > 0) {
        // Remember what was open, so the agent learns why its Pages are gone
        // and the tabs can be reopened.
        space.lostTabs = lost.map(
          (targetId) => space.tabUrls?.[targetId] ?? "",
        );
      }
      space.tabUrls = {};
      space.targets = space.targets.filter((targetId) => live.has(targetId));
      // A space whose every tab is gone is stale until it gets a new tab.
      if (lost.length > 0 && space.targets.length === 0) space.stale = true;
      if (!live.has(space.activeTargetId)) {
        space.activeTargetId = space.targets.at(-1) ?? null;
      }
    }
    this.#changed();
  }

  listTaskSpaces() {
    return {
      taskSpaces: [...this.#spaces.values()].map((space) => ({
        taskId: space.name,
        id: space.id,
        name: space.name,
        createdBy: space.createdBy,
        ownership:
          space.ownership === "agent" && space.control === "user"
            ? "agentDelegatedToUser"
            : space.ownership,
        profileId: space.profileId,
        profileName: space.profileName,
        recentTabTitles: space.targets
          .map((targetId) => this.#browser.targetInfo(targetId)?.title)
          .filter((title) => typeof title === "string" && title.length > 0)
          .slice(-5),
      })),
    };
  }

  /** Full internal view of one space, used by the CLI-side bindings. */
  describe(id) {
    const space = this.#spaces.get(id);
    return space ? structuredClone(space) : null;
  }

  /**
   * A new space opens with one default blank tab, as in ego lite.
   * @param {{ ttlMs?: number }} [options]
   */
  async createTaskSpace(name, profileId, options = {}) {
    const profile = this.#profiles.resolve(profileId);
    if (!profile) {
      return egoError("Profile not found", "EGO_PROFILE_NOT_FOUND");
    }
    const ttl = checkTtl(options.ttlMs);
    if (ttl.error) return ttl.error;
    // Names are unique, as in ego lite. Two agents that start the same task
    // at once must end up in one space, not two.
    for (const existing of this.#spaces.values()) {
      if (existing.name === name) {
        return egoError(
          `Task space name already in use: ${name} (id ${existing.id})`,
          "EGO_TASK_SPACE_NAME_IN_USE",
        );
      }
    }
    const limits = this.#limits();
    const agentSpaces = [...this.#spaces.values()].filter(
      (space) => space.ownership === "agent",
    ).length;
    if (limits.maxTaskSpaces > 0 && agentSpaces >= limits.maxTaskSpaces) {
      return resourceLimit(
        `${agentSpaces} agent task spaces are open (limit ${limits.maxTaskSpaces})`,
      );
    }
    const pageLimit = this.#pageLimit(null);
    if (pageLimit) return pageLimit;
    const space = {
      id: this.#nextId++,
      name,
      createdBy: "agent",
      ownership: "agent",
      control: "agent",
      controlReason: null,
      profileId: profile.id,
      profileName: profile.name,
      state: "",
      targets: [],
      activeTargetId: null,
      createdAt: this.#now(),
      lastActivity: this.#now(),
    };
    if (ttl.value !== undefined) space.ttlMs = ttl.value;
    if (profile.kind === "ephemeral") {
      try {
        space.browserContextId = await this.#browser.createContext();
      } catch (error) {
        return egoError(
          `Cannot create an ephemeral profile: ${error?.message || error}`,
          "EGO_BROWSER_UNAVAILABLE",
        );
      }
    }
    this.#spaces.set(space.id, space);
    const tab = await this.createTab(space.id, "about:blank");
    if (tab.error_code) {
      this.#spaces.delete(space.id);
      this.#changed();
      await this.#disposeContext(space);
      return ["EGO_RESOURCE_LIMIT", "EGO_PROFILE_BUSY"].includes(tab.error_code)
        ? tab
        : egoError(tab.error, "EGO_BROWSER_UNAVAILABLE");
    }
    return descriptor(space);
  }

  claimTaskSpace(id, name) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    space.ownership = "agent";
    space.control = "agent";
    space.controlReason = null;
    space.lastActivity = this.#now();
    if (typeof name === "string" && name.length > 0) space.name = name;
    this.#changed();
    return descriptor(space);
  }

  /** `force` is the user acting through the CLI: it closes a handed-off space. */
  async closeTaskSpace(id, { force = false } = {}) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.control === "user" && !force) return userInControl(space);
    this.#spaces.delete(id);
    this.#changed();
    await Promise.allSettled(
      space.targets.map((targetId) => this.#browser.closeTarget(targetId)),
    );
    await this.#disposeContext(space);
    return `${id} task space closed.`;
  }

  /** Delete an ephemeral space's browser context, with its cookies. */
  async #disposeContext(space) {
    if (!space.browserContextId) return;
    await Promise.resolve()
      .then(() => this.#browser.disposeContext?.(space.browserContextId))
      .catch(() => {});
  }

  /**
   * finish(): the space goes to the user; its memo store is cleared. An
   * ephemeral space is deleted instead, with its cookies: nobody can come
   * back to a throwaway profile.
   */
  async completeTaskSpace(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.control === "user") return userInControl(space);
    if (space.profileId === "ephemeral") {
      await this.closeTaskSpace(id);
      return `${id} task space completed.`;
    }
    space.ownership = "user";
    space.state = "";
    delete space.memo;
    this.#changed();
    return `${id} task space completed.`;
  }

  async handOffTaskSpace(id, reason = "manual_takeover") {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    space.control = "user";
    space.controlReason = reason;
    space.lastActivity = this.#now();
    this.#changed();
    if (space.activeTargetId) {
      // showTarget also brings the window to the front and fills the screen.
      const show = this.#browser.showTarget ?? this.#browser.activateTarget;
      await Promise.resolve()
        .then(() => show.call(this.#browser, space.activeTargetId))
        .catch(() => {});
    }
    return `${id} has been handed off to the user.`;
  }

  takeOverTaskSpace(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.ownership !== "agent") return inactive(id);
    space.control = "agent";
    space.controlReason = null;
    space.lastActivity = this.#now();
    this.#changed();
    return `${id} has been taken over by the agent.`;
  }

  setAgentTaskState(id, state) {
    const gate = this.gate(id);
    if (gate) return gate;
    this.#spaces.get(id).state = state;
    this.#changed();
    return `${id} state updated.`;
  }

  async createTab(id, url) {
    const gate = this.gate(id);
    if (gate) return gate;
    const limit = this.#pageLimit(id);
    if (limit) return limit;
    const space = this.#spaces.get(id);
    const anchor = space.activeTargetId ?? space.targets.at(-1);
    let targetId;
    try {
      targetId = await this.#browser.createTarget(url, {
        anchor,
        profileId: browserOfProfile(space.profileId),
        browserContextId: space.browserContextId,
      });
    } catch (error) {
      return egoError(
        String(error?.message || error),
        error?.error_code || "EGO_OPERATION_FAILED",
      );
    }
    // The space may have been closed while the browser created the tab.
    if (!this.#spaces.has(id)) {
      await this.#browser.closeTarget(targetId).catch(() => {});
      return notFound(id);
    }
    this.addTarget(id, targetId);
    return { targetId, url };
  }

  listTabs(id) {
    const gate = this.gate(id);
    if (gate) return gate;
    const space = this.#spaces.get(id);
    return {
      tabs: space.targets.map((targetId, index) => {
        const info = this.#browser.targetInfo(targetId) || {};
        return {
          index,
          targetId,
          url: info.url ?? "",
          title: info.title ?? "",
          active: targetId === space.activeTargetId,
        };
      }),
    };
  }

  setActiveTarget(id, targetId) {
    const space = this.#spaces.get(id);
    if (!space || !space.targets.includes(targetId)) return false;
    if (space.activeTargetId !== targetId) {
      space.activeTargetId = targetId;
      this.#changed();
    }
    return true;
  }

  /** Error object when task commands may not run in this space, else null. */
  gate(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.ownership !== "agent") return inactive(id);
    if (space.control === "user") return userInControl(space);
    return null;
  }

  spaceOfTarget(targetId) {
    for (const space of this.#spaces.values()) {
      if (space.targets.includes(targetId)) return space.id;
    }
    return null;
  }

  addTarget(id, targetId) {
    const space = this.#spaces.get(id);
    if (!space) return;
    if (!space.targets.includes(targetId)) space.targets.push(targetId);
    space.activeTargetId = targetId;
    delete space.lostTabs;
    delete space.stale;
    this.#changed();
  }

  /** A page opened by a page in a space (window.open, target=_blank) joins it. */
  handleTargetCreated(info) {
    if (info.type !== "page" || !info.openerId) return;
    const id = this.spaceOfTarget(info.openerId);
    if (id !== null) this.addTarget(id, info.targetId);
  }

  /**
   * Tabs gone with a browser that stopped (a profile browser crashed): keep
   * their URLs for `restoreTabs`, as after a daemon restart.
   * @param {string[]} targetIds
   * @param {(targetId: string) => string | undefined} urlOf
   */
  loseTargets(targetIds, urlOf) {
    const gone = new Set(targetIds);
    let touched = false;
    for (const space of this.#spaces.values()) {
      const lost = space.targets.filter((targetId) => gone.has(targetId));
      if (lost.length === 0) continue;
      touched = true;
      space.lostTabs = [
        ...(space.lostTabs ?? []),
        ...lost.map((targetId) => urlOf(targetId) ?? ""),
      ];
      space.targets = space.targets.filter((targetId) => !gone.has(targetId));
      if (space.targets.length === 0) space.stale = true;
      if (gone.has(space.activeTargetId)) {
        space.activeTargetId = space.targets.at(-1) ?? null;
      }
    }
    if (touched) this.#changed();
  }

  handleTargetDestroyed(targetId) {
    let touched = false;
    for (const space of this.#spaces.values()) {
      const index = space.targets.indexOf(targetId);
      if (index < 0) continue;
      space.targets.splice(index, 1);
      if (space.activeTargetId === targetId) {
        space.activeTargetId = space.targets.at(-1) ?? null;
      }
      touched = true;
    }
    if (touched) this.#changed();
  }

  /** Record use of a space; `gc` measures idle time from here. */
  touch(id) {
    const space = this.#spaces.get(id);
    if (!space) return;
    const now = this.#now();
    const unsaved = now - (space.lastActivity ?? 0) >= ACTIVITY_SAVE_MS;
    space.lastActivity = now;
    if (unsaved) this.#save(this.snapshotState());
  }

  /**
   * Read (`hasValue` false) or write one memo entry. A value of null deletes
   * the key. The store is JSON, at most MAX_MEMO_BYTES per space.
   */
  memo(id, key, value, hasValue) {
    const gate = this.gate(id);
    if (gate) return gate;
    if (
      typeof key !== "string" ||
      key.length === 0 ||
      key.length > MAX_MEMO_KEY
    ) {
      return egoError(
        `memo key must be a string of 1-${MAX_MEMO_KEY} characters`,
        "EGO_INVALID_ARGUMENT",
      );
    }
    const space = this.#spaces.get(id);
    const store = space.memo ?? {};
    if (!hasValue) {
      return { found: Object.hasOwn(store, key), value: store[key] ?? null };
    }
    const next = { ...store };
    if (value === null) delete next[key];
    else next[key] = value;
    const size = Buffer.byteLength(JSON.stringify(next));
    if (size > MAX_MEMO_BYTES) {
      return egoError(
        `memo store of task space ${id} would be ${size} bytes (limit ${MAX_MEMO_BYTES})`,
        "EGO_RESOURCE_LIMIT",
      );
    }
    space.memo = next;
    this.#changed();
    return { found: value !== null, value };
  }

  /**
   * Reopen the http(s) tabs a browser restart closed. GET only, by design:
   * a form POST is never replayed. Other URLs are reported, not opened.
   */
  async restoreTabs(id) {
    const gate = this.gate(id);
    if (gate) return gate;
    const space = this.#spaces.get(id);
    const lost = [...(space.lostTabs ?? [])];
    const tabs = [];
    const skipped = [];
    for (const url of lost) {
      if (!/^https?:\/\//i.test(url)) {
        skipped.push(url);
        continue;
      }
      const tab = await this.createTab(id, url);
      if (tab.error_code) return { ...tab, tabs, skipped };
      tabs.push(tab);
    }
    if (this.#spaces.has(id)) {
      delete this.#spaces.get(id).lostTabs;
      delete this.#spaces.get(id).stale;
      this.#changed();
    }
    return { tabs, skipped };
  }

  /** Use against the limits, for `ego-browser status`. */
  usage() {
    const spaces = [...this.#spaces.values()];
    return {
      taskSpaces: spaces.length,
      agentTaskSpaces: spaces.filter((space) => space.ownership === "agent")
        .length,
      pages: spaces.reduce((sum, space) => sum + space.targets.length, 0),
      memoryMb: this.#memoryMb(),
    };
  }

  /**
   * Close agent spaces idle past their TTL. Never touches user-owned spaces.
   * A space handed to the user waits; when nobody can see the browser
   * (`handOffVisible` false) it returns to the agent after handOffTtlMs.
   * @returns {Promise<{ id: number, name: string, action: "closed" | "returned", idleMs: number }[]>}
   */
  async gc({ dryRun = false, handOffVisible = false } = {}) {
    const limits = this.#limits();
    const now = this.#now();
    const actions = [];
    for (const space of [...this.#spaces.values()]) {
      if (space.ownership !== "agent") continue;
      const idleMs = now - (space.lastActivity ?? now);
      if (space.control === "user") {
        if (!handOffVisible && idleMs >= limits.handOffTtlMs) {
          actions.push({
            id: space.id,
            name: space.name,
            action: "returned",
            idleMs,
          });
          if (!dryRun) {
            space.control = "agent";
            space.controlReason = null;
            space.lastActivity = now;
            this.#changed();
          }
        }
        continue;
      }
      const ttl = space.ttlMs ?? limits.defaultTtlMs;
      if (ttl > 0 && idleMs >= ttl) {
        actions.push({
          id: space.id,
          name: space.name,
          action: "closed",
          idleMs,
        });
        if (!dryRun) await this.closeTaskSpace(space.id);
      }
    }
    return actions;
  }

  /** Saved state, with the last known URL of each tab. */
  snapshotState() {
    return {
      nextId: this.#nextId,
      spaces: [...this.#spaces.values()].map((space) => {
        const copy = structuredClone(space);
        copy.tabUrls = {};
        for (const targetId of space.targets) {
          const url =
            this.#browser.targetInfo(targetId)?.url ??
            space.tabUrls?.[targetId];
          if (url) copy.tabUrls[targetId] = url;
        }
        return copy;
      }),
    };
  }

  /** EGO_RESOURCE_LIMIT when one more page would pass a limit, else null. */
  #pageLimit(id) {
    const limits = this.#limits();
    const space = id === null ? null : this.#spaces.get(id);
    if (
      space &&
      limits.maxPagesPerSpace > 0 &&
      space.targets.length >= limits.maxPagesPerSpace
    ) {
      return resourceLimit(
        `task space ${id} has ${space.targets.length} pages (limit ${limits.maxPagesPerSpace})`,
      );
    }
    const pages = [...this.#spaces.values()].reduce(
      (sum, each) => sum + each.targets.length,
      0,
    );
    if (limits.maxTotalPages > 0 && pages >= limits.maxTotalPages) {
      return resourceLimit(
        `${pages} pages are open in all task spaces (limit ${limits.maxTotalPages})`,
      );
    }
    if (limits.maxRssMb > 0) {
      const memory = this.#memoryMb();
      if (memory !== null && memory >= limits.maxRssMb) {
        return resourceLimit(
          `the browser uses ${memory} MB (limit ${limits.maxRssMb} MB)`,
        );
      }
    }
    return null;
  }

  #maxId() {
    let max = 0;
    for (const id of this.#spaces.keys()) max = Math.max(max, id);
    return max;
  }

  #changed() {
    this.#save(this.snapshotState());
    this.#onChange();
  }
}

function checkTtl(ttlMs) {
  if (ttlMs === undefined || ttlMs === null) return {};
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    return {
      error: egoError(
        `ttlMs must be a whole number of milliseconds from 1 to ${MAX_TTL_MS}`,
        "EGO_INVALID_ARGUMENT",
      ),
    };
  }
  return { value: ttlMs };
}

function resourceLimit(detail) {
  return egoError(
    `Resource limit reached: ${detail}. Close Pages you no longer need, or run \`ego-browser gc\`.`,
    "EGO_RESOURCE_LIMIT",
  );
}

function descriptor(space) {
  return { taskId: space.name, id: space.id, name: space.name };
}

function notFound(id) {
  return egoError(`Task space not found: ${id}`, "EGO_TASK_SPACE_NOT_FOUND");
}

function inactive(id) {
  return egoError(
    `Task space ${id} is no longer assigned to the agent`,
    "EGO_TASK_SPACE_INACTIVE",
  );
}

function userInControl(space) {
  return egoError(
    space.controlReason || "manual_takeover",
    "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
}
