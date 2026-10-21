/**
 * The web destination's gate (`substrate/native-gate-wasm.ts`, M3.5): the host reads a Rust web
 * build's wasm module itself (sections, imports, exports, bounded) and admits only a module whose
 * every import comes from the build's own wasm-bindgen glue, in a folder holding exactly the
 * shell's files (`index.html`, `game.js`, `game_bg.wasm`, the optional `size.json`) and assets.
 * The admitted folder's manifest names each file's digest. Synthetic modules come from
 * `fixtures/rust-bundles/binaries.ts`; the committed `rust-wasm` fixture is real wasm-bindgen output.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { WEB_FILES, WEB_NET_FILES } from "../../src/main/rust-build-web.ts";
import { NativeRefusal, RustAdmissionProblem } from "../../src/shared/native-contract.ts";
import {
  admitRustWasm,
  admitWebShell,
  parseWasm,
  RUST_WASM_GLUE_MODULE,
  RUST_WEB_NET_FILES,
  RUST_WEB_SHELL_FILES,
  WasmImportKind,
} from "../../src/substrate/native-gate-wasm.ts";
import { glueImport, M2, wasmBinary } from "../fixtures/rust-bundles/binaries.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURE = new URL("../fixtures/rust-wasm/", import.meta.url);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const verdict = (bytes: Uint8Array) => {
  const admission = admitRustWasm(bytes);
  return admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`;
};

describe("the wasm reader (M3.5)", () => {
  it("reads a module's imports and exports as WebAssembly itself does", () => {
    const bytes = new Uint8Array(
      wasmBinary({ imports: [glueImport("__wbg_log"), glueImport("__wbg_now")], exports: ["start"] }),
    );
    assert.ok(WebAssembly.validate(bytes), "the fixture writer makes a valid module");
    const read = parseWasm(bytes);
    assert.ok(read.ok);
    const compiled = new WebAssembly.Module(bytes);
    assert.deepEqual(
      read.module.imports.map((entry) => ({ module: entry.module, name: entry.name, kind: entry.kind })),
      WebAssembly.Module.imports(compiled),
    );
    assert.deepEqual(read.module.exports, WebAssembly.Module.exports(compiled));
  });

  it("reads the committed wasm-bindgen fixture: one glue module, the shell's exports", async () => {
    const read = parseWasm(await readFile(new URL(WEB_FILES.wasm, FIXTURE)));
    assert.ok(read.ok);
    assert.deepEqual([...new Set(read.module.imports.map((entry) => entry.module))], [RUST_WASM_GLUE_MODULE]);
    assert.ok(read.module.exports.some((entry) => entry.name === "studio_boot"));
  });

  const malformed: Array<[string, Uint8Array]> = [
    ["empty bytes", new Uint8Array()],
    ["another magic", Buffer.from("\u007fELF\u0002\u0001\u0001\u0000")],
    ["wasm version 2", Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00])],
    ["a section running past the end", Buffer.concat([wasmBinary().subarray(0, 8), Buffer.from([0x02, 0x7f, 0x01])])],
    [
      "an LEB128 longer than five bytes",
      Buffer.concat([wasmBinary().subarray(0, 8), Buffer.from([0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])]),
    ],
    [
      "a truncated import name",
      Buffer.concat([wasmBinary().subarray(0, 8), Buffer.from([0x02, 0x03, 0x01, 0x10, 0x61])]),
    ],
    [
      "an import section with an impossible count",
      Buffer.concat([wasmBinary().subarray(0, 8), Buffer.from([0x02, 0x05, 0xff, 0xff, 0xff, 0xff, 0x0f])]),
    ],
    [
      "a non-UTF-8 name",
      Buffer.concat([wasmBinary().subarray(0, 8), Buffer.from([0x02, 0x05, 0x01, 0x01, 0xff, 0x00, 0x00])]),
    ],
  ];
  for (const [label, bytes] of malformed) {
    it(`refuses ${label} as unreadable, typed, without throwing`, () => {
      assert.equal(parseWasm(bytes).ok, false);
      assert.equal(verdict(bytes), `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.Unreadable}`);
    });
  }
});

describe("Rust web module admission (M3.5)", () => {
  it("admits a module importing only its wasm-bindgen glue, as the real web build did", () => {
    assert.deepEqual(M2.web.importModules, [RUST_WASM_GLUE_MODULE]);
    assert.equal(verdict(wasmBinary()), "admitted");
  });

  const hostile: Array<[string, Uint8Array, string]> = [
    [
      "an import from env (an Emscripten or C runtime)",
      wasmBinary({ imports: [glueImport("__wbg_log"), { module: "env", name: "fetch" }] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.WasmImport}`,
    ],
    [
      "a WASI import",
      wasmBinary({ imports: [{ module: "wasi_snapshot_preview1", name: "sock_open" }] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.WasmImport}`,
    ],
    [
      "the glue module under another out-name",
      wasmBinary({ imports: [{ module: "./other_bg.js", name: "__wbg_log" }] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.WasmImport}`,
    ],
    [
      "an imported memory (shared with the page)",
      wasmBinary({ imports: [{ ...glueImport("memory"), kind: 2 }] }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.WasmImport}`,
    ],
  ];
  for (const [label, bytes, expected] of hostile) {
    it(`refuses ${label}, typed`, () => {
      assert.equal(verdict(bytes), expected);
    });
  }

  it("names wasm's import kinds by their wire names", () => {
    assert.deepEqual(Object.values(WasmImportKind).sort(), ["function", "global", "memory", "table", "tag"]);
  });
});

describe("the web build's shell manifest (M3.5)", () => {
  it("names the files the lane's web branch writes", () => {
    assert.deepEqual(RUST_WEB_SHELL_FILES, {
      page: WEB_FILES.page,
      module: WEB_FILES.module,
      wasm: WEB_FILES.wasm,
      size: WEB_FILES.size,
    });
  });

  /** A web folder: the committed fixture's three files, plus `extra` (a path → bytes, or a link). */
  async function webFolder(extra: Record<string, Buffer> = {}, drop: string[] = []): Promise<string> {
    const dir = path.join(await tmpDir("web-shell-"), "web");
    await mkdir(path.join(dir, "assets", "sprites"), { recursive: true });
    for (const name of [WEB_FILES.page, WEB_FILES.module, WEB_FILES.wasm])
      if (!drop.includes(name)) await writeFile(path.join(dir, name), await readFile(new URL(name, FIXTURE)));
    await writeFile(path.join(dir, "assets", "sprites", "ship.png"), "png bytes");
    for (const [rel, bytes] of Object.entries(extra)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), bytes);
    }
    return dir;
  }

  it("admits the committed web build with its assets and lists each file's digest", async () => {
    const dir = await webFolder({ [WEB_FILES.size]: Buffer.from("{}") });
    try {
      const admission = await admitWebShell(dir);
      assert.ok(admission.ok, admission.ok ? "" : admission.detail);
      const wasm = await readFile(new URL(WEB_FILES.wasm, FIXTURE));
      assert.deepEqual(
        admission.manifest.files.map((file) => file.path),
        ["assets/sprites/ship.png", WEB_FILES.module, WEB_FILES.wasm, WEB_FILES.page, WEB_FILES.size].sort(),
      );
      const listed = admission.manifest.files.find((file) => file.path === WEB_FILES.wasm);
      assert.deepEqual(listed, { path: WEB_FILES.wasm, sha256: sha256(wasm), bytes: wasm.length });
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  const hostile: Array<[string, () => Promise<string>, string]> = [
    [
      "a file the shell does not name",
      () => webFolder({ "worker.js": Buffer.from("self.onmessage = () => {}") }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.ShellFiles}`,
    ],
    [
      "a second wasm module among the assets",
      () => webFolder({ "assets/decoder.bin": wasmBinary() }),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.ShellFiles}`,
    ],
    [
      "no game.js",
      () => webFolder({}, [WEB_FILES.module]),
      `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.ShellFiles}`,
    ],
    [
      "a module importing from env",
      () => webFolder({ [WEB_FILES.wasm]: wasmBinary({ imports: [{ module: "env", name: "x" }] }) }),
      `${NativeRefusal.ForeignImport}/${RustAdmissionProblem.WasmImport}`,
    ],
  ];
  for (const [label, make, expected] of hostile) {
    it(`refuses a web folder with ${label}, typed`, async () => {
      const dir = await make();
      try {
        const admission = await admitWebShell(dir);
        assert.equal(admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`, expected);
      } finally {
        await rm(path.dirname(dir), { recursive: true, force: true });
      }
    });
  }

  it("names the files a [net] build's web branch writes besides the shell's (MP-5a)", () => {
    assert.deepEqual(RUST_WEB_NET_FILES, WEB_NET_FILES);
  });

  const BRIDGE = Buffer.from('"use strict";globalThis.GenexMultiplayerBridge={};\n');
  const NET = { [WEB_NET_FILES.bridge]: BRIDGE, [WEB_NET_FILES.shim]: Buffer.from("export default {};\n") };

  it("admits a [net] build's bridge and shim beside the shell, the bridge held to its pin (MP-5a)", async () => {
    const dir = await webFolder(NET);
    try {
      const admission = await admitWebShell(dir, sha256(BRIDGE));
      assert.ok(admission.ok, admission.ok ? "" : admission.detail);
      const listed = admission.manifest.files.map((file) => file.path);
      for (const file of Object.values(WEB_NET_FILES)) assert.ok(listed.includes(file), file);
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });

  const netHostile: Array<[string, Record<string, Buffer>, string | undefined]> = [
    ["the bridge without its shim", { [WEB_NET_FILES.bridge]: BRIDGE }, sha256(BRIDGE)],
    ["the shim without its bridge", { [WEB_NET_FILES.shim]: NET[WEB_NET_FILES.shim] }, sha256(BRIDGE)],
    ["a bridge that is not the pin's", NET, sha256(Buffer.from("another bridge"))],
    ["a bridge that is not the real pin's", NET, undefined],
    ["a bridge outside mp/", { "bridge.global.js": BRIDGE }, sha256(BRIDGE)],
  ];
  for (const [label, extra, pin] of netHostile) {
    it(`refuses a web folder with ${label}, typed (MP-5a)`, async () => {
      const dir = await webFolder(extra);
      try {
        const admission = await admitWebShell(dir, pin);
        assert.equal(
          admission.ok ? "admitted" : `${admission.refusal}/${admission.problem}`,
          `${NativeRefusal.NotAnExecutable}/${RustAdmissionProblem.ShellFiles}`,
        );
      } finally {
        await rm(path.dirname(dir), { recursive: true, force: true });
      }
    });
  }

  it("refuses a link and a second hard link, and reads neither's target", async () => {
    const dir = await webFolder();
    try {
      await symlink("/etc/hosts", path.join(dir, "assets", "hosts.txt"));
      const linked = await admitWebShell(dir);
      assert.equal(
        !linked.ok && `${linked.refusal}/${linked.problem}`,
        `${NativeRefusal.Symlink}/${RustAdmissionProblem.Link}`,
      );
      await rm(path.join(dir, "assets", "hosts.txt"));
      await link(path.join(dir, WEB_FILES.page), path.join(dir, "assets", "page-twin.html"));
      const hard = await admitWebShell(dir);
      assert.equal(
        !hard.ok && `${hard.refusal}/${hard.problem}`,
        `${NativeRefusal.HardLink}/${RustAdmissionProblem.Link}`,
      );
    } finally {
      await rm(path.dirname(dir), { recursive: true, force: true });
    }
  });
});
