/**
 * ego lite daemon: owns the browser process and the task-space registry, and
 * answers the CLI over a private Unix socket. One daemon per user.
 *
 * The browser's DevTools is a pipe that only this process holds. The CLI
 * reaches CDP through the same private socket ({"method":"cdpProxy"}), so no
 * other local user can drive the browser.
 */
import { createServer } from "node:net";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

import {
  devtoolsMode,
  launchBrowser,
  wantsHeadless,
} from "./browser-launcher.mjs";
import { openWebSocket } from "./cdp-connection.mjs";
import { CdpMux } from "./cdp-mux.mjs";
import { loadConfig } from "./config.mjs";
import {
  connectRunningDaemon,
  encode,
  lineReader,
} from "./control-channel.mjs";
import { findCommand, startVirtualDisplay } from "./display.mjs";
import { egoError } from "./errors.mjs";
import {
  HOST_VERSION,
  controlSocketPath,
  daemonInfoFile,
  daemonLockFile,
  spacesFile,
  stateDir,
} from "./paths.mjs";
import { cached, processTreeMemoryMb } from "./resources.mjs";
import { RoundLog } from "./round-log.mjs";
import { captureSnapshot } from "./snapshot.mjs";
import { TaskSpaceRegistry } from "./task-spaces.mjs";
import { Viewer, findNoVnc } from "./viewer.mjs";

/** Size of a new task-space window; small defaults push content off-screen. */
const WINDOW_SIZE = { width: 1440, height: 900 };

/** Daemon methods that act on one task space ({ id }) and count as use. */
const SPACE_METHODS = new Set([
  "describe",
  "claimTaskSpace",
  "completeTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "setAgentTaskState",
  "createTab",
  "listTabs",
  "setActiveTarget",
  "memo",
  "restoreTabs",
]);

/** "virtual" (Xvfb), or undefined for the desktop display or headless. */
export function displayMode(env = process.env) {
  const mode = env.EGO_LITE_DISPLAY;
  if (mode === undefined || mode === "" || mode === "auto") return undefined;
  if (mode !== "virtual") {
    throw new Error(`EGO_LITE_DISPLAY must be virtual or auto, not ${mode}`);
  }
  return mode;
}

