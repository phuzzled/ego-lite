/**
 * ego lite daemon: owns the browser process and the task-space registry, and
 * answers the CLI over a private Unix socket. One daemon per user.
 *
 * The browser's DevTools is a pipe that only this process holds. The CLI
 * reaches CDP through the same private socket ({"method":"cdpProxy"}), so no
 * other local user can drive the browser.
 *
 * Profiles: the Default profile's browser starts with the daemon. Each named
 * profile gets its own browser process, pipe and mux, started on demand
 * (browser-pool.mjs); a CLI round asks for a profile's browser with
 * {"method":"cdpProxy","params":{"browser":"<profile id>"}}. Ephemeral task
 * spaces are browser contexts in the Default browser.
 */
import { createServer } from "node:net";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { BrowserPool } from "./browser-pool.mjs";
import { openWebSocket } from "./cdp-connection.mjs";
import { CdpMux } from "./cdp-mux.mjs";
import { loadConfig } from "./config.mjs";
import {
  ephemeralRefusal,
  exportProfileData,
  importProfileData,
  parseOrigins,
  parseSites,
} from "./cookies.mjs";
import {
  connectRunningDaemon,
  encode,
  lineReader,
} from "./control-channel.mjs";
import { findCommand, startVirtualDisplay } from "./display.mjs";
import { egoError, isEgoError } from "./errors.mjs";
import {
  HOST_VERSION,
  controlSocketPath,
  daemonInfoFile,
  daemonLockFile,
  ensurePrivateDir,
  spacesFile,
  stateDir,
  writeAtomic,
} from "./paths.mjs";
import { DEFAULT_PROFILE_ID, ProfileStore } from "./profiles.mjs";
import { cached, processTreeMemoryMb } from "./resources.mjs";
import { RoundLog } from "./round-log.mjs";
import {
  SecretStore,
  fillSecretInTarget,
  redactSecrets,
  secretNameProblem,
} from "./secrets.mjs";
import { pruneSdkLedgers, sdkStateDir } from "./sdk-ledgers.mjs";
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
  "fillSecret",
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
  // The default socket folder is ours alone; a custom EGO_LITE_SOCKET may sit
  // in a folder the user shares on purpose, so only create that one.
  if (env.EGO_LITE_SOCKET) {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  } else {
    ensurePrivateDir(dirname(socketPath));
  }
  // Two CLI calls can start a daemon at the same time. Only one may own the
  // socket and the browser profile; the other leaves at once.
  const lockFile = daemonLockFile(env);
  const infoFile = daemonInfoFile(env);
  ensurePrivateDir(dirname(lockFile));
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

  const profiles = new ProfileStore({ env });
  const secrets = new SecretStore({ env, log });
  let registry;
  let stopping = false;
  let shutdown = () => {};

  // Keep tab URLs on disk as they change, so a crash still knows what to
  // reopen. Writes are batched.
  const file = spacesFile(env);
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer || !registry) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeSaved(file, registry.snapshotState());
    }, 1_000);
    saveTimer.unref();
  };

  let virtualDisplay = null;
  let browserEnv = env;
  const onCommand = (_client, message) => {
    if (message.method !== "Target.attachToTarget") return;
    const id = registry?.spaceOfTarget(message.params?.targetId);
    if (id !== null && id !== undefined) registry.touch(id);
  };

  /** Launch the browser of one profile, with its own pipe and mux. */
  async function startBrowser(profileId) {
    let profileEnv = browserEnv;
    if (profileId !== DEFAULT_PROFILE_ID) {
      if (profiles.resolve(profileId)?.kind !== "named") {
        throw Object.assign(new Error(`Profile not found: ${profileId}`), {
          error_code: "EGO_PROFILE_NOT_FOUND",
        });
      }
      profileEnv = {
        ...browserEnv,
        EGO_LITE_PROFILE_DIR: profiles.userDataDir(profileId),
      };
    }
    const launched = await launchBrowser(profileEnv);
    try {
      // All CDP of a browser goes through one connection: the pipe, or in
      // port mode one WebSocket. CLI rounds reach it through its mux.
      const upstream =
        launched.transport ?? (await openWebSocket(launched.wsUrl));
      const mux = new CdpMux(upstream, { onCommand });
      await mux.start();
      const cdp = mux.localConnection();
      const version = await cdp.send("Browser.getVersion");
      if (profileId !== DEFAULT_PROFILE_ID) {
        log(
          `browser for profile ${profileId} started (pid ${launched.child.pid})`,
        );
        roundLog.event("browser-start", { message: profileId });
      }
      return { ...launched, mux, cdp, version };
    } catch (error) {
      launched.child.kill("SIGKILL");
      throw error;
    }
  }

  const pool = new BrowserPool({
    start: startBrowser,
    limits: () => config,
    onTarget: (method, _profileId, params) => {
      if (!registry) return;
      if (method === "Target.targetCreated") {
        registry.handleTargetCreated(params.targetInfo);
      } else if (method === "Target.targetInfoChanged") {
        if (registry.spaceOfTarget(params.targetInfo.targetId) !== null) {
          scheduleSave();
        }
      } else {
        registry.handleTargetDestroyed(params.targetId);
      }
    },
    onExit: (profileId, lost, expected) => {
      if (stopping) return;
      // A browser that dies on its own is a failure: exit non-zero so a
      // supervisor (systemd Restart=on-failure) starts it again.
      if (profileId === DEFAULT_PROFILE_ID) {
        log("browser exited; stopping daemon");
        shutdown(1);
        return;
      }
      log(
        `browser for profile ${profileId} ${expected ? "stopped" : "exited"}`,
      );
      roundLog.event(expected ? "browser-stop" : "browser-exit", {
        message: profileId,
      });
      const urls = new Map(lost.map((tab) => [tab.targetId, tab.url]));
      registry?.loseTargets([...urls.keys()], (targetId) => urls.get(targetId));
    },
  });

  let main;
  try {
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
    main = await pool.ensure(DEFAULT_PROFILE_ID);
  } catch (error) {
    virtualDisplay?.stop();
    rmSync(lockFile, { force: true });
    throw error;
  }
  const { child, wsUrl, executable, cdp } = main;
  const browserVersion = main.version;
  const headless = display !== "virtual" && wantsHeadless(env);
  // Page labels in the SDK belong to one browser run.
  const instanceId = `linux-host:${child.pid}`;
  const devtools = devtoolsMode(env);
  log(
    `browser ${browserVersion.product} (${executable}) over the DevTools ${devtools === "pipe" ? "pipe" : `port ${wsUrl}`}`,
  );
  roundLog.event("start", { message: browserVersion.product });

  /** The connection of the browser that holds a tab. */
  const cdpOf = (targetId) => {
    const owner = pool.ownerOf(targetId);
    if (!owner) throw new Error(`No browser holds tab ${targetId}`);
    return owner.cdp;
  };

  const browser = {
    targetInfo: (targetId) => pool.targetInfo(targetId),
    activateTarget: (targetId) =>
      cdpOf(targetId).send("Target.activateTarget", { targetId }),
    showTarget: (targetId) => showTarget(targetId),
    closeTarget: (targetId) =>
      cdpOf(targetId).send("Target.closeTarget", { targetId }),
    createContext: async () =>
      (await cdp.send("Target.createBrowserContext", {})).browserContextId,
    disposeContext: (browserContextId) =>
      cdp.send("Target.disposeBrowserContext", { browserContextId }),
    async createTarget(
      url,
      { anchor, profileId = DEFAULT_PROFILE_ID, browserContextId } = {},
    ) {
      const instance = await pool.ensure(profileId);
      const context = browserContextId ? { browserContextId } : {};
      const created = (targetId) => {
        // The reply can come before targetCreated; the tab is known at once.
        if (!instance.targets.has(targetId)) {
          instance.targets.set(targetId, { targetId, type: "page", url });
        }
        return targetId;
      };
      // Chromium opens a plain new tab in the last active window, so focus a
      // tab of the space first. The first tab of a space gets its own window.
      if (anchor && instance.targets.has(anchor)) {
        const focused = await instance.cdp
          .send("Target.activateTarget", { targetId: anchor })
          .then(() => true)
          .catch(() => false);
        if (focused) {
          const { targetId } = await instance.cdp.send("Target.createTarget", {
            url,
            ...context,
          });
          return created(targetId);
        }
      }
      const { targetId } = await instance.cdp.send("Target.createTarget", {
        url,
        newWindow: true,
        ...WINDOW_SIZE,
        // No window manager on the virtual display: place windows ourselves.
        ...(display === "virtual" ? { left: 0, top: 0 } : {}),
        ...context,
      });
      return created(targetId);
    },
  };

  /**
   * Bring a tab to the front for the user. On the virtual display, which has
   * no window manager, also move its window to the corner and make it fill
   * the screen, so the viewer shows that tab and nothing else.
   */
  async function showTarget(targetId) {
    const owner = pool.ownerOf(targetId);
    if (!owner) return;
    if (display === "virtual") {
      try {
        const { windowId } = await owner.cdp.send(
          "Browser.getWindowForTarget",
          {
            targetId,
          },
        );
        await owner.cdp
          .send("Browser.setWindowBounds", {
            windowId,
            bounds: { windowState: "normal" },
          })
          .catch(() => {});
        await owner.cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 0, top: 0, ...WINDOW_SIZE },
        });
      } catch (error) {
        log(`cannot arrange the window of a handed-off tab: ${error.message}`);
      }
    }
    await owner.cdp.send("Target.activateTarget", { targetId });
  }

  const clients = new Set();
  // Memory of every running browser, for maxRssMb.
  const memoryMb = cached(() => {
    let total = 0;
    for (const pid of pool.pids()) {
      const mb = processTreeMemoryMb(pid);
      if (mb === null) return null;
      total += mb;
    }
    return total;
  }, 5_000);
  // Secrets filled per task space; their values are redacted from snapshots.
  const filledSecrets = new Map();
  let viewer = null;
  registry = new TaskSpaceRegistry({
    browser,
    saved: readSaved(file),
    save: (state) => writeSaved(file, state),
    onChange: () => {
      broadcast(clients, "spaces", spaceSummaries(registry, filledSecrets));
      stopViewerAfterHandOff();
    },
    limits: () => config,
    memoryMb,
    profiles,
  });
  // Only the Default browser runs now; tabs of other profiles are lost.
  registry.pruneTargets([...main.targets.keys()]);

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
    if (Number.isInteger(spaceId)) {
      viewer.spaceId = spaceId;
      const space = registry.describe(spaceId);
      if (space?.activeTargetId) {
        await showTarget(space.activeTargetId).catch(() => {});
      }
    }
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
    const relayDir = join(stateDir(env), "relay");
    ensurePrivateDir(relayDir);
    // A fresh 0700 folder, never one that already exists.
    const dir = mkdtempSync(join(relayDir, `${id}-${Date.now()}-`));
    const owner = cdpOf(targetId);
    const { sessionId } = await owner.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    let image;
    try {
      ({ data: image } = await owner.send(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      ));
    } finally {
      await owner
        .send("Target.detachFromTarget", { sessionId })
        .catch(() => {});
    }
    const snapshot = await captureSnapshot(owner, targetId, {});
    const screenshot = join(dir, "screenshot.png");
    const snapshotFile = join(dir, "snapshot.txt");
    writeFileSync(screenshot, Buffer.from(image, "base64"), { mode: 0o600 });
    writeFileSync(snapshotFile, redactFor(id, snapshot.content), {
      mode: 0o600,
    });
    const info = pool.targetInfo(targetId) || {};
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
    // A named profile's browser with no task space and no round attached
    // stops; the next space or round of that profile starts it again.
    const inUse = registry.browsersInUse();
    const browsers = pool
      .running()
      .filter(
        (profileId) =>
          profileId !== DEFAULT_PROFILE_ID &&
          !inUse.has(profileId) &&
          pool.clientCount(profileId) === 0,
      );
    if (!dryRun) {
      for (const profileId of browsers) {
        log(`gc: stopping the idle browser of profile ${profileId}`);
        await pool.stop(profileId);
      }
    }
    const ledgers = pruneLedgers({ dryRun });
    return { dryRun, actions, browsers, ledgers };
  }

  /** The SDK ledgers of spaces that are gone (see sdk-ledgers.mjs). */
  function pruneLedgers({ dryRun = false } = {}) {
    try {
      const { ids, nextId } = registry.spaceIds();
      const removed = pruneSdkLedgers({
        dir: sdkStateDir(env),
        liveIds: ids,
        nextId,
        dryRun,
      });
      if (!dryRun && removed.length > 0) {
        log(
          `gc: removed the SDK state of ${removed.length} closed task spaces`,
        );
      }
      return removed;
    } catch (error) {
      log(`gc: could not clean the SDK state: ${error.message}`);
      return [];
    }
  }

  /** The running browser of a profile whose cookies may be read or written. */
  async function profileBrowser(profileId) {
    const profile = profiles.resolve(profileId);
    if (!profile) {
      return egoError(
        `Profile not found: ${profileId}`,
        "EGO_PROFILE_NOT_FOUND",
      );
    }
    if (profile.kind === "ephemeral") return ephemeralRefusal();
    return pool.ensure(profile.id);
  }

  function checkScope(sites, origins) {
    if (
      !Array.isArray(sites) ||
      sites.some((site) => typeof site !== "string")
    ) {
      throw new Error("sites must be a list of site names");
    }
    const checked = parseSites(sites.join(","));
    return {
      sites: checked,
      origins: parseOrigins((origins || []).join(","), checked),
    };
  }

  /** Text with the values of the secrets filled in a space replaced. */
  function redactFor(id, text) {
    const names = filledSecrets.get(id);
    if (!names || names.size === 0) return text;
    const values = [];
    for (const name of names) {
      try {
        const secret = secrets.get(name);
        if (secret) values.push(secret);
      } catch {
        // Unreadable store: nothing more to redact than before.
      }
    }
    return redactSecrets(text, values);
  }

  async function fillSecret({ id, name, targetId, clear }) {
    const problem = secretNameProblem(name);
    if (problem) return egoError(problem, "EGO_INVALID_ARGUMENT");
    const gate = registry.gate(id);
    if (gate) return gate;
    const space = registry.describe(id);
    const target = targetId ?? space.activeTargetId ?? space.targets.at(-1);
    if (!target || !space.targets.includes(target)) {
      return egoError(
        `Tab ${target ?? "(none)"} is not in task space ${id}`,
        "EGO_WEB_CONTENTS_UNAVAILABLE",
      );
    }
    let secret;
    try {
      secret = secrets.get(name);
    } catch (error) {
      return egoError(
        `Cannot read the secret store ${secrets.file}: ${error.message}`,
        "EGO_SECRET_STORE_UNAVAILABLE",
      );
    }
    if (!secret) {
      return egoError(
        `No secret named ${name}. The user stores one with: ego-browser secret set ${name} --origin https://<site>`,
        "EGO_SECRET_NOT_FOUND",
      );
    }
    const result = await fillSecretInTarget(cdpOf(target), target, secret, {
      clear: clear !== false,
    });
    if (result.filled) {
      if (!filledSecrets.has(id)) filledSecrets.set(id, new Set());
      filledSecrets.get(id).add(name);
      broadcast(clients, "spaces", spaceSummaries(registry, filledSecrets));
    }
    return result;
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
        spaces: spaceSummaries(registry, filledSecrets),
      };
    },
    status: () => ({
      version: HOST_VERSION,
      browser: browserVersion.product,
      devtools,
      display: display ?? (headless ? "headless" : "desktop"),
      usage: { ...registry.usage(), browsers: pool.running().length },
      browsers: pool.running(),
      limits: {
        maxTaskSpaces: config.maxTaskSpaces,
        maxPagesPerSpace: config.maxPagesPerSpace,
        maxTotalPages: config.maxTotalPages,
        maxRssMb: config.maxRssMb,
        maxBrowsers: config.maxBrowsers,
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
    profiles: () => {
      const { profiles: list } = profiles.list();
      return {
        profiles: list.map((profile) => ({
          ...profile,
          running: pool.running().includes(profile.id),
          spaces: registry.spacesOfProfile(profile.id).length,
        })),
      };
    },
    createProfile: ({ id, name }) => profiles.create(id, name),
    removeProfile: async ({ id }) => {
      const profile = profiles.resolve(id);
      if (!profile || profile.id !== id) {
        return egoError(`Profile not found: ${id}`, "EGO_PROFILE_NOT_FOUND");
      }
      if (profile.kind !== "named") {
        return egoError(
          `${id} is a built-in profile and cannot be removed`,
          "EGO_INVALID_ARGUMENT",
        );
      }
      const using = registry.spacesOfProfile(id);
      if (using.length > 0) {
        return egoError(
          `Profile ${id} is used by task space(s) ${using.join(", ")}. Close them first: ego-browser close ${using.join(" ")}`,
          "EGO_PROFILE_BUSY",
        );
      }
      await pool.stop(id);
      const result = profiles.remove(id);
      roundLog.event("profile-remove", { message: id });
      return result;
    },
    exportProfileData: async ({ profileId, sites, origins }) => {
      const scope = checkScope(sites, origins);
      const instance = await profileBrowser(profileId);
      if (isEgoError(instance)) return instance;
      const data = await exportProfileData(instance.cdp, scope);
      roundLog.event("cookies-export", {
        message: `${profileId}: ${data.cookies.length} cookies`,
      });
      return data;
    },
    importProfileData: async ({ profileId, cookies, localStorage }) => {
      const instance = await profileBrowser(profileId);
      if (isEgoError(instance)) return instance;
      const result = await importProfileData(instance.cdp, {
        cookies,
        localStorage,
      });
      roundLog.event("cookies-import", {
        message: `${profileId}: ${result.cookies} cookies`,
      });
      // Chrome writes cookies to disk every 30 seconds. A named profile's
      // browser that nothing uses is closed now, which writes them at once.
      const id = instance.profileId;
      if (
        id !== DEFAULT_PROFILE_ID &&
        !registry.browsersInUse().has(id) &&
        pool.clientCount(id) === 0
      ) {
        await pool.stop(id);
        result.saved = true;
      }
      return result;
    },
    fillSecret: (params) => fillSecret(params),
    redact: ({ id, text }) => ({ text: redactFor(id, String(text ?? "")) }),
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
        // From here on this socket carries NUL-framed CDP for one client,
        // on the browser of one profile (Default unless asked).
        socket.off("data", onData);
        clients.delete(socket);
        const profileId = message.params?.browser ?? DEFAULT_PROFILE_ID;
        pool.ensure(String(profileId)).then(
          (instance) => {
            if (socket.destroyed) return;
            socket.write(encode({ id: message.id, result: "ok" }));
            instance.mux.attachStream(socket);
          },
          (error) => {
            if (!socket.destroyed) {
              socket.end(
                encode({
                  id: message.id,
                  error: String(error?.message || error),
                }),
              );
            }
          },
        );
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

  pruneLedgers();
  const gcTimer = setInterval(() => {
    runGc().catch((error) => log(`gc failed: ${error.message}`));
  }, config.gcIntervalMs);
  gcTimer.unref();

  shutdown = (code) => {
    if (stopping) return;
    stopping = true;
    clearInterval(gcTimer);
    // Keep the latest tab URLs, so a restart can say what was lost.
    writeSaved(file, registry.snapshotState());
    roundLog.event("stop", { exit: code });
    viewer?.stop("daemon stopped");
    server.close();
    for (const socket of clients) socket.destroy();
    for (const profileId of pool.running()) {
      const instance = pool.get(profileId);
      instance.mux.close();
      instance.cdp.close();
      // A browser that stopped answering may ignore SIGTERM.
      if (instance.child.exitCode === null) {
        instance.child.kill(code ? "SIGKILL" : "SIGTERM");
      }
    }
    rmSync(socketPath, { force: true });
    rmSync(infoFile, { force: true });
    rmSync(lockFile, { force: true });
    virtualDisplay?.stop();
    process.exit(code);
  };

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

  // Create the socket 0600 from the start: a chmod after listen() leaves a
  // window in which it has the umask's mode.
  const umask = process.umask(0o077);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } finally {
    process.umask(umask);
  }
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

function spaceSummaries(registry, filledSecrets = new Map()) {
  return registry.snapshotState().spaces.map((space) => ({
    id: space.id,
    profileId: space.profileId,
    secrets: filledSecrets.has(space.id),
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

export function readSaved(file, report = log) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      report(`cannot read ${file} (${error.code}); starting with no spaces`);
    }
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Keep the broken file for a look instead of saving over it.
    const kept = `${file}.corrupt`;
    try {
      renameSync(file, kept);
    } catch {
      // Read-only state dir: the next save fails and says so.
    }
    report(
      `${file} is not valid JSON; kept it as ${kept} and started with no task spaces`,
    );
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

function log(message) {
  process.stderr.write(`[ego-lite ${new Date().toISOString()}] ${message}\n`);
}
