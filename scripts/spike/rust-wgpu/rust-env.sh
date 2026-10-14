#!/usr/bin/env bash
# M0a spike only: run a cargo command, or a tool the spike folder installed, with the pinned Rust
# sysroot setup-toolchain.sh installed. Kept for the spike scripts that source it; everything else
# runs cargo through scripts/toolchains/rust-env.ts (M1.12), which applies the same rules.
#
#   bash scripts/spike/rust-wgpu/rust-env.sh cargo test -p genex --offline --locked
#   bash scripts/spike/rust-wgpu/rust-env.sh wasm-bindgen --version
#   eval "$(bash scripts/spike/rust-wgpu/rust-env.sh --print-env)"
#
# - The sysroot's bin comes first on PATH; ~/.cargo/bin, rustup's folders and any folder holding a
#   `rustup` are dropped from PATH, RUSTUP_* are unset and the rustc wrappers are set empty (which
#   also overrides a config file's): rustup and ~/.cargo are never consulted.
# - CARGO_HOME is the spike's own, whose config replaces crates.io with the vendored tree.
# - Every cargo subcommand that takes one gets `--manifest-path <workspace>/Cargo.toml`
#   (native/genex-rust by default); a caller's own --manifest-path or `+toolchain` is refused, and
#   so are `--config` and `-Z` (either could re-enable the network, a wrapper or another source).
# - A `.cargo/config` or `.cargo/config.toml` in any folder above the build's working folder or the
#   workspace is refused: cargo would read it (a runner, a linker, a rustc wrapper, a source).
# - The cross-compiler env (Android NDK, llvm-mingw, iOS deployment target, JAVA_HOME) is
#   exported for whatever is installed.
# - `cargo test` and `cargo bench` run with GENEX_NO_WINDOW=1, so a test that reaches the desktop
#   shell's window is refused `window-refused` instead of opening one; a caller's explicit
#   GENEX_NO_WINDOW=0 (the owner's windowed smoke rows) is kept.
#
# Before running anything it checks that every archive in the spike receipt is pinned in the
# committed pins.md beside this script with the same sha256 and that the tools are present inside the spike folder. A
# failed check prints one typed line on stderr and exits 78:
#   genex-spike-refusal: {"code":"<code>","detail":"<text>"}
#
# Overrides (tests and other worktrees): GENEX_SPIKE_TOOLCHAIN_DIR, GENEX_SPIKE_APPROVALS,
# GENEX_SPIKE_WORKSPACE. CARGO_TARGET_DIR defaults to <repo>/.studio-dev/cargo-target.
#
# Sourcing this file (setup-toolchain.sh does) defines the helpers and runs nothing.
# Written for the bash 3.2 macOS ships: no associative arrays, no mapfile.

set -euo pipefail

SPIKE_RUST_VERSION="1.99.0"
SPIKE_REFUSAL_EXIT=78
SPIKE_IOS_DEPLOYMENT_TARGET="16.0"
SPIKE_ANDROID_API=29
# The plan pins NDK r30; this run uses the installed 27.x without new licences (recorded deviation).
SPIKE_NDK_VERSIONS="30.0.16248370 27.1.12297006 27.0.12077973"
SPIKE_SYSROOT_TOOLS="cargo rustc rustdoc cargo-clippy clippy-driver"
# Cargo subcommands that take --manifest-path (cargo-zigbuild, cargo-deny and cargo-vet included).
SPIKE_MANIFEST_SUBCOMMANDS=" build b check c test t clippy run r doc d bench metadata tree fetch vendor update generate-lockfile rustc rustdoc clean package pkgid locate-project verify-project fix fmt zigbuild deny vet "
# Cargo subcommands that run test or bench binaries: they never get a window.
SPIKE_NO_WINDOW_SUBCOMMANDS=" test t bench "
# Global cargo options that consume the next argument.
SPIKE_CARGO_VALUE_OPTIONS=" --config -C --color -Z --explain "

