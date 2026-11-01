import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentWorkspace, packageRoot } from "../dist/src/env.js";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SKILL = resolve(PACKAGE_DIR, "..", "..", "skills", "ego-browser");

function withoutWorkspaceEnv(fn) {
  const previous = process.env.EGO_BROWSER_AGENT_WORKSPACE;
  delete process.env.EGO_BROWSER_AGENT_WORKSPACE;
  try {
    return fn();
  } finally {
    if (previous !== undefined) {
      process.env.EGO_BROWSER_AGENT_WORKSPACE = previous;
    }
  }
}

test("packageRoot finds package/ego-browser from dist/src and dist/out", () => {
  assert.equal(packageRoot(join(PACKAGE_DIR, "dist", "src")), PACKAGE_DIR);
  assert.equal(packageRoot(join(PACKAGE_DIR, "dist", "out")), PACKAGE_DIR);
  assert.equal(packageRoot(join(PACKAGE_DIR, "src")), PACKAGE_DIR);
});

test("agentWorkspace from the unbundled dist/src is the repo's skills/ego-browser", () => {
  withoutWorkspaceEnv(() => {
    const workspace = agentWorkspace(join(PACKAGE_DIR, "dist", "src"));
    assert.equal(workspace, REPO_SKILL);
    assert(existsSync(join(workspace, "SKILL.md")), workspace);
    assert(!workspace.includes(join("package", "skills")));
  });
});

test("agentWorkspace prefers the skill bundled next to dist/out", () => {
  withoutWorkspaceEnv(() => {
    const out = join(PACKAGE_DIR, "dist", "out");
    assert.equal(agentWorkspace(out), join(out, "agent-skills", "ego-browser"));
  });
});
