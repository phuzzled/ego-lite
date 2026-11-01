#!/bin/sh
# Build a .deb of ego lite for Linux from this checkout.
#
#   sh package/ego-host-linux/scripts/build-deb.sh [<out-dir>]
#
# The package is Architecture: all (plain JavaScript). It installs the host to
# /usr/lib/ego-lite and links /usr/bin/ego-browser. Chrome is a recommended
# package, not bundled; on arm64 use the distro chromium (not the snap) or
# Playwright's arm64 Chromium, and set EGO_LITE_CHROME if needed.
#
# Needs dpkg-deb, Node.js 22+ and npm. Builds the SDK first unless
# package/ego-browser/dist/out already exists (EGO_LITE_DEB_REBUILD=1 forces it).

set -eu

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is required"
command -v node >/dev/null 2>&1 || die "node is required"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
host="$root/package/ego-host-linux"
sdk="$root/package/ego-browser"
out_dir="${1:-$host/dist}"
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)

version=$(node -p 'require(process.argv[1]).version' "$host/package.json")

if [ "${EGO_LITE_DEB_REBUILD:-0}" = "1" ] || [ ! -f "$sdk/dist/out/index.js" ]; then
	printf 'Building the ego-browser SDK ...\n' >&2
	(cd "$sdk" && CI=true npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null) ||
		die "SDK build failed"
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/ego-lite-deb.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM

lib="$stage/usr/lib/ego-lite"
mkdir -p "$lib" "$stage/usr/bin" "$stage/DEBIAN" "$stage/usr/share/doc/ego-lite"
cp -R "$host/bin" "$host/src" "$host/share" "$host/package.json" "$lib/"
rm -f "$lib"/src/*.test.mjs "$lib/src/test-support.mjs"
cp -R "$sdk/dist/out" "$lib/sdk"
chmod 0755 "$lib/bin/ego-browser.mjs"
ln -s ../lib/ego-lite/bin/ego-browser.mjs "$stage/usr/bin/ego-browser"
cp "$host/README.md" "$stage/usr/share/doc/ego-lite/README.md"
if [ -f "$root/LICENSE" ]; then
	cp "$root/LICENSE" "$stage/usr/share/doc/ego-lite/copyright"
fi

size=$(du -sk "$stage/usr" | cut -f1)
cat >"$stage/DEBIAN/control" <<EOF
Package: ego-lite
Version: $version
Architecture: all
Maintainer: ego lite <noreply@github.com>
Installed-Size: $size
Depends: nodejs (>= 22)
Recommends: google-chrome-stable | chromium | chromium-browser, xvfb, x11vnc, novnc
Section: web
Priority: optional
Homepage: https://github.com/phuzzled/ego-lite
Description: browser for AI agents (ego-browser CLI and daemon for Linux)
 Runs Chrome or Chromium for AI agents behind the ego-browser SDK: task
 spaces, snapshots, hand-off to a user through a local noVNC viewer, round
 logs and resource limits. DevTools is a private pipe, not a port.
EOF

# mktemp -d makes the root 0700, and a strict umask (077) makes every copied
# file private: dpkg-deb then refuses DEBIAN/, or the package installs
# /usr/lib/ego-lite unreadable for other users. Set package modes explicitly.
chmod -R u=rwX,go=rX "$stage"

deb="$out_dir/ego-lite_${version}_all.deb"
dpkg-deb --root-owner-group --build "$stage" "$deb" >/dev/null
printf '%s\n' "$deb"
