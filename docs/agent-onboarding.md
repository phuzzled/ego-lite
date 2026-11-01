# Agent onboarding: ego lite browser

Give this whole file to an agent as its brief. It teaches the agent what ego
lite is, how to run it, and how to use it in daily work.

---

## 1. What you now have

You can drive a real Chromium browser with the `ego-browser` command.

- The browser keeps cookies and logins between runs. Sites you (or the user)
  signed in to stay signed in.
- You work in a **task space**: your own set of tabs, kept apart from the
  user's tabs. It survives between commands.
- You can read pages as Markdown, read tables and PDFs, search the web, click,
  type, fill forms, upload and download files, take screenshots, run
  JavaScript in the page, read the JSON a page loads, and send raw Chrome
  DevTools Protocol (CDP) commands.
- You can **hand control to the user** (for a login, a CAPTCHA or a payment)
  and take it back after.

Use ego-browser for any web task: research, data extraction, form work, web
app testing and QA, checking a deploy, and signed-in work on the user's sites.
Prefer it to fetch tools when the page needs JavaScript, a login, or clicks.

## 2. First thing, every session

```bash
ego-browser skill
```

This prints the full usage guide for the installed version. Read it. It is the
source of truth and wins over this file if they disagree. The guide ends with a
line that starts `[ego-browser:skill] end of guide`. If that line is missing,
the output was cut off: save it to a file and read the file in parts.

If `ego-browser` is not found, install it. On Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/phuzzled/ego-lite/main/package/ego-host-linux/scripts/install.sh | EGO_LITE_REF=main sh
```

Without `EGO_LITE_REF=main` you get the pinned release `linux-v0.1.1`. It is
older than the one-shot commands, the MCP server, profiles, secrets and
helpers such as `page.read()`. The checksum and troubleshooting are in
`skills/ego-browser/references/install.md`.

On macOS and Windows, the user installs the ego lite app from
https://lite.ego.app/. Sections marked (Linux) are about the Linux host.

## 3. Pick the right way in

| Job                                             | Use                                  |
| ----------------------------------------------- | ------------------------------------ |
| Read one page, a PDF, a table, or a web search  | A one-shot command (section 4)       |
| Your agent has no shell, only MCP tools         | The MCP server (section 5)           |
| Several steps: clicks, forms, logins, many URLs | The scripting loop (sections 6 to 9) |

## 4. One-shot commands (Linux)

Each command opens a throwaway task space with an empty cookie jar, loads the
page, waits for it to settle, rejects a cookie banner, prints the result, and
closes the space. There is nothing to clean up.

```bash
ego-browser read https://en.wikipedia.org/wiki/Web_browser       # Markdown
ego-browser read https://arxiv.org/pdf/1706.03762 --max-chars 3000  # PDF text
ego-browser tables https://en.wikipedia.org/wiki/List_of_largest_cities --csv --index 0
ego-browser search "rust programming language" --max 5
ego-browser shot https://example.com --full --out /tmp/ego/example.png
ego-browser snapshot https://example.com
```

- Add `--json` for the full result as JSON.
- Add `--profile Default` to use the user's logins. Only do that when the
  user asks.
- `--timeout 2m` sets the time limit (default 60 s).
- Notes (a cut screenshot, a blocked engine) go to stderr. Stdout stays clean.
- Exit codes: `0` ok, `1` error, `2` usage, `3` bot check, `4` HTTP error,
  `5` timeout.

## 5. The MCP server (Linux)

If your agent speaks MCP and has no shell, add the server. For Claude Code:

```bash
claude mcp add ego-browser -- ego-browser mcp
```

For Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "ego-browser": { "command": "ego-browser", "args": ["mcp"] }
  }
}
```

Add `"--profile", "ephemeral"` to `args` to keep the agent away from the
user's logins. Use the full path (`which ego-browser`) if the client does not
see your `PATH`.

The tools are `browser_open`, `browser_snapshot`, `browser_act`,
`browser_read`, `browser_tables`, `browser_search`, `browser_screenshot`,
`browser_evaluate`, `browser_wait_for`, `browser_fill_secret`,
`browser_handoff`, `browser_takeover`, `browser_spaces`,
`browser_close_space`, `browser_finish` and `browser_run` (any script, with
the full API). Start with `browser_open`, act on the `@refs` it returns, and
end with `browser_finish`. The server closes its spaces when the client
disconnects.

