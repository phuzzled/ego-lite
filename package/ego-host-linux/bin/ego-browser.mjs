#!/usr/bin/env node
/**
 * ego-browser for Linux.
 *
 *   ego-browser nodejs [--sdk-path <index.js>] [-e <code>]   run a script (stdin by default)
 *   ego-browser skill  [--sdk-path <index.js>]               print the usage guide
 *   ego-browser start [--display virtual] | stop | status    manage the browser daemon
 *   ego-browser spaces | close <id...> | close --all         list or close task spaces
 *   ego-browser gc | logs | view | relay | restore | service operations
 *   ego-browser profiles | cookies | secret                  identity: profiles, logins, secrets
 *   ego-browser read | shot | tables | snapshot | search     one-shot commands
 *   ego-browser mcp                                          MCP server on stdio
 *   ego-browser upgrade                                      how to update ego lite
 */
import { spawn } from "node:child_process";
import {
  constants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { connectRunningDaemon } from "../src/control-channel.mjs";
import {
  COOKIE_WARNING,
  buildCookieFile,
  chromeCookiesPath,
  describeSkipped,
  filePermissionWarning,
  keyringPassword,
  parseOrigins,
  parseSites,
  readChromeCookies,
  readCookieFile,
  writePrivateFile,
} from "../src/cookies.mjs";
import { createEgoBindings } from "../src/ego-bindings.mjs";
import {
  HOST_VERSION,
  bundledSdkPath,
  daemonLogFile,
  debugSdkPath,
  ensurePrivateDir,
  spacesFile,
} from "../src/paths.mjs";
import {
  DEFAULT_SPACE_TTL_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  McpServer,
  runMcpStdio,
} from "../src/mcp-server.mjs";
import {
  ONE_SHOT_USAGE,
  UsageError,
  parseDuration,
  parseOneShotArgs,
  runOneShot,
} from "../src/oneshot.mjs";
import { ProfileStore } from "../src/profiles.mjs";
import { formatEntry, readLogs } from "../src/round-log.mjs";
import { SecretStore } from "../src/secrets.mjs";
import { openSdkSession } from "../src/sdk-session.mjs";
import { serviceCommand } from "../src/service.mjs";

const USAGE = `ego-browser ${HOST_VERSION} (Linux)

Usage:
  ego-browser nodejs [--sdk-path <index.js>] <<'EOF'
  ...script...
  EOF
  ego-browser nodejs [--sdk-path <index.js>] -e "<script>"
  ego-browser skill [--sdk-path <index.js>]
  ego-browser start [--display virtual]
                                     start the daemon; virtual: headful on Xvfb
  ego-browser stop | status
  ego-browser spaces                 list task spaces
  ego-browser close <id> [<id>...]   close task spaces
  ego-browser close --all            close every agent-controlled task space
  ego-browser close --force <id|--all>
                                     also close spaces handed off to the user
  ego-browser gc [--dry-run]         close agent spaces idle past their TTL
  ego-browser logs [--space <id>] [-n <count>] [--follow] [--json]
                                     recent rounds, actions and daemon events
  ego-browser view [--stop]          a one-time noVNC link to the virtual display
  ego-browser relay <id>             screenshot and snapshot of a space, to show the user
  ego-browser restore <id>           reopen the tabs a browser restart closed
  ego-browser service install [--display virtual] [--no-enable] | uninstall | status
                                     systemd user service for the daemon
  ego-browser profiles               list profiles (Default, named, ephemeral)
  ego-browser profiles create <id> [--name <name>]
                                     a persistent profile with its own logins
  ego-browser profiles remove <id>   delete a named profile and its browser data
  ego-browser cookies export --profile <id> --sites <a.com,b.org> --out <file>
                       [--local-storage <https://origin,...>] [--force]
                                     write a profile's logins to a 0600 file
  ego-browser cookies import --profile <id> --in <file>
  ego-browser cookies import-chrome --from <chrome profile dir> --profile <id>
                       --sites <a.com,...> [--keyring] [--dry-run]
                                     copy logins from this machine's desktop Chrome
  ego-browser secret set <name> --origin <https://site> [--origin ...]
                                     store a secret (asks for it; or reads stdin)
  ego-browser secret list | remove <name>
  ego-browser mcp [--profile <id>] [--timeout <2m>] [--ttl <30m>]
                                     an MCP server on stdio (tools browser_*)
  ego-browser upgrade

${ONE_SHOT_USAGE}`;

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/phuzzled/ego-lite/main/package/ego-host-linux/scripts/install.sh | sh";

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "nodejs":
      return runNodejs(parseRunArgs(rest));
    case "skill":
      return printSkill(parseRunArgs(rest));
    case "daemon": {
      const { runDaemon } = await import("../src/daemon.mjs");
      await runDaemon();
      return null;
    }
    case "start":
      return startDaemon(rest);
    case "stop":
      return stopDaemon();
    case "status":
      return printStatus();
    case "spaces":
      return printSpaces();
    case "close":
      return closeSpaces(rest);
    case "gc":
      return runGc(rest);
    case "logs":
      return printLogs(rest);
    case "view":
      return startView(rest);
    case "relay":
      return relaySpace(rest);
    case "restore":
      return restoreSpace(rest);
    case "profiles":
      return profilesCommand(rest);
    case "cookies":
      return cookiesCommand(rest);
    case "secret":
    case "secrets":
      return secretCommand(rest);
    case "service":
      return serviceCommand(rest, { maxRssMb: loadConfig().config.maxRssMb });
    case "read":
    case "shot":
    case "tables":
    case "snapshot":
    case "search":
      return oneShotCommand(command, rest);
    case "mcp":
      return mcpCommand(rest);
    case "upgrade":
      process.stdout.write(
        `Re-run the ego lite Linux installer to upgrade:\n  ${INSTALL_COMMAND}\n`,
      );
      return 0;
    case "-h":
    case "--help":
    case undefined:
      process.stdout.write(USAGE);
      return command ? 0 : 2;
    default:
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      return 2;
  }
}

