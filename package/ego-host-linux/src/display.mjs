/**
 * A virtual X display (Xvfb) for a headful browser on a server. The display
 * needs a random cookie (MIT-MAGIC-COOKIE-1) that only this user can read,
 * and does not listen on TCP, so other local users cannot see or drive it.
 */
import { spawn as spawnProcess, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAMILY_WILD = 0xffff;

/** Path of a command on PATH, or null. */
export function findCommand(name, env = process.env) {
  try {
    return (
      execFileSync("sh", ["-c", 'command -v "$1"', "sh", name], {
        encoding: "utf8",
        env,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * One Xauthority entry that matches any host for `display`:
 * family, address, display number, auth name, auth data, each length-prefixed.
 */
export function xauthEntry(display, cookie) {
  const field = (buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(buffer.length);
    return Buffer.concat([length, buffer]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.from(String(display))),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(cookie),
  ]);
}

/** A display number with no X server or stale lock. */
export function freeDisplay(start = 90, end = 190, exists = existsSync) {
  for (let number = start; number < end; number += 1) {
    if (
      !exists(`/tmp/.X11-unix/X${number}`) &&
      !exists(`/tmp/.X${number}-lock`)
    ) {
      return number;
    }
  }
  return null;
}

/**
 * Start Xvfb and wait for its socket.
 * @returns {Promise<{ display: string, xauthority: string, process: import("node:child_process").ChildProcess, stop: () => void }>}
 */
export async function startVirtualDisplay({
  runDir,
  width = 1440,
  height = 900,
  xvfb = findCommand("Xvfb"),
  spawn = spawnProcess,
  timeoutMs = 10_000,
} = {}) {
  if (!xvfb) {
    throw Object.assign(
      new Error(
        "Xvfb is not installed. Install it with: sudo apt-get install -y xvfb",
      ),
      { error_code: "EGO_DISPLAY_UNAVAILABLE" },
    );
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const xauthority = join(runDir, "Xauthority");
  let lastError = "no free display number";
  let start = 90;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = freeDisplay(start);
    if (number === null) break;
    start = number + 1;
    writeFileSync(xauthority, xauthEntry(number, randomBytes(16)), {
      mode: 0o600,
    });
    const child = spawn(
      xvfb,
      [
        `:${number}`,
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-nolisten",
        "tcp",
        "-auth",
        xauthority,
        "-noreset",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const ready = await waitFor(
      () => existsSync(`/tmp/.X11-unix/X${number}`),
      () => child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
    );
    if (ready) {
      return {
        display: `:${number}`,
        xauthority,
        process: child,
        stop() {
          if (child.exitCode === null) child.kill("SIGTERM");
          rmSync(xauthority, { force: true });
        },
      };
    }
    if (child.exitCode === null) child.kill("SIGKILL");
    lastError = stderr.trim() || `Xvfb :${number} did not start`;
  }
  rmSync(xauthority, { force: true });
  throw Object.assign(new Error(`Cannot start Xvfb: ${lastError}`), {
    error_code: "EGO_DISPLAY_UNAVAILABLE",
  });
}

async function waitFor(ready, failed, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return true;
    if (failed()) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
