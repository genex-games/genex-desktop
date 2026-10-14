#!/usr/bin/env bash
# M0a spike only (M4.1 promotes it into the gnullvm lane): cross-build the pond for
# x86_64-pc-windows-gnullvm from the Mac with llvm-mingw 20260922 (ucrt).
#
#   bash scripts/spike/rust-wgpu/cross-windows.sh
#
# 1. genex-render's dx12_compiler test: the instance names Dx12Compiler::Fxc explicitly (wgpu's
#    default `Auto` would load a dxcompiler.dll found on PATH; the plan forbids `from_env`).
# 2. cargo builds `pond` for the target with crt-static (libunwind linked in); the PE checks: x86-64, a console/GUI executable, and
#    imports only system DLLs (plan Windows row: System32 + d3d12/dxgi/d3dcompiler_47, ucrt):
#    a dxcompiler.dll, opengl32.dll or any bundled runtime DLL (lib*.dll) is refused.
# The binary is never run here: the D3D12-under-WARP row is the owner-dispatched Windows job (M0a.13).

set -euo pipefail
# shellcheck source=cross-lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/cross-lib.sh"
CROSS_NAME=cross-windows

WINDOWS_TARGET="x86_64-pc-windows-gnullvm"
# Without crt-static the gnullvm std imports libunwind.dll, which Windows does not ship; with it
# libunwind links statically and the C runtime stays the system UCRT (api-ms-win-crt-*).
WINDOWS_RUSTFLAGS="-C target-feature=+crt-static"
# DLLs the export may never import (lower case): another shader compiler, a GL path, runtimes
# that would have to ship beside the exe.
WINDOWS_REFUSED_IMPORTS="dxcompiler.dll dxil.dll opengl32.dll libunwind.dll libc++.dll libwinpthread-1.dll"

imports() {
  set -e
  "$(cross_tool llvm-readobj)" --coff-imports "$1" | awk '/^  Name: / { print tolower($2) }' | sort -u
}

check_pe() {
  set -e
  local file=$1 header list dll refused
  header=$("$(cross_tool llvm-readobj)" --file-headers "$file")
  printf '%s\n' "$header" | grep -q 'Machine: IMAGE_FILE_MACHINE_AMD64' || cross_fail wrong-machine "$file is not an x86-64 PE"
  list=$(imports "$file")
  [ -n "$list" ] || cross_fail no-imports "$file imports nothing (not a PE executable?)"
  for dll in $list; do
    for refused in $WINDOWS_REFUSED_IMPORTS; do
      [ "$dll" != "$refused" ] || cross_fail import-refused "$file imports $dll"
    done
    case $dll in lib*.dll) cross_fail import-refused "$file imports the bundled runtime $dll" ;; esac
  done
  printf '"imports":%s' "$(printf '%s\n' "$list" | cross_json_lines)"
}

main() {
  set -e
  [ $# -eq 0 ] || cross_fail usage "usage: cross-windows.sh"
  cross_require_disk
  local test_log="$CROSS_EVIDENCE/windows-fxc-test.log" log="$CROSS_EVIDENCE/windows-build.jsonl" ms pond pe
  mkdir -p "$CROSS_EVIDENCE"
  bash "$CROSS_RUST_ENV" cargo test -p genex-render --test dx12_compiler --offline --locked >"$test_log" 2>&1 ||
    cross_fail fxc-not-explicit "genex-render's dx12_compiler test failed ($test_log)"
  export CARGO_TARGET_X86_64_PC_WINDOWS_GNULLVM_RUSTFLAGS="$WINDOWS_RUSTFLAGS"
  ms=$(cross_cargo "$log" build -p pond --bin pond --no-default-features --release --target "$WINDOWS_TARGET" --offline --locked)
  pond=$(cross_artifact "$log" pond pond bin)
  pond=$(cross_keep "$pond" windows)
  pe=$(check_pe "$pond")
  cross_record windows.json "$(printf '{"format":"genex-cross/1","destination":"windows","target":"%s","toolchain":{"llvmMingw":"20260922-ucrt"},"rustflags":"%s","dx12Compiler":"Fxc","artifacts":[{"name":"pond",%s,%s}]}' \
    "$WINDOWS_TARGET" "$WINDOWS_RUSTFLAGS" "$(cross_artifact_json "$pond" "$ms")" "$pe")"
}

main "$@"
