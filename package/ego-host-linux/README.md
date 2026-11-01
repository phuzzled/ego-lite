# ego lite for Linux

The ego lite app (macOS, Windows) is closed source. This package gives the
open-source `ego-browser` SDK the same contract on Linux, on top of stock
Chrome or Chromium:

- `bin/ego-browser.mjs` — the `ego-browser` CLI: `nodejs`, `skill`, `start`,
  `stop`, `status`, `spaces`, `close <id...>`, `close --all`, `close --force`, `upgrade`. Loads the SDK in the same order as the app:
  `--sdk-path`, then `~/.config/ego-lite/debug/index.js`, then the bundled SDK.
- `src/daemon.mjs` — one background process per user. It starts the browser,
  keeps the task-space registry (`~/.local/state/ego-lite/spaces.json`) and
  answers the CLI on a private Unix socket.
- `src/ego-bindings.mjs` — `globalThis.ego`, as documented in
  `docs/native-bindings-api.md`.
- `src/snapshot.mjs` — `ego.snapshot()`, built from the accessibility tree of
  the page and all its frames.

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

## Settings

| Variable                  | Effect                                                      |
| ------------------------- | ----------------------------------------------------------- |
| `EGO_LITE_CHROME`         | Browser binary to use                                       |
| `EGO_LITE_HEADLESS`       | `1` or `0`; default is headless when there is no display    |
| `EGO_LITE_PASSWORD_STORE` | Chrome `--password-store`; default `basic` when headless    |
| `EGO_LITE_CHROME_ARGS`    | Extra browser flags; quote a value with spaces: `--a="b c"` |
| `EGO_LITE_PROFILE_DIR`    | Browser profile (default `~/.local/share/ego-lite/profile`) |

Logs: `~/.local/state/ego-lite/daemon.log`.

## Test

```bash
npm test                                   # unit tests, this package
cd ../ego-browser && npm run e2e           # real-browser suite, needs ego-browser on PATH
```

## Known gaps

- One profile (`Default`). Task spaces share its cookies and logins.
- No on-screen hand-off banner. Hand-off and take-over work through the API.
- Permission prompts (camera, location) do not move control to the user yet.
- A snapshot shows the page as it is at that moment. Single-page apps can show
  an empty shell right after `goto()`; wait for the content first.
- The DevTools port listens on 127.0.0.1. Other local users of the same
  machine could connect to it.
