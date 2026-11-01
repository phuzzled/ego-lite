#!/usr/bin/env node
/**
 * ego-browser for Linux.
 *
 *   ego-browser nodejs [--sdk-path <index.js>] [-e <code>]   run a script (stdin by default)
 *   ego-browser skill  [--sdk-path <index.js>]               print the usage guide
 *   ego-browser start | stop | status                        manage the browser daemon
 *   ego-browser spaces | close <id...> | close --all         list or close task spaces
 *   ego-browser upgrade                                      how to update ego lite
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectRunningDaemon } from "../src/control-channel.mjs";
import { createEgoBindings } from "../src/ego-bindings.mjs";
import {
  HOST_VERSION,
  bundledSdkPath,
  daemonLogFile,
  debugSdkPath,
} from "../src/paths.mjs";

const USAGE = `ego-browser ${HOST_VERSION} (Linux)

Usage:
  ego-browser nodejs [--sdk-path <index.js>] <<'EOF'
  ...script...
  EOF
  ego-browser nodejs [--sdk-path <index.js>] -e "<script>"
  ego-browser skill [--sdk-path <index.js>]
  ego-browser start | stop | status
  ego-browser spaces                 list task spaces
  ego-browser close <id> [<id>...]   close task spaces
  ego-browser close --all            close every agent-controlled task space
  ego-browser close --force <id|--all>
                                     also close spaces handed off to the user
  ego-browser upgrade
`;

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
      await connectDaemon();
      process.stdout.write("ego lite daemon is running\n");
      return 0;
    case "stop":
      return stopDaemon();
    case "status":
      return printStatus();
    case "spaces":
      return printSpaces();
    case "close":
      return closeSpaces(rest);
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

async function printSpaces() {
  let control;
  try {
    control = await connectRunningDaemon();
  } catch {
    process.stdout.write("ego lite daemon is not running\n");
    return 1;
  }
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
  process.stdout.write("id\towner\ttabs\tname\n");
  taskSpaces.forEach((space, index) => {
    const count = details[index]?.targets?.length ?? "?";
    process.stdout.write(
      `${space.id}\t${space.ownership}\t${count}\t${space.name}\n`,
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
  let control;
  try {
    control = await connectRunningDaemon();
  } catch {
    process.stdout.write("ego lite daemon is not running\n");
    return 1;
  }
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

/** Connect to the daemon, starting it in the background when needed. */
async function connectDaemon(timeoutMs = 40_000) {
  try {
    return await connectRunningDaemon();
  } catch {
    // Not running yet.
  }
  const logFile = daemonLogFile();
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "daemon"],
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
    try {
      return await connectRunningDaemon();
    } catch {
      // Exit code 0: another daemon won the start race; keep waiting for it.
      if (child.exitCode) break;
    }
  }
  throw Object.assign(
    new Error(`ego lite daemon did not start; see ${logFile}`),
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
  let control;
  try {
    control = await connectRunningDaemon();
  } catch {
    process.stdout.write("ego lite daemon is not running\n");
    return 1;
  }
  const hello = await control.call("hello");
  const { taskSpaces } = await control.call("listTaskSpaces");
  control.close();
  process.stdout.write(
    `ego lite ${hello.version}\nbrowser: ${hello.browser}\ntask spaces: ${taskSpaces.length}\n`,
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