## 6. How a script run works

You send a JavaScript script on stdin. It runs in Node.js (not in the page)
with browser helpers already in scope. Top-level `await` works.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("check pricing page");
const page = task.page("p1");
await page.goto("https://example.com/");
console.log({ spaceId: task.spaceId });
console.log(await page.snapshot());
EOF
```

If your shell or sandbox blocks heredocs, use `-e '...'`. On Windows, write a
`.mjs` file and run it (the guide shows how).

Each run is a new process:

- **Kept between runs:** the task space, its tabs, page labels (`p1`, `p2`),
  cookies, logins, and `task.memo()` notes.
- **Lost between runs:** your JavaScript variables.

So print what you need next time (the `spaceId`, page labels, a fresh
snapshot) at the end of every run.

## 7. The work loop

1. **Round 1:** create one task space for the whole goal. Print its `spaceId`.
   Go to the page. Print a snapshot, or `page.read()` if you only need to read.
2. **Next rounds:** resume with `await taskSpace(<spaceId>)`. Do several
   actions from the last snapshot. Wait for the expected result. Print a new
   snapshot **last**, so the next round can act on it at once.
3. **Done:** `await task.finish()`, once, as the last line of the last round.
   With no argument it keeps no pages, the same as `{ keep: [] }`.

A snapshot is the page as text, with a number on each element you can use:

```text
[stats nodes=33 refs=9 text=89 readyState=complete pendingRequests=0 domChanging=no]
root "Quotes to Scrape"
  textbox [ref=6]
  button "Login" [ref=7, loc=role:button[name="Login"]]
```

- Use `@7` now. It is short-lived: take a new snapshot after the page changes.
- Use `loc=...` to find the same element again later. It is stable.
- The `[stats ...]` line says how big the page is and whether it is still
  loading. A `[warning page may still be rendering]` line means wait and take
  the snapshot again.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("quotes login");
const page = task.page("p1");
await page.goto("https://quotes.toscrape.com/login");
await page.fill("#username", "demo");
await page.fill("#password", "demo");
await page.click("loc=role:button[name='Login']", { label: "submit login" });
await page.waitForURL("https://quotes.toscrape.com/");
console.log(await page.snapshot({ settle: true }));
await task.finish();
EOF
```

## 8. Rules that matter

- **One task space per goal.** Never open a new space to escape a stuck page.
  Fix it in the same space, or stop and ask the user.
- **Reuse pages.** A new space already has page `p1` on `about:blank`. Use
  `p1.goto()` first. Call `await task.newPage()` only when you need a second
  page open at the same time. `task.page("p9")` never creates a page.
- **Read with `read()`.** For reading, `await page.read()` returns Markdown. A
  full-page snapshot of a long article can be 7 times larger. Use a snapshot
  when you need refs to act on.
- **Read the hint.** Errors end with `error_code:` and `hint:` lines. Do what
  the hint says before you try anything else.
- **Lint warnings are real.** Lines starting `[ego-browser:lint]` point at a
  bug in your script. Fix it before you read the rest of the output.
- **No static `import`.** The script is the body of an async function, not a
  module. Write `const fs = await import("node:fs/promises")`.
- **`goto()` is not an HTTP response.** It resolves to a receipt
  (`{ popups?, dialog? }`) with no `status`. A 4xx or 5xx answer throws
  `EGO_NAVIGATION_HTTP_ERROR` with `error.status`. Use `page.fetch()` to read
  a status and body without navigating.
- **Every Page method is async.** `url()`, `title()`, `info()` and
  `snapshot()` return Promises. Write `await page.url()`.
- **It is not Playwright.** Use only the documented API. No `locator()`,
  `getByRole()`, `expect()` or `route()`. When the API does not cover it, use
  `page.evaluate()` or `page.cdp()`.
- **Page code goes in `page.evaluate()`.** `window` and `document` exist only
  there. The callback cannot see your script's variables; pass one JSON value
  as the second argument.
- **Absolute paths only** for screenshots, uploads and downloads. The script
  does not run in your working directory and does not get your env vars.
