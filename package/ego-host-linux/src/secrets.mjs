/**
 * Origin-bound secrets (P17).
 *
 * The user stores a secret once (`ego-browser secret set github-password
 * --origin https://github.com`), and an agent fills it by name with
 * `ego.fillSecret(name)`. The value never enters the script, its output, the
 * CLI process, round logs or snapshots:
 * - it lives in ~/.local/share/ego-lite/secrets.json, mode 0600 in a 0700
 *   folder (the OS keyring is not used: servers rarely have one unlocked);
 * - only the daemon reads it, and the daemon types it into the focused field
 *   with Input.insertText, after checking that the field's document is on
 *   one of the secret's origins;
 * - snapshots of a task space that had a secret filled are passed through
 *   `redactSecrets` by the daemon.
 *
 * Limit: the page itself holds the value once it is typed. A script that
 * reads the field with evaluate() sees it. fillSecret stops accidental
 * exposure; it does not make a hostile script safe.
 */
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { egoError } from "./errors.mjs";
import { dataDir } from "./paths.mjs";
import { writeAtomic } from "./profiles.mjs";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MIN_SECRET_LENGTH = 4;
const MAX_SECRET_LENGTH = 4_096;

export function secretsFile(env = process.env) {
  return join(dataDir(env), "secrets.json");
}

/** "https://GitHub.com/login" -> "https://github.com". Throws on anything else. */
export function normalizeOrigin(text) {
  let url;
  try {
    url = new URL(String(text));
  } catch {
    throw new Error(`not an origin: ${text}`);
  }
  if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
    throw new Error(
      `${text}: a secret may only be bound to an https origin (or http on localhost)`,
    );
  }
  return url.origin;
}

function isLoopbackHttp(url) {
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

export function secretNameProblem(name) {
  return typeof name === "string" && NAME.test(name)
    ? null
    : "a secret name is 1-64 letters, digits, '.', '_' or '-'";
}

export class SecretStore {
  #file;
  #log;

  constructor({ env = process.env, log = () => {} } = {}) {
    this.#file = secretsFile(env);
    this.#log = log;
  }

  get file() {
    return this.#file;
  }

  #load() {
    let text;
    try {
      // A file other users can read is tightened, not trusted as is.
      const { mode } = statSync(this.#file);
      if ((mode & 0o077) !== 0) {
        chmodSync(this.#file, 0o600);
        this.#log(`tightened ${this.#file} to mode 0600`);
      }
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    const data = JSON.parse(text);
    return data && typeof data.secrets === "object" ? data.secrets : {};
  }

  #save(secrets) {
    writeAtomic(
      this.#file,
      `${JSON.stringify({ version: 1, secrets }, null, 2)}\n`,
    );
  }

  /** Names and origins only, never values. */
  list() {
    return Object.entries(this.#load()).map(([name, secret]) => ({
      name,
      origins: secret.origins,
      createdAt: secret.createdAt,
    }));
  }

  set(name, value, origins, now = Date.now) {
    const problem = secretNameProblem(name);
    if (problem) throw new Error(problem);
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `a secret must be at least ${MIN_SECRET_LENGTH} characters`,
      );
    }
    if (value.length > MAX_SECRET_LENGTH || /[\r\n]/.test(value)) {
      throw new Error(
        `a secret is one line of at most ${MAX_SECRET_LENGTH} characters`,
      );
    }
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new Error("a secret needs at least one --origin");
    }
    const bound = [...new Set(origins.map(normalizeOrigin))];
    const secrets = this.#load();
    secrets[name] = { value, origins: bound, createdAt: now() };
    this.#save(secrets);
    return { name, origins: bound };
  }

  remove(name) {
    const secrets = this.#load();
    if (!Object.hasOwn(secrets, name)) return false;
    delete secrets[name];
    this.#save(secrets);
    return true;
  }

  /** The secret with its value. Daemon only. */
  get(name) {
    const secret = this.#load()[name];
    return secret ? { name, ...secret } : null;
  }
}

/**
 * Replace every filled secret's value in `text` (also in its JSON-escaped
 * form) with [secret:<name>].
 * @param {string} text
 * @param {{ name: string, value: string }[]} secrets
 */
export function redactSecrets(text, secrets) {
  let out = String(text);
  // Longest first, so a secret that contains another is replaced whole.
  const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of sorted) {
    if (typeof value !== "string" || value.length === 0) continue;
    // A snapshot line JSON-quotes a field value, and the snapshot itself is
    // sent as JSON: look for the value escaped once and twice too.
    const once = JSON.stringify(value).slice(1, -1);
    const forms = new Set([value, once, JSON.stringify(once).slice(1, -1)]);
    for (const form of forms) out = out.split(form).join(`[secret:${name}]`);
  }
  return out;
}

/**
 * Runs in the page: the focused element, through same-origin frames. Reports
 * the origin of the document that holds it and whether it takes text.
 */
const FOCUS_PROBE = `(() => {
  let doc = document;
  let el = doc.activeElement;
  while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    let inner;
    try { inner = el.contentDocument; } catch { inner = null; }
    if (!inner) return { origin: doc.defaultView.location.origin, editable: false, crossOriginFrame: true };
    doc = inner;
    el = doc.activeElement;
  }
  const textInput = el && el.tagName === "INPUT" &&
    !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes((el.type || "text").toLowerCase());
  const editable = Boolean(el && !el.disabled && !el.readOnly &&
    (textInput || el.tagName === "TEXTAREA" || el.isContentEditable));
  if (editable && SELECT_ALL && typeof el.select === "function") el.select();
  return { origin: doc.defaultView.location.origin, editable, crossOriginFrame: false };
})()`;

/**
 * Type a secret into the focused field of a page, after checking that the
 * field's document is on one of the secret's origins. The caller focuses the
 * field first (click or focus()). With `clear` the field's text is selected,
 * so the secret replaces it.
 * @param {object} cdp  CdpConnection of the browser that holds the page
 */
export async function fillSecretInTarget(
  cdp,
  targetId,
  secret,
  { clear = true } = {},
) {
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  try {
    const evaluate = async (selectAll) => {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        {
          expression: FOCUS_PROBE.replace("SELECT_ALL", String(selectAll)),
          returnByValue: true,
        },
        sessionId,
      );
      if (exceptionDetails || !result?.value) {
        throw new Error("cannot read the focused field of the page");
      }
      return result.value;
    };
    const probe = await evaluate(false);
    if (probe.crossOriginFrame) {
      return egoError(
        "The focused field is inside a frame from another origin; fillSecret cannot check where it would type. Focus a field in the page itself.",
        "EGO_SECRET_NO_FIELD",
      );
    }
    if (!probe.editable) {
      return egoError(
        "No text field has focus. Click or focus the field first, then call fillSecret.",
        "EGO_SECRET_NO_FIELD",
      );
    }
    if (!secret.origins.includes(probe.origin)) {
      return egoError(
        `Secret ${secret.name} is not allowed on ${probe.origin}; it is bound to ${secret.origins.join(", ")}. Change that with: ego-browser secret set ${secret.name} --origin <origin>`,
        "EGO_SECRET_ORIGIN_MISMATCH",
      );
    }
    if (clear) {
      // Check again: the page may have moved on since the first look.
      const again = await evaluate(true);
      if (!again.editable || again.origin !== probe.origin) {
        return egoError(
          "The focused field changed while filling; focus it again and retry.",
          "EGO_SECRET_NO_FIELD",
        );
      }
    }
    await cdp.send("Input.insertText", { text: secret.value }, sessionId);
    return { filled: true, secret: secret.name, origin: probe.origin };
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}
