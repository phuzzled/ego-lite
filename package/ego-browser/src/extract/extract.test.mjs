import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

import { extractPdfText, pdfMarkdown } from "../../dist/src/extract/pdf.js";
import {
  countWords,
  finishReadResult,
  truncateMarkdown,
} from "../../dist/src/extract/read.js";
import {
  csvField,
  gridToRows,
  tableToCsv,
  uniqueHeaders,
} from "../../dist/src/extract/tables.js";
import {
  judgeSearchPage,
  searchEngineOrder,
  searchUrl,
  unwrapResultUrl,
} from "../../dist/src/extract/search.js";
import {
  ACCEPT_TEXT,
  CONSENT_RULES,
  REJECT_TEXT,
} from "../../dist/src/extract/consent.js";
import { isolatedCallExpression } from "../../dist/src/extract/isolated.js";
import { twoPagePdf } from "../../scripts/real-browser-e2e/extraction-fixture.mjs";

/** A one-page PDF whose Type0 font maps two-byte codes through ToUnicode. */
function type0Pdf() {
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    "2 beginbfchar <0001> <0048> <0002> <0069> endbfchar",
    "1 beginbfrange <0010> <0012> <00E9> endbfrange",
    "endcmap end end",
  ].join("\n");
  const content =
    "BT /F1 12 Tf 72 700 Td <00010002> Tj 0 -14 Td <001000110012> Tj ET";
  const objects = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    5: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R >>",
  };
  const streams = {
    4: Buffer.from(content),
    6: deflateSync(Buffer.from(cmap)),
  };
  const parts = [Buffer.from("%PDF-1.5\n")];
  for (let id = 1; id <= 6; id += 1) {
    if (streams[id]) {
      const filter = id === 6 ? " /Filter /FlateDecode" : "";
      parts.push(
        Buffer.from(
          `${id} 0 obj\n<< /Length ${streams[id].length}${filter} >>\nstream\n`,
        ),
        streams[id],
        Buffer.from("\nendstream\nendobj\n"),
      );
    } else {
      parts.push(Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`));
    }
  }
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

test("a generated two-page PDF reads page by page with its title", () => {
  const text = extractPdfText(twoPagePdf());
  assert.equal(text.info.title, "Fixture report");
  assert.equal(text.info.author, "Ego Fixture");
  assert.equal(text.pages.length, 2);
  assert.equal(
    text.pages[0].text,
    "Quarterly report\nRevenue grew in the first quarter.",
  );
  assert.equal(text.pages[1].text, "Second page text\nCosts fell.");
  assert.equal(text.warning, undefined);
  assert.match(
    pdfMarkdown(text),
    /^# Fixture report\n\n## Page 1\n\nQuarterly/,
  );
});

test("a real-world PDF with object streams and ToUnicode maps reads", async () => {
  const bytes = await readFile(
    new URL(
      "../../scripts/real-browser-e2e/fixtures/openai-gpt-4-system-card.pdf",
      import.meta.url,
    ),
  );
  const text = extractPdfText(bytes);
  assert.equal(text.pages.length, 60);
  assert.match(text.pages[0].text, /^GPT-4 System Card\nOpenAI\nAbstract/);
  assert.match(text.pages[1].text, /Large language models, also known as LLMs/);
});

test("Type0 fonts decode two-byte codes through bfchar and bfrange", () => {
  const text = extractPdfText(type0Pdf());
  assert.equal(text.pages[0].text, "Hi\néêë");
});

test("non-PDF, encrypted and image-only PDFs say so", () => {
  assert.throws(() => extractPdfText(Buffer.from("<html>")), /not a PDF/);
  const encrypted = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF",
  );
  assert.match(extractPdfText(encrypted).warning, /encrypted/);
  const empty = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
  );
  const result = extractPdfText(empty);
  assert.equal(result.pages.length, 1);
  assert.match(result.warning, /scanned images/);
});

test("Markdown is cut at the last heading, paragraph, line or word", () => {
  const sections = Array.from(
    { length: 20 },
    (_v, i) => `## Section ${i}\n\n${"word ".repeat(40).trim()}`,
  ).join("\n\n");
  const cut = truncateMarkdown(sections, 1000);
  assert.equal(cut.truncated, true);
  assert(cut.markdown.length <= 1000);
  assert.match(cut.markdown, /word$/);
  const line = truncateMarkdown(
    `${"a ".repeat(400)}\n${"b ".repeat(400)}`,
    1000,
  );
  assert.match(line.markdown, /a$/);
  const word = truncateMarkdown("x".repeat(100) + " " + "y".repeat(2000), 1000);
  assert.equal(
    word.markdown.length,
    1000,
    "no boundary in the second half: hard cut",
  );
  assert.deepEqual(truncateMarkdown("short", 10), {
    markdown: "short",
    truncated: false,
  });
});

test("words are counted without link targets or markup", () => {
  assert.equal(
    countWords("# Title\n\nA [link text](https://x.test/a/b) here."),
    5,
  );
  const result = finishReadResult(
    {
      url: "https://x.test/",
      title: "T",
      markdown: "one two three",
      links: [],
      source: "article",
    },
    100,
  );
  assert.equal(result.words, 3);
  assert.equal(result.truncated, false);
});

