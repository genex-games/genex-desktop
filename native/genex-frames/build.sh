#!/bin/bash
# Builds genex-frames for macOS (arm64 by default, macOS 12+) with Apple clang only.
#
#   build.sh          the addon (genex-frames.node), the sender library and the test sender
#   build.sh test     the same, then the ASan+UBSan tests, run
#
# Environment:
#   OUT               output directory (default <repo>/.studio-dev/build/genex-frames)
#   ARCH              arm64 (default) or x86_64
#   NODE_API_INCLUDE  directory holding node_api.h (default: the active node's include/node);
#                     only the ABI-stable N-API headers are used, so any Node >= 18 works
#   FUZZ_ITERATIONS   fuzz loop iterations (default 100000)
#   ANGLE_DIR         a Metal-only ANGLE store entry (include/, libEGL.dylib, libGLESv2.dylib); when
#                     set, also builds gxf_test_sender_angle (GPU rendering) with the dylibs beside it
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$REPO/.studio-dev/build/genex-frames}"
ARCH="${ARCH:-arm64}"
MIN_MACOS=12.0
FUZZ_ITERATIONS="${FUZZ_ITERATIONS:-100000}"

if [ -z "${NODE_API_INCLUDE:-}" ]; then
  NODE_API_INCLUDE="$(dirname "$(dirname "$(command -v node)")")/include/node"
fi
if [ ! -f "$NODE_API_INCLUDE/node_api.h" ]; then
  echo "node_api.h not found in $NODE_API_INCLUDE (set NODE_API_INCLUDE)" >&2
  exit 1
fi

CC=(xcrun clang)
CXX=(xcrun clang++)
TARGET=(-arch "$ARCH" -mmacosx-version-min="$MIN_MACOS")
WARN=(-Wall -Wextra -Wpedantic -Werror -Wno-gnu-zero-variadic-macro-arguments)
INCLUDES=(-I"$HERE/include" -I"$HERE/src" -I"$HERE/sender")
RELEASE=(-O2 -fstack-protector-strong -D_FORTIFY_SOURCE=2 -fvisibility=hidden)
SANITIZE=(-O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined)
FRAMEWORKS=(-framework IOSurface -framework CoreFoundation)

mkdir -p "$OUT/obj" "$OUT/tests"

compile_c() { "${CC[@]}" "${TARGET[@]}" -std=c11 "${WARN[@]}" "${INCLUDES[@]}" "$@"; }
compile_cxx() { "${CXX[@]}" "${TARGET[@]}" -std=c++17 "${WARN[@]}" "${INCLUDES[@]}" "$@"; }

# The addon: N-API symbols resolve at load time from the host (Node or Electron).
compile_c "${RELEASE[@]}" -c "$HERE/src/gxf_validate.c" -o "$OUT/obj/gxf_validate.o"
compile_cxx "${RELEASE[@]}" -c "$HERE/src/gxf_channel.cc" -o "$OUT/obj/gxf_channel.o"
compile_cxx "${RELEASE[@]}" -I"$NODE_API_INCLUDE" -c "$HERE/src/gxf_addon.cc" -o "$OUT/obj/gxf_addon.o"
"${CXX[@]}" "${TARGET[@]}" -bundle -undefined dynamic_lookup -Wl,-dead_strip \
  "$OUT/obj/gxf_addon.o" "$OUT/obj/gxf_channel.o" "$OUT/obj/gxf_validate.o" \
  "${FRAMEWORKS[@]}" -lbsm -o "$OUT/genex-frames.node"
strip -x "$OUT/genex-frames.node"

# Import audit: receive-only. No pixel access, no files, no sockets, no loading of other code.
FORBIDDEN='^_(dlopen|dlsym|NSAddImage|open|openat|fopen|creat|socket|connect|bind|listen|accept|sendto|IOSurfaceLock|IOSurfaceUnlock|IOSurfaceGetBaseAddress|IOSurfaceGetBaseAddressOfPlane|mmap|vm_map|mach_vm_map|posix_spawn|fork|execve|system)$'
IMPORTS="$(nm -u "$OUT/genex-frames.node" | sed 's/^ *//')"
if echo "$IMPORTS" | grep -Eq "$FORBIDDEN"; then
  echo "genex-frames.node imports a forbidden symbol:" >&2
  echo "$IMPORTS" | grep -E "$FORBIDDEN" >&2
  exit 1
fi
echo "$IMPORTS" > "$OUT/genex-frames.imports.txt"

# The game-side library and the test sender (plain build: it runs under the game profile).
compile_c "${RELEASE[@]}" -c "$HERE/sender/gxf_sender.c" -o "$OUT/obj/gxf_sender.o"
rm -f "$OUT/libgxf_sender.a"
ar rcs "$OUT/libgxf_sender.a" "$OUT/obj/gxf_sender.o"
compile_c "${RELEASE[@]}" "$HERE/sender/gxf_test_sender.c" "$OUT/libgxf_sender.a" "${FRAMEWORKS[@]}" \
  -o "$OUT/gxf_test_sender"
echo "built $OUT/genex-frames.node, $OUT/libgxf_sender.a, $OUT/gxf_test_sender"

if [ -n "${ANGLE_DIR:-}" ]; then
  compile_c "${RELEASE[@]}" -DGXF_WITH_ANGLE -I"$ANGLE_DIR/include" "$HERE/sender/gxf_test_sender.c" \
    "$HERE/sender/gxf_angle_render.c" "$OUT/libgxf_sender.a" "${FRAMEWORKS[@]}" -L"$ANGLE_DIR" -lEGL -lGLESv2 \
    -Wl,-rpath,@executable_path -o "$OUT/gxf_test_sender_angle"
  cp "$ANGLE_DIR/libEGL.dylib" "$ANGLE_DIR/libGLESv2.dylib" "$OUT/"
  echo "built $OUT/gxf_test_sender_angle (ANGLE from $ANGLE_DIR)"
fi

if [ "${1:-}" != "test" ]; then exit 0; fi

T="$OUT/tests"
compile_c "${SANITIZE[@]}" "$HERE/tests/test_validate.c" "$HERE/src/gxf_validate.c" -lbsm -o "$T/test_validate"
compile_c "${SANITIZE[@]}" "$HERE/tests/test_fuzz.c" "$HERE/src/gxf_validate.c" -lbsm -o "$T/test_fuzz"
compile_c "${SANITIZE[@]}" -c "$HERE/src/gxf_validate.c" -o "$T/gxf_validate.o"
compile_c "${SANITIZE[@]}" -c "$HERE/sender/gxf_sender.c" -o "$T/gxf_sender.o"
compile_cxx "${SANITIZE[@]}" "$HERE/tests/test_channel.cc" "$HERE/src/gxf_channel.cc" "$T/gxf_validate.o" \
  "$T/gxf_sender.o" "${FRAMEWORKS[@]}" -lbsm -o "$T/test_channel"

export ASAN_OPTIONS="abort_on_error=1:halt_on_error=1:strict_string_checks=1:detect_stack_use_after_return=1"
export UBSAN_OPTIONS="print_stacktrace=1:halt_on_error=1"
"$T/test_validate"
"$T/test_fuzz" "$FUZZ_ITERATIONS"
"$T/test_channel"
echo "all genex-frames tests passed"
