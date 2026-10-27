/**
 * What the `@genex-ai/physics` build ships besides code (`scripts/physics-wasm-notices.ts`): the
 * third-party notices of every crate linked into the module, and the refusal of a module that holds
 * an absolute path of the build machine. Unit rows over fixture metadata run anywhere; the package
 * rows read the built folder `.studio-dev/build/physics-wasm/` (`node scripts/physics-wasm.ts`) and
 * skip without it (`GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  commonText,
  crateClosure,
  crateTexts,
  localPathsIn,
  type Metadata,
  type MetadataPackage,
  noticeCrate,
  noticesMarkdown,
} from "../../scripts/physics-wasm-notices.ts";
import { factoryGlue } from "../../scripts/physics-wasm-glue.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGE = path.join(REPO, ".studio-dev/build/physics-wasm");
const MODULE = path.join(PACKAGE, "wasm/genex_physics_wasm_bg.wasm");
const APACHE = "Apache License\nVersion 2.0, January 2004\n";

function pkg(id: string, source: string | null, license: string | null, dir: string): MetadataPackage {
  const [name, version] = id.split("@");
  return {
    id,
    name,
    version,
    license,
    authors: [`${name} authors`],
    repository: `https://example.invalid/${name}`,
    source,
    manifest_path: path.join(dir, `${name}-${version}`, "Cargo.toml"),
  };
}

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";

/** Metadata of a binding that links `lib` (which links `leaf`), builds with `builder` and tests with `tester`. */
function metadata(dir: string): Metadata {
  const packages = [
    pkg("binding@0.1.0", null, "MIT", dir),
    pkg("core@0.1.0", null, "MIT", dir),
    pkg("lib@1.0.0", REGISTRY, "MIT OR Apache-2.0", dir),
    pkg("leaf@2.0.0", REGISTRY, "Apache-2.0", dir),
    pkg("builder@1.0.0", REGISTRY, "MIT", dir),
    pkg("tester@1.0.0", REGISTRY, "MIT", dir),
  ];
  const dep = (pkg: string, kind: string | null) => ({ pkg, dep_kinds: [{ kind }] });
  const nodes = [
    { id: "binding@0.1.0", deps: [dep("core@0.1.0", null), dep("tester@1.0.0", "dev"), dep("builder@1.0.0", "build")] },
    { id: "core@0.1.0", deps: [dep("lib@1.0.0", null)] },
    { id: "lib@1.0.0", deps: [dep("leaf@2.0.0", null)] },
    { id: "leaf@2.0.0", deps: [] },
    { id: "builder@1.0.0", deps: [] },
    { id: "tester@1.0.0", deps: [] },
  ];
  return { packages, resolve: { nodes } };
}

describe("the physics package's third-party notices", () => {
  it("lists the third-party crates the binding links in, along normal dependencies only", async () => {
    const dir = await tmpDir("physics-notices-");
    const names = crateClosure(metadata(dir), "binding").map((crate) => crate.name);
    assert.deepEqual(names, ["leaf", "lib"], "no workspace member, build or dev dependency");
    assert.throws(() => crateClosure(metadata(dir), "lib"), /not a workspace member/);
  });

  it("ships every licence file once, and the Apache text for a crate whose source has none", async () => {
    const dir = await tmpDir("physics-notices-");
    const data = metadata(dir);
    await mkdir(path.join(dir, "lib-1.0.0"), { recursive: true });
    await writeFile(path.join(dir, "lib-1.0.0", "LICENSE-APACHE"), APACHE);
    await writeFile(path.join(dir, "lib-1.0.0", "LICENSE-MIT"), "MIT License\nCopyright (c) lib authors\n");
    await writeFile(path.join(dir, "lib-1.0.0", "README.md"), "not a licence");
    await mkdir(path.join(dir, "leaf-2.0.0"), { recursive: true });
    const crates = crateClosure(data, "binding").map((crate) => noticeCrate(crate, crateTexts(crate)));
    assert.deepEqual(
      crates.map((crate) => crate.texts.map((text) => text.file)),
      [[], ["LICENSE-APACHE", "LICENSE-MIT"]],
    );
    const apache = commonText(crates, /^LICENSE-APACHE$/);
    assert.equal(apache, APACHE);
    const notices = noticesMarkdown(crates, new Map([["Apache-2.0", apache ?? ""]]));
    assert.equal(notices.split(APACHE.trimEnd()).length - 1, 1, "the Apache text once");
    assert.ok(notices.includes("- leaf 2.0.0: no licence file in its source; Apache-2.0 applies"), notices);
    assert.ok(notices.includes("- lib 1.0.0: LICENSE-APACHE"), notices);
    assert.ok(notices.includes("Copyright (c) lib authors"), notices);
    assert.ok(notices.includes("| leaf | 2.0.0 | Apache-2.0 | leaf authors |"), notices);
  });
});

