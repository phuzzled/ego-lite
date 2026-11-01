# ego lite for Linux

The ego lite app (macOS, Windows) is closed source. This package gives the
open-source `ego-browser` SDK the same contract on Linux, on top of stock
Chrome or Chromium:

- `bin/ego-browser.mjs` — the `ego-browser` CLI (commands below). Loads the
  SDK in the same order as the app: `--sdk-path`, then
  `~/.config/ego-lite/debug/index.js`, then the bundled SDK.
- `src/daemon.mjs` — one background process per user. It starts the browser,
  keeps the task-space registry (`~/.local/state/ego-lite/spaces.json`) and
  answers the CLI on a private Unix socket.
- `src/cdp-mux.mjs` — shares the browser's DevTools pipe between the daemon
  and each CLI round, with per-client sessions.
- `src/ego-bindings.mjs` — `globalThis.ego`, as documented in
  `docs/native-bindings-api.md`, plus the host extensions below.
- `src/snapshot.mjs` — `ego.snapshot()`, built from the accessibility tree of
  the page and all its frames.
- `src/display.mjs`, `src/viewer.mjs` — a virtual display and a noVNC viewer
  for hand-off on a server.
- `src/profiles.mjs`, `src/browser-pool.mjs`, `src/cdp-router.mjs` — profiles:
  one browser per persistent profile, and the routing of a round's CDP to it.
- `src/cookies.mjs`, `src/secrets.mjs` — login import and export, and
  origin-bound secrets.

## Install

```bash
sh package/ego-host-linux/scripts/install.sh
```

Needs Node.js 22+ and npm. Uses Google Chrome or Chromium (not the snap), or
downloads Chrome for Testing.

Without a checkout, the installer downloads the pinned release tag
(`linux-v0.1.1`) and prints the SHA-256 of the source archive. Set
`EGO_LITE_SHA256` to that value to make later installs stop on a mismatch.
Set `EGO_LITE_REF=main` for the newest code. Chrome for Testing is the latest
stable build at install time; it is not pinned.

Installer options:

| Variable                        | Effect                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `EGO_LITE_VIEWER=1`             | Also `apt-get install` xvfb, x11vnc and novnc (needs sudo) |
| `EGO_LITE_SERVICE=1`            | Install and enable the systemd user service                |
| `EGO_LITE_SERVICE=virtual`      | The same, with the browser on a virtual display            |
| `EGO_LITE_CHROME_FOR_TESTING=1` | Always download Chrome for Testing (x86_64 only)           |

**arm64:** Chrome for Testing has no Linux arm64 build. The installer uses a
non-snap `chromium`, or else downloads Playwright's arm64 Chromium, which
`ego-browser` then finds in `~/.cache/ms-playwright`. This path is untested.

**.deb:** `sh package/ego-host-linux/scripts/build-deb.sh [<out-dir>]` builds
`ego-lite_<version>_all.deb` (installs to `/usr/lib/ego-lite`, links
`/usr/bin/ego-browser`; depends on `nodejs (>= 22)`, recommends Chrome,
xvfb, x11vnc and novnc). Built and dry-run installed on Ubuntu x86_64.

## Commands

```bash
ego-browser nodejs <<'EOF' ... EOF       # run a script (or -e "<code>")
ego-browser skill                        # print the usage guide
ego-browser start [--display virtual]    # start the daemon; virtual = headful on Xvfb
ego-browser stop | status                # status shows use against the limits
ego-browser spaces                       # id, owner, tabs, idle time, stale flag
ego-browser close <id...> | --all | --force <id|--all>
ego-browser gc [--dry-run]               # close agent spaces idle past their TTL
ego-browser logs [--space <id>] [-n 50] [--follow] [--json]
ego-browser view [--stop]                # one-time noVNC link to the virtual display
ego-browser relay <id>                   # screenshot + snapshot of a space, for the user
ego-browser restore <id>                 # reopen the tabs a browser restart closed
ego-browser service install [--display virtual] [--no-enable] | uninstall | status
ego-browser profiles [create <id> [--name <name>] | remove <id>]
ego-browser cookies export --profile <id> --sites <a.com,...> --out <file>
                       [--local-storage <https://origin,...>] [--force]
ego-browser cookies import --profile <id> --in <file>
ego-browser cookies import-chrome --from <chrome profile dir> --profile <id>
                       --sites <a.com,...> [--keyring] [--dry-run]
ego-browser secret set <name> --origin <https://site> [--origin ...]
ego-browser secret list | remove <name>
ego-browser upgrade
```

## Profiles

