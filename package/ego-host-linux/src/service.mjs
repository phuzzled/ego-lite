/**
 * systemd user service for the daemon:
 *
 *   ego-browser service install [--display virtual] [--no-enable]
 *   ego-browser service uninstall | status
 *
 * The unit runs `ego-browser daemon` with Restart=on-failure, so the browser
 * comes back after a crash; task spaces survive in spaces.json.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { HOST_ROOT } from "./paths.mjs";

export const UNIT_NAME = "ego-lite.service";

/** Settings the daemon reads from its environment, copied into the unit. */
const PASSED_ENV = [
  "EGO_LITE_CHROME",
  "EGO_LITE_HEADLESS",
  "EGO_LITE_PASSWORD_STORE",
  "EGO_LITE_CHROME_ARGS",
  "EGO_LITE_PROFILE_DIR",
  "EGO_LITE_DEVTOOLS",
  "EGO_LITE_NOVNC_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

export function unitFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "systemd", "user", UNIT_NAME);
}

/** systemd quoting for one word of ExecStart or one Environment= value. */
export function systemdQuote(value) {
  const text = String(value);
  if (/[\n\r]/.test(text)) throw new Error("value may not contain a newline");
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * The unit text. `display` is "virtual" for a headful browser on Xvfb, so a
 * user can watch it with `ego-browser view`.
 */
export function unitText({
  node = process.execPath,
  bin = join(HOST_ROOT, "bin", "ego-browser.mjs"),
  env = process.env,
  display,
  memoryMaxMb,
  template = readFileSync(join(HOST_ROOT, "share", UNIT_NAME), "utf8"),
} = {}) {
  const environment = [];
  for (const key of PASSED_ENV) {
    if (env[key])
      environment.push(`Environment=${systemdQuote(`${key}=${env[key]}`)}`);
  }
  if (display === "virtual") {
    environment.push(`Environment=${systemdQuote("EGO_LITE_DISPLAY=virtual")}`);
  }
  return template
    .replace(
      "@EXEC_START@",
      `${systemdQuote(node)} ${systemdQuote(bin)} daemon`,
    )
    .replace("@ENVIRONMENT@\n", environment.map((line) => `${line}\n`).join(""))
    .replace(
      "@MEMORY_MAX@\n",
      memoryMaxMb > 0 ? `MemoryMax=${Math.round(memoryMaxMb)}M\n` : "",
    );
}

function systemctl(args, options = {}) {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/** Run a service subcommand; returns an exit code. */
export function serviceCommand(
  args,
  {
    env = process.env,
    out = process.stdout,
    err = process.stderr,
    maxRssMb = 0,
    run = systemctl,
  } = {},
) {
  const [action, ...rest] = args;
  const file = unitFile(env);
  if (action === "install") {
    let display;
    let enable = true;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--no-enable") enable = false;
      else if (rest[i] === "--display") display = rest[++i];
      else if (rest[i].startsWith("--display=")) display = rest[i].slice(10);
      else {
        err.write(`Unknown option: ${rest[i]}\n`);
        return 2;
      }
    }
    if (display !== undefined && display !== "virtual" && display !== "auto") {
      err.write("--display must be virtual or auto\n");
      return 2;
    }
    // The hard memory cap sits above the soft page limit, so the daemon
    // refuses new pages before systemd kills the browser.
    const memoryMaxMb = maxRssMb > 0 ? maxRssMb + 1024 : 0;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, unitText({ env, display, memoryMaxMb }), {
      mode: 0o644,
    });
    out.write(`Wrote ${file}\n`);
    if (!enable) {
      out.write(
        `Enable it with: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}\n`,
      );
      return 0;
    }
    try {
      run(["daemon-reload"]);
      run(["enable", "--now", UNIT_NAME]);
    } catch (error) {
      err.write(`systemctl failed: ${error.stderr || error.message}\n`);
      return 1;
    }
    out.write(
      `Enabled ${UNIT_NAME}. To keep it running after you log out: sudo loginctl enable-linger $USER\n`,
    );
    return 0;
  }
  if (action === "uninstall") {
    try {
      run(["disable", "--now", UNIT_NAME]);
    } catch {
      // Not enabled or no user manager; still remove the file.
    }
    const had = existsSync(file);
    rmSync(file, { force: true });
    try {
      run(["daemon-reload"]);
    } catch {
      // No user manager.
    }
    out.write(had ? `Removed ${file}\n` : `No unit at ${file}\n`);
    return 0;
  }
  if (action === "status") {
    if (!existsSync(file)) {
      out.write(`not installed (${file})\n`);
      return 1;
    }
    try {
      out.write(run(["status", "--no-pager", UNIT_NAME]));
      return 0;
    } catch (error) {
      out.write(error.stdout || "");
      return error.status || 1;
    }
  }
  err.write(
    "Usage: ego-browser service install [--display virtual] [--no-enable] | uninstall | status\n",
  );
  return 2;
}
