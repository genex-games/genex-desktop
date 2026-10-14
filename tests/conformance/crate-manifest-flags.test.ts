/**
 * A crate's own Cargo.toml read for the two things the person approves apart (M3.15): whether
 * cargo runs a build script and whether the crate is a proc macro. The manifest is whatever its
 * publisher uploaded, so every spelling TOML allows for either is a row here, and anything the
 * reader cannot read is taken for both (fail closed): approving too much is asked, never assumed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crateManifestFlags } from "../../src/substrate/toolchain-store/crate-vendor-job.ts";

const PKG = '[package]\nname = "x"\nversion = "1.0.0"\n';

describe("a crate manifest's build script and proc-macro flags", () => {
  it("reads a plain manifest as neither", () => {
    assert.deepEqual(crateManifestFlags(`${PKG}[dependencies]\nserde = "1"\n`), {
      build: null,
      procMacro: false,
    });
  });

  it("finds a build script in every spelling", () => {
    const rows: Array<[string, string]> = [
      ["a basic string", `${PKG}build = "gen.rs"\n`],
      ["a literal string", `[package]\nname = 'x'\nbuild = 'gen.rs'\n`],
      ["a quoted key", `${PKG}"build" = "gen.rs"\n`],
      ["an escaped key", `${PKG}"bu\\u0069ld" = "gen.rs"\n`],
      ["a dotted key at the root", `package.build = "gen.rs"\n[lib]\n`],
      ["an inline package table", `package = { name = "x", build = "gen.rs" }\n`],
      ["a commented header", `[package] # the crate\nname = "x"\nbuild = "gen.rs"\n`],
      ["a spaced header", `[ package ]\nbuild = "gen.rs"\n`],
      ["build = true", `${PKG}build = true\n`],
      ["an array", `${PKG}build = ["a.rs", "b.rs"]\n`],
    ];
    for (const [why, text] of rows) assert.equal(crateManifestFlags(text).build, true, why);
  });

  it("takes build = false as no build script", () => {
    assert.equal(crateManifestFlags(`${PKG}build = false\n`).build, false);
  });

  it("finds a proc macro in every spelling", () => {
    const rows: Array<[string, string]> = [
      ["a lib table", `${PKG}[lib]\nproc-macro = true\n`],
      ["an underscore key", `${PKG}[lib]\nproc_macro = true\n`],
      ["a commented header", `${PKG}[lib] # x\nproc-macro = true\n`],
      ["a spaced header", `${PKG}[ lib ]\nproc-macro = true\n`],
      ["a dotted key", `${PKG}lib.proc-macro = true\n`],
      ["an inline table", `${PKG}lib = { proc-macro = true }\n`],
      ["a quoted key", `${PKG}[lib]\n"proc-macro" = true\n`],
      ["a crate type", `${PKG}[lib]\ncrate-type = ["proc-macro"]\n`],
    ];
    for (const [why, text] of rows) assert.equal(crateManifestFlags(text).procMacro, true, why);
  });

  it("never reads a field out of a string or a comment", () => {
    const text = `${PKG}description = """\nbuild = "gen.rs"\n[lib]\nproc-macro = true\n"""\n# build = "x"\nkeywords = ["proc-macro"]\n`;
    assert.deepEqual(crateManifestFlags(text), { build: null, procMacro: false });
  });

  it("takes a manifest it cannot read for both (fail closed)", () => {
    for (const text of [`${PKG}build = "gen.rs`, `${PKG}x = '''open\n`, `${PKG}k = "\\q"\n`, "\u0000"]) {
      assert.deepEqual(crateManifestFlags(text), { build: true, procMacro: true }, JSON.stringify(text));
    }
  });
});
