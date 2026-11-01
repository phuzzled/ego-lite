import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ProfileStore, profileIdProblem, profilesFile } from "./profiles.mjs";

function store() {
  const root = mkdtempSync(join(tmpdir(), "ego-lite-profiles-"));
  const env = {
    XDG_DATA_HOME: join(root, "data"),
    EGO_LITE_PROFILE_DIR: join(root, "profile"),
  };
  let now = 1_000;
  return { env, store: new ProfileStore({ env, now: () => (now += 1) }) };
}

describe("ProfileStore", () => {
  it("lists Default first, then named profiles, then ephemeral", () => {
    const { store: profiles } = store();
    profiles.create("work", "Work");
    profiles.create("research");
    assert.deepEqual(profiles.list().profiles, [
      { id: "Default", name: "Default", isDefault: true },
      { id: "work", name: "Work", isDefault: false },
      { id: "research", name: "research", isDefault: false },
      {
        id: "ephemeral",
        name: "Ephemeral (throwaway)",
        isDefault: false,
        ephemeral: true,
      },
    ]);
  });

  it("resolves omitted, empty and default ids to Default, as the contract says", () => {
    const { store: profiles } = store();
    for (const id of [undefined, "", "default", "Default"]) {
      assert.equal(profiles.resolve(id).kind, "default");
      assert.equal(profiles.resolve(id).id, "Default");
    }
    assert.equal(profiles.resolve("ephemeral").kind, "ephemeral");
    assert.equal(profiles.resolve("nope"), null);
    profiles.create("work");
    assert.deepEqual(profiles.resolve("work"), {
      id: "work",
      name: "work",
      kind: "named",
    });
  });

  it("gives each named profile its own 0700 user-data-dir and a 0600 list", () => {
    const { env, store: profiles } = store();
    profiles.create("work");
    const dir = profiles.userDataDir("work");
    assert.equal(dir, join(env.XDG_DATA_HOME, "ego-lite", "profiles", "work"));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(profilesFile(env)).mode & 0o777, 0o600);
    assert.equal(profiles.userDataDir("Default"), env.EGO_LITE_PROFILE_DIR);
  });

  it("refuses reserved, duplicate and unsafe ids", () => {
    const { store: profiles } = store();
    for (const id of ["default", "ephemeral", "../x", "Work", "", "a/b"]) {
      assert.equal(
        profiles.create(id).error_code,
        "EGO_INVALID_ARGUMENT",
        `id ${JSON.stringify(id)}`,
      );
    }
    profiles.create("work");
    assert.equal(profiles.create("work").error_code, "EGO_PROFILE_EXISTS");
    assert.equal(profileIdProblem("my_profile-2"), null);
    assert.throws(() => profiles.userDataDir("../etc"));
  });

  it("removes a profile and its browser data", () => {
    const { store: profiles } = store();
    profiles.create("work");
    const dir = profiles.userDataDir("work");
    assert.equal(profiles.remove("work"), "profile work removed");
    assert.equal(existsSync(dir), false);
    assert.equal(profiles.resolve("work"), null);
    assert.equal(profiles.remove("work").error_code, "EGO_PROFILE_NOT_FOUND");
  });

  it("treats a broken list file as no named profiles", () => {
    const profiles = new ProfileStore({
      env: { XDG_DATA_HOME: "/nonexistent" },
      read: () => "{not json",
    });
    assert.equal(profiles.list().profiles.length, 2);
  });
});
