# Ubuntu Port Plan for ego lite

Status (2026-11-01): phases 1–4 built in `package/ego-host-linux/`. The full
real-browser e2e suite passes on Ubuntu 26.04 (69/69, headless and headed under
Xvfb). Open: phase 5 extras and the known gaps in
`package/ego-host-linux/README.md`. Written 2026-11-01.

## 1. The key fact

This repo is **not the browser**. It holds:

- the `ego-browser` SDK (`package/ego-browser/`) — Node.js, MIT licence;
- the agent Skill (`skills/ego-browser/`);
- the agent plugins (`plugins/ego/`).

The real browser ("ego lite.app" on macOS, an installer on Windows) is a
**closed-source Chromium fork** made by Citro Labs. It does two things that the
SDK needs:

1. It ships the `ego-browser` CLI (`nodejs`, `skill`, `upgrade`, `--sdk-path`).
2. It injects `globalThis.ego` — the native bindings in
   `docs/native-bindings-api.md` (task spaces, tabs, snapshot, hand-off, raw CDP).

There is no Linux build of that app. So "Ubuntu version" means: **we build our
own Linux host** that gives the SDK the same CLI and the same `globalThis.ego`
contract, on top of stock Chromium/Chrome. The SDK itself already runs on Linux
(CI is `ubuntu-latest`, Node 22).

## 2. Target architecture

```text
agent shell
  └─ ego-browser nodejs <<'EOF' ... EOF        (new Linux CLI, ~/.local/bin)
       ├─ loads dist/out/index.js (SDK, unchanged)
       ├─ installs globalThis.ego  (new: JS shim, talks to daemon)
       └─ unix socket ──► ego-lited             (new: long-lived daemon)
                             ├─ task-space registry (JSON on disk)
                             ├─ snapshot engine (AX tree → ego snapshot format)
                             ├─ hand-off overlay / control extension
                             └─ CDP over --remote-debugging-pipe
                                  └─ Chromium / Chrome for Testing
                                       (user-data-dir ~/.local/share/ego-lite)
```

Why a daemon: task spaces, tabs and logins must survive between separate
`ego-browser nodejs` calls. Each CLI call is short; the browser is not.

New code goes in a new package: `package/ego-host-linux/` (TypeScript, ESM,
Node 22+, same style and test runner as `package/ego-browser`).

## 3. Work packages

### WP1 — Linux CLI (`ego-browser`)

- Subcommands: `nodejs` (stdin heredoc and `-e`), `skill`, `upgrade`, `-h`.
- SDK lookup order, same as upstream: `--sdk-path` → debug override
  (Linux path: `~/.config/ego-lite/debug/index.js`) → bundled SDK.
- `skill`: print `ego-browser/SKILL.md` next to the resolved `index.js`, plus
  the `source=...` override line (see `docs/ego-browser-skill-command.md`).
- Call and await `disposeEgoSdk()` before exit
  (`docs/native-sdk-lifecycle-requirement.md`).
- Syntax errors: print line, column and source line.
- Start the daemon if it is not running.

### WP2 — Daemon (`ego-lited`) and browser launch

- Find a browser in this order: `EGO_LITE_CHROME` env → Chrome for Testing in
  `~/.local/share/ego-lite/chrome` → `google-chrome` → `chromium`.
- **Do not rely on the Ubuntu snap `chromium`.** Snap confinement breaks custom
  `--user-data-dir` paths and extension loading. Default to Chrome for Testing
  (downloaded by the installer) or the Google Chrome `.deb`.
- Launch with `--remote-debugging-pipe`, own `--user-data-dir`, and
  `--load-extension` for the control extension (WP5). Note: branded Google
  Chrome 137+ ignores `--load-extension`; Chrome for Testing and Chromium do not.
- Unix socket at `$XDG_RUNTIME_DIR/ego-lite.sock`, mode 0600.
- Optional systemd **user** service so it starts at login.

### WP3 — `globalThis.ego` bindings (the core job)

Implement every method in `docs/native-bindings-api.md`, with the same result
shapes, `error_code` values and `TypeError` argument checks:

| Binding | Linux implementation |
| --- | --- |
| `getBrowserVersion` | host version + `Browser.getVersion` |
| `listProfiles` | one `Default` profile first; more later via extra user-data-dirs |
| `createTaskSpace(name, profileId?)` | new browser window; record id, name, `ownership: 'agent'` |
| `listTaskSpaces` / `claimTaskSpace` | registry; user windows show as `ownership: 'user'` |
| `useTaskSpace(id)` | local selection only (sync) |
| `createTab` / `listTabs` | `Target.createTarget` with `windowId`; filter targets by window |
| `closeTaskSpace` / `completeTaskSpace` | close window / mark done |
| `handOffTaskSpace` / `takeOverTaskSpace` | flip ownership; block mutating calls with `EGO_TASK_SPACE_USER_IN_CONTROL` |
| `setAgentTaskState` | show text in the overlay (WP5) |
| `animationHighlightMouseToPosition` | inject an animated dot via `Runtime.evaluate` |
| `sendCDPMessage` / `onCDPMessage` / `onSendCDPMessageError` | proxy raw CDP; scope to the task's targets; enforce ownership |
| `snapshot(options)` | WP4 |