SPIKE_REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
SPIKE_DIR="${GENEX_SPIKE_TOOLCHAIN_DIR:-$SPIKE_REPO/.studio-dev/spike-toolchain}"
SPIKE_APPROVALS="${GENEX_SPIKE_APPROVALS:-$SPIKE_REPO/scripts/spike/rust-wgpu/pins.md}"
SPIKE_WORKSPACE="${GENEX_SPIKE_WORKSPACE:-$SPIKE_REPO/native/genex-rust}"
SPIKE_SYSROOT="$SPIKE_DIR/sysroot"
SPIKE_CARGO_HOME="$SPIKE_DIR/cargo-home"
SPIKE_VENDOR="$SPIKE_DIR/vendor"
SPIKE_TOOLS="$SPIKE_DIR/tools"
SPIKE_RECEIPT="$SPIKE_DIR/receipt.tsv"
SPIKE_PINS_BEGIN="<!-- genex-spike-pins:begin -->"
SPIKE_PINS_END="<!-- genex-spike-pins:end -->"

spike_json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# Print the typed refusal line and exit 78.
spike_refuse() {
  printf 'genex-spike-refusal: {"code":"%s","detail":"%s"}\n' "$1" "$(spike_json_escape "$2")" >&2
  exit "$SPIKE_REFUSAL_EXIT"
}

# The canonical path of an existing file, following every symlink (no GNU realpath on macOS).
spike_real_path() {
  local p=$1 hops=0 target dir
  while [ -L "$p" ]; do
    target=$(readlink "$p")
    case $target in
      /*) p=$target ;;
      *) p="$(dirname "$p")/$target" ;;
    esac
    hops=$((hops + 1))
    [ "$hops" -lt 40 ] || return 1
  done
  dir=$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "$dir" "$(basename "$p")"
}

# The pins table rows of pins.md as `file<TAB>url<TAB>sha256<TAB>group` lines.
spike_pins() {
  awk -v begin="$SPIKE_PINS_BEGIN" -v end="$SPIKE_PINS_END" '
    index($0, begin) == 1 { inside = 1; next }
    index($0, end) == 1 { inside = 0; next }
    inside && /^\|/ {
      n = split($0, cell, "|")
      if (n < 6) next
      for (i = 2; i <= 5; i++) { gsub(/^[ \t]+|[ \t]+$/, "", cell[i]) }
      if (cell[3] == "file" || cell[3] ~ /^-+$/) next
      printf "%s\t%s\t%s\t%s\n", cell[3], cell[4], cell[5], cell[2]
    }' "$SPIKE_APPROVALS"
}

# One field of the pin for an archive file name: 2 = url, 3 = sha256. Empty when not pinned.
spike_pin_field() {
  spike_pins | awk -F '\t' -v file="$1" -v field="$2" '$1 == file && !done { print $field; done = 1 }'
}

spike_require_approvals() {
  [ -f "$SPIKE_APPROVALS" ] || spike_refuse approvals-missing "no approvals file at $SPIKE_APPROVALS (M0a.0)"
}

# Every archive the receipt says was installed must be pinned with the same sha256.
spike_check_receipt() {
  [ -f "$SPIKE_RECEIPT" ] || spike_refuse toolchain-missing "no spike toolchain at $SPIKE_DIR: run scripts/spike/rust-wgpu/setup-toolchain.sh"
  local verdict
  # No early `exit` in awk: with pipefail a writer killed by SIGPIPE would fail the script.
  verdict=$(spike_pins | awk -F '\t' '
    FILENAME == "-" { pin[$1] = $3; next }
    NF >= 3 && first == "" {
      if (!($2 in pin)) first = sprintf("archive-not-approved\t%s is installed but not pinned in pins.md", $2)
      else if (pin[$2] != $3) first = sprintf("archive-sha256-mismatch\t%s: installed %s, approved %s", $2, $3, pin[$2])
    }
    END { if (first != "") print first }' - "$SPIKE_RECEIPT")
  [ -z "$verdict" ] || spike_refuse "${verdict%%$'\t'*}" "${verdict#*$'\t'}"
}

# Path is inside the spike folder once every link is followed.
spike_inside() {
  local real spike_real
  real=$(spike_real_path "$1") || return 1
  spike_real=$(cd -P "$SPIKE_DIR" && pwd -P) || return 1
  case $real in
    "$spike_real"/*) return 0 ;;
    *) return 1 ;;
  esac
}

spike_check_tool() {
  local file=$1
  [ -e "$file" ] || spike_refuse tool-missing "$(basename "$file") is not installed at $file"
  spike_inside "$file" || spike_refuse tool-outside-spike "$file resolves outside the spike folder"
  [ -x "$file" ] || spike_refuse tool-missing "$file is not executable"
}

spike_check_sysroot() {
  local tool
  for tool in $SPIKE_SYSROOT_TOOLS; do spike_check_tool "$SPIKE_SYSROOT/bin/$tool"; done
  [ -f "$SPIKE_CARGO_HOME/config.toml" ] || spike_refuse vendor-missing "no vendored CARGO_HOME config at $SPIKE_CARGO_HOME/config.toml"
  [ -d "$SPIKE_VENDOR" ] && [ -n "$(ls -A "$SPIKE_VENDOR" 2>/dev/null)" ] ||
    spike_refuse vendor-missing "no vendored crates at $SPIKE_VENDOR: run setup-toolchain.sh"
}

# The installed Android NDK: ANDROID_NDK_HOME, else a known version under the SDK.
spike_ndk() {
  if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
    printf '%s\n' "$ANDROID_NDK_HOME"
    return 0
  fi
  local sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}" v
  for v in $SPIKE_NDK_VERSIONS; do
    if [ -d "$sdk/ndk/$v" ]; then
      printf '%s\n' "$sdk/ndk/$v"
      return 0
    fi
  done
  return 1
}

spike_ndk_bin() {
  local ndk host=darwin-x86_64
  ndk=$(spike_ndk) || return 1
  [ "$(uname -s)" = Linux ] && host=linux-x86_64
  printf '%s\n' "$ndk/toolchains/llvm/prebuilt/$host/bin"
}

SPIKE_LLVM_MINGW="$SPIKE_TOOLS/llvm-mingw"

# PATH without ~/.cargo/bin, rustup folders or any folder that holds a rustup.
spike_filtered_path() {
  local out="" dir old_ifs=$IFS original_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    [ "$dir" = "$HOME/.cargo/bin" ] && continue
    [ "$dir" = "$original_cargo_home/bin" ] && continue
    case $dir in */.rustup/* | */.rustup) continue ;; esac
    [ -x "$dir/rustup" ] && continue
    out="${out:+$out:}$dir"
  done
  IFS=$old_ifs
  printf '%s\n' "$out"
}

