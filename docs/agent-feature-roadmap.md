# ego-lite as an agent's main way onto the web: feature roadmap

Status: proposal. Date: 2026-11-01. Scope: the SDK (`package/ego-browser`),
the Linux host (`package/ego-host-linux`), the Skill and the docs.

The goal: an agent should reach for `ego-browser` first for any web task, and
it should work the first time. Today it works well once the agent knows the
rules. Most lost rounds come from silent failures, missing hints, and work the
agent has to hand-write each time (reading an article, a table, a PDF, an API
response).

This document does not fix bugs. Bugs seen while testing are listed in
[Appendix B](#appendix-b-bugs-noticed).

---

## 1. Summary: top 10, ranked by impact on agent success ÷ effort

| #   | Change                                                                       | Effort | Impact | Where                  |
| --- | ---------------------------------------------------------------------------- | ------ | ------ | ---------------------- |
| 1   | Every error carries a `hint` with the next step; `goto()` errors name the HTTP status | S      | High   | SDK                    |
| 2   | Snapshot retries transient "page changed" errors and reports how complete it is | S      | High   | SDK                    |
| 3   | Lint the script before it runs (static `import`, missing `await`, `.status()`) | S      | High   | SDK (`run.ts`)         |
| 4   | `page.waitForSettled()` and `snapshot({ settle })` for client-rendered pages | M      | High   | SDK                    |
| 5   | `page.read()` (article as Markdown, PDF text) and `page.tables()`            | M      | High   | SDK                    |
| 6   | One-shot CLI: `ego-browser read <url>`, `shot`, `tables`, `snapshot`, `search` | S      | High   | Linux host (+ SDK #5)  |
| 7   | Task-space TTL, `gc`, and page restore after a browser restart               | M      | Med-High | Linux host           |
| 8   | Safe hand-off on servers: refuse silent headless hand-off; virtual display + noVNC link | M | High (servers) | Linux host |
| 9   | `page.waitForResponse()` and `page.captureResponses()` return parsed bodies  | M      | Med-High | SDK                  |
| 10  | MCP server wrapper (`ego-browser mcp`) so any framework can call it          | M      | High (reach) | Linux host       |

Items 1 to 3 are small and stop the failures agents already hit. Items 4 to 6
remove the most hand-written code. Items 7 and 8 make a headless server safe to
leave running. Items 9 and 10 widen what agents can do and who can use it.

Just outside the top 10: surface site learnings in the v2 API, a `search()`
helper, profiles, safe secrets, a pipe instead of the DevTools port, a systemd
user service, and CI for the Linux host.

---

## 2. Evidence from measurement

Run on atlas (Ubuntu, Node 24, Chrome 150, headless, no display), private
`HOME`, current checkout through `--sdk-path`. One task space, reused.

| Task                                                      | Result                                                                  | Time      |
| --------------------------------------------------------- | ----------------------------------------------------------------------- | --------- |
| Cold start + `goto` Wikipedia article                     | OK                                                                      | 3.6 s     |
| Viewport snapshot of that article                         | 17,321 chars                                                            | 0.5 s     |
| Full-page snapshot of that article                        | **132,195 chars**                                                       | 2.1 s     |
| `innerText` of the article body                           | 19,325 chars                                                            | 3 ms      |
| Full-page screenshot                                      | OK                                                                      | 0.5 s     |
| Wikipedia `table.wikitable` to arrays via `evaluate`      | OK, but header and spacer rows need hand clean-up                       | 6 ms      |
| w3schools table to arrays                                 | OK                                                                      | 2.2 s     |
| Google search                                             | Redirected to `/sorry/` (bot check)                                     | 2.3 s     |
| DuckDuckGo HTML search                                    | Bot challenge page                                                      | 0.3 s     |
| Bing search                                               | 10 results                                                              | 1.1 s     |
| `quotes.toscrape.com/js-delayed` + snapshot at once       | 19 lines, **0 quotes, no warning**                                      | 1.1 s     |
| Same with `waitUntil: "networkidle"`                      | **0 quotes**: network was idle while the timer ran                      | 1.1 s     |
| Same with `waitForSelector(".quote")`                     | 5 quotes                                                                | 10.5 s    |
| Infinite scroll (`/scroll`) with `mouse.wheel` x4         | 0 → 100 quotes                                                          | 6.6 s     |
| BBC News snapshot right after `goto`                      | **Throws** "Page changed during snapshot; take a new snapshot"          | 1.1 s     |
| PDF opened with `goto`, then snapshot                     | Snapshot is just `iframe`, **no text**                                  | 0.6 s     |
| PDF saved with `page.fetch(..., { saveAs })`              | OK (status 200, `application/pdf`)                                      | 7 ms      |
| httpbin form: fill, click, wait                           | OK                                                                      | 0.8 s     |
| `goto` to an HTTP 404 with an empty body                  | **Throws** `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, no status, no hint     | 0.3 s     |
| Click on a missing element                                | Times out with "matched 0 elements", no next step                        | 3.3 s     |
| `String(page.url())` without `await`                      | `[object Promise]`, no warning                                          | 0 ms      |
| CDP `Network.enable` + one `goto` + `page.events()`       | **879 raw events**; agent must filter and fetch bodies itself           | 0.8 s     |
| Data-URL download with `waitForEvent("download")`         | OK                                                                      | 0.1 s     |
| `task.handOff()` while headless                           | Returns `undefined`, no warning. Space is now stuck (see below)          | 3 ms      |
| `ego-browser close 1` after that hand-off                 | **Refused**: `EGO_TASK_SPACE_USER_IN_CONTROL`. `close --all` skips it    | –         |
| `ego-browser stop`, then `taskSpace(1)`                   | Space resumes with **0 pages, 0 tabs**; `p1` and its URL are gone        | 0.5 s     |
| Headless browser identity                                 | UA contains `HeadlessChrome`; `navigator.webdriver` is `true`            | –         |

What this shows:

- A full-page snapshot costs about 7 times the tokens of the page's text. For
  reading, agents need a text or Markdown view, not the accessibility tree.
- `networkidle` is not a "content is ready" signal. A page that renders on a
  timer, or polls, fools it both ways.
- Several failures are silent (empty SPA snapshot, missing `await`, headless
  hand-off). Silent failures cost the most rounds, because the agent trusts
  the wrong answer.
- Big search engines block the headless browser. An agent that treats
  ego-browser as its main way online needs a search path that works, and an
  honest "blocked, hand off or use another source" signal when it does not.
  This roadmap does not propose hiding automation from sites.

---

## 3. Proposals

Each proposal lists: problem, evidence, API shape, files, tests, effort, risk,
and upstream divergence. "Upstream" means the closed macOS and Windows app. The
SDK in `package/ego-browser` is shared with it; the Linux host is ours alone.

"Diverges: no" means the change is SDK-only and works on every host, or is
Linux-host-only and changes no contract. "Diverges: yes" means the SDK would
need a new `globalThis.ego` binding or behaviour the upstream app does not have
yet.

### Reliability primitives

#### P1. Errors with a next step (top 10 #1)

**Problem.** Errors say what failed, not what to do. Agents then retry blindly,
open a new task space, or give up.

**Evidence.** `goto` to a 404 with an empty body throws
`page.goto failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE`. The agent cannot see
the status. A missing element throws "matched 0 elements" with no hint to
snapshot again. A stale connection after a daemon restart gives no recovery
hint (reported by agents). An agent assumed `goto()` returned a response with
`.status()`.

**API.** Every SDK error keeps `error_code` and gains `hint` (one sentence, an
imperative). `runMain()` prints the hint on its own line after the stack.

```text
Error: page.goto failed: HTTP 404 Not Found (empty body)
  error_code: EGO_NAVIGATION_HTTP_ERROR
  status: 404
  hint: The server answered 404. Check the URL. To read the status without
        navigating, use await page.fetch(url).
```

```js
try {
  await page.goto(url);
} catch (error) {
  console.log(error.error_code, error.status, error.hint);
}
```

Suggested hints:

| error_code / message                       | hint                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `EGO_NAVIGATION_HTTP_ERROR` (new)          | Check the URL; use `page.fetch(url)` for the status and body.                                |
| `EGO_ELEMENT_NOT_FOUND` (0 matches)        | Take a new snapshot; the page may have changed or not rendered yet. Use a ref or `loc=`.     |
| `EGO_ELEMENT_AMBIGUOUS` (many matches)     | Use a ref from a fresh snapshot, add `>> nth=N`, or use a more exact `loc=role:` name.        |
| stale ref                                  | Refs last one page state. Take a new snapshot and use the new ref.                           |
| `EGO_BROWSER_UNAVAILABLE`                  | Run `ego-browser stop`, then rerun this script. If it fails again, read the daemon log at `<path>`. |
| `EGO_TASK_SPACE_USER_IN_CONTROL`           | Stop. Tell the user what to finish, then resume with `takeOverTaskSpace(id)` after they confirm. |
| page label not found                       | Already good. Add: "After a browser restart, pages are gone; call `await task.newPage()`."   |
| `page.goto` net::ERR_NAME_NOT_RESOLVED etc | Check the host name and network. Do not retry more than once.                                |
| timeout in `waitFor*`                      | Print a snapshot or screenshot to see what the page shows instead.                            |

To get the status for `ERR_HTTP_RESPONSE_CODE_FAILURE`, read
`Network.responseReceived` for the main frame, which the navigation wait
already listens to.

**Where.**
- `package/ego-browser/src/ego-errors.ts`: add `hint`, `status` and a
  `withHint(code, message, hint)` factory.
- `package/ego-browser/src/driver/page-waits.ts` (line ~458,
  `page.goto failed`): attach the main-frame status.
- `package/ego-browser/src/element-resolver.ts`: hints on
  `ElementResolutionError`.
- `package/ego-browser/src/run.ts`: print `hint` after the error.
- `package/ego-host-linux/src/errors.mjs`: pass `hint` through from the daemon.

**Test.** Unit tests per error in `ego-errors.test.mjs` and
`element-resolver.test.mjs`. In `real-browser-fixture.test.mjs`, add a fixture
route that returns 404 with an empty body and assert `status === 404` and a
non-empty `hint`.

**Effort:** S. **Risk:** low; additive fields. **Diverges:** no (SDK only).

#### P2. Snapshot retry and a completeness signal (top 10 #2)

**Problem.** A snapshot can fail on a busy page, or succeed with almost
nothing in it, and the agent cannot tell.

**Evidence.** BBC News threw "Page changed during snapshot" right after
`goto`. The delayed-quotes page gave 19 lines and no quotes, with no warning.
Agents reported an empty single-page-app snapshot as "no data".

**API.** The snapshot retries the transient "page changed" case up to 3 times
with a short back-off (about 250 ms) before it throws. The header line gains a
`stats` part and, when the page looks unfinished, a `warning` line.

```text
[p1 "quotes.toscrape.com/js-delayed/" | space "research"(4): 1 managed — p1*]
[stats nodes=18 refs=3 text=212 readyState=complete pendingRequests=0 domChanging=yes]
[warning page may still be rendering: the DOM changed in the last 500 ms and the
 snapshot has little text. Wait for the content (waitForSelector or
 waitForSettled), then snapshot again.]
```

`page.snapshot({ format: "object" })` returns the same as data:

```js
const snap = await page.snapshot({ format: "object" });
// { text, stats: { nodes, refs, textChars, readyState, domChanging, pendingRequests }, warnings: [] }
```

Heuristics for the warning (cheap, no extra round trip): `readyState` is not
`complete`; fewer than N text characters for a page with a large DOM; or a
`MutationObserver` saw changes in the last 500 ms. Keep the default output a
string, so old scripts still work.

**Where.** `package/ego-browser/src/page-model.ts` (where "Page changed during
snapshot" is raised), `src/snapshot-result.ts` (header and stats),
`src/driver/observe.ts`, and `src/public-api-schema.ts` (`format` option).

**Test.** `page-model.test.mjs`: a fake that changes once, then succeeds,
must return a snapshot; one that always changes must throw after 3 tries.
`snapshot-result.test.mjs`: header with stats and warning. Real-browser
fixture: a page that renders rows after 1.5 s must produce the warning when
snapped at once, and none after `waitForSelector`.

**Effort:** S (retry), S-M (stats and warning). **Risk:** low; a false warning
costs one extra wait. **Diverges:** no for the retry. The stats can be computed
in the page with `Runtime.evaluate`, so no new binding is needed.

#### P3. Lint the script before it runs (top 10 #3)

**Problem.** The same mistakes recur, and each one costs a round.

**Evidence.** Agents used a static `import`, forgot `await` on `url()`, and
read `.status()` from a `goto()` receipt. The guide already warns about all
three, so docs alone are not enough.

**API.** `runMain()` parses the script with acorn (already a dependency of
`help-runtime.ts`) before it runs and prints warnings to stderr. It never
blocks, except for the static-import case, which already fails: there it
replaces the raw `SyntaxError` with a clear message.

```text
[ego-browser:lint] line 1: static "import" does not work here. Write
  const fs = await import("node:fs/promises");
[ego-browser:lint] line 7: page.url() returns a Promise. Write await page.url().
[ego-browser:lint] line 4: goto() returns an action receipt, not a response; it
  has no status(). Use await page.fetch(url) for a status.
[ego-browser:lint] line 9: "document" is not defined in the script. Put page code
  inside page.evaluate(() => ...).
[ego-browser:lint] line 2: taskSpace("...") without printing task.spaceId. Print
  it so the next round can resume this space.
```

Rules (each is a small AST check):

1. `ImportDeclaration` at top level.
2. A call to a known Page or TaskSpace async method (from
   `public-api-schema.ts`) whose result is not awaited, returned, or assigned
   to a variable that is later awaited.
3. Member access `.status`, `.status()`, `.ok()`, `.json()` on a value that came
   from `goto()` or `reload()`.
4. Free identifiers `window`, `document`, `location` outside an `evaluate`,
   `waitForFunction` or `addInitScript` callback.
5. Playwright-only names: `locator`, `getByRole`, `getByText`, `expect`,
   `route`, `context`, `$`, `$$`.
6. A new `taskSpace(name)` call in a script that never mentions `spaceId`.
7. `require(` (CommonJS) in the script.

Turn off with `// ego-browser-lint-disable` on the first line.

**Where.** New `package/ego-browser/src/script-lint.ts`; call it from
`src/run.ts` before `new AsyncFunction`. Method lists come from
`src/public-api-schema.ts`, so they stay in sync.

**Test.** New `src/script-lint.test.mjs` with one good and one bad script per
rule, plus "no false positive" cases (`const u = page.url(); await u;`).
`run-output-sink.test.mjs` asserts warnings go to stderr, not stdout.

**Effort:** S. **Risk:** low; warnings only. False positives are the main risk;
keep rules narrow. **Diverges:** no.

#### P4. A "settled" wait for client-rendered pages (top 10 #4)

**Problem.** `goto()` returns at `load`. On single-page apps the content comes
later. `networkidle` is not a good signal: some apps never go quiet, and some
render on a timer with no network at all.

**Evidence.** `js-delayed` with `networkidle` gave 0 quotes. Agents took a
snapshot of a SPA too early and saw no rows.

**API.**

```js
await page.goto(url);
await page.waitForSettled({ timeout: 15_000 }); // DOM quiet + no pending fetch/XHR
console.log(await page.snapshot());

// Or in one call:
console.log(await page.snapshot({ settle: true }));            // default quiet window 500 ms
console.log(await page.snapshot({ settle: { quietMs: 800, timeout: 20_000 } }));

// When the agent knows what it needs, a content wait is still best:
await page.waitForSettled({ until: "loc=role:row", minCount: 5 });
```

Definition of settled: `readyState === "complete"`, no DOM mutations for
`quietMs`, no in-flight fetch/XHR started by the page (tracked through
`Network.requestWillBeSent` / `loadingFinished`, ignoring long-poll, WebSocket
and EventSource), and, when `until` is given, at least `minCount` matches.
It resolves with what it saw, so the agent learns why it stopped:

```js
// { settled: true, waitedMs: 1840, mutationsSeen: 212, pendingRequests: 0 }
// or on timeout (no throw by default): { settled: false, reason: "dom still changing", ... }
```

It does not throw on timeout by default. A busy page that never settles should
still give a snapshot, with the P2 warning.

**Where.** `package/ego-browser/src/driver/page-waits.ts` (new
`waitForSettled`), `src/page-model.ts` (Page method),
`src/driver/observe.ts` (`settle` option), `src/public-api-schema.ts`, and
`skill-body/SKILL.md`.

**Test.** Real-browser fixtures: rows after a 1.5 s timer; rows after a fetch;
a page that polls every 200 ms forever (must return `settled: false` at the
timeout, not hang); a static page (must return in under `quietMs + 100 ms`).
Unit tests for the request bookkeeping with a fake event stream.

**Effort:** M. **Risk:** medium; timing heuristics need tuning on real sites.
**Diverges:** no; built on existing CDP and `Runtime.evaluate`.

#### P5. Idempotent rounds and crash resume (part of top 10 #7)

**Problem.** Each round is a new process. If a round dies half-way, the agent
cannot tell which steps ran. If the daemon or browser restarts, the task space
survives but its pages do not.

**Evidence.** After `ego-browser stop` and a new run, `taskSpace(1)` resumed
with 0 pages and 0 tabs; `task.page("p1")` threw. The URL that `p1` was on is
lost. Task spaces piled up after failed runs (reported).

**API.**

```js
// 1. Restore pages after a restart. Opt-in so nothing surprising happens.
const task = await taskSpace(7, { restorePages: true });
// p1 is reopened at its last committed URL. Printed:
// [ego-browser] browser restarted; reopened p1 at https://example.com/list (form state is lost)

// 2. Record progress inside the space, so a re-run can skip finished steps.
const done = await task.memo("exported-report"); // undefined the first time
if (!done) {
  await exportReport(page);
  await task.memo("exported-report", { at: Date.now(), file: "/abs/report.csv" });
}
```

`task.memo(key, value?)` is a small JSON store kept with the task space by the
host, cleared by `finish()`. It lets a round be safely re-run.

The host keeps, per task space: page labels, last committed URL, title, and
`memo` entries, in `spaces.json`. On daemon start it marks spaces whose tabs
are gone as `stale` instead of silently empty.

**Where.** `package/ego-host-linux/src/task-spaces.mjs` (store URLs and
memos, mark stale), `src/daemon.mjs` (on start), `src/ego-bindings.mjs` (new
binding for memo), `package/ego-browser/src/page-model.ts` (TaskSpace
`restorePages` and `memo`).

**Test.** `task-spaces.test.mjs`: restart the registry from disk and assert
labels and URLs survive. Real-browser test on Linux: open `p1`, stop the
daemon, resume with `restorePages`, assert `await page.url()`.

**Effort:** M. **Risk:** medium; reopening a URL can re-submit a GET with side
effects, so it is opt-in and never replays POST. **Diverges:** yes for
`memo` (new binding) and `restorePages`. Propose both upstream; until then the
SDK should feature-detect the binding and throw a clear "not supported on this
host" error.

#### P6. Automatic retries, kept narrow

**Problem.** Agents retry everything by hand, or nothing.

**Proposal.** Retry only what is safe and transient, inside the SDK:

- snapshot "page changed" (P2);
- element resolution with `kind: "transient"` until the action timeout
  (already done; document it);
- CDP session lost: re-attach once (already done in `browser-runtime.ts`);
- control socket closed at the start of a round: reconnect once (already done
  in the Linux CLI).

Never auto-retry a click, a fill, a submit or a navigation that may have
committed: these can have side effects. Instead, report `mayHaveLateEffects`
(already present on `evaluate`) on action timeouts too.

**Where.** `src/driver/page-actions.ts` (add `mayHaveLateEffects` to action
timeouts), docs.

**Effort:** S. **Risk:** low. **Diverges:** no.

### Extraction

#### P7. `page.read()`: readable article as Markdown, and PDF text (top 10 #5)

**Problem.** Reading is the most common agent job. Today the agent either
prints a huge snapshot or writes its own `innerText` code each time, which
drops links and structure.

**Evidence.** Full-page snapshot of a Wikipedia article: 132,195 chars.
`innerText` of the body: 19,325 chars. A PDF opened with `goto` gives a
snapshot that is only `iframe`.

**API.**

```js
const doc = await page.read();
// {
//   url, title, byline?, published?, lang,
//   markdown: "# Web browser\n\nA **web browser** is ...",
//   links: [{ text, href }],          // absolute URLs, de-duplicated
//   words: 3120,
//   truncated: false,
//   source: "article" | "main" | "body" | "pdf"
// }
console.log(doc.markdown);

await page.read({ maxChars: 20_000 });          // cut at a heading boundary, set truncated
await page.read({ mode: "full" });              // whole body, not just the main article
await page.read({ selector: "#mw-content-text" });
```

For a PDF URL (or a page whose main frame is a PDF), `read()` fetches the
bytes with `page.fetch()` and extracts text with a bundled `pdfjs-dist`,
returning `source: "pdf"` and per-page text:

```js
const pdf = await page.read(); // on .../report.pdf
// { source: "pdf", pages: [{ n: 1, text }], markdown: "## Page 1\n\n..." }
const local = await readPdf("/abs/path/file.pdf"); // a global helper for downloaded files
```

Implementation: inject a small, bundled Readability-style extractor (for
example Mozilla Readability, Apache-2.0) and a DOM-to-Markdown converter
(Turndown, MIT) into an isolated world through `Page.createIsolatedWorld`, so
page scripts cannot interfere.

**Where.** New `package/ego-browser/src/extract/read.ts` and
`src/extract/pdf.ts`; Page method in `src/page-model.ts`; schema in
`src/public-api-schema.ts`; bundling in `scripts/build.mjs` (check the size of
`dist/out/index.js` after adding pdf.js; load it lazily with a dynamic import).

**Test.** Fixtures in the real-browser server: an article with nav, ads and a
footer (assert they are dropped); a page with no `<article>`; a two-page PDF;
a 1 MB page with `maxChars` (assert cut at a heading). Snapshot-test the
Markdown output.

**Effort:** M. **Risk:** low for HTML, medium for bundle size (pdf.js is
large; keep it in a lazy chunk). **Diverges:** no; pure SDK.

#### P8. `page.tables()` to JSON and CSV

**Problem.** Tables are the second most common extraction. Hand code misses
`rowspan`, `colspan`, header rows and hidden cells.

**Evidence.** The Wikipedia table came out with a header row of
`["Web browser","Market share","show\nReference"]` and an empty spacer row.

**API.**

```js
const tables = await page.tables();
// [{ index, caption, selector, headers: ["Browser", "Share"], rows: [{ Browser: "Chrome", Share: "65%" }] }]

const t = await page.tables({ selector: "table.wikitable", index: 0 });
await page.tables({ index: 0, saveAs: "/abs/out/share.csv" }); // also writes CSV
```

Also detect ARIA grids (`role=grid`, `role=table`) used by apps that draw
tables with `div`s.

**Where.** `package/ego-browser/src/extract/tables.ts`, `src/page-model.ts`,
`src/public-api-schema.ts`.

**Test.** Fixtures: `rowspan`/`colspan`, two header rows, `role=grid` with
`div`s, numbers with thousands separators kept as text.

**Effort:** S-M. **Risk:** low. **Diverges:** no.

#### P9. Structured data and full-page screenshots

- `page.structuredData()` returns JSON-LD, OpenGraph, `meta` description,
  canonical URL and microdata. Cheap and very useful for research. Effort S.
  File: `src/extract/structured.ts`.
- `page.screenshot({ fullPage: true })` already works (0.5 s on Wikipedia).
  Add `maxHeight` (default 16,000 CSS px) and split very long pages into
  tiles (`{ tiles: true }` returns several paths), because image tools reject
  huge images. Effort S. File: `src/driver/observe.ts`.

**Diverges:** no.

#### P10. A `search()` helper with an honest result

**Problem.** "Search the web" is step one of most research. Google returned
its `/sorry/` page and DuckDuckGo returned a bot challenge on the headless
host. Bing worked. The bundled `google/search_and_extract` site tool would
return `[]` silently in that case.

**API.**

```js
const results = await page.search("rust async runtime comparison", { engine: "auto", max: 10 });
// { engine: "bing", query, results: [{ rank, title, url, snippet }], blocked: [] }
// When an engine shows a bot check:
// { engine: "google", results: [], blocked: [{ engine: "google", url: ".../sorry/...", hint: "This engine
//   asked for a human check. Try engine: 'bing', or hand off to the user." }] }
```

`engine: "auto"` tries the user's configured engine, then the next one, and
always reports any block. It never tries to solve or hide from a bot check.
On a visible browser (P13), a block can be handed to the user like any other
CAPTCHA.

**Where.** New learning `skills/ego-browser/learnings/bing/` plus a small
SDK wrapper `src/extract/search.ts` that calls the site tools; update
`learnings/google/tools/search-extract.js` to detect `/sorry/` and throw a
`EGO_SITE_BLOCKED` error with a hint.

**Test.** `validate:site-skills`; unit tests with saved HTML fixtures of each
engine's results page and of a block page.

**Effort:** M. **Risk:** medium; result-page markup changes often, so keep the
selectors in learnings, not in SDK code. **Diverges:** no.

### Navigation and interaction

#### P11. Cookie and consent banners

**Problem.** Banners cover content and steal clicks. Every agent writes its
own "find the Accept button" code, and many accept tracking by default.

**API.**

```js
const r = await page.dismissConsent();               // prefers "Reject all" / "Necessary only"
// { found: true, action: "reject", framework: "onetrust", clicked: "Reject All" }
await page.dismissConsent({ prefer: "accept" });     // only when the user asked for it
```

Match known frameworks first (OneTrust, Cookiebot, Didomi, Quantcast, TrustArc,
Usercentrics, Sourcepoint iframes), then a text fallback on buttons inside a
dialog-like container. Default to the privacy-preserving choice.

**Where.** New learning `skills/ego-browser/learnings/_consent/` (data-driven
selectors), wrapper in `src/extract/consent.ts`.

**Test.** Fixtures copying each framework's markup; a page with no banner
(must return `found: false` fast).

**Effort:** M. **Risk:** medium; selectors drift. **Diverges:** no.

#### P12. Infinite scroll and pagination

**Evidence.** `/scroll` went from 0 to 100 items with four `mouse.wheel`
calls and fixed sleeps: it works, but the agent has to write the loop and
guess when to stop.

**API.**

```js
const r = await page.scrollToLoad({
  itemSelector: ".quote",
  maxItems: 200,
  maxScrolls: 30,
  idleMs: 1500,      // stop when no new items appear for this long
});
// { items: 100, scrolls: 9, stoppedBecause: "no new items" }

for await (const p of page.paginate({ next: "loc=role:link[name='Next']", maxPages: 5 })) {
  rows.push(...(await p.tables())[0].rows);
}
```

**Where.** `src/driver/scroll-motion.ts` (reuse wheel motion),
`src/page-model.ts`.

**Test.** Fixture with lazy-loaded items and a fixture with "Next" links.

**Effort:** S-M. **Risk:** low. **Diverges:** no.

#### P13. Wait for and capture network responses (top 10 #9)

**Problem.** Many SPAs load their data from a JSON API. Reading that JSON is
faster and more exact than scraping the DOM. Today the agent must enable
`Network`, sift raw events and call `Network.getResponseBody` itself.

**Evidence.** One `goto` with `Network.enable` gave 879 raw events.

**API.**

```js
// Arm before the action, like waitForEvent.
const resp = page.waitForResponse(/\/api\/search/, { timeout: 15_000 });
await page.fill("loc=role:searchbox", "laptops");
await page.press("loc=role:searchbox", "Enter");
const r = await resp;
// { url, status, headers, mimeType, json?, text?, fromCache }
console.log(r.json.items.length);

// Collect many while doing something.
const cap = await page.captureResponses({ match: /graphql/, maxBodies: 50 });
await page.scrollToLoad({ itemSelector: "article", maxItems: 100 });
const responses = await cap.stop(); // [{ url, status, json }]
```

Bodies are kept in memory up to a size cap (default 2 MB each, 20 MB total)
and dropped after the round.

**Where.** `src/browser-runtime.ts` (event subscription),
`src/driver/page-waits.ts` (`waitForResponse`), new
`src/driver/network-capture.ts`, schema, Skill.

**Test.** Fixture page that fetches `/api/items` after a click; assert parsed
JSON. Test the size caps and that capture stops at `stop()`.

**Effort:** M. **Risk:** low-medium (memory). **Diverges:** no; uses
`page.cdp` paths that already exist.

#### P14. Multiple tabs: small gaps

The tab model is good. Two gaps:

- `task.pages()` after a restart returns `[]` with no reason (P5 fixes).
- No helper to run the same extraction across many URLs in parallel. Add
  `task.map(urls, async (page, url) => ..., { concurrency: 3 })`, which opens
  up to N Pages, reuses them, and closes them after. Effort S. File:
  `src/page-model.ts`. Diverges: no.

### Identity

#### P15. Profiles on Linux

**Problem.** One profile. Every task space shares the user's cookies. An agent
doing throwaway research and an agent doing signed-in banking share a jar.

**API.**

```bash
ego-browser profiles                  # list
ego-browser profiles create research  # new, empty profile
```

```js
const task = await taskSpace("price research", { profileId: "research" });
const temp = await taskSpace("one-off", { profileId: "ephemeral" }); // in-memory, deleted at finish()
```

On Linux, map a profile to a Chrome browser context
(`Target.createBrowserContext`) for `ephemeral`, and to a separate
`--user-data-dir` (a second Chrome process) for persistent named profiles.
The SDK already has `profiles` and `profileId`; this is host work.

**Where.** `package/ego-host-linux/src/daemon.mjs`, `browser-launcher.mjs`,
`task-spaces.mjs`, `paths.mjs`; CLI in `bin/ego-browser.mjs`.

**Test.** Cookies set in `ephemeral` are gone after `finish()`; two named
profiles do not share cookies.

**Effort:** M (ephemeral S). **Risk:** medium (several Chrome processes).
**Diverges:** no; implements an existing contract.

#### P16. Import cookies or logins

**Problem.** On a server, the user cannot log in through a window.

**API.**

```bash
# On the user's desktop: export cookies for named sites only.
ego-browser cookies export --sites github.com,notion.so > cookies.json
# On the server:
ego-browser cookies import --profile default < cookies.json
```

Use CDP `Storage.getCookies` / `Storage.setCookies`. Export only named sites.
Print a clear warning that the file holds live sessions. Never print cookie
values to stdout during a script round.

**Where.** `package/ego-host-linux/bin/ego-browser.mjs`, new
`src/cookies.mjs`.

**Effort:** S. **Risk:** high if misused (session theft); keep it explicit,
site-scoped, file mode 0600. **Diverges:** no (host CLI only).

#### P17. Safe secret handling

**Problem.** The guide says "never type secrets you were not given", but when
the user does give one, it ends up in the script text, the shell history, and
the model context.

**API.**

```bash
ego-browser secret set github-password      # reads from a TTY prompt, stores in the OS keyring or a 0600 file
```

```js
await page.fillSecret("loc=role:textbox[name='Password']", "github-password");
// The value never enters the script or its output. The receipt says { filled: true, secret: "github-password" }.
```

Output from `fill()` and `evaluate()` is not echoed, so the main leak is the
script text itself; `fillSecret` closes that. Bind each secret to allowed
origins (`--origin https://github.com`) so it cannot be typed into another
site.

**Where.** New `package/ego-host-linux/src/secrets.mjs`, binding in
`src/ego-bindings.mjs`, Page method in `package/ego-browser/src/page-model.ts`.

**Effort:** M. **Risk:** medium (secret storage). **Diverges:** yes (new
binding). Propose upstream; feature-detect in the SDK.

#### P18. Hand-off on headless servers (top 10 #8)

**Problem.** On a headless server the user cannot see the browser. Today
`task.handOff()` returns as if it worked.

**Evidence.** `handOff()` while headless returned `undefined` with no
warning. The space became `agentDelegatedToUser`. `ego-browser close 1`
then refused with `EGO_TASK_SPACE_USER_IN_CONTROL`, and `close --all`
skipped it. Only `takeOverTaskSpace(1)` then `finish()` cleared it. A user on
a headless server cannot complete a login hand-off (reported).

**Proposal, in three steps.**

1. **Refuse a silent hand-off (S).** When the browser is headless and no
   viewer is running, `handOff()` throws `EGO_HANDOFF_NO_DISPLAY` with the
   hint: "No one can see this browser. Start a viewer with `ego-browser
   view`, or ask the user to import cookies (`ego-browser cookies import`)."
   Also let `ego-browser close <id>` close a delegated space when headless and
   no viewer is attached.

2. **Visible mode on servers (M).** `ego-browser start --display virtual` runs
   Chrome headful on `Xvfb` (present on atlas at `/usr/bin/Xvfb`). Then
   `ego-browser view` starts `x11vnc` bound to `127.0.0.1` plus
   `websockify`/noVNC, and prints a one-time link:

   ```text
   $ ego-browser view
   Viewer: http://127.0.0.1:6080/vnc.html?autoconnect=1&password=<one-time>
   From your laptop: ssh -L 6080:127.0.0.1:6080 hermes@atlas, then open the link.
   The viewer stops after 30 minutes or when the hand-off ends.
   ```

   `handOff()` returns `{ viewer: "<link>" }` so the agent can pass it on.
   Bind only to localhost; never expose it on a public interface by default.
   A real headful Chrome is also what sites expect, so fewer bot checks fire.

3. **Screenshot relay (S, fallback).** When no viewer is possible,
   `handOff({ relay: true })` writes a screenshot and the snapshot to a
   folder and returns their paths. The agent shows the image to the user, the
   user says what to click or type, and the agent does it. Slow, but it works
   for a simple consent or 2FA code. It must not be used to type a password
   the user did not hand over (P17 covers that).

**Where.** `package/ego-host-linux/src/browser-launcher.mjs` (`Xvfb`
start, `--display`), new `src/viewer.mjs` (x11vnc + websockify lifecycle),
`src/task-spaces.mjs` (`handOffTaskSpace` checks for a viewer),
`bin/ego-browser.mjs` (`view` command), `scripts/install.sh` (optional
`xvfb x11vnc novnc` packages), docs.

**Test.** Unit: `handOff` throws when headless and no viewer. Integration on
atlas: start `--display virtual`, `view`, connect with a VNC client from the
test, take a screenshot through VNC and compare to `page.screenshot()`.

**Effort:** S (step 1), M (step 2), S (step 3). **Risk:** medium (a remote
desktop is a security surface: localhost only, one-time password, timeout).
**Diverges:** step 1 no (host only); `{ viewer }` in the `handOff()` result is
an additive field upstream can ignore.

### Operations

#### P19. Observability and logs

**Problem.** When a run fails, the only log is `daemon.log`, which has the
browser start line and little else. The agent cannot see what a past round
did.

**API.**

```bash
ego-browser logs              # last 50 events from the daemon and recent rounds
ego-browser logs --space 7    # one task space: rounds, actions, errors, durations
ego-browser logs --follow
```

Each round appends one JSON line per action to
`~/.local/state/ego-lite/rounds/<spaceId>.jsonl`:
`{ ts, round, page, action, target, ms, ok, error_code }`. No page content,
no typed values.

**Where.** `package/ego-browser/src/output-sink.ts` (action events),
`package/ego-host-linux/src/daemon.mjs` (writer), `bin/ego-browser.mjs`.

**Effort:** S-M. **Risk:** low (keep values out). **Diverges:** no if the
host writes the log; the SDK only needs to emit events through an existing
channel.

#### P20. Task-space TTL and garbage collection (part of top 10 #7)

**Problem.** Spaces pile up after failed runs. A failed run leaves its space
open on purpose so it can resume, but nothing ever closes it.

**API.**

```js
const task = await taskSpace("scrape prices", { ttlMs: 2 * 60 * 60_000 }); // default 24 h for agent spaces
```

```bash
ego-browser gc                 # close agent spaces idle longer than their TTL
ego-browser gc --dry-run
```

The daemon runs `gc` every 10 minutes. It never closes user-owned or
user-controlled spaces, and never closes a space with an unmanaged tab. A
delegated space whose hand-off cannot complete (headless, no viewer) gets its
own short TTL (1 h) and returns to the agent.

**Where.** `package/ego-host-linux/src/task-spaces.mjs` (last-activity time,
TTL), `src/daemon.mjs` (timer), `bin/ego-browser.mjs` (`gc`).

**Test.** `task-spaces.test.mjs` with a fake clock.

**Effort:** S. **Risk:** low-medium (closing work an agent planned to
resume; mitigated by TTL refresh on every round). **Diverges:** `ttlMs` is a
new option; the SDK should pass it only when the host says it supports it.

#### P21. Limits on concurrent agents and a resource budget

**Problem.** One daemon serves every agent on the box. Ten agents each opening
five tabs on a small server will run out of memory and the browser will crash
for all of them.

**Proposal.** Daemon-wide limits in `~/.config/ego-lite/config.json`:

```json
{ "maxTaskSpaces": 8, "maxPagesPerSpace": 6, "maxTotalPages": 24, "maxRssMb": 3072 }
```

When a limit is hit, `taskSpace()` or `newPage()` throws
`EGO_RESOURCE_LIMIT` with a hint ("Close Pages you no longer need, or run
`ego-browser gc`"). `ego-browser status` shows the use against the limits.
Watch total Chrome RSS through `SystemInfo.getProcessInfo` and refuse new pages
above the cap.

**Where.** `package/ego-host-linux/src/daemon.mjs`, `task-spaces.mjs`,
new `src/config.mjs`.

**Effort:** S-M. **Risk:** low. **Diverges:** no (the SDK already reports a
page budget).

#### P22. systemd user service

```bash
ego-browser service install   # writes ~/.config/systemd/user/ego-lite.service and enables it
ego-browser service status
```

The unit runs `ego-browser daemon` with `Restart=on-failure`, `MemoryMax=`
from the config, and `loginctl enable-linger` advice for servers. With P5 the
spaces come back after a restart.

**Where.** `package/ego-host-linux/bin/ego-browser.mjs`, a template in
`package/ego-host-linux/share/ego-lite.service`, `scripts/install.sh`.

**Effort:** S. **Risk:** low. **Diverges:** no.

#### P23. Packaging: .deb and arm64

- Build a `.deb` from `package/ego-host-linux` with `nfpm` in CI. Depends on
  `nodejs (>= 22)`; recommends `chromium | google-chrome-stable`, `xvfb`,
  `x11vnc`, `novnc`.
- arm64: Chrome for Testing has no Linux arm64 build. On arm64 the installer
  must use the distro `chromium` (not the snap) or Playwright's arm64
  Chromium. Add that branch to `scripts/install.sh` and test on an arm64
  runner.

**Effort:** M. **Risk:** low. **Diverges:** no.

#### P24. CI on ubuntu-latest

**Evidence.** `.github/workflows/ci.yml` runs on `ubuntu-latest` but only in
`package/ego-browser`. It does not run `package/ego-host-linux` unit tests,
and it does not run the real-browser E2E suite against the Linux host.

**Proposal.** Add a job `linux-host`: `npm ci && npm test` in
`package/ego-host-linux`; install Chrome with `browser-actions/setup-chrome`;
start the host with a temporary `HOME`; run `npm run e2e` in
`package/ego-browser` with `--sdk-path`. Upload `daemon.log` on failure.

**Where.** `.github/workflows/ci.yml`.

**Effort:** S. **Risk:** low (E2E flakiness; retry once). **Diverges:** no.

#### P25. DevTools pipe instead of a port

**Evidence.** README: "The DevTools port listens on 127.0.0.1. Other local
users of the same machine could connect to it." On a shared server (atlas is
shared) any local user could take over the agent's signed-in browser.

**Proposal.** Launch Chrome with `--remote-debugging-pipe` and talk CDP over
file descriptors 3 and 4 from the daemon (null-byte framed JSON). Remove
`--remote-debugging-port=0` and `--remote-allow-origins`. Keep the port as an
opt-in (`EGO_LITE_DEVTOOLS=port`) for debugging.

**Where.** `package/ego-host-linux/src/browser-launcher.mjs` (spawn with
`stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]`),
`src/cdp-connection.mjs` (a pipe transport next to the WebSocket one).

**Test.** `cdp-connection` unit test with a fake pipe; existing E2E must pass
unchanged.

**Effort:** S-M. **Risk:** low-medium (all CDP goes through one transport;
test it well). **Diverges:** no. **Priority:** high on shared machines; do it
in phase 2 at the latest.

### Agent ergonomics

#### P26. `help()` return types

**Problem.** `help("page.goto")` shows options but the return type is buried
in prose. Agents guess return shapes (for example `.status()`).

**Proposal.** Add a `returns` field to every entry in
`public-api-schema.ts` and print it as its own line:

```text
page.goto(url, { referer?, timeout?, waitUntil? })
  returns: Promise<ActionReceipt>  // { popups?: { label, targetId }[], dialog? }. Not an HTTP response.
```

Add a test that every entry has `returns`.

**Where.** `src/public-api-schema.ts`, `src/help-runtime.ts`,
`src/public-api-schema.test.mjs`.

**Effort:** S. **Risk:** none. **Diverges:** no.

#### P27. One-shot commands (top 10 #6)

**Problem.** Half of agent web use is "read this URL" or "look at this page".
That takes a heredoc, a task space, `goto`, extraction, and `finish()`, and
leaves a space behind if any step throws.

**CLI.**

```bash
ego-browser read https://example.com/post            # Markdown to stdout (P7)
ego-browser read https://example.com/report.pdf      # PDF text
ego-browser read --json https://example.com/post     # the full page.read() object
ego-browser shot https://example.com --full -o /abs/shot.png
ego-browser tables https://en.wikipedia.org/wiki/X --csv -o /abs/dir/
ego-browser snapshot https://example.com             # settled snapshot (P4)
ego-browser search "query" --json                    # P10
```

Each command uses a throwaway task space in the `ephemeral` profile by default
(`--profile default` to use logins), waits for settled (P4), and always
finishes the space, even on error. Exit codes: 0 ok, 3 blocked by a bot check,
4 HTTP error, 5 timeout.

**Where.** `package/ego-host-linux/bin/ego-browser.mjs` (commands), which runs
a short built-in script through the same `runMain()` path.

**Test.** CLI tests against the fixture server: output, exit codes, and "no
space left behind" after a forced error.

**Effort:** S once P7 exists (the commands are thin). **Risk:** low.
**Diverges:** the commands are host-only. Upstream can add the same names
later; the scripts they run are plain SDK calls.

#### P28. MCP server wrapper (top 10 #10)

**Problem.** Only agents with a shell can use ego-browser. Many frameworks
(Claude Desktop, IDE agents, hosted agent builders) speak MCP and have no
shell.

**CLI.** `ego-browser mcp` runs an MCP server on stdio.

Tools (small, typed, each maps to SDK calls):

| Tool                 | Input                                               | Output                                 |
| -------------------- | --------------------------------------------------- | -------------------------------------- |
| `browser_read`       | `url`, `maxChars?`                                  | Markdown, title, links                 |
| `browser_open`       | `url`, `space?`                                     | `space`, `page`, settled snapshot      |
| `browser_snapshot`   | `space`, `page`, `scope?`                           | snapshot text                          |
| `browser_act`        | `space`, `page`, `action` (click/fill/press/select), `target`, `value?` | receipt + new snapshot |
| `browser_screenshot` | `space`, `page`, `fullPage?`                        | image content                          |
| `browser_tables`     | `space`, `page` or `url`                            | JSON tables                            |
| `browser_run`        | `space`, `script`                                   | stdout, stderr (the full escape hatch) |
| `browser_handoff`    | `space`, `reason`                                   | viewer link or relay paths             |
| `browser_finish`     | `space`, `keep?`                                    | ok                                     |

Use `@modelcontextprotocol/sdk`. The server keeps one control connection to
the daemon. Each `browser_run` uses the same `runMain()` path as the CLI.

**Where.** New `package/ego-host-linux/src/mcp-server.mjs`; `mcp` command in
`bin/ego-browser.mjs`; a ready config snippet in `docs/agent-onboarding.md`.

**Test.** Spawn the server in a test, call each tool with the MCP client SDK
against the fixture server.

**Effort:** M. **Risk:** low-medium (keeping tool output small; reuse P7 and
P2). **Diverges:** no (host only); upstream could ship the same server.

### Skills

#### P29. Make site learnings reachable from v2

**Evidence.** Neither `skills/ego-browser/SKILL.md` nor
`package/ego-browser/skill-body/SKILL.md` mentions `runSiteTool` or
learnings, so agents never use them. The Node tools use the v1 context
(`ctx.openOrReuseTab`), not a TaskSpace Page.

**API.**

```js
console.log(await siteTools("github.com"));        // names, args, returns from manifest.json
const repos = await page.site("github").run("search_repos", { query: "cdp", maxResults: 10 });
```

`page.site(id).run()` passes a v2 Page into the tool, so it works inside the
agent's task space. Keep v1 `runSiteTool` for old scripts.

**Where.** `src/learning/index.ts`, `src/page-model.ts`, manifests (add
`"api": 2`), `scripts/validate-site-skills.ts`.

**Effort:** M. **Diverges:** no.

#### P30. New learnings and recipes to add

Learnings (each `manifest.json` + `notes/` + tools):

- `bing` (search, the working default on headless; P10)
- `_consent` (P11)
- `wikipedia` (article, infobox, tables; the REST API at `/api/rest_v1`)
- `arxiv` and `scholar.archive.org` (paper metadata and PDF links)
- `reddit` (use the `.json` endpoints with `page.fetch`)
- `hn` (Algolia API)
- `youtube` (title, description, transcript panel)
- `linkedin`, `x-com` extensions (read-only, signed-in)
- `gov-forms` notes: how to fill long multi-step forms safely

Skill recipes (short sections in `skill-body/SKILL.md` or a
`references/recipes.md`): research a question with citations; extract a table
to CSV; watch a page for a change; QA a web app flow with screenshots; read a
PDF; capture a SPA's API JSON instead of scraping.

**Effort:** S each. **Diverges:** no.

---

## 4. Proposed doc edits

### 4.1 `docs/agent-onboarding.md`

Add to section 1, after the bullet list:

```markdown
For reading a page, prefer `await page.read()` (Markdown) over a full-page
snapshot. A full-page snapshot of a long article can be 7 times larger than
its text. Use a snapshot when you need refs to act on.
```

Replace the "App pages draw after they load" bullet in section 5 with:

```markdown
- **App pages draw after they load.** `goto()` returns when the page shell has
  loaded. Single-page apps draw their rows later, and `networkidle` does not
  wait for that. Before a snapshot, wait for the content you need:
  `await page.waitForSelector(".row")`. If you do not know the selector, use
  `await page.snapshot({ settle: true })`. If a snapshot prints a
  `[warning page may still be rendering]` line, wait and take it again.
```

Add to section 5:

```markdown
- **Read the hint.** Errors end with a `hint:` line. Do what it says before
  you try anything else.
- **Lint warnings are real.** Lines starting `[ego-browser:lint]` point at a
  bug in your script. Fix it before you read the rest of the output.
- **Search engines may block you.** On a server without a screen, Google and
  DuckDuckGo often show a bot check. Use `page.search(q)` (it picks a working
  engine and tells you when one is blocked) or Bing. Never try to solve or get
  around a bot check yourself; hand off to the user.
```

Add a new section 7 recipe, before "Popup or new tab":

````markdown
**Read an article or a PDF**

```js
const doc = await page.read({ maxChars: 20_000 });
console.log(doc.title, doc.url);
console.log(doc.markdown);
```

Or in one command, no script: `ego-browser read <url>`.

**Get a table as CSV**

```js
await page.tables({ index: 0, saveAs: "/abs/out/table.csv" });
```

**Read the JSON a page loads**

```js
const wait = page.waitForResponse(/\/api\/items/);
await page.click("text=Load more", { label: "load more items" });
const r = await wait;
console.log(r.status, r.json);
```
````

Replace the headless bullet in section 8 with:

```markdown
- **No screen = headless.** The user cannot see the browser. `handOff()`
  fails with `EGO_HANDOFF_NO_DISPLAY` instead of waiting for nobody. To let
  the user sign in on a server, run `ego-browser start --display virtual`,
  then `ego-browser view`, and give the user the link it prints (it needs an
  SSH tunnel). Or ask the user to import cookies from their desktop with
  `ego-browser cookies import`.
- **Clean up:** `ego-browser gc` closes agent spaces that have been idle past
  their TTL. The daemon also runs it every 10 minutes.
- **After a browser restart** your space is still there but its pages are
  not. Resume with `taskSpace(id, { restorePages: true })`.
- **One-shot commands:** `ego-browser read <url>`, `shot <url>`,
  `tables <url>`, `snapshot <url>`, `search "<query>"`. Each uses and closes
  its own space. Use them for one-page jobs.
```

Add rows to the table in section 10:

```markdown
| `hint:` line under an error                    | Do what it says first.                                                          |
| `[ego-browser:lint] ...`                       | Fix that line of your script, then rerun.                                       |
| `Page changed during snapshot`                 | The page is still drawing. Wait for content, then snapshot again.               |
| `page.goto failed: ... status 4xx/5xx`         | The server refused. Check the URL; use `page.fetch(url)` to read the body.      |
| Google `/sorry/` or a "confirm you are human" page | Bot check. Use `page.search()` or Bing, or hand off to the user. Do not solve it. |
| `EGO_HANDOFF_NO_DISPLAY`                       | No one can see the browser. Use `ego-browser view` or cookie import.            |
| `EGO_RESOURCE_LIMIT`                           | Close pages you no longer need, or run `ego-browser gc`.                        |
| `page label not found` after a restart          | Resume with `taskSpace(id, { restorePages: true })` or `await task.newPage()`. |
```

Add a short section 11, "Use it from any agent":

````markdown
## 11. Use it from any agent (MCP)

If your agent has no shell, add the MCP server:

```json
{ "mcpServers": { "ego-browser": { "command": "ego-browser", "args": ["mcp"] } } }
```

Tools: `browser_read`, `browser_open`, `browser_snapshot`, `browser_act`,
`browser_screenshot`, `browser_tables`, `browser_run`, `browser_handoff`,
`browser_finish`.
````

### 4.2 `package/ego-browser/skill-body/SKILL.md`

After "Supported TaskSpace API", add:

```markdown
Resume after a browser restart with `taskSpace(id, { restorePages: true })`.
Pages come back at their last URL; form state is lost. `task.memo(key, value?)`
stores small JSON progress notes in the space so a re-run round can skip
finished steps; `finish()` clears them.
```

In "Page operations", extend the list:

```markdown
- Reading: `read(options)` (article or PDF as Markdown), `tables(options)`,
  `structuredData()`
- Network: `waitForResponse(urlOrRegExp, options)`,
  `captureResponses(options)`
- Helpers: `search(query, options)`, `dismissConsent(options)`,
  `scrollToLoad(options)`, `paginate(options)`
```

In "Work efficiently", add first:

```markdown
- To read a page, use `page.read()`. It returns Markdown that is much smaller
  than a full-page snapshot. Use a snapshot when you need refs to act on.
```

In "Semantic pages", replace "A snapshot captures the current moment; it does
not wait for the page to become stable." with:

```markdown
A snapshot captures the current moment. On a client-rendered page, wait for
the content first: `waitForSelector()` when you know the element,
`waitForSettled()` when you do not, or `snapshot({ settle: true })` for both
in one call. `networkidle` does not mean the content is drawn. If the snapshot
header has a `[warning page may still be rendering]` line, wait and snapshot
again before you conclude the data is missing.
```

After "Action receipts, popups, and dialogs", add:

```markdown
Errors carry `error_code` and a `hint`. Follow the hint before anything else.
Lines that start with `[ego-browser:lint]` flag a likely bug in your script
(a static import, a missing `await`, `.status()` on a receipt); fix it first.
```

In "User control and completion", add:

```markdown
On a host without a display, `handOff()` throws `EGO_HANDOFF_NO_DISPLAY`
unless a viewer is running. Tell the user to run `ego-browser view`, or ask
them to import cookies. Do not end the round as if the hand-off worked.

When a site shows a bot check or CAPTCHA, do not try to solve or avoid it.
Hand off to the user, or use another source.
```

Add a "Site tools" section before "Clearing cookies":

```markdown
## Site tools

Some sites have tested tools. Before writing extraction code for a site, run
`console.log(await siteTools("github.com"))`. Call a tool with
`await page.site("github").run("search_repos", { query })`.
```

---

## 5. Phased plan

### Phase 1: quick wins (1 to 2 weeks)

Stop the silent failures. All small, all SDK-only or host-only, no upstream
dependency.

1. P1 error hints and HTTP status on `goto` errors.
2. P2 snapshot retry on "page changed", plus stats and the warning.
3. P3 script lint.
4. P26 `returns` in `help()`.
5. P18 step 1: refuse a silent headless hand-off; let `close` clear a stuck
   delegated space.
6. P20 TTL and `ego-browser gc`.
7. P24 CI job for the Linux host and Linux E2E.
8. Doc edits in section 4 that describe only shipped behaviour.

Exit check: rerun the section 2 table. The BBC snapshot must succeed, the
delayed page must warn, the 404 must report `status: 404`, the headless
hand-off must throw, and no space may be left that `close --all` cannot clear.

### Phase 2: extraction and reliability (3 to 5 weeks)

1. P4 `waitForSettled` and `snapshot({ settle })`.
2. P7 `page.read()` with PDF text.
3. P8 `page.tables()`.
4. P27 one-shot CLI commands.
5. P13 `waitForResponse` and `captureResponses`.
6. P25 DevTools pipe (do this early in the phase: atlas is a shared box).
7. P5 page restore and `memo` (host part first).
8. P9 structured data and tiled full-page screenshots.

Exit check: an agent can do "read these five URLs and give me a table" in one
round with no hand-written DOM code.

### Phase 3: identity and reach (4 to 6 weeks)

1. P18 steps 2 and 3: virtual display, `ego-browser view` with noVNC, relay.
2. P15 profiles (ephemeral first).
3. P16 cookie import and export.
4. P28 MCP server.
5. P10 `search()` with the Bing learning, and P11 consent banners.
6. P29 site learnings in v2, P30 new learnings.

Exit check: a user on a laptop can finish a login for an agent on atlas
through the viewer link, and an MCP-only agent can do a research task.

### Phase 4: operations at scale

1. P21 limits and a resource budget.
2. P19 round logs and `ego-browser logs`.
3. P22 systemd user service.
4. P23 `.deb` and arm64.
5. P17 secrets with origin binding.
6. P12 scroll and pagination helpers, P14 `task.map`.
7. Propose the diverging pieces (P5 `memo`/`restorePages`, P17
   `fillSecret`) upstream.

---

## Appendix A: upstream divergence at a glance

| Proposal                         | SDK change | New `ego` binding | Diverges from macOS/Windows app |
| -------------------------------- | ---------- | ----------------- | ------------------------------- |
| P1 hints, P2, P3, P4, P6         | yes        | no                | no                              |
| P7, P8, P9, P12, P13, P14, P26   | yes        | no                | no                              |
| P10, P11, P29, P30               | small      | no                | no                              |
| P5 `restorePages`, `memo`        | yes        | yes               | **yes**, feature-detect         |
| P17 `fillSecret`                 | yes        | yes               | **yes**, feature-detect         |
| P20 `ttlMs` option               | small      | no (option)       | minor, feature-detect           |
| P15, P16, P18, P19, P21–P25, P27, P28 | no    | no                | no (Linux host only)            |

## Appendix B: bugs noticed

Not fixed here; for the developer working on bugs.

1. **Headless hand-off leaves a stuck space.** `task.handOff()` with no
   display returns `undefined`. The space becomes `agentDelegatedToUser`.
   `ego-browser close <id>` refuses (`EGO_TASK_SPACE_USER_IN_CONTROL:
   manual_takeover`), `close --all` skips it, and `ego-browser spaces` shows
   its tab count as `?`. Only `takeOverTaskSpace(id)` + `finish()` clears it.
2. **Pages lost after a daemon restart.** After `ego-browser stop` and a new
   run, `taskSpace(1)` resumes with 0 pages and 0 tabs. `spaces.json` keeps
   the space but not its tabs or URLs, and nothing tells the agent why.
3. **`goto` hides HTTP errors.** A 4xx/5xx with an empty body throws
   `page.goto failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE` with no status
   (`page-waits.ts` ~line 458). Seen on `httpbin.org/status/404` and on
   `x.com/explore`.
4. **Snapshot throws on busy pages.** "Page changed during snapshot; take a
   new snapshot" on BBC News right after `goto`, with no internal retry
   (`page-model.ts`).
5. **`ego-browser upgrade` (Linux) prints a relative path**:
   `sh skills/ego-browser/scripts/install.sh`. It only works from a repo
   checkout. The README and onboarding use the `curl ... | sh` URL instead.
6. **Launcher advice uses a loose `pkill -f` pattern.** On a profile clash,
   `browser-launcher.mjs` tells the user to run `pkill -f '<profileDir>'`,
   which can match unrelated processes (for example an editor with that
   path open). Read the PID from the profile's `SingletonLock` link instead.
7. **`EGO_LITE_CHROME_ARGS` splits on whitespace**, so a flag value with a
   space (for example a path with a space) cannot be passed.
8. **Bundled Google site tool fails silently when blocked.**
   `learnings/google/tools/search-extract.js` uses `div.g`; on the headless
   host Google redirects to `/sorry/`, so it returns `[]` with no error. It
   also uses the v1 `ctx` API only.
9. **Learnings are invisible to agents.** Neither SKILL.md mentions
   `runSiteTool` or the learnings folder.
10. **CI skips the Linux host.** `.github/workflows/ci.yml` never runs
    `package/ego-host-linux` tests or the E2E suite on Linux.
11. **Headless identity.** The headless browser reports `HeadlessChrome` in
    its user agent and `navigator.webdriver === true`. Google and DuckDuckGo
    then block it. This is expected for automation; the fix proposed here is
    honest (visible mode on a virtual display, a search fallback, hand-off),
    not spoofing.

## Appendix C: how the measurements were taken

- Host: `hermes@atlas`, Ubuntu, Node 24.22.1, `/usr/bin/google-chrome` 150,
  no `DISPLAY`.
- Copy at `~/review/features/`, `HOME=~/review/features-home`,
  `XDG_RUNTIME_DIR=` (own daemon and profile). Built with
  `npm ci && npm run build` in `package/ego-browser`.
- Run as `node ~/review/features/package/ego-host-linux/bin/ego-browser.mjs
  nodejs --sdk-path ~/review/features/package/ego-browser/dist/out/index.js`.
- Times are wall-clock inside the script with `Date.now()`, one run each, so
  treat them as rough.
- The probe task space was closed and the daemon stopped at the end.