- **Some names are taken.** The helpers are already declared in your script.
  Do not name a variable `wait`, `click`, `hover`, `snapshot`, `scroll`,
  `js`, `cdp` or `help`, or the script fails with
  `Identifier '...' has already been declared`.
- **App pages draw after they load.** `goto()` returns when the page shell has
  loaded. Single-page apps draw their rows later, and `networkidle` does not
  wait for that. Before a snapshot, wait for the content you need:
  `await page.waitForSelector(".row")`. If you do not know the selector, use
  `await page.snapshot({ settle: true })`.
- **Wait for a result, not for time.** Use `waitForURL()`,
  `waitForSelector()`, `waitForSettled()` or `waitForFunction()`. Avoid
  `waitForTimeout()`.
- **All times are milliseconds.**
- **Search engines may block you.** On a server, Google and DuckDuckGo often
  show a bot check. `page.search()` tries Bing first and lists blocked
  engines in `blocked`. Never try to solve or get around a bot check; use
  another source or hand off to the user.
- **Stop when the user has control.** `EGO_TASK_SPACE_USER_IN_CONTROL` means
  stop. Do not retry or work around it.
- **Never type a password you were not given.** Use `page.fillSecret()` with
  a secret the user stored (section 11), or hand off.
- **Always end with `finish()`.** A space stays open until you call
  `task.finish()`. A run that throws leaves its space open on purpose, so you
  can resume it. When you give up on a task, close its space (section 13).

## 9. API cheat sheet

Run `help()` or `help("page.read")` inside a script for exact signatures and
return values.

**Task space** (`const task = await taskSpace(nameOrId, options?)`)

| Need                       | Call                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| Get a page                 | `task.page("p1")`, `await task.newPage()`                              |
| List pages / all tabs      | `await task.pages()`, `await task.tabs()`                              |
| Same work on many URLs     | `await task.map(urls, async (page, url) => ..., { concurrency: 3 })`   |
| Notes that survive a rerun | `await task.memo("key", value)`, `await task.memo("key")`              |
| Pages back after a restart | `taskSpace(id, { restorePages: true })`                                |
| Throwaway cookie jar       | `taskSpace(name, { profileId: "ephemeral" })`                          |
| Close when idle (Linux)    | `taskSpace(name, { ttlMs: 600_000 })`                                  |
| Give the user control      | `await task.handOff()`, or `handOff({ relay: true })` on a server      |
| Resume after the user      | `await takeOverTaskSpace(id)`                                          |
| Finish                     | `await task.finish()` (same as `{ keep: [] }`)                         |
| Other spaces               | `await listTaskSpaces()`, `await claimTaskSpace(id)` (only when asked) |

**Page**

| Need           | Call                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Go / reload    | `goto(url)`, `reload()`                                                                                                    |
| Read           | `read()`, `tables()`, `structuredData()`, `snapshot()`, `screenshot({ path })`, `url()`, `title()`                         |
| Search the web | `search(query, { max })`                                                                                                   |
| Act            | `click`, `dblclick`, `hover`, `fill`, `fillSecret`, `selectOption`, `press`, `focus`, `dragAndDrop`                        |
| Wait           | `waitForSettled`, `waitForURL`, `waitForSelector`, `waitForFunction`, `waitForLoadState`, `waitForEvent`                   |
| Network        | `waitForResponse(match)`, `captureResponses({ match })`, `fetch(url, options)`                                             |
| Long lists     | `scrollToLoad({ itemSelector })`, `paginate({ next })`, `dismissConsent()`                                                 |
| Files          | `setInputFiles(sel, [paths])`, `waitForFileChooser()`, `waitForEvent("download")`; `readPdf(path)` for a PDF on disk       |
| Dialogs        | `acceptDialog(text?)`, `dismissDialog()`                                                                                   |
| Mouse / keys   | `mouse.click(x, y)`, `mouse.wheel(dx, dy)`, `keyboard.type()`, `keyboard.press("ControlOrMeta+A")`, `keyboard.paste(text)` |
| Page code      | `evaluate(fn, arg)`                                                                                                        |
| Site tools     | `siteTools(url)`, `page.site(id).run(tool, args)`                                                                          |
| Low level      | `page.cdp(method, params)`, `task.cdp(...)` for Target and Browser                                                         |