# Export the spike environment for this process and its children.
spike_export_env() {
  local path_head="$SPIKE_SYSROOT/bin" extra
  for extra in "$SPIKE_TOOLS/bin" "$SPIKE_TOOLS/zig" "$SPIKE_TOOLS/binaryen/bin"; do
    [ -d "$extra" ] && path_head="$path_head:$extra"
  done
  PATH="$path_head:$(spike_filtered_path)"
  export PATH
  unset RUSTUP_TOOLCHAIN RUSTUP_HOME CARGO_BUILD_RUSTC
  # Empty, not unset: an empty wrapper variable also overrides `build.rustc-wrapper` in a config.
  export RUSTC_WRAPPER="" RUSTC_WORKSPACE_WRAPPER="" CARGO_BUILD_RUSTC_WRAPPER="" CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=""
  export CARGO_HOME="$SPIKE_CARGO_HOME"
  export CARGO="$SPIKE_SYSROOT/bin/cargo"
  export RUSTC="$SPIKE_SYSROOT/bin/rustc"
  export RUSTDOC="$SPIKE_SYSROOT/bin/rustdoc"
  export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$SPIKE_REPO/.studio-dev/cargo-target}"
  export CARGO_NET_OFFLINE=true
  export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-$SPIKE_IOS_DEPLOYMENT_TARGET}"
  local ndk_bin
  if ndk_bin=$(spike_ndk_bin) && [ -d "$ndk_bin" ]; then
    export ANDROID_NDK_HOME="${ndk_bin%/toolchains/*}"
    export ANDROID_NDK_ROOT="$ANDROID_NDK_HOME"
    export CC_aarch64_linux_android="$ndk_bin/aarch64-linux-android$SPIKE_ANDROID_API-clang"
    export CXX_aarch64_linux_android="$ndk_bin/aarch64-linux-android$SPIKE_ANDROID_API-clang++"
    export AR_aarch64_linux_android="$ndk_bin/llvm-ar"
    export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
  fi
  if [ -d "$SPIKE_LLVM_MINGW/bin" ]; then
    export CC_x86_64_pc_windows_gnullvm="$SPIKE_LLVM_MINGW/bin/x86_64-w64-mingw32-clang"
    export CXX_x86_64_pc_windows_gnullvm="$SPIKE_LLVM_MINGW/bin/x86_64-w64-mingw32-clang++"
    export AR_x86_64_pc_windows_gnullvm="$SPIKE_LLVM_MINGW/bin/llvm-ar"
    export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER="$CC_x86_64_pc_windows_gnullvm"
  fi
  if [ -d "$SPIKE_TOOLS/jdk/Contents/Home" ]; then
    export JAVA_HOME="$SPIKE_TOOLS/jdk/Contents/Home"
  elif [ -d "$SPIKE_TOOLS/jdk/bin" ]; then
    export JAVA_HOME="$SPIKE_TOOLS/jdk"
  fi
}

