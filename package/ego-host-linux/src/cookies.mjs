/**
 * Cookie and localStorage export and import for a profile (P16).
 *
 * A cookie file holds live sessions: anyone who has it can act as the user on
 * those sites. So:
 * - export only the sites the user names, to a file created 0600 that is
 *   never overwritten by accident and never printed;
 * - everything stays on this machine: nothing here opens a network
 *   connection. localStorage is read and written on a page whose requests
 *   are all answered locally (Fetch interception), so no request leaves;
 * - importing from the user's desktop Chrome or Chromium reads a copy of its
 *   cookie database, read-only. A value encrypted with a key from the OS
 *   keyring (v11) is skipped and counted unless the user asks to use the
 *   keyring; it is never guessed.
 */
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  closeSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { egoError } from "./errors.mjs";

export const COOKIE_FILE_FORMAT = "ego-lite-cookies";
export const COOKIE_FILE_VERSION = 1;

export const COOKIE_WARNING =
  "WARNING: this file holds live login sessions. Anyone who has it can use these sites as you. Keep it private (it is mode 0600), copy it only over a secure channel such as scp, and delete it once imported.";

const SITE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** "github.com, Notion.so" -> ["github.com", "notion.so"]. Throws on a bad name. */
export function parseSites(text) {
  const sites = String(text ?? "")
    .split(",")
    .map((site) => site.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  if (sites.length === 0) throw new Error("--sites needs at least one site");
  for (const site of sites) {
    if (!SITE.test(site)) throw new Error(`not a site name: ${site}`);
  }
  return [...new Set(sites)];
}

/** True when a cookie domain (".github.com" or "gist.github.com") is in one of the sites. */
export function domainInSites(domain, sites) {
  const host = String(domain ?? "")
    .toLowerCase()
    .replace(/^\./, "");
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Check an origin for localStorage: http(s), no path, inside the sites. */
export function parseOrigins(text, sites) {
  const origins = String(text ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.map((origin) => {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`not an origin: ${origin}`);
    }
    if (
      !/^https?:$/.test(url.protocol) ||
      url.origin !== origin.replace(/\/$/, "")
    ) {
      throw new Error(`not an origin (scheme://host[:port]): ${origin}`);
    }
    if (!domainInSites(url.hostname, sites)) {
      throw new Error(`${origin} is not in --sites`);
    }
    return url.origin;
  });
}

/**
 * A CDP Cookie as a Storage.setCookies CookieParam. A host-only cookie (no
 * leading dot) is set through its URL, so it stays host-only.
 */
export function toCookieParam(cookie) {
  const param = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
  };
  if (["Strict", "Lax", "None"].includes(cookie.sameSite)) {
    param.sameSite = cookie.sameSite;
  }
  if (cookie.session !== true && Number(cookie.expires) > 0) {
    param.expires = Number(cookie.expires);
  }
  if (["Low", "Medium", "High"].includes(cookie.priority)) {
    param.priority = cookie.priority;
  }
  if (cookie.partitionKey && typeof cookie.partitionKey === "object") {
    param.partitionKey = cookie.partitionKey;
  }
  const domain = String(cookie.domain ?? "");
  if (domain.startsWith(".")) {
    param.domain = domain;
  } else {
    param.url = `${param.secure ? "https" : "http"}://${domain}${param.path}`;
  }
  return param;
}

function isExpired(cookie, nowSeconds) {
  return (
    cookie.session !== true &&
    Number(cookie.expires) > 0 &&
    Number(cookie.expires) < nowSeconds
  );
}

/** The JSON text of a cookie file. */
export function buildCookieFile({
  profile,
  sites,
  cookies,
  localStorage = {},
  source = "ego-lite",
  now = Date.now,
}) {
  return `${JSON.stringify(
    {
      format: COOKIE_FILE_FORMAT,
      version: COOKIE_FILE_VERSION,
      warning: COOKIE_WARNING,
      exportedAt: new Date(now()).toISOString(),
      source,
      profile,
      sites,
      cookies,
      localStorage,
    },
    null,
    2,
  )}\n`;
}

