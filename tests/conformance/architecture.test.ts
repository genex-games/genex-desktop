import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import {
  ALLOWLIST,
  checkBoundaries,
  checkCycles,
  checkNativeLoads,
  checkRustRuntimeBoundary,
  checkSeedBoundary,
  importCycles,
  rustRuntimeEdges,
  seedEdges,
  type BoundaryAllowlist,
} from "../../scripts/check-boundaries.ts";

/** A throwaway repository root with a tsconfig and the given source files. */
function tree(t: { after(fn: () => void): void }, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        allowJs: true,
        allowImportingTsExtensions: true,
      },
    }),
  );
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
const none: BoundaryAllowlist = { cycles: [] };

test("the app may not load the harness seed at run time: static and dynamic imports from main, preload, renderer and shared count, erased types and the seed itself do not", (t) => {
  const root = tree(t, {
    "src/harness-seed/loop/roles.mjs": "import './util.mjs'; export const ROLES = [];",
    "src/harness-seed/loop/util.mjs": "export const x = 1;",
    "src/main/core.ts": "import { ROLES } from '../harness-seed/loop/roles.mjs'; export const n = ROLES.length;",
    "src/main/lazy.ts": "export const load = () => import('../harness-seed/loop/util.mjs');",
    "src/main/resources.ts": "export const load = (dir: string) => import(dir + '/harness-seed/loop/util.mjs');",
    "src/preload/bridge.ts": "import '../harness-seed/loop/util.mjs';",
    "src/renderer/types.ts":
      "import type { ROLES } from '../harness-seed/loop/roles.mjs'; export type R = typeof ROLES;",
    "src/renderer/view.ts": "export { ROLES } from '../harness-seed/loop/roles.mjs';",
    "src/shared/contract.ts": "import '../harness-seed/loop/util.mjs';",
    "src/substrate/boot.ts": "import '../harness-seed/loop/util.mjs';",
  });
  const expected = [
    "src/main/core.ts:1 -> src/harness-seed/loop/roles.mjs",
    "src/main/lazy.ts:1 -> src/harness-seed/loop/util.mjs",
    "src/preload/bridge.ts:1 -> src/harness-seed/loop/util.mjs",
    "src/renderer/view.ts:1 -> src/harness-seed/loop/roles.mjs",
    "src/shared/contract.ts:1 -> src/harness-seed/loop/util.mjs",
  ];
  assert.deepEqual(
    seedEdges(root)
      .map((e) => `${e.from}:${e.line} -> ${e.to}`)
      .sort(),
    expected,
    "a path computed at run time (the shipped resources copy) is not an edge, and the substrate hosts the harness",
  );
  const result = checkSeedBoundary(root);
  assert.equal(result.errors.length, expected.length, "every seed import fails: there is no allowlist");
  assert.match(result.errors.join("\n"), /src\/main\/lazy\.ts:1: runtime import of the harness seed/);
  assert.deepEqual(result.warnings, []);
});

