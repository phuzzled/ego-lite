import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SecretStore,
  fillSecretInTarget,
  normalizeOrigin,
  redactSecrets,
} from "./secrets.mjs";

function store() {
  const env = {
    XDG_DATA_HOME: join(mkdtempSync(join(tmpdir(), "ego-lite-secrets-")), "d"),
  };
  return new SecretStore({ env });
}

describe("SecretStore", () => {
  it("keeps secrets in a 0600 file and lists names and origins only", () => {
    const secrets = store();
    secrets.set("github-password", "hunter22", [
      "https://GitHub.com/login",
      "https://github.com",
    ]);
    assert.equal(statSync(secrets.file).mode & 0o777, 0o600);
    assert.deepEqual(
      secrets.list().map(({ name, origins }) => ({ name, origins })),
      [{ name: "github-password", origins: ["https://github.com"] }],
    );
    assert.equal(JSON.stringify(secrets.list()).includes("hunter22"), false);
    assert.equal(secrets.get("github-password").value, "hunter22");
    assert.equal(secrets.remove("github-password"), true);
    assert.equal(secrets.get("github-password"), null);
    assert.equal(secrets.remove("github-password"), false);
  });

  it("refuses bad names, short or multi-line values and missing origins", () => {
    const secrets = store();
    assert.throws(() => secrets.set("a b", "value", ["https://a.test"]));
    assert.throws(
      () => secrets.set("x", "abc", ["https://a.test"]),
      /at least 4/,
    );
    assert.throws(
      () => secrets.set("x", "ab\ncd", ["https://a.test"]),
      /one line/,
    );
    assert.throws(() => secrets.set("x", "abcd", []), /--origin/);
  });

  it("tightens a store file that others can read", () => {
    const secrets = store();
    secrets.set("k", "value", ["https://a.test"]);
    chmodSync(secrets.file, 0o644);
    secrets.get("k");
    assert.equal(statSync(secrets.file).mode & 0o777, 0o600);
  });

  it("binds only to https origins, or http on localhost", () => {
    assert.equal(normalizeOrigin("https://a.test/x?y"), "https://a.test");
    assert.equal(
      normalizeOrigin("http://localhost:3000"),
      "http://localhost:3000",
    );
    assert.throws(() => normalizeOrigin("http://a.test"), /https/);
    assert.throws(() => normalizeOrigin("javascript:alert(1)"), /https/);
    assert.throws(() => normalizeOrigin("nope"), /not an origin/);
  });
});

describe("redactSecrets", () => {
  it("replaces values and their JSON-escaped form", () => {
    const secrets = [
      { name: "pw", value: 'p"ss1' },
      { name: "long", value: 'p"ss1-and-more' },
    ];
    const text = JSON.stringify({
      content: 'textbox "Password" value="p\\"ss1-and-more" and p"ss1',
    });
    const redacted = redactSecrets(text, secrets);
    assert.equal(redacted.includes("ss1"), false);
    assert.match(redacted, /\[secret:long\]/);
    assert.match(redacted, /\[secret:pw\]/);
    assert.doesNotThrow(() => JSON.parse(redacted));
  });
});

/** A page double: `probe` is what the focus probe finds. */
function pageCdp(probes) {
  const sent = [];
  let index = 0;
  return {
    sent,
    async send(method, params) {
      sent.push({ method, params });
      if (method === "Target.attachToTarget") return { sessionId: "S" };
      if (method === "Runtime.evaluate") {
        const probe = probes[Math.min(index, probes.length - 1)];
        index += 1;
        return { result: { value: probe } };
      }
      return {};
    },
  };
}

const SECRET = {
  name: "github-password",
  value: "hunter22",
  origins: ["https://github.com"],
};

describe("fillSecretInTarget", () => {
  it("types the value into a focused field on an allowed origin", async () => {
    const cdp = pageCdp([{ origin: "https://github.com", editable: true }]);
    const result = await fillSecretInTarget(cdp, "T1", SECRET);
    assert.deepEqual(result, {
      filled: true,
      secret: "github-password",
      origin: "https://github.com",
    });
    const typed = cdp.sent.filter(
      (entry) => entry.method === "Input.insertText",
    );
    assert.deepEqual(typed, [
      { method: "Input.insertText", params: { text: "hunter22" } },
    ]);
    assert.equal(cdp.sent.at(-1).method, "Target.detachFromTarget");
  });

  it("refuses another origin and types nothing", async () => {
    const cdp = pageCdp([
      { origin: "https://github.com.evil.test", editable: true },
    ]);
    const result = await fillSecretInTarget(cdp, "T1", SECRET);
    assert.equal(result.error_code, "EGO_SECRET_ORIGIN_MISMATCH");
    assert.equal(result.error.includes("hunter22"), false);
    assert.equal(
      cdp.sent.some((entry) => entry.method === "Input.insertText"),
      false,
    );
  });

  it("refuses when no field has focus, or the field is in a cross-origin frame", async () => {
    for (const probe of [
      { origin: "https://github.com", editable: false },
      { origin: "https://github.com", editable: false, crossOriginFrame: true },
    ]) {
      const cdp = pageCdp([probe]);
      const result = await fillSecretInTarget(cdp, "T1", SECRET);
      assert.equal(result.error_code, "EGO_SECRET_NO_FIELD");
      assert.equal(
        cdp.sent.some((entry) => entry.method === "Input.insertText"),
        false,
      );
    }
  });

  it("stops when the page moves to another origin between the checks", async () => {
    const cdp = pageCdp([
      { origin: "https://github.com", editable: true },
      { origin: "https://evil.test", editable: true },
    ]);
    const result = await fillSecretInTarget(cdp, "T1", SECRET);
    assert.equal(result.error_code, "EGO_SECRET_NO_FIELD");
    assert.equal(
      cdp.sent.some((entry) => entry.method === "Input.insertText"),
      false,
    );
  });

  it("never puts the value in the probe script", async () => {
    const cdp = pageCdp([{ origin: "https://github.com", editable: true }]);
    await fillSecretInTarget(cdp, "T1", SECRET);
    for (const entry of cdp.sent) {
      if (entry.method === "Input.insertText") continue;
      assert.equal(JSON.stringify(entry).includes("hunter22"), false);
    }
    assert.ok(readFileSync);
  });
});
