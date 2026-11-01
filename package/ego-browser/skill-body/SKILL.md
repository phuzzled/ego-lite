---
version: "2.2.0"
date: "2026-11-01"
---

# ego-browser

Call `help()` or `help("page.click")` to print signatures, options and return
values of the APIs below; it prints by itself, so do not wrap it in
`console.log`. For installation or connection problems, read
`references/install.md` in the ego-browser Skill directory.

## Run browser scripts

Pass the script to `ego-browser nodejs`. Heredoc is Bash/Zsh syntax; it does
not exist in PowerShell or cmd.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("inspect example page");
const page = task.page("p1");
await page.goto("https://example.com");

console.log({ taskSpaceId: task.spaceId, page: page.label });
console.log(await page.snapshot());
EOF
```

When a sandbox blocks heredoc input, use `-e` with single quotes around the
code and double quotes for JavaScript strings:

```bash
ego-browser nodejs -e '
const task = await taskSpace("inspect example page");
await task.page("p1").goto("https://example.com");
console.log(task.spaceId);
'
```

**PowerShell** has no heredoc, and Windows PowerShell 5.1 drops double quotes
inside native arguments. Write the script to a UTF-8 `.mjs` file and evaluate
an ASCII-only entry point. Use forward slashes in the URL, and keep non-ASCII
text inside the file. Do not pipe the file with `Get-Content`, which corrupts
non-ASCII text on 5.1.

```powershell
ego-browser nodejs -e "await import('file:///C:/Users/<name>/ego/task.mjs')"
```

**cmd** supports input redirection: `ego-browser nodejs < C:\Users\<name>\ego\task.mjs`.

With script files, write a new complete file for every round (`round-01.mjs`,
`round-02.mjs`) in a directory named for the goal and time; editing an old
round replays old steps. Create files with your file tool, not PowerShell
`Set-Content` or `>`.

`SyntaxError: await is only valid in async functions...` means the shell
damaged the script. Do not wrap it in an async IIFE or open a new task space;
switch to the `.mjs` file form.

### Script rules

- The script runs in Node.js as the body of an async function. Top-level
  `await` works; a static `import` does not: write
  `const fs = await import("node:fs/promises")`.
- Your own top-level declarations shadow helpers of the same name (`wait`,
  `click`, `snapshot`, `js`, `help`, ...), so after `const wait = 5` the
  `wait()` helper is not reachable in that script.
- `window`, `document`, and DOM APIs exist only inside `page.evaluate()`.
- Use absolute paths. The script does not run in your working directory and
  does not inherit your environment variables.
- It is not Playwright. Use only the APIs in this guide. Do not infer
  `locator()`, `getByRole()`, `expect()`, or `route()`; use `page.evaluate()`
  or `page.cdp()` when the API does not cover an operation.
- Lines starting `[ego-browser:lint]` are printed before the script runs and
  flag a likely bug (static import, missing `await`, `.status()` on a receipt,
  Page globals, Playwright names, `require()`). Fix that line first.
- Errors print `error_code:` and `hint:` lines, and `status:` for an HTTP error.
  Do what the hint says before trying anything else. In code, read
  `error.error_code`, `error.hint`, and `error.status`.
- Only `click()`, `dblclick()`, `hover()`, `dragAndDrop()`, `mouse.click()`,
  `mouse.move()`, and `mouse.wheel()` accept `{ label }`, a 3-6 word action
  description shown next to the agent cursor. `selectOption(selector, { label })`
  instead selects the option with that visible text.

When the user explicitly asks for ego-browser, start with a real browser command
and diagnose the CLI or installation only if it fails.

## Spaces, rounds, and pages

- Use exactly one TaskSpace for the entire user goal. Print its `spaceId` and
  resume that same space in later rounds. Use several only when the user asks.
- `taskSpace(name)` resumes your own space with that name. A name held by a
  user-owned space fails with `EGO_TASK_SPACE_NAME_IN_USE`: ask the user
  whether to work there (`claimTaskSpace(id)`), or pick another name.
- Never use a new TaskSpace to recover from a stuck or blocked Page. Recover in
  the same space, or stop and ask the user.
- Every invocation starts a new Node.js process. Task spaces, tabs, and
  Page labels persist; JavaScript variables do not.
- A new space starts with Page `p1`; navigate it, and reuse Pages with `goto()`.
- All time values are milliseconds.

```js
// Later round: resume with the space id and Page label printed earlier.
const resumed = await taskSpace(7);
const source = resumed.page("p1");
await source.goto("https://example.com/");
```

Options apply when the space is created: `profileId` picks a browser profile
(list them with `await profiles()`; `"ephemeral"` is an empty cookie jar that
`finish()` deletes), and `ttlMs` closes the space after that long unused (Linux
host). Use a profile only when the user names one.

```js
const task = await taskSpace("one-off lookup", {
  profileId: "ephemeral",
  ttlMs: 600_000,
});
```

After a browser restart a space keeps its id but loses its tabs. Resume with
`taskSpace(id, { restorePages: true })`: Pages come back at their last URL with
their labels; form state is lost. `task.memo(key, value?)` keeps small JSON
progress notes with the space so a rerun can skip finished steps (`null`
deletes; `finish()` clears them). Both throw `EGO_UNSUPPORTED_ON_HOST` on hosts
without them.

```js
const task = await taskSpace("price check", { restorePages: true });
const done = (await task.memo("done")) ?? [];
await task.memo("done", [...done, "page-1"]);
```

TaskSpace API: `spaceId`, `name`, `ownership`, `profileId`, `page(label)`,
`userPage()`, `await pages()`, `await tabs()`, `newPage()`,
`adopt(page, { as? })`, `release(label)`, `map(urls, fn, options)`,
`memo(key, value?)`, `restorePages()`, `waitForControl()`, `handOff()`,
`finish({ keep })`, `cdp()`.

`task.page(label)` only refers to an existing Page; it never creates one, and
its handle is always truthy. Call `await task.newPage()` for another Page.
`await task.tabs()` lists every tab as
`{ label?, page, targetId, title, url, active, openedBy }`; a tab without a
label is unmanaged, so adopt it first:

```js
const active = (await task.tabs()).find((item) => item.active);
if (active && !active.label) {
  const adopted = await task.adopt(active.page);
  console.log({ page: adopted.label, url: await adopted.url() });
}
```

`release(label)` returns an unknown-origin Page to the user without closing it.
Treat `openedBy: "unknown"` as user-owned.

## Page operations

Every method returns a Promise, including `url()`, `title()`, and `info()`.

- Read: `read()`, `tables()`, `structuredData()`, `snapshot()`,
  `screenshot()`, `search()`, `url()`, `title()`, `info()`
- Navigate and wait: `goto()`, `reload()`, `waitForSettled()`,
  `waitForURL()`, `waitForSelector()`, `waitForFunction()`,
  `waitForLoadState()`, `waitForEvent()`, `waitForTimeout()`
- Network: `waitForResponse()`, `captureResponses()`, `fetch()`
- Lists: `scrollToLoad()`, `paginate()`; banners: `dismissConsent()`
- Elements: `click()`, `dblclick()`, `hover()`, `dragAndDrop()`, `fill()`,
  `fillSecret()`, `selectOption()`, `focus()`, `press()`, `setInputFiles()`,
  `waitForFileChooser()`, `close()`
- Dialogs: `acceptDialog(promptText?)`, `dismissDialog()`
- Input: `mouse.click/move/down/up/wheel()`,
  `keyboard.down/up/press/type/insertText/paste()`
- Code: `evaluate(fnOrString, argument)`, `cdp()`, `site(id)`

`goto()`, `reload()`, and element actions resolve to an action receipt
(`{ popups?, dialog? }`), not an HTTP response. A navigation the server answers
with 4xx or 5xx throws `EGO_NAVIGATION_HTTP_ERROR` with `error.status`.

Work efficiently:

- To read a page, use `page.read()`: Markdown far smaller than a snapshot. Use
  a snapshot when you need refs to act on, and a screenshot only for visuals.
- Plan several actions from one observation, then observe once. Print the
  final snapshot last so the next round can act on it directly.
- If an action does not give the expected result, inspect the page before
  retrying. Stop once the page clearly shows the result.

### Read pages, PDFs, tables, and search

```js
await page.goto("https://en.wikipedia.org/wiki/Web_browser");
const doc = await page.read({ maxChars: 20_000 });
console.log(doc.title, doc.words, doc.truncated, doc.warning);
console.log(doc.markdown);
```

`read()` returns `{ url, title, markdown, links, words, truncated, source }`;
`mode: "full"` reads the whole body, `selector` one element. On a PDF URL it
returns the text with `pages: [{ n, text }]`. For a PDF on disk use
`await readPdf("/absolute/path/file.pdf")`. A `warning` means very little text:
wait, then read again or take a snapshot.

```js
await page.goto("https://en.wikipedia.org/wiki/List_of_largest_cities");
const [table] = await page.tables({ index: 0 });
console.log(table.headers, table.rowCount, table.rows[0]);
await page.tables({ index: 0, saveAs: "/absolute/path/cities.csv" });
console.log(await page.structuredData()); // JSON-LD, OpenGraph, microdata
```

```js
const found = await page.search("rust programming language", { max: 5 });
console.log(found.engine, found.results, found.blocked, found.warning);
```

`search()` tries Bing, then DuckDuckGo, then Google. An engine that shows a bot
check is listed in `blocked`, never returned as empty results; `engine` is
`null` when all were blocked. `warning` means no result mentions the query.
Google and DuckDuckGo often block automated browsers.

### Semantic pages: snapshot and selectors

A snapshot captures the current moment. On a client-rendered page, wait first:
`waitForSelector()` when you know the element, `waitForSettled()` when you do
not, or `snapshot({ settle: true })` for both in one call. `networkidle` does
not mean the content is drawn.

```js
await page.goto("https://quotes.toscrape.com/js/");
console.log(await page.snapshot({ settle: { until: ".quote", minCount: 5 } }));
```

The snapshot starts with a header line, then
`[stats nodes=… refs=… text=… readyState=… pendingRequests=… domChanging=…]`.
A `[warning page may still be rendering]` line means wait and snapshot again
before you conclude data is missing. `waitForSettled()` never throws; check
`settled` and `reason`. `format: "object"` returns
`{ text, stats, warnings, settle }`.

The default snapshot covers the viewport, including visible iframe content.
Use `snapshot({ scope: "full_page" })` for the whole page, or focus on a frame
with the ref on its `iframe` line:
`page.snapshot({ scope: "subtree", root: "@12" })`.

```js
// Act on refs and locators from the previous output, then observe once.
await page.goto("https://quotes.toscrape.com/login");
await page.fill("#username", "demo");
await page.fill("#password", "demo");
await page.click("loc=role:button[name='Login']", { label: "submit login" });
await page.waitForURL("https://quotes.toscrape.com/");
console.log(await page.snapshot());
```

Element actions accept snapshot refs (`@21`), `text=...`, `loc=css:`,
`loc=role:`, `loc=href:`, `xpath=...`, and raw CSS. A selector must match
exactly one element. Unquoted `text=` ignores case and matches a substring;
`text="Save changes"` is exact. Also accepted: `css=...`, terminal
`:has-text("...")` and `:text-is("...")`, `>> nth=N`, and
`loc=role:...[name*="..."]`. Refs are short-lived.
After the page changes, take a new snapshot; use `loc=...` to find an element
again later. CSS
searches open shadow roots; actions prefer the top document, then frames.
`click()`, `fill()`, `hover()`, and `dragAndDrop()` scroll their target into
view.

`selectOption()` takes a value, `{ label }`, `{ index }`, or an array for a
multiple select; `null` or `[]` clears it. `waitForFunction()` follows
Playwright's argument order: pass `undefined` before options when there is no
Page argument.

### Lists, pages of results, banners, and many URLs

```js
await page.dismissConsent(); // rejects a cookie banner; never accepts by default
await page.goto("https://quotes.toscrape.com/scroll");
const scrolled = await page.scrollToLoad({
  itemSelector: ".quote",
  maxItems: 30,
});
console.log(scrolled.items, scrolled.stoppedBecause);