**Selectors:** `@21`, `loc=role:button[name='Save']`, `loc=css:#id`,
`loc=href:/path`, `text=Save` (substring, any case), `text="Save"` (exact),
`xpath=...`, or plain CSS. An action needs exactly one match.

Pointer actions (`click`, `dblclick`, `hover`, `dragAndDrop`, `mouse.click`,
`mouse.move`, `mouse.wheel`) take an optional `{ label: "3-6 word note" }`.
The label shows next to the agent cursor. Other methods reject `label`.

## 10. Daily-use recipes

Each recipe is the middle of a script. It assumes
`const task = await taskSpace("...")` and `const page = task.page("p1")`.

**Read an article**

```js
await page.goto("https://en.wikipedia.org/wiki/Web_browser");
const doc = await page.read({ maxChars: 20_000 });
console.log(doc.title, doc.url, doc.words);
console.log(doc.markdown);
```

**Read a PDF**

```js
await page.goto("https://arxiv.org/pdf/1706.03762");
const pdf = await page.read({ maxChars: 5_000 });
console.log(pdf.pages.length, pdf.markdown);
```

For a PDF already on disk: `await readPdf("/home/me/files/paper.pdf")`.

**Get a table as CSV**

```js
await page.goto("https://en.wikipedia.org/wiki/List_of_largest_cities");
await page.tables({ index: 0, saveAs: "/tmp/ego/cities.csv" });
const [cities] = await page.tables({ index: 0 });
console.log(cities.headers, cities.rows.slice(0, 3));
```

**Search the web**

```js
const found = await page.search("node.js release schedule", { max: 5 });
console.log(found.engine, found.blocked, found.warning);
for (const r of found.results) console.log(r.rank, r.title, r.url);
```

If `engine` is `null`, every engine was blocked. If `warning` is set, no
result mentions your query: rephrase it or read a known site.

**Read the JSON a page loads**

Arm the wait before the action that sends the request.

```js
const responseWait = page.waitForResponse(/algolia\.net/);
await page.goto("https://hn.algolia.com/?q=rust");
const r = await responseWait;
console.log(
  r.status,
  r.json.hits.map((h) => h.title),
);
```

To collect every response for a while, use
`const capture = await page.captureResponses({ match: /api/ })`, act, call
`await page.waitForSettled()`, then `await capture.stop()`.

**Pages of results and infinite lists**

```js
await page.goto("https://quotes.toscrape.com/");
for await (const p of page.paginate({ next: "li.next a", maxPages: 3 })) {
  const quotes = await p.evaluate(() =>
    [...document.querySelectorAll(".quote .text")].map((q) => q.textContent),
  );
  console.log(await p.url(), quotes.length);
}

await page.goto("https://quotes.toscrape.com/scroll");
const loaded = await page.scrollToLoad({
  itemSelector: ".quote",
  maxItems: 50,
});
console.log(loaded.items, loaded.stoppedBecause);
```

**The same job on many URLs**

```js
const results = await task.map(
  ["https://example.com/", "https://www.iana.org/help/example-domains"],
  async (p) => (await p.read({ maxChars: 2_000 })).title,
  { concurrency: 2 },
);
console.log(results);
```

Each result is `{ url, index, ok: true, value }` or
`{ url, index, ok: false, error, error_code }`. One failure does not stop the
others.

**Cookie banner**

```js
const consent = await page.dismissConsent();
console.log(consent.found, consent.action);
```

It clicks "Reject all" or "Necessary only". It never accepts unless you pass
`{ prefer: "accept" }`; do that only when the user asked.

**What a page says about itself** (JSON-LD, OpenGraph)

```js
await page.goto("https://en.wikipedia.org/wiki/Web_browser");
const data = await page.structuredData();
console.log(data.jsonLd[0]?.["@type"], data.jsonLd[0]?.name, data.openGraph);
```

**Extract a list**

```js
await page.goto("https://quotes.toscrape.com/");
const rows = await page.evaluate(
  ({ limit }) =>
    [...document.querySelectorAll(".quote")].slice(0, limit).map((q) => ({
      text: q.querySelector(".text")?.textContent?.trim(),
      author: q.querySelector(".author")?.textContent?.trim(),
    })),
  { limit: 5 },
);
console.log(JSON.stringify(rows, null, 2));
```

