/** Find, launch and connect to the Chromium build used by ego lite on Linux. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
        throw new Error(
          `Another browser is using the ego lite profile ${userDataDir}. Stop it (for example: pkill -f '${userDataDir}') and try again.`,
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
