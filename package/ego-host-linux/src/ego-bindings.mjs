/**
 * The `globalThis.ego` object the SDK expects, built on the daemon and plain
 * CDP. The contract is docs/native-bindings-api.md: argument checks throw
 * TypeError with EGO_INVALID_ARGUMENT, task commands resolve error objects,
 * and ego.snapshot() rejects with an Error that carries error_code.
 *
 * Linux-host additions, which the SDK can feature-detect with
 * `ego.getHostCapabilities()`:
 * - createTaskSpace(name, profileId?, { ttlMs }) for `gc`;
 * - handOffTaskSpace({ relay: true }) writes a screenshot and a snapshot
 *   for the user instead of handing off;
 * - taskSpaceMemo(key, value?) and restoreTaskSpaceTabs() for re-runs;
 * - logEvent(entry) adds an action to the round log;
 * - listProfiles() lists named profiles and `ephemeral`; a task space of a
 *   named profile runs in that profile's browser, and raw CDP is routed
 *   there (cdp-router.mjs);
 * - fillSecret(name, { targetId, clear }) types a stored secret into the
 *   focused field; the daemon does the typing, so the value never enters
 *   this process.
 */
import { CdpConnection } from "./cdp-connection.mjs";
import { CdpRouter } from "./cdp-router.mjs";
import {
  egoError,
  invalidArgument,
  isEgoError,
  rejectionFrom,
} from "./errors.mjs";
import { HOST_VERSION, daemonLogFile } from "./paths.mjs";
import { sanitizeEntry } from "./round-log.mjs";
import { captureSnapshot, validateSnapshotOptions } from "./snapshot.mjs";
import { DEFAULT_PROFILE, browserOfProfile } from "./task-spaces.mjs";

const NOT_SELECTED = () =>
  egoError("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");

/** CDP commands that are agent actions worth a line in the round log. */
const LOGGED_CDP = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Input.insertText",
  "DOM.setFileInputFiles",
  "Target.createTarget",
  "Target.closeTarget",
]);

/** Bindings that are not logged as actions. */
const UNLOGGED = new Set(["useTaskSpace", "getHostCapabilities", "logEvent"]);

/**
 * @param {object} options
 * @param {import("./control-channel.mjs").ControlClient} options.control
 * @param {{ spaces: object[], round?: string, display?: string, headless?: boolean }} options.hello
 */