/** Parse and check a cookie file. Throws with a plain message. */
export function readCookieFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not a cookie file (not JSON)");
  }
  if (
    data?.format !== COOKIE_FILE_FORMAT ||
    data.version !== COOKIE_FILE_VERSION
  ) {
    throw new Error(
      `not an ego lite cookie file (format ${COOKIE_FILE_FORMAT}, version ${COOKIE_FILE_VERSION})`,
    );
  }
  if (!Array.isArray(data.cookies))
    throw new Error("cookie file has no cookies list");
  for (const cookie of data.cookies) {
    if (
      !cookie ||
      typeof cookie.name !== "string" ||
      typeof cookie.value !== "string" ||
      typeof cookie.domain !== "string" ||
      cookie.domain.length === 0
    ) {
      throw new Error("cookie file has a malformed cookie");
    }
  }
  const localStorage = data.localStorage ?? {};
  if (typeof localStorage !== "object" || Array.isArray(localStorage)) {
    throw new Error("cookie file has a malformed localStorage section");
  }
  for (const [origin, items] of Object.entries(localStorage)) {
    if (
      !/^https?:\/\/[^/]+$/.test(origin) ||
      !items ||
      typeof items !== "object"
    ) {
      throw new Error(`cookie file has malformed localStorage for ${origin}`);
    }
    for (const value of Object.values(items)) {
      if (typeof value !== "string") {
        throw new Error(
          `cookie file has a non-text localStorage value for ${origin}`,
        );
      }
    }
  }
  return { ...data, localStorage };
}

/**
 * Create `path` with mode 0600 and write `text`. Refuses to replace an
 * existing file unless `force`, and never follows a symbolic link.
 */
