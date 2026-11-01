/** Find, launch and connect to the Chromium build used by ego lite on Linux. */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { dataDir, profileDir } from "./paths.mjs";

const SYSTEM_BROWSERS = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];

/** Browser binary in priority order: env, bundled Chrome for Testing, system. */
export function findBrowser(env = process.env, exists = existsSync) {
  if (env.EGO_LITE_CHROME) return env.EGO_LITE_CHROME;
  const bundled = join(dataDir(env), "chrome", "chrome-linux64", "chrome");
  if (exists(bundled)) return bundled;
  for (const name of SYSTEM_BROWSERS) {
    const path = which(name);
    // Snap Chromium cannot use our --user-data-dir; skip it.
    if (path && !path.startsWith("/snap/")) return path;
  }
  throw new Error(
    "No Chromium browser found. Run the ego lite installer, install google-chrome, or set EGO_LITE_CHROME.",
  );
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

export function browserArgs(env = process.env) {
  const args = [
    "--remote-debugging-port=0",
    "--remote-allow-origins=http://127.0.0.1",
    `--user-data-dir=${profileDir(env)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "--disable-features=Translate",
  ];
  // Without a desktop keyring, Chromium blocks the first cookie access for
  // about 25 seconds waiting on D-Bus. Servers use the basic store instead.
  const passwordStore =
    env.EGO_LITE_PASSWORD_STORE || (wantsHeadless(env) ? "basic" : "");
  if (passwordStore) args.push(`--password-store=${passwordStore}`);
  if (wantsHeadless(env)) args.push("--headless=new");
  if (env.EGO_LITE_CHROME_ARGS) {
    args.push(...env.EGO_LITE_CHROME_ARGS.split(/\s+/).filter(Boolean));
  }
  args.push("about:blank");
  return args;
}

/**
 * Start the browser and wait for its DevTools endpoint.
 * @returns {Promise<{ child: import("node:child_process").ChildProcess, wsUrl: string }>}
 */
export async function launchBrowser(env = process.env, timeoutMs = 30_000) {
  const executable = findBrowser(env);
  const userDataDir = profileDir(env);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const portFile = join(userDataDir, "DevToolsActivePort");
  await stopOrphanBrowser(userDataDir);
  rmSync(portFile, { force: true });

  const child = spawn(executable, browserArgs(env), {
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4_000);
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      if (stderrTail.includes("ProcessSingleton")) {
        const owner = profileLockPid(userDataDir);
        throw new Error(
          `Another browser${owner ? ` (process ${owner})` : ""} is using the ego lite profile ${userDataDir}. Stop that process and try again.`,
        );
      }
      throw new Error(
        `Browser exited during start (code ${child.exitCode}): ${stderrTail}`,
      );
    }
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
 * host started (DevTools on port 0, this profile) counts; the caller holds
 * the daemon lock, so no live daemon owns it.
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
    command.includes(" --remote-debugging-port=0 ");
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