**Use a tested site tool**

```js
console.log(await siteTools("news.ycombinator.com"));
const hits = await page.site("hn").run("search", { query: "rust" });
console.log(hits.slice(0, 3));
```

Run `siteTools()` before you write extraction code for a known site.

**Call a site API as the signed-in user**

```js
await page.goto("https://quotes.toscrape.com/");
const res = await page.fetch("/api/quotes?page=1");
console.log(res.status, res.body.slice(0, 300));
```

**Download a file**

```js
await page.goto("https://the-internet.herokuapp.com/download");
const downloadWait = page.waitForEvent("download", { timeout: 30_000 });
await page.click("#content a >> nth=0", { label: "download first file" });
const download = await downloadWait;
await download.saveAs(`/tmp/ego/downloads/${download.suggestedFilename()}`);
```

**Upload a file**

```js
await page.goto("https://the-internet.herokuapp.com/upload");
await page.setInputFiles("#file-upload", ["/tmp/ego/report.pdf"]);
await page.click("#file-submit", { label: "submit upload" });
```

**Full-page screenshot**

```js
await page.goto("https://en.wikipedia.org/wiki/Web_browser");
const tiles = await page.screenshot({ fullPage: true, tiles: true });
console.log(tiles);
```

`fullPage: true` alone stops at 16000 CSS px with a notice. `tiles: true`
returns several images of up to 4000 px each.

**Popup or new tab**

```js
await page.goto("https://the-internet.herokuapp.com/windows");
const popupWait = page.waitForEvent("popup");
await page.click("text=Click Here", { label: "open new window" });
const popup = await popupWait;
await popup.waitForLoadState();
console.log(popup.label, await popup.url());
```

**Canvas, maps, sheets (no useful DOM)**

```js
const shot = await page.screenshot({ path: "/tmp/ego/before.png" });
await page.mouse.click(420, 260, { label: "select cell B2" });
await page.keyboard.paste("hello\tworld");
console.log({ shot });
```

Look at the screenshot with your image tool. Coordinates are CSS pixels.

**JavaScript dialog** (an action's receipt has `dialog`, or `page.info()`
shows one): call `acceptDialog()` or `dismissDialog()` before anything else.

**The user must sign in, solve a CAPTCHA or approve a payment**

```js
await task.handOff();
console.log("Handed off space", task.spaceId);
```

End the round. Tell the user exactly what to do in the browser. On a server,
see section 12 first. When they say they are done:

```js
const task = await takeOverTaskSpace(7);
const page = task.userPage();
```

Adopt `page` if it has no label. Then carry on.

## 11. Profiles, logins and secrets (Linux)

A profile is a cookie jar. Pick it when you create the space; the space stays
in it. Use one only when the user tells you to.

| Profile     | What it is                                                     |
| ----------- | -------------------------------------------------------------- |
| `Default`   | The user's ego lite profile, with their logins. Used if unset. |
| `ephemeral` | Empty and throwaway. `finish()` deletes it with its cookies.   |
| named       | Made by the user with `ego-browser profiles create work`.      |

```js
console.log(await profiles());
const temp = await taskSpace("one-off lookup", { profileId: "ephemeral" });
await temp.page("p1").goto("https://example.com/");
await temp.finish();
```

**Logins on a server.** Nobody can log in through a window there. The user
logs in on their desktop, exports the cookies of the sites you need, and
imports them on the server:

```bash
ego-browser cookies export --profile work --sites github.com --out ~/work-cookies.json
ego-browser cookies import --profile work --in ~/work-cookies.json
```

The user runs these, not you. The file holds live sessions.

**Secrets.** The user stores a password once. You fill it by name and never
see it:

```bash
ego-browser secret set github-password --origin https://github.com
ego-browser secret list
```

```js
await page.goto("https://the-internet.herokuapp.com/login");
await page.fillSecret("#password", "demo-login");
```

It is typed only on the origins the secret was stored for. Snapshots show
`[secret:<name>]` instead of the value. Never ask for a password in chat. On
`EGO_SECRET_NOT_FOUND`, ask the user to run `ego-browser secret set`.

## 12. Hand-off on a server (Linux)

