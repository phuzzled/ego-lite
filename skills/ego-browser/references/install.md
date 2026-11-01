# Install or upgrade ego lite

Read this file only when `ego-browser` is not found, when `ego-browser skill` reports an unknown command, or when the user asks to install ego lite. For day-to-day browser work, run `ego-browser skill` and follow its output.

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've completed onboarding, no additional setup is normally needed.

ego lite website: https://lite.ego.app/

## Upgrade an older ego lite

If `ego-browser` exists but `ego-browser skill` reports `Unknown command: skill`, the installed ego lite is older than this skill. Ask the user for approval, then run:

```bash
ego-browser upgrade
```

If `upgrade` is also an unknown command, reinstall with the steps below. Then continue with "After installing: confirm `ego-browser` is available".

## Install on macOS

The install script lives at `scripts/install.sh` in this skill and supports macOS and Linux. On macOS it will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64).
- Install `ego lite.app` to `/Applications` (falling back to `~/Applications` when needed).
- Strip the quarantine attribute to keep Gatekeeper from blocking the first launch.
- After installing, launch the `ego lite` app.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the ego lite app directly. If ego lite is already installed, the script skips the download and opens the app directly.

After the script opens the ego lite app, the user completes the first-run onboarding in the app. Onboarding registers the `ego-browser` command on the PATH, usually under `~/.local/bin`.

## Install on Linux

There is no ego lite app for Linux. On Linux the same script installs the open-source Linux host from `package/ego-host-linux` in this repository. It needs Node.js 22 or newer and npm. It will:

- Download the source, build the ego-browser SDK, and install the host to `~/.local/share/ego-lite/host`.
- Link the `ego-browser` command into `~/.local/bin`.
- Use Google Chrome or Chromium when installed (not the snap package); otherwise download Chrome for Testing.
- Install the agent Skill to `~/.agents/skills/ego-browser` when it is not there yet.
- Start the ego lite daemon, which owns the browser.

Ask the user for approval, then run:

```bash
sh skills/ego-browser/scripts/install.sh
```

By default it installs the pinned release tag `linux-v0.1.1`. The installer prints the SHA-256 of the source archive it downloaded. The archive for `linux-v0.1.1` has this SHA-256:

```text
ec8da2cdc2fc9f0685294c9179970e0ccfaf2563b0c4da6b7b611428666b8547
```

To make the install stop on a mismatch, set `EGO_LITE_SHA256`:

```bash
EGO_LITE_SHA256=ec8da2cdc2fc9f0685294c9179970e0ccfaf2563b0c4da6b7b611428666b8547 sh skills/ego-browser/scripts/install.sh
```

`linux-v0.1.1` predates the one-shot commands, profiles, secrets, the tool server, and helpers such as `page.read()`. For those, install the newest code with `EGO_LITE_REF=main`. A branch archive changes with every commit, so it has no fixed checksum. Other installer options: `EGO_LITE_VIEWER=1` also installs xvfb, x11vnc and novnc (with sudo) for hand-off on a server, and `EGO_LITE_SERVICE=1` installs a systemd user service.

There is no onboarding step on Linux. Continue with "After installing: confirm `ego-browser` is available". On a server without a display, the browser runs headless. Run `ego-browser status` to see the browser, task spaces and limits, and `ego-browser stop` to close the browser.

### Linux: other ways in

For a one-page job, a Linux host from `main` needs no script. Each command opens a throwaway task space, prints the result and closes the space:

```bash
ego-browser read https://example.com
ego-browser tables https://en.wikipedia.org/wiki/List_of_largest_cities --csv --index 0
ego-browser search "rust programming language" --max 5
```

`shot <url>` saves a screenshot and `snapshot <url>` prints a snapshot. Exit code 3 means a bot check blocked the page, 4 an HTTP error, 5 a timeout.

Agents that cannot run shell commands can reach the same browser through the tool server built into the Linux host. Its setup for Claude Code, Codex, Cursor and other clients is in the Linux host README: https://github.com/phuzzled/ego-lite/blob/main/package/ego-host-linux/README.md

## Install on Windows

There is no install script for Windows. Have the user download the installer from https://lite.ego.app/ and run it, then open ego lite.

## Onboarding

Onboarding is a step the user completes in the GUI, on either platform:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH.

After the app opens, wait for the user to confirm they've finished onboarding before continuing. On Windows the PATH entry only reaches processes started afterwards, so open a new terminal before checking for the command.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready.

macOS and Linux shells:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

PowerShell:

```powershell
Get-Command ego-browser
```

cmd:

```bat
where ego-browser
```

Once the command exists, verify the runtime. In Bash or Zsh:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

In PowerShell or cmd, where heredoc does not exist:

```powershell
ego-browser nodejs -e "console.log('ego-browser ready')"
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```bash
ego-browser skill
```

## After that, return to the original task

Once the environment is ready, return to the user's original task: run `ego-browser skill` and follow its output.

## Troubleshooting

- **Not macOS or Linux**: `scripts/install.sh` supports macOS and Linux only. On Windows, have the user download and install from the ego lite website at https://lite.ego.app/.
- **Linux: Node.js too old**: install Node.js 22 or newer, then rerun the script.
- **Linux: browser does not start**: read `~/.local/state/ego-lite/daemon.log`. Chrome for Testing may need system libraries; the installer prints the `apt-get` line. Set `EGO_LITE_CHROME` to use another Chromium binary.
- **Linux: `checksum mismatch`**: the downloaded archive is not the one you pinned. Check `EGO_LITE_REF` and `EGO_LITE_SHA256`; do not unset the checksum to get past it without asking the user.
- **Linux: `Unknown command: read`** (or `search`, `secret`, `profiles`): the host is `linux-v0.1.1`. Reinstall with `EGO_LITE_REF=main`.
- **Linux: `EGO_BROWSER_UNAVAILABLE` or "Cannot connect to browser"**: run `ego-browser stop`, then run the script again. If it fails again, read `~/.local/state/ego-lite/daemon.log`.
- **Linux: `EGO_RESOURCE_LIMIT`**: the host is at its limit of task spaces, pages or memory. Run `ego-browser status`, then `ego-browser gc` to close idle agent spaces, or `ego-browser close <id>`.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Gatekeeper still blocks it (macOS)**: the script already tries to strip quarantine; if the first launch is still blocked, have the user allow ego lite manually under System Settings → Privacy & Security.
- **SmartScreen blocks the installer (Windows)**: have the user choose "More info" and then "Run anyway" in the SmartScreen dialog.
- **Command still unavailable after onboarding**: on macOS and Linux, confirm `~/.local/bin` is on the PATH (see above). On Windows, open a new terminal first, because an existing one keeps the PATH it started with. Otherwise have the user reopen ego lite, finish onboarding, and retry.
