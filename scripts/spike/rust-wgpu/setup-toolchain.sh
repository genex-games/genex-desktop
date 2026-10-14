#!/usr/bin/env bash
# M0a spike only (M1.12 lands it; the product store replaces it from M2.3): install the pinned
# Rust sysroot, the spike's extra tools and the vendored crate set into an owned spike folder,
# <repo>/.studio-dev/spike-toolchain/, outside every profile and never machine-wide (no rustup,
# nothing under ~/.cargo or ~/.rustup).
#
#   setup-toolchain.sh --pin [--with GROUPS]   record official URLs + sha256s in pins.md (network)
#   setup-toolchain.sh [--with GROUPS] [--no-vendor]
#                                              install the pinned archives, then vendor (network)
#   setup-toolchain.sh --vendor                re-vendor exactly vendor-allowlist.lock (network)
#   setup-toolchain.sh --relock                re-resolve the allowlist, rewrite the lock, vendor (network)
#   setup-toolchain.sh --verify                offline check of everything installed
#
# GROUPS is a comma list of rust (always), wasm, zig, mingw, jdk, supply-chain, or all.
#
# Install only ever uses the committed pins table, scripts/spike/rust-wgpu/pins.md (rows between
# the genex-spike-pins markers; GENEX_SPIKE_APPROVALS overrides it for tests): an archive without
# a pin, a pinned URL that is not an official source (static.rust-lang.org, ziglang.org, or the
# release downloads of the GitHub repositories the archive table names; a local file:// mirror
# only with GENEX_SPIKE_ALLOW_FILE_SOURCES=1, which the tests set), and a download whose sha256
# differs from its pin are typed refusals, each checked
# before that archive is downloaded or kept and all before anything is installed; a mismatching
# download is deleted, never retried. `--pin` takes each
# checksum from what the official source publishes beside the archive (the Rust channel manifest,
# verified against its own .sha256; GitHub release digests and .sha256 sidecars; ziglang.org's
# index; the Adoptium API) and refuses a pin that would change an existing row. New rows land in
# the tracked pins.md, so a pin is reviewed before CI (which only installs and verifies) uses it.
# `GENEX_SPIKE_PIN_HOST=<triple> --pin` records another host's rows (CI's x86_64 Linux) without
# installing anything.
#
# The vendored crate set is the committed lock, vendor-allowlist.lock beside this script: install and
# --vendor copy it into the vendor manifest and run `cargo vendor --locked`, so a fresh runner
# vendors exactly the versions developers built with, never crates.io's latest. Before cargo runs,
# every crates.io package the workspace lock (<workspace>/Cargo.lock) pins must be in the committed
# lock with the same version and checksum, and afterwards the vendored tree must be exactly the
# lock's crates with its checksums; either disagreement is the typed refusal
# vendor-lock-disagreement, and --verify checks both offline. --relock is the only path that
# changes the lock: cargo resolves the allowlist starting from the committed lock (only what the
# allowlist changed moves) and the result is written back for review. GENEX_SPIKE_VENDOR_LOCK and
# GENEX_SPIKE_VENDOR_ALLOWLIST override both files for tests.
#
# Layout: downloads/ (verified archives, kept for --verify), sysroot/ (rustc, cargo, clippy,
# llvm-tools, rust-std per target), tools/ (bin/, zig/, binaryen/, llvm-mingw/, jdk/),
# vendor/ (cargo vendor --versioned-dirs), vendor-manifest/ (the allowlist manifest and a copy of the
# committed lock),
# cargo-home/config.toml (crates.io replaced by vendor/, net.offline), receipt.tsv.
#
# Refusals are the same typed stderr line and exit 78 as rust-env.sh's.

set -euo pipefail
# shellcheck source=rust-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/rust-env.sh"

SETUP_SCRIPTS="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SETUP_ALLOWLIST="${GENEX_SPIKE_VENDOR_ALLOWLIST:-$SETUP_SCRIPTS/vendor-allowlist.toml}"
SETUP_VENDOR_LOCK="${GENEX_SPIKE_VENDOR_LOCK:-$SETUP_SCRIPTS/vendor-allowlist.lock}"
SETUP_WORKSPACE_LOCK="$SPIKE_WORKSPACE/Cargo.lock"
SETUP_DOWNLOADS="$SPIKE_DIR/downloads"
SETUP_VENDOR_MANIFEST="$SPIKE_DIR/vendor-manifest"
SETUP_VENDOR_RECEIPT="$SPIKE_DIR/vendor-receipt.tsv"

