#!/bin/sh
# Compile checks of the C++ game template (src/game-template-cpp/src) against the real raylib 6.0
# headers and the store's ANGLE headers, without building raylib or linking the game:
#
#   scripts/toolchains/compile-check.sh mac           clang++ -fsyntax-only of every template source,
#                                                     as a window build (PLATFORM_DESKTOP_GLFW), as
#                                                     a headless one (GENEX_HEADLESS), both with the
#                                                     Metal ANGLE's EGL headers, and with PLATFORM_WEB
#                                                     (emsdk's clang++ for wasm32-unknown-emscripten,
#                                                     emcc's include flags); then the headless raylib
#                                                     platform inside a build-tree copy of raylib's
#                                                     rcore.c (-DPLATFORM_MEMORY -DGRAPHICS_API_OPENGL_ES3)
#   scripts/toolchains/compile-check.sh zig-cross     zig c++ -c of every template source for
#                                                     x86_64-windows-gnu and x86_64-linux-gnu with that
#                                                     target's ANGLE headers, the early portability
#                                                     warning (zig 0.16's cc wrapper fails -fsyntax-only
#                                                     with FileNotFound, so it compiles to objects in
#                                                     the scratch folder)
#   scripts/toolchains/compile-check.sh linux-docker  build tests/cpp with the raylib-free units using
#                                                     Linux zig inside ubuntu:24.04 (no network, the
#                                                     repository read-only), run every test binary and
#                                                     the transport's rows over socket pairs, and build
#                                                     the stub game (tests/cpp/raylib_stub.h) as a
#                                                     window and a headless run; it must exit 0 when
#                                                     the studio's fd 3 ends at once
#
# Inputs, never actions: raylib 6.0, the three ANGLE builds, emsdk 6.0.10 and zig 0.16.0 under
# $GENEX_DEV_TOOLCHAINS (default .studio-dev/toolchains). Nothing here downloads: linux-docker
# unpacks the cached zig-x86_64-linux archive into the work folder, and the container runs with
# --network none.
# Caches and outputs go to a work folder this script creates inside $GENEX_COMPILE_CHECK_SCRATCH
# (default $TMPDIR) and removes on exit; nothing else there is touched.
#
# On a Mac a /usr/bin compiler is a Command Line Tools shim that opens Apple's installer when the
# tools are missing, so mac mode asks `xcode-select -p` (which never prompts; the path is
# $GENEX_COMPILE_CHECK_XCODE_SELECT for tests) first and reports "not run" instead.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
TOOLCHAINS=${GENEX_DEV_TOOLCHAINS:-$REPO/.studio-dev/toolchains}
RAYLIB="$TOOLCHAINS/raylib-6.0/src"
EMSDK_CLANG="$TOOLCHAINS/emsdk-6.0.10/install/bin/clang++"
# Emscripten's shipped sysroot: read here, never written (-fsyntax-only builds no library).
EMSCRIPTEN_SYSROOT="$TOOLCHAINS/emsdk-6.0.10/install/emscripten/cache/sysroot"
ZIG="$TOOLCHAINS/zig-0.16.0/zig"
ZIG_LINUX_ARCHIVE="$TOOLCHAINS/downloads/zig-x86_64-linux-0.16.0.tar.xz"
ANGLE_MAC="$TOOLCHAINS/angle-macos-arm64-metal/c5bf49e78850/include"
ANGLE_WINDOWS="$TOOLCHAINS/angle-windows-x64-d3d11/c5bf49e78850/include"
ANGLE_LINUX="$TOOLCHAINS/angle-linux-x64-vulkan/c5bf49e78850/include"
HEADLESS_PLATFORM="$REPO/native/raylib-platform/rcore_genex_headless.c"
TEMPLATE="$REPO/src/game-template-cpp/src"
HOST_CXX=${GENEX_COMPILE_CHECK_CXX:-clang++}
XCODE_SELECT=${GENEX_COMPILE_CHECK_XCODE_SELECT:-/usr/bin/xcode-select}
UBUNTU_IMAGE=ubuntu:24.04
# The raylib-free units every tests/cpp binary links (rng.h, digest.h and frames.h are header-only).
UNITS="json protocol input clock session paths transport"
TESTS="json protocol input clock session paths digest transport frames"
# Our own sources are held to warnings; raylib's headers come in as system headers. Every native
# lane defines GENEX_AUDIO_RATE_HZ (the rate it gives raylib's mixer), and a native build without
# it does not compile; the web build ignores it.
STRICT="-std=c++20 -Wall -Wextra -Werror -DGRAPHICS_API_OPENGL_ES3 -DGENEX_AUDIO_RATE_HZ=48000"