Task space = one window in the shared profile. That keeps the user's logins,
which is the main point of ego lite.

### WP4 — Snapshot engine (highest risk)

The native `ego.snapshot()` returns a text tree plus `refs`
(`backendNodeId`, `role`, `name`, optional `loc`). The SDK parses this output,
so our format must match it exactly.

- Build from `Accessibility.getFullAXTree` + `DOM.getDocument` (pierce,
  all frames).
- Support `scope` (`full_page`, `only_within_viewport`, `subtree`),
  `interactiveOnly`, `includeActionMarks`, `includeStableLocator`,
  `maxResultLength`.
- Stable locators: `role:` / `css:` / `href:`; omit `loc` when not unique.
- Subtree: fail with an ambiguity error when a `backendNodeId` occurs in more
  than one frame (`docs/native-snapshot-ref-requirement.md`).
- Reference for the expected format: `src/snapshot-result.ts`,
  `src/page-ref-registry.ts`, and the fakes in `src/*.test.mjs`.
- Best source of truth: capture real snapshots from ego lite on a Mac and use
  them as golden test fixtures.

### WP5 — User control UI

ego lite has native UI for hand-off and agent status. Linux replacement:

- A small MV3 extension (loaded by the daemon) that shows a bar in agent
  windows: task name, agent state text, "Take control" / "Give back" buttons.
- The extension talks to the daemon through a native-messaging host.
- JS dialogs: follow `docs/native-javascript-dialog-requirement.md`.

### WP6 — SDK fixes for Linux (small, in this repo)

- `src/clipboard.ts`: add a Linux branch. Use `wl-copy`/`wl-paste` on Wayland,
  `xclip` on X11. Save and restore the clipboard like the macOS/Windows paths.
  Today `page.keyboard.paste` throws on Linux.
- `scripts/real-browser-e2e/ego-browser-cli.mjs`: find the Linux CLI path.
- `scripts/repro-popup-foreground.sh`: Linux CLI path.
- Keyboard code already treats non-darwin as `Control`. Check only.

### WP7 — Install and packaging

- `skills/ego-browser/scripts/install.sh`: add a Linux branch (today it dies on
  non-Darwin). Download Chrome for Testing + host, install CLI to
  `~/.local/bin`, add a `.desktop` file, enable the user service.
- Optional `.deb` package for Ubuntu 22.04 / 24.04 (amd64, then arm64).
- First-run "onboarding": put CLI on `PATH`; optional cookie import from
  Chrome/Firefox (later phase).
- Update docs: `skills/ego-browser/references/install.md`,
  `plugins/ego/README.md` ("macOS or Windows" → add Linux), `README.md`.

### WP8 — Testing and CI

- Unit tests for the host with `node --test`, like the SDK.
- Run the existing real-browser suite (`npm run e2e`) against the Linux host.
  This is the pass/fail gate: the SDK is unchanged, so passing e2e means the
  bindings are compatible.
- CI job on `ubuntu-latest` with `xvfb-run` and Chrome for Testing.
- Manual tests on Ubuntu 24.04 GNOME (Wayland) and X11.

## 4. Phases

| Phase | Content | Done when |
| --- | --- | --- |
| 0 | Capture golden snapshots and binding results from ego lite on macOS | fixtures in repo |
| 1 | WP1 + WP2 + CDP/tabs/task-space part of WP3 | `ego-browser nodejs` opens a page and runs `js()` on Ubuntu |
| 2 | WP4 snapshot engine | snapshot golden tests pass; `@N` refs click correctly |
| 3 | WP5 hand-off UI + WP6 SDK fixes | full e2e suite passes on Ubuntu |
| 4 | WP7 installer + docs, WP8 CI | one-line install on a clean Ubuntu 24.04 VM works |
| 5 | Extras: profile import, multiple profiles, arm64, `.deb` | — |

## 5. Risks

- **Snapshot parity.** The native format is not fully documented. If our text
  differs, agent prompts and refs break. Golden fixtures (phase 0) reduce this.
- **Upstream drift.** Citro Labs can change bindings in a new app version. Pin
  to a known SDK version and run e2e on each upstream merge.
- **Snap Chromium on Ubuntu.** Avoid it; ship Chrome for Testing.
- **Wayland.** Clipboard and window focus differ from X11. Test both.
- **Licence.** This repo is MIT. Do not copy or reverse-engineer code from the
  closed-source app. Build from the public docs only.

## 6. Alternative

Ask Citro Labs for an official Linux build (their site says "Built on
Chromium", so a Linux build is technically easy for them). This costs us no
code but we do not control the timeline.