A profile is a cookie jar and a login state. Pick one when the task space is
created; the space stays in it.

| Profile           | What it is                                                 | Where                                    |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `Default`         | the ego lite profile, used when no profile is given        | `~/.local/share/ego-lite/profile`        |
| `ephemeral`       | throwaway: a new in-memory browser context for each space  | memory only; deleted at `finish()`/close |
| named (`work`...) | persistent, with its own logins, made by `profiles create` | `~/.local/share/ego-lite/profiles/<id>`  |

```bash
ego-browser profiles create work --name "Work account"
ego-browser profiles                      # id, kind, browser running?, spaces, name
ego-browser profiles remove work          # refuses while a task space uses it
```

```js
const work = await taskSpace("inbox", { profileId: "work" });
const temp = await taskSpace("one-off", { profileId: "ephemeral" });
```

`ego.listProfiles()` returns `Default` first (`isDefault: true`), then the
named profiles, then `ephemeral` (with `ephemeral: true`). An unknown id gives
`EGO_PROFILE_NOT_FOUND`.

How one daemon serves several profiles:

- Chrome holds one `--user-data-dir` per process, so **each named profile
  runs in its own browser**, with its own DevTools pipe and mux, started the
  first time a task space (or a cookie import) needs it. The Default browser
  starts with the daemon, and the daemon still stops when it dies. When a
  named profile's browser dies, its spaces keep their ids and are marked
  stale with their URLs, as after a restart (`ego-browser restore <id>`).
- **Ephemeral** spaces are browser contexts (`Target.createBrowserContext`)
  inside the Default browser: no extra process. `finish()` deletes the space
  with its tabs and cookies, whatever Pages it was asked to keep (a notice
  says so), and an ephemeral space does not survive a daemon restart.
- A CLI round asks the daemon for each browser it needs. Raw CDP is routed by
  session, then by tab, then by the selected space's profile, so one script
  can drive spaces of several profiles side by side.
- **Limits count across all browsers**: `maxTaskSpaces` and `maxTotalPages`
  count spaces and pages of every profile, `maxRssMb` is the sum of every
  browser's memory, and `maxBrowsers` (default 4, Default included) caps the
  browser processes. `gc` also stops a named profile's browser once no task
  space and no round uses it.
- Chrome writes cookies to disk about every 30 seconds; a browser killed
  within that time loses the newest ones.

## Logins: cookie export and import

On a server nobody can log in through a window. Log in on a desktop, export
the cookies of the sites you need, and import them on the server:

```bash
# On the desktop (ego lite profile "work"):
ego-browser cookies export --profile work --sites github.com,notion.so \
  --local-storage https://www.notion.so --out ~/work-cookies.json
scp ~/work-cookies.json me@server:
# On the server:
ego-browser cookies import --profile work --in ~/work-cookies.json && rm ~/work-cookies.json
```

- `--sites` is required: only cookies of those sites (and their subdomains)
  are exported. `--local-storage` adds the localStorage of the given origins,
  which must be inside the sites.
- The file is created with mode 0600 and is never overwritten without
  `--force`. It holds live sessions: the command prints a warning, and import
  warns when the file can be read by other users. Cookie values are never
  printed.
- Nothing leaves the machine. localStorage is read and written on a hidden
  tab whose requests are all answered locally (Fetch interception, service
  workers bypassed), so no request reaches the site.
- Expired cookies are skipped. Import into a named profile that nothing uses
  closes its browser afterwards, which writes the cookies to disk at once.
- `ephemeral` cannot be exported or imported: it lives inside one space.

**From your desktop Chrome or Chromium on the same machine**, only when you run:

```bash
ego-browser cookies import-chrome --from ~/.config/google-chrome/Default \
  --profile work --sites github.com
```

It copies the cookie database to a private temporary folder and reads the
copy, so your Chrome is not changed or locked. Values Chrome encrypted with
its built-in Linux key (`v10`, used with `--password-store=basic` or without a
keyring) are decrypted. Values encrypted with a key from the desktop keyring
(`v11`, GNOME Keyring or KWallet) are **skipped and counted**; add `--keyring`
to read that key with `secret-tool lookup application chrome` (or
`chromium`; `--keyring-app` overrides), which may ask you to unlock the
keyring. `--dry-run` shows what would be imported. Needs Node.js 22.13+
(`node:sqlite`).

## Secrets

The user stores a secret once; an agent fills it by name and never sees it.

```bash
ego-browser secret set github-password --origin https://github.com
# asks for the value without echo; or: pass show github | ego-browser secret set ...
ego-browser secret list                   # names and origins, never values
ego-browser secret remove github-password
```

