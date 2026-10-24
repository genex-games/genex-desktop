/**
 * `genex.toml`, the one build input a Rust · wgpu game declares (`src/substrate/genex-toml.ts`):
 * read as data by the host, which writes the cargo manifest from it, so anything outside the
 * schema is refused with a typed code. The rows mirror genex's own `manifest.rs` (the runtime
 * reads the same file) and add what only the host checks: crate version requirements, unknown
 * native-enhanced feature names, the web refusal for a game that declares any, and the WGSL
 * sources it names resolved by realpath inside a folder, regular files only, never through a link.
 * The `[render]` table and `[[wgsl]] api` rows come from `tests/fixtures/genex-toml-render.json`,
 * which genex's `tests/manifest.rs` reads too, and the render vocabulary is the wire fixture's.
 */
import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { WEB_WASM_CEILING_MB } from "../../src/shared/game-export-contract.ts";
import {
  NATIVE_EXTENSION_API_VERSION,
  NATIVE_WGSL_MAX_BYTES,
  NativeEnhancedFeature,
  NativeRefusal,
} from "../../src/shared/native-contract.ts";
import {
  AO_INTENSITY_MAX,
  AO_RADIUS_MAX,
  BLOOM_INTENSITY_MAX,
  BLOOM_RADIUS_MAX,
  BLOOM_RADIUS_MIN,
  BLOOM_THRESHOLD_MAX,
  CAPTURE_SETTLE_FRAMES_MAX,
  CONTACT_SHADOW_LENGTH_MAX,
  CaptureExposure,
  DegradeReason,
  DeviceClass,
  ADAPTATION_SPEED_MAX,
  EV_COMPENSATION_LIMIT,
  EXPOSURE_EV_LIMIT,
  ExposureMode,
  FOG_COLOR_MAX,
  FOG_DENSITY_MAX,
  FOG_DISTANCE_LIMIT,
  FOG_HEIGHT_FALLOFF_MAX,
  FAR_DENSITY_MIN,
  FormFactor,
  LookKey,
  LOD_FADE_BAND_MAX,
  LOD_MAX_LEVELS,
  LOD_MIN_TRIANGLES,
  LOD_SCHEMA_VERSION,
  LOD_THRESHOLD_PX_MAX,
  LOD_THRESHOLD_PX_MIN,
  LodExtrasKey,
  LodFault,
  LodLevelKey,
  LODS_EXTRAS_KEY,
  MESHLET_MAX_TRIANGLES,
  MESHLET_MAX_VERTICES,
  MESHLET_MIN_TRIANGLES_DEFAULT,
  MESHLET_RECORD_BYTES,
  MESHLET_SCHEMA_VERSION,
  MESHLETS_EXTRAS_KEY,
  MeshletExtrasKey,
  MeshletFault,
  Metering,
  PerformanceTier,
  PostPassStage,
  QualityKey,
  QualityPreset,
  FRAME_BUDGET_MS_MAX,
  FRAME_BUDGET_MS_MIN,
  RENDER_FPS_TARGETS,
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  RenderFeature,
  RenderInput,
  RendererFeature,
  RenderSettingsRefusal,
  RenderTomlKey,
  SettingsSource,
  SHADOW_BLEND_BAND_MAX,
  SHADOW_DISTANCE_MAX,
  SHADOW_DISTANCE_MIN,
  ShadowTomlKey,
  Tonemapper,
  WGSL_EXTENSION_APIS,
} from "../../src/shared/render-quality.ts";
import {
  assetBudgetOf,
  assetGroupMatches,
  checkTargetFeatures,
  checkWgslFiles,
  GAME_CRATE_ALLOWLIST,
  GameFit,
  GenexTomlCode,
  genexMatchmakingBlock,
  MatchmakingPreset,
  MatchWinCondition,
  NET_MATCH_CONFIG_MAX_KEYS,
  netEnabled,
  parseGenexToml,
  readGenexToml,
  renderTomlFragment,
  WgslKind,
  wgslTomlFragment,
  withEngineRow,
} from "../../src/substrate/genex-toml.ts";
import { TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import {
  GLB_TEXTURE_STEM_MAX_CHARS,
  GLB_TEXTURES_EXTRAS_KEY,
  GLB_TEXTURES_SCHEMA_VERSION,
  GlbTextureImageKey,
  GlbTexturesKey,
} from "../../src/substrate/asset-import/glb-textures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE_MANIFEST = path.join(ROOT, "src", "game-template-rust", "genex.toml");

/** The `[render]` and `[[wgsl]] api` rows both parsers read. */
const RENDER_ROWS = JSON.parse(
  await readFile(path.join(ROOT, "tests", "fixtures", "genex-toml-render.json"), "utf8"),
) as {
  game: string;
  accepted: Array<{ name: string; text: string }>;
  hostile: Array<{ name: string; text: string; code: string }>;
  fragments: { wgslRows: string; render: string; wgsl: string };
};

/** The crates a game names without approval, the one table both sides hold (owner call 8). */
const CRATE_ALLOWLIST = JSON.parse(
  await readFile(path.join(ROOT, "tests", "fixtures", "game-crate-allowlist.json"), "utf8"),
) as { crates: string[] };

/** The render vocabulary of the wire fixture genex-studio's `wire.rs` and genex's `manifest.rs` hold. */
const WIRE_RENDER = (
  JSON.parse(await readFile(path.join(ROOT, "tests", "fixtures", "native-wire-v2.json"), "utf8")) as {
    render: Record<string, unknown>;
  }
).render;

/** The parsed manifest of an accepted text, or a failure naming the refusal. */
function accepted(text: string) {
  const result = parseGenexToml(text);
  assert.ok(result.ok, `refused: ${result.ok ? "" : `${result.code} ${result.detail}`}`);
  return result.manifest;
}

/** The code a refused result answers. */
function refusedCode(result: { ok: true } | { ok: false; code: string }): string {
  assert.equal(result.ok, false, "accepted what should be refused");
  return result.ok ? "" : result.code;
}

const GAME = '[game]\ntitle = "Pond"\n';
const SIZE = '[game]\ntitle = "Pond"\nworld_size = ';

/** Texts refused, each with its code. */
const wgsl = (file: string, kind = "post") => `${GAME}[[wgsl]]\npath = "${file}"\nkind = "${kind}"\n`;
const hostile: Array<[string, string, string]> = [
  ["not TOML", "[game\ntitle = 1", GenexTomlCode.Syntax],
  ["no [game]", '[gpu]\nnative_features = ["subgroup"]\n', GenexTomlCode.Syntax],
  ["an unknown section (cargo's [package])", `${GAME}[package]\nname = "x"\n`, GenexTomlCode.Syntax],
  ["an unknown key in [game]", `${GAME}build = "build.rs"\n`, GenexTomlCode.Syntax],
  ["a dotted key", `${GAME}crates.noise = "0.9"\n`, GenexTomlCode.Syntax],
  ["an inline-table crate (a path source)", `${GAME}[crates]\nnoise = { path = "/etc" }\n`, GenexTomlCode.Syntax],
  ["a key given twice", `${GAME}title = "Again"\n`, GenexTomlCode.Syntax],
  ["a section given twice", `${GAME}[game]\n`, GenexTomlCode.Syntax],
  ["a multi-line string", '[game]\ntitle = """Pond"""\n', GenexTomlCode.Syntax],
  ["a float size", `${SIZE}[960.5, 540]\n`, GenexTomlCode.Syntax],
  ["a size of one side", `${SIZE}[960]\n`, GenexTomlCode.Syntax],
  ["a title of the wrong type", "[game]\ntitle = 3\n", GenexTomlCode.Syntax],
  ["an unknown WGSL kind", wgsl("a.wgsl", "compute"), GenexTomlCode.Syntax],
  ["[wgsl] as a single table", `${GAME}[wgsl]\npath = "a.wgsl"\nkind = "post"\n`, GenexTomlCode.Syntax],
  ["an empty title", '[game]\ntitle = "  "\n', GenexTomlCode.InvalidTitle],
  ["an overlong title", `[game]\ntitle = "${"x".repeat(81)}"\n`, GenexTomlCode.InvalidTitle],
  ["a world side below 64", `${SIZE}[32, 540]\n`, GenexTomlCode.InvalidWorldSize],
  ["a world side above 4096", `${SIZE}[960, 8192]\n`, GenexTomlCode.InvalidWorldSize],
  // Lane EF: genex's `the_fit_is_letterbox_unless_the_game_says_expand` holds the same rows.
  ["a fit in another case", `${GAME}fit = "Expand"\n`, GenexTomlCode.InvalidFit],
  ["an empty fit", `${GAME}fit = ""\n`, GenexTomlCode.InvalidFit],
  ["a fit outside the vocabulary", `${GAME}fit = "stretch"\n`, GenexTomlCode.InvalidFit],
  ["a fit with a trailing space", `${GAME}fit = "expand "\n`, GenexTomlCode.InvalidFit],
  ["a fit with a NUL", `${GAME}fit = "letterbox\\u0000"\n`, GenexTomlCode.InvalidFit],
  ["a fit that climbs", `${GAME}fit = "../expand"\n`, GenexTomlCode.InvalidFit],
  ["a fit of the wrong type", `${GAME}fit = 1\n`, GenexTomlCode.Syntax],
  ["a fit as an array", `${GAME}fit = ["expand"]\n`, GenexTomlCode.Syntax],
  ["a save name that climbs", `${GAME}save_name = "../x"\n`, GenexTomlCode.InvalidSaveName],
  ["a save name of '..'", `${GAME}save_name = ".."\n`, GenexTomlCode.InvalidSaveName],
  ["a crate off the allowlist", `${GAME}[crates]\nserde = "1"\n`, GenexTomlCode.CrateNotAllowlisted],
  ["a wildcard crate version", `${GAME}[crates]\nnoise = "*"\n`, GenexTomlCode.InvalidCrateVersion],
  [
    "a crate version smuggling TOML",
    `${GAME}[crates]\nnoise = "0.9\\"\\npath = \\"/etc"\n`,
    GenexTomlCode.InvalidCrateVersion,
  ],
  ["a WGSL path with ../", wgsl("../outside.wgsl"), GenexTomlCode.InvalidWgslPath],
  ["a WGSL path climbing midway", wgsl("shaders/../../outside.wgsl"), GenexTomlCode.InvalidWgslPath],
  ["an absolute WGSL path", wgsl("/etc/x.wgsl"), GenexTomlCode.InvalidWgslPath],
  ["a home WGSL path", wgsl("~/x.wgsl"), GenexTomlCode.InvalidWgslPath],
  ["a backslash WGSL path", wgsl("a\\\\b.wgsl"), GenexTomlCode.InvalidWgslPath],
  ["a WGSL path that is not .wgsl", wgsl("a.txt"), GenexTomlCode.InvalidWgslPath],
  [
    "the same WGSL path twice",
    `${wgsl("a.wgsl")}[[wgsl]]\npath = "a.wgsl"\nkind = "pass"\n`,
    GenexTomlCode.DuplicateWgslPath,
  ],
  [
    "an unknown native feature",
    `${GAME}[gpu]\nnative_features = ["ray-tracing"]\n`,
    GenexTomlCode.UnknownNativeFeature,
  ],
  [
    "a native feature twice",
    `${GAME}[gpu]\nnative_features = ["subgroup", "subgroup"]\n`,
    GenexTomlCode.DuplicateNativeFeature,
  ],
];

describe("genex.toml: the schema", () => {
  it("reads the template's manifest once the title is filled", async () => {
    const text = (await readFile(TEMPLATE_MANIFEST, "utf8")).replace("__GAME_TITLE__", "Pond");
    const manifest = accepted(text);
    assert.equal(manifest.title, "Pond");
    assert.deepEqual(manifest.worldSize, [960, 540]);
    assert.equal(manifest.saveName, null);
    assert.deepEqual(manifest.crates, []);
    assert.deepEqual(manifest.wgsl, []);
    assert.deepEqual(manifest.nativeFeatures, []);
    // Release R-2 (owner call E11): the template links only what it uses, so its web build fits
    // 4 MiB; a game that adds walkers, a streamed world or an animated character turns one back on.
    // Gate GR: the starter plays no sound, so audio is off too and the export stays under 90% of 4 MiB.
    assert.deepEqual(
      [manifest.physics, manifest.audio, manifest.nav, manifest.streaming, manifest.animation],
      [true, false, false, false, false],
    );
  });

  it("reads each game system's switch, and a file that names none keeps every system", () => {
    for (const system of ["nav", "streaming", "animation"] as const) {
      const manifest = accepted(`${GAME}[${system}]\nenabled = false\n`);
      assert.equal(manifest[system], false, system);
      const others = (["physics", "audio", "nav", "streaming", "animation"] as const).filter((name) => name !== system);
      for (const other of others) assert.equal(manifest[other], true, `${system}: ${other} stays`);
      assert.equal(accepted(`${GAME}[${system}]\n`)[system], true, `an empty [${system}] keeps it`);
    }
    const bare = accepted(GAME);
    assert.deepEqual([bare.nav, bare.streaming, bare.animation], [true, true, true]);
  });

  it("reads every section of the documented example", () => {
    const manifest = accepted(
      [
        "[game]",
        'title = "Pond"            # required',
        "world_size = [1280, 720]",
        "save_name = 'pond save'",
        "",
        "[crates]",
        'noise = "0.9"',
        'fastrand = "=2.5.0"',
        "",
        "[[wgsl]]",
        'path = "shaders/water.wgsl"',
        'kind = "material"',
        "",
        "[[wgsl]]",
        'path = "shaders/bloom.wgsl"',
        'kind = "post"',
        "",
        "[gpu]",
        "native_features = [",
        '  "subgroup",  # comments inside an array',
        '  "ray-query",',
        "]",
      ].join("\r\n"),
    );
    assert.deepEqual(manifest.worldSize, [1280, 720]);
    assert.equal(manifest.saveName, "pond save");
    assert.deepEqual(manifest.crates, [
      { name: "fastrand", version: "=2.5.0" },
      { name: "noise", version: "0.9" },
    ]);
    // Flipped (RQ0.0): each source carries its extension API, 1 when the row names none.
    assert.deepEqual(manifest.wgsl, [
      { path: "shaders/water.wgsl", kind: WgslKind.Material, api: 1 },
      { path: "shaders/bloom.wgsl", kind: WgslKind.Post, api: 1 },
    ]);
    assert.deepEqual(manifest.nativeFeatures, [NativeEnhancedFeature.Subgroup, NativeEnhancedFeature.RayQuery]);
  });

  it("accepts an approved crate's exact pin as request and approval take it, pre-releases and long parts included", () => {
    for (const version of ["=1.0.0", "=1.0.0-beta.1", "=1234567.0.1", "=0.3.0-rc.2"]) {
      const manifest = accepted(`${GAME}[crates]\ntidy = "${version}"\n`);
      assert.deepEqual(manifest.crates.find((crate) => crate.name === "tidy")?.version, version);
    }
    // Only an exact pin of an approvable name: a loose or hostile one is still refused.
    for (const version of ["1.0.0-beta.1", "=1.0", "=1.0.0-beta.1;x", "^1.0.0-beta.1"]) {
      const result = parseGenexToml(`${GAME}[crates]\ntidy = "${version}"\n`);
      assert.equal(result.ok, false, version);
    }
  });

  it("reads [game] fit as written, letterbox when the file names none", () => {
    assert.equal(accepted(GAME).fit, null);
    assert.equal(accepted(`${GAME}fit = "letterbox"\n`).fit, GameFit.Letterbox);
    assert.equal(accepted(`${GAME}fit = "expand"\n`).fit, GameFit.Expand);
  });

  it("decodes string escapes and keeps the allowlist the runtime keeps", () => {
    assert.equal(accepted('[game]\ntitle = "Pond \\u00e9 \\"deep\\""\n').title, 'Pond é "deep"');
    assert.deepEqual([...GAME_CRATE_ALLOWLIST].sort(), ["fastrand", "noise", "pathfinding"]);
  });

  // Release R-2 (owner call 8): one allowlist, held by both sides to one fixture (genex's
  // `manifest.rs` reads it in `crates/genex/tests/manifest.rs`).
  it("holds the allowlist to the fixture genex's manifest holds too", () => {
    assert.deepEqual([...GAME_CRATE_ALLOWLIST], CRATE_ALLOWLIST.crates);
  });

  it("admits pathfinding at a version requirement without a person's approval, like noise", () => {
    const manifest = accepted(`${GAME}[crates]\npathfinding = "4.16"\n`);
    assert.deepEqual(manifest.crates, [{ name: "pathfinding", version: "4.16" }]);
  });

  for (const [name, text, code] of hostile) {
    it(`refuses ${name} with ${code}`, () => {
      assert.equal(refusedCode(parseGenexToml(text)), code);
    });
  }
});

/** A `[[texture]]` row (C-10): a loose texture's usage, for what no material slot can tell. */
const textureRow = (file: string, usage: string) => `[[texture]]\npath = "${file}"\nusage = "${usage}"\n`;

describe("genex.toml: [[texture]] rows declare a loose texture's usage (C-10)", () => {
  it("reads each row as a path under assets/ and a usage, in file order, and none when the file has none", () => {
    const manifest = accepted(
      `${GAME}${textureRow("textures/flow.png", "data")}${textureRow("ui/badge.webp", "color")}${textureRow("rock_n.jpg", "normal")}`,
    );
    assert.deepEqual(manifest.textures, [
      { path: "textures/flow.png", usage: TextureUsage.Data },
      { path: "ui/badge.webp", usage: TextureUsage.Color },
      { path: "rock_n.jpg", usage: TextureUsage.Normal },
    ]);
    assert.deepEqual(accepted(GAME).textures, []);
  });

  const refused: Array<[string, string, string]> = [
    ["a usage outside color, data and normal", textureRow("bark.png", "albedo"), GenexTomlCode.InvalidTextureUsage],
    ["a usage in another case", textureRow("bark.png", "Normal"), GenexTomlCode.InvalidTextureUsage],
    ["an empty usage", textureRow("bark.png", ""), GenexTomlCode.InvalidTextureUsage],
    ["a path that climbs out of assets/", textureRow("../index.png", "color"), GenexTomlCode.InvalidTextureUsage],
    ["a path climbing midway", textureRow("a/../../b.png", "color"), GenexTomlCode.InvalidTextureUsage],
    ["an absolute path", textureRow("/etc/x.png", "color"), GenexTomlCode.InvalidTextureUsage],
    ["a backslash path", textureRow("a\\\\b.png", "color"), GenexTomlCode.InvalidTextureUsage],
    ["a path with an empty segment", textureRow("a//b.png", "color"), GenexTomlCode.InvalidTextureUsage],
    ["a texture already encoded (KTX2)", textureRow("bark.ktx2", "color"), GenexTomlCode.InvalidTextureUsage],
    ["a path that is not an image", textureRow("notes.txt", "data"), GenexTomlCode.InvalidTextureUsage],
    [
      "the same path twice, even with one usage",
      `${textureRow("bark.png", "color")}${textureRow("bark.png", "color")}`,
      GenexTomlCode.InvalidTextureUsage,
    ],
    ["a row without a usage", '[[texture]]\npath = "bark.png"\n', GenexTomlCode.Syntax],
    ["a row without a path", '[[texture]]\nusage = "color"\n', GenexTomlCode.Syntax],
    ["a usage of the wrong type", '[[texture]]\npath = "bark.png"\nusage = 1\n', GenexTomlCode.Syntax],
    ["an unknown key in a row", `${textureRow("bark.png", "color")}srgb = true\n`, GenexTomlCode.Syntax],
    ["[texture] as a single table", '[texture]\npath = "bark.png"\nusage = "color"\n', GenexTomlCode.Syntax],
  ];
  for (const [name, row, code] of refused) {
    it(`refuses ${name} with ${code}`, () => {
      assert.equal(refusedCode(parseGenexToml(`${GAME}${row}`)), code);
    });
  }
});

/** An `[[asset_group]]` row (C-30): a named set of assets a game loads during play. */
const groupRow = (name: string, paths: readonly string[]) =>
  `[[asset_group]]\nname = "${name}"\npaths = [${paths.map((rel) => JSON.stringify(rel)).join(", ")}]\n`;

/** `[[asset_group]]` rows refused, each with its code. */
const REFUSED_GROUPS: Array<[string, string, string]> = [
  ["a path that climbs out of assets/", groupRow("g", ["../src/main.rs"]), GenexTomlCode.InvalidAssetGroup],
  ["a path climbing midway", groupRow("g", ["a/../../b.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a glob climbing out", groupRow("g", ["**/../x"]), GenexTomlCode.InvalidAssetGroup],
  ["an absolute path", groupRow("g", ["/etc/passwd"]), GenexTomlCode.InvalidAssetGroup],
  ["a backslash path", groupRow("g", ["a\\\\b.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a drive letter", groupRow("g", ["C:/x.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["an empty segment", groupRow("g", ["a//b.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a dot segment", groupRow("g", ["./b.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["an empty path", groupRow("g", [""]), GenexTomlCode.InvalidAssetGroup],
  ["a bracket class", groupRow("g", ["props/[ab].glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a brace set", groupRow("g", ["props/{a,b}.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["** inside a segment", groupRow("g", ["props/a**.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a Windows device name", groupRow("g", ["props/con.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["the reserved name boot", groupRow("boot", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["the reserved name sim", groupRow("sim", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["the reserved name stream", groupRow("stream", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a reserved name in another case", groupRow("Boot", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["an empty name", groupRow("", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a name with a slash", groupRow("a/b", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a name with a space", groupRow("a b", ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a name over 64 characters", groupRow("g".repeat(65), ["a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["a group with no paths", groupRow("g", []), GenexTomlCode.InvalidAssetGroup],
  ["one glob twice in a group", groupRow("g", ["a.glb", "a.glb"]), GenexTomlCode.InvalidAssetGroup],
  ["one name twice", `${groupRow("g", ["a.glb"])}${groupRow("g", ["b.glb"])}`, GenexTomlCode.InvalidAssetGroup],
  [
    "more paths than a group holds",
    groupRow(
      "g",
      Array.from({ length: 257 }, (_, at) => `p${at}.glb`),
    ),
    GenexTomlCode.InvalidAssetGroup,
  ],
  [
    "more groups than a game holds",
    Array.from({ length: 65 }, (_, at) => groupRow(`g${at}`, ["a.glb"])).join(""),
    GenexTomlCode.InvalidAssetGroup,
  ],
  ["a row without paths", '[[asset_group]]\nname = "g"\n', GenexTomlCode.Syntax],
  ["a row without a name", '[[asset_group]]\npaths = ["a.glb"]\n', GenexTomlCode.Syntax],
  ["paths as one string", '[[asset_group]]\nname = "g"\npaths = "a.glb"\n', GenexTomlCode.Syntax],
  ["a path that is not a string", '[[asset_group]]\nname = "g"\npaths = [1]\n', GenexTomlCode.Syntax],
  ["an unknown key in a row", `${groupRow("g", ["a.glb"])}boot = true\n`, GenexTomlCode.Syntax],
  ["[asset_group] as a single table", '[asset_group]\nname = "g"\npaths = ["a.glb"]\n', GenexTomlCode.Syntax],
];

describe("genex.toml: [[asset_group]] rows name groups of assets loaded during play (C-30)", () => {
  it("reads each group's name and globs under assets/, in file order, and none when the file has none", () => {
    const manifest = accepted(
      `${GAME}${groupRow("castle", ["interiors/castle/**", "props/throne.glb"])}${groupRow("crypt", ["interiors/crypt/*.glb"])}`,
    );
    assert.deepEqual(manifest.assetGroups, [
      { name: "castle", paths: ["interiors/castle/**", "props/throne.glb"] },
      { name: "crypt", paths: ["interiors/crypt/*.glb"] },
    ]);
    assert.deepEqual(accepted(GAME).assetGroups, []);
  });

  it("allows one path in two groups: each group lists it", () => {
    const manifest = accepted(`${GAME}${groupRow("a", ["props/door.glb"])}${groupRow("b", ["props/*.glb"])}`);
    assert.deepEqual(
      manifest.assetGroups?.map((group) => [group.name, assetGroupMatches(group, "props/door.glb")]),
      [
        ["a", true],
        ["b", true],
      ],
    );
  });

  const matches: Array<[string, string, boolean]> = [
    ["props/*.glb", "props/door.glb", true],
    ["props/*.glb", "props/sub/door.glb", false],
    ["props/*.glb", "props/door.png", false],
    ["props/d??r.glb", "props/door.glb", true],
    ["props/d?r.glb", "props/door.glb", false],
    ["interiors/**", "interiors/castle/hall.glb", true],
    ["interiors/**", "interiors/a.glb", true],
    ["interiors/**", "interiors", false],
    ["interiors/**/hall.glb", "interiors/hall.glb", true],
    ["interiors/**/hall.glb", "interiors/castle/east/hall.glb", true],
    ["interiors/**/hall.glb", "interiors/castle/hallway.glb", false],
    ["**", "anything/at/all.bin", true],
    ["a.b", "aXb", false],
    ["Props/door.glb", "props/door.glb", false],
  ];
  for (const [glob, rel, expected] of matches) {
    it(`matches ${glob} against ${rel}: ${expected}`, () => {
      assert.equal(assetGroupMatches({ name: "g", paths: [glob] }, rel), expected);
    });
  }

  for (const [name, row, code] of REFUSED_GROUPS) {
    it(`refuses ${name} with ${code}`, () => {
      assert.equal(refusedCode(parseGenexToml(`${GAME}${row}`)), code);
    });
  }
});

const MIB = 1024 * 1024;
const assetsRow = (lines: string) => `${GAME}[assets]\n${lines}`;
const destinationRow = (destination: string, lines: string) => `${GAME}[assets.${destination}]\n${lines}`;

/** `[assets]` texts refused, each with its code (C-17). */
const REFUSED_ASSETS: Array<[string, string, string]> = [
  ["a budget of 0 MB", assetsRow("budget_mb = 0\n"), GenexTomlCode.AssetBudgetOutOfRange],
  ["a negative budget", assetsRow("budget_mb = -5\n"), GenexTomlCode.AssetBudgetOutOfRange],
  ["a budget past any destination's bound", assetsRow("budget_mb = 65537\n"), GenexTomlCode.AssetBudgetOutOfRange],
  [
    "a web budget past the 512 MB shell cap",
    destinationRow("web", "budget_mb = 513\n"),
    GenexTomlCode.AssetBudgetOutOfRange,
  ],
  ["an iOS budget past 4096 MB", destinationRow("ios", "budget_mb = 4097\n"), GenexTomlCode.AssetBudgetOutOfRange],
  [
    "an Android budget past 4096 MB",
    destinationRow("android", "budget_mb = 4097\n"),
    GenexTomlCode.AssetBudgetOutOfRange,
  ],
  ["a desktop budget of 0 MB", destinationRow("desktop", "budget_mb = 0\n"), GenexTomlCode.AssetBudgetOutOfRange],
  [
    "a texture cap that is no power of two",
    assetsRow("phone_max_texture_px = 1000\n"),
    GenexTomlCode.InvalidTextureCap,
  ],
  ["a texture cap below 512", assetsRow("phone_max_texture_px = 256\n"), GenexTomlCode.InvalidTextureCap],
  ["a texture cap above 4096", assetsRow("phone_max_texture_px = 8192\n"), GenexTomlCode.InvalidTextureCap],
  ["a float budget", assetsRow("budget_mb = 64.5\n"), GenexTomlCode.Syntax],
  ["a string budget", assetsRow('budget_mb = "64"\n'), GenexTomlCode.Syntax],
  ["an unknown [assets] key", assetsRow("max_files = 9\n"), GenexTomlCode.Syntax],
  ["an unknown destination", destinationRow("switch", "budget_mb = 9\n"), GenexTomlCode.Syntax],
  ["a destination per OS (mac is desktop)", destinationRow("mac", "budget_mb = 9\n"), GenexTomlCode.Syntax],
  ["a texture cap per destination", destinationRow("ios", "phone_max_texture_px = 1024\n"), GenexTomlCode.Syntax],
  ["[assets] as an array", `${GAME}[[assets]]\nbudget_mb = 9\n`, GenexTomlCode.Syntax],
];

// Owner call C8: web 64 MB, iOS 200 MB, Android 200 MB, desktop 2 GB; an export past its budget warns
// (`assets-over-budget`) and only a hard cap refuses (`assets-over-ceiling`): the web shell's 512 MB.
describe("genex.toml: [assets] budgets per destination (C-17, owner call C8)", () => {
  it("reads [assets] budget_mb and phone_max_texture_px, and each [assets.<destination>] budget_mb", () => {
    const manifest = accepted(
      `${GAME}[assets]\nbudget_mb = 300\nphone_max_texture_px = 1024\n\n[assets.web]\nbudget_mb = 48\n\n[assets.desktop]\nbudget_mb = 4096\n`,
    );
    assert.deepEqual(manifest.assets, {
      budgetMb: 300,
      phoneMaxTexturePx: 1024,
      destinations: { web: 48, desktop: 4096 },
    });
  });

  it("names no budgets when the file has no [assets], and none of a key the table leaves out", () => {
    assert.equal(accepted(GAME).assets, null);
    assert.deepEqual(accepted(`${GAME}[assets]\n`).assets, {
      budgetMb: null,
      phoneMaxTexturePx: null,
      destinations: {},
    });
    assert.deepEqual(accepted(destinationRow("ios", "budget_mb = 150\n")).assets, {
      budgetMb: null,
      phoneMaxTexturePx: null,
      destinations: { ios: 150 },
    });
  });

  const defaults: Array<[BuildTarget, number, number | null]> = [
    [BuildTarget.Web, 64, 512],
    [BuildTarget.Ios, 200, 4096],
    [BuildTarget.Android, 200, 4096],
    [BuildTarget.Mac, 2048, null],
    [BuildTarget.Windows, 2048, null],
    [BuildTarget.Linux, 2048, null],
  ];
  for (const [target, budgetMb, ceilingMb] of defaults) {
    it(`a game that names no budget gets ${budgetMb} MB on ${target}, ceiling ${ceilingMb ?? "none"}`, () => {
      assert.deepEqual(assetBudgetOf(null, target), {
        budgetBytes: budgetMb * MIB,
        ceilingBytes: ceilingMb === null ? null : ceilingMb * MIB,
      });
      assert.deepEqual(assetBudgetOf(accepted(GAME).assets, target), assetBudgetOf(null, target));
    });
  }

  it("a destination's own budget beats [assets] budget_mb, which beats the default", () => {
    const { assets } = accepted(`${GAME}[assets]\nbudget_mb = 300\n\n[assets.ios]\nbudget_mb = 150\n`);
    assert.equal(assetBudgetOf(assets, BuildTarget.Ios).budgetBytes, 150 * MIB);
    assert.equal(assetBudgetOf(assets, BuildTarget.Android).budgetBytes, 300 * MIB);
    assert.equal(assetBudgetOf(assets, BuildTarget.Linux).budgetBytes, 300 * MIB);
    assert.equal(assetBudgetOf(assets, BuildTarget.Web).budgetBytes, 300 * MIB);
  });

  it("an [assets] budget_mb above a destination's hard cap is that cap there, never past it", () => {
    const { assets } = accepted(assetsRow("budget_mb = 8000\n"));
    assert.deepEqual(assetBudgetOf(assets, BuildTarget.Web), { budgetBytes: 512 * MIB, ceilingBytes: 512 * MIB });
    assert.deepEqual(assetBudgetOf(assets, BuildTarget.Ios), {
      budgetBytes: 4096 * MIB,
      ceilingBytes: 4096 * MIB,
    });
    assert.deepEqual(assetBudgetOf(assets, BuildTarget.Mac), { budgetBytes: 8000 * MIB, ceilingBytes: null });
  });

  it("admits each budget at its bounds: 1 MB, the web shell's 512 MB, the phones' 4096 MB", () => {
    for (const text of [
      assetsRow("budget_mb = 1\n"),
      destinationRow("web", "budget_mb = 512\n"),
      destinationRow("ios", "budget_mb = 4096\n"),
      destinationRow("android", "budget_mb = 4096\n"),
      assetsRow("phone_max_texture_px = 512\n"),
      assetsRow("phone_max_texture_px = 4096\n"),
    ]) {
      accepted(text);
    }
  });

  for (const [name, text, code] of REFUSED_ASSETS) {
    it(`refuses ${name} with ${code}`, () => {
      assert.equal(refusedCode(parseGenexToml(text)), code);
    });
  }
});

describe("genex.toml: the [render] table and [[wgsl]] api (rows shared with manifest.rs)", () => {
  for (const row of RENDER_ROWS.accepted) {
    it(`accepts ${row.name}`, () => {
      accepted(`${RENDER_ROWS.game}${row.text}`);
    });
  }

  for (const row of RENDER_ROWS.hostile) {
    it(`refuses ${row.name} with ${row.code}`, () => {
      assert.equal(refusedCode(parseGenexToml(`${RENDER_ROWS.game}${row.text}`)), row.code);
    });
  }

  it("reads the documented table into the game's look and its per-class quality", () => {
    const documented = RENDER_ROWS.accepted[0];
    assert.ok(documented);
    const manifest = accepted(`${RENDER_ROWS.game}${documented.text}`);
    assert.deepEqual(manifest.render, {
      formFactors: [FormFactor.Desktop, FormFactor.Mobile],
      preset: QualityPreset.Auto,
      look: {
        tonemapper: Tonemapper.Agx,
        exposure: ExposureMode.Auto,
        metering: Metering.Center,
        evCompensation: -0.5,
        bloomIntensity: 0.04,
      },
      classes: {
        [DeviceClass.MobileMid]: {
          preset: QualityPreset.Low,
          renderScale: 0.67,
          fps: 30,
          features: { [RenderFeature.Bloom]: false, [RenderFeature.Ao]: false },
        },
        [DeviceClass.DesktopUltra]: { features: { [RenderFeature.Taa]: true, [RenderFeature.ContactShadows]: true } },
      },
    });
  });

  it("a manifest without [render] has none, and a sub-table may come before its table", () => {
    assert.equal(accepted(RENDER_ROWS.game).render, null);
    const late = accepted(`${RENDER_ROWS.game}[render.look]\ntonemapper = "none"\n\n[render]\npreset = "low"\n`);
    assert.deepEqual(late.render, {
      formFactors: [],
      preset: QualityPreset.Low,
      look: { tonemapper: Tonemapper.None },
      classes: {},
    });
  });

  // Owner decision 2026-10-11: a browser game names its own code budget; a manifest that names none
  // gets the default, and only a whole number from the minimum to the 32 MB ceiling is a budget.
  it("reads [web] wasm_budget_mb as the game's web budget, null when it names none", () => {
    assert.equal(accepted(`${RENDER_ROWS.game}[web]\nwasm_budget_mb = 12\n`).wasmBudgetMb, 12);
    assert.equal(accepted(`${RENDER_ROWS.game}[web]\n`).wasmBudgetMb, null);
    assert.equal(accepted(RENDER_ROWS.game).wasmBudgetMb, null);
    assert.equal(
      refusedCode(parseGenexToml(`${RENDER_ROWS.game}[web]\nwasm_budget_mb = ${WEB_WASM_CEILING_MB + 1}\n`)),
      GenexTomlCode.InvalidWebBudget,
    );
  });

  it("admits a WGSL api up to the host's extension API and refuses the rest", () => {
    for (const api of WGSL_EXTENSION_APIS) {
      const result = parseGenexToml(`${RENDER_ROWS.game}[[wgsl]]\npath = "a.wgsl"\nkind = "post"\napi = ${api}\n`);
      const admitted = api <= NATIVE_EXTENSION_API_VERSION;
      assert.equal(result.ok, admitted, `api ${api}`);
      if (!result.ok) assert.equal(result.code, GenexTomlCode.ExtensionApiUnavailable);
    }
  });

  it("admits [[wgsl]] api 2 now that the renderer serves it, and refuses api 3 as unknown", () => {
    const row = (api: number) => `${RENDER_ROWS.game}[[wgsl]]\npath = "a.wgsl"\nkind = "material"\napi = ${api}\n`;
    const two = parseGenexToml(row(2));
    assert.ok(two.ok, "api 2");
    assert.equal(two.manifest.wgsl[0]?.api, 2);
    assert.equal(refusedCode(parseGenexToml(row(3))), GenexTomlCode.UnknownExtensionApi);
  });

  it("reads auto exposure's limits and speeds into the look and writes them back into the fragment", () => {
    const text = `${RENDER_ROWS.game}[render.look]\nexposure = "auto"\nev_min = -6\nev_max = 8.5\nadaptation_speed_up = 3\nadaptation_speed_down = 1\n`;
    const manifest = accepted(text);
    assert.deepEqual(manifest.render?.look, {
      exposure: ExposureMode.Auto,
      evMin: -6,
      evMax: 8.5,
      adaptationSpeedUp: 3,
      adaptationSpeedDown: 1,
    });
    assert.ok(manifest.render);
    const back = accepted(`${RENDER_ROWS.game}${renderTomlFragment(manifest.render)}`);
    assert.deepEqual(back.render, manifest.render, "the fragment reads back as the same look");
  });

  it("reads the RQ4 look (bloom, GTAO, fog, contact shadows) into the look and writes it back into the fragment", () => {
    const look = [
      "[render.look]",
      "bloom_threshold = 1.5",
      "bloom_radius = 2",
      "ao_intensity = 0.8",
      "ao_radius = 0.75",
      "fog_density = 0.02",
      "fog_height_falloff = 0.3",
      "fog_base_height = -4",
      "fog_start = 10",
      "fog_max_opacity = 0.9",
      "fog_color = [0.8, 0.85, 1.0]",
      "fog_aerial_perspective = false",
      "contact_shadow_length = 0.4",
    ].join("\n");
    const manifest = accepted(`${RENDER_ROWS.game}${look}\n`);
    assert.deepEqual(manifest.render?.look, {
      bloomThreshold: 1.5,
      bloomRadius: 2,
      aoIntensity: 0.8,
      aoRadius: 0.75,
      fogDensity: 0.02,
      fogHeightFalloff: 0.3,
      fogBaseHeight: -4,
      fogStart: 10,
      fogMaxOpacity: 0.9,
      fogColor: [0.8, 0.85, 1],
      fogAerialPerspective: false,
      contactShadowLength: 0.4,
    });
    assert.ok(manifest.render);
    const back = accepted(`${RENDER_ROWS.game}${renderTomlFragment(manifest.render)}`);
    assert.deepEqual(back.render, manifest.render, "the fragment reads back as the same look");
  });

  it("reads a class table's LOD keys and switches (LOD-06) and writes them back into the fragment the facade reads", () => {
    const table =
      "[render.class.mobile-mid]\nlod_threshold_px = 3\nlod_fade_band = 0\nfar_density = 0.5\nlod-fade = false\nimpostors = true\n";
    const manifest = accepted(`${RENDER_ROWS.game}${table}`);
    assert.deepEqual(manifest.render?.classes, {
      [DeviceClass.MobileMid]: {
        lodThresholdPx: 3,
        lodFadeBand: 0,
        farDensity: 0.5,
        features: { [RenderFeature.LodFade]: false, [RenderFeature.Impostors]: true },
      },
    });
    assert.ok(manifest.render);
    const fragment = renderTomlFragment(manifest.render);
    assert.match(fragment, /^lod_threshold_px = 3\.0$/m, "a whole threshold stays a float");
    const back = accepted(`${RENDER_ROWS.game}${fragment}`);
    assert.deepEqual(back.render, manifest.render, "the fragment reads back as the same LOD choices");
  });

  const rq4Hostile: ReadonlyArray<readonly [string, string]> = [
    ["a negative bloom threshold", "bloom_threshold = -1"],
    ["a bloom threshold past its limit", `bloom_threshold = ${BLOOM_THRESHOLD_MAX + 1}`],
    ["a bloom radius under its floor", `bloom_radius = ${BLOOM_RADIUS_MIN / 2}`],
    ["a bloom radius past its limit", `bloom_radius = ${BLOOM_RADIUS_MAX + 1}`],
    ["an AO intensity past 1", `ao_intensity = ${AO_INTENSITY_MAX + 0.5}`],
    ["a zero AO radius", "ao_radius = 0"],
    ["an AO radius past its limit", `ao_radius = ${AO_RADIUS_MAX + 1}`],
    ["a negative fog density", "fog_density = -0.1"],
    ["a fog density past its limit", `fog_density = ${FOG_DENSITY_MAX + 1}`],
    ["a negative fog height falloff", "fog_height_falloff = -1"],
    ["a fog base height past its limit", `fog_base_height = ${-FOG_DISTANCE_LIMIT - 1}`],
    ["a negative fog start", "fog_start = -1"],
    ["a fog opacity past 1", "fog_max_opacity = 1.5"],
    ["a fog colour of two channels", "fog_color = [1.0, 1.0]"],
    ["a fog colour channel past its limit", `fog_color = [1.0, ${FOG_COLOR_MAX + 1}, 1.0]`],
    ["a negative fog colour channel", "fog_color = [1.0, -0.5, 1.0]"],
    ["a zero contact-shadow length", "contact_shadow_length = 0"],
    ["a contact-shadow length past its limit", `contact_shadow_length = ${CONTACT_SHADOW_LENGTH_MAX + 1}`],
  ];
  for (const [name, line] of rq4Hostile) {
    it(`refuses ${name} with invalid-render-look`, () => {
      const result = parseGenexToml(`${RENDER_ROWS.game}[render.look]\n${line}\n`);
      assert.equal(refusedCode(result), GenexTomlCode.InvalidRenderLook);
    });
  }

  it("refuses an RQ4 look key of the wrong type as a malformed file", () => {
    for (const line of [
      'fog_aerial_perspective = "yes"',
      'fog_color = "white"',
      'fog_color = [1, "a", 1]',
      'ao_radius = "far"',
    ]) {
      const result = parseGenexToml(`${RENDER_ROWS.game}[render.look]\n${line}\n`);
      assert.equal(result.ok, false, line);
    }
  });

  it("compiles the documented table and its [[wgsl]] rows into the fragments the facade reads (GENEX_RENDER_TOML, GENEX_WGSL_TOML)", () => {
    const documented = RENDER_ROWS.accepted[0];
    assert.ok(documented);
    const manifest = accepted(`${RENDER_ROWS.game}${documented.text}${RENDER_ROWS.fragments.wgslRows}`);
    assert.ok(manifest.render);
    assert.equal(renderTomlFragment(manifest.render), RENDER_ROWS.fragments.render);
    assert.equal(wgslTomlFragment(manifest.wgsl), RENDER_ROWS.fragments.wgsl);
    assert.equal(wgslTomlFragment([]), "", "a game without rows compiles in an empty table set");
    const back = accepted(`${RENDER_ROWS.game}${RENDER_ROWS.fragments.render}${RENDER_ROWS.fragments.wgsl}`);
    assert.deepEqual(back.render, manifest.render, "the fragment reads back as the same [render]");
    assert.deepEqual(back.wgsl, manifest.wgsl, "and the same [[wgsl]] rows");
    const whole = accepted(`${RENDER_ROWS.game}[render.class.desktop-low]\nrender_scale = 1\n`);
    assert.ok(whole.render);
    assert.match(renderTomlFragment(whole.render), /^render_scale = 1\.0$/m, "a whole scale stays a float");
  });

  it("keeps a [render] table through an eject and an un-eject, byte for byte", () => {
    const documented = RENDER_ROWS.accepted[0];
    assert.ok(documented);
    const text = `${RENDER_ROWS.game}${documented.text}`;
    const ejected = withEngineRow(text, "0.1.0");
    assert.ok(ejected.ok);
    assert.deepEqual(ejected.manifest.render, accepted(text).render);
    const back = withEngineRow(ejected.text, null);
    assert.ok(back.ok);
    assert.equal(back.text, text);
  });
});

describe("genex.toml: the render vocabulary is the wire's", () => {
  it("names every value the wire fixture names, in its order", () => {
    const values = (vocabulary: Record<string, string>) => Object.values(vocabulary);
    assert.deepEqual(values(QualityPreset), WIRE_RENDER.presets);
    assert.deepEqual(values(FormFactor), WIRE_RENDER.formFactors);
    assert.deepEqual(values(PerformanceTier), WIRE_RENDER.tiers);
    assert.deepEqual(values(DeviceClass), WIRE_RENDER.deviceClasses);
    assert.deepEqual(values(RenderFeature), WIRE_RENDER.features);
    assert.deepEqual(values(DegradeReason), WIRE_RENDER.degradeReasons);
    assert.deepEqual(values(Tonemapper), WIRE_RENDER.tonemappers);
    assert.deepEqual(values(ExposureMode), WIRE_RENDER.exposureModes);
    assert.deepEqual(values(Metering), WIRE_RENDER.metering);
    assert.deepEqual(values(LookKey), WIRE_RENDER.lookKeys);
    assert.deepEqual(values(QualityKey), WIRE_RENDER.qualityKeys);
    assert.deepEqual(values(RenderTomlKey), WIRE_RENDER.renderKeys);
    assert.deepEqual(values(ShadowTomlKey), WIRE_RENDER.shadowKeys);
    assert.deepEqual({ min: SHADOW_DISTANCE_MIN, max: SHADOW_DISTANCE_MAX }, WIRE_RENDER.shadowDistance);
    assert.equal(SHADOW_BLEND_BAND_MAX, WIRE_RENDER.shadowBlendBandMax);
    assert.deepEqual({ min: LOD_THRESHOLD_PX_MIN, max: LOD_THRESHOLD_PX_MAX }, WIRE_RENDER.lodThresholdPx);
    assert.equal(LOD_FADE_BAND_MAX, WIRE_RENDER.lodFadeBandMax);
    assert.equal(FAR_DENSITY_MIN, WIRE_RENDER.farDensityMin);
    assert.deepEqual(values(SettingsSource), WIRE_RENDER.settingsSources);
    assert.deepEqual(values(CaptureExposure), WIRE_RENDER.captureExposure);
    assert.deepEqual(values(RendererFeature), WIRE_RENDER.rendererFeatures);
    assert.deepEqual(values(RenderInput), WIRE_RENDER.renderInputs);
    assert.deepEqual(values(PostPassStage), WIRE_RENDER.postPassStages);
    assert.deepEqual(values(RenderSettingsRefusal), WIRE_RENDER.settingsRefusals);
    assert.deepEqual({ min: RENDER_SCALE_MIN, max: RENDER_SCALE_MAX }, WIRE_RENDER.renderScale);
    assert.deepEqual({ min: FRAME_BUDGET_MS_MIN, max: FRAME_BUDGET_MS_MAX }, WIRE_RENDER.frameBudgetMs);
    assert.deepEqual(RENDER_FPS_TARGETS, WIRE_RENDER.fpsTargets);
    assert.equal(EV_COMPENSATION_LIMIT, WIRE_RENDER.evCompensationLimit);
    assert.equal(BLOOM_INTENSITY_MAX, WIRE_RENDER.bloomIntensityMax);
    assert.equal(EXPOSURE_EV_LIMIT, WIRE_RENDER.exposureEvLimit);
    assert.equal(ADAPTATION_SPEED_MAX, WIRE_RENDER.adaptationSpeedMax);
    assert.equal(BLOOM_THRESHOLD_MAX, WIRE_RENDER.bloomThresholdMax);
    assert.deepEqual({ min: BLOOM_RADIUS_MIN, max: BLOOM_RADIUS_MAX }, WIRE_RENDER.bloomRadius);
    assert.equal(AO_INTENSITY_MAX, WIRE_RENDER.aoIntensityMax);
    assert.equal(AO_RADIUS_MAX, WIRE_RENDER.aoRadiusMax);
    assert.equal(FOG_DENSITY_MAX, WIRE_RENDER.fogDensityMax);
    assert.equal(FOG_HEIGHT_FALLOFF_MAX, WIRE_RENDER.fogHeightFalloffMax);
    assert.equal(FOG_DISTANCE_LIMIT, WIRE_RENDER.fogDistanceLimit);
    assert.equal(FOG_COLOR_MAX, WIRE_RENDER.fogColorMax);
    assert.equal(CONTACT_SHADOW_LENGTH_MAX, WIRE_RENDER.contactShadowLengthMax);
    assert.deepEqual(WGSL_EXTENSION_APIS, WIRE_RENDER.wgslApis);
    assert.equal(CAPTURE_SETTLE_FRAMES_MAX, WIRE_RENDER.captureSettleFramesMax);
  });

  it("every device class is a form factor and a tier, and the class keys of genex.toml are its values", () => {
    const forms = new Set<string>(Object.values(FormFactor));
    const tiers = new Set<string>(Object.values(PerformanceTier));
    for (const name of Object.values(DeviceClass)) {
      const [form, tier, ...rest] = name.split("-");
      assert.ok(forms.has(form ?? "") && tiers.has(tier ?? "") && rest.length === 0, name);
    }
  });
});

describe("genex.toml: native-enhanced features per destination", () => {
  it("refuses a web build of a game that declares any native feature, and only that", () => {
    const native = accepted(`${GAME}[gpu]\nnative_features = ["mesh-shader"]\n`);
    const core = accepted(GAME);
    assert.equal(refusedCode(checkTargetFeatures(native, BuildTarget.Web)), NativeRefusal.NativeFeaturesWeb);
    assert.equal(checkTargetFeatures(native, BuildTarget.Mac).ok, true);
    assert.equal(checkTargetFeatures(core, BuildTarget.Web).ok, true);
  });
});

describe("genex.toml: reading the file and its WGSL sources", () => {
  it("reads only a plain genex.toml, never one through a link", async () => {
    const dir = await tmpDir("genex-toml-");
    const outside = path.join(dir, "outside.toml");
    await writeFile(outside, GAME);
    const linked = path.join(dir, "linked");
    await mkdir(linked);
    await symlink(outside, path.join(linked, "genex.toml"));
    assert.equal(refusedCode(await readGenexToml(linked)), GenexTomlCode.Unreadable);
    assert.equal(refusedCode(await readGenexToml(path.join(dir, "missing"))), GenexTomlCode.Unreadable);
    const plain = path.join(dir, "plain");
    await mkdir(plain);
    await writeFile(path.join(plain, "genex.toml"), GAME);
    assert.equal((await readGenexToml(plain)).ok, true);
  });

  /** The WGSL check of a folder holding `shaders/` as `prepare` leaves it, for a manifest naming `shaders/water.wgsl`. */
  async function wgslGame(prepare: (root: string) => Promise<void>) {
    const root = await tmpDir("genex-wgsl-");
    await mkdir(path.join(root, "shaders"));
    await prepare(root);
    const manifest = accepted(`${GAME}[[wgsl]]\npath = "shaders/water.wgsl"\nkind = "material"\n`);
    return checkWgslFiles(root, manifest);
  }

  it("accepts a regular WGSL file inside the folder", async () => {
    const result = await wgslGame((root) => writeFile(path.join(root, "shaders", "water.wgsl"), "fn f() {}\n"));
    assert.equal(result.ok, true);
  });

  const rows: Array<[string, (root: string) => Promise<void>, string]> = [
    [
      "a symlinked WGSL file",
      async (root) => {
        await writeFile(path.join(root, "real.wgsl"), "fn f() {}\n");
        await symlink(path.join(root, "real.wgsl"), path.join(root, "shaders", "water.wgsl"));
      },
      GenexTomlCode.WgslLinked,
    ],
    [
      "a hard-linked WGSL file",
      async (root) => {
        await writeFile(path.join(root, "secret.wgsl"), "fn f() {}\n");
        await link(path.join(root, "secret.wgsl"), path.join(root, "shaders", "water.wgsl"));
      },
      GenexTomlCode.WgslLinked,
    ],
    [
      "a folder named like the source",
      (root) => mkdir(path.join(root, "shaders", "water.wgsl")),
      GenexTomlCode.WgslNotAFile,
    ],
    ["a missing source", async () => {}, GenexTomlCode.WgslNotAFile],
    [
      "an oversize source",
      (root) => writeFile(path.join(root, "shaders", "water.wgsl"), "/".repeat(NATIVE_WGSL_MAX_BYTES + 1)),
      GenexTomlCode.WgslTooLarge,
    ],
  ];
  for (const [name, prepare, code] of rows) {
    it(`refuses ${name} with ${code}`, async () => {
      assert.equal(refusedCode(await wgslGame(prepare)), code);
    });
  }

  it("refuses a WGSL source reached through a symlinked folder", async () => {
    const root = await tmpDir("genex-wgsl-dir-");
    const elsewhere = await tmpDir("genex-wgsl-elsewhere-");
    await writeFile(path.join(elsewhere, "water.wgsl"), "fn f() {}\n");
    await symlink(elsewhere, path.join(root, "shaders"));
    const manifest = accepted(`${GAME}[[wgsl]]\npath = "shaders/water.wgsl"\nkind = "material"\n`);
    assert.equal(refusedCode(await checkWgslFiles(root, manifest)), GenexTomlCode.WgslLinked);
  });
});

describe("the genex_meshlets glTF extras schema is the renderer's", () => {
  it("names the key, limits, members and faults genex-render's meshlet.rs pins", async () => {
    const facade = JSON.parse(
      await readFile(path.join(ROOT, "tests", "fixtures", "rust-facade-vocabulary.json"), "utf8"),
    ) as {
      meshlets: Record<string, unknown>;
    };
    assert.deepEqual(facade.meshlets, {
      extrasKey: MESHLETS_EXTRAS_KEY,
      schemaVersion: MESHLET_SCHEMA_VERSION,
      maxVertices: MESHLET_MAX_VERTICES,
      maxTriangles: MESHLET_MAX_TRIANGLES,
      recordBytes: MESHLET_RECORD_BYTES,
      minTrianglesDefault: MESHLET_MIN_TRIANGLES_DEFAULT,
      extrasKeys: Object.values(MeshletExtrasKey),
      faults: Object.values(MeshletFault),
    });
  });
});

describe("the genex_lods glTF extras schema is the renderer's", () => {
  it("names the key, limits, members and faults genex-render's mesh_lod.rs pins", async () => {
    const facade = JSON.parse(
      await readFile(path.join(ROOT, "tests", "fixtures", "rust-facade-vocabulary.json"), "utf8"),
    ) as { lods: Record<string, unknown> };
    assert.deepEqual(facade.lods, {
      extrasKey: LODS_EXTRAS_KEY,
      schemaVersion: LOD_SCHEMA_VERSION,
      maxLevels: LOD_MAX_LEVELS,
      minTriangles: LOD_MIN_TRIANGLES,
      extrasKeys: Object.values(LodExtrasKey),
      levelKeys: Object.values(LodLevelKey),
      faults: Object.values(LodFault),
    });
  });
});

describe("the genex_textures glTF extras schema is the importer's", () => {
  it("names the key, version, members, kinds and stem cap glb-textures.ts writes", async () => {
    const facade = JSON.parse(
      await readFile(path.join(ROOT, "tests", "fixtures", "rust-facade-vocabulary.json"), "utf8"),
    ) as { textures: Record<string, unknown> };
    assert.deepEqual(facade.textures, {
      extrasKey: GLB_TEXTURES_EXTRAS_KEY,
      schemaVersion: GLB_TEXTURES_SCHEMA_VERSION,
      extrasKeys: Object.values(GlbTexturesKey),
      imageKeys: Object.values(GlbTextureImageKey),
      kinds: Object.values(TextureUsage),
      stemMaxChars: GLB_TEXTURE_STEM_MAX_CHARS,
    });
  });
});

/** A `[net]` table (G6 MP-5b) after the `[game]` table, with its matchmaking sub-tables when given. */
const netToml = (net: string, matchmaking = "", config = "") =>
  `${GAME}[net]\n${net}${matchmaking && `[net.matchmaking]\n${matchmaking}`}${config && `[net.matchmaking.config]\n${config}`}`;

describe("genex.toml: [net] turns multiplayer on and carries the draft's matchmaking (G6 MP-5b)", () => {
  it("reads [net] enabled and its matchmaking preset, win condition and numeric knobs", () => {
    const manifest = accepted(
      netToml(
        "enabled = true\n",
        'preset = "arena"\nwin_condition = "firstToScore"\n',
        "maxPlayers = 8\nscoreTarget = 20\nfill = 0.5\n",
      ),
    );
    assert.deepEqual(manifest.net, {
      enabled: true,
      matchmaking: {
        preset: MatchmakingPreset.Arena,
        winCondition: MatchWinCondition.FirstToScore,
        config: { maxPlayers: 8, scoreTarget: 20, fill: 0.5 },
      },
    });
    assert.equal(netEnabled(manifest), true);
  });

  it("has no networking without [net], or with enabled = false", () => {
    const plain = accepted(GAME);
    assert.equal(plain.net, null);
    assert.equal(netEnabled(plain), false);
    const off = accepted(netToml("enabled = false\n"));
    assert.deepEqual(off.net, { enabled: false, matchmaking: null });
    assert.equal(netEnabled(off), false);
  });

  it("writes the matchmaking block the draft's package.json carries, in Genex's spelling, and none without one", () => {
    const manifest = accepted(netToml("enabled = true\n", 'preset = "open"\n', "maxPlayers = 10\nminPlayers = 2\n"));
    assert.deepEqual(genexMatchmakingBlock(manifest), { preset: "open", config: { maxPlayers: 10, minPlayers: 2 } });
    const duel = accepted(netToml("enabled = true\n", 'preset = "duel"\nwin_condition = "lastStanding"\n'));
    assert.deepEqual(genexMatchmakingBlock(duel), { preset: "duel", winCondition: "lastStanding" });
    assert.equal(genexMatchmakingBlock(accepted(netToml("enabled = true\n"))), null);
    // A game with networking off sends no block, whatever its table says.
    assert.equal(genexMatchmakingBlock(accepted(netToml("enabled = false\n", 'preset = "open"\n'))), null);
    assert.equal(genexMatchmakingBlock(accepted(GAME)), null);
  });

  it("names every preset and win condition Genex's relay knows", () => {
    assert.deepEqual(Object.values(MatchmakingPreset), ["open", "duel", "arena", "teams", "private"]);
    assert.deepEqual(Object.values(MatchWinCondition), [
      "lastStanding",
      "firstToScore",
      "highScoreInTime",
      "firstToFinish",
    ]);
  });

  const tooMany = Array.from({ length: NET_MATCH_CONFIG_MAX_KEYS + 1 }, (_, at) => `knob${at} = 1\n`).join("");
  const refusedNet: Array<[string, string]> = [
    ['enabled = "yes"', netToml('enabled = "yes"\n')],
    ["no enabled key", netToml('matchmaking_note = "x"\n')],
    ["an [net] without enabled", `${GAME}[net]\n`],
    ["an unknown key in [net]", netToml('enabled = true\nrelay_url = "wss://elsewhere.example"\n')],
    ["a preset outside open|duel|arena|teams|private", netToml("enabled = true\n", 'preset = "battle-royale"\n')],
    ["a matchmaking table without a preset", netToml("enabled = true\n", 'win_condition = "firstToScore"\n')],
    ["an unknown win condition", netToml("enabled = true\n", 'preset = "arena"\nwin_condition = "mostKills"\n')],
    ["an unknown key in [net.matchmaking]", netToml("enabled = true\n", 'preset = "open"\nregion = "eu"\n')],
    ["matchmaking as a string", netToml('enabled = true\nmatchmaking = "open"\n')],
    ["a knob that is not a number", netToml("enabled = true\n", 'preset = "open"\n', 'maxPlayers = "8"\n')],
    ["a negative knob", netToml("enabled = true\n", 'preset = "open"\n', "maxPlayers = -1\n")],
    ["a knob past the cap", netToml("enabled = true\n", 'preset = "open"\n', "maxPlayers = 10000001\n")],
    [
      "a knob name that is not camelCase letters",
      netToml("enabled = true\n", 'preset = "open"\n', '"max players" = 8\n'),
    ],
    ["a knob named __proto__", netToml("enabled = true\n", 'preset = "open"\n', "__proto__ = 8\n")],
    [
      "a knob table under a knob",
      netToml("enabled = true\n", 'preset = "open"\n', "[net.matchmaking.config.deep]\nx = 1\n"),
    ],
    [`more than ${NET_MATCH_CONFIG_MAX_KEYS} knobs`, netToml("enabled = true\n", 'preset = "open"\n', tooMany)],
  ];
  for (const [name, text] of refusedNet) {
    it(`refuses ${name} with ${GenexTomlCode.InvalidNet}`, () => {
      assert.equal(refusedCode(parseGenexToml(text)), GenexTomlCode.InvalidNet);
    });
  }

  it("refuses the inline-table form as a malformed file: genex.toml spells matchmaking as [net.matchmaking]", () => {
    const text = `${GAME}[net]\nenabled = true\nmatchmaking = { preset = "open" }\n`;
    assert.equal(refusedCode(parseGenexToml(text)), GenexTomlCode.Syntax);
  });

  it("keeps a [net] table through an eject and an un-eject, byte for byte", () => {
    const text = netToml("enabled = true\n", 'preset = "teams"\n', "maxPlayers = 8\n");
    const ejected = withEngineRow(text, "0.1.0");
    assert.ok(ejected.ok);
    assert.deepEqual(ejected.manifest.net, accepted(text).net);
    const back = withEngineRow(ejected.text, null);
    assert.ok(back.ok);
    assert.equal(back.text, text);
  });
});
