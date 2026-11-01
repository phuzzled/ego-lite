import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildCookieFile,
  chromeCookiesPath,
  chromeKey,
  chromeRowsToCookies,
  decryptChromeValue,
  describeSkipped,
  domainInSites,
  exportProfileData,
  filePermissionWarning,
  importProfileData,
  keyringPassword,
  parseOrigins,
  parseSites,
  readChromeCookies,
  readCookieFile,
  toCookieParam,
  writePrivateFile,
} from "./cookies.mjs";

const tempDir = () => mkdtempSync(join(tmpdir(), "ego-lite-cookies-test-"));

/** Encrypt like Chrome on Linux: "v10"/"v11" + AES-128-CBC, IV of spaces. */
function chromeEncrypt(text, password, prefix, hostKey) {
  const cipher = createCipheriv(
    "aes-128-cbc",
    chromeKey(password),
    Buffer.alloc(16, " "),
  );
  const plain = hostKey
    ? Buffer.concat([
        createHash("sha256").update(hostKey).digest(),
        Buffer.from(text),
      ])
    : Buffer.from(text);
  return Buffer.concat([
    Buffer.from(prefix),
    cipher.update(plain),
    cipher.final(),
  ]);
}

/** Chrome stores times as microseconds since 1601. */
const chromeTime = (unixSeconds) => (unixSeconds + 11_644_473_600) * 1e6;
const NOW = 1_800_000_000_000;

function row(fields) {
  return {
    host_key: ".github.com",
    name: "user_session",
    value: "",
    encrypted_value: null,
    path: "/",
    expires_utc: chromeTime(NOW / 1000 + 86_400),
    is_secure: 1,
    is_httponly: 1,
    is_persistent: 1,
    samesite: 1,
    priority: 1,
    top_frame_site_key: "",
    ...fields,
  };
}

describe("site scope", () => {
  it("parses a site list and matches subdomains only", () => {
    assert.deepEqual(parseSites("GitHub.com, .notion.so,github.com"), [
      "github.com",
      "notion.so",
    ]);
    assert.throws(() => parseSites(""), /at least one site/);
    assert.throws(() => parseSites("http://x.com"), /not a site name/);
    const sites = ["github.com"];
    assert.equal(domainInSites(".github.com", sites), true);
    assert.equal(domainInSites("gist.github.com", sites), true);
    assert.equal(domainInSites("evilgithub.com", sites), false);
    assert.equal(domainInSites("github.com.evil.test", sites), false);
  });

  it("accepts localStorage origins only inside the sites", () => {
    assert.deepEqual(
      parseOrigins("https://app.notion.so,http://notion.so:8080", [
        "notion.so",
      ]),
      ["https://app.notion.so", "http://notion.so:8080"],
    );
    assert.throws(
      () => parseOrigins("https://evil.test", ["notion.so"]),
      /not in --sites/,
    );
    assert.throws(
      () => parseOrigins("https://notion.so/path", ["notion.so"]),
      /not an origin/,
    );
    assert.throws(
      () => parseOrigins("file:///etc", ["notion.so"]),
      /not an origin/,
    );
  });
});

describe("toCookieParam", () => {
  it("keeps a host-only cookie host-only by setting it through its URL", () => {
    assert.deepEqual(
      toCookieParam({
        name: "__Host-id",
        value: "v",
        domain: "github.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: 1_900_000_000,
        session: false,
        priority: "Medium",
      }),
      {
        name: "__Host-id",
        value: "v",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: 1_900_000_000,
        priority: "Medium",
        url: "https://github.com/",
      },
    );
  });

  it("sets a domain cookie by domain and leaves a session cookie without expiry", () => {
    const param = toCookieParam({
      name: "a",
      value: "b",
      domain: ".github.com",
      path: "/x",
      secure: false,
      httpOnly: false,
      expires: -1,
      session: true,
    });
    assert.equal(param.domain, ".github.com");
    assert.equal(param.url, undefined);
    assert.equal(param.expires, undefined);
  });
});

