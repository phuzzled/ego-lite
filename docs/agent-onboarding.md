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
- You can read pages, click, type, fill forms, upload and download files,
  take screenshots, run JavaScript in the page, call page APIs with the page's
  cookies, and send raw Chrome DevTools Protocol (CDP) commands.
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

If `ego-browser` is not found, install it (Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/phuzzled/ego-lite/main/package/ego-host-linux/scripts/install.sh | sh
```

On macOS and Windows, the user installs the ego lite app from https://lite.ego.app/.

## 3. How a run works

You send a JavaScript script on stdin. It runs in Node.js (not in the page)
with browser helpers already in scope. Top-level `await` works.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("check pricing page");
const page = task.page("p1");
await page.goto("https://example.com/pricing");
console.log({ spaceId: task.spaceId });
console.log(await page.snapshot());
EOF
```

If your shell or sandbox blocks heredocs, use `-e '...'`. On Windows, write a
`.mjs` file and run it (the guide shows how).

Each run is a new process:

- **Kept between runs:** the task space, its tabs, page labels (`p1`, `p2`),
  cookies, logins.
- **Lost between runs:** your JavaScript variables.

So print what you need next time (the `spaceId`, page labels, a fresh
snapshot) at the end of every run.

## 4. The work loop

1. **Round 1:** create one task space for the whole goal. Print its `spaceId`.
   Go to the page. Print a snapshot.
2. **Next rounds:** resume with `await taskSpace(<spaceId>)`. Do several
   actions from the last snapshot. Wait for the expected result. Print a new
   snapshot **last**, so the next round can act on it at once.
3. **Done:** `await task.finish({ keep: [] })`, once, as the last line of the
   last round.

A snapshot is the page as text, with a number on each element you can use:

```text
root
  heading "Sign in" level=1
  textbox "Email" [ref=21, loc=role:textbox[name="Email"]]
  button "Sign in" [ref=22, loc=role:button[name="Sign in"]]
```

- Use `@21` now. It is short-lived: take a new snapshot after the page changes.
- Use `loc=...` to find the same element again later. It is stable.

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace(7);
const page = task.page("p1");
await page.fill("@21", "user@example.com");
await page.click("loc=role:button[name='Sign in']", { label: "submit sign in" });
await page.waitForURL(/\/dashboard/);
console.log(await page.snapshot());
EOF
```

## 5. Rules that matter

- **One task space per goal.** Never open a new space to escape a stuck page.
  Fix it in the same space, or stop and ask the user.
- **Reuse pages.** A new space already has page `p1` on `about:blank`. Use
  `p1.goto()` first. Call `await task.newPage()` only when you need a second
  page open at the same time; otherwise `p1` stays as an empty extra tab.
  `task.page("p9")` never creates a page.
- **No static `import`.** The script is the body of an async function, not a
  module. Write `const fs = await import("node:fs/promises")`.
- **`goto()` is not an HTTP response.** It resolves to a receipt
  (`{ popups?, dialog? }`) with no `status`. Check `await page.url()`,
  `await page.title()` or a snapshot. Use `page.fetch()` for a status code.
- **Every Page method is async.** `url()`, `title()`, `info()` and
  `snapshot()` return Promises. Write `await page.url()`; without `await` you
  print `[object Promise]`.
- **It is not Playwright.** Use only the documented API. No `locator()`,
  `getByRole()`, `expect()` or `route()`. When the API does not cover it, use
  `page.evaluate()` or `page.cdp()`.
- **Page code goes in `page.evaluate()`.** `window` and `document` exist only
  there. The callback cannot see your script's variables; pass one JSON value
  as the second argument.
- **Absolute paths only** for screenshots, uploads and downloads. The script
  does not run in your working directory and does not get your env vars.
- **Wait for a result, not for time.** Use `waitForURL()`, `waitForSelector()`
  or `waitForFunction()`. Avoid `waitForTimeout()`.
- **App pages draw after they load.** On single-page apps (job boards, admin
  tools, dashboards) `goto()` returns when the empty shell has loaded. A
  snapshot taken then can show only filters and headings, with no rows, and it
  does not warn you. Before the snapshot, wait for the content you need:

  ```js
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelectorAll("h2").length > 3,
    undefined,
    { timeout: 20_000 },
  );
  console.log(await page.snapshot({ scope: "full_page" }));
  ```

  Do not rely on `waitUntil: "networkidle"` for these apps: many poll the
  server and never go quiet. If a snapshot looks too short, wait and take it
  again before you conclude the data is missing.

- **All times are milliseconds.**
- **Observe cheaply.** Snapshot for structure, screenshot for looks. Do not take
  both by default. Stop when the page clearly shows the result.
- **Stop when the user has control.** Errors such as
  `EGO_TASK_SPACE_USER_IN_CONTROL` mean stop. Do not retry or work around them.
- **Never type secrets you were not given for this task.** For a login the user
  must do, hand off (section 7).
- **Always end with `finish()`.** A space stays open until you call
  `task.finish()`. A run that throws leaves its space open on purpose, so you
  can resume it. When you give up on a task, close its space (section 8).

## 6. API cheat sheet

Run `help()` or `help("page.click")` inside a script for exact signatures.

**Task space** (`const task = await taskSpace(nameOrId)`)

| Need                       | Call                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| Get a page                 | `task.page("p1")`, `await task.newPage()`                              |
| List pages / all tabs      | `await task.pages()`, `await task.tabs()`                              |
| Take over an unmanaged tab | `await task.adopt(tab.page)`                                           |
| Give the user control      | `await task.handOff()`                                                 |
| Resume after the user      | `await takeOverTaskSpace(id)`                                          |
| Finish                     | `await task.finish({ keep: [] })`                                      |
| Other spaces               | `await listTaskSpaces()`, `await claimTaskSpace(id)` (only when asked) |

**Page**

| Need                         | Call                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Go / reload                  | `goto(url)`, `reload()`                                                                                                    |
| Read                         | `snapshot()`, `snapshot({ scope: "full_page" })`, `screenshot({ path })`, `url()`, `title()`                               |
| Act                          | `click`, `dblclick`, `hover`, `fill`, `selectOption`, `press`, `focus`, `dragAndDrop`                                      |
| Wait                         | `waitForURL`, `waitForSelector`, `waitForFunction`, `waitForLoadState`, `waitForEvent("popup" \| "download")`              |
| Files                        | `setInputFiles(sel, [paths])`, `waitForFileChooser()`                                                                      |
| Dialogs                      | `acceptDialog(text?)`, `dismissDialog()`                                                                                   |
| Mouse / keys                 | `mouse.click(x, y)`, `mouse.wheel(dx, dy)`, `keyboard.type()`, `keyboard.press("ControlOrMeta+A")`, `keyboard.paste(text)` |
| Page code                    | `evaluate(fn, arg)`                                                                                                        |
| HTTP with the page's cookies | `fetch(url, options)`; add `saveAs` for binary files                                                                       |
| Low level                    | `page.cdp(method, params)`, `task.cdp(...)` for Target and Browser                                                         |

**Selectors:** `@21`, `loc=role:button[name='Save']`, `loc=css:#id`,
`loc=href:/path`, `text=Save` (substring, any case), `text="Save"` (exact),
`xpath=...`, or plain CSS. An action needs exactly one match.

