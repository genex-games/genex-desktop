/**
 * Multiplayer in the host-written cargo manifest (G6 MP-5b): a game with `[net] enabled = true`
 * links the facade's `net-loopback` feature (the in-process room) in every build Studio starts
 * (Live, judges, captures and the Simulator build a device launch installs), and the relay
 * (`net`) only in an export. A game without networking gets the same manifest, byte for byte, as
 * before. The slug the relay bakes in comes only from the game's Genex binding, and a hostile one
 * is never baked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bakeableGameSlug, rustNetFeatureOf } from "../../src/main/rust-build.ts";
import { cargoManifest, RustFacadePackage, RustFlavour, RustNetFeature } from "../../src/main/rust-manifest.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { parseGenexToml } from "../../src/substrate/genex-toml.ts";

const GENEX_VERSION = "0.1.0";
const NET_GAME = '[game]\ntitle = "Tag"\n\n[net]\nenabled = true\n';

function manifestOf(text: string) {
  const parsed = parseGenexToml(text);
  assert.ok(parsed.ok, parsed.ok ? "" : `${parsed.code} ${parsed.detail}`);
  return parsed.manifest;
}

/** The `genex = …` line of a written manifest. */
function facadeLine(cargoToml: string): string {
  const line = cargoToml.split("\n").find((row) => row.startsWith("genex = "));
  assert.ok(line, cargoToml);
  return line;
}

describe("cargo manifest: a [net] game's facade features (G6 MP-5b)", () => {
  const net = manifestOf(NET_GAME);

  it("a Live build links the in-process room beside the studio, and never the relay", () => {
    const line = facadeLine(
      cargoManifest(net, GENEX_VERSION, RustFlavour.Dev, RustFacadePackage.Native, null, RustNetFeature.Loopback),
    );
    assert.equal(line, 'genex = { version = "=0.1.0", features = ["studio", "net-loopback"] }');
    assert.doesNotMatch(line, /"net"/);
  });

  it("an export links the relay, natively and on the web", () => {
    const native = cargoManifest(
      net,
      GENEX_VERSION,
      RustFlavour.Export,
      RustFacadePackage.Native,
      null,
      RustNetFeature.Relay,
    );
    assert.equal(facadeLine(native), 'genex = { version = "=0.1.0", features = ["net"] }');
    const web = cargoManifest(
      net,
      GENEX_VERSION,
      RustFlavour.Export,
      RustFacadePackage.Web,
      null,
      RustNetFeature.Relay,
    );
    assert.equal(facadeLine(web), 'genex = { package = "genex-platform-web", version = "=0.1.0", features = ["net"] }');
  });

  it("a web Live build links the room through the web facade", () => {
    const web = cargoManifest(
      net,
      GENEX_VERSION,
      RustFlavour.Export,
      RustFacadePackage.Web,
      null,
      RustNetFeature.Loopback,
    );
    assert.equal(
      facadeLine(web),
      'genex = { package = "genex-platform-web", version = "=0.1.0", features = ["net-loopback"] }',
    );
  });

  it("keeps physics off beside the network feature", () => {
    const noPhysics = manifestOf(`${NET_GAME}\n[physics]\nenabled = false\n`);
    const line = facadeLine(
      cargoManifest(noPhysics, GENEX_VERSION, RustFlavour.Export, RustFacadePackage.Native, null, RustNetFeature.Relay),
    );
    // Flipped (release R-2): the facade's defaults also hold nav, streaming and animation, which a game
    // without physics keeps.
    assert.equal(
      line,
      'genex = { version = "=0.1.0", default-features = false, features = ["audio", "nav", "streaming", "animation", "net"] }',
    );
  });

  it("writes a game without networking the same manifest as before, whatever the build would link", () => {
    for (const text of ['[game]\ntitle = "Pond"\n', '[game]\ntitle = "Pond"\n\n[net]\nenabled = false\n']) {
      const manifest = manifestOf(text);
      for (const flavour of Object.values(RustFlavour)) {
        for (const facade of Object.values(RustFacadePackage)) {
          const before = cargoManifest(manifest, GENEX_VERSION, flavour, facade);
          for (const feature of Object.values(RustNetFeature)) {
            assert.equal(cargoManifest(manifest, GENEX_VERSION, flavour, facade, null, feature), before);
          }
        }
      }
    }
  });
});

describe("which network a build links (G6 MP-5b, owner call MP-O2)", () => {
  it("every build Studio starts links the room; only an export reaches the relay", () => {
    const rows: Array<[CppBuildPurpose, string, RustNetFeature]> = [
      [CppBuildPurpose.Live, "aarch64-apple-darwin", RustNetFeature.Loopback],
      [CppBuildPurpose.Judging, "aarch64-apple-darwin", RustNetFeature.Loopback],
      [CppBuildPurpose.Live, "wasm32-unknown-unknown", RustNetFeature.Loopback],
      [CppBuildPurpose.Export, "aarch64-apple-darwin", RustNetFeature.Relay],
      [CppBuildPurpose.Export, "wasm32-unknown-unknown", RustNetFeature.Relay],
      [CppBuildPurpose.Export, "x86_64-pc-windows-gnullvm", RustNetFeature.Relay],
      [CppBuildPurpose.Export, "x86_64-unknown-linux-gnu", RustNetFeature.Relay],
      [CppBuildPurpose.Export, "aarch64-apple-ios", RustNetFeature.Relay],
      [CppBuildPurpose.Export, "aarch64-linux-android", RustNetFeature.Relay],
      // The Simulator build exists only for a device launch from Studio: the room, never the network.
      [CppBuildPurpose.Export, "aarch64-apple-ios-sim", RustNetFeature.Loopback],
    ];
    for (const [purpose, triple, expected] of rows) {
      assert.equal(rustNetFeatureOf(purpose, triple), expected, `${purpose} ${triple}`);
    }
  });
});

describe("the relay slug a build bakes in (G6 MP-5b, hostile table)", () => {
  it("bakes a plain slug", () => {
    for (const slug of ["tag", "harbour-nights", "tag_2", "a1b2c3", "x".repeat(128)]) {
      assert.equal(bakeableGameSlug(slug), slug);
    }
  });

  it("never bakes a slug that is a path, climbs, carries control or other characters, or is too long", () => {
    const hostile = [
      "",
      "a/b",
      "/abs",
      "..",
      "../x",
      "x/..",
      "a\\b",
      ".hidden",
      "a.b",
      "a\u0000b",
      "a\nb",
      "a\tb",
      "a\u007fb",
      "a b",
      " lead",
      "-lead",
      "%2e%2e",
      "é",
      "x".repeat(129),
      "a;b",
      "$(id)",
    ];
    for (const slug of hostile) assert.equal(bakeableGameSlug(slug), null, JSON.stringify(slug));
    assert.equal(bakeableGameSlug(null), null);
  });
});
