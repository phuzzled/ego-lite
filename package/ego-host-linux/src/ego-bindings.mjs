/**
 * The `globalThis.ego` object the SDK expects, built on the daemon and plain
 * CDP. The contract is docs/native-bindings-api.md: argument checks throw
 * TypeError with EGO_INVALID_ARGUMENT, task commands resolve error objects,
 * and ego.snapshot() rejects with an Error that carries error_code.
 */
import { CdpConnection } from "./cdp-connection.mjs";
import {
  egoError,
  invalidArgument,
  isEgoError,
  rejectionFrom,
} from "./errors.mjs";
import { HOST_VERSION, daemonLogFile } from "./paths.mjs";
import { captureSnapshot, validateSnapshotOptions } from "./snapshot.mjs";

const NOT_SELECTED = () =>
  egoError("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");

/**
 * @param {object} options
 * @param {import("./control-channel.mjs").ControlClient} options.control
 * @param {{ wsUrl: string, spaces: object[] }} options.hello
 */
export async function createEgoBindings({ control, hello }) {
  const raw = await connectBrowser(control, hello);
  let internal = null;
  const internalConnection = async () => {
    if (!internal || internal.closed) {
      internal = await connectBrowser(control, hello);
    }
    return internal;
  };

  let spaces = summariesById(hello.spaces);
  control.onEvent((event, data) => {
    if (event === "spaces") spaces = summariesById(data);
  });

  let selected;
  // Tabs activated through raw CDP in this invocation. Kept locally so a
  // snapshot right after Target.activateTarget never races the daemon.
  const activated = new Map();

  const call = (method, params) => control.call(method, params);
  const taskCall = async (method, params = {}) => {
    if (selected === undefined) return NOT_SELECTED();
    return call(method, { id: selected, ...params });
  };

  async function activeTarget() {
    const result = await taskCall("listTabs");
    if (isEgoError(result)) return result;
    const tabs = result.tabs;
    const local = activated.get(selected);
    const chosen =
      tabs.find((tab) => tab.targetId === local) ||
      tabs.find((tab) => tab.active) ||
      tabs.at(-1);
    if (!chosen) {
      return egoError(
        `Task space ${selected} has no open tab`,
        "EGO_WEB_CONTENTS_UNAVAILABLE",
      );
    }
    return chosen.targetId;
  }

  const ego = {
    async getBrowserVersion(...args) {
      expectArgs("getBrowserVersion", args, 0);
      return { currentVersion: HOST_VERSION, updateAvailable: false };
    },

    useTaskSpace(...args) {
      expectArgs("useTaskSpace", args, 1);
      const [id] = args;
      if (typeof id !== "number" || !Number.isFinite(id)) {
        throw invalidArgument("useTaskSpace(id) requires a numeric id");
      }
      selected = id;
      return id;
    },

    async listProfiles(...args) {
      expectArgs("listProfiles", args, 0);
      return call("listProfiles");
    },

    async listTaskSpaces(...args) {
      expectArgs("listTaskSpaces", args, 0);
      return call("listTaskSpaces");
    },

    async createTaskSpace(...args) {
      expectArgs("createTaskSpace", args, 1, 2);
      const [name, profileId] = args;
      if (typeof name !== "string" || name.length === 0) {
        throw invalidArgument(
          "createTaskSpace(name) requires a non-empty name",
        );
      }
      if (profileId !== undefined && typeof profileId !== "string") {
        throw invalidArgument("createTaskSpace profileId must be a string");
      }
      return call("createTaskSpace", { name, profileId });
    },

    async claimTaskSpace(...args) {
      expectArgs("claimTaskSpace", args, 1, 2);
      const [id, name] = args;
      if (typeof id !== "number" || !Number.isFinite(id)) {
        throw invalidArgument("claimTaskSpace(id) requires a numeric id");
      }
      if (name !== undefined && typeof name !== "string") {
        throw invalidArgument("claimTaskSpace name must be a string");
      }
      return call("claimTaskSpace", { id, name });
    },

    async closeTaskSpace(...args) {
      expectArgs("closeTaskSpace", args, 0);
      return taskCall("closeTaskSpace");
    },

    async completeTaskSpace(...args) {
      expectArgs("completeTaskSpace", args, 0);
      return taskCall("completeTaskSpace");
    },

    async handOffTaskSpace(...args) {
      expectArgs("handOffTaskSpace", args, 0);
      return taskCall("handOffTaskSpace");
    },

    async takeOverTaskSpace(...args) {
      expectArgs("takeOverTaskSpace", args, 0);
      return taskCall("takeOverTaskSpace");
    },

    async setAgentTaskState(...args) {
      expectArgs("setAgentTaskState", args, 1);
      if (typeof args[0] !== "string") {
        throw invalidArgument("setAgentTaskState(state) requires a string");
      }
      return taskCall("setAgentTaskState", { state: args[0] });
    },

    async createTab(...args) {
      expectArgs("createTab", args, 1);
      if (typeof args[0] !== "string") {
        throw invalidArgument("createTab(url) requires a string url");
      }
      const result = await taskCall("createTab", { url: args[0] });
      if (!isEgoError(result)) activated.set(selected, result.targetId);
      return result;
    },

    async listTabs(...args) {
      expectArgs("listTabs", args, 0);
      const result = await taskCall("listTabs");
      const local = activated.get(selected);
      if (
        !isEgoError(result) &&
        result.tabs.some((t) => t.targetId === local)
      ) {
        for (const tab of result.tabs) tab.active = tab.targetId === local;
      }
      return result;
    },

    async snapshot(...args) {
      expectArgs("snapshot", args, 0, 1);
      const options = validateSnapshotOptions(args[0]);
      const targetId = await activeTarget();
      if (isEgoError(targetId)) throw rejectionFrom(targetId);
      try {
        return await captureSnapshot(
          await internalConnection(),
          targetId,
          options,
        );
      } catch (error) {
        if (error?.error_code) throw error;
        const failure = new Error(String(error?.message || error));
        failure.error_code = "EGO_SNAPSHOT_FAILED";
        throw failure;
      }
    },

    async animationHighlightMouseToPosition(...args) {
      expectArgs("animationHighlightMouseToPosition", args, 2);
      const [x, y] = args;
      if (![x, y].every((value) => typeof value === "number")) {
        throw invalidArgument(
          "animationHighlightMouseToPosition(x, y) requires numbers",
        );
      }
      const targetId = await activeTarget();
      if (isEgoError(targetId)) return targetId;
      await showHighlight(await internalConnection(), targetId, x, y).catch(
        () => {},
      );
      return `${selected} mouse highlight shown.`;
    },

    sendCDPMessage(...args) {
      expectArgs("sendCDPMessage", args, 1);
      const [message] = args;
      if (typeof message !== "string") {
        throw invalidArgument("sendCDPMessage(message) requires a JSON string");
      }
      if (raw.closed) {
        const error = new TypeError("CDP channel is not connected");
        error.error_code = "EGO_CDP_CHANNEL_UNAVAILABLE";
        throw error;
      }
      const blocked = rawCdpGate(selected, spaces);
      if (blocked) {
        setImmediate(() => {
          const callback = ego.onSendCDPMessageError;
          if (typeof callback === "function") {
            callback(blocked.error, blocked.error_code);
          }
        });
        return undefined;
      }
      trackActivation(message, selected, spaces, activated, call);
      raw.sendRaw(message);
      return undefined;
    },

    onCDPMessage: null,
    onSendCDPMessageError: null,
  };

  raw.onMessage((text) => {
    const callback = ego.onCDPMessage;
    if (typeof callback === "function") callback(text);
  });

  Object.defineProperty(ego, "close", {
    enumerable: false,
    value() {
      raw.close();
      internal?.close();
    },
  });
  return ego;
}