function parseRunArgs(args) {
  const options = { sdkPath: undefined, code: undefined, rest: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--sdk-path") options.sdkPath = args[++i];
    else if (arg.startsWith("--sdk-path=")) options.sdkPath = arg.slice(11);
    else if (arg === "-e" || arg === "--eval") options.code = args[++i];
    else options.rest.push(arg);
  }
  if (options.sdkPath === undefined && args.includes("--sdk-path")) {
    throw new Error("--sdk-path requires a path");
  }
  return options;
}

/** Same order as the macOS app: --sdk-path, debug override, bundled SDK. */
function resolveSdk(sdkPath) {
  if (sdkPath) return { path: resolve(sdkPath), source: "sdk-path" };
  const debug = debugSdkPath();
  if (existsSync(debug)) return { path: debug, source: "debug-sdk" };
  return { path: bundledSdkPath(), source: "bundled" };
}

function printSkill({ sdkPath }) {
  const sdk = resolveSdk(sdkPath);
  const guideDir = join(dirname(sdk.path), "ego-browser");
  const guide = join(guideDir, "SKILL.md");
  if (!existsSync(guide)) {
    process.stderr.write(`Usage guide not found: ${guide}\n`);
    return 1;
  }
  if (sdk.source !== "bundled") {
    process.stdout.write(
      `[ego-browser:skill] source=${sdk.source} dir=${guideDir} (override, not the bundled guide)\n`,
    );
  }
  process.stdout.write(readFileSync(guide, "utf8"));
  return 0;
}

/** Open an in-process SDK session; null after printing why it cannot. */
function sdkPathOrNull(sdkPath) {
  const sdk = resolveSdk(sdkPath);
  if (!existsSync(sdk.path)) {
    process.stderr.write(`ego-browser SDK not found: ${sdk.path}\n`);
    return null;
  }
  return sdk.path;
}

async function oneShotCommand(command, args) {
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(ONE_SHOT_USAGE);
    return 0;
  }
  let options;
  try {
    options = parseOneShotArgs(command, args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(
      `ego-browser ${command}: ${error.message}\n\n${ONE_SHOT_USAGE}`,
    );
    return 2;
  }
  const sdkPath = sdkPathOrNull(options.sdkPath);
  if (!sdkPath) return 1;
  return runOneShot(options, {
    openSession: () => openSdkSession({ sdkPath, connect: connectWithHello }),
    stdout: process.stdout,
    stderr: process.stderr,
    onInterrupt(handler) {
      process.once("SIGINT", handler);
      process.once("SIGTERM", handler);
      return () => {
        process.off("SIGINT", handler);
        process.off("SIGTERM", handler);
      };
    },
  });
}

