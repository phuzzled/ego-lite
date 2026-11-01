import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadLearnedContext,
  validateLearning,
  validateLearnings,
} from "../../dist/src/learning/index.js";

const repoLearnings = new URL(
  "../../../../skills/ego-browser/learnings",
  import.meta.url,
).pathname;

async function withSite(manifest, files, fn) {
  const root = await mkdtemp(join(tmpdir(), "ego-learning-"));
  const site = join(root, "learnings", manifest.id);
  try {
    await mkdir(join(site, "tools"), { recursive: true });
    await mkdir(join(site, "notes"), { recursive: true });
    await writeFile(join(site, "manifest.json"), JSON.stringify(manifest));
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(site, path), content);
    }
    return await fn(root, site);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tool = (extra = {}) => ({
  description: "A tool.",
  path: "tools/t.js",
  callable: "t",
  args: {},
  returns: { type: "array", description: "Rows." },
  ...extra,
});

test("the bundled learnings validate, including the v2 tools", async () => {
  assert.deepEqual(await validateLearnings(repoLearnings), []);
});

test("a Node tool's api must be 1 or 2, and only Node tools have one", async () => {
  await withSite(
    {
      id: "demo",
      name: "Demo",
      domains: ["demo.test"],
      notes: [],
      nodeTools: { good: tool({ api: 2 }), bad: tool({ api: 3 }) },
      browserTools: {
        b: { ...tool({ api: 2 }), path: "browser-tools/b.js" },
      },
    },
    { "tools/t.js": "export async function t() { return []; }" },
    async (_root, site) => {
      const errors = await validateLearning(site);
      assert(
        errors.some((error) => /nodeTools\.bad: api must be 1/.test(error)),
      );
      assert(
        errors.some((error) =>
          /browserTools\.b: api applies to Node tools only/.test(error),
        ),
      );
      assert(!errors.some((error) => /nodeTools\.good/.test(error)));
    },
  );
});

test("learned context shows the v2 call for api 2 tools", async () => {
  await withSite(
    {
      id: "demo",
      name: "Demo",
      domains: ["demo.test"],
      notes: [],
      nodeTools: { v2: tool({ api: 2 }), v1: tool() },
    },
    { "tools/t.js": "export async function t() { return []; }" },
    async (root) => {
      const context = await loadLearnedContext("https://demo.test/", {
        agentWorkspace: root,
      });
      const examples = Object.fromEntries(
        context.tools.map((entry) => [entry.toolName, entry.example]),
      );
      assert.match(examples.v2, /page\.site\("demo"\)\.run\("v2"/);
      assert.match(examples.v1, /runSiteTool\("demo", "v1"/);
    },
  );
});

test("the arXiv tool parses an Atom feed", async () => {
  const { parseFeed } = await import(`${repoLearnings}/arxiv/tools/search.js`);
  const [paper] = parseFeed(`<feed><entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>The dominant &amp; best models.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7" rel="related" type="application/pdf"/>
  </entry></feed>`);
  assert.deepEqual(paper, {
    id: "1706.03762v7",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    summary: "The dominant & best models.",
    published: "2017-06-12T17:57:34Z",
    absUrl: "http://arxiv.org/abs/1706.03762v7",
    pdfUrl: "http://arxiv.org/pdf/1706.03762v7",
  });
});

test("the bing tool throws EGO_SITE_BLOCKED instead of returning nothing", async () => {
  const { search } = await import(`${repoLearnings}/bing/tools/search.js`);
  const blockedPage = {
    async search() {
      return {
        engine: null,
        results: [],
        blocked: [
          {
            engine: "bing",
            url: "https://www.bing.com/x",
            reason: "a check",
            hint: "Hand off.",
          },
        ],
      };
    },
  };
  await assert.rejects(
    () => search(blockedPage, { query: "x" }),
    (error) =>
      error.error_code === "EGO_SITE_BLOCKED" && /a check/.test(error.message),
  );
  const okPage = {
    async search(query, options) {
      assert.deepEqual(options, { engine: "bing", max: 3 });
      return {
        engine: "bing",
        results: [{ rank: 1, title: query }],
        blocked: [],
      };
    },
  };
  assert.deepEqual(await search(okPage, { query: "q", maxResults: 3 }), [
    { rank: 1, title: "q" },
  ]);
  await assert.rejects(() => search(okPage, {}), /query is required/);
});