await page.goto("https://quotes.toscrape.com/");
for await (const p of page.paginate({ next: "li.next a", maxPages: 3 })) {
  console.log(await p.url());
}

const results = await task.map(
  ["https://example.com", "https://example.org"],
  async (p) => p.title(),
  { concurrency: 2 },
);
console.log(results); // [{ url, index, ok, value } | { ok: false, error, error_code }]
```

`dismissConsent()` returns `{ found, action }`; pass `prefer: "accept"` only
when the user asked. `task.map()` reuses up to `concurrency` Pages and closes
them afterwards; one failure does not stop the others.

### Network responses

Arm `waitForResponse()` before the action that triggers the request; do not
`await` it first. A string matches as a glob or substring.

```js
const response = page.waitForResponse(/algolia\.net/);
await page.goto("https://hn.algolia.com/?q=rust");
const { status, json } = await response;
console.log(status, json.hits.length);

const capture = await page.captureResponses({ match: /algolia\.net/ });
await page.fill("input[type=search]", "deno");
await page.waitForSettled();
console.log((await capture.stop()).map((r) => [r.status, r.url]));
```

`page.fetch(url, options)` runs `window.fetch()` in the Page with its cookies
and CORS, and returns `{ ok, status, statusText, url, headers, body }`; add
`saveAs` to write a binary body to an absolute path. Use Node.js `fetch()` for
requests that need no browser state.

### Visual pages: screenshot, mouse, and keyboard

Use screenshots with mouse and keyboard for canvas, rich text, spreadsheets,
and maps:

```js
const path = await page.screenshot({ path: "/absolute/path/before.png" });
await page.mouse.click(420, 260, { label: "open spreadsheet cell" });
await page.mouse.wheel(0, 600, { label: "scroll project board" });
await page.keyboard.paste("hello\tworld");
const tiles = await page.screenshot({ fullPage: true, tiles: true });
console.log({ screenshot: path, tiles });
```

`path` must be absolute; without it the file goes to the temporary directory.
`fullPage: true` stops at `maxHeight` (16000 CSS px) with a notice;
`tiles: true` returns several images of up to 4000 px. On Windows, write paths
with forward slashes. Coordinates are CSS pixels; key names follow Playwright
(`ControlOrMeta+A`). Move or click over a scrollable area before
`mouse.wheel()`. `keyboard.paste()` restores the clipboard afterwards and takes
`{ text, html }` for rich editors. Validate one small edit before repeating it.

### Page JavaScript and CDP

`page.evaluate()` callbacks run inside the Page and cannot see script
variables; pass one JSON-serializable argument:

```js
const rows = await page.evaluate(
  ({ selector, limit }) =>
    [...document.querySelectorAll(selector)].slice(0, limit).map((node) => ({
      text: node.textContent?.trim(),
      href: node.querySelector("a")?.href,
    })),
  { selector: "article", limit: 20 },
);
```

It has no timeout option; keep work bounded. On a safety timeout, check
`executionStopped` and `mayHaveLateEffects`. `page.cdp()` sends Page, Runtime,
DOM, Network, or Input commands; `task.cdp()` sends Target and Browser
commands. Raw CDP invalidates refs. Do not persist `page.targetId`.

## Popups and dialogs

Start waiting before an action that opens a new Page:

```js
const popupPromise = page.waitForEvent("popup");
await page.click('a[target="_blank"]');
const popupPage = await popupPromise;
await popupPage.waitForLoadState();
```

Receipts also list popups seen at once as `receipt.popups: [{ label }]`; use
`task.page(label)`. A JavaScript dialog appears as `receipt.dialog` or in
`page.info()`; handle it with `await page.acceptDialog("text")` or
`await page.dismissDialog()` before continuing. `await page.events()` returns
and clears buffered protocol events.

A receipt describes only the dispatched action and what was seen at once; it
does not verify the resulting application state.

## Files, downloads, and secrets

```js
await page.setInputFiles("input[type=file]", ["/absolute/path/report.pdf"]);

