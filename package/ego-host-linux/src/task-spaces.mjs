/**
 * Task-space registry kept by the daemon.
 *
 * A task space is a named set of page targets with an owner. Membership is
 * tracked by target id, not by window, so popups join their opener's space and
 * window placement stays cosmetic. Result shapes and error codes follow
 * docs/native-bindings-api.md.
 */
import { egoError } from "./errors.mjs";

export const DEFAULT_PROFILE = Object.freeze({
  id: "Default",
  name: "Default",
  isDefault: true,
});

export class TaskSpaceRegistry {
  #spaces = new Map();
  #nextId = 1;
  #browser;
  #save;
  #onChange;

  /**
   * @param {object} options
   * @param {object} options.browser  createTarget/closeTarget/activateTarget/targetInfo
   * @param {object} [options.saved]  previously saved state
   * @param {(state: object) => void} [options.save]
   * @param {() => void} [options.onChange]
   */
  constructor({ browser, saved, save = () => {}, onChange = () => {} }) {
    this.#browser = browser;
    this.#save = save;
    this.#onChange = onChange;
    if (saved && Array.isArray(saved.spaces)) {
      for (const space of saved.spaces) {
        this.#spaces.set(space.id, { ...space, targets: [...space.targets] });
      }
      this.#nextId = Math.max(saved.nextId || 1, this.#maxId() + 1);
    }
  }

  listProfiles() {
    return { profiles: [{ ...DEFAULT_PROFILE }] };
  }

  /** Drop targets that no longer exist, for example after a browser restart. */
  pruneTargets(liveTargetIds) {
    const live = new Set(liveTargetIds);
    for (const space of this.#spaces.values()) {
      space.targets = space.targets.filter((targetId) => live.has(targetId));
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

  /** A new space opens with one default blank tab, as in ego lite. */
  async createTaskSpace(name, profileId) {
    if (profileId && profileId !== "default" && profileId !== "Default") {
      return egoError("Profile not found", "EGO_PROFILE_NOT_FOUND");
    }
    const space = {
      id: this.#nextId++,
      name,
      createdBy: "agent",
      ownership: "agent",
      control: "agent",
      controlReason: null,
      profileId: DEFAULT_PROFILE.id,
      profileName: DEFAULT_PROFILE.name,
      state: "",
      targets: [],
      activeTargetId: null,
    };
    this.#spaces.set(space.id, space);
    const tab = await this.createTab(space.id, "about:blank");
    if (tab.error_code) {
      this.#spaces.delete(space.id);
      this.#changed();
      return egoError(tab.error, "EGO_BROWSER_UNAVAILABLE");
    }
    return descriptor(space);
  }

  claimTaskSpace(id, name) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    space.ownership = "agent";
    space.control = "agent";
    space.controlReason = null;
    if (typeof name === "string" && name.length > 0) space.name = name;
    this.#changed();
    return descriptor(space);
  }

  async closeTaskSpace(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.control === "user") return userInControl(space);
    this.#spaces.delete(id);
    this.#changed();
    await Promise.allSettled(
      space.targets.map((targetId) => this.#browser.closeTarget(targetId)),
    );
    return `${id} task space closed.`;
  }

  completeTaskSpace(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.control === "user") return userInControl(space);
    space.ownership = "user";
    space.state = "";
    this.#changed();
    return `${id} task space completed.`;
  }

  async handOffTaskSpace(id, reason = "manual_takeover") {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    space.control = "user";
    space.controlReason = reason;
    this.#changed();
    if (space.activeTargetId) {
      await this.#browser.activateTarget(space.activeTargetId).catch(() => {});
    }
    return `${id} has been handed off to the user.`;
  }

  takeOverTaskSpace(id) {
    const space = this.#spaces.get(id);
    if (!space) return notFound(id);
    if (space.ownership !== "agent") return inactive(id);
    space.control = "agent";
    space.controlReason = null;
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
    const space = this.#spaces.get(id);
    const anchor = space.activeTargetId ?? space.targets.at(-1);
    let targetId;
    try {
      targetId = await this.#browser.createTarget(url, { anchor });
    } catch (error) {
      return egoError(String(error?.message || error), "EGO_OPERATION_FAILED");
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
    this.#changed();
  }

  /** A page opened by a page in a space (window.open, target=_blank) joins it. */
  handleTargetCreated(info) {
    if (info.type !== "page" || !info.openerId) return;
    const id = this.spaceOfTarget(info.openerId);
    if (id !== null) this.addTarget(id, info.targetId);
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

  snapshotState() {
    return {
      nextId: this.#nextId,
      spaces: [...this.#spaces.values()].map((space) => structuredClone(space)),
    };
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