export function writePrivateFile(path, text, { force = false } = {}) {
  let existing = null;
  try {
    existing = lstatSync(path);
  } catch {
    // New file.
  }
  if (existing) {
    if (!force) {
      throw new Error(`${path} exists; pass --force to replace it`);
    }
    if (!existing.isFile()) throw new Error(`${path} is not a regular file`);
    unlinkSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** A warning when a cookie file can be read by other users, else null. */
export function filePermissionWarning(path, stat = statSync) {
  const { mode } = stat(path);
  if ((mode & 0o077) === 0) return null;
  return `warning: ${path} can be read by other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`;
}

/**
 * Read cookies (and localStorage of `origins`) from a browser.
 * @param {object} cdp  CdpConnection on the profile's browser
 */
export async function exportProfileData(cdp, { sites, origins = [] }) {
  const { cookies } = await cdp.send("Storage.getCookies", {});
  const chosen = cookies.filter((cookie) =>
    domainInSites(cookie.domain, sites),
  );
  const localStorage = {};
  for (const origin of origins) {
    const items = await onOriginPage(cdp, origin, (evaluate) =>
      evaluate(
        "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])))",
      ),
    );
    const parsed = JSON.parse(items);
    if (Object.keys(parsed).length > 0) localStorage[origin] = parsed;
  }
  return { cookies: chosen, localStorage };
}

/**
 * Write cookies and localStorage into a browser. Expired cookies are skipped.
 * @returns {Promise<{ cookies: number, expired: number, localStorage: number }>}
 */
export async function importProfileData(
  cdp,
  { cookies = [], localStorage = {} },
  now = Date.now,
) {
  const nowSeconds = now() / 1000;
  const live = cookies.filter((cookie) => !isExpired(cookie, nowSeconds));
  if (live.length > 0) {
    await cdp.send("Storage.setCookies", { cookies: live.map(toCookieParam) });
  }
  let items = 0;
  for (const [origin, entries] of Object.entries(localStorage)) {
    const count = Object.keys(entries).length;
    if (count === 0) continue;
    await onOriginPage(cdp, origin, (evaluate) =>
      evaluate(
        `(() => { const items = ${JSON.stringify(entries)}; for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value); return "ok"; })()`,
      ),
    );
    items += count;
  }
  return {
    cookies: live.length,
    expired: cookies.length - live.length,
    localStorage: items,
  };
}

const BLANK_PAGE = Buffer.from(
  "<!doctype html><title>ego lite storage</title>",
).toString("base64");

/**
 * Open a background tab on `origin` whose every request is answered here,
 * with an empty page: the origin's storage is reachable and nothing goes on
 * the network. Service workers are bypassed for the same reason.
 */
export async function onOriginPage(cdp, origin, use, timeoutMs = 15_000) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
    background: true,
  });
  let sessionId;
  let unsubscribe = () => {};
  try {
    ({ sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    }));
    unsubscribe = cdp.onMessage((_text, message) => {
      if (
        message.method !== "Fetch.requestPaused" ||
        message.sessionId !== sessionId
      ) {
        return;
      }
      const { requestId, request, resourceType } = message.params;
      const answer =
        resourceType === "Document" && request.url.startsWith(`${origin}/`)
          ? cdp.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [
                  { name: "Content-Type", value: "text/html; charset=utf-8" },
                ],
                body: BLANK_PAGE,
              },
              sessionId,
            )
          : cdp.send(
              "Fetch.failRequest",
              { requestId, errorReason: "BlockedByClient" },
              sessionId,
            );
      answer.catch(() => {});
    });
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send(
      "Network.setBypassServiceWorker",
      { bypass: true },
      sessionId,
    );
    await cdp.send(
      "Fetch.enable",
      { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      sessionId,
    );
    await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
    const evaluate = async (expression) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { result, exceptionDetails } = await cdp.send(
          "Runtime.evaluate",
          {
            expression: `location.origin === ${JSON.stringify(origin)} && document.readyState !== "loading" ? (${expression}) : null`,
            returnByValue: true,
          },
          sessionId,
        );
        if (exceptionDetails) {
          throw new Error(
            `cannot use the storage of ${origin}: ${exceptionDetails.exception?.description || exceptionDetails.text}`,
          );
        }
        if (result?.value !== null && result?.value !== undefined) {
          return result.value;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out opening the storage of ${origin}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return await use(evaluate);
  } finally {
    unsubscribe();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// --- Desktop Chrome / Chromium import ---------------------------------------

/** Seconds between 1601-01-01 (Chrome's epoch) and 1970-01-01. */
const CHROME_EPOCH_OFFSET = 11_644_473_600;
const SAME_SITE = { 0: "None", 1: "Lax", 2: "Strict" };
const PRIORITY = { 0: "Low", 1: "Medium", 2: "High" };

/** The cookie database of a Chrome profile folder, or the file itself. */
export function chromeCookiesPath(from, exists = existsSync, stat = statSync) {
  if (!exists(from)) throw new Error(`${from} does not exist`);
  if (stat(from).isFile()) return from;
  for (const candidate of [
    join(from, "Network", "Cookies"),
    join(from, "Cookies"),
  ]) {
    if (exists(candidate)) return candidate;
  }
  throw new Error(
    `no Cookies database in ${from}; pass a Chrome profile folder such as ~/.config/google-chrome/Default`,
  );
}

/** AES-128 key Chrome on Linux derives from a password. */
export function chromeKey(password) {
  return pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
}

/**
 * Decrypt one encrypted_value. Returns the text, or null when the key is
 * wrong or missing. Since database version 24 the plaintext starts with
 * SHA-256(host_key), which is checked and removed.
 */
export function decryptChromeValue(encrypted, key, hostKey) {
  const iv = Buffer.alloc(16, " ");
  let plain;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    plain = Buffer.concat([
      decipher.update(Buffer.from(encrypted).subarray(3)),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
  const digest = createHash("sha256").update(hostKey).digest();
  if (plain.length >= 32 && plain.subarray(0, 32).equals(digest)) {
    plain = plain.subarray(32);
  }
  const text = plain.toString("utf8");
  // A wrong key that happens to pass the padding check gives binary noise.
  return /^[ -~ -￿]*$/.test(text) ? text : null;
}

/**
 * The keyring password Chrome uses for v11 values, from the desktop keyring
 * through `secret-tool` (GNOME Keyring or KWallet's Secret Service). Only
 * called when the user passes --keyring. Null when it is not there.
 */
export function keyringPassword(application, run = execFileSync) {
  try {
    const text = run("secret-tool", ["lookup", "application", application], {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return text.length > 0 ? text.replace(/\n$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * Cookies of `sites` from a Chrome cookie database, as CDP cookies.
 * The database is copied first and opened read-only, so the source is never
 * changed and a running Chrome does not block it.
 * @param {string} file  the Cookies database
 * @param {{ sites: string[], keyring?: string | null, now?: () => number }} options
 *   keyring: the v11 password, when the user allowed the keyring
 * @returns {Promise<{ cookies: object[], skipped: { keyring: number, undecryptable: number, expired: number } }>}
 */
export async function readChromeCookies(
  file,
  { sites, keyring = null, now = Date.now },
) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error(
      "reading a Chrome cookie database needs Node.js 22.13 or newer (node:sqlite)",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "ego-lite-cookies-"));
  const copy = join(dir, "Cookies");
  try {
    copyFileSync(file, copy);
    for (const suffix of ["-wal", "-journal"]) {
      if (existsSync(`${file}${suffix}`))
        copyFileSync(`${file}${suffix}`, `${copy}${suffix}`);
    }
    const db = new DatabaseSync(copy, { readOnly: true });
    let rows;
    try {
      // Chrome times (microseconds since 1601) pass 2^53: read them exactly.
      const statement = db.prepare("SELECT * FROM cookies");
      statement.setReadBigInts(true);
      rows = statement.all();
    } finally {
      db.close();
    }
    return chromeRowsToCookies(rows, { sites, keyring, now });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pure part of readChromeCookies, for tests. */
export function chromeRowsToCookies(
  rows,
  { sites, keyring = null, now = Date.now },
) {
  const v10 = chromeKey("peanuts");
  const v11 = keyring ? chromeKey(keyring) : null;
  const nowSeconds = now() / 1000;
  const cookies = [];
  const skipped = { keyring: 0, undecryptable: 0, expired: 0 };
  for (const row of rows) {
    const hostKey = String(row.host_key ?? "");
    if (!domainInSites(hostKey, sites)) continue;
    let value = row.value ?? "";
    const encrypted = row.encrypted_value
      ? Buffer.from(row.encrypted_value)
      : null;
    if (encrypted && encrypted.length > 0) {
      const prefix = encrypted.subarray(0, 3).toString("latin1");
      if (prefix === "v11" && !v11) {
        skipped.keyring += 1;
        continue;
      }
      const key = prefix === "v10" ? v10 : prefix === "v11" ? v11 : null;
      value = key ? decryptChromeValue(encrypted, key, hostKey) : null;
      if (value === null) {
        skipped.undecryptable += 1;
        continue;
      }
    }
    const persistent = Number(row.is_persistent ?? row.has_expires ?? 0) === 1;
    const expires = persistent
      ? Number(BigInt(row.expires_utc ?? 0) / 1_000n) / 1_000 -
        CHROME_EPOCH_OFFSET
      : -1;
    if (persistent && expires > 0 && expires < nowSeconds) {
      skipped.expired += 1;
      continue;
    }
    const cookie = {
      name: String(row.name),
      value,
      domain: hostKey,
      path: String(row.path || "/"),
      expires,
      secure: Number(row.is_secure) === 1,
      httpOnly: Number(row.is_httponly) === 1,
      session: !persistent,
    };
    const sameSite = SAME_SITE[Number(row.samesite)];
    if (sameSite) cookie.sameSite = sameSite;
    const priority = PRIORITY[Number(row.priority)];
    if (priority) cookie.priority = priority;
    if (row.top_frame_site_key) {
      cookie.partitionKey = {
        topLevelSite: String(row.top_frame_site_key),
        hasCrossSiteAncestor: Number(row.has_cross_site_ancestor ?? 0) === 1,
      };
    }
    cookies.push(cookie);
  }
  return { cookies, skipped };
}

/** Reasons a Chrome import skipped cookies, in plain words. */
export function describeSkipped(skipped, keyringUsed) {
  const lines = [];
  if (skipped.keyring > 0) {
    lines.push(
      `${skipped.keyring} cookie(s) skipped: encrypted with a key from the desktop keyring (v11). Run again with --keyring to read that key through secret-tool, or log in on this profile instead.`,
    );
  }
  if (skipped.undecryptable > 0) {
    lines.push(
      `${skipped.undecryptable} cookie(s) skipped: could not be decrypted${keyringUsed ? " (the keyring key did not fit)" : ""}.`,
    );
  }
  if (skipped.expired > 0)
    lines.push(`${skipped.expired} expired cookie(s) skipped.`);
  return lines;
}

/** Error result for a profile whose data cannot be exported or imported. */
export function ephemeralRefusal() {
  return egoError(
    "The ephemeral profile lives only inside one task space; export or import a named profile or Default.",
    "EGO_INVALID_ARGUMENT",
  );
}
