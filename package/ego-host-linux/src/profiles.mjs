/**
 * Browser profiles on Linux. A profile is a cookie jar and a login state.
 *
 * - `Default`: the ego lite profile (`EGO_LITE_PROFILE_DIR`), in the browser
 *   the daemon starts with.
 * - `ephemeral`: a throwaway, in-memory browser context in the Default
 *   browser (`Target.createBrowserContext`). Each task space gets its own;
 *   it is deleted when the space closes or finishes.
 * - named profiles (`ego-browser profiles create work`): a persistent
 *   `--user-data-dir` under ~/.local/share/ego-lite/profiles/<id>, run by its
 *   own browser process, started on demand.
 *
 * The list of named profiles is ~/.local/share/ego-lite/profiles.json (0600).
 * It is read on every call, so the CLI may change it while the daemon runs.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { egoError } from "./errors.mjs";
import { dataDir, profileDir, writeAtomic } from "./paths.mjs";

export const DEFAULT_PROFILE_ID = "Default";
export const EPHEMERAL_PROFILE_ID = "ephemeral";

/** Lower-case letters, digits, "-" and "_"; it is also a folder name. */
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(["default", EPHEMERAL_PROFILE_ID]);
const MAX_NAME = 80;

export function profilesFile(env = process.env) {
  return join(dataDir(env), "profiles.json");
}

export function namedProfilesDir(env = process.env) {
  return join(dataDir(env), "profiles");
}

/** Null when `id` may name a new profile, else the reason it may not. */
export function profileIdProblem(id) {
  if (typeof id !== "string" || !PROFILE_ID.test(id)) {
    return "a profile id is 1-32 lower-case letters, digits, - or _, starting with a letter or digit";
  }
  if (RESERVED.has(id)) return `${id} is a built-in profile`;
  return null;
}

export class ProfileStore {
  #env;
  #read;
  #write;
  #now;

  constructor({
    env = process.env,
    read = (path) => readFileSync(path, "utf8"),
    write = writeAtomic,
    now = Date.now,
  } = {}) {
    this.#env = env;
    this.#read = read;
    this.#write = write;
    this.#now = now;
  }

  /** Named profiles, oldest first. A missing or broken file is no profiles. */
  named() {
    let saved;
    try {
      saved = JSON.parse(this.#read(profilesFile(this.#env)));
    } catch {
      return [];
    }
    if (!Array.isArray(saved?.profiles)) return [];
    return saved.profiles.filter(
      (profile) => profileIdProblem(profile?.id) === null,
    );
  }

  /**
   * The `ego.listProfiles()` result: Default first (it is the default), then
   * named profiles, then `ephemeral` (marked `ephemeral: true`).
   */
  list() {
    return {
      profiles: [
        { id: DEFAULT_PROFILE_ID, name: "Default", isDefault: true },
        ...this.named().map(({ id, name }) => ({
          id,
          name,
          isDefault: false,
        })),
        {
          id: EPHEMERAL_PROFILE_ID,
          name: "Ephemeral (throwaway)",
          isDefault: false,
          ephemeral: true,
        },
      ],
    };
  }

  /**
   * The profile a createTaskSpace profileId selects, or null. Omitted, "",
   * "default" and "Default" select the default profile.
   * @returns {{ id: string, name: string, kind: "default" | "ephemeral" | "named" } | null}
   */
  resolve(profileId) {
    if (
      profileId === undefined ||
      profileId === null ||
      profileId === "" ||
      profileId === "default" ||
      profileId === DEFAULT_PROFILE_ID
    ) {
      return { id: DEFAULT_PROFILE_ID, name: "Default", kind: "default" };
    }
    if (profileId === EPHEMERAL_PROFILE_ID) {
      return {
        id: EPHEMERAL_PROFILE_ID,
        name: "Ephemeral (throwaway)",
        kind: "ephemeral",
      };
    }
    const profile = this.named().find((each) => each.id === profileId);
    return profile
      ? { id: profile.id, name: profile.name, kind: "named" }
      : null;
  }

  /** Browser user-data-dir of a persistent profile. */
  userDataDir(id) {
    if (id === DEFAULT_PROFILE_ID) return profileDir(this.#env);
    if (profileIdProblem(id)) throw new Error(`Invalid profile id: ${id}`);
    return join(namedProfilesDir(this.#env), id);
  }

  create(id, name = id) {
    const problem = profileIdProblem(id);
    if (problem) return egoError(problem, "EGO_INVALID_ARGUMENT");
    if (typeof name !== "string" || name.trim() === "") name = id;
    name = name.replace(/[\u0000-\u001f]/g, " ").slice(0, MAX_NAME);
    const profiles = this.named();
    if (profiles.some((profile) => profile.id === id)) {
      return egoError(`Profile already exists: ${id}`, "EGO_PROFILE_EXISTS");
    }
    const profile = { id, name, createdAt: this.#now() };
    mkdirSync(this.userDataDir(id), { recursive: true, mode: 0o700 });
    this.#save([...profiles, profile]);
    return { id, name, isDefault: false };
  }

  /** Forget a named profile and delete its browser data. */
  remove(id) {
    const profiles = this.named();
    if (!profiles.some((profile) => profile.id === id)) {
      return egoError(`Profile not found: ${id}`, "EGO_PROFILE_NOT_FOUND");
    }
    this.#save(profiles.filter((profile) => profile.id !== id));
    rmSync(this.userDataDir(id), { recursive: true, force: true });
    return `profile ${id} removed`;
  }

  #save(profiles) {
    this.#write(
      profilesFile(this.#env),
      `${JSON.stringify({ profiles }, null, 2)}\n`,
    );
  }
}

/** Write a 0600 file through a rename, in a 0700 folder. */
export { writeAtomic };