export async function createEgoBindings({ control, hello }) {
  const raw = new CdpRouter({
    initial: await connectBrowser(control, hello),
    connect: (browser) => connectBrowser(control, hello, browser),
    defaultBrowser: DEFAULT_PROFILE.id,
  });
  // One connection per browser for the bindings' own CDP (snapshots).
  const internal = new Map();
  const internalConnection = async (browser = DEFAULT_PROFILE.id) => {
    let connection = internal.get(browser);
    if (!connection || connection.closed) {
      connection = await connectBrowser(control, hello, browser);
      internal.set(browser, connection);
    }
    return connection;
  };

  let spaces = summariesById(hello.spaces);
  control.onEvent((event, data) => {
    if (event === "spaces") spaces = summariesById(data);
  });
  /** Browser (profile) that runs a space's tabs. */
  const browserOf = (id) => browserOfProfile(spaces.get(id)?.profileId);
  const browserOfTarget = (targetId) => {
    for (const space of spaces.values()) {
      if (space.targets?.includes(targetId)) {
        return browserOfProfile(space.profileId);
      }
    }
    return undefined;
  };

  let selected;
  const noticed = new Set();
  // Tabs activated through raw CDP in this invocation. Kept locally so a
  // snapshot right after Target.activateTarget never races the daemon.
  const activated = new Map();
  const roundLog = createRoundLogger(control, hello.round);

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

    /** Host extensions this binding set supports. */
    getHostCapabilities(...args) {
      expectArgs("getHostCapabilities", args, 0);
      return {
        host: "linux",
        taskSpaceTtl: true,
        taskSpaceMemo: true,
        restoreTaskSpaceTabs: true,
        handOffRelay: true,
        handOffViewer: hello.display === "virtual",
        logEvent: true,
        profiles: true,
        ephemeralProfile: true,
        fillSecret: true,
      };
    },

    useTaskSpace(...args) {
      expectArgs("useTaskSpace", args, 1);
      const [id] = args;
      if (typeof id !== "number" || !Number.isFinite(id)) {
        throw invalidArgument("useTaskSpace(id) requires a numeric id");
      }
      selected = id;
      // Open the channel to this space's browser before the first command.
      if (browserOf(id) !== DEFAULT_PROFILE.id) raw.prepare(browserOf(id));
      const lostTabs = spaces.get(id)?.lostTabs;
      if (lostTabs?.length && !noticed.has(id)) {
        noticed.add(id);
        process.stderr.write(lostTabsNotice(id, lostTabs));
      }
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
      expectArgs("createTaskSpace", args, 1, 3);
      const [name, profileId, options] = args;
      if (typeof name !== "string" || name.length === 0) {
        throw invalidArgument(
          "createTaskSpace(name) requires a non-empty name",
        );
      }
      if (profileId !== undefined && typeof profileId !== "string") {
        throw invalidArgument("createTaskSpace profileId must be a string");
      }
      if (
        options !== undefined &&
        (options === null || typeof options !== "object")
      ) {
        throw invalidArgument("createTaskSpace options must be an object");
      }
      const ttlMs = options?.ttlMs;
      if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) {
        throw invalidArgument(
          "createTaskSpace ttlMs must be a positive whole number of milliseconds",
        );
      }
      return call("createTaskSpace", { name, profileId, ttlMs });
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
      const id = selected;
      const ephemeral = spaces.get(id)?.profileId === "ephemeral";
      const result = await taskCall("completeTaskSpace");
      if (ephemeral && typeof result === "string") {
        // The SDK's receipt may say Pages were kept; they were not.
        process.stderr.write(ephemeralFinishNotice(id));
      }
      return result;
    },

    async handOffTaskSpace(...args) {
      expectArgs("handOffTaskSpace", args, 0, 1);
      const [options] = args;
      if (
        options !== undefined &&
        (options === null || typeof options !== "object")
      ) {
        throw invalidArgument("handOffTaskSpace options must be an object");
      }
      if (options?.relay === true) {
        // The agent keeps control and relays what the user says to do.
        if (selected === undefined) return NOT_SELECTED();
        const relay = await call("relay", { id: selected });
        if (isEgoError(relay)) return relay;
        process.stderr.write(relayNotice(selected, relay));
        return { relay };
      }
      const result = await taskCall("handOffTaskSpace");
      if (isEgoError(result)) return result;
      if (hello.display === "virtual") {
        const viewer = await call("startViewer", { spaceId: selected }).catch(
          (error) => egoError(error.message, "EGO_VIEWER_UNAVAILABLE"),
        );
        process.stderr.write(
          isEgoError(viewer)
            ? `[ego-browser] warning: task space ${selected} is handed off, but no viewer could start: ${viewer.error}\n`
            : viewerNotice(selected, viewer),
        );
      } else if (hello.headless) {
        process.stderr.write(headlessHandOffWarning(selected));
      }
      return result;
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

    /**
     * taskSpaceMemo(key) reads, taskSpaceMemo(key, value) writes, value null
     * deletes. Resolves { found, value }. Kept with the space until finish().
     */
    async taskSpaceMemo(...args) {
      expectArgs("taskSpaceMemo", args, 1, 2);
      const [key, value] = args;
      if (typeof key !== "string" || key.length === 0) {
        throw invalidArgument("taskSpaceMemo(key) requires a non-empty string");
      }
      if (args.length === 1) {
        return taskCall("memo", { key, hasValue: false });
      }
      let json;
      try {
        json = JSON.stringify(value);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        throw invalidArgument(
          "taskSpaceMemo value must be JSON (use null to delete)",
        );
      }
      return taskCall("memo", { key, value: JSON.parse(json), hasValue: true });
    },

    /** Reopen the http(s) tabs a browser restart closed in this space. */
    async restoreTaskSpaceTabs(...args) {
      expectArgs("restoreTaskSpaceTabs", args, 0);
      const result = await taskCall("restoreTabs");
      if (!isEgoError(result) && result.tabs.length > 0) {
        activated.set(selected, result.tabs.at(-1).targetId);
      }
      return result;
    },

    /** Add one action to the round log: { page, action, target, ms, ok, error_code }. */
    logEvent(...args) {
      expectArgs("logEvent", args, 1);
      if (!args[0] || typeof args[0] !== "object") {
        throw invalidArgument("logEvent(entry) requires an object");
      }
      roundLog.add({ ...sanitizeEntry(args[0]), space: selected });
      return undefined;
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

    /**
     * fillSecret(name, { targetId, clear }) types the stored secret `name`
     * into the focused field of the page (the active tab by default), when
     * the field's origin is one the secret is bound to. Resolves
     * { filled: true, secret, origin } or an error object.
     */
    async fillSecret(...args) {
      expectArgs("fillSecret", args, 1, 2);
      const [name, options] = args;
      if (typeof name !== "string" || name.length === 0) {
        throw invalidArgument("fillSecret(name) requires a secret name");
      }
      if (
        options !== undefined &&
        (options === null || typeof options !== "object")
      ) {
        throw invalidArgument("fillSecret options must be an object");
      }
      if (
        options?.targetId !== undefined &&
        typeof options.targetId !== "string"
      ) {
        throw invalidArgument("fillSecret targetId must be a string");
      }
      let targetId = options?.targetId;
      if (targetId === undefined && selected !== undefined) {
        const active = await activeTarget();
        if (isEgoError(active)) return active;
        targetId = active;
      }
      return taskCall("fillSecret", {
        name,
        targetId,
        clear: options?.clear !== false,
      });
    },

    async snapshot(...args) {
      expectArgs("snapshot", args, 0, 1);
      const options = validateSnapshotOptions(args[0]);
      const targetId = await activeTarget();
      if (isEgoError(targetId)) throw rejectionFrom(targetId);
      try {
        const result = await captureSnapshot(
          await internalConnection(browserOf(selected)),
          targetId,
          options,
        );
        // A space that had a secret filled: the daemon blanks its value.
        if (!spaces.get(selected)?.secrets) return result;
        const { text } = await call("redact", {
          id: selected,
          text: JSON.stringify(result),
        });
        return JSON.parse(text);
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
      await showHighlight(
        await internalConnection(browserOf(selected)),
        targetId,
        x,
        y,
      ).catch(() => {});
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
      roundLog.command(message, selected);
      raw.send(message, browserOf(selected), browserOfTarget);
      return undefined;
    },

    onCDPMessage: null,
    onSendCDPMessageError: null,
  };

  // Log each binding call (name, time, result code) for `ego-browser logs`.
  for (const [name, fn] of Object.entries(ego)) {
    if (typeof fn !== "function" || UNLOGGED.has(name)) continue;
    if (name === "sendCDPMessage") continue;
    ego[name] = function logged(...args) {
      const started = Date.now();
      const space = selected;
      const record = (ok, errorCode) =>
        roundLog.add({
          space,
          action: name,
          ms: Date.now() - started,
          ok,
          ...(errorCode ? { error_code: errorCode } : {}),
        });
      let result;
      try {
        result = fn.apply(this, args);
      } catch (error) {
        record(false, error?.error_code || "EXCEPTION");
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          (value) => {
            record(!isEgoError(value), value?.error_code);
            return value;
          },
          (error) => {
            record(false, error?.error_code || "EXCEPTION");
            throw error;
          },
        );
      }
      return result;
    };
  }

  raw.onMessage((text) => {
    roundLog.reply(text);
    const callback = ego.onCDPMessage;
    if (typeof callback === "function") callback(text);
  });

  Object.defineProperties(ego, {
    close: {
      enumerable: false,
      value() {
        roundLog.stop();
        raw.close();
        for (const connection of internal.values()) connection.close();
      },
    },
    /** Start and end lines for this round; `flushLog` sends what is queued. */
    logRound: {
      enumerable: false,
      value: (event, fields = {}) =>
        roundLog.add({ kind: "round", event, space: selected, ...fields }),
    },
    flushLog: { enumerable: false, value: () => roundLog.flush() },
  });
  return ego;
}