describe("the physics module holds no path of the machine that built it", () => {
  it("finds the given folders and any home folder in a module's bytes, and nothing in a clean one", () => {
    const bytes = (text: string) => new Uint8Array(Buffer.from(`\0asm${text}\0`, "latin1"));
    const rows: [string, string, string[]][] = [
      ["a vendored path", "/build/repo/vendor/rapier3d-0.36.0/src/lib.rs", ["/build/repo"]],
      ["a Mac home folder", "panicked at /Users/someone/x.rs", ["/Users/someone/"]],
      ["a Linux home folder", "at /home/ci/.cargo/registry/a.rs", ["/home/ci/"]],
      ["a relative vendored path", "vendor/rapier3d-0.36.0/src/lib.rs", []],
      ["the std library's remapped path", "/rustc/0123abcd/library/core/src/num/mod.rs", []],
    ];
    for (const [name, text, found] of rows) {
      assert.deepEqual(localPathsIn(bytes(text), ["/build/repo"]), found, name);
    }
  });
});

describe("the physics glue as a factory, one WebAssembly instance per call", () => {
  const glue = [
    "export function __wbg_reset_state () {",
    "    state++;",
    "}",
    "let state = 0;",
    "let wasmModule;",
    "export function build_id() {",
    '    return "b" + state;',
    "}",
    "function initSync(module) { wasmModule = module; return state; }",
    "async function __wbg_init(input) { return input; }",
    "export { initSync, __wbg_init as default };",
    "",
  ].join("\n");

  it("wraps the glue in createGlue(), each call with state of its own and the same exports", async () => {
    const dir = await tmpDir("physics-glue-");
    const file = path.join(dir, "glue.mjs");
    await writeFile(file, factoryGlue(glue));
    const { createGlue } = (await import(pathToFileURL(file).href)) as {
      createGlue: () => Record<string, (...args: unknown[]) => unknown>;
    };
    const [a, b] = [createGlue(), createGlue()];
    assert.deepEqual(Object.keys(a), ["__wbg_reset_state", "build_id", "initSync", "default", "__genex_module"]);
    a.__wbg_reset_state();
    assert.deepEqual([a.build_id(), b.build_id()], ["b1", "b0"], "each call keeps its own state");
    a.initSync("module");
    assert.deepEqual([a.__genex_module(), b.__genex_module()], ["module", undefined]);
    assert.ok(Object.isFrozen(a));
  });

  it("refuses a glue of any other shape", () => {
    const rows: [string, string][] = [
      ["an import", `import x from "y";\n${glue}`],
      ["no init export at the end", glue.replace("export { initSync, __wbg_init as default };", "")],
      ["another export form", glue.replace("let state = 0;", "export let state = 0;")],
      ["no exported function", glue.replace(/export function/g, "function")],
    ];
    for (const [name, text] of rows) assert.throws(() => factoryGlue(text), /physics-wasm-glue/, name);
  });
});

const built = existsSync(MODULE);
function needsBuild(): { skip?: string } {
  if (built) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${MODULE} absent`);
  return { skip: `not run: the physics package (${PACKAGE}; node scripts/physics-wasm.ts) absent` };
}

describe("the built @genex-ai/physics package", needsBuild(), () => {
  it("ships its licence and the notices of rapier3d and parry3d, and no local path in its module", () => {
    const files = JSON.parse(readFileSync(path.join(PACKAGE, "package.json"), "utf8")).files as string[];
    assert.ok(files.includes("LICENSE") && files.includes("THIRD-PARTY-NOTICES.md"), files.join(", "));
    assert.match(readFileSync(path.join(PACKAGE, "LICENSE"), "utf8"), /^MIT License/);
    const notices = readFileSync(path.join(PACKAGE, "THIRD-PARTY-NOTICES.md"), "utf8");
    for (const crate of ["rapier3d", "parry3d", "nalgebra", "simba", "serde_json", "wasm-bindgen"]) {
      assert.ok(notices.includes(`| ${crate} |`), `${crate} is listed`);
    }
    assert.ok(notices.includes("- rapier3d 0.36.0: no licence file in its source; Apache-2.0 applies"));
    assert.ok(notices.includes("Apache License"), "the Apache-2.0 text is shipped");
    assert.deepEqual(localPathsIn(readFileSync(MODULE), [path.resolve(REPO), os.homedir()]), []);
  });
});
