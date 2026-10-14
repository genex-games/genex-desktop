# Third-party code

Small libraries this game vendors, one folder each: `third_party/<name>/`, with the library's
licence file beside its source and the version it came from in a line of its own README. Nothing
is fetched at build time: no network, no `FetchContent`, no Emscripten ports, no second copy of
raylib (the studio's `genex.cmake` provides it). The build compiles `src/*.cpp`; include a
header-only library with a path relative to the including file
(`#include "../third_party/<name>/<header>.h"`), and give a library with its own source files a
one-line `src/<name>.cpp` that includes them.
