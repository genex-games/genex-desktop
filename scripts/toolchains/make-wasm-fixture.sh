#!/bin/sh
# Builds tests/fixtures/raylib-wasm/ (index.html, index.js, index.wasm, index.data and README.md):
# real Emscripten 6.0.10 output of the small C program below, linked with the C++ lane's web
# options (read from recipe.json's `targets.web.link`) and the C++ template's `web/shell.html`, so
# the export tests and the L4 seam exercise real Emscripten glue. No raylib: GLFW and GLES3 come
# from Emscripten's built-in JS libraries (`-sUSE_GLFW=3` is not a port).
#
#   scripts/toolchains/make-wasm-fixture.sh          build twice from fresh caches, write the fixture
#                                                    and record whether the two builds were identical
#   scripts/toolchains/make-wasm-fixture.sh --check  fail when the template shell or the link options
#                                                    changed since the fixture was built; otherwise
#                                                    rebuild into a scratch folder and compare digests
#
# Inputs, never actions: emsdk 6.0.10 under $GENEX_DEV_TOOLCHAINS (default .studio-dev/toolchains).
# Nothing here downloads. emcc runs with a private EM_CACHE cloned from emsdk's shipped cache, an
# EM_CONFIG written here, emsdk's own Python behind a `-B` wrapper (emcc starts Python with `-E`,
# which ignores PYTHONDONTWRITEBYTECODE), EMCC_SKIP_SANITY_CHECK=1, no embuilder and no ports. On a
# Mac it runs under sandbox-exec with the network and every write into the toolchains denied.
# Each run works in its own folder under $GENEX_WASM_FIXTURE_WORK (default
# .studio-dev/evidence/raylib-w1-export) and removes that folder when it ends.
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd -P)
TOOLCHAINS=${GENEX_DEV_TOOLCHAINS:-$REPO/.studio-dev/toolchains}
EMSDK="$TOOLCHAINS/emsdk-6.0.10"
EMSCRIPTEN="$EMSDK/install/emscripten"
PYTHON="$EMSDK/python/python-3.13.3-0/bin/python3"
NODE="$EMSDK/node/bin/node"
WORK=${GENEX_WASM_FIXTURE_WORK:-$REPO/.studio-dev/evidence/raylib-w1-export}
FIXTURE="$REPO/tests/fixtures/raylib-wasm"
TEMPLATE_SHELL="$REPO/src/game-template-cpp/web/shell.html"
RECIPE="$REPO/src/substrate/toolchain-store/recipe.json"
EXPECTED_VERSION=6.0.10
FILES="index.html index.js index.wasm index.data"

fail() {
  echo "make-wasm-fixture: $*" >&2
  exit 1
}

case "${1:-}" in
  "") MODE=write ;;
  --check) MODE=check ;;
  *) fail "usage: make-wasm-fixture.sh [--check]" ;;
esac

for tool in "$EMSCRIPTEN/emcc" "$PYTHON" "$NODE" "$EMSCRIPTEN/cache"; do
  [ -e "$tool" ] || fail "not run: $tool absent (populate the dev toolchains first)"
done
[ -f "$TEMPLATE_SHELL" ] || fail "not run: $TEMPLATE_SHELL absent (the C++ template's shell)"
STORE=$(cd "$TOOLCHAINS" && pwd -P) || fail "cannot resolve $TOOLCHAINS"

# The lane's web link options, as the recipe lists them (each one word, starting with -); the
# fixture adds only -O2, the template shell and its one asset.
LINK_OPTIONS=$("$NODE" -e '
const link = require(process.argv[1]).targets?.web?.link;
const words = Array.isArray(link) && link.length > 0 && link.every((o) => typeof o === "string" && /^-\S+$/.test(o));
if (!words) process.exit(1);
process.stdout.write(link.join(" "));
' "$RECIPE") || fail "recipe.json has no targets.web.link of single-word options"
COMMAND="emcc main.c -O2 -o ../out/index.html $LINK_OPTIONS --shell-file web/shell.html --preload-file assets@/assets"

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi
}

digests() {
  for file in $FILES; do printf '%s  %s\n' "$(sha256 "$1/$file")" "$file"; done
}

mkdir -p "$WORK"
RUN=$(mktemp -d "$WORK/run.XXXXXX")
case "$RUN" in "$WORK"/run.*) ;; *) fail "unexpected work folder $RUN" ;; esac
trap 'rm -rf -- "$RUN"' EXIT