async function mcpCommand(args) {
  const rest = [...args];
  let profileId;
  let toolTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
  let ttlMs = DEFAULT_SPACE_TTL_MS;
  let sdkPathOption;
  try {
    profileId = takeOption(rest, "--profile");
    const timeout = takeOption(rest, "--timeout");
    if (timeout) toolTimeoutMs = parseDuration(timeout);
    const ttl = takeOption(rest, "--ttl");
    if (ttl) ttlMs = parseDuration(ttl, "--ttl", 24 * 3_600_000);
    sdkPathOption = takeOption(rest, "--sdk-path");
  } catch (error) {
    process.stderr.write(`ego-browser mcp: ${error.message}\n`);
    return 2;
  }
  if (rejectExtra(rest)) return 2;
  const sdkPath = sdkPathOrNull(sdkPathOption);
  if (!sdkPath) return 1;

  // stdout carries the protocol only. Anything else that writes to it (a
  // stray console.log, an SDK notice) goes to stderr instead.
  const protocolWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) =>
    process.stderr.write(chunk, ...rest);
  const log = (line) => process.stderr.write(`[ego-browser mcp] ${line}\n`);

  const server = new McpServer({
    version: HOST_VERSION,
    profileId,
    toolTimeoutMs,
    ttlMs,
    log,
    // browser_handoff issues the viewer link itself and returns it.
    openSession: () =>
      openSdkSession({
        sdkPath,
        connect: connectWithHello,
        handOffViewer: false,
      }),
  });
  const transport = runMcpStdio(server, {
    input: process.stdin,
    write: (text) => protocolWrite(text),
    log,
    drainMs: toolTimeoutMs,
  });
  const onSignal = () => void transport.stop();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, onSignal);
  process.stdout.on("error", onSignal);
  await transport.done;
  return 0;
}

async function runNodejs({ sdkPath, code, rest }) {
  if (rest.length > 0 && rest[0] !== "-") {
    process.stderr.write(`Unexpected arguments: ${rest.join(" ")}\n${USAGE}`);
    return 2;
  }
  const sdk = resolveSdk(sdkPath);
  if (!existsSync(sdk.path)) {
    process.stderr.write(`ego-browser SDK not found: ${sdk.path}\n`);
    return 1;
  }
  const source = code ?? (await readStdin());

  const { control, hello } = await connectWithHello();
  const ego = await createEgoBindings({ control, hello });
  globalThis.ego = ego;
  // The SDK keys Page labels by browser run. It cannot use its parent process
  // here, because each agent command has a new parent shell.
  process.env.EGO_BROWSER_INSTANCE_ID = hello.instanceId;
  const spacesBefore = new Set(hello.spaces.map((space) => space.id));
  const started = Date.now();
  ego.logRound("start");

  let exitCode = 1;
  let module;
  try {
    // Importing the SDK installs it on globalThis (installEgoSdk).
    module = await import(pathToFileURL(sdk.path).href);
    exitCode = await module.runMain({ argv: [], stdinText: source });
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    exitCode = 1;
  }
  try {
    if (exitCode !== 0) await reportOpenSpaces(control, spacesBefore);
  } finally {
    if (typeof module?.disposeEgoSdk === "function") {
      await module.disposeEgoSdk(globalThis).catch(() => {});
    }
    ego.logRound("end", { exit: exitCode, ms: Date.now() - started });
    await ego.flushLog();
    ego.close();
    control.close();
  }
  return exitCode;
}

function readStdin() {
  return new Promise((resolveText, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveText(data));
    process.stdin.on("error", reject);
  });
}

/** Connect and say hello. A daemon with a dead browser stops; start anew. */
async function connectWithHello() {
  let control = await connectDaemon();
  try {
    return { control, hello: await control.call("hello") };
  } catch {
    control.close();
    await new Promise((done) => setTimeout(done, 500));
    control = await connectDaemon();
    return { control, hello: await control.call("hello") };
  }
}

/** After a failed run, name the task spaces it left open. */
async function reportOpenSpaces(control, spacesBefore) {
  const result = await control.call("listTaskSpaces").catch(() => null);
  const opened = (result?.taskSpaces || []).filter(
    (space) => space.ownership === "agent" && !spacesBefore.has(space.id),
  );
  for (const space of opened) {
    process.stderr.write(
      `[ego-browser] task space ${space.id} ("${space.name}") is still open. Resume it with taskSpace(${space.id}), or close it with: ego-browser close ${space.id}\n`,
    );
  }
}

/** Connect to a running daemon, or print that none is running. */
async function runningDaemon() {
  try {
    return await connectRunningDaemon();
  } catch {
    process.stdout.write("ego lite daemon is not running\n");
    return null;
  }
}