const chooserPromise = page.waitForFileChooser({ timeout: 10_000 });
await page.click("button.upload");
await (await chooserPromise).setFiles("/absolute/path/report.pdf");

const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
await page.click("button.download");
const download = await downloadPromise;
await download.saveAs("/absolute/path/report.pdf");
```

`saveAs()` waits for completion and creates parent directories. Temporary
download files are removed when the round ends, so save in the same script.
A download also has `url()`, `suggestedFilename()`, `path()`, `failure()`,
`cancel()`, and `delete()`. An upload may return `{ dialog }`; handle it as
above.

On hosts with a secret store (Linux), the user stores a password once with
`ego-browser secret set <name> --origin https://site`. Fill it by name; the
value never reaches your script, and snapshots redact it:

```js
await page.goto("https://the-internet.herokuapp.com/login");
console.log(await page.fillSecret("#password", "demo-login"));
```

It is typed only on the origins the secret was stored for. Never ask for a
password in chat; on `EGO_SECRET_NOT_FOUND`, ask the user to store it.

## Site tools

Some sites have tested tools. Before writing extraction code for a site, list
them, then run one with a Page:

```js
console.log(await siteTools("en.wikipedia.org"));
const summary = await page
  .site("wikipedia")
  .run("summary", { title: "Rust (programming language)" });
console.log(summary.extract);
```