```js
await page.click("loc=role:textbox[name='Password']"); // focus the field
await ego.fillSecret("github-password"); // { filled: true, secret, origin }
```

- Stored in `~/.local/share/ego-lite/secrets.json`, mode 0600 in a 0700
  folder (a looser file is tightened on read). The OS keyring is not used:
  servers rarely have one unlocked. The value is never taken on the command
  line, which shell history and `ps` keep.
- The daemon types the value (`Input.insertText`) into the focused field. It
  first checks that the field's document is on one of the secret's origins
  (exact match, https only except localhost), and checks again just before
  typing. A field inside a frame from another origin is refused.
- The value never enters the script's process, its output, round logs or the
  daemon log. Snapshots of a space that had a secret filled are redacted by
  the daemon (`value="[secret:github-password]"`), and so is `relay`.
- Errors: `EGO_SECRET_NOT_FOUND`, `EGO_SECRET_ORIGIN_MISMATCH`,
  `EGO_SECRET_NO_FIELD`.
- Limit: once typed, the value is in the page. A script that reads the field
  with `evaluate()` sees it. `fillSecret` stops accidental exposure, not a
  hostile script.

## Security model

- **DevTools is a pipe**, not a port: Chrome starts with
  `--remote-debugging-pipe`, and only the daemon holds the pipe. CLI rounds
  reach CDP through the daemon's Unix socket (mode 0600 in a 0700 folder), so
  other local users cannot drive the browser. `EGO_LITE_DEVTOOLS=port` opens
  the old `127.0.0.1` port for debugging only.
- **Sessions are per round.** The daemon gives each round its own sessions
  and detaches them when the round ends, as a closed WebSocket would.
- **The virtual display** (Xvfb) does not listen on TCP and needs a random
  cookie kept in `~/.local/state/ego-lite/run/Xauthority` (0600).
- **The viewer** listens on `127.0.0.1` only. Its WebSocket needs a random
  one-time token; Host and Origin must be loopback names. Each connection runs
  its own `x11vnc -inetd` on a socket pair, so no VNC port is open. It stops
  after 30 minutes, when the agent takes over, or with `ego-browser view
--stop`. Reach it through an SSH tunnel.
- **Logs** hold action names, timings and error codes; no page content, typed
  text, CDP parameters, or URL paths and queries (navigation shows the origin).