async function printSpaces() {
  const control = await runningDaemon();
  if (!control) return 1;
  const { taskSpaces } = await control.call("listTaskSpaces");
  // describe, not listTabs: listTabs refuses spaces the agent may not use.
  const details = await Promise.all(
    taskSpaces.map((space) =>
      control.call("describe", { id: space.id }).catch(() => null),
    ),
  );
  control.close();
  if (taskSpaces.length === 0) {
    process.stdout.write("no task spaces\n");
    return 0;
  }
  process.stdout.write("id\towner\ttabs\tidle\tname\n");
  taskSpaces.forEach((space, index) => {
    const detail = details[index];
    const count = detail?.targets?.length ?? "?";
    const idle = detail?.lastActivity
      ? formatDuration(Date.now() - detail.lastActivity)
      : "?";
    const stale = detail?.stale ? " (stale: tabs lost in a restart)" : "";
    process.stdout.write(
      `${space.id}\t${space.ownership}\t${count}\t${idle}\t${space.name}${stale}\n`,
    );
  });
  return 0;
}

async function closeSpaces(args) {
  const all = args.includes("--all");
  // The CLI is the user acting, so --force may close a handed-off space.
  const force = args.includes("--force");
  const ids = args
    .filter((arg) => arg !== "--all" && arg !== "--force")
    .map(Number);
  if ((!all && ids.length === 0) || ids.some((id) => !Number.isInteger(id))) {
    process.stderr.write(`close needs task space ids or --all\n${USAGE}`);
    return 2;
  }
  const control = await runningDaemon();
  if (!control) return 1;
  if (all) {
    const { taskSpaces } = await control.call("listTaskSpaces");
    // Spaces the user owns stay open; handed-off ones close with --force.
    const closable = force ? ["agent", "agentDelegatedToUser"] : ["agent"];
    ids.push(
      ...taskSpaces
        .filter((space) => closable.includes(space.ownership))
        .map((space) => space.id),
    );
  }
  let code = 0;
  for (const id of ids) {
    const result = await control.call("closeTaskSpace", { id, force });
    if (typeof result === "string") {
      process.stdout.write(`${result}\n`);
    } else {
      const hint =
        result?.error_code === "EGO_TASK_SPACE_USER_IN_CONTROL"
          ? `; to close it anyway: ego-browser close --force ${id}`
          : "";
      process.stderr.write(
        `${id}: not closed (${result?.error_code || "error"}: ${result?.error})${hint}\n`,
      );
      code = 1;
    }
  }
  control.close();
  if (ids.length === 0) process.stdout.write("no agent task spaces to close\n");
  return code;
}

async function runGc(args) {
  const unknown = args.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n`);
    return 2;
  }
  const control = await runningDaemon();
  if (!control) return 1;
  const {
    dryRun,
    actions,
    browsers = [],
  } = await control.call("gc", {
    dryRun: args.includes("--dry-run"),
  });
  control.close();
  for (const profileId of browsers) {
    process.stdout.write(
      `-\t${dryRun ? "would stop" : "stopped"} the idle browser of profile ${profileId}\n`,
    );
  }
  if (actions.length === 0) {
    if (browsers.length === 0) process.stdout.write("nothing to collect\n");
    return 0;
  }
  for (const action of actions) {
    const verb =
      action.action === "closed"
        ? dryRun
          ? "would close"
          : "closed"
        : dryRun
          ? "would return to the agent"
          : "returned to the agent";
    process.stdout.write(
      `${action.id}\t${verb}\tidle ${formatDuration(action.idleMs)}\t${action.name}\n`,
    );
  }
  return 0;
}

async function printLogs(args) {
  let space;
  let limit = 50;
  let follow = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--space") space = Number(args[++i]);
    else if (arg === "-n" || arg === "--lines") limit = Number(args[++i]);
    else if (arg === "--follow" || arg === "-f") follow = true;
    else if (arg === "--json") json = true;
    else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      return 2;
    }
  }
  if (space !== undefined && !Number.isInteger(space)) {
    process.stderr.write("--space needs a task space id\n");
    return 2;
  }
  if (!Number.isInteger(limit) || limit < 0) {
    process.stderr.write("-n needs a count\n");
    return 2;
  }
  const print = (entry) =>
    process.stdout.write(
      `${json ? JSON.stringify(entry) : formatEntry(entry)}\n`,
    );
  let entries = readLogs({ space, limit });
  entries.forEach(print);
  if (!follow) return 0;
  let last = entries.at(-1)?.ts ?? 0;
  let seen = new Set(
    entries.filter((e) => e.ts === last).map((e) => JSON.stringify(e)),
  );
  for (;;) {
    await new Promise((done) => setTimeout(done, 500));
    entries = readLogs({ space, limit: 500 }).filter(
      (entry) =>
        entry.ts > last ||
        (entry.ts === last && !seen.has(JSON.stringify(entry))),
    );
    for (const entry of entries) print(entry);
    if (entries.length > 0) {
      last = entries.at(-1).ts;
      seen = new Set(
        entries.filter((e) => e.ts === last).map((e) => JSON.stringify(e)),
      );
    }
  }
}

async function startView(args) {
  const stop = args.includes("--stop");
  const unknown = args.filter((arg) => arg !== "--stop");
  if (unknown.length > 0) {
    process.stderr.write(`Unknown option: ${unknown[0]}\n`);
    return 2;
  }
  const control = await runningDaemon();
  if (!control) return 1;
  if (stop) {
    process.stdout.write(`${await control.call("stopViewer")}\n`);
    control.close();
    return 0;
  }
  const viewer = await control.call("startViewer", {});
  control.close();
  if (viewer?.error_code) {
    process.stderr.write(`${viewer.error_code}: ${viewer.error}\n`);
    return 1;
  }
  const minutes = Math.round((viewer.expiresAt - Date.now()) / 60_000);
  process.stdout.write(
    `Viewer: ${viewer.url}\nFrom your computer: ${viewer.ssh}\nthen open the link. It works once; run ego-browser view again for a new one.\nThe viewer stops after ${minutes} minutes, when the hand-off ends, or with: ego-browser view --stop\n`,
  );
  return 0;
}

function spaceIdArg(args, command) {
  const id = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(id)) {
    process.stderr.write(`${command} needs one task space id\n`);
    return null;
  }
  return id;
}

async function relaySpace(args) {
  const id = spaceIdArg(args, "relay");
  if (id === null) return 2;
  const control = await runningDaemon();
  if (!control) return 1;
  const result = await control.call("relay", { id });
  control.close();
  if (result?.error_code) {
    process.stderr.write(`${result.error_code}: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(
    `screenshot: ${result.screenshot}\nsnapshot: ${result.snapshot}\npage: ${result.title} ${result.url}\n`,
  );
  return 0;
}