export async function runDaemon(env = process.env) {
  const socketPath = controlSocketPath(env);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  // Two CLI calls can start a daemon at the same time. Only one may own the
  // socket and the browser profile; the other leaves at once.
  const lockFile = daemonLockFile(env);
  const infoFile = daemonInfoFile(env);
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  if (!acquireLock(lockFile)) {
    log("another daemon is running; exiting");
    return;
  }
  if (await daemonAnswers(env)) {
    rmSync(lockFile, { force: true });
    log("another daemon is answering; exiting");
    return;
  }
  rmSync(socketPath, { force: true });

  const { config, warnings } = loadConfig(env);
  for (const warning of warnings) log(warning);
  const roundLog = new RoundLog({ env });
  const runDir = join(stateDir(env), "run");
  const display = displayMode(env);

  let virtualDisplay = null;
  let launched;
  try {
    let browserEnv = env;
    if (display === "virtual") {
      virtualDisplay = await startVirtualDisplay({
        runDir,
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
      });
      browserEnv = {
        ...env,
        DISPLAY: virtualDisplay.display,
        XAUTHORITY: virtualDisplay.xauthority,
        EGO_LITE_HEADLESS: "0",
      };
      delete browserEnv.WAYLAND_DISPLAY;
      log(`virtual display ${virtualDisplay.display}`);
    }
    launched = await launchBrowser(browserEnv);
  } catch (error) {
    virtualDisplay?.stop();
    rmSync(lockFile, { force: true });
    throw error;
  }
  const { child, wsUrl, executable } = launched;
  const headless = display !== "virtual" && wantsHeadless(env);
  // All CDP goes through one connection: the pipe, or in port mode one
  // WebSocket. The CLI reaches it through the mux on the private socket.
  const upstream = launched.transport ?? (await openWebSocket(wsUrl));
  let registry;
  const mux = new CdpMux(upstream, {
    onCommand: (_client, message) => {
      if (message.method !== "Target.attachToTarget") return;
      const id = registry?.spaceOfTarget(message.params?.targetId);
      if (id !== null && id !== undefined) registry.touch(id);
    },
  });
  await mux.start();
  const cdp = mux.localConnection();
  const browserVersion = await cdp.send("Browser.getVersion");
  // Page labels in the SDK belong to one browser run.
  const instanceId = `linux-host:${child.pid}`;
  const devtools = devtoolsMode(env);
  log(
    `browser ${browserVersion.product} (${executable}) over the DevTools ${devtools === "pipe" ? "pipe" : `port ${wsUrl}`}`,
  );
  roundLog.event("start", { message: browserVersion.product });

  const targets = new Map();
  const browser = {
    targetInfo: (targetId) => targets.get(targetId),
    activateTarget: (targetId) =>
      cdp.send("Target.activateTarget", { targetId }),
    closeTarget: (targetId) => cdp.send("Target.closeTarget", { targetId }),
    async createTarget(url, { anchor } = {}) {
      // Chromium opens a plain new tab in the last active window, so focus a
      // tab of the space first. The first tab of a space gets its own window.
      if (anchor && targets.has(anchor)) {
        const focused = await cdp
          .send("Target.activateTarget", { targetId: anchor })
          .then(() => true)
          .catch(() => false);
        if (focused) {
          const { targetId } = await cdp.send("Target.createTarget", { url });
          return targetId;
        }
      }
      const { targetId } = await cdp.send("Target.createTarget", {
        url,
        newWindow: true,
        ...WINDOW_SIZE,
      });
      return targetId;
    },
  };

  const clients = new Set();
  const file = spacesFile(env);
  const memoryMb = cached(() => processTreeMemoryMb(child.pid), 5_000);
  let viewer = null;
  registry = new TaskSpaceRegistry({
    browser,
    saved: readSaved(file),
    save: (state) => writeSaved(file, state),
    onChange: () => {
      broadcast(clients, "spaces", spaceSummaries(registry));
      stopViewerAfterHandOff();
    },
    limits: () => config,
    memoryMb,
  });

  // Keep tab URLs on disk as they change, so a crash still knows what to
  // reopen. Writes are batched.
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeSaved(file, registry.snapshotState());
    }, 1_000);
    saveTimer.unref();
  };

  cdp.onMessage((_text, message) => {
    const info = message.params?.targetInfo;
    if (message.method === "Target.targetCreated") {
      targets.set(info.targetId, info);
      registry.handleTargetCreated(info);
    } else if (message.method === "Target.targetInfoChanged") {
      const before = targets.get(info.targetId)?.url;
      targets.set(info.targetId, info);
      if (
        before !== info.url &&
        registry.spaceOfTarget(info.targetId) !== null
      ) {
        scheduleSave();
      }
    } else if (message.method === "Target.targetDestroyed") {
      targets.delete(message.params.targetId);
      registry.handleTargetDestroyed(message.params.targetId);
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const info of targetInfos) targets.set(info.targetId, info);
  registry.pruneTargets(targetInfos.map((info) => info.targetId));

  /** Can a user see a space handed to them right now? */
  const handOffVisible = () =>
    display === "virtual" ? Boolean(viewer?.running) : !headless;

  function stopViewerAfterHandOff() {
    if (!viewer?.running || viewer.spaceId === undefined) return;
    const space = registry.describe(viewer.spaceId);
    if (!space || space.control !== "user") viewer.stop("hand-off ended");
  }

  async function startViewer({ spaceId } = {}) {
    if (display !== "virtual") {
      return egoError(
        "The browser has no virtual display, so there is nothing to view. Restart it with: ego-browser stop && ego-browser start --display virtual",
        "EGO_VIEWER_UNAVAILABLE",
      );
    }
    const x11vnc = findCommand("x11vnc", env);
    const novncDir = findNoVnc(env);
    if (!x11vnc || !novncDir) {
      return egoError(
        `The viewer needs ${[!x11vnc && "x11vnc", !novncDir && "noVNC"].filter(Boolean).join(" and ")}. Install with: sudo apt-get install -y x11vnc novnc`,
        "EGO_VIEWER_UNAVAILABLE",
      );
    }
    if (!viewer) {
      viewer = new Viewer({
        display: virtualDisplay.display,
        xauthority: virtualDisplay.xauthority,
        novncDir,
        x11vnc,
        port: config.viewerPort,
        timeoutMs: config.viewerTimeoutMs,
        onStop: (reason) => {
          roundLog.event("viewer-stop", { message: reason });
          log(`viewer stopped (${reason})`);
          viewer = null;
        },
      });
    }
    try {
      await viewer.start();
    } catch (error) {
      viewer = null;
      return egoError(
        error.message,
        error.error_code || "EGO_VIEWER_UNAVAILABLE",
      );
    }
    if (Number.isInteger(spaceId)) viewer.spaceId = spaceId;
    const token = viewer.issueToken();
    const port = viewer.port;
    roundLog.event("viewer-start", {
      ...(Number.isInteger(spaceId) ? { space: spaceId } : {}),
    });
    log(`viewer on 127.0.0.1:${port}`);
    return {
      url: viewer.url(token),
      port,
      ssh: `ssh -N -L ${port}:127.0.0.1:${port} ${userInfo().username}@${hostname()}`,
      expiresAt: viewer.expiresAt,
    };
  }

  /** Screenshot and snapshot of a space's active tab, for a user to read. */
  async function relay({ id }) {
    const space = registry.describe(id);
    if (!space)
      return egoError(
        `Task space not found: ${id}`,
        "EGO_TASK_SPACE_NOT_FOUND",
      );
    const targetId = space.activeTargetId ?? space.targets.at(-1);
    if (!targetId) {
      return egoError(
        `Task space ${id} has no open tab`,
        "EGO_WEB_CONTENTS_UNAVAILABLE",
      );
    }
    const dir = join(stateDir(env), "relay", `${id}-${Date.now()}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    let image;
    try {
      ({ data: image } = await cdp.send(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      ));
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    const snapshot = await captureSnapshot(cdp, targetId, {});
    const screenshot = join(dir, "screenshot.png");
    const snapshotFile = join(dir, "snapshot.txt");
    writeFileSync(screenshot, Buffer.from(image, "base64"), { mode: 0o600 });
    writeFileSync(snapshotFile, snapshot.content, { mode: 0o600 });
    const info = targets.get(targetId) || {};
    return {
      dir,
      screenshot,
      snapshot: snapshotFile,
      url: info.url ?? "",
      title: info.title ?? "",
    };
  }

  async function runGc({ dryRun = false } = {}) {
    const actions = await registry.gc({
      dryRun,
      handOffVisible: handOffVisible(),
    });
    if (!dryRun) {
      for (const action of actions) {
        roundLog.event(`gc-${action.action}`, { space: action.id });
        log(
          `gc: task space ${action.id} ${action.action} after ${Math.round(action.idleMs / 60_000)} min idle`,
        );
      }
    }
    return { dryRun, actions };
  }

  let rounds = 0;
  const handlers = {
    hello: async () => {
      // A daemon whose browser stopped answering must not hand out its
      // endpoint. Stop, so the next CLI call starts a fresh one.
      try {
        await cdp.send("Browser.getVersion", {}, undefined, 5_000);
      } catch (error) {
        log(`browser not answering (${error.message}); stopping daemon`);
        setImmediate(() => shutdown(1));
        throw new Error("ego lite browser is not answering; restarting it");
      }
      rounds += 1;
      return {
        version: HOST_VERSION,
        devtools,
        // Port mode only, for a human with DevTools; the CLI uses the proxy.
        ...(wsUrl ? { wsUrl } : {}),
        instanceId,
        headless,
        display: display ?? (headless ? "headless" : "desktop"),
        round: `${process.pid}.${rounds}`,
        browser: browserVersion.product,
        spaces: spaceSummaries(registry),
      };
    },
    status: () => ({
      version: HOST_VERSION,
      browser: browserVersion.product,
      devtools,
      display: display ?? (headless ? "headless" : "desktop"),
      usage: registry.usage(),
      limits: {
        maxTaskSpaces: config.maxTaskSpaces,
        maxPagesPerSpace: config.maxPagesPerSpace,
        maxTotalPages: config.maxTotalPages,
        maxRssMb: config.maxRssMb,
      },
      viewer: viewer?.running
        ? {
            port: viewer.port,
            connections: viewer.connections,
            expiresAt: viewer.expiresAt,
          }
        : null,
    }),
    listProfiles: () => registry.listProfiles(),
    listTaskSpaces: () => registry.listTaskSpaces(),
    describe: ({ id }) => registry.describe(id),
    createTaskSpace: async ({ name, profileId, ttlMs }) => {
      const result = await registry.createTaskSpace(name, profileId, { ttlMs });
      if (result?.error_code === "EGO_RESOURCE_LIMIT") {
        roundLog.event("limit", { message: result.error });
      }
      return result;
    },
    claimTaskSpace: ({ id, name }) => registry.claimTaskSpace(id, name),
    closeTaskSpace: ({ id, force }) =>
      registry.closeTaskSpace(id, { force: force === true }),
    completeTaskSpace: ({ id }) => registry.completeTaskSpace(id),
    handOffTaskSpace: async ({ id, reason }) => {
      const result = await registry.handOffTaskSpace(id, reason);
      if (typeof result === "string") roundLog.event("hand-off", { space: id });
      return result;
    },
    takeOverTaskSpace: ({ id }) => {
      const result = registry.takeOverTaskSpace(id);
      if (typeof result === "string")
        roundLog.event("take-over", { space: id });
      return result;
    },
    setAgentTaskState: ({ id, state }) => registry.setAgentTaskState(id, state),
    createTab: async ({ id, url }) => {
      const result = await registry.createTab(id, url);
      if (result?.error_code === "EGO_RESOURCE_LIMIT") {
        roundLog.event("limit", { space: id, message: result.error });
      }
      return result;
    },
    listTabs: ({ id }) => registry.listTabs(id),
    setActiveTarget: ({ id, targetId }) =>
      registry.setActiveTarget(id, targetId),
    memo: ({ id, key, value, hasValue }) =>
      registry.memo(id, key, value, hasValue === true),
    restoreTabs: ({ id }) => registry.restoreTabs(id),
    gc: ({ dryRun }) => runGc({ dryRun: dryRun === true }),
    startViewer: ({ spaceId }) => startViewer({ spaceId }),
    stopViewer: () => {
      if (!viewer?.running) return "no viewer running";
      viewer.stop("stopped by the user");
      return "viewer stopped";
    },
    relay: ({ id }) => relay({ id }),
    log: ({ entries }) => {
      if (Array.isArray(entries)) roundLog.append(entries.slice(0, 1_000));
      return null;
    },
    shutdown: () => {
      setImmediate(() => shutdown(0));
      return "shutting down";
    },
  };

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    const onData = lineReader((message) => {
      if (message.method === "cdpProxy") {
        // From here on this socket carries NUL-framed CDP for one client.
        socket.off("data", onData);
        clients.delete(socket);
        socket.write(encode({ id: message.id, result: "ok" }));
        mux.attachStream(socket);
        return;
      }
      respond(socket, message);
    });
    socket.on("data", onData);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  async function respond(socket, { id, method, params }) {
    const handler = handlers[method];
    let reply;
    try {
      if (!handler) throw new Error(`Unknown daemon method: ${method}`);
      if (SPACE_METHODS.has(method) && Number.isInteger(params?.id)) {
        registry.touch(params.id);
      }
      reply = { id, result: (await handler(params || {})) ?? null };
    } catch (error) {
      reply = { id, error: String(error?.message || error) };
    }
    if (!socket.destroyed) socket.write(encode(reply));
  }

  const gcTimer = setInterval(() => {
    runGc().catch((error) => log(`gc failed: ${error.message}`));
  }, config.gcIntervalMs);
  gcTimer.unref();

  let stopping = false;
  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(gcTimer);
    // Keep the latest tab URLs, so a restart can say what was lost.
    writeSaved(file, registry.snapshotState());
    roundLog.event("stop", { exit: code });
    viewer?.stop("daemon stopped");
    server.close();
    for (const socket of clients) socket.destroy();
    mux.close();
    rmSync(socketPath, { force: true });
    rmSync(infoFile, { force: true });
    rmSync(lockFile, { force: true });
    cdp.close();
    // A browser that stopped answering may ignore SIGTERM.
    if (child.exitCode === null) child.kill(code ? "SIGKILL" : "SIGTERM");
    virtualDisplay?.stop();
    process.exit(code);
  }

  // A browser that dies on its own is a failure: exit non-zero so a
  // supervisor (systemd Restart=on-failure) starts it again.
  child.on("exit", (code, signal) => {
    if (stopping) return;
    log(`browser exited (${code ?? signal}); stopping daemon`);
    shutdown(1);
  });
  virtualDisplay?.process.on("exit", () => {
    if (stopping) return;
    log("virtual display exited; stopping daemon");
    shutdown(1);
  });
  cdp.onClose(() => {
    if (stopping) return;
    log("browser connection closed; stopping daemon");
    shutdown(1);
  });
  process.on("uncaughtException", (error) => {
    log(`uncaught error: ${error?.stack || error}`);
    shutdown(1);
  });
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  writeAtomic(
    infoFile,
    JSON.stringify({ pid: process.pid, socket: socketPath }),
  );
  log(`listening on ${socketPath}`);
}

/** Create the lock file, or take it over when its owner process is gone. */
export function acquireLock(file, isOwnerAlive = isDaemonProcess) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(file, "utf8").trim());
      if (owner && owner !== process.pid && isOwnerAlive(owner)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

/**
 * True when pid is a live ego lite daemon. The lock outlives a reboot, and its
 * pid can then belong to an unrelated process.
 */
export function isDaemonProcess(pid) {
  if (!processAlive(pid)) return false;
  let cmdline;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    // Without /proc, trust the pid.
    return !existsSync("/proc/self");
  }
  return cmdline.split("\0").includes("daemon");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function daemonAnswers(env) {
  try {
    const client = await connectRunningDaemon(env, 1_000);
    client.close();
    return true;
  } catch {
    return false;
  }
}

function spaceSummaries(registry) {
  return registry.snapshotState().spaces.map((space) => ({
    id: space.id,
    ownership: space.ownership,
    control: space.control,
    controlReason: space.controlReason,
    targets: space.targets,
    activeTargetId: space.activeTargetId,
    lostTabs: space.lostTabs,
  }));
}

function broadcast(clients, event, data) {
  const line = encode({ event, data });
  for (const socket of clients) {
    if (!socket.destroyed) socket.write(line);
  }
}

function readSaved(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeSaved(file, state) {
  try {
    writeAtomic(file, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`cannot save task spaces: ${error.message}`);
  }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

function log(message) {
  process.stderr.write(`[ego-lite ${new Date().toISOString()}] ${message}\n`);
}