test("table grids become keyed rows with joined multi-row headers", () => {
  const { headers, rows } = gridToRows(
    [
      ["City", "Population", "Population"],
      ["City", "2010", "2020"],
      ["Springfield", "1,234", "1,500"],
      ["", "", ""],
      ["City", "2010", "2020"],
      ["Shelbyville", "900"],
    ],
    2,
  );
  assert.deepEqual(headers, ["City", "Population / 2010", "Population / 2020"]);
  assert.deepEqual(rows, [
    {
      City: "Springfield",
      "Population / 2010": "1,234",
      "Population / 2020": "1,500",
    },
    {
      City: "Shelbyville",
      "Population / 2010": "900",
      "Population / 2020": "",
    },
  ]);
  assert.deepEqual(gridToRows([["a", "b"]], 0).headers, [
    "Column 1",
    "Column 2",
  ]);
  assert.deepEqual(uniqueHeaders(["Name", "Name", ""]), [
    "Name",
    "Name (2)",
    "Column 3",
  ]);
});

test("CSV quotes commas, quotes, newlines and edge spaces", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("1,234"), '"1,234"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField("two\nlines"), '"two\nlines"');
  assert.equal(csvField(" padded"), '" padded"');
  assert.equal(
    tableToCsv({ headers: ["a", "b"], rows: [{ a: "1", b: "x,y" }] }),
    'a,b\r\n1,"x,y"\r\n',
  );
});

test("search tries engines in order and honors a configured first engine", () => {
  assert.deepEqual(searchEngineOrder("auto", undefined), [
    "bing",
    "duckduckgo",
    "google",
  ]);
  assert.deepEqual(searchEngineOrder(undefined, "google"), [
    "google",
    "bing",
    "duckduckgo",
  ]);
  assert.deepEqual(searchEngineOrder("duckduckgo", "google"), ["duckduckgo"]);
  assert.equal(
    searchUrl("bing", "a b&c"),
    "https://www.bing.com/search?q=a%20b%26c",
  );
});

test("engine tracking links are unwrapped to the target URL", () => {
  const target = "https://example.test/page?x=1";
  const bing = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString("base64url")}&ntb=1`;
  assert.equal(unwrapResultUrl(bing), target);
  assert.equal(
    unwrapResultUrl(
      `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`,
    ),
    target,
  );
  assert.equal(
    unwrapResultUrl(
      `https://www.google.com/url?q=${encodeURIComponent(target)}`,
    ),
    target,
  );
  assert.equal(unwrapResultUrl("not a url"), "not a url");
});

test("a block or an unreadable page is never reported as empty results", () => {
  const blocked = judgeSearchPage("google", {
    url: "https://www.google.com/sorry/index",
    blocked: "Google showed its unusual-traffic check (/sorry/)",
    results: [],
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.block.hint, /bing/);
  const unreadable = judgeSearchPage("bing", {
    url: "https://www.bing.com/x",
    results: [],
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.block.reason, /no results could be read/);
  const none = judgeSearchPage("bing", {
    url: "https://www.bing.com/x",
    results: [],
    noResults: true,
  });
  assert.deepEqual(none, { ok: true, results: [], noResults: true });
  const found = judgeSearchPage("bing", {
    url: "https://www.bing.com/x",
    results: [{ title: "T", url: "https://a.test/", snippet: "S" }],
  });
  assert.deepEqual(found.results, [
    { rank: 1, title: "T", url: "https://a.test/", snippet: "S" },
  ]);
});

test("consent text matches reject and necessary-only, never accept", () => {
  for (const text of [
    "Reject all",
    "Reject All Cookies",
    "Decline",
    "Only necessary cookies",
    "Necessary only",
    "Use necessary cookies only",
    "Continue without accepting",
    "Alle ablehnen",
    "Tout refuser",
    "Rechazar todo",
  ]) {
    assert.match(text, REJECT_TEXT, text);
    assert.doesNotMatch(text, ACCEPT_TEXT, text);
  }
  for (const text of [
    "Accept all",
    "Accept",
    "I agree",
    "Allow all cookies",
    "Got it",
  ]) {
    assert.match(text, ACCEPT_TEXT, text);
    assert.doesNotMatch(text, REJECT_TEXT, text);
  }
  assert.doesNotMatch(
    "Reject all and subscribe to our newsletter today",
    REJECT_TEXT,
  );
  for (const rule of CONSENT_RULES) {
    assert(rule.reject.length > 0, `${rule.framework} has a reject selector`);
    assert(rule.accept.length > 0, `${rule.framework} has an accept selector`);
  }
});

test("isolated calls pass their argument as JSON", () => {
  const expression = isolatedCallExpression((arg) => arg.a + 1, {
    a: '"quoted"',
  });
  assert.match(expression, /JSON\.parse/);
  // The expression evaluates to a Promise of the function's result.
  return eval(expression).then((value) => assert.equal(value, '"quoted"1'));
});