`siteTools()` with no argument lists every site; `page.site(id).notes()` reads
how the site works. A tool marked `// v1 only` runs with `runSiteTool()`.

## User control and completion

Stop when the user takes control or the space is inactive. Do not
retry or route around the stop. Permission prompts and other browser-owned prompts need the
user. When a site shows a bot check or CAPTCHA, never try to solve or avoid it:
use another source or hand off.

When the user must act in the browser, call `await task.handOff()`, end the
round, and say what to do. After the user confirms, resume the same space:

```js
const task = await takeOverTaskSpace(7);
const userPage = task.userPage();
```

Adopt `userPage` if it is unmanaged. Use `waitForControl()` only to wait in
place. On a Linux server without a screen, nobody can see a handed-off space:
`handOff()` warns, and prints a viewer link only when the browser runs on a
virtual display. To keep control and show the user the page instead, use a
relay:

```js
const { relay } = await task.handOff({ relay: true });
console.log(relay.screenshot, relay.snapshot);
```

Show the user the screenshot, then do what they say in later rounds.

Claim a user-owned or inactive space only when the user explicitly asks,
including a space you finished with kept Pages. Find its numeric
id with `await listTaskSpaces()` (entries expose `id`, not `spaceId`), then
`await claimTaskSpace(id)`.

When the task succeeds, close the space with `await task.finish({ keep: [] })`;
`finish()` with no argument means the same.
Call `finish()` exactly once and wait for it
to resolve before reporting completion. Put it last in the final
round; do not use any Page afterwards. Keep Pages only when the user asks or
must see the result: `await task.finish({ keep: ["p2"] })`. User-created and
unmanaged tabs are protected. An ephemeral space is always deleted. Do not call
`finish()` when the task stops for user control or an error; a run that throws
leaves its space open so you can resume it.

If the output contains `[ego-browser:notice]`, finish the task, tell the user
an Ego Lite update is available, and run `ego-browser upgrade` only with their
approval. Run `ego-browser skill` again after the upgrade.

## Clearing cookies, cache, and storage

Before clearing any cookie, cache, or storage, read
`references/clearing-state.md` in the ego-browser Skill directory. Some clears
reach the whole browser profile.
