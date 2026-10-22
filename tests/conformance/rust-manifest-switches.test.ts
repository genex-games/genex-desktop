/**
 * The game systems a genex.toml switches off, in the host-written cargo manifest and lock (release
 * R-2, owner call E11). Each of `[physics]`, `[audio]`, `[nav]`, `[streaming]` and `[animation]`
 * with `enabled = false` links the facade without default features, naming every default the game
 * keeps, natively and through the web facade; a game that switches nothing off keeps the bare
 * requirement. The lock drops a switched-off system's crates only where its facade feature does
 * (Rapier, audio's mixer): navigation, streaming and animation keep their crates, because the
 * facade keeps their surface and only stops linking their engines.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cargoManifest, gameCargoLock, RustFacadePackage, RustFlavour } from "../../src/main/rust-manifest.ts";
import { parseGenexToml } from "../../src/substrate/genex-toml.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENEX_VERSION = "0.1.0";
const GAME = '[game]\ntitle = "Pond"\n';
/** The facade's default features in its own order (genex's and genex-platform-web's `default`). */
const DEFAULTS = ["physics", "audio", "nav", "streaming", "animation"] as const;

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

/** A genex.toml switching off each of `systems`. */
const switchedOff = (systems: readonly string[]) =>
  `${GAME}${systems.map((system) => `\n[${system}]\nenabled = false\n`).join("")}`;

const quoted = (features: readonly string[]) => features.map((feature) => `"${feature}"`).join(", ");

describe("cargo manifest: the game systems a genex.toml switches off (release R-2)", () => {
  for (const system of DEFAULTS) {
    it(`a game without ${system} links every other default, natively and on the web`, () => {
      const manifest = manifestOf(switchedOff([system]));
      const kept = quoted(DEFAULTS.filter((feature) => feature !== system));
      assert.equal(
        facadeLine(cargoManifest(manifest, GENEX_VERSION)),
        `genex = { version = "=0.1.0", default-features = false, features = [${kept}] }`,
      );
      assert.equal(
        facadeLine(cargoManifest(manifest, GENEX_VERSION, RustFlavour.Export, RustFacadePackage.Web)),
        `genex = { package = "genex-platform-web", version = "=0.1.0", default-features = false, features = [${kept}] }`,
      );
    });
  }

  it("a Live build keeps the studio feature first, then the defaults the game keeps", () => {
    const manifest = manifestOf(switchedOff(["nav", "streaming", "animation"]));
    assert.equal(
      facadeLine(cargoManifest(manifest, GENEX_VERSION, RustFlavour.Dev)),
      'genex = { version = "=0.1.0", default-features = false, features = ["studio", "physics", "audio"] }',
    );
  });

  it("a game with every system off links the facade with no default feature", () => {
    const manifest = manifestOf(switchedOff(DEFAULTS));
    assert.equal(
      facadeLine(cargoManifest(manifest, GENEX_VERSION)),
      'genex = { version = "=0.1.0", default-features = false }',
    );
  });

  it("a game that switches nothing off, or switches a system on by name, keeps the bare requirement", () => {
    for (const text of [GAME, `${GAME}\n[nav]\nenabled = true\n`, `${GAME}\n[streaming]\n\n[animation]\n`]) {
      assert.equal(facadeLine(cargoManifest(manifestOf(text), GENEX_VERSION)), 'genex = "=0.1.0"', text);
    }
  });

  it("the template switches off navigation, streaming and animation and keeps physics and audio", async () => {
    const text = await readFile(path.join(ROOT, "src", "game-template-rust", "genex.toml"), "utf8");
    const manifest = manifestOf(text.replace("__GAME_TITLE__", "Pond"));
    assert.equal(
      facadeLine(cargoManifest(manifest, GENEX_VERSION, RustFlavour.Export, RustFacadePackage.Web)),
      'genex = { package = "genex-platform-web", version = "=0.1.0", default-features = false, features = ["physics", "audio"] }',
    );
  });
});

describe("cargo lock: the crates a switched-off system leaves (release R-2)", () => {
  it("navigation, streaming and animation off keep the lock a game that says nothing gets", async () => {
    const baseLock = await readFile(path.join(ROOT, "native", "genex-rust", "Cargo.lock"), "utf8");
    for (const facade of Object.values(RustFacadePackage)) {
      const pins = { genexVersion: GENEX_VERSION, baseLock, facade };
      const every = gameCargoLock(manifestOf(GAME), pins);
      const fewer = gameCargoLock(manifestOf(switchedOff(["nav", "streaming", "animation"])), pins);
      assert.ok(every.ok && fewer.ok, JSON.stringify([every, fewer]));
      assert.equal(fewer.text, every.text, facade);
      for (const crate of ["genex-nav", "genex-stream", "genex-anim"]) {
        assert.match(fewer.text, new RegExp(`\nname = "${crate}"\n`), `${facade}: ${crate}'s surface stays`);
      }
    }
  });

  it("every system off drops Rapier's and the mixer's closures and nothing else a switch names", async () => {
    const baseLock = await readFile(path.join(ROOT, "native", "genex-rust", "Cargo.lock"), "utf8");
    const pins = { genexVersion: GENEX_VERSION, baseLock };
    const bare = gameCargoLock(manifestOf(switchedOff(DEFAULTS)), pins);
    const engines = gameCargoLock(manifestOf(switchedOff(["physics", "audio"])), pins);
    assert.ok(bare.ok && engines.ok, JSON.stringify([bare, engines]));
    assert.equal(bare.text, engines.text);
    for (const crate of ["rapier3d", "kira", "cpal", "symphonia"]) {
      assert.doesNotMatch(bare.text, new RegExp(`\nname = "${crate}"\n`), crate);
    }
  });
});