RUST_CHANNEL_BASE="https://static.rust-lang.org/dist"
# Every rust-std the spike cross-builds (M0a.7, M0a.8, M0a.16) besides the host's; M0a.9 runs the
# x86_64-apple-darwin build under Rosetta for its x86 parity row.
RUST_TARGETS="wasm32-unknown-unknown aarch64-apple-ios aarch64-apple-ios-sim aarch64-linux-android x86_64-unknown-linux-gnu x86_64-pc-windows-gnullvm x86_64-apple-darwin"
WASM_BINDGEN_VERSION="0.2.129"
BINARYEN_VERSION="version_133"
ZIG_VERSION="0.16.0"
CARGO_ZIGBUILD_VERSION="0.23.4"
LLVM_MINGW_VERSION="20260922"
JDK_FEATURE_VERSION="21"
CARGO_DENY_VERSION="0.20.2"
CARGO_VET_VERSION="0.10.0"
ALL_GROUPS="rust,wasm,zig,mingw,jdk,supply-chain"
# Crates of a GL backend: WebGPU core is the floor, so the vendored tree must not hold them.
GL_CRATES="glow khronos-egl glutin glutin_egl_sys glutin_wgl_sys"
# Where an approved archive may come from (redirects must stay https): the Rust and Zig download
# servers and the release downloads of exactly the repositories setup_archives names.
OFFICIAL_SOURCES="https://static.rust-lang.org/dist/ https://ziglang.org/download/
  https://github.com/wasm-bindgen/wasm-bindgen/releases/download/
  https://github.com/WebAssembly/binaryen/releases/download/
  https://github.com/rust-cross/cargo-zigbuild/releases/download/
  https://github.com/mstorsjo/llvm-mingw/releases/download/
  https://github.com/adoptium/temurin21-binaries/releases/download/
  https://github.com/EmbarkStudios/cargo-deny/releases/download/
  https://github.com/mozilla/cargo-vet/releases/download/"
CURL_RETRIES=2
SANDBOX_EXEC="/usr/bin/sandbox-exec"
NO_NETWORK_PROFILE="(version 1)(allow default)(deny network*)"

setup_say() { printf 'setup-toolchain: %s\n' "$*" >&2; }

setup_host() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo aarch64-apple-darwin ;;
    Darwin-x86_64) echo x86_64-apple-darwin ;;
    Linux-x86_64) echo x86_64-unknown-linux-gnu ;;
    *) spike_refuse tool-missing "no spike toolchain for host $(uname -s)-$(uname -m)" ;;
  esac
}
HOST="$(setup_host)"
# Another host's pins (`--pin` only: nothing is installed for it).
if [ -n "${GENEX_SPIKE_PIN_HOST:-}" ]; then
  case " $* " in *" --pin "*) ;; *) spike_refuse usage "GENEX_SPIKE_PIN_HOST applies to --pin only" ;; esac
  case $GENEX_SPIKE_PIN_HOST in
    aarch64-apple-darwin | x86_64-apple-darwin | x86_64-unknown-linux-gnu) HOST=$GENEX_SPIKE_PIN_HOST ;;
    *) spike_refuse usage "GENEX_SPIKE_PIN_HOST must be a host the spike supports, not $GENEX_SPIKE_PIN_HOST" ;;
  esac
fi

# Per-host archive names of the extra tools.
case $HOST in
  aarch64-apple-darwin)
    WASM_BINDGEN_HOST=$HOST BINARYEN_HOST=arm64-macos ZIG_HOST=aarch64-macos MINGW_ASSET="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-macos-universal.tar.xz"
    CARGO_DENY_HOST=$HOST
    JDK_OS=mac JDK_ARCH=aarch64 ;;
  x86_64-apple-darwin)
    WASM_BINDGEN_HOST=$HOST BINARYEN_HOST=x86_64-macos ZIG_HOST=x86_64-macos MINGW_ASSET="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-macos-universal.tar.xz"
    CARGO_DENY_HOST=$HOST
    JDK_OS=mac JDK_ARCH=x64 ;;
  *)
    # wasm-bindgen and cargo-deny publish their x86_64 Linux builds for musl only (static, run on glibc too).
    WASM_BINDGEN_HOST=x86_64-unknown-linux-musl BINARYEN_HOST=x86_64-linux ZIG_HOST=x86_64-linux MINGW_ASSET="llvm-mingw-$LLVM_MINGW_VERSION-ucrt-ubuntu-22.04-x86_64.tar.xz"
    CARGO_DENY_HOST=x86_64-unknown-linux-musl
    JDK_OS=linux JDK_ARCH=x64 ;;
esac

