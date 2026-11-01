/**
 * ego lite daemon: owns the browser process and the task-space registry, and
 * answers the CLI over a private Unix socket. One daemon per user.
 */
import { createServer } from "node:net";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { launchBrowser } from "./browser-launcher.mjs";
import { CdpConnection } from "./cdp-connection.mjs";
import { ControlClient, encode, lineReader } from "./control-channel.mjs";
import { HOST_VERSION, controlSocketPath, spacesFile } from "./paths.mjs";
import { TaskSpaceRegistry } from "./task-spaces.mjs";

/** Size of a new task-space window; small defaults push content off-screen. */
const WINDOW_SIZE = { width: 1440, height: 900 };

export async function runDaemon(env = process.env) {
  const socketPath = controlSocketPath(env);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  // Two CLI calls can start a daemon at the same time. Only one may own the
  // socket and the browser profile; the other leaves at once.
  const lockFile = `${socketPath}.lock`;
  if (!acquireLock(lockFile)) {
    log("another daemon is running; exiting");
    return;
  }
  if (await socketAnswers(socketPath)) {
    rmSync(lockFile, { force: true });
    log("another daemon is answering; exiting");
    return;
  }
  rmSync(socketPath, { force: true });

  let launched;
  try {
    launched = await launchBrowser(env);
  } catch (error) {
    rmSync(lockFile, { force: true });
    throw error;
  }
  const { child, wsUrl, executable } = launched;
  const cdp = await CdpConnection.connect(wsUrl);
  const browserVersion = await cdp.send("Browser.getVersion");
  // Page labels in the SDK belong to one browser run.
  const instanceId = `linux-host:${child.pid}`;
  log(`browser ${browserVersion.product} (${executable}) at ${wsUrl}`);

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
  const registry = new TaskSpaceRegistry({
    browser,
    saved: readSaved(file),
    save: (state) => writeSaved(file, state),
    onChange: () => broadcast(clients, "spaces", spaceSummaries(registry)),
  });

  cdp.onMessage((_text, message) => {
    const info = message.params?.targetInfo;
    if (message.method === "Target.targetCreated") {
      targets.set(info.targetId, info);
      registry.handleTargetCreated(info);
    } else if (message.method === "Target.targetInfoChanged") {
      targets.set(info.targetId, info);
    } else if (message.method === "Target.targetDestroyed") {
      targets.delete(message.params.targetId);
      registry.handleTargetDestroyed(message.params.targetId);
    }
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const info of targetInfos) targets.set(info.targetId, info);
  registry.pruneTargets(targetInfos.map((info) => info.targetId));

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
      return {
        version: HOST_VERSION,
        wsUrl,
        instanceId,
        browser: browserVersion.product,
        spaces: spaceSummaries(registry),
      };
    },
    listProfiles: () => registry.listProfiles(),
    listTaskSpaces: () => registry.listTaskSpaces(),
    describe: ({ id }) => registry.describe(id),
    createTaskSpace: ({ name, profileId }) =>
      registry.createTaskSpace(name, profileId),
    claimTaskSpace: ({ id, name }) => registry.claimTaskSpace(id, name),
    closeTaskSpace: ({ id }) => registry.closeTaskSpace(id),
    completeTaskSpace: ({ id }) => registry.completeTaskSpace(id),
    handOffTaskSpace: ({ id, reason }) => registry.handOffTaskSpace(id, reason),
    takeOverTaskSpace: ({ id }) => registry.takeOverTaskSpace(id),
    setAgentTaskState: ({ id, state }) => registry.setAgentTaskState(id, state),
    createTab: ({ id, url }) => registry.createTab(id, url),
    listTabs: ({ id }) => registry.listTabs(id),
    setActiveTarget: ({ id, targetId }) =>
      registry.setActiveTarget(id, targetId),
    shutdown: () => {
      setImmediate(() => shutdown(0));
      return "shutting down";
    },
  };

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.on(
      "data",
      lineReader((message) => respond(socket, message)),
    );
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  async function respond(socket, { id, method, params }) {
    const handler = handlers[method];
    let reply;
    try {
      if (!handler) throw new Error(`Unknown daemon method: ${method}`);
      reply = { id, result: (await handler(params || {})) ?? null };
    } catch (error) {
      reply = { id, error: String(error?.message || error) };
    }
    if (!socket.destroyed) socket.write(encode(reply));
  }

  let stopping = false;
  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    server.close();
    for (const socket of clients) socket.destroy();
    rmSync(socketPath, { force: true });
    rmSync(lockFile, { force: true });
    cdp.close();
    // A browser that stopped answering may ignore SIGTERM.
    if (child.exitCode === null) child.kill(code ? "SIGKILL" : "SIGTERM");
    process.exit(code);
  }

  child.on("exit", (code) => {
    log(`browser exited (${code}); stopping daemon`);
    shutdown(0);
  });
  cdp.onClose(() => {
    log("browser connection closed; stopping daemon");
    shutdown(0);
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
  log(`listening on ${socketPath}`);
}

/** Create the lock file, or take it over when its owner process is gone. */
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(readFileSync(file, "utf8").trim());
      if (owner && owner !== process.pid && processAlive(owner)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function socketAnswers(path) {
  try {
    const client = await ControlClient.connect(path, 1_000);
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
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    log(`cannot save task spaces: ${error.message}`);
  }
}

function log(message) {
  process.stderr.write(`[ego-lite ${new Date().toISOString()}] ${message}\n`);
}
