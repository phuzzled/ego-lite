/** Find, launch and connect to the Chromium build used by ego lite on Linux. */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { streamTransport } from "./cdp-connection.mjs";
import { dataDir, profileDir } from "./paths.mjs";

const SYSTEM_BROWSERS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];

/**
 * Browser binary in priority order: env, bundled Chrome for Testing, system,
 * then Playwright's Chromium (the arm64 fallback; Chrome for Testing has no
 * Linux arm64 build).
 */
export function findBrowser(env = process.env, exists = existsSync) {
  if (env.EGO_LITE_CHROME) return env.EGO_LITE_CHROME;
  const bundled = join(dataDir(env), "chrome", "chrome-linux64", "chrome");
  if (exists(bundled)) return bundled;
  for (const name of SYSTEM_BROWSERS) {
    const path = which(name);
    // Snap Chromium cannot use our --user-data-dir; skip it.
    if (path && !path.startsWith("/snap/")) return path;
  }
  const playwright = playwrightChromium(env);
  if (playwright) return playwright;
  throw new Error(
    "No Chromium browser found. Run the ego lite installer, install google-chrome, or set EGO_LITE_CHROME.",
  );
}

/** Newest chromium-<rev> in Playwright's browser cache, or null. */
export function playwrightChromium(
  env = process.env,
  list = (dir) => readdirSync(dir),
  exists = existsSync,
) {
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH ||
    join(env.HOME || homedir(), ".cache", "ms-playwright");
  let entries;
  try {
    entries = list(cache);
  } catch {
    return null;
  }
  const builds = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [name] of builds) {
    for (const dir of [
      "chrome-linux",
      "chrome-linux64",
      "chrome-linux-arm64",
    ]) {
      const path = join(cache, name, dir, "chrome");
      if (exists(path)) return path;
    }
  }
  return null;
}