Pointer actions (`click`, `dblclick`, `hover`, `dragAndDrop`, `mouse.click`,
`mouse.move`, `mouse.wheel`) take an optional `{ label: "3-6 word note" }`.
The label shows next to the agent cursor. Other methods reject `label`.

## 7. Common recipes

**Extract a list**

```js
const rows = await page.evaluate(
  ({ limit }) =>
    [...document.querySelectorAll("article")].slice(0, limit).map((a) => ({
      title: a.querySelector("h2")?.textContent?.trim(),
      href: a.querySelector("a")?.href,
    })),
  { limit: 20 },
);
console.log(JSON.stringify(rows, null, 2));
```

**Call a site API as the signed-in user**

```js
const res = await page.fetch("/api/items?limit=20");
console.log(res.status, res.body.slice(0, 500));
```

**Download a file**

```js
const wait = page.waitForEvent("download", { timeout: 30_000 });
await page.click("text=Export CSV", { label: "export csv" });
const download = await wait;
await download.saveAs("/home/me/exports/report.csv");
```

**Upload a file**

```js
await page.setInputFiles("input[type=file]", ["/home/me/report.pdf"]);
```

**Popup or new tab**

```js
const popupWait = page.waitForEvent("popup");
await page.click("a[target=_blank]");
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

**The user must sign in, solve a CAPTCHA or approve a payment**

```js
await task.handOff();
console.log("Handed off space", task.spaceId);
```

End the round. Tell the user exactly what to do in the browser. When they say
they are done:

```js
const task = await takeOverTaskSpace(7);
const page = task.userPage();
```

Adopt `page` if it has no label. Then carry on.

**JavaScript dialog** (an action's receipt has `dialog`, or `page.info()`
shows one): call `acceptDialog()` or `dismissDialog()` before anything else.

## 8. Linux host extras

On Linux, ego lite is the open-source host in `package/ego-host-linux`. It runs
Chrome in the background for you.

```bash
ego-browser status     # is the background browser running?
ego-browser start      # start it (nodejs starts it for you if needed)
ego-browser stop       # stop it
ego-browser spaces     # list task spaces: id, owner, tab count, name
ego-browser close 12   # close task space 12 (several ids are fine)
ego-browser close --all  # close every space the agent controls
```

`close --all` never closes a space that the user owns or controls. After a
failed run, the CLI names any task space that run left open.

- **No screen = headless.** With no `DISPLAY` or `WAYLAND_DISPLAY`, Chrome runs
  with no window. The user cannot see or click it, so a hand-off cannot work
  there. For a login on a server, ask the user to run the browser with a
  screen once (for example `EGO_LITE_HEADLESS=0` on a desktop), or to sign in
  some other way. Logins then stay in the profile.
- **Logs:** `~/.local/state/ego-lite/daemon.log`. Read it when a run fails to
  connect.
- **Settings:** `EGO_LITE_CHROME` (browser binary), `EGO_LITE_HEADLESS` (`1` or
  `0`), `EGO_LITE_PROFILE_DIR`, `EGO_LITE_CHROME_ARGS`. Set them before
  `ego-browser start`, not inside a script.
- **Known gaps:** one profile only; no on-screen "agent working" banner;
  camera and location prompts do not hand control to the user.
- `keyboard.paste()` works on Linux. It uses Chrome's own clipboard.

## 9. Using it day to day

- **Research:** search, open the best results in one space, extract with
  `page.evaluate()`, finish the space, report with links.
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
  name such as `"daily price check"`, so `taskSpace(name)` resumes it.
- **Keep scripts:** for repeat jobs, save each round as its own file in a
  dated folder (`round-01.mjs`, `round-02.mjs`). Never edit an old round and
  rerun it: it replays old steps.

## 10. When things go wrong

| You see                                                         | Do                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `ego-browser: command not found`                                | Install (section 2).                                                                                                                          |
| `Unknown command: skill`                                        | The app is too old. Ask the user to run `ego-browser upgrade`.                                                                                |
| `SyntaxError: await is only valid...`                           | The shell broke the script. Use a `.mjs` file. Do not wrap it in an async function.                                                           |
| Selector matched 0 or many                                      | Take a new snapshot. Use a ref or a more exact `loc=`.                                                                                        |
| Old `@N` ref fails                                              | The page changed. Take a new snapshot.                                                                                                        |
| `EGO_TASK_SPACE_USER_IN_CONTROL`                                | The user has control. Stop and wait for them.                                                                                                 |
| `EGO_TASK_SPACE_NOT_FOUND` / inactive                           | Print `await listTaskSpaces()`. Ask the user before you claim one.                                                                            |
| `EGO_TASK_SPACE_NAME_IN_USE`                                    | The user owns a space with that name. Ask, or pick another name.                                                                              |
| Output has `[ego-browser:notice]`                               | Finish the task. Tell the user an update exists. Upgrade only with their yes.                                                                 |
| `EGO_BROWSER_UNAVAILABLE` / "Cannot connect to browser" (Linux) | The CLI already retried once. Run `ego-browser stop`, then run the script again. Read `~/.local/state/ego-lite/daemon.log` if it fails again. |
| Snapshot has the page frame but no rows                         | The app has not drawn them yet. Wait for the rows (section 5), then take the snapshot again.                                                  |
| `Cannot use import statement outside a module`                  | Use `await import("node:...")` instead of `import ... from`.                                                                                  |
| `resp.status` is `undefined` after `goto()`                     | `goto()` returns a receipt, not a response. Use `page.fetch()` for a status.                                                                  |
| `[object Promise]` in your output                               | You forgot `await` on a Page method such as `url()`.                                                                                          |
| Old task spaces pile up (Linux)                                 | `ego-browser spaces`, then `ego-browser close <id>` or `ego-browser close --all`.                                                             |

Before you clear cookies, cache or storage, read
`references/clearing-state.md` in the ego-browser Skill folder. Some clears
wipe the whole profile, which signs the user out everywhere.
