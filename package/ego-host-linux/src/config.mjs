/**
 * Daemon settings from ~/.config/ego-lite/config.json. Every key is optional;
 * a limit of 0 turns that limit off.
 *
 *   { "maxTaskSpaces": 8, "maxPagesPerSpace": 6, "maxTotalPages": 24,
 *     "maxRssMb": 3072, "defaultTtlMs": 86400000 }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configDir } from "./paths.mjs";

export const DEFAULT_CONFIG = Object.freeze({
  // Agent-owned task spaces open at once.
  maxTaskSpaces: 8,
  maxPagesPerSpace: 6,
  maxTotalPages: 24,
  // Memory of the whole browser (all its processes); new pages are refused above it.
  maxRssMb: 3072,
  // Idle time after which `gc` closes an agent space.
  defaultTtlMs: 24 * 60 * 60_000,
  // Idle time after which a hand-off nobody can see returns to the agent.
  handOffTtlMs: 60 * 60_000,
  gcIntervalMs: 10 * 60_000,
  viewerPort: 6080,
  viewerTimeoutMs: 30 * 60_000,
});

/** Longest TTL a task space may ask for: 30 days. */
export const MAX_TTL_MS = 30 * 24 * 60 * 60_000;

export function configFile(env = process.env) {
  return join(configDir(env), "config.json");
}

/**
 * Read and check the config file. Bad values fall back to the default with a
 * warning; a missing file is not an error.
 * @returns {{ config: typeof DEFAULT_CONFIG, warnings: string[] }}
 */
export function loadConfig(
  env = process.env,
  read = (path) => readFileSync(path, "utf8"),
) {
  const file = configFile(env);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(read(file));
  } catch (error) {
    if (error.code !== "ENOENT") {
      warnings.push(`ignoring ${file}: ${error.message}`);
    }
    raw = {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`ignoring ${file}: not a JSON object`);
    raw = {};
  }
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULT_CONFIG)) {
      warnings.push(`unknown setting ${key} in ${file}`);
      continue;
    }
    const valid =
      Number.isSafeInteger(value) &&
      value >= 0 &&
      (key !== "viewerPort" || (value >= 1024 && value <= 65535)) &&
      (!key.endsWith("Ms") || key === "defaultTtlMs" || value > 0) &&
      (key !== "defaultTtlMs" || value <= MAX_TTL_MS);
    if (!valid) {
      warnings.push(
        `invalid ${key} in ${file}: ${JSON.stringify(value)}; using ${DEFAULT_CONFIG[key]}`,
      );
      continue;
    }
    config[key] = value;
  }
  return { config, warnings };
}