# A `--target` needs its rust-std in the sysroot and, for some targets, a cross linker.
spike_check_target() {
  local target=$1 std
  # `cargo tree --target all` and the host spellings name no extra rust-std.
  case $target in all | host | host-tuple) return 0 ;; esac
  std=$target
  case $target in *-gnu.*) std=${target%%-gnu.*}-gnu ;; esac
  [ -d "$SPIKE_SYSROOT/lib/rustlib/$std/lib" ] ||
    spike_refuse tool-missing "rust-std for $std is not installed in $SPIKE_SYSROOT (setup-toolchain.sh installs the pinned targets)"
  case $std in
    aarch64-linux-android)
      local ndk_bin
      ndk_bin=$(spike_ndk_bin) && [ -x "$ndk_bin/aarch64-linux-android$SPIKE_ANDROID_API-clang" ] ||
        spike_refuse tool-missing "no Android NDK clang for $target (ANDROID_NDK_HOME or ~/Library/Android/sdk/ndk/<$SPIKE_NDK_VERSIONS>)"
      ;;
    x86_64-pc-windows-gnullvm)
      [ -x "$SPIKE_LLVM_MINGW/bin/x86_64-w64-mingw32-clang" ] ||
        spike_refuse tool-missing "llvm-mingw is not installed in $SPIKE_LLVM_MINGW (setup-toolchain.sh --with mingw)"
      ;;
  esac
}

spike_check_zigbuild() {
  spike_check_tool "$SPIKE_TOOLS/bin/cargo-zigbuild"
  spike_check_tool "$SPIKE_TOOLS/zig/zig"
}

# Refuse a cargo config file cargo would read: in `.cargo/` of the working folder, the workspace
# or any folder above them (the spike's own CARGO_HOME config is `config.toml` in CARGO_HOME).
spike_check_cargo_configs() {
  local start dir file
  for start in "$PWD" "$SPIKE_WORKSPACE"; do
    dir=$(cd -P "$start" 2>/dev/null && pwd -P) || continue
    while :; do
      for file in "$dir/.cargo/config" "$dir/.cargo/config.toml"; do
        [ -e "$file" ] && spike_refuse cargo-config-found "cargo would read $file: the spike's builds take no cargo config"
      done
      [ "$dir" = / ] && break
      dir=$(dirname "$dir")
    done
  done
  return 0
}