async function restoreSpace(args) {
  const id = spaceIdArg(args, "restore");
  if (id === null) return 2;
  const control = await runningDaemon();
  if (!control) return 1;
  const result = await control.call("restoreTabs", { id });
  control.close();
  if (result?.error_code) {
    process.stderr.write(`${result.error_code}: ${result.error}\n`);
    return 1;
  }
  for (const tab of result.tabs) process.stdout.write(`reopened ${tab.url}\n`);
  for (const url of result.skipped) {
    process.stdout.write(
      `not reopened (not http/https): ${url || "(unknown)"}\n`,
    );
  }
  if (result.tabs.length === 0 && result.skipped.length === 0) {
    process.stdout.write(`task space ${id} has no lost tabs\n`);
  }
  return 0;
}

/** Value of `--name value` or `--name=value`; the rest stays in `args`. */
function takeOption(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} needs a value`);
      }
      args.splice(i, 2);
      return value;
    }
    if (args[i].startsWith(`${name}=`)) {
      const value = args[i].slice(name.length + 1);
      args.splice(i, 1);
      return value;
    }
  }
  return undefined;
}

/** Every value of a repeatable option. */
function takeOptions(args, name) {
  const values = [];
  for (let value; (value = takeOption(args, name)) !== undefined;) {
    values.push(value);
  }
  return values;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function rejectExtra(args) {
  if (args.length === 0) return false;
  process.stderr.write(`Unexpected argument: ${args[0]}\n`);
  return true;
}

async function profilesCommand(args) {
  const [sub = "list", ...rest] = args;
  if (sub === "list") {
    if (rejectExtra(rest)) return 2;
    let list;
    let control = null;
    try {
      control = await connectRunningDaemon();
    } catch {
      // Not running: list from the file, without running state.
    }
    if (control) {
      list = (await control.call("profiles")).profiles;
      control.close();
    } else {
      list = new ProfileStore().list().profiles;
    }
    process.stdout.write("id\tkind\tbrowser\tspaces\tname\n");
    for (const profile of list) {
      const kind = profile.isDefault
        ? "default"
        : profile.ephemeral
          ? "ephemeral"
          : "named";
      const running =
        profile.running === undefined
          ? "-"
          : profile.ephemeral
            ? "(in Default)"
            : profile.running
              ? "running"
              : "stopped";
      process.stdout.write(
        `${profile.id}\t${kind}\t${running}\t${profile.spaces ?? "-"}\t${profile.name}\n`,
      );
    }
    return 0;
  }
  if (sub === "create") {
    const name = takeOption(rest, "--name");
    const [id, ...extra] = rest;
    if (!id || rejectExtra(extra)) {
      process.stderr.write("profiles create needs one profile id\n");
      return 2;
    }
    const result = new ProfileStore().create(id, name);
    if (result.error_code) {
      process.stderr.write(`${result.error_code}: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(
      `profile ${result.id} created. Use it with: taskSpace("<task>", { profileId: "${result.id}" })\n`,
    );
    return 0;
  }
  if (sub === "remove" || sub === "rm") {
    const [id, ...extra] = rest;
    if (!id || rejectExtra(extra)) {
      process.stderr.write("profiles remove needs one profile id\n");
      return 2;
    }
    let result;
    let control = null;
    try {
      control = await connectRunningDaemon();
    } catch {
      // Not running: no browser to stop and no live task space.
    }
    if (control) {
      result = await control.call("removeProfile", { id });
      control.close();
    } else {
      result = removeProfileOffline(id);
    }
    if (result?.error_code) {
      process.stderr.write(`${result.error_code}: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(
      `${result} (its cookies and browser data are deleted)\n`,
    );
    return 0;
  }
  process.stderr.write(`Unknown profiles command: ${sub}\n${USAGE}`);
  return 2;
}

/** Remove a profile while no daemon runs; refuse when a saved space uses it. */
function removeProfileOffline(id) {
  const store = new ProfileStore();
  const profile = store.resolve(id);
  if (!profile || profile.id !== id || profile.kind !== "named") {
    return {
      error: `Profile not found or built in: ${id}`,
      error_code: "EGO_PROFILE_NOT_FOUND",
    };
  }
  let saved = [];
  try {
    saved = JSON.parse(readFileSync(spacesFile(), "utf8")).spaces ?? [];
  } catch {
    // No saved task spaces.
  }
  const using = saved.filter((space) => space.profileId === id);
  if (using.length > 0) {
    return {
      error: `Profile ${id} is used by task space(s) ${using.map((space) => space.id).join(", ")}; close them first`,
      error_code: "EGO_PROFILE_BUSY",
    };
  }
  return store.remove(id);
}

async function cookiesCommand(args) {
  const [sub, ...rest] = args;
  try {
    if (sub === "export") return await exportCookies(rest);
    if (sub === "import") return await importCookies(rest);
    if (sub === "import-chrome") return await importChromeCookies(rest);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    return 1;
  }
  process.stderr.write(`Unknown cookies command: ${sub ?? ""}\n${USAGE}`);
  return 2;
}

function profileOption(args) {
  const profileId = takeOption(args, "--profile");
  if (!profileId)
    throw new Error("--profile <id> is required (see: ego-browser profiles)");
  return profileId;
}

async function exportCookies(args) {
  const profileId = profileOption(args);
  const sitesText = takeOption(args, "--sites");
  const out = takeOption(args, "--out") ?? takeOption(args, "-o");
  const originsText = takeOption(args, "--local-storage");
  const force = takeFlag(args, "--force");
  if (rejectExtra(args)) return 2;
  if (!sitesText) {
    throw new Error(
      "--sites is required: export only the sites you name, e.g. --sites github.com,notion.so",
    );
  }
  if (!out)
    throw new Error(
      "--out <file> is required; the file is created with mode 0600",
    );
  const sites = parseSites(sitesText);
  const origins = originsText ? parseOrigins(originsText, sites) : [];
  const control = await connectDaemon();
  let data;
  try {
    data = await control.call(
      "exportProfileData",
      { profileId, sites, origins },
      120_000,
    );
  } finally {
    control.close();
  }
  if (data?.error_code) {
    process.stderr.write(`${data.error_code}: ${data.error}\n`);
    return 1;
  }
  const path = resolve(out);
  writePrivateFile(
    path,
    buildCookieFile({
      profile: profileId,
      sites,
      cookies: data.cookies,
      localStorage: data.localStorage,
    }),
    { force },
  );
  const items = Object.values(data.localStorage).reduce(
    (sum, entries) => sum + Object.keys(entries).length,
    0,
  );
  process.stderr.write(`${COOKIE_WARNING}\n`);
  process.stdout.write(
    `exported ${data.cookies.length} cookie(s)${origins.length ? ` and ${items} localStorage item(s)` : ""} of ${sites.join(", ")} from profile ${profileId} to ${path} (mode 0600)\n`,
  );
  return 0;
}

async function importCookies(args) {
  const profileId = profileOption(args);
  const file = takeOption(args, "--in") ?? args.shift();
  if (rejectExtra(args)) return 2;
  if (!file) throw new Error("--in <file> is required");
  const path = resolve(file);
  const warning = filePermissionWarning(path);
  if (warning) process.stderr.write(`${warning}\n`);
  const data = readCookieFile(readFileSync(path, "utf8"));
  const control = await connectDaemon();
  let result;
  try {
    result = await control.call(
      "importProfileData",
      { profileId, cookies: data.cookies, localStorage: data.localStorage },
      120_000,
    );
  } finally {
    control.close();
  }
  if (result?.error_code) {
    process.stderr.write(`${result.error_code}: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(
    `imported ${result.cookies} cookie(s)${result.localStorage ? ` and ${result.localStorage} localStorage item(s)` : ""} into profile ${profileId}${result.expired ? `; ${result.expired} expired cookie(s) skipped` : ""}${savedNote(result)}\n`,
  );
  process.stderr.write(
    `${path} still holds live sessions; delete it if you no longer need it.\n`,
  );
  return 0;
}

/** Whether imported cookies are already on disk. */
function savedNote(result) {
  return result.saved
    ? " (saved to disk)"
    : " (the browser saves them to disk within 30 seconds)";
}

async function importChromeCookies(args) {
  const profileId = profileOption(args);
  const from = takeOption(args, "--from");
  const sitesText = takeOption(args, "--sites");
  const useKeyring = takeFlag(args, "--keyring");
  const keyringApp = takeOption(args, "--keyring-app");
  const dryRun = takeFlag(args, "--dry-run");
  if (rejectExtra(args)) return 2;
  if (!from) {
    throw new Error(
      "--from <path> is required: your Chrome profile folder, e.g. ~/.config/google-chrome/Default",
    );
  }
  if (!sitesText)
    throw new Error("--sites is required, e.g. --sites github.com");
  const sites = parseSites(sitesText);
  const file = chromeCookiesPath(resolve(from));
  let keyring = null;
  if (useKeyring) {
    const application =
      keyringApp ?? (/chromium/i.test(file) ? "chromium" : "chrome");
    keyring = keyringPassword(application);
    if (!keyring) {
      process.stderr.write(
        `The desktop keyring has no "${application}" key (secret-tool lookup application ${application} found nothing, or secret-tool is missing). Cookies encrypted with it will be skipped.\n`,
      );
    }
  }
  const { cookies, skipped } = await readChromeCookies(file, {
    sites,
    keyring,
  });
  for (const line of describeSkipped(skipped, Boolean(keyring))) {
    process.stderr.write(`${line}\n`);
  }
  if (dryRun) {
    process.stdout.write(
      `would import ${cookies.length} cookie(s) of ${sites.join(", ")} from ${file} into profile ${profileId}\n`,
    );
    return 0;
  }
  if (cookies.length === 0) {
    process.stdout.write("no cookies to import\n");
    return skipped.keyring + skipped.undecryptable > 0 ? 1 : 0;
  }
  const control = await connectDaemon();
  let result;
  try {
    result = await control.call(
      "importProfileData",
      { profileId, cookies, localStorage: {} },
      120_000,
    );
  } finally {
    control.close();
  }
  if (result?.error_code) {
    process.stderr.write(`${result.error_code}: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(
    `imported ${result.cookies} cookie(s) of ${sites.join(", ")} from ${file} into profile ${profileId}${savedNote(result)}\n`,
  );
  return 0;
}

async function secretCommand(args) {
  const [sub, ...rest] = args;
  const store = new SecretStore();
  try {
    if (sub === "list") {
      if (rejectExtra(rest)) return 2;
      const secrets = store.list();
      if (secrets.length === 0) process.stdout.write("no secrets\n");
      for (const secret of secrets) {
        process.stdout.write(`${secret.name}\t${secret.origins.join(", ")}\n`);
      }
      return 0;
    }
    if (sub === "set") {
      const origins = takeOptions(rest, "--origin");
      const [name, ...extra] = rest;
      if (!name || rejectExtra(extra)) {
        process.stderr.write(
          "secret set needs one name and at least one --origin\n",
        );
        return 2;
      }
      if (origins.length === 0) {
        throw new Error(
          "--origin is required: where this secret may be typed, e.g. --origin https://github.com",
        );
      }
      const value = await readSecretValue(`Secret ${name}: `);
      const saved = store.set(name, value, origins);
      process.stdout.write(
        `secret ${saved.name} stored in ${store.file} (mode 0600), for ${saved.origins.join(", ")}. An agent fills it with ego.fillSecret("${saved.name}").\n`,
      );
      return 0;
    }
    if (sub === "remove" || sub === "rm") {
      const [name, ...extra] = rest;
      if (!name || rejectExtra(extra)) {
        process.stderr.write("secret remove needs one name\n");
        return 2;
      }
      if (!store.remove(name)) {
        process.stderr.write(`no secret named ${name}\n`);
        return 1;
      }
      process.stdout.write(`secret ${name} removed\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    return 1;
  }
  process.stderr.write(`Unknown secret command: ${sub ?? ""}\n${USAGE}`);
  return 2;
}

/**
 * Read a secret without echo from the terminal, or the first line of stdin
 * when it is not a terminal (piped from a password manager). Never from the
 * command line, which shell history and `ps` keep.
 */
function readSecretValue(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    return readStdin().then((text) => text.replace(/\r?\n$/, ""));
  }
  return new Promise((resolveValue, reject) => {
    process.stderr.write(prompt);
    let value = "";
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const done = (error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolveValue(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

async function startDaemon(args) {
  let display;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--display") display = args[++i];
    else if (args[i].startsWith("--display=")) display = args[i].slice(10);
    else {
      process.stderr.write(`Unknown option: ${args[i]}\n`);
      return 2;
    }
  }
  if (display !== undefined && display !== "virtual" && display !== "auto") {
    process.stderr.write("--display must be virtual or auto\n");
    return 2;
  }
  const env = { ...process.env };
  if (display !== undefined) env.EGO_LITE_DISPLAY = display;
  const control = await connectDaemon(env);
  const hello = await control.call("hello");
  control.close();
  if (display === "virtual" && hello.display !== "virtual") {
    process.stderr.write(
      `ego lite is already running (${hello.display}). Run ego-browser stop, then ego-browser start --display virtual\n`,
    );
    return 1;
  }
  process.stdout.write(`ego lite daemon is running (${hello.display})\n`);
  return 0;
}

/** Connect to the daemon, starting it in the background when needed. */
async function connectDaemon(env = process.env, timeoutMs = 40_000) {
  try {
    return await connectRunningDaemon(env);
  } catch {
    // Not running yet.
  }
  const logFile = daemonLogFile(env);
  ensurePrivateDir(dirname(logFile));
  // daemon.log may hold page errors: keep it 0600 and never follow a link.
  const log = openSync(
    logFile,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  fchmodSync(log, 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "daemon"],
    { detached: true, stdio: ["ignore", log, log], env },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
    try {
      return await connectRunningDaemon(env);
    } catch {
      // Exit code 0: another daemon won the start race; keep waiting for it.
      if (child.exitCode) break;
    }
  }
  // Say why, so an agent sees "EACCES ... daemon.lock" or "no Chrome" at once.
  let last = "";
  try {
    last =
      readFileSync(logFile, "utf8").trim().split("\n").at(-1)?.slice(0, 300) ??
      "";
  } catch {
    // No log to quote.
  }
  throw Object.assign(
    new Error(
      `ego lite daemon did not start; see ${logFile}${last ? ` (last line: ${last})` : ""}`,
    ),
    { error_code: "EGO_BROWSER_UNAVAILABLE" },
  );
}

async function stopDaemon() {
  let control;
  try {
    control = await connectRunningDaemon();
  } catch {
    process.stdout.write("ego lite daemon is not running\n");
    return 0;
  }
  await control.call("shutdown").catch(() => {});
  control.close();
  process.stdout.write("ego lite daemon stopped\n");
  return 0;
}

async function printStatus() {
  const control = await runningDaemon();
  if (!control) return 1;
  const status = await control.call("status");
  const { taskSpaces } = await control.call("listTaskSpaces");
  control.close();
  const { usage, limits } = status;
  const of = (value, limit) => (limit > 0 ? `${value}/${limit}` : `${value}`);
  process.stdout.write(
    [
      `ego lite ${status.version}`,
      `browser: ${status.browser} (${status.display}, DevTools ${status.devtools})`,
      `agent task spaces: ${of(usage.agentTaskSpaces, limits.maxTaskSpaces)}`,
      `pages: ${of(usage.pages, limits.maxTotalPages)} (at most ${limits.maxPagesPerSpace || "any"} per space)`,
      `memory: ${usage.memoryMb ?? "?"} MB${limits.maxRssMb > 0 ? ` of ${limits.maxRssMb} MB` : ""}`,
      `browsers: ${of(usage.browsers ?? 1, limits.maxBrowsers ?? 0)} (${(status.browsers ?? ["Default"]).join(", ")})`,
      `viewer: ${status.viewer ? `127.0.0.1:${status.viewer.port}, ${status.viewer.connections} connected` : "off"}`,
      `task spaces: ${taskSpaces.length}`,
      "",
    ].join("\n"),
  );
  for (const space of taskSpaces) {
    process.stdout.write(
      `  ${space.id}  ${space.name}  (${space.ownership})\n`,
    );
  }
  return 0;
}

try {
  const code = await main(process.argv.slice(2));
  if (code !== null) {
    process.exitCode = code;
    // Leave no open handles behind a finished script, after output drains.
    process.stdout.write("", () =>
      process.stderr.write("", () => process.exit(code)),
    );
  }
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`);
  process.exit(1);
}
