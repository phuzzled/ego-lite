/**
 * ego lite daemon: owns the browser process and the task-space registry, and
 * answers the CLI over a private Unix socket. One daemon per user.
 */
import { createServer } from "node:net";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { launchBrowser } from "./browser-launcher.mjs";
import { CdpConnection } from "./cdp-connection.mjs";
import { encode, lineReader } from "./control-channel.mjs";
import { HOST_VERSION, controlSocketPath, spacesFile } from "./paths.mjs";
import { TaskSpaceRegistry } from "./task-spaces.mjs";

/** Size of a new task-space window; small defaults push content off-screen. */
const WINDOW_SIZE = { width: 1440, height: 900 };

export async function runDaemon(env = process.env) {
  const socketPath = controlSocketPath(env);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });

  const { child, wsUrl, executable } = await launchBrowser(env);
  const cdp = await CdpConnection.connect(wsUrl);
  const browserVersion = await cdp.send("Browser.getVersion");
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
    hello: () => ({
      version: HOST_VERSION,
      wsUrl,
      browser: browserVersion.product,
      spaces: spaceSummaries(registry),
    }),
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
    cdp.close();
    if (child.exitCode === null) child.kill();
    process.exit(code);
  }

  child.on("exit", (code) => {
    log(`browser exited (${code}); stopping daemon`);
    shutdown(0);
  });
  cdp.onClose(() => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath}`);
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