- **Cookie files and secrets** are 0600 files the user controls; nothing is
  uploaded. See [Logins](#logins-cookie-export-and-import) and
  [Secrets](#secrets).

## Hand-off on a server

On a server without a screen the browser is headless, and nobody can see a
handed-off space. Two ways out:

1. **Live view.** `ego-browser stop && ego-browser start --display virtual`
   runs Chrome headful on Xvfb. `task.handOff()` then starts the viewer and
   prints a link and the SSH tunnel command for the user:

   ```text
   [ego-browser] task space 3 is handed off. Give the user this link (it works once):
     http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale&reconnect=0&path=websockify%3Ftoken%3D...
   From their computer they first run: ssh -N -L 6080:127.0.0.1:6080 me@server
   ```

   `ego-browser view` prints a new link at any time. Needs `xvfb x11vnc
novnc` (`EGO_LITE_VIEWER=1` in the installer).

   The virtual display has no window manager, so the daemon arranges windows
   itself: new windows open at the top-left corner at screen size, and on
   hand-off the space's tab is brought to the front, from whichever profile's
   browser holds it, and its window is set to fill the screen.

2. **Screenshot relay.** `ego-browser relay <id>` (or
   `ego.handOffTaskSpace({ relay: true })`) writes a screenshot and a snapshot
   of the space's page to `~/.local/state/ego-lite/relay/` and keeps control
   with the agent. The agent shows them to the user and does what the user
   says.

A hand-off that nobody can see returns to the agent after an hour of no use
(`handOffTtlMs`), and `ego-browser close --force <id>` closes it at once.

## Settings

Environment:

| Variable                  | Effect                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `EGO_LITE_CHROME`         | Browser binary to use                                       |
| `EGO_LITE_HEADLESS`       | `1` or `0`; default is headless when there is no display    |
| `EGO_LITE_DISPLAY`        | `virtual`: headful on a private Xvfb display                |
| `EGO_LITE_DEVTOOLS`       | `pipe` (default) or `port` (debugging only)                 |
| `EGO_LITE_PASSWORD_STORE` | Chrome `--password-store`; default `basic` when headless    |
| `EGO_LITE_CHROME_ARGS`    | Extra browser flags; quote a value with spaces: `--a="b c"` |
| `EGO_LITE_PROFILE_DIR`    | Default profile (default `~/.local/share/ego-lite/profile`) |
| `EGO_LITE_NOVNC_DIR`      | noVNC web files (default `/usr/share/novnc`)                |

`~/.config/ego-lite/config.json` (every key optional; read when the daemon
starts; a limit of 0 turns it off):

```json
{
  "maxTaskSpaces": 8,
  "maxPagesPerSpace": 6,
  "maxTotalPages": 24,
  "maxRssMb": 3072,
  "maxBrowsers": 4,
  "defaultTtlMs": 86400000,
  "handOffTtlMs": 3600000,
  "gcIntervalMs": 600000,
  "viewerPort": 6080,
  "viewerTimeoutMs": 1800000
}
```

`maxTaskSpaces` counts agent-owned spaces of every profile. `maxRssMb` is the
memory of every browser (proportional set size of their process trees).
`maxBrowsers` caps browser processes, one per profile in use. Past a limit,
`taskSpace()` and `newPage()` fail with `EGO_RESOURCE_LIMIT`.

## Task-space lifetime

- Every daemon call on a space, and every CDP attach to one of its tabs,
  counts as use. `ego-browser gc` (and the daemon, every `gcIntervalMs`)
  closes agent spaces idle longer than their TTL: `defaultTtlMs`, or the
  `ttlMs` the space was created with. User-owned spaces are never closed.
- After a browser restart a space keeps its id but loses its tabs; it is
  marked stale and the agent is told which URLs were open.
  `ego-browser restore <id>` or `ego.restoreTaskSpaceTabs()` reopens the
  http(s) ones (GET only; form state is lost).

## Host extensions to `globalThis.ego`

For the SDK, feature-detected with `ego.getHostCapabilities()`:

| Binding                                                  | Result                                                  |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `createTaskSpace(name, profileId, { ttlMs })`            | as before; the space gets its own TTL                   |
| `handOffTaskSpace({ relay: true })`                      | `{ relay: { dir, screenshot, snapshot, url, title } }`  |
| `taskSpaceMemo(key)` / `(key, value)`                    | `{ found, value }`; null deletes; cleared by `finish()` |
| `restoreTaskSpaceTabs()`                                 | `{ tabs: [{ targetId, url }], skipped: [url] }`         |
| `logEvent({ page, action, target, ms, ok, error_code })` | adds a line to the round log                            |
| `listProfiles()` / `createTaskSpace(name, profileId)`    | named profiles and `ephemeral` (`profiles: true`)       |
| `fillSecret(name, { targetId?, clear? })`                | `{ filled, secret, origin }` (`fillSecret: true`)       |

`getHostCapabilities()` also reports `ephemeralProfile: true`. A space
summary pushed to the round carries its `profileId`.

## Logs

- `~/.local/state/ego-lite/daemon.log` — daemon output (the journal when run
  as a service).
- `~/.local/state/ego-lite/events.jsonl` — daemon events: start, stop, gc,
  limits, hand-off, take-over, viewer.
- `~/.local/state/ego-lite/rounds/<spaceId>.jsonl` — one line per action:
  `{ ts, round, space, action, target, ms, ok, error_code }`. Files rotate at
  1 MB.

## systemd

`ego-browser service install` writes `~/.config/systemd/user/ego-lite.service`
(`Restart=on-failure`, `MemoryMax` = `maxRssMb` + 1 GB) and enables it. The
daemon exits non-zero when the browser dies, so systemd restarts it; task
spaces come back from `spaces.json`. On a server run
`sudo loginctl enable-linger $USER` so it keeps running after you log out.

## Test

```bash
npm test                                   # unit tests, this package
cd ../ego-browser && npm run e2e           # real-browser suite, needs ego-browser on PATH
```

CI runs both on ubuntu-latest, the E2E suite headless and headed under
`xvfb-run`.

## Known gaps

- No on-screen hand-off banner. Hand-off and take-over work through the API.
- Permission prompts (camera, location) do not move control to the user yet.
- A snapshot shows the page as it is at that moment. Single-page apps can show
  an empty shell right after `goto()`; wait for the content first.
- Page labels (`p1`) are not restored after a browser restart; that needs the
  SDK's `restorePages`.
- The virtual display has no window manager. The daemon places and raises
  windows itself. Windows have no title bars, so the user cannot move or
  resize them in the viewer.
- The SDK has no `page.fillSecret()` yet; scripts call `ego.fillSecret()`
  after focusing the field.