# The archives of the selected groups as `group<TAB>file<TAB>pin source` lines. `file` is the
# local name (and the pins table key); the pin source tells --pin where the official URL and
# checksum come from.
setup_archives() {
  local groups=",$1," t
  local v=$SPIKE_RUST_VERSION
  printf 'rust\trustc-%s-%s.tar.xz\trust:rustc:%s\n' "$v" "$HOST" "$HOST"
  printf 'rust\tcargo-%s-%s.tar.xz\trust:cargo:%s\n' "$v" "$HOST" "$HOST"
  printf 'rust\tclippy-%s-%s.tar.xz\trust:clippy-preview:%s\n' "$v" "$HOST" "$HOST"
  printf 'rust\tllvm-tools-%s-%s.tar.xz\trust:llvm-tools-preview:%s\n' "$v" "$HOST" "$HOST"
  printf 'rust\trust-std-%s-%s.tar.xz\trust:rust-std:%s\n' "$v" "$HOST" "$HOST"
  for t in $RUST_TARGETS; do printf 'rust\trust-std-%s-%s.tar.xz\trust:rust-std:%s\n' "$v" "$t" "$t"; done
  case $groups in *,wasm,*)
    printf 'wasm\twasm-bindgen-%s-%s.tar.gz\tgithub:wasm-bindgen/wasm-bindgen:%s:wasm-bindgen-%s-%s.tar.gz\n' \
      "$WASM_BINDGEN_VERSION" "$WASM_BINDGEN_HOST" "$WASM_BINDGEN_VERSION" "$WASM_BINDGEN_VERSION" "$WASM_BINDGEN_HOST"
    printf 'wasm\tbinaryen-%s-%s.tar.gz\tgithub:WebAssembly/binaryen:%s:binaryen-%s-%s.tar.gz\n' \
      "$BINARYEN_VERSION" "$BINARYEN_HOST" "$BINARYEN_VERSION" "$BINARYEN_VERSION" "$BINARYEN_HOST" ;;
  esac
  case $groups in *,zig,*)
    printf 'zig\tzig-%s-%s.tar.xz\tzig:%s:%s\n' "$ZIG_HOST" "$ZIG_VERSION" "$ZIG_VERSION" "$ZIG_HOST"
    printf 'zig\tcargo-zigbuild-%s-%s.tar.xz\tgithub:rust-cross/cargo-zigbuild:v%s:cargo-zigbuild-%s.tar.xz\n' \
      "$CARGO_ZIGBUILD_VERSION" "$HOST" "$CARGO_ZIGBUILD_VERSION" "$HOST" ;;
  esac
  case $groups in *,mingw,*)
    printf 'mingw\t%s\tgithub:mstorsjo/llvm-mingw:%s:%s\n' "$MINGW_ASSET" "$LLVM_MINGW_VERSION" "$MINGW_ASSET" ;;
  esac
  case $groups in *,jdk,*)
    printf 'jdk\ttemurin-jdk-%s-%s-%s.tar.gz\tadoptium:%s:%s:%s\n' "$JDK_FEATURE_VERSION" "$JDK_OS" "$JDK_ARCH" "$JDK_FEATURE_VERSION" "$JDK_OS" "$JDK_ARCH" ;;
  esac
  case $groups in *,supply-chain,*)
    printf 'supply-chain\tcargo-deny-%s-%s.tar.gz\tgithub:EmbarkStudios/cargo-deny:%s:cargo-deny-%s-%s.tar.gz\n' \
      "$CARGO_DENY_VERSION" "$CARGO_DENY_HOST" "$CARGO_DENY_VERSION" "$CARGO_DENY_VERSION" "$CARGO_DENY_HOST"
    printf 'supply-chain\tcargo-vet-%s-%s.tar.xz\tgithub:mozilla/cargo-vet:v%s:cargo-vet-%s.tar.xz\n' \
      "$CARGO_VET_VERSION" "$HOST" "$CARGO_VET_VERSION" "$HOST" ;;
  esac
  return 0
}

setup_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

setup_source_allowed() {
  local url=$1 prefix
  case $url in file:///*) [ "${GENEX_SPIKE_ALLOW_FILE_SOURCES:-}" = 1 ] && return 0 ;; esac
  for prefix in $OFFICIAL_SOURCES; do
    case $url in "$prefix"*) return 0 ;; esac
  done
  return 1
}

setup_fetch() {
  curl -fsSL --retry "$CURL_RETRIES" --proto '=https,file' --proto-redir '=https' -o "$2" "$1"
}

# Value at a dotted path of the JSON on stdin (node is required by the repository anyway).
setup_json() {
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const v = new Function("j", "return " + process.argv[1])(JSON.parse(s));
      if (v === undefined || v === null) process.exit(3);
      process.stdout.write(String(v));
    });' "$1"
}

# ---- --pin ---------------------------------------------------------------------------------

setup_rust_manifest() {
  local manifest="$SPIKE_DIR/pin-cache/channel-rust-$SPIKE_RUST_VERSION.toml" published actual
  if [ ! -f "$manifest" ]; then
    mkdir -p "$(dirname "$manifest")"
    setup_fetch "$RUST_CHANNEL_BASE/channel-rust-$SPIKE_RUST_VERSION.toml" "$manifest.partial"
    published=$(curl -fsSL --proto '=https' "$RUST_CHANNEL_BASE/channel-rust-$SPIKE_RUST_VERSION.toml.sha256" | awk '{ print $1 }')
    actual=$(setup_sha256 "$manifest.partial")
    if [ "$published" != "$actual" ]; then
      rm -f "$manifest.partial"
      spike_refuse archive-sha256-mismatch "channel-rust-$SPIKE_RUST_VERSION.toml: published $published, downloaded $actual"
    fi
    mv "$manifest.partial" "$manifest"
  fi
  printf '%s\n' "$manifest"
}