# Run cargo from the sysroot with --manifest-path after the subcommand.
spike_run_cargo() {
  local args=("$@") n=$# i=0 sub="" sub_at=-1 a
  while [ "$i" -lt "$n" ]; do
    a=${args[$i]}
    case $a in
      +*) spike_refuse rustup-toolchain "cargo $a: the spike sysroot is the only toolchain" ;;
      --) break ;;
      -*)
        case $SPIKE_CARGO_VALUE_OPTIONS in *" $a "*) i=$((i + 1)) ;; esac
        ;;
      *)
        sub=$a
        sub_at=$i
        break
        ;;
    esac
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "$n" ]; do
    a=${args[$i]}
    case $a in
      --) break ;;
      --manifest-path | --manifest-path=*) spike_refuse manifest-override "the spike always builds $SPIKE_WORKSPACE/Cargo.toml" ;;
      --config | --config=* | -Z | -Z*) spike_refuse config-override "cargo $a: the spike's cargo configuration is fixed" ;;
      --target) spike_check_target "${args[$((i + 1))]:-}" ;;
      --target=*) spike_check_target "${a#--target=}" ;;
    esac
    i=$((i + 1))
  done
  spike_check_cargo_configs
  [ "$sub" = zigbuild ] && spike_check_zigbuild
  case $SPIKE_NO_WINDOW_SUBCOMMANDS in
    *" $sub "*) [ "${GENEX_NO_WINDOW:-}" = 0 ] || export GENEX_NO_WINDOW=1 ;;
  esac
  case $SPIKE_MANIFEST_SUBCOMMANDS in
    *" $sub "*)
      local head=("${args[@]:0:$((sub_at + 1))}") tail=("${args[@]:$((sub_at + 1))}")
      exec "$SPIKE_SYSROOT/bin/cargo" "${head[@]}" --manifest-path "$SPIKE_WORKSPACE/Cargo.toml" ${tail[@]+"${tail[@]}"}
      ;;
  esac
  exec "$SPIKE_SYSROOT/bin/cargo" ${args[@]+"${args[@]}"}
}

# Run another tool, which must resolve inside the spike folder.
spike_run_tool() {
  local tool=$1 resolved
  shift
  resolved=$(command -v "$tool" 2>/dev/null) || resolved=""
  if [ -z "$resolved" ] || ! spike_inside "$resolved"; then
    spike_refuse tool-missing "$tool is not installed in the spike folder $SPIKE_DIR"
  fi
  exec "$resolved" "$@"
}

spike_print_env() {
  local name
  for name in PATH CARGO_HOME CARGO RUSTC RUSTDOC CARGO_TARGET_DIR CARGO_NET_OFFLINE IPHONEOS_DEPLOYMENT_TARGET \
    ANDROID_NDK_HOME ANDROID_NDK_ROOT CC_aarch64_linux_android CXX_aarch64_linux_android AR_aarch64_linux_android \
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER CC_x86_64_pc_windows_gnullvm CXX_x86_64_pc_windows_gnullvm \
    AR_x86_64_pc_windows_gnullvm CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_LINKER JAVA_HOME; do
    [ -n "${!name:-}" ] && printf 'export %s=%q\n' "$name" "${!name}"
  done
  printf 'unset RUSTUP_TOOLCHAIN RUSTUP_HOME\n'
  printf 'export RUSTC_WRAPPER= RUSTC_WORKSPACE_WRAPPER= CARGO_BUILD_RUSTC_WRAPPER= CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=\n'
}

spike_main() {
  [ $# -ge 1 ] || spike_refuse usage "usage: rust-env.sh cargo <args…> | rust-env.sh <spike tool> <args…> | rust-env.sh --print-env"
  [ -d "$SPIKE_DIR" ] || spike_refuse toolchain-missing "no spike toolchain at $SPIKE_DIR: run scripts/spike/rust-wgpu/setup-toolchain.sh"
  spike_require_approvals
  spike_check_receipt
  spike_check_sysroot
  spike_export_env
  case $1 in
    --print-env) spike_print_env ;;
    cargo)
      shift
      spike_run_cargo "$@"
      ;;
    *) spike_run_tool "$@" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  spike_main "$@"
fi
