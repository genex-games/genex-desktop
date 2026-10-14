# raylib-wasm-hostile fixture (synthetic)

Hand-written, not Emscripten output. It keeps the web export honest about classic scripts: the
real glue is in `../raylib-wasm/`, and this page holds the shapes a module parser gets wrong.

- `index.html` loads `index.js` with `<script async type="text/javascript" src="index.js">`, a
  classic script (no `type="module"`).
- `index.js` looks like Emscripten's classic glue:
  - A Node branch behind `typeof require == "function"` that calls `require("fs")` and
    `require("path")`. The browser never takes it.
  - `import("x")` in plain strings, which are never code.
  - A bare `import("x")` inside a template string in that Node branch. es-module-lexer reports it
    as the specifier `x`, which no import map resolves: read as a module, the export fails with
    "Export has an unresolved module: x". Read as the page's classic script, it passes: the export
    still follows a classic script's relative and mapped imports, but not a bare one no map answers.
- `index.wasm` is a valid 200-byte module. It holds one exported function, `answer`, which returns
  42, and a custom section named `genex-synthetic-fixture` padding the file to 200 bytes.
  sha256 `462fecf8da1b39ce23c6382d463c520740c63d5fa5a9fc9ca9d48ab44042e1b9`.