describe("cookie file", () => {
  it("round-trips and carries the warning", () => {
    const text = buildCookieFile({
      profile: "work",
      sites: ["github.com"],
      cookies: [{ name: "a", value: "b", domain: ".github.com" }],
      localStorage: { "https://github.com": { k: "v" } },
      now: () => NOW,
    });
    const data = readCookieFile(text);
    assert.equal(data.cookies.length, 1);
    assert.equal(data.localStorage["https://github.com"].k, "v");
    assert.match(data.warning, /live login sessions/);
  });

  it("rejects files that are not cookie files", () => {
    assert.throws(() => readCookieFile("nope"), /not JSON/);
    assert.throws(() => readCookieFile("{}"), /not an ego lite cookie file/);
    const bad = JSON.parse(
      buildCookieFile({ profile: "p", sites: [], cookies: [] }),
    );
    bad.cookies = [{ name: 1 }];
    assert.throws(() => readCookieFile(JSON.stringify(bad)), /malformed/);
    bad.cookies = [];
    bad.localStorage = { "javascript:alert(1)": {} };
    assert.throws(() => readCookieFile(JSON.stringify(bad)), /malformed/);
  });

  it("is created 0600, is not overwritten by accident and never follows a link", () => {
    const dir = tempDir();
    const file = join(dir, "cookies.json");
    writePrivateFile(file, "one");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writePrivateFile(file, "two"), /--force/);
    writePrivateFile(file, "two", { force: true });
    assert.equal(readFileSync(file, "utf8"), "two");
    const target = join(dir, "target");
    writeFileSync(target, "keep");
    const link = join(dir, "link.json");
    symlinkSync(target, link);
    assert.throws(() => writePrivateFile(link, "x"), /exists/);
    assert.throws(
      () => writePrivateFile(link, "x", { force: true }),
      /not a regular file/,
    );
    assert.equal(readFileSync(target, "utf8"), "keep");
  });

  it("warns when a cookie file can be read by others", () => {
    assert.equal(
      filePermissionWarning("/f", () => ({ mode: 0o100600 })),
      null,
    );
    assert.match(
      filePermissionWarning("/f", () => ({ mode: 0o100644 })),
      /chmod 600/,
    );
  });
});

/** A browser double for Storage and the localStorage page. */
function fakeCdp(cookies = []) {
  const sent = [];
  const listeners = new Set();
  const storage = {};
  return {
    sent,
    storage,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (method === "Storage.getCookies") return { cookies };
      if (method === "Target.createTarget") return { targetId: "T" };
      if (method === "Target.attachToTarget") return { sessionId: "S" };
      if (method === "Page.navigate") {
        // The page asks for the document; the router answers it locally.
        for (const listener of listeners) {
          listener("", {
            method: "Fetch.requestPaused",
            sessionId: "S",
            params: {
              requestId: "R",
              resourceType: "Document",
              request: { url: params.url },
            },
          });
        }
        return {};
      }
      if (method === "Runtime.evaluate") {
        const expression = params.expression;
        if (expression.includes("localStorage.setItem")) {
          Object.assign(
            storage,
            JSON.parse(/const items = (\{.*?\});/.exec(expression)[1]),
          );
          return { result: { value: "ok" } };
        }
        return { result: { value: JSON.stringify(storage) } };
      }
      return {};
    },
  };
}

describe("exportProfileData / importProfileData", () => {
  it("exports only the named sites, and localStorage through a local-only page", async () => {
    const cdp = fakeCdp([
      { name: "a", value: "1", domain: ".github.com" },
      { name: "b", value: "2", domain: "bank.test" },
    ]);
    cdp.storage.token = "t";
    const data = await exportProfileData(cdp, {
      sites: ["github.com"],
      origins: ["https://github.com"],
    });
    assert.deepEqual(
      data.cookies.map((cookie) => cookie.name),
      ["a"],
    );
    assert.deepEqual(data.localStorage, {
      "https://github.com": { token: "t" },
    });
    const methods = cdp.sent.map((entry) => entry.method);
    assert.ok(methods.includes("Network.setBypassServiceWorker"));
    assert.ok(methods.includes("Fetch.enable"));
    const fulfilled = cdp.sent.find(
      (entry) => entry.method === "Fetch.fulfillRequest",
    );
    assert.equal(fulfilled.params.responseCode, 200);
    assert.ok(methods.includes("Target.closeTarget"));
  });

  it("imports live cookies and skips expired ones", async () => {
    const cdp = fakeCdp();
    const result = await importProfileData(
      cdp,
      {
        cookies: [
          {
            name: "live",
            value: "1",
            domain: ".a.test",
            expires: NOW / 1000 + 60,
          },
          {
            name: "old",
            value: "1",
            domain: ".a.test",
            expires: NOW / 1000 - 60,
          },
          { name: "session", value: "1", domain: "a.test", session: true },
        ],
        localStorage: { "https://a.test": { k: "v" } },
      },
      () => NOW,
    );
    assert.deepEqual(result, { cookies: 2, expired: 1, localStorage: 1 });
    const set = cdp.sent.find((entry) => entry.method === "Storage.setCookies");
    assert.deepEqual(
      set.params.cookies.map((cookie) => cookie.name),
      ["live", "session"],
    );
    assert.deepEqual(cdp.storage, { k: "v" });
  });
});

