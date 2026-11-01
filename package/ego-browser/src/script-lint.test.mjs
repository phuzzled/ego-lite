import test from "node:test";
import assert from "node:assert/strict";

import { formatLintWarnings, lintScript } from "../dist/src/script-lint.js";

function rules(code) {
  return lintScript(code).map(({ line, rule }) => `${line}:${rule}`);
}

const PRELUDE = `const task = await taskSpace("demo");\nconst page = task.page("p1");\n`;

test("a static import is explained with the matching dynamic import", () => {
  const warnings = lintScript(
    `import fs from "node:fs/promises";\nimport { readFile as rf, writeFile } from "node:fs/promises";\nimport * as path from "node:path";\nimport "./side-effect.js";`,
  );
  assert.deepEqual(
    warnings.map((warning) => warning.message.split("Write ")[1]),
    [
      'const { default: fs } = await import("node:fs/promises");',
      'const { readFile: rf, writeFile } = await import("node:fs/promises");',
      'const path = await import("node:path");',
      'await import("./side-effect.js");',
    ],
  );
  assert.deepEqual(rules(`const fs = await import("node:fs/promises");`), []);
});

test("a Page or TaskSpace call used without await is flagged", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}console.log(String(page.url()));\npage.click("#a");\nif (page.title()) {}\nconst same = page.url() === "x";\nconsole.log(\`\${page.url()}\`);\npage.url().includes("x");\ntask.newPage();\ntask.page("p2").goto("https://example.com");\npage.keyboard.press("Enter");`,
    ),
    [
      "3:missing-await",
      "4:missing-await",
      "5:missing-await",
      "6:missing-await",
      "7:missing-await",
      "8:missing-await",
      "9:missing-await",
      "10:missing-await",
      "11:missing-await",
    ],
  );
  assert.equal(
    lintScript(`${PRELUDE}String(page.url());`)[0].message,
    "page.url() returns a Promise. Write await page.url().",
  );
  assert.equal(
    lintScript(`${PRELUDE}page.click("#a");`)[0].message,
    "page.click(...) returns a Promise. Write await page.click(...).",
  );
});

test("held, awaited, returned, or chained Promises are not flagged", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}const u = page.url(); await u;
const both = await Promise.all([page.url(), page.title()]);
const popup = page.waitForEvent("popup");
const chooser = page.waitForFileChooser();
const response = page.waitForResponse(/api/);
await page.click("#go");
page.goto("https://example.com").catch(() => {});
async function read() { return page.title(); }
const later = () => page.url();
void page.close();
const results = await Promise.allSettled([page.goto("https://a")]);
let v; v = page.url(); await v;`,
    ),
    [],
  );
});

test("objects that are not Pages keep their own methods", () => {
  assert.deepEqual(
    rules(
      `const arr = [1, 2]; arr.fill(0);
const fs = await import("node:fs/promises"); fs.close;
const handle = { url() { return "x"; } }; console.log(handle.url());
const map = new Map(); map.keys();`,
    ),
    [],
  );
});

test("Page variables are recognized from factories as well as names", () => {
  assert.deepEqual(
    rules(
      `const t = await taskSpace("x");\nconst first = t.page("p1");\nconst created = await t.newPage();\nfirst.click("#a");\ncreated.goto("https://example.com");\nconst loginPage = t.page("p2");\nloginPage.fill("#u", "me");`,
    ),
    ["4:missing-await", "5:missing-await", "7:missing-await"],
  );
});

test("status() on a goto or reload receipt is flagged", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}const r = await page.goto("https://example.com");\nconsole.log(r.status());\nif (!r.ok) {}\nconst again = await page.reload();\nagain.json();\nconsole.log((await page.goto("https://x")).status);`,
    ),
    [
      "4:receipt-status",
      "5:receipt-status",
      "7:receipt-status",
      "8:receipt-status",
    ],
  );
  assert.match(
    lintScript(
      `${PRELUDE}const r = await page.goto("https://x");\nr.status();`,
    )[0].message,
    /it has no status\(\)\. Use await page\.fetch\(url\)/,
  );
  assert.deepEqual(
    rules(
      `${PRELUDE}const r = await page.fetch("https://example.com");\nconsole.log(r.status, r.ok);`,
    ),
    [],
  );
});

test("Page globals in Node.js code are flagged once, page callbacks are not", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}console.log(document.title);\nconst w = window.innerWidth;\nconsole.log(document.body);`,
    ),
    ["3:page-global", "4:page-global"],
  );
  assert.deepEqual(
    rules(
      `${PRELUDE}await page.evaluate(() => document.title);
await page.waitForFunction(() => window.ready === true);
function inPage() { return location.href; }
await page.evaluate(inPage);
if (typeof window === "undefined") {}
const location = "Sydney"; console.log(location);
const info = { document: 1, window: 2 }; info.document;`,
    ),
    [],
  );
});

test("Playwright-only names are flagged with the ego-browser equivalent", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}await page.locator("#a").click();\nawait page.getByRole("button").click();\nconst html = await page.content();\nawait page.waitForNavigation();\nexpect(1).toBe(1);\nawait page.$("#a");`,
    ),
    [
      "3:playwright-api",
      "4:playwright-api",
      "5:playwright-api",
      "6:playwright-api",
      "7:playwright-api",
      "8:playwright-api",
    ],
  );
  assert.match(
    lintScript(`${PRELUDE}await page.locator("#a").click();`)[0].message,
    /page\.locator\(\) is a Playwright API.*loc=role:button/,
  );
  assert.deepEqual(
    rules(
      `const expect = (v) => v; expect(1);\nconst list = { locator() {} }; list.locator();`,
    ),
    [],
  );
});

test("require() is flagged unless the script defines it", () => {
  assert.deepEqual(rules(`const fs = require("node:fs");`), ["1:require"]);
  assert.match(
    lintScript(`const fs = require("node:fs");`)[0].message,
    /await import\("node:fs"\)/,
  );
  assert.deepEqual(
    rules(
      `const { createRequire } = await import("node:module");\nconst require = createRequire(import.meta.url);\nrequire("node:fs");`,
    ),
    [],
  );
});

test("the lint can be disabled and never throws on bad input", () => {
  assert.deepEqual(
    lintScript(`// ego-browser-lint-disable\nimport fs from "node:fs";`),
    [],
  );
  assert.deepEqual(lintScript("const = ;"), []);
  assert.deepEqual(lintScript(undefined), []);
  assert.equal(formatLintWarnings([]), "");
  assert.equal(
    formatLintWarnings([{ line: 3, rule: "require", message: "m" }]),
    "[ego-browser:lint] line 3: m\n",
  );
});

test("top-level return and await parse like the real script body", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}if (await page.url()) return;\nreturn await page.title();`,
    ),
    [],
  );
});

test("new Page and TaskSpace methods are linted from the schema", () => {
  assert.deepEqual(
    rules(
      `${PRELUDE}console.log(String(page.read()));\npage.dismissConsent();\ntask.memo("k", 1);`,
    ),
    ["3:missing-await", "4:missing-await", "5:missing-await"],
  );
  assert.deepEqual(
    rules(
      `${PRELUDE}for await (const p of page.paginate({ next: "a" })) {}\nconst s = page.site("bing");`,
    ),
    [],
  );
});
