import test from "node:test";
import assert from "node:assert/strict";

import { formatHelp, help } from "../dist/src/help-runtime.js";

test("help resolves public aliases from the API schema", () => {
  const pageClick = help({}, "page.click");

  assert.equal(pageClick.name, "Page.click");
  assert.match(pageClick.signature, /await page\.click/);
  assert.match(pageClick.description, /timeout/);
  assert.match(formatHelp(pageClick), /Page\.click[\s\S]*await page\.click/);
});

test("help keeps legacy and unknown names out of the public surface", () => {
  assert.equal(
    help({ oldHelper() {} }, "oldHelper"),
    'Legacy helper hidden from default help: oldHelper. Use help("legacy", "oldHelper").',
  );
  assert.equal(help({}, "missingHelper"), "Unknown helper: missingHelper");
});

test("help prints what each public entry resolves to on its own line", () => {
  const goto = help({}, "page.goto");
  assert.match(goto.returns, /^Promise<ActionReceipt>/);
  assert.match(
    formatHelp(goto),
    /await page\.goto\(url, \{ referer\?, timeout\?, waitUntil\? \}\)\n {2}returns: Promise<ActionReceipt> \/\/ .*Not an HTTP response/,
  );
  for (const doc of help({})) {
    assert.match(
      formatHelp(doc),
      /\n {2}returns: \S/,
      `${doc.name} help shows its return value`,
    );
  }
});
