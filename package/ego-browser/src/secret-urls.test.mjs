import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  forgetSecrets,
  knowsSecrets,
  recordSecretField,
  redactSecretText,
  redactSecretUrl,
  rememberSecretFieldNames,
  secretHashSalt,
} from "../dist/src/secret-urls.js";

const VALUE = "s3cret value!";
const hash = (value) =>
  createHash("sha256")
    .update(secretHashSalt() + value)
    .digest("hex");

test("a filled field's query parameter is hidden by its name", () => {
  forgetSecrets();
  recordSecretField(3, { name: "pw" });
  assert.equal(
    redactSecretUrl("http://127.0.0.1:9/submitted?user=ann&pw=abc%21&x=1", 3),
    "http://127.0.0.1:9/submitted?user=ann&pw=[secret]&x=1",
  );
  assert.equal(
    redactSecretUrl("http://h.test/a?pw=abc", 4),
    "http://h.test/a?pw=abc",
    "another space is not touched",
  );
});

test("a value equal to the filled secret is hidden wherever it appears", () => {
  forgetSecrets();
  recordSecretField(3, { name: "", hash: hash(VALUE) });
  assert.equal(
    redactSecretUrl(
      "http://h.test/s3cret%20value!/x?q=s3cret+value%21&n=1#s3cret%20value!",
      3,
    ),
    "http://h.test/[secret]/x?q=[secret]&n=1#[secret]",
  );
  assert.equal(
    redactSecretText('[p1 "Welcome token1234" | other s3cret]', 3),
    '[p1 "Welcome token1234" | other s3cret]',
  );
  recordSecretField(3, { hash: hash("token1234") });
  assert.equal(
    redactSecretText('[p1 "Welcome token1234"]', 3),
    '[p1 "Welcome [secret]"]',
  );
});

test("without knowing the field, a flagged space hides every query value", () => {
  forgetSecrets();
  assert.equal(knowsSecrets(5), false);
  assert.equal(
    redactSecretText(
      '[p1 "http://h.test/done?user=ann&pw=hunter2#frag" | space "x"(5)]',
      5,
      true,
    ),
    '[p1 "http://h.test/done?user=[secret]&pw=[secret]#[secret]" | space "x"(5)]',
  );
  assert.equal(
    redactSecretText("http://h.test/?pw=1", 5),
    "http://h.test/?pw=1",
  );
  rememberSecretFieldNames(5, ["pw"]);
  assert.equal(knowsSecrets(5), true);
  assert.equal(
    redactSecretUrl("http://h.test/done?user=ann&pw=hunter2", 5),
    "http://h.test/done?user=ann&pw=[secret]",
  );
});

test("a tab title that is a URL without its scheme is redacted too", () => {
  forgetSecrets();
  recordSecretField(6, { name: "pw" });
  assert.equal(
    redactSecretText('[p1 "127.0.0.1:9/submitted?user=ann&pw=Pq7" | x]', 6),
    '[p1 "127.0.0.1:9/submitted?user=ann&pw=[secret]" | x]',
  );
});