function which(name) {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function wantsHeadless(env = process.env) {
  if (env.EGO_LITE_HEADLESS === "1") return true;
  if (env.EGO_LITE_HEADLESS === "0") return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * How the daemon reaches DevTools. The default pipe has no listener at all;
 * "port" opens 127.0.0.1:<random> as before, which any local user can reach,
 * so it is only for debugging.
 */
export function devtoolsMode(env = process.env) {
  const mode = env.EGO_LITE_DEVTOOLS || "pipe";
  if (mode !== "pipe" && mode !== "port") {
    throw new Error(`EGO_LITE_DEVTOOLS must be pipe or port, not ${mode}`);
  }
  return mode;
}

export function browserArgs(env = process.env) {
  const devtools =
    devtoolsMode(env) === "port"
      ? ["--remote-debugging-port=0", "--remote-allow-origins=http://127.0.0.1"]
      : ["--remote-debugging-pipe"];
  const args = [
    ...devtools,
    `--user-data-dir=${profileDir(env)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--disable-features=Translate",
  ];
  // Without a desktop keyring, Chromium blocks the first cookie access for
  // about 25 seconds waiting on D-Bus. Servers use the basic store instead.
  const noKeyring = wantsHeadless(env) || env.EGO_LITE_DISPLAY === "virtual";
  const passwordStore =
    env.EGO_LITE_PASSWORD_STORE || (noKeyring ? "basic" : "");
  if (passwordStore) args.push(`--password-store=${passwordStore}`);
  if (wantsHeadless(env)) args.push("--headless=new");
  if (env.EGO_LITE_CHROME_ARGS) {
    args.push(...splitArgs(env.EGO_LITE_CHROME_ARGS));
  }
  args.push("about:blank");
  return args;
}

/**
 * Split a flag string on whitespace, like a shell: single or double quotes
 * keep a value with spaces together, as in --flag="a b".
 */
export function splitArgs(text) {
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in EGO_LITE_CHROME_ARGS`);
  if (started) args.push(current);
  return args;
}

/**
 * Start the browser and wait until DevTools answers.
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, executable: string, transport?: object, wsUrl?: string }>}
 *   `transport` in pipe mode (the default), `wsUrl` in port mode.
 */
export async function launchBrowser(env = process.env, timeoutMs = 30_000) {
  const executable = findBrowser(env);
  const userDataDir = profileDir(env);
  const mode = devtoolsMode(env);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const portFile = join(userDataDir, "DevToolsActivePort");
  await stopOrphanBrowser(userDataDir);
  rmSync(portFile, { force: true });

  // Chrome reads commands from fd 3 and writes replies to fd 4.
  const child = spawn(executable, browserArgs(env), {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    detached: false,
    env,
  });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });
  const exitError = () => {
    if (stderrTail.includes("ProcessSingleton")) {
      const owner = profileLockPid(userDataDir);
      return new Error(
        `Another browser${owner ? ` (process ${owner})` : ""} is using the ego lite profile ${userDataDir}. Stop that process and try again.`,
      );
    }
    return new Error(
      `Browser exited during start (code ${child.exitCode}): ${stderrTail}`,
    );
  };

  if (mode === "pipe") {
    const transport = streamTransport(child.stdio[4], child.stdio[3]);
    try {
      await probePipe(transport, child, timeoutMs);
    } catch (error) {
      if (child.exitCode !== null) throw exitError();
      child.kill("SIGKILL");
      throw new Error(`${error.message}: ${stderrTail}`);
    }
    return { child, transport, executable };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw exitError();
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
      if (port && path) {
        return { child, wsUrl: `ws://127.0.0.1:${port}${path}`, executable };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`Browser did not open its DevTools port: ${stderrTail}`);
}

/**
 * Ask the pipe for the browser version with id 0, which the daemon's own ids
 * (from 1) never use. Resolves on the reply.
 */
export function probePipe(transport, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const done = (error) => {
      clearTimeout(timer);
      clearInterval(poll);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => done(new Error("Browser did not answer on the DevTools pipe")),
      timeoutMs,
    );
    const poll = setInterval(() => {
      if (child.exitCode !== null) done(new Error("Browser exited"));
    }, 100);
    unsubscribe = transport.onMessage((text) => {
      if (/^\{"id":0[,}]/.test(text)) done();
    });
    transport.send(JSON.stringify({ id: 0, method: "Browser.getVersion" }));
  });
}

/** Pid in the profile's SingletonLock link ("<hostname>-<pid>"), or null. */
export function profileLockPid(userDataDir, readLink = readlinkSync) {
  try {
    const match = /-(\d+)$/.exec(readLink(join(userDataDir, "SingletonLock")));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * The browser a crashed daemon left running, or null. Only a browser this
 * host started (DevTools pipe or port 0, this profile) counts; the caller
 * holds the daemon lock, so no live daemon owns it.
 */
export function orphanBrowserPid(
  userDataDir,
  readLink = readlinkSync,
  readCmdline = (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8"),
) {
  const pid = profileLockPid(userDataDir, readLink);
  if (!pid) return null;
  let command;
  try {
    // Chrome rewrites its title, so arguments may be joined by spaces
    // rather than NUL bytes.
    command = ` ${readCmdline(pid).replaceAll("\0", " ")} `;
  } catch {
    return null;
  }
  const ours =
    command.includes(` --user-data-dir=${userDataDir} `) &&
    (command.includes(" --remote-debugging-pipe ") ||
      command.includes(" --remote-debugging-port=0 "));
  return ours ? pid : null;
}

async function stopOrphanBrowser(userDataDir, timeoutMs = 5_000) {
  const pid = orphanBrowserPid(userDataDir);
  if (!pid) return;
  process.stderr.write(
    `[ego-lite] stopping browser ${pid} left running by an earlier daemon\n`,
  );
  const signal = (name) => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  };
  if (!signal("SIGTERM")) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!signal(0)) return;
  }
  signal("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
