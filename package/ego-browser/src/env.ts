import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile as loadNodeEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The package root (package/ego-browser) of this build: the nearest parent,
 * at most three levels up, whose package.json is this package. The code runs
 * from dist/out (the bundle) and from dist/src (per-file build), so a fixed
 * ".." is wrong for one of them. Falls back to the parent of this file.
 */
export function packageRoot(fromDir = SRC_DIR): string {
  let dir = fromDir;
  for (let level = 0; level <= 3; level += 1) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8"))?.name;
        if (name === "ego-browser-v2" || name === "ego-browser") return dir;
      } catch {
        // Not ours; keep looking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(fromDir, "..");
}

export function agentWorkspace(fromDir = SRC_DIR) {
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE);
  }

  const bundledSkill = resolve(fromDir, "agent-skills", "ego-browser");
  if (existsSync(bundledSkill)) {
    return bundledSkill;
  }

  // The repo's skills/ego-browser, two levels above package/ego-browser.
  return resolve(packageRoot(fromDir), "..", "..", "skills", "ego-browser");
}

function resolvePath(path) {
  if (path.startsWith("~")) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || ".",
      path.slice(1),
    );
  }
  return resolve(path);
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return;
  }
  loadNodeEnvFile(path);
}

export function loadEnv() {
  loadEnvFile(resolve(packageRoot(), ".env"));
  loadEnvFile(resolve(agentWorkspace(), ".env"));
}
