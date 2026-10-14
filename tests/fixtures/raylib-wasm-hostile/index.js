// SYNTHETIC hostile fixture, hand-written to look like Emscripten's classic glue: see README.md.
// A classic script, loaded by a <script> tag without type=module; never parse it as a module.
var Module = typeof Module != "undefined" ? Module : {};
var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof require == "function";

// Strings that only look like imports; none of them is code.
var importHints = ['import("x")', "import('x')", 'import(\"x\")'];

if (ENVIRONMENT_IS_NODE) {
  // The require-guarded Node branch: the browser never takes it.
  var fs = require("fs");
  var nodePath = require("path");
  // A bare import("x") inside a template string: a module lexer reads it as the specifier "x".
  Module.loaderNote = `${import("x")}`;
  Module.wasmBytes = fs.readFileSync(nodePath.join(__dirname, "index.wasm"));
}

function locateFile(name) {
  return (Module.locateFile || ((file) => file))(name);
}

if (!ENVIRONMENT_IS_NODE) {
  fetch(locateFile("index.wasm"))
    .then((response) => response.arrayBuffer())
    .then((bytes) => WebAssembly.instantiate(bytes, {}))
    .then(({ instance }) => {
      Module.answer = instance.exports.answer();
      Module.importHints = importHints;
    });
}
