#!/usr/bin/env node
/**
 * ego-browser for Linux.
 *
 *   ego-browser nodejs [--sdk-path <index.js>] [-e <code>]   run a script (stdin by default)
 *   ego-browser skill  [--sdk-path <index.js>]               print the usage guide
 *   ego-browser start | stop | status                        manage the browser daemon
 *   ego-browser upgrade                                      how to update ego lite
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ControlClient } from "../src/control-channel.mjs";
import { createEgoBindings } from "../src/ego-bindings.mjs";
import {
  HOST_VERSION,
  bundledSdkPath,
  controlSocketPath,
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
  ego-browser upgrade
`;

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
    case "upgrade":
      process.stdout.write(
        "Re-run the ego lite Linux installer to upgrade:\n  sh skills/ego-browser/scripts/install.sh\n",
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

  const control = await connectDaemon();
  const hello = await control.call("hello");
  const ego = await createEgoBindings({ control, hello });
  globalThis.ego = ego;

  let exitCode = 1;
  let module;
  try {
    // Importing the SDK installs it on globalThis (installEgoSdk).
    module = await import(pathToFileURL(sdk.path).href);
    exitCode = await module.runMain({ argv: [], stdinText: source });
  } catch (error) {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    exitCode = 1;
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

/** Connect to the daemon, starting it in the background when needed. */
async function connectDaemon(timeoutMs = 40_000) {
  const socketPath = controlSocketPath();
  try {
    return await ControlClient.connect(socketPath);
  } catch {
    // Not running yet.
  }
  const logFile = daemonLogFile();
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, "daemon"],
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
    try {
      return await ControlClient.connect(socketPath);
    } catch {
      if (child.exitCode !== null) break;
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
    control = await ControlClient.connect(controlSocketPath());
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
    control = await ControlClient.connect(controlSocketPath());
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