SHELL_SHA=$(sha256 "$TEMPLATE_SHELL")

# The inputs the fixture records, which --check compares before it rebuilds anything.
if [ "$MODE" = check ]; then
  RECORDED_SHELL=$(sed -n 's/^- Template shell sha256: `\([0-9a-f]*\)`.*/\1/p' "$FIXTURE/README.md")
  RECORDED_LINK=$(sed -n 's/^- Link options: `\(.*\)`$/\1/p' "$FIXTURE/README.md")
  [ "$RECORDED_SHELL" = "$SHELL_SHA" ] ||
    fail "--check: src/game-template-cpp/web/shell.html changed since the fixture was built (recorded ${RECORDED_SHELL:-nothing}, now $SHELL_SHA): run make-wasm-fixture.sh"
  [ "$RECORDED_LINK" = "$LINK_OPTIONS" ] ||
    fail "--check: recipe.json's targets.web.link changed since the fixture was built (recorded '$RECORDED_LINK', now '$LINK_OPTIONS'): run make-wasm-fixture.sh"
fi

write_sources() {
  mkdir -p "$1/assets" "$1/web"
  # The asset: the clear colour as four bytes (RGBA). The NUL keeps Git reading index.data as binary.
  printf '\360\124\036\000' >"$1/assets/clear.rgba"
  cp "$TEMPLATE_SHELL" "$1/web/shell.html"
  cat >"$1/main.c" <<'EOF'
/* Genex wasm fixture: GLFW + GLES3 clear the canvas, sized to the page, to the asset's colour. */
#include <GLES3/gl3.h>
#include <GLFW/glfw3.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <stdio.h>

static unsigned char rgba[4] = {240, 84, 30, 0};

static void frame(void) {
  double css_width = 0, css_height = 0, ratio = emscripten_get_device_pixel_ratio();
  emscripten_get_element_css_size("#canvas", &css_width, &css_height);
  int width = (int)(css_width * ratio), height = (int)(css_height * ratio);
  emscripten_set_canvas_element_size("#canvas", width, height);
  glViewport(0, 0, width, height);
  glClearColor(rgba[0] / 255.0f, rgba[1] / 255.0f, rgba[2] / 255.0f, 1.0f);
  glClear(GL_COLOR_BUFFER_BIT);
}

int main(void) {
  FILE *asset = fopen("/assets/clear.rgba", "rb");
  if (asset) { fread(rgba, 1, sizeof rgba, asset); fclose(asset); }
  if (!glfwInit()) return 1;
  glfwWindowHint(GLFW_CLIENT_API, GLFW_OPENGL_ES_API);
  glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
  GLFWwindow *window = glfwCreateWindow(640, 360, "Genex wasm fixture", NULL, NULL);
  if (!window) return 1;
  glfwMakeContextCurrent(window);
  emscripten_set_main_loop(frame, 0, 0);
  return 0;
}
EOF
}

# emcc, as one run of the lane would: this build's own cache, config and Python, in `$1/src`.
emcc_in() {
  dir=$1
  shift
  (cd "$dir/src" && env EM_CACHE="$dir/em-cache" EM_CONFIG="$dir/emscripten.config" EMSDK_PYTHON="$dir/python3" \
    EMCC_SKIP_SANITY_CHECK=1 PYTHONDONTWRITEBYTECODE=1 "$@")
}

# One build from scratch into `$1/out`: a fresh private cache (a copy-on-write clone where the file
# system has one, never the shipped cache), the sources, then emcc.
build() {
  dir=$1
  mkdir -p "$dir/src" "$dir/out"
  if [ "$(uname -s)" = Darwin ]; then cp -c -R "$EMSCRIPTEN/cache" "$dir/em-cache"; else cp -R --reflink=auto "$EMSCRIPTEN/cache" "$dir/em-cache"; fi
  printf 'LLVM_ROOT = "%s"\nBINARYEN_ROOT = "%s"\nNODE_JS = "%s"\n' "$EMSDK/install/bin" "$EMSDK/install" "$NODE" >"$dir/emscripten.config"
  printf '#!/bin/sh\nexec "%s" -B "$@"\n' "$PYTHON" >"$dir/python3"
  chmod 755 "$dir/python3"
  write_sources "$dir/src"
  # shellcheck disable=SC2086 # LINK_OPTIONS is a fixed list of words
  set -- "$EMSCRIPTEN/emcc" main.c -O2 -o ../out/index.html $LINK_OPTIONS --shell-file web/shell.html --preload-file assets@/assets
  # The network and every write under the toolchains are denied where sandbox-exec exists.
  if [ -x /usr/bin/sandbox-exec ]; then
    set -- /usr/bin/sandbox-exec -p "(version 1)(allow default)(deny network*)(deny file-write* (subpath \"$STORE\"))" "$@"
  fi
  emcc_in "$dir" "$@"
  for file in $FILES; do [ -f "$dir/out/$file" ] || fail "emcc wrote no $file"; done
}