describe("desktop Chrome import", () => {
  it("decrypts v10 values, with and without the host-key hash", () => {
    const key = chromeKey("peanuts");
    assert.equal(
      decryptChromeValue(
        chromeEncrypt("s3cret", "peanuts", "v10", ".github.com"),
        key,
        ".github.com",
      ),
      "s3cret",
    );
    assert.equal(
      decryptChromeValue(
        chromeEncrypt("old", "peanuts", "v10"),
        key,
        ".github.com",
      ),
      "old",
    );
    assert.equal(
      decryptChromeValue(
        chromeEncrypt("x", "other", "v10"),
        key,
        ".github.com",
      ),
      null,
    );
  });

  it("skips keyring (v11) values honestly unless the keyring key is given", () => {
    const rows = [
      row({
        encrypted_value: chromeEncrypt("a", "peanuts", "v10", ".github.com"),
      }),
      row({
        name: "kr",
        encrypted_value: chromeEncrypt("b", "ring", "v11", ".github.com"),
      }),
      row({ host_key: "bank.test", name: "other", value: "c" }),
      row({
        name: "gone",
        value: "d",
        expires_utc: chromeTime(NOW / 1000 - 1),
      }),
    ];
    const without = chromeRowsToCookies(rows, {
      sites: ["github.com"],
      now: () => NOW,
    });
    assert.deepEqual(
      without.cookies.map((cookie) => [cookie.name, cookie.value]),
      [["user_session", "a"]],
    );
    assert.deepEqual(without.skipped, {
      keyring: 1,
      undecryptable: 0,
      expired: 1,
    });
    assert.match(describeSkipped(without.skipped, false)[0], /--keyring/);

    const withKey = chromeRowsToCookies(rows, {
      sites: ["github.com"],
      keyring: "ring",
      now: () => NOW,
    });
    assert.deepEqual(
      withKey.cookies.map((cookie) => [cookie.name, cookie.value]),
      [
        ["user_session", "a"],
        ["kr", "b"],
      ],
    );
    const [cookie] = withKey.cookies;
    assert.equal(cookie.sameSite, "Lax");
    assert.equal(cookie.secure, true);
    assert.equal(cookie.session, false);
    assert.equal(Math.round(cookie.expires), NOW / 1000 + 86_400);
  });

  it("asks secret-tool for the keyring key only when called", () => {
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      return "pw\n";
    };
    assert.equal(keyringPassword("chromium", run), "pw");
    assert.deepEqual(calls, [
      ["secret-tool", "lookup", "application", "chromium"],
    ]);
    assert.equal(
      keyringPassword("chrome", () => {
        throw new Error("no keyring");
      }),
      null,
    );
  });

  it("finds the database in a profile folder", () => {
    const exists = (path) => path === "/p" || path === "/p/Network/Cookies";
    const stat = () => ({ isFile: () => false });
    assert.equal(chromeCookiesPath("/p", exists, stat), "/p/Network/Cookies");
    assert.throws(
      () => chromeCookiesPath("/q", () => false, stat),
      /does not exist/,
    );
  });

  it("reads a real SQLite cookie database without changing it", async (t) => {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      t.skip("needs node:sqlite");
      return;
    }
    const dir = tempDir();
    const file = join(dir, "Cookies");
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, is_persistent INTEGER, samesite INTEGER, priority INTEGER, top_frame_site_key TEXT)",
    );
    db.prepare(
      "INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, 1, 1, 1, '')",
    ).run(
      ".github.com",
      "user_session",
      chromeEncrypt("abc", "peanuts", "v10", ".github.com"),
      BigInt(chromeTime(NOW / 1000 + 3_600)),
    );
    db.close();
    const before = readFileSync(file);
    const { cookies } = await readChromeCookies(file, {
      sites: ["github.com"],
      now: () => NOW,
    });
    assert.deepEqual(
      cookies.map((cookie) => [cookie.name, cookie.value]),
      [["user_session", "abc"]],
    );
    assert.deepEqual(readFileSync(file), before);
  });
});