On a server without a screen the browser is headless. Nobody can see a
handed-off space, and `handOff()` warns you so. There are two ways out.

**1. Live view.** The browser must run on a virtual display (it needs
`xvfb`, `x11vnc` and `novnc`):

```bash
ego-browser stop && ego-browser start --display virtual
```

Then `task.handOff()` prints a one-time link and an SSH tunnel command.
Give both to the user:

```text
[ego-browser] task space 18 is handed off. Give the user this link (it works once):
  http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=websockify%3Ftoken%3D...
From their computer they first run: ssh -N -L 6080:127.0.0.1:6080 me@server
```

`ego-browser view` prints a new link at any time. The viewer stops after 30
minutes, or when you take over.

**2. Relay.** You keep control and show the user the page:

```js
const { relay } = await task.handOff({ relay: true });
console.log(relay.screenshot, relay.snapshot, relay.url);
```

Show the user the screenshot. Do what they say in the next round. Never type
a password they did not give you; use a secret.

## 13. Cleanup and limits (Linux)

```bash
ego-browser status        # browser, viewer, and use against the limits
ego-browser spaces        # id, owner, tabs, idle time, stale flag, name
ego-browser close 12      # close task space 12 (several ids are fine)
ego-browser close --all   # close every space the agent controls
ego-browser gc --dry-run  # which idle agent spaces gc would close
ego-browser gc            # close agent spaces idle past their TTL
ego-browser logs -n 20    # recent actions, timings and error codes
```

- `close --all` never closes a space the user owns or controls. A space handed
  off in a headless browser stays with the user; close it with
  `ego-browser close --force <id>` once the user agrees.
- After a failed run, the CLI names any task space that run left open.
- Agent spaces close after a day without use (or their `ttlMs`). The daemon
  runs `gc` every 10 minutes.
- Default limits: 8 agent task spaces, 6 pages per space, 24 pages in all,
  3 GB of browser memory, 4 browsers. Past a limit, `taskSpace()` and
  `newPage()` fail with `EGO_RESOURCE_LIMIT`.
- **After a browser restart** your space keeps its id but loses its tabs. The
  next run lists the URLs. Resume with
  `taskSpace(id, { restorePages: true })`; form state is lost.
- **Logs:** `~/.local/state/ego-lite/daemon.log` for the daemon,
  `ego-browser logs` for your rounds.
- **Settings:** `EGO_LITE_CHROME` (browser binary), `EGO_LITE_HEADLESS` (`1` or
  `0`), `EGO_LITE_PROFILE_DIR`, `EGO_LITE_CHROME_ARGS`. Set them before
  `ego-browser start`, not inside a script.

## 14. Using it day to day

- **Research:** `page.search()` or `ego-browser search`, then `read()` the best
  results (`task.map()` for several), finish the space, report with links.
- **Signed-in chores:** dashboards, admin panels, forms on the user's
  accounts. Hand off for logins and anything that spends money or sends a
  message, unless the user already said yes to that exact action.
- **Web app QA:** open the dev or staging URL, walk the flow, take a
  screenshot at each key step, read console errors with
  `page.cdp("Runtime.enable")` plus `page.events()`, and report what broke
  with the step and the screenshot path.
- **Deploy checks:** open the live URL, check the title, a key element and an
  API call with `page.fetch()`, then finish.
- **Monitoring:** run the same short script on a schedule. Use a fixed space
  name such as `"daily price check"`, so `taskSpace(name)` resumes it. Keep
  progress in `task.memo()` so a rerun skips finished steps.
- **Keep scripts:** for repeat jobs, save each round as its own file in a
  dated folder (`round-01.mjs`, `round-02.mjs`). Never edit an old round and
  rerun it: it replays old steps.

## 15. Known limits

- **Bing from a server** sometimes returns no results, or results that do not
  match the query. `search()` sets `noResults` or `warning`. Rephrase, or go
  to a known site.
- **Google and DuckDuckGo** usually show a bot check to a server. `search()`
  lists them in `blocked`; `ego-browser search` exits with code 3.
- **Reddit** answers servers with HTTP 403 or a bot check, and its site tool
  throws `EGO_SITE_BLOCKED`. Use another source or hand off.