/**
 * Queue of round-log entries, sent to the daemon in batches. Only names,
 * ids, timings and codes: never CDP params, typed text or page content.
 */
export function createRoundLogger(control, round, now = Date.now) {
  let queue = [];
  const pending = new Map();
  let keys = 0;
  let count = 0;
  const timer = setInterval(() => flush(), 500);
  timer.unref?.();

  function add(entry) {
    if (!round) return;
    if (entry.kind !== "round") count += 1;
    if (entry.kind === "round" && entry.event === "end") {
      entry = {
        ...entry,
        count,
        ...(keys ? { message: `${keys} key events` } : {}),
      };
    }
    queue.push({ ts: now(), round, ...entry });
    if (queue.length >= 200) flush();
  }

  function flush() {
    if (queue.length === 0) return Promise.resolve();
    const entries = queue;
    queue = [];
    return Promise.resolve(control.call("log", { entries })).catch(() => {});
  }

  return {
    add,
    flush,
    stop: () => clearInterval(timer),
    /** Note a raw CDP command the agent sent, if it is an action. */
    command(text, space) {
      if (!round) return;
      if (
        !/"Input\.dispatchKeyEvent"|"Page\.|"Input\.|"DOM\.setFileInputFiles"|"Target\.(create|close)Target"/.test(
          text,
        )
      ) {
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const { id, method, params = {} } = message;
      if (method === "Input.dispatchKeyEvent") {
        if (params.type === "keyDown" || params.type === "rawKeyDown")
          keys += 1;
        return;
      }
      const isClick =
        method === "Input.dispatchMouseEvent" && params.type === "mousePressed";
      if (!isClick && !LOGGED_CDP.has(method)) return;
      const target =
        method === "Page.navigate" || method === "Target.createTarget"
          ? originOf(params.url)
          : undefined;
      pending.set(id, {
        action: isClick ? "click" : method,
        target,
        space,
        started: now(),
      });
    },
    /** Match a reply to a logged command. */
    reply(text) {
      if (pending.size === 0) return;
      const head = /^\{"id":(\d+),"(result|error)"/.exec(text);
      if (!head) return;
      const entry = pending.get(Number(head[1]));
      if (!entry) return;
      pending.delete(Number(head[1]));
      let errorCode;
      if (head[2] === "error") errorCode = "CDP_ERROR";
      else if (
        entry.action === "Page.navigate" &&
        /"errorText":"[^"]/.test(text.slice(0, 2_000))
      ) {
        errorCode = "NAVIGATION_FAILED";
      }
      add({
        space: entry.space,
        action: entry.action,
        ...(entry.target ? { target: entry.target } : {}),
        ms: now() - entry.started,
        ok: !errorCode,
        ...(errorCode ? { error_code: errorCode } : {}),
      });
    },
  };
}

/** Origin only: a path or query can carry a token. */
function originOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : parsed.protocol;
  } catch {
    return undefined;
  }
}