/**
 * Connect to the browser endpoint. When that fails, ask the daemon again:
 * hello checks the browser and returns the endpoint it is using now.
 */
export async function connectBrowser(control, hello) {
  try {
    return await CdpConnection.connect(hello.wsUrl);
  } catch (first) {
    const fresh = await control.call("hello").catch(() => null);
    if (fresh?.wsUrl) {
      try {
        const connection = await CdpConnection.connect(fresh.wsUrl);
        hello.wsUrl = fresh.wsUrl;
        return connection;
      } catch {
        // Fall through to the error below.
      }
    }
    throw Object.assign(
      new Error(
        `${first.message}. Run \`ego-browser stop\`, then run the script again. Log: ${daemonLogFile()}`,
      ),
      { error_code: "EGO_BROWSER_UNAVAILABLE" },
    );
  }
}

function summariesById(list = []) {
  return new Map(list.map((space) => [space.id, space]));
}

/** Same rules as TaskSpaceRegistry.gate, from the pushed space summaries. */
export function rawCdpGate(selected, spaces) {
  if (selected === undefined) return NOT_SELECTED();
  const space = spaces.get(selected);
  if (!space) {
    return egoError(
      `Task space not found: ${selected}`,
      "EGO_TASK_SPACE_NOT_FOUND",
    );
  }
  if (space.ownership !== "agent") {
    return egoError(
      `Task space ${selected} is no longer assigned to the agent`,
      "EGO_TASK_SPACE_INACTIVE",
    );
  }
  if (space.control === "user") {
    return egoError(
      space.controlReason || "manual_takeover",
      "EGO_TASK_SPACE_USER_IN_CONTROL",
    );
  }
  return null;
}

function trackActivation(message, selected, spaces, activated, call) {
  if (!message.includes("Target.activateTarget")) return;
  let parsed;
  try {
    parsed = JSON.parse(message);
  } catch {
    return;
  }
  const targetId = parsed?.params?.targetId;
  if (parsed?.method !== "Target.activateTarget" || !targetId) return;
  if (!spaces.get(selected)?.targets?.includes(targetId)) return;
  activated.set(selected, targetId);
  call("setActiveTarget", { id: selected, targetId }).catch(() => {});
}

function expectArgs(name, args, min, max = min) {
  if (args.length < min || args.length > max) {
    throw invalidArgument(
      `${name} expects ${min === max ? min : `${min}-${max}`} argument(s), got ${args.length}`,
    );
  }
}

async function showHighlight(cdp, targetId, x, y) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const dot = document.createElement("div");
          dot.setAttribute("aria-hidden", "true");
          dot.style.cssText = "position:fixed;left:${x - 10}px;top:${y - 10}px;width:20px;height:20px;border-radius:50%;background:rgba(255,120,0,.55);pointer-events:none;z-index:2147483647;transition:opacity .5s;";
          (document.body || document.documentElement).appendChild(dot);
          setTimeout(() => { dot.style.opacity = "0"; }, 250);
          setTimeout(() => dot.remove(), 800);
        })()`,
      },
      sessionId,
      5_000,
    );
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}