fail() {
  echo "compile-check: $*" >&2
  exit 1
}

need() {
  [ -e "$1" ] || fail "not run: $1 absent (populate the dev toolchains first)"
}

BASE=${GENEX_COMPILE_CHECK_SCRATCH:-${TMPDIR:-/tmp}}
mkdir -p "$BASE"
WORK=$(mktemp -d "$BASE/compile-check.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Refuse a Mac's /usr/bin compiler shim when the Command Line Tools are not there to answer it.
need_command_line_tools() {
  [ "$(uname -s)" = Darwin ] || return 0
  case "$(command -v "$HOST_CXX" || true)" in
    /usr/bin/*) "$XCODE_SELECT" -p >/dev/null 2>&1 ||
      fail "not run: $HOST_CXX is a Command Line Tools shim and the Command Line Tools are not installed" ;;
  esac
}

# The headless raylib platform where the Mac prebuild compiles it: a build-tree copy of raylib's
# sources in which it replaces platforms/rcore_memory.c, so raylib's own rcore.c includes it.
check_headless_platform() {
  mkdir "$WORK/raylib"
  cp -R "$RAYLIB" "$WORK/raylib/src"
  cp "$HEADLESS_PLATFORM" "$WORK/raylib/src/platforms/rcore_memory.c"
  echo "mac PLATFORM_MEMORY rcore.c with rcore_genex_headless.c"
  xcrun clang -std=c99 -Werror -fsyntax-only -DPLATFORM_MEMORY -DGRAPHICS_API_OPENGL_ES3 \
    -isystem "$ANGLE_MAC" "$WORK/raylib/src/rcore.c"
}

# Every template source, once per platform define. The web pass is what emcc would run, minus
# Python: its clang, its target, its sysroot and the two include folders it adds.
check_mac() {
  need_command_line_tools
  need "$RAYLIB/raylib.h"
  need "$ANGLE_MAC/EGL/egl.h"
  need "$EMSDK_CLANG"
  need "$EMSCRIPTEN_SYSROOT/include/emscripten/emscripten.h"
  for source in "$TEMPLATE"/*.cpp; do
    echo "mac PLATFORM_DESKTOP_GLFW $(basename "$source")"
    # shellcheck disable=SC2086 # STRICT is a list of flags
    "$HOST_CXX" $STRICT -fsyntax-only -DPLATFORM_DESKTOP_GLFW -isystem "$RAYLIB" -isystem "$ANGLE_MAC" \
      -I "$TEMPLATE" "$source"
  done
  for source in "$TEMPLATE"/*.cpp; do
    echo "mac GENEX_HEADLESS $(basename "$source")"
    # shellcheck disable=SC2086 # STRICT is a list of flags
    "$HOST_CXX" $STRICT -fsyntax-only -DGENEX_HEADLESS -isystem "$RAYLIB" -isystem "$ANGLE_MAC" \
      -I "$TEMPLATE" "$source"
  done
  for source in "$TEMPLATE"/*.cpp; do
    echo "mac PLATFORM_WEB $(basename "$source")"
    # shellcheck disable=SC2086 # STRICT is a list of flags
    "$EMSDK_CLANG" --target=wasm32-unknown-emscripten "--sysroot=$EMSCRIPTEN_SYSROOT" \
      -Xclang -iwithsysroot/include/fakesdl -Xclang -iwithsysroot/include/compat \
      $STRICT -fsyntax-only -DPLATFORM_WEB -isystem "$RAYLIB" -I "$TEMPLATE" "$source"
  done
  check_headless_platform
}

check_zig_cross() {
  need "$RAYLIB/raylib.h"
  need "$ZIG"
  need "$ANGLE_WINDOWS/EGL/egl.h"
  need "$ANGLE_LINUX/EGL/egl.h"
  export ZIG_GLOBAL_CACHE_DIR="$WORK/zig-global-cache"
  export ZIG_LOCAL_CACHE_DIR="$WORK/zig-local-cache"
  for target in x86_64-windows-gnu x86_64-linux-gnu; do
    case "$target" in
      *windows*) angle="$ANGLE_WINDOWS" ;;
      *) angle="$ANGLE_LINUX" ;;
    esac
    mkdir -p "$WORK/obj/$target"
    for source in "$TEMPLATE"/*.cpp; do
      echo "zig $target $(basename "$source")"
      # shellcheck disable=SC2086 # STRICT is a list of flags
      "$ZIG" c++ -target "$target" $STRICT -c -DPLATFORM_DESKTOP_GLFW -isystem "$RAYLIB" -isystem "$angle" \
        -I "$TEMPLATE" "$source" -o "$WORK/obj/$target/$(basename "$source" .cpp).o"
    done
  done
}

check_linux_docker() {
  need "$ZIG_LINUX_ARCHIVE"
  command -v docker >/dev/null 2>&1 || fail "not run: docker absent"
  docker image inspect "$UBUNTU_IMAGE" >/dev/null 2>&1 ||
    fail "not run: image $UBUNTU_IMAGE absent (it is never pulled here)"
  mkdir "$WORK/zig" "$WORK/bin"
  tar -xJf "$ZIG_LINUX_ARCHIVE" -C "$WORK/zig" --strip-components=1
  # The stub raylib stands in for raylib.h and ANGLE's EGL headers in the stub game's build.
  mkdir -p "$WORK/stub/EGL"
  for header in raylib.h EGL/egl.h EGL/eglext.h; do
    echo '#include "/w/tests/cpp/raylib_stub.h"' >"$WORK/stub/$header"
  done
  # One shell script for the container: build the units once, link each test, then run them all;
  # then the stub game twice, which must exit 0 at once when its fd 3 ends.
  {
    echo 'set -eu'
    echo 'export ZIG_GLOBAL_CACHE_DIR=/s/zig-global-cache ZIG_LOCAL_CACHE_DIR=/s/zig-local-cache'
    echo 'CXX="/s/zig/zig c++ -std=c++20 -target x86_64-linux-gnu -O1 -Wall -Wextra -Werror -UNDEBUG -pthread"'
    echo 'LANE="-DGENEX_AUDIO_RATE_HZ=48000"'
    echo 'CXX="$CXX -I/w/src/game-template-cpp/src"'
    echo 'uname -m; /s/zig/zig version'
    for unit in $UNITS; do
      echo "\$CXX -c /w/src/game-template-cpp/src/$unit.cpp -o /s/bin/$unit.o"
    done
    for test in $TESTS; do
      echo "\$CXX /w/tests/cpp/${test}_test.cpp /s/bin/*.o -o /s/bin/${test}_test"
    done
    for test in $TESTS; do
      echo "echo \"run ${test}_test\"; (cd /s/bin && ./${test}_test)"
    done
    echo 'GAME_SOURCES=$(ls /w/src/game-template-cpp/src/*.cpp | grep -v /main.cpp)'
    for mode in window headless; do
      define=""
      [ "$mode" = headless ] && define="-DGENEX_HEADLESS"
      echo "\$CXX \$LANE -I/s/stub $define /w/tests/cpp/capture_test.cpp \$GAME_SOURCES -o /s/bin/game_$mode"
      echo "echo \"run game_$mode with fd 3 at its end\"; mkdir -p /s/state-$mode"
      echo "GENEX_STUDIO_FD=3 GENEX_STUDIO_NONCE=docker GENEX_STATE_DIR=/s/state-$mode /s/bin/game_$mode basic 3</dev/null"
      echo "echo \"ok game_$mode exited 0\""
    done
  } >"$WORK/run-tests.sh"
  # As the caller, so everything the container writes into the work folder is the caller's to remove.
  docker run --rm --network none --platform linux/amd64 --user "$(id -u):$(id -g)" \
    -v "$REPO:/w:ro" -v "$WORK:/s" "$UBUNTU_IMAGE" \
    /bin/sh /s/run-tests.sh
}

case "${1:-}" in
  mac) check_mac ;;
  zig-cross) check_zig_cross ;;
  linux-docker) check_linux_docker ;;
  *) fail "usage: compile-check.sh mac|zig-cross|linux-docker" ;;
esac
echo "compile-check: ${1} passed"
