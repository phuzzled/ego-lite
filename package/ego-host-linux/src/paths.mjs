import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_VERSION = "0.1.1-linux";

const HOME = homedir();

/** Directory that holds bin/, src/ and the bundled sdk/ of this host. */
export const HOST_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function configDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(HOME, ".config"), "ego-lite");
}

export function dataDir(env = process.env) {
  return join(env.XDG_DATA_HOME || join(HOME, ".local", "share"), "ego-lite");
}

export function stateDir(env = process.env) {
  return join(env.XDG_STATE_HOME || join(HOME, ".local", "state"), "ego-lite");
}

/** Unix socket of the daemon. Kept under XDG_RUNTIME_DIR when available. */
export function controlSocketPath(env = process.env) {
  if (env.EGO_LITE_SOCKET) return env.EGO_LITE_SOCKET;
  const base = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "ego-lite")
    : stateDir(env);
  return join(base, "control.sock");
}

export function profileDir(env = process.env) {
  return env.EGO_LITE_PROFILE_DIR || join(dataDir(env), "profile");
}

export function spacesFile(env = process.env) {
  return join(stateDir(env), "spaces.json");
}

/**
 * Lock and address of the running daemon. They sit with the profile's state,
 * not with the socket: shells with different XDG_RUNTIME_DIR values compute
 * different socket paths but share one browser profile.
 */
export function daemonLockFile(env = process.env) {
  return join(stateDir(env), "daemon.lock");
}

export function daemonInfoFile(env = process.env) {
  return join(stateDir(env), "daemon.json");
}

export function daemonLogFile(env = process.env) {
  return join(stateDir(env), "daemon.log");
}

/** Debug SDK override, the Linux counterpart of the macOS Citro Labs path. */
export function debugSdkPath(env = process.env) {
  return join(configDir(env), "debug", "index.js");
}

export function bundledSdkPath() {
  return join(HOST_ROOT, "sdk", "index.js");
}