test("import cycles are found through static runtime imports only, and the allowlist may only shrink", (t) => {
  const root = tree(t, {
    "src/a.ts": "import { b } from './b.ts'; export const a = () => b;",
    "src/b.ts": "import { c } from './c.ts'; export const b = c;",
    "src/c.ts": "import { a } from './a.ts'; export const c = a;",
    "src/self.ts": "import './self.ts';",
    "src/typed.ts": "import type { t } from './typed-back.ts'; export const u = 1;",
    "src/typed-back.ts": "import { u } from './typed.ts'; export const t = u;",
    "src/lazy.ts": "import { back } from './lazy-back.ts'; export const lazy = back;",
    "src/lazy-back.ts": "export const back = () => import('./lazy.ts');",
    "src/game-template/src/main.js": "import './studio.js';",
    "src/game-template/src/studio.js": "import './main.js';",
  });
  assert.deepEqual(importCycles(root), [["src/a.ts", "src/b.ts", "src/c.ts"], ["src/self.ts"]]);
  assert.equal(checkCycles(root, none).errors.length, 2);
  const allowed = { cycles: [["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], ["src/self.ts"]] };
  const result = checkCycles(root, allowed);
  assert.deepEqual(result.errors, [], "a cycle inside an allowlisted one passes");
  assert.ok(
    result.warnings.some((w) => w.includes("no longer matches") && w.includes("src/d.ts")),
    "an entry larger than today's cycle is to be shrunk",
  );
  fs.writeFileSync(path.join(root, "src/c.ts"), "import { a } from './a.ts'; import './d.ts'; export const c = a;");
  fs.writeFileSync(path.join(root, "src/d.ts"), "import './e.ts';");
  fs.writeFileSync(path.join(root, "src/e.ts"), "import './c.ts';");
  assert.match(
    checkCycles(root, allowed).errors.join("\n"),
    /new import cycle: src\/a\.ts, src\/b\.ts, src\/c\.ts, src\/d\.ts, src\/e\.ts/,
    "a cycle that grows past its entry fails",
  );
});

test("main, the substrate and the preload load no native code but the frames addon, by process.dlopen in native-frames.ts", (t) => {
  const root = tree(t, {
    "src/main/foo.ts": "const addon = require('./x.node');",
    "src/main/esm.ts": "import addon from './y.node'; export { addon };",
    "src/main/reexport.ts": "export * from '../z.node';",
    "src/main/lazy.ts": "export const load = () => import('../lazy.node');",
    "src/main/equals.ts": "import pty = require('./pty.node');",
    "src/main/created.ts":
      "import { createRequire } from 'node:module'; const req = createRequire(import.meta.url); req('./c.node'); module.require('./m.node');",
    "src/substrate/dl.ts": "process.dlopen({ exports: {} }, '/tmp/a.node');",
    "src/substrate/aliased.ts": "const { dlopen } = process; const d = process['dlopen']; export { dlopen, d };",
    "src/preload/wasm.ts":
      "export const a = (b: BufferSource) => WebAssembly.instantiate(b); export const c = (b: BufferSource) => WebAssembly.compile(b); export const m = (b: BufferSource) => new WebAssembly.Module(b);",
    "src/main/native-frames.ts":
      "export function load(file: string) { const module = { exports: {} }; process.dlopen(module, file); return module.exports; } export const other = () => require('./other.node');",
    "src/main/scan.ts":
      "export const isAddon = (ext: string) => ext === '.node'; export const NAME = 'genex-frames.node'; export const RULE = /process\\.dlopen\\(/; // process.dlopen(x) in a comment",
    "src/renderer/view.ts": "const addon = require('./r.node');",
    "src/harness-seed/loop/x.ts": "process.dlopen({ exports: {} }, 'x.node');",
  });
  const refused = checkNativeLoads(root)
    .map((error) => error.split(": ")[0])
    .sort();
  assert.deepEqual(refused, [
    "src/main/created.ts:1",
    "src/main/created.ts:1",
    "src/main/equals.ts:1",
    "src/main/esm.ts:1",
    "src/main/foo.ts:1",
    "src/main/lazy.ts:1",
    "src/main/native-frames.ts:1",
    "src/main/reexport.ts:1",
    "src/preload/wasm.ts:1",
    "src/preload/wasm.ts:1",
    "src/preload/wasm.ts:1",
    "src/substrate/aliased.ts:1",
    "src/substrate/aliased.ts:1",
    "src/substrate/dl.ts:1",
  ]);
  assert.match(checkNativeLoads(root).join("\n"), /src\/main\/native-frames\.ts:1: .*other\.node/);
});

test("process.dlopen is allowed in src/main/native-frames.ts alone, and a .node string comparison is no load", (t) => {
  const root = tree(t, {
    "src/main/native-frames.ts": "export function load(file: string) { process.dlopen({ exports: {} }, file); }",
    "src/substrate/plugins/scan.ts":
      "export const isAddon = (ext: string) => ext === '.node' || ext.endsWith('.node');",
  });
  assert.deepEqual(checkNativeLoads(root), []);
});

test("the app may not load the Rust runtime or the spike's scripts: any src file, static or dynamic, resolved or not; erased types do not count", (t) => {
  const root = tree(t, {
    "native/genex-rust/web/shell.html": "<!doctype html>\n",
    "scripts/spike/rust-wgpu/measure.ts": "export const measure = () => 1;",
    "scripts/spike/rust-wgpu/types.ts": "export type Pins = { rust: string };",
    "src/main/shell.ts": "import shell from '../../native/genex-rust/web/shell.html';\nexport default shell;",
    "src/renderer/measure.ts": "export { measure } from '../../scripts/spike/rust-wgpu/measure.ts';",
    "src/substrate/lazy.ts": "export const load = () => import('../../scripts/spike/rust-wgpu/measure.ts');",
    "src/harness-seed/loop/crate.ts": "import '../../../native/genex-rust/crates/genex/src/lib.rs';",
    "src/shared/pins.ts": "import type { Pins } from '../../scripts/spike/rust-wgpu/types.ts'; export type P = Pins;",
    "src/main/resources.ts": "export const load = (dir: string) => import(dir + '/native/genex-rust/x.js');",
  });
  assert.deepEqual(
    rustRuntimeEdges(root)
      .map((e) => `${e.from}:${e.line} -> ${e.to}`)
      .sort(),
    [
      "src/harness-seed/loop/crate.ts:1 -> native/genex-rust/crates/genex/src/lib.rs",
      "src/main/shell.ts:1 -> native/genex-rust/web/shell.html",
      "src/renderer/measure.ts:1 -> scripts/spike/rust-wgpu/measure.ts",
      "src/substrate/lazy.ts:1 -> scripts/spike/rust-wgpu/measure.ts",
    ],
  );
  const result = checkRustRuntimeBoundary(root);
  assert.equal(result.errors.length, 4);
  assert.match(
    result.errors.join("\n"),
    /src\/main\/shell\.ts:1: runtime import of native\/genex-rust\/web\/shell\.html/,
  );
});

test("this repository has no seed import, and no cycle beyond the frozen allowlist", () => {
  const allowed = JSON.parse(fs.readFileSync(path.resolve(ALLOWLIST), "utf8")) as BoundaryAllowlist;
  assert.deepEqual(checkSeedBoundary(process.cwd()).errors, []);
  assert.deepEqual(
    checkRustRuntimeBoundary(process.cwd()).errors,
    [],
    "no app import of the Rust runtime or the spike",
  );
  assert.deepEqual(checkCycles(process.cwd(), allowed).errors, []);
});

test("this repository loads native code only where allowed: the frames addon in native-frames.ts", () => {
  assert.deepEqual(checkNativeLoads(process.cwd()), []);
});
test("browser boundary rejects direct, transitive, aliased and dynamic runtime dependencies; erased types pass", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ["renderer", "shared", "main"]) fs.mkdirSync(path.join(root, "src", d), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { moduleResolution: "bundler", module: "esnext", paths: { "@main/*": ["src/main/*"] } },
    }),
  );
  fs.writeFileSync(path.join(root, "src/main/private.ts"), "export const secret=1; export interface Type {}");
  const file = path.join(root, "src/renderer/a.ts");
  for (const code of [
    "import 'node:fs';",
    "import '../main/private.ts';",
    "export * from '../main/private.ts';",
    "void import('@main/private.ts');",
    "const x='node:fs';void import(x);",
  ]) {
    fs.writeFileSync(file, code);
    assert.ok(checkBoundaries(root).length, code);
  }
  fs.writeFileSync(path.join(root, "src/shared/barrel.ts"), "export * from '../main/private.ts';");
  fs.writeFileSync(file, "import '../shared/barrel.ts';");
  assert.match(checkBoundaries(root).join("\n"), /forbidden runtime edge/);
  fs.unlinkSync(path.join(root, "src/shared/barrel.ts"));
  fs.writeFileSync(
    file,
    "import type { Type } from '../main/private.ts'; export type { Type } from '../main/private.ts'; type X=import('../main/private.ts').Type; import {type Type as T} from '../main/private.ts';",
  );
  assert.deepEqual(checkBoundaries(root), []);
});
test("canonical preload API refuses an incompatible method signature", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "api-type-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wrong.ts");
  const contract = path.resolve("src/shared/studio-api.ts");
  fs.writeFileSync(
    file,
    `import type { StudioApi } from ${JSON.stringify(contract)}; const bootstrap: StudioApi['bootstrap'] = async () => 'wrong';`,
  );
  const p = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  // The compiler spells file names with forward slashes, on Windows too.
  const inFile = (d: ts.Diagnostic) => d.file !== undefined && path.resolve(d.file.fileName) === file;
  assert.ok(ts.getPreEmitDiagnostics(p).some((d) => inFile(d) && d.code === 2322));
});