- **Full-page screenshots** stop at 16000 CSS px in a script, and at 7500 px
  in `ego-browser shot --full` and the MCP server. Use `tiles: true` for a
  longer page.
- **Permission prompts** (camera, location) do not hand control to the user.
- **The virtual display** has no window manager. The user cannot move or
  resize windows in the viewer.

## 16. When things go wrong

| You see                                                         | Do                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `hint:` line under an error                                     | Do what it says first.                                                                                                   |
| `[ego-browser:lint] ...`                                        | Fix that line of your script, then rerun.                                                                                |
| `ego-browser: command not found`                                | Install (section 2).                                                                                                     |
| `Unknown command: skill`                                        | The app is too old. Ask the user to run `ego-browser upgrade`.                                                           |
| `Unknown command: read` (Linux)                                 | The host is `linux-v0.1.1`. Reinstall with `EGO_LITE_REF=main` (section 2).                                              |
| `SyntaxError: await is only valid...`                           | The shell broke the script. Use a `.mjs` file. Do not wrap it in an async function.                                      |
| `Cannot use import statement outside a module`                  | Use `await import("node:...")` instead of `import ... from`.                                                             |
| `Identifier 'wait' has already been declared`                   | That name is a helper. Rename your variable (section 8).                                                                 |
| `EGO_ELEMENT_NOT_FOUND`, or a selector matched many             | Take a new snapshot. Use a ref or a more exact `loc=`.                                                                   |
| Old `@N` ref fails                                              | The page changed. Take a new snapshot.                                                                                   |
| `Page changed during snapshot`                                  | The page is still drawing. Wait for content, then snapshot again.                                                        |
| `[warning page may still be rendering]`                         | Wait for the content (`waitForSelector` or `waitForSettled`), then snapshot again.                                       |
| `EGO_NAVIGATION_HTTP_ERROR` (with `status`)                     | The server refused. Check the URL; use `page.fetch(url)` to read the body.                                               |
| `EGO_NAVIGATION_FAILED`                                         | Check the host name and the network. Retry once at most.                                                                 |
| `EGO_SITE_BLOCKED`, Google `/sorry/`, a "confirm you are human" | Bot check. Use another source or Bing, or hand off to the user. Do not solve it.                                         |
| `EGO_TASK_SPACE_USER_IN_CONTROL`                                | The user has control. Stop and wait for them.                                                                            |
| `EGO_TASK_SPACE_NOT_FOUND` / inactive                           | Print `await listTaskSpaces()`. Ask the user before you claim one.                                                       |
| `EGO_TASK_SPACE_NAME_IN_USE`                                    | The user owns a space with that name. Ask, or pick another name.                                                         |
| `EGO_RESOURCE_LIMIT`                                            | Close pages you no longer need, finish old spaces, or run `ego-browser gc`.                                              |
| `EGO_SECRET_NOT_FOUND`                                          | Ask the user to store it with `ego-browser secret set`. Never ask for the value.                                         |
| `EGO_SECRET_ORIGIN_MISMATCH`                                    | You are on the wrong site for that secret. Check `await page.url()`.                                                     |
| `EGO_UNSUPPORTED_ON_HOST`                                       | This host lacks the feature (memo, secrets, relay). Do without it.                                                       |
| `page label not found` after a restart                          | Resume with `taskSpace(id, { restorePages: true })` or `await task.newPage()`.                                           |
| `EGO_BROWSER_UNAVAILABLE` / "Cannot connect to browser" (Linux) | Rerun once. If it fails again, run `ego-browser stop`, then rerun. Read `~/.local/state/ego-lite/daemon.log` after that. |
| Output has `[ego-browser:notice]`                               | Finish the task. Tell the user an update exists. Upgrade only with their yes.                                            |
| `resp.status` is `undefined` after `goto()`                     | `goto()` returns a receipt, not a response. Use `page.fetch()` for a status.                                             |
| `[object Promise]` in your output                               | You forgot `await` on a Page method such as `url()`.                                                                     |
| Old task spaces pile up (Linux)                                 | `ego-browser spaces`, then `ego-browser close <id>`, `close --all` or `gc`.                                              |

Before you clear cookies, cache or storage, read
`references/clearing-state.md` in the ego-browser Skill folder. Some clears
wipe the whole profile, which signs the user out everywhere.