# `url<TAB>sha256<TAB>checksum source` for one pin source spec.
setup_resolve_pin() {
  local spec=$1 kind rest
  kind=${spec%%:*}
  rest=${spec#*:}
  case $kind in
    rust)
      local pkg=${rest%%:*} target=${rest#*:} manifest
      manifest=$(setup_rust_manifest)
      awk -v section="[pkg.$pkg.target.$target]" -v src="channel-rust-$SPIKE_RUST_VERSION.toml (sha256 $(setup_sha256 "$manifest"), checked against its published .sha256)" '
        $0 == section { inside = 1; next }
        /^\[/ { inside = 0 }
        inside && $1 == "xz_url" { gsub(/"/, "", $3); url = $3 }
        inside && $1 == "xz_hash" { gsub(/"/, "", $3); sha = $3 }
        END { if (url != "" && sha != "") printf "%s\t%s\t%s\n", url, sha, src }' "$manifest"
      ;;
    github)
      local repo tag asset url digest sidecar=""
      repo=${rest%%:*}; rest=${rest#*:}; tag=${rest%%:*}; asset=${rest#*:}
      url="https://github.com/$repo/releases/download/$tag/$asset"
      digest=$(curl -fsSL --proto '=https' "https://api.github.com/repos/$repo/releases/tags/$tag" |
        setup_json "(j.assets.find((a) => a.name === '$asset') || {}).digest" 2>/dev/null || true)
      digest=${digest#sha256:}
      for ext in .sha256 .sha256sum; do
        sidecar=$(curl -fsSL --proto '=https' --proto-redir '=https' "$url$ext" 2>/dev/null | grep -oE '[0-9a-f]{64}' | sed -n 1p || true)
        [ -n "$sidecar" ] && break
      done
      if [ -n "$digest" ] && [ -n "$sidecar" ] && [ "$digest" != "$sidecar" ]; then
        spike_refuse archive-sha256-mismatch "$asset: GitHub digest $digest, published sidecar $sidecar"
      fi
      local sha=${digest:-$sidecar} src="GitHub release asset digest"
      [ -n "$digest" ] && [ -n "$sidecar" ] && src="GitHub release asset digest = published sidecar"
      [ -z "$digest" ] && src="published sidecar ${asset}.sha256"
      [ -n "$sha" ] || spike_refuse archive-not-approved "no published checksum for $asset"
      printf '%s\t%s\t%s\n' "$url" "$sha" "$src"
      ;;
    zig)
      local version=${rest%%:*} host=${rest#*:} index
      index=$(curl -fsSL --proto '=https' "https://ziglang.org/download/index.json")
      printf '%s\t%s\t%s\n' \
        "$(printf '%s' "$index" | setup_json "j['$version']['$host'].tarball")" \
        "$(printf '%s' "$index" | setup_json "j['$version']['$host'].shasum")" \
        "ziglang.org/download/index.json"
      ;;
    adoptium)
      local feature os arch json
      feature=${rest%%:*}; rest=${rest#*:}; os=${rest%%:*}; arch=${rest#*:}
      json=$(curl -fsSL --proto '=https' "https://api.adoptium.net/v3/assets/latest/$feature/hotspot?architecture=$arch&image_type=jdk&os=$os&vendor=eclipse")
      printf '%s\t%s\t%s\n' \
        "$(printf '%s' "$json" | setup_json "j[0].binary.package.link")" \
        "$(printf '%s' "$json" | setup_json "j[0].binary.package.checksum")" \
        "api.adoptium.net ($(printf '%s' "$json" | setup_json "j[0].release_name"))"
      ;;
  esac
}

# Add rows to the pins table (created at the end of the pins file if absent). The file is
# rewritten in place, so an approvals path that is a link keeps pointing at the same record.
setup_write_pins() {
  local rows=$1 target tmp
  [ -n "$rows" ] || return 0
  target=$(spike_real_path "$SPIKE_APPROVALS") || spike_refuse approvals-missing "cannot resolve $SPIKE_APPROVALS"
  tmp=$(mktemp "${TMPDIR:-/tmp}/genex-spike-pins.XXXXXX")
  if ! grep -qF "$SPIKE_PINS_BEGIN" "$target"; then
    {
      printf '\n## Pinned archives (setup-toolchain.sh --pin, M0a.17)\n\n'
      printf 'Install reads only these rows. Each sha256 is the checksum the official source publishes beside\n'
      printf 'the archive (fifth column); a row is never rewritten: a changed checksum is a typed refusal.\n\n'
      printf '%s\n| group | file | url | sha256 | checksum source |\n| --- | --- | --- | --- | --- |\n%s\n' "$SPIKE_PINS_BEGIN" "$SPIKE_PINS_END"
    } >>"$target"
  fi
  # The rows go through a file: BSD awk refuses a newline in a -v value.
  printf '%s' "$rows" >"$tmp.rows"
  awk -v end="$SPIKE_PINS_END" -v rows="$tmp.rows" '
    index($0, end) == 1 { while ((getline line < rows) > 0) print line }
    { print }' "$target" >"$tmp"
  cat "$tmp" >"$target"
  rm -f "$tmp" "$tmp.rows"
}

setup_pin() {
  spike_require_approvals
  local groups=$1 rows="" group file spec resolved url sha src pinned
  while IFS=$'\t' read -r group file spec; do
    resolved=$(setup_resolve_pin "$spec")
    IFS=$'\t' read -r url sha src <<<"$resolved"
    [ -n "$url" ] && [ -n "$sha" ] || spike_refuse archive-not-approved "no official URL and checksum for $file ($spec)"
    pinned=$(spike_pin_field "$file" 3)
    if [ -n "$pinned" ]; then
      [ "$pinned" = "$sha" ] || spike_refuse archive-sha256-mismatch "$file: pinned $pinned, official source now says $sha"
      continue
    fi
    rows="$rows| $group | $file | $url | $sha | $src |"$'\n'
    setup_say "pinned $file $sha"
  done < <(setup_archives "$groups")
  setup_write_pins "$rows"
}

# ---- install -------------------------------------------------------------------------------

setup_receipt_has() {
  [ -f "$SPIKE_RECEIPT" ] && awk -F '\t' -v f="$1" -v s="$2" '$2 == f && $3 == s { found = 1 } END { exit !found }' "$SPIKE_RECEIPT"
}

# Copy the single file named $2 found under $1 into $3.
setup_copy_binary() {
  local found
  found=$(find "$1" -type f -name "$2" | sed -n 1p)
  [ -n "$found" ] || spike_refuse tool-missing "$2 is not in the archive unpacked at $1"
  mkdir -p "$3"
  cp -p "$found" "$3/$2"
  chmod 755 "$3/$2"
}

# Unpacked tree with one top-level folder moved to $2 (replacing it).
setup_unpack_single() {
  local archive=$1 dest=$2 stage
  stage=$(mktemp -d "$SPIKE_DIR/stage.XXXXXX")
  tar -xf "$archive" -C "$stage"
  local tops
  tops=$(ls -A "$stage")
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  if [ "$(printf '%s\n' "$tops" | wc -l | tr -d ' ')" = 1 ] && [ -d "$stage/$tops" ]; then
    mv "$stage/$tops" "$dest"
    rmdir "$stage"
  else
    mv "$stage" "$dest"
  fi
}

setup_install_archive() {
  local group=$1 file=$2 archive="$SETUP_DOWNLOADS/$2" stage
  case $file in
    cargo-zigbuild-* | cargo-deny-* | cargo-vet-*) setup_install_tool "$group" "$file" "$archive" ;;
    rustc-* | cargo-* | clippy-* | llvm-tools-* | rust-std-*)
      # A Rust dist component: its own install.sh copies it into the sysroot prefix only.
      stage=$(mktemp -d "$SPIKE_DIR/stage.XXXXXX")
      tar -xf "$archive" -C "$stage"
      bash "$stage"/*/install.sh --prefix="$SPIKE_SYSROOT" --disable-ldconfig >/dev/null
      rm -rf "$stage"
      ;;
    *) setup_install_tool "$group" "$file" "$archive" ;;
  esac
}

setup_install_tool() {
  local file=$2 archive=$3 stage
  case $file in
    wasm-bindgen-*)
      stage=$(mktemp -d "$SPIKE_DIR/stage.XXXXXX")
      tar -xf "$archive" -C "$stage"
      for bin in wasm-bindgen wasm-bindgen-test-runner wasm2es6js; do setup_copy_binary "$stage" "$bin" "$SPIKE_TOOLS/bin"; done
      rm -rf "$stage"
      ;;
    binaryen-*) setup_unpack_single "$archive" "$SPIKE_TOOLS/binaryen" ;;
    zig-*) setup_unpack_single "$archive" "$SPIKE_TOOLS/zig" ;;
    llvm-mingw-*) setup_unpack_single "$archive" "$SPIKE_TOOLS/llvm-mingw" ;;
    temurin-jdk-*) setup_unpack_single "$archive" "$SPIKE_TOOLS/jdk" ;;
    cargo-zigbuild-* | cargo-deny-* | cargo-vet-*)
      local bin=${file%%-[0-9]*}
      stage=$(mktemp -d "$SPIKE_DIR/stage.XXXXXX")
      tar -xf "$archive" -C "$stage"
      setup_copy_binary "$stage" "$bin" "$SPIKE_TOOLS/bin"
      rm -rf "$stage"
      ;;
    *) spike_refuse archive-not-approved "no installer for $file" ;;
  esac
}

setup_install() {
  local groups=$1 vendor=$2 list group file url sha actual
  spike_require_approvals
  if [ "$vendor" = yes ]; then
    setup_require_vendor_lock
    setup_check_workspace_lock
  fi
  list=$(setup_archives "$groups")
  # One archive at a time: its pin and source are checked before it is downloaded, and its bytes
  # before the next; nothing is installed until every archive is downloaded and verified.
  while IFS=$'\t' read -r group file _; do
    url=$(spike_pin_field "$file" 2)
    sha=$(spike_pin_field "$file" 3)
    [ -n "$url" ] && [ -n "$sha" ] || spike_refuse archive-not-approved "$file has no pin in $SPIKE_APPROVALS (run --pin, or M0a.0)"
    setup_source_allowed "$url" || spike_refuse archive-source-refused "$file: $url is not an official source"
    if [ -f "$SETUP_DOWNLOADS/$file" ] && [ "$(setup_sha256 "$SETUP_DOWNLOADS/$file")" = "$sha" ]; then continue; fi
    mkdir -p "$SETUP_DOWNLOADS"
    setup_say "downloading $file"
    rm -f "$SETUP_DOWNLOADS/$file.partial"
    setup_fetch "$url" "$SETUP_DOWNLOADS/$file.partial" || {
      rm -f "$SETUP_DOWNLOADS/$file.partial"
      spike_refuse download-failed "$file from $url"
    }
    actual=$(setup_sha256 "$SETUP_DOWNLOADS/$file.partial")
    if [ "$actual" != "$sha" ]; then
      rm -f "$SETUP_DOWNLOADS/$file.partial"
      spike_refuse archive-sha256-mismatch "$file: downloaded $actual, approved $sha"
    fi
    mv "$SETUP_DOWNLOADS/$file.partial" "$SETUP_DOWNLOADS/$file"
  done <<<"$list"
  while IFS=$'\t' read -r group file _; do
    sha=$(spike_pin_field "$file" 3)
    url=$(spike_pin_field "$file" 2)
    setup_receipt_has "$file" "$sha" && continue
    setup_say "installing $file"
    setup_install_archive "$group" "$file"
    printf '%s\t%s\t%s\t%s\n' "$group" "$file" "$sha" "$url" >>"$SPIKE_RECEIPT"
  done <<<"$list"
  [ "$vendor" = yes ] && setup_vendor locked
  setup_write_cargo_config
  setup_say "installed into $SPIKE_DIR"
}

# ---- vendoring -----------------------------------------------------------------------------

setup_write_cargo_config() {
  mkdir -p "$SPIKE_CARGO_HOME"
  cat >"$SPIKE_CARGO_HOME/config.toml" <<EOF
# Written by scripts/spike/rust-wgpu/setup-toolchain.sh: crates.io is replaced by the vendored
# tree (vendor-allowlist.toml) and cargo never opens the network.
[source.crates-io]
replace-with = "genex-spike-vendored"

[source.genex-spike-vendored]
directory = "$SPIKE_VENDOR"

[net]
offline = true
EOF
}

# `name<TAB>version<TAB>checksum` of every crates.io package of a Cargo.lock (a workspace member
# or path package has no checksum).
setup_locked_crates() {
  awk '
    /^\[\[package\]\]/ { name = ""; version = "" }
    $1 == "name" { gsub(/"/, "", $3); name = $3 }
    $1 == "version" && name != "" { gsub(/"/, "", $3); version = $3 }
    $1 == "checksum" && name != "" { gsub(/"/, "", $3); printf "%s\t%s\t%s\n", name, version, $3 }' "$1"
}

setup_require_vendor_lock() {
  [ -f "$SETUP_VENDOR_LOCK" ] ||
    spike_refuse vendor-lock-missing "no committed vendor lock at $SETUP_VENDOR_LOCK: create it with setup-toolchain.sh --relock (network) and commit it"
}

# Every crates.io package the workspace lock pins is in the committed lock with the same version
# and checksum (offline; nothing runs). A workspace without a lock has nothing to disagree with.
setup_check_workspace_lock() {
  [ -f "$SETUP_WORKSPACE_LOCK" ] || return 0
  local verdict
  verdict=$(
    {
      setup_locked_crates "$SETUP_VENDOR_LOCK" | sed 's/^/vendor\t/'
      setup_locked_crates "$SETUP_WORKSPACE_LOCK" | sed 's/^/workspace\t/'
    } | awk -F '\t' -v ws="$SETUP_WORKSPACE_LOCK" -v vl="$SETUP_VENDOR_LOCK" '
      $1 == "vendor" { sum[$2 " " $3] = $4; next }
      first == "" && !(($2 " " $3) in sum) {
        first = sprintf("%s pins %s %s, which %s does not lock: add it with setup-toolchain.sh --relock, or move the workspace to the locked version", ws, $2, $3, vl)
      }
      first == "" && (($2 " " $3) in sum) && sum[$2 " " $3] != $4 {
        first = sprintf("%s pins %s %s with checksum %s, %s with %s", ws, $2, $3, $4, vl, sum[$2 " " $3])
      }
      END { if (first != "") print first }'
  )
  [ -z "$verdict" ] || spike_refuse vendor-lock-disagreement "$verdict"
}

# The vendored set agrees with the committed lock: the vendor manifest's lock is the committed one,
# every locked crate is vendored with its checksum and nothing else is vendored. $1 is the
# manifest folder and $2 the vendored tree (the installed ones by default).
setup_check_lock_agreement() {
  local manifest=${1:-$SETUP_VENDOR_MANIFEST} vendor=${2:-$SPIKE_VENDOR} name version sum dir recorded count=0 extra
  setup_check_workspace_lock
  cmp -s "$manifest/Cargo.lock" "$SETUP_VENDOR_LOCK" ||
    spike_refuse vendor-lock-disagreement "the vendor manifest's lock $manifest/Cargo.lock is not the committed $SETUP_VENDOR_LOCK: run setup-toolchain.sh --vendor"
  while IFS=$'\t' read -r name version sum; do
    dir="$vendor/$name-$version"
    [ -f "$dir/.cargo-checksum.json" ] || spike_refuse vendor-lock-disagreement "$name $version is locked but not vendored in $vendor"
    recorded=$(grep -oE '"package":"[0-9a-f]{64}"' "$dir/.cargo-checksum.json" | grep -oE '[0-9a-f]{64}' || true)
    [ "$recorded" = "$sum" ] || spike_refuse vendor-checksum-mismatch "$name $version: lock $sum, vendored $recorded"
    count=$((count + 1))
  done < <(setup_locked_crates "$SETUP_VENDOR_LOCK")
  extra=$(
    {
      setup_locked_crates "$SETUP_VENDOR_LOCK" | awk -F '\t' '{ printf "lock\t%s-%s\n", $1, $2 }'
      ls "$vendor" | sed 's/^/dir\t/'
    } | awk -F '\t' '$1 == "lock" { locked[$2] = 1; next }
        !($2 in locked) { out = out (out == "" ? "" : ", ") $2 }
        END { print out }'
  )
  [ -z "$extra" ] || spike_refuse vendor-lock-disagreement "vendored but not in $SETUP_VENDOR_LOCK: $extra"
  setup_say "ok: $count vendored crates are exactly the committed lock's, checksums included"
}

# Vendor the allowlist into a staged tree and move it into place once it agrees with the lock.
# $1 = locked (the committed lock, `cargo vendor --locked`) or relock (cargo may move the lock,
# which is then written back to the committed file).
setup_vendor() {
  local mode=${1:-locked}
  spike_check_tool "$SPIKE_SYSROOT/bin/cargo"
  if [ "$mode" = locked ]; then
    setup_require_vendor_lock
    setup_check_workspace_lock
  fi
  # A throwaway CARGO_HOME inside the spike folder holds the registry index and .crate cache while
  # vendoring; it is removed afterwards (the vendored tree is the only crate source kept).
  local fetch_home="$SPIKE_DIR/cargo-home-fetch" next="$SPIKE_DIR/vendor.next" manifest="$SPIKE_DIR/vendor-manifest.next" status=0
  rm -rf "$next" "$manifest"
  mkdir -p "$manifest"
  {
    printf '# Generated by setup-toolchain.sh from scripts/spike/rust-wgpu/vendor-allowlist.toml; never built.\n'
    printf '[package]\nname = "genex-spike-vendor"\nversion = "0.0.0"\nedition = "2024"\npublish = false\n\n[lib]\npath = "lib.rs"\n\n'
    cat "$SETUP_ALLOWLIST"
  } >"$manifest/Cargo.toml"
  : >"$manifest/lib.rs"
  [ -f "$SETUP_VENDOR_LOCK" ] && cp "$SETUP_VENDOR_LOCK" "$manifest/Cargo.lock"
  local locked=()
  [ "$mode" = locked ] && locked=(--locked)
  (
    unset RUSTUP_TOOLCHAIN RUSTUP_HOME RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CARGO_NET_OFFLINE
    export CARGO_HOME="$fetch_home" RUSTC="$SPIKE_SYSROOT/bin/rustc" PATH="$SPIKE_SYSROOT/bin:$(spike_filtered_path)"
    "$SPIKE_SYSROOT/bin/cargo" vendor --quiet ${locked[@]+"${locked[@]}"} --manifest-path "$manifest/Cargo.toml" --versioned-dirs "$next" >/dev/null
  ) || status=$?
  rm -rf "$fetch_home"
  if [ "$status" != 0 ]; then
    rm -rf "$next" "$manifest"
    [ "$mode" = locked ] &&
      spike_refuse cargo-vendor-failed "cargo vendor --locked over $SETUP_VENDOR_LOCK exited $status: a crate or feature the allowlist needs that the lock lacks is added with setup-toolchain.sh --relock"
    spike_refuse cargo-vendor-failed "cargo vendor over $SETUP_ALLOWLIST exited $status"
  fi
  if [ "$mode" = relock ] && ! cmp -s "$manifest/Cargo.lock" "$SETUP_VENDOR_LOCK"; then
    # Rewritten in place, so a lock path that is a link keeps pointing at the same file.
    if [ -f "$SETUP_VENDOR_LOCK" ]; then cat "$manifest/Cargo.lock" >"$SETUP_VENDOR_LOCK"; else cp "$manifest/Cargo.lock" "$SETUP_VENDOR_LOCK"; fi
    setup_say "relocked $SETUP_VENDOR_LOCK: review and commit it"
  fi
  # The workspace lock is checked last on a relock: a moved version is reported, not undone.
  [ "$mode" = locked ] && setup_check_lock_agreement "$manifest" "$next"
  rm -rf "$SPIKE_VENDOR" "$SETUP_VENDOR_MANIFEST"
  mv "$next" "$SPIKE_VENDOR"
  mv "$manifest" "$SETUP_VENDOR_MANIFEST"
  printf 'lock\t%s\ncrates\t%s\n' "$(setup_sha256 "$SETUP_VENDOR_LOCK")" "$(ls "$SPIKE_VENDOR" | wc -l | tr -d ' ')" >"$SETUP_VENDOR_RECEIPT"
  setup_check_no_gl
  [ "$mode" = relock ] && setup_check_lock_agreement
  setup_say "vendored $(ls "$SPIKE_VENDOR" | wc -l | tr -d ' ') crates into $SPIKE_VENDOR"
}

setup_check_no_gl() {
  local crate dir
  for crate in $GL_CRATES; do
    for dir in "$SPIKE_VENDOR/$crate"-[0-9]*; do
      [ -e "$dir" ] && spike_refuse vendor-gl-crate "$(basename "$dir") is vendored: a GL backend crate (WebGPU core is the floor)"
    done
  done
  return 0
}

# ---- --verify ------------------------------------------------------------------------------

setup_expect_version() {
  local out
  out=$("$SPIKE_SYSROOT/bin/$1" --version) || spike_refuse tool-missing "$1 --version failed"
  case $out in
    "$1 $SPIKE_RUST_VERSION "*) setup_say "ok: $out" ;;
    *) spike_refuse tool-version-mismatch "$1 is '$out', pinned $SPIKE_RUST_VERSION" ;;
  esac
}

# `cargo metadata --offline` over the allowlist manifest, with the network denied where the host
# can deny it, resolves every package from the vendored tree.
setup_verify_metadata() {
  local runner=() json vendor_real outside
  [ "$(uname -s)" = Darwin ] && [ -x "$SANDBOX_EXEC" ] && runner=("$SANDBOX_EXEC" -p "$NO_NETWORK_PROFILE")
  json=$(
    spike_export_env
    ${runner[@]+"${runner[@]}"} "$SPIKE_SYSROOT/bin/cargo" metadata --offline --locked --format-version 1 \
      --manifest-path "$SETUP_VENDOR_MANIFEST/Cargo.toml"
  ) || spike_refuse metadata-failed "cargo metadata --offline failed over the vendored registry"
  vendor_real=$(cd -P "$SPIKE_VENDOR" && pwd -P)
  outside=$(printf '%s' "$json" | setup_json "j.packages.filter((p) => p.source !== null && !p.manifest_path.startsWith('$vendor_real/')).map((p) => p.name + ' ' + p.version).join(', ') || 'none'")
  [ "$outside" = none ] || spike_refuse metadata-outside-vendor "resolved outside $SPIKE_VENDOR: $outside"
  setup_say "ok: cargo metadata --offline resolves $(printf '%s' "$json" | setup_json "j.packages.length") packages, all from the vendored tree${runner[*]:+ (network denied)}"
}

setup_verify() {
  spike_require_approvals
  [ -d "$SPIKE_DIR" ] || spike_refuse toolchain-missing "no spike toolchain at $SPIKE_DIR: run setup-toolchain.sh"
  # The committed locks first: offline, and a disagreement fails every offline build.
  setup_require_vendor_lock
  setup_check_workspace_lock
  spike_check_receipt
  local group file sha url actual n=0
  while IFS=$'\t' read -r group file sha url; do
    [ -f "$SETUP_DOWNLOADS/$file" ] || spike_refuse toolchain-missing "the approved archive $file is no longer in $SETUP_DOWNLOADS"
    actual=$(setup_sha256 "$SETUP_DOWNLOADS/$file")
    [ "$actual" = "$sha" ] || spike_refuse archive-sha256-mismatch "$file: on disk $actual, approved $sha"
    n=$((n + 1))
  done <"$SPIKE_RECEIPT"
  setup_say "ok: $n archives match their approved sha256"
  spike_check_sysroot
  setup_expect_version cargo
  setup_expect_version rustc
  for file in cargo-zigbuild cargo-deny cargo-vet wasm-bindgen wasm-bindgen-test-runner; do
    [ -e "$SPIKE_TOOLS/bin/$file" ] && spike_check_tool "$SPIKE_TOOLS/bin/$file"
  done
  setup_check_no_gl
  setup_check_lock_agreement
  setup_verify_metadata
  setup_say "verified $SPIKE_DIR"
}

# ---- main ----------------------------------------------------------------------------------

setup_main() {
  local mode=install groups=rust vendor=yes
  while [ $# -gt 0 ]; do
    case $1 in
      --pin) mode=pin ;;
      --verify) mode=verify ;;
      --vendor) mode=vendor ;;
      --relock) mode=relock ;;
      --no-vendor) vendor=no ;;
      --with)
        shift
        groups="rust,${1:-}"
        ;;
      --with=*) groups="rust,${1#--with=}" ;;
      *) spike_refuse usage "unknown option $1 (see the header of setup-toolchain.sh)" ;;
    esac
    shift
  done
  case ",$groups," in *,all,*) groups=$ALL_GROUPS ;; esac
  case $mode in
    pin) setup_pin "$groups" ;;
    verify) setup_verify ;;
    vendor | relock)
      spike_require_approvals
      spike_check_receipt
      [ "$mode" = vendor ] && setup_require_vendor_lock
      setup_vendor "${mode/vendor/locked}"
      setup_write_cargo_config
      ;;
    install) setup_install "$groups" "$vendor" ;;
  esac
}

setup_main "$@"