/**
 * Connect to a browser through the daemon's CDP proxy: the Default
 * profile's, or the one of `browser`. When that fails, say hello again (it
 * checks the browser) and retry once.
 */
export async function connectBrowser(
  control,
  hello,
  browser = DEFAULT_PROFILE.id,
) {
  const params = browser === DEFAULT_PROFILE.id ? {} : { browser };
  try {
    return await CdpConnection.connectProxy(control.path, 10_000, params);
  } catch (first) {
    if (browser !== DEFAULT_PROFILE.id) {
      throw Object.assign(first, { error_code: "EGO_BROWSER_UNAVAILABLE" });
    }
    const fresh = await control.call("hello").catch(() => null);
    if (fresh) {
      try {
        return await CdpConnection.connectProxy(control.path);
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

/** Tabs do not survive a browser restart; say so instead of losing them quietly. */
export function lostTabsNotice(id, urls) {
  const list = urls.map((url) => `  ${url || "(unknown URL)"}\n`).join("");
  return `[ego-browser] the browser restarted, so task space ${id} lost its tabs and Page labels. Open a Page with task.newPage() and go to the URL again, or reopen them all with: ego-browser restore ${id}. Tabs that were open:\n${list}`;
}

/** A headless browser has no window, so nobody can act on a hand-off. */
export function headlessHandOffWarning(id) {
  return `[ego-browser] warning: the browser is headless, so the user cannot see or use task space ${id}. Resume it with takeOverTaskSpace(${id}), or close it with: ego-browser close --force ${id}. To show the user the page instead: ego-browser relay ${id}. For a live view, restart with: ego-browser stop && ego-browser start --display virtual\n`;
}

/** Where the user can see a handed-off space. */
export function viewerNotice(id, viewer) {
  return `[ego-browser] task space ${id} is handed off. Give the user this link (it works once):\n  ${viewer.url}\nFrom their computer they first run: ${viewer.ssh}\nThe viewer stops when the agent takes over or after ${Math.round((viewer.expiresAt - Date.now()) / 60_000)} minutes. A new link: ego-browser view\n`;
}

/** finish() deletes an ephemeral space, whatever Pages it was asked to keep. */
export function ephemeralFinishNotice(id) {
  return `[ego-browser] task space ${id} used the ephemeral profile, so finish() deleted it with its tabs, cookies and storage. Use a named profile (ego-browser profiles create <id>) to keep a session.\n`;
}

export function relayNotice(id, relay) {
  return `[ego-browser] task space ${id}: screenshot ${relay.screenshot} and snapshot ${relay.snapshot}. Show them to the user and do what they say. Never type a password the user did not give you.\n`;
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