build "$RUN/a"
VERSION=$(emcc_in "$RUN/a" "$EMSCRIPTEN/emcc" --version | head -n 1)
case "$VERSION" in *" $EXPECTED_VERSION "* | *" $EXPECTED_VERSION-git "*) ;; *) fail "expected emcc $EXPECTED_VERSION, found: $VERSION" ;; esac
digests "$RUN/a/out" >"$WORK/build-digests.txt"

if [ "$MODE" = check ]; then
  digests "$FIXTURE" >"$WORK/fixture-digests.txt"
  if cmp -s "$WORK/build-digests.txt" "$WORK/fixture-digests.txt"; then
    echo "make-wasm-fixture --check: byte-reproducible; every digest matches tests/fixtures/raylib-wasm"
    exit 0
  fi
  diff "$WORK/fixture-digests.txt" "$WORK/build-digests.txt" >&2 || true
  fail "--check: the rebuilt output differs from tests/fixtures/raylib-wasm (digests above)"
fi

# A second build from its own fresh cache: are two builds of the same inputs byte-identical?
build "$RUN/b"
digests "$RUN/b/out" >"$WORK/second-build-digests.txt"
if cmp -s "$WORK/build-digests.txt" "$WORK/second-build-digests.txt"; then
  REPRODUCIBLE="yes: two builds, each from its own fresh cache, gave the same bytes for every file"
else
  REPRODUCIBLE="no: two builds from fresh caches differed in $(diff "$WORK/build-digests.txt" "$WORK/second-build-digests.txt" | sed -n 's/^> [0-9a-f]*  //p' | tr '\n' ' ')"
fi

mkdir -p "$FIXTURE"
for file in $FILES; do
  cp "$RUN/a/out/$file" "$FIXTURE/$file"
  chmod 644 "$FIXTURE/$file"
done
{
  echo "# raylib-wasm fixture"
  echo
  echo "Real Emscripten output, generated by \`scripts/toolchains/make-wasm-fixture.sh\`; do not edit by"
  echo "hand. It is the C++ lane's web output shape (\`index.html\`, \`index.js\`, \`index.wasm\`,"
  echo "\`index.data\`) for a small C program (in the script) that uses GLFW and GLES3 through"
  echo "Emscripten's built-in libraries, no raylib, and clears the canvas, sized to the page, to the"
  echo "colour in its one preloaded asset (\`/assets/clear.rgba\`, packed into \`index.data\`)."
  echo
  echo "- Emscripten: \`$VERSION\`"
  echo "- Shell: \`src/game-template-cpp/web/shell.html\`, the C++ template's."
  echo "- Template shell sha256: \`$SHELL_SHA\` (\`--check\` refuses a fixture built from another)."
  echo "- Link options: \`$LINK_OPTIONS\`"
  echo "  (recipe.json's \`targets.web.link\`, read at build time; \`--check\` compares them too)."
  echo "- Command (run in the script's work folder, with a private \`EM_CACHE\`, \`EM_CONFIG\`,"
  echo "  \`EMSDK_PYTHON\`, \`EMCC_SKIP_SANITY_CHECK=1\` and \`PYTHONDONTWRITEBYTECODE=1\`):"
  echo
  echo "  \`\`\`sh"
  echo "  $COMMAND"
  echo "  \`\`\`"
  echo
  echo "- Byte-reproducible: $REPRODUCIBLE."
  echo "- Check: \`scripts/toolchains/make-wasm-fixture.sh --check\` compares the shell and link options"
  echo "  above, then rebuilds into a scratch folder and compares these digests."
  echo
  echo "| File | SHA-256 |"
  echo "| --- | --- |"
  for file in $FILES; do echo "| \`$file\` | \`$(sha256 "$FIXTURE/$file")\` |"; done
} >"$FIXTURE/README.md"
echo "make-wasm-fixture: wrote tests/fixtures/raylib-wasm ($VERSION); byte-reproducible: $REPRODUCIBLE"
