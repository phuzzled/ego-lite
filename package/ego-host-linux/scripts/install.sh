#!/bin/sh
# Install or upgrade ego lite for Linux (the ego-browser CLI, its daemon and
# the SDK) for the current user. No root needed, except for the optional
# Chrome for Testing system libraries.
#
#   sh package/ego-host-linux/scripts/install.sh            from a checkout
#   sh install.sh                                            download the pinned release
#
# Environment:
#   EGO_LITE_REPO   GitHub repo to download when not run from a checkout
#                   (default phuzzled/ego-lite)
#   EGO_LITE_REF    tag, branch or commit to download (default: the pinned
#                   release tag below; use main for the newest code)
#   EGO_LITE_SHA256 expected SHA-256 of the downloaded source archive; the
#                   install stops when it does not match
#   EGO_LITE_CHROME_FOR_TESTING=1  always download Chrome for Testing
#                   (x86_64 only; there is no Linux arm64 build)
#   EGO_LITE_VIEWER=1   also install xvfb, x11vnc and novnc with apt-get (sudo),
#                   for hand-off on a server: ego-browser start --display virtual
#   EGO_LITE_SERVICE=1  install and enable a systemd user service
#                   (EGO_LITE_SERVICE=virtual: the service uses a virtual display)

set -eu

REPO="${EGO_LITE_REPO:-phuzzled/ego-lite}"
RELEASE_TAG="linux-v0.2.0"
REF="${EGO_LITE_REF:-$RELEASE_TAG}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ego-lite"
HOST_DIR="$DATA_DIR/host"
BIN_DIR="$HOME/.local/bin"
SKILL_DIR="$HOME/.agents/skills/ego-browser"
TEMP_DIR=""

log() {
	printf '%s\n' "$*" >&2
}

