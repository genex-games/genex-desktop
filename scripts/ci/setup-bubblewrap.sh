#!/usr/bin/env bash
# Builds the pinned bubblewrap the Linux game box needs on a CI runner and points GENEX_BWRAP at it.
# The box passes `--disable-userns`, which bubblewrap added in 0.8; Ubuntu 22.04's own package is
# 0.6.1, which exits 1 on that argument before the game starts. The source is the release tarball,
# checked against its pinned SHA-256 before anything is unpacked; nothing is installed system-wide.
#
#   bash scripts/ci/setup-bubblewrap.sh        (needs meson, ninja-build, libcap-dev, pkg-config)
#
# Called by the jobs that run `scripts/ci/rust-linux-host.ts --step headless-box`, which refuses a
# bubblewrap older than 0.8 (`tool-missing`); `--check-workflow` holds the order.
set -euo pipefail

BWRAP_VERSION="0.11.2"
BWRAP_URL="https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz"
BWRAP_SHA256="69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6"

root="${RUNNER_TEMP:?RUNNER_TEMP is not set}/bubblewrap"
rm -rf "$root"
mkdir -p "$root"
archive="$root/bubblewrap-${BWRAP_VERSION}.tar.xz"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$archive" "$BWRAP_URL"
echo "${BWRAP_SHA256}  ${archive}" | sha256sum --check --strict -
tar -xJf "$archive" -C "$root"
src="$root/bubblewrap-${BWRAP_VERSION}"
meson setup "$root/build" "$src" \
  -Dman=disabled -Dselinux=disabled -Dtests=false \
  -Dbash_completion=disabled -Dzsh_completion=disabled
ninja -C "$root/build" bwrap
bwrap="$root/build/bwrap"
test -f "$bwrap" && test ! -L "$bwrap"
version="$("$bwrap" --version)"
test "$version" = "bubblewrap ${BWRAP_VERSION}"
echo "$version at $bwrap"
echo "GENEX_BWRAP=$bwrap" >> "${GITHUB_ENV:?GITHUB_ENV is not set}"