die() {
	log "error: $*"
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

cleanup() {
	if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
		rm -rf "$TEMP_DIR"
	fi
}

trap cleanup EXIT HUP INT TERM

check_node() {
	require_command node
	require_command npm
	major=$(node -p 'process.versions.node.split(".")[0]')
	[ "$major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v))"
}

# Print the checkout root when this script runs from one.
find_checkout() {
	script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || return 1
	root=$(CDPATH= cd -- "$script_dir/../../.." 2>/dev/null && pwd) || return 1
	[ -f "$root/package/ego-browser/package.json" ] &&
		[ -f "$root/package/ego-host-linux/bin/ego-browser.mjs" ] || return 1
	printf '%s\n' "$root"
}

download_source() {
	require_command curl
	require_command tar
	url="https://codeload.github.com/$REPO/tar.gz/$REF"
	log "Downloading $url ..."
	mkdir -p "$TEMP_DIR/src"
	curl -fL --retry 3 --output "$TEMP_DIR/source.tar.gz" "$url" ||
		die "failed to download $REPO@$REF"
	sum=$(sha256 "$TEMP_DIR/source.tar.gz")
	log "Source archive SHA-256: $sum"
	if [ -n "${EGO_LITE_SHA256:-}" ] && [ "$sum" != "$EGO_LITE_SHA256" ]; then
		die "checksum mismatch for $REPO@$REF (expected $EGO_LITE_SHA256)"
	fi
	tar -xzf "$TEMP_DIR/source.tar.gz" -C "$TEMP_DIR/src" --strip-components=1 ||
		die "failed to unpack $REPO@$REF"
	printf '%s\n' "$TEMP_DIR/src"
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

build_sdk() {
	root="$1"
	log "Building the ego-browser SDK ..."
	(
		cd "$root/package/ego-browser"
		CI=true npm ci --no-audit --no-fund >/dev/null
		npm run build >/dev/null
	) || die "SDK build failed"
}

install_host() {
	root="$1"
	staged="$TEMP_DIR/host"
	mkdir -p "$staged"
	cp -R "$root/package/ego-host-linux/bin" "$root/package/ego-host-linux/src" \
		"$root/package/ego-host-linux/share" \
		"$root/package/ego-host-linux/package.json" "$staged/"
	rm -f "$staged"/src/*.test.mjs "$staged"/src/test-support.mjs
	cp -R "$root/package/ego-browser/dist/out" "$staged/sdk"
	chmod +x "$staged/bin/ego-browser.mjs"

	# Stop a running daemon so the new code takes over on the next call.
	if [ -x "$HOST_DIR/bin/ego-browser.mjs" ]; then
		"$HOST_DIR/bin/ego-browser.mjs" stop >/dev/null 2>&1 || true
	fi
	mkdir -p "$DATA_DIR"
	rm -rf "$HOST_DIR"
	mv "$staged" "$HOST_DIR"
	mkdir -p "$BIN_DIR"
	ln -sf "$HOST_DIR/bin/ego-browser.mjs" "$BIN_DIR/ego-browser"
	log "Installed ego-browser to $BIN_DIR/ego-browser"
}

install_entry_skill() {
	if [ -e "$SKILL_DIR" ]; then
		log "Keeping the existing agent Skill at $SKILL_DIR"
		return 0
	fi
	mkdir -p "$(dirname "$SKILL_DIR")"
	cp -R "$HOST_DIR/sdk/agent-skills/ego-browser" "$SKILL_DIR"
	log "Installed the agent Skill to $SKILL_DIR"
}

has_system_browser() {
	for name in google-chrome-stable google-chrome chromium chromium-browser; do
		path=$(command -v "$name" 2>/dev/null) || continue
		case "$path" in
		/snap/*) continue ;; # snap confinement breaks a custom profile dir
		esac
		return 0
	done
	return 1
}

# Chrome for Testing has no Linux arm64 build. There the distro Chromium (not
# the snap) or Playwright's arm64 Chromium is used; ego-browser finds both.
PLAYWRIGHT_VERSION="1.49.1"

machine_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) printf 'x86_64\n' ;;
	aarch64 | arm64) printf 'arm64\n' ;;
	*) uname -m ;;
	esac
}

install_playwright_chromium() {
	log "No Chromium found, and Chrome for Testing has no Linux arm64 build."
	log "Downloading Playwright's Chromium (playwright@$PLAYWRIGHT_VERSION) ..."
	npx --yes "playwright@$PLAYWRIGHT_VERSION" install chromium ||
		die "failed to install Playwright's Chromium. Install a non-snap chromium, or set EGO_LITE_CHROME"
	log "If it fails to start, install its libraries:"
	log "  sudo npx --yes playwright@$PLAYWRIGHT_VERSION install-deps chromium"
}

# Optional packages for hand-off on a server without a screen.
check_viewer_packages() {
	missing=""
	command -v Xvfb >/dev/null 2>&1 || missing="$missing xvfb"
	command -v x11vnc >/dev/null 2>&1 || missing="$missing x11vnc"
	[ -f /usr/share/novnc/vnc.html ] || missing="$missing novnc"
	[ -n "$missing" ] || return 0
	if [ "${EGO_LITE_VIEWER:-0}" = "1" ] && command -v apt-get >/dev/null 2>&1; then
		log "Installing the viewer packages:$missing"
		# shellcheck disable=SC2086 # one word per package
		sudo apt-get install -y $missing || log "warning: could not install$missing"
		return 0
	fi
	log "Optional, for hand-off on a server (ego-browser start --display virtual, ego-browser view):"
	log "  sudo apt-get install -y$missing"
}

install_chrome_for_testing() {
	require_command curl
	require_command unzip
	log "Downloading Chrome for Testing (stable) ..."
	url=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json |
		node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).channels.Stable.downloads.chrome.find(x=>x.platform==="linux64");process.stdout.write(d.url)})') ||
		die "cannot find the Chrome for Testing download"
	curl -fL --retry 3 --output "$TEMP_DIR/chrome.zip" "$url" ||
		die "failed to download Chrome for Testing"
	rm -rf "$DATA_DIR/chrome"
	mkdir -p "$DATA_DIR/chrome"
	unzip -q "$TEMP_DIR/chrome.zip" -d "$DATA_DIR/chrome"
	log "Installed Chrome for Testing to $DATA_DIR/chrome"
	log "If it fails to start, install its libraries:"
	log "  sudo apt-get install -y libnss3 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libasound2t64"
}

main() {
	[ "$(uname -s)" = "Linux" ] || die "this installer supports Linux only"
	check_node
	temp_base=${TMPDIR:-/tmp}
	TEMP_DIR=$(mktemp -d "${temp_base%/}/ego-lite-install.XXXXXX")

	root=$(find_checkout || true)
	[ -n "$root" ] || root=$(download_source)

	build_sdk "$root"
	install_host "$root"
	install_entry_skill

	arch=$(machine_arch)
	if [ "$arch" = "arm64" ]; then
		if [ "${EGO_LITE_CHROME_FOR_TESTING:-0}" = "1" ]; then
			log "warning: Chrome for Testing has no Linux arm64 build; ignoring EGO_LITE_CHROME_FOR_TESTING"
		fi
		has_system_browser || install_playwright_chromium
	elif [ "$arch" != "x86_64" ]; then
		has_system_browser || die "no Chromium for $arch; install one and set EGO_LITE_CHROME"
	elif [ "${EGO_LITE_CHROME_FOR_TESTING:-0}" = "1" ] || ! has_system_browser; then
		install_chrome_for_testing
	fi
	check_viewer_packages

	case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) log "Add $BIN_DIR to PATH: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
	esac

	case "${EGO_LITE_SERVICE:-0}" in
	1) "$BIN_DIR/ego-browser" service install || die "the systemd user service did not install" ;;
	virtual)
		"$BIN_DIR/ego-browser" service install --display virtual ||
			die "the systemd user service did not install"
		;;
	0) "$BIN_DIR/ego-browser" start >/dev/null || die "the ego lite daemon did not start" ;;
	*) die "EGO_LITE_SERVICE must be 1, virtual or 0" ;;
	esac
	log "ego lite is ready. Check with: ego-browser status"
}

main "$@"
