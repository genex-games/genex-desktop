/**
 * `genex.toml`, the one build input a Rust · wgpu game folder declares. The host reads it as data
 * and writes the cargo manifest and lock itself (`src/main/rust-manifest.ts`), so anything outside
 * the schema is refused with a typed code before a build starts:
 *
 * ```toml
 * [game]
 * title = "Pond"            # required
 * world_size = [960, 540]   # optional, each side 64..=4096
 * save_name = "pond"        # optional: letters, digits, space, _ - .
 *
 * [crates]                  # optional: the reviewed allowlist (noise, fastrand) by requirement,
 * noise = "0.9"             # or a crate the person approved for this game, at its exact version
 * tidy = "=1.0.0"
 *
 * [[crate_request]]         # optional: ask the person for a crate (extension ladder level 4)
 * name = "tidy"
 * version = "1.0.0"         # one exact release
 * reason = "tidy layouts"   # optional, one sentence for the person
 *
 * [[wgsl]]                  # optional WGSL extension sources, relative to the game folder
 * path = "shaders/water.wgsl"
 * kind = "material"         # material | post | pass
 * api = 1                   # optional extension API: 1 (default) or 2, up to the renderer's
 *
 * [render]                  # optional: the renderer's quality and the game's look
 * form_factors = ["desktop", "mobile"]   # FormFactor values; build targets stay the project's
 * preset = "auto"           # auto | low | medium | high | ultra
 *
 * [render.look]             # the game's look, the same on every preset and device
 * tonemapper = "agx-punchy" # khronos-neutral (default) | agx | agx-punchy | aces | none
 * exposure = "auto"         # manual (default) | auto
 * metering = "center"       # average | center | spot | ground
 * ev_compensation = -0.5    # within ±10
 * bloom_intensity = 0.04    # 0..=1
 * ev_min = -6               # auto exposure's metered EV range, within ±16 (default -8..=8)
 * ev_max = 8
 * adaptation_speed_up = 1   # EV per second, 0 < speed <= 20 (defaults 1 and 3)
 * adaptation_speed_down = 3
 *
 * [render.loading]          # the loading screen until the first lit frame (`shared/loading-style.ts`)
 * title = "Harbour Nights"  # default: [game] title; 1..=60 characters
 * background = "#1b2233"    # sRGB #rrggbb; accent (spinner, bar) and text likewise
 * logo = "ui/logo.png"      # a PNG, JPEG or WebP under assets/
 *
 * [render.class.mobile-mid] # quality on one device class (`DeviceClass`)
 * preset = "low"
 * render_scale = 0.67       # 0.5..=1
 * fps = 30                  # 30 | 60
 * bloom = false             # a `RenderFeature` switch
 * lod_threshold_px = 2.5    # the error a level may show, output pixels, 0.5..=8 (held to 0.5x..2x the preset's)
 * lod_fade_band = 0.15      # the LOD crossfade band, a share of the threshold, 0..=0.5 (0: hard switches)
 * far_density = 0.35        # the share of far-field copies kept, 0.1..=1
 *
 * [gpu]                     # optional native-enhanced features; a game that names any has no web build
 * native_features = ["subgroup"]
 *
 * [web]                     # optional: the browser build's code budget, in MB of gzip
 * wasm_budget_mb = 8        # 1..=32 (default 4): past it an export warns, past 32 it is refused
 *
 * [physics]                 # optional: a game without physics leaves Rapier out of its build
 * enabled = false           # default true
 *
 * [[texture]]               # optional: a loose texture's usage, where no material slot tells it
 * path = "textures/flow.png"   # under assets/: a PNG, JPEG or WebP (`isTextureRowPath`)
 * usage = "data"            # color | data | normal (`asset-import/texture-usage.ts`)
 *
 * [[asset_group]]           # optional: assets a game loads during play, by name (C-30)
 * name = "castle"           # letters, digits, _ and -; never boot, sim or stream (the build's own groups)
 * paths = ["interiors/castle/**", "props/throne.glb"]  # globs under assets/: *, ? and whole-segment **
 *
 * [assets]                  # optional: the package's budgets, in MB (C-17, owner call C8)
 * budget_mb = 300           # every destination's budget: past it an export warns (`assets-over-budget`)
 * phone_max_texture_px = 2048  # iOS and Android packages drop KTX2 levels above it: 512..=4096, a power of two
 *
 * [assets.web]              # one destination's own budget: web, ios, android or desktop (Mac, Windows, Linux)
 * budget_mb = 64            # defaults web 64, ios 200, android 200, desktop 2048; at most the destination's
 *                           # hard cap (web 512, the shell's; phones 4096), past which a build is refused
 *
 * [net]                     # optional: multiplayer (G6); absent, the game is built with no networking
 * enabled = true            # required in the table: Live links the in-process room, an export the relay
 *
 * [net.matchmaking]         # optional: what `matchmake()` asks Genex's relay for, carried by the draft
 * preset = "open"           # open | duel | arena | teams | private
 * win_condition = "firstToScore"  # optional: lastStanding | firstToScore | highScoreInTime | firstToFinish
 *
 * [net.matchmaking.config]  # optional: the preset's numeric knobs, in Genex's own camelCase spelling
 * maxPlayers = 8            # at most 16 knobs, each 0..=1000000
 * minPlayers = 2
 *
 * [engine]                  # written by the host alone when the person ejects the engine (level 5)
 * ejected_from = "0.1.0"    # the genex release copied into `engine/`; the build links that fork
 * ```
 *
 * The rules mirror genex's own `manifest.rs` (the runtime reads the same schema): a crate's version
 * is a plain requirement (no inline table, so never a path or git source), a crate off the
 * allowlist is named only at an exact version (`=X.Y.Z`: whether the person approved it for this
 * game is the build's check, `rust-build.ts`), and `[[crate_request]]` rows name one crate at one
 * exact release. The host's additions: a native feature outside the `NativeEnhancedFeature`
 * vocabulary has its own code, the `[engine]` row the person's eject writes, and a WGSL source must
 * be a regular file reached by realpath inside the folder, never through a link.
 *
 * The parser reads the TOML this schema needs and refuses the rest as `manifest-syntax`: section
 * headers (`[name]`, `[name.sub]`, `[[name]]`; a sub-table may come before its table), bare or
 * quoted keys (never dotted in a key-value line), basic and literal strings, integers, decimal
 * floats (kept apart from integers: a float is never a size or a count), booleans and arrays
 * (multi-line, with comments). No inline tables, `inf`/`nan`, dates or multi-line strings: none of
 * them has a place in a valid `genex.toml`. The `[render]` vocabulary is `shared/render-quality.ts`.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isWebWasmBudgetMb } from "../shared/game-export-contract.ts";
import { LoadingKey, type LoadingStyle, loadingStyleProblem } from "../shared/loading-style.ts";
import { BuildTarget } from "../shared/game-project.ts";
import {
  NATIVE_EXTENSION_API_VERSION,
  NATIVE_WGSL_MAX_BYTES,
  NativeEnhancedFeature,
  NativeRefusal,
} from "../shared/native-contract.ts";
import {
  type DeviceClass,
  type FormFactor,
  isBloomIntensity,
  isDeviceClass,
  isEvCompensation,
  isAdaptationSpeed,
  isAoIntensity,
  isAoRadius,
  isBloomRadius,
  isBloomThreshold,
  isContactShadowLength,
  isExposureEv,
  isFogBaseHeight,
  isFogColor,
  isFogDensity,
  isFogHeightFalloff,
  isFogOpacity,
  isFogStart,
  isExposureMode,
  isFormFactor,
  isFpsTarget,
  isMetering,
  isQualityPreset,
  isRenderFeature,
  isFarDensity,
  isLodFadeBand,
  isLodThreshold,
  isRenderScale,
  isShadowBlendBand,
  isShadowDistance,
  isTonemapper,
  LookKey,
  QualityKey,
  type RenderClassOverride,
  type RenderFeature,
  type RenderLook,
  type RenderShadows,
  type RenderToml,
  ShadowTomlKey,
  RenderTomlKey,
  WGSL_EXTENSION_APIS,
} from "../shared/render-quality.ts";
import { isSafeAssetPath } from "./asset-import/safe-asset.ts";
import { isTextureRowPath, isTextureUsage, type TextureRow } from "./asset-import/texture-usage.ts";
import { readRegularFile } from "./fsx.ts";
import { isInside } from "./paths.ts";
import { GENEX_MANIFEST } from "./project-shape.ts";

/** Why a `genex.toml` (or a WGSL source it names) was refused. The first eight are genex's `ManifestErrorCode`. Wire values. */
export const GenexTomlCode = {
  /** Not the TOML this schema reads, a missing required key, an unknown key or a value of the wrong shape. */
  Syntax: "manifest-syntax",
  /** An empty or overlong title. */
  InvalidTitle: "invalid-title",
  /** A world size side outside 64..=4096. */
  InvalidWorldSize: "invalid-world-size",
  /** A save name with characters outside letters, digits, space, `_`, `-`, `.`, or `.`/`..`. */
  InvalidSaveName: "invalid-save-name",
  /** A crate off the reviewed allowlist, named by anything but an exact version (`=X.Y.Z`). */
  CrateNotAllowlisted: "crate-not-allowlisted",
  /** A WGSL path that is not a plain relative `.wgsl` path. */
  InvalidWgslPath: "invalid-wgsl-path",
  /** The same WGSL path twice. */
  DuplicateWgslPath: "duplicate-wgsl-path",
  /** The same native feature twice. */
  DuplicateNativeFeature: "duplicate-native-feature",
  /** No plain `genex.toml` to read: missing, a link, a folder, oversize or not UTF-8. */
  Unreadable: "manifest-unreadable",
  /** An allowlisted crate whose version is not a plain requirement (`0.9`, `^0.9.0`, `~2.5`, `=2.5.0`). */
  InvalidCrateVersion: "invalid-crate-version",
  /** A native feature name outside the `NativeEnhancedFeature` vocabulary. */
  UnknownNativeFeature: "unknown-native-feature",
  /** A WGSL source reached through a link (a linked file or folder, or a hard link), or resolving outside the folder. */
  WgslLinked: "wgsl-linked",
  /** A WGSL source that is missing or not a regular file. */
  WgslNotAFile: "wgsl-not-a-file",
  /** A WGSL source above `NATIVE_WGSL_MAX_BYTES`. */
  WgslTooLarge: "wgsl-too-large",
  /** A `[[crate_request]]` row without a crate name and one exact version, with an overlong reason, or twice. */
  InvalidCrateRequest: "invalid-crate-request",
  /** An `[engine]` row whose `ejected_from` is not one genex release (`X.Y.Z`). */
  InvalidEngine: "invalid-engine",
  /** A `[[wgsl]] api` the facade never defined (see `WGSL_EXTENSION_APIS`). */
  UnknownExtensionApi: "unknown-extension-api",
  /** A `[[wgsl]] api` this renderer does not serve yet (above `NATIVE_EXTENSION_API_VERSION`). */
  ExtensionApiUnavailable: "extension-api-unavailable",
  /** A `preset` outside `QualityPreset`, in `[render]` or a class table. */
  InvalidRenderPreset: "invalid-render-preset",
  /** A `[render.class.<class>]` naming no `DeviceClass`. */
  UnknownDeviceClass: "unknown-device-class",
  /** A `form_factors` entry outside `FormFactor`, or one named twice. */
  InvalidFormFactor: "invalid-form-factor",
  /** A `render_scale` outside `RENDER_SCALE_MIN..=RENDER_SCALE_MAX`. */
  InvalidRenderScale: "invalid-render-scale",
  /** An `fps` other than one of `RENDER_FPS_TARGETS`. */
  InvalidRenderFps: "invalid-render-fps",
  /** A class table's switch naming no `RenderFeature`. */
  UnknownRenderFeature: "unknown-render-feature",
  /** A `[render.look]` value outside its vocabulary or range. */
  InvalidRenderLook: "invalid-render-look",
  /** A `[render.shadows]` value outside its range (`SHADOW_DISTANCE_MIN..=SHADOW_DISTANCE_MAX`, `0..=SHADOW_BLEND_BAND_MAX`). */
  InvalidRenderShadows: "invalid-render-shadows",
  /**
   * A class table's LOD key outside its range (`lod_threshold_px` within
   * `LOD_THRESHOLD_PX_MIN..=LOD_THRESHOLD_PX_MAX`, `lod_fade_band` within `0..=LOD_FADE_BAND_MAX`,
   * `far_density` within `FAR_DENSITY_MIN..=1`).
   */
  InvalidRenderLod: "invalid-render-lod",
  /** A `[render.loading]` value that breaks its rule (`shared/loading-style.ts`). */
  InvalidRenderLoading: "invalid-render-loading",
  /** A `[web] wasm_budget_mb` outside `WEB_WASM_BUDGET_MIN_MB..=WEB_WASM_CEILING_MB`. */
  InvalidWebBudget: "invalid-web-budget",
  /**
   * A `[[texture]]` row whose usage is not `color`, `data` or `normal`, whose path is not a safe
   * path under `assets/` to a PNG, JPEG or WebP, or whose path another row already names.
   */
  InvalidTextureUsage: "invalid-texture-usage",
  /**
   * An `[[asset_group]]` row whose name is malformed, reserved (`boot`, `sim`, `stream`) or taken
   * by another row; whose paths are none, too many, repeated, or a glob that is not a safe path
   * under `assets/` (C-30); or more rows than {@link ASSET_GROUP_MAX}.
   */
  InvalidAssetGroup: "invalid-asset-group",
  /**
   * An `[assets]` or `[assets.<destination>]` `budget_mb` below {@link ASSET_BUDGET_MIN_MB} or past
   * the destination's hard cap ({@link ASSET_BUDGETS}; {@link ASSET_BUDGET_MAX_MB} for `[assets]`
   * and a destination without one).
   */
  AssetBudgetOutOfRange: "asset-budget-out-of-range",
  /** An `[assets] phone_max_texture_px` that is not a power of two from {@link PHONE_TEXTURE_CAP_MIN_PX} to {@link PHONE_TEXTURE_CAP_MAX_PX}. */
  InvalidTextureCap: "invalid-texture-cap",
  /**
   * A `[net]` table that breaks its rule (G6 MP-5b): `enabled` missing or not a boolean, an unknown
   * key, a matchmaking preset or win condition outside {@link MatchmakingPreset} and
   * {@link MatchWinCondition}, or a knob that is not a camelCase name with a number from 0 to
   * {@link NET_MATCH_KNOB_MAX} (at most {@link NET_MATCH_CONFIG_MAX_KEYS}).
   */
  InvalidNet: "invalid-net",
} as const;
export type GenexTomlCode = (typeof GenexTomlCode)[keyof typeof GenexTomlCode];

/** What a WGSL source extends. Wire values (genex's `WgslKind`). */
export const WgslKind = {
  /** A custom material, `gfx.material(path, uniforms)`, drawn with `frame.custom(..)` (extension ladder level 2). */
  Material: "material",
  /** A post pass, `gfx.post_pass(path, stage)` (level 2). */
  Post: "post",
  /** A custom GPU pass through `genex::gpu` (level 3). */
  Pass: "pass",
} as const;
export type WgslKind = (typeof WgslKind)[keyof typeof WgslKind];

/**
 * The folder of an ejected game that holds its engine fork, one sub-folder per forked crate
 * (`engine/genex-core`): written by the host on the person's eject, then the entry owner's.
 */
export const RUST_ENGINE_FOLDER = "engine";

/** Extra crates a game may name without a person's approval: genex's `GAME_CRATE_ALLOWLIST`. */
export const GAME_CRATE_ALLOWLIST: readonly string[] = Object.freeze(["fastrand", "noise", "pathfinding"]);

/**
 * The asset groups every build already has (the web map's boot, sim and stream groups, STR-14b):
 * an `[[asset_group]]` may not take one of these names, in any case.
 */
export const RESERVED_ASSET_GROUPS: readonly string[] = Object.freeze(["boot", "sim", "stream"]);
/** The most `[[asset_group]]` rows a game declares. */
export const ASSET_GROUP_MAX = 64;
/** The most paths one `[[asset_group]]` lists. */
export const ASSET_GROUP_PATHS_MAX = 256;
/** An asset group's name: a letter or digit, then letters, digits, `_` and `-`, 64 at most. */
const ASSET_GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A glob segment: an asset path segment's characters with `*` and `?` among them. */
const GLOB_SEGMENT = /^[A-Za-z0-9 _.*?-]+$/;
/** The glob segment that matches any number of whole segments. */
const ANY_SEGMENTS = "**";

/**
 * Where a package budget applies: an `[assets.<destination>]` table's name. Mac, Windows and Linux
 * share one, `desktop`. Wire values (genex.toml keys): never rename one.
 */
export const AssetDestination = { Web: "web", Ios: "ios", Android: "android", Desktop: "desktop" } as const;
export type AssetDestination = (typeof AssetDestination)[keyof typeof AssetDestination];

/** One destination's package budget when the game names none, and the hard cap no package passes (null: none), in MB. */
export interface AssetBudgetRow {
  readonly defaultMb: number;
  readonly ceilingMb: number | null;
}

/**
 * Each destination's package budget (owner call C8): web 64 MB, iOS 200 MB (the cellular download
 * limit), Android 200 MB (the Play base module) and desktop 2 GB. Only the hard caps refuse: the
 * web shell's 512 MB (genex-platform-web's `MAX_ASSETS_TOTAL_BYTES`) and 4096 MB on a phone.
 */
export const ASSET_BUDGETS = Object.freeze({
  [AssetDestination.Web]: { defaultMb: 64, ceilingMb: 512 },
  [AssetDestination.Ios]: { defaultMb: 200, ceilingMb: 4096 },
  [AssetDestination.Android]: { defaultMb: 200, ceilingMb: 4096 },
  [AssetDestination.Desktop]: { defaultMb: 2048, ceilingMb: null },
} as const satisfies Record<AssetDestination, AssetBudgetRow>);
/** The smallest budget a game may name. */
export const ASSET_BUDGET_MIN_MB = 1;
/** The largest `[assets] budget_mb`, and a desktop's: a bound on the key, never a refusal of a package. */
export const ASSET_BUDGET_MAX_MB = 65536;
/** One megabyte as a package budget counts it: 2^20 bytes. */
export const ASSET_BUDGET_MB_BYTES = 1024 * 1024;
/** The smallest and largest `[assets] phone_max_texture_px` (the default is the package step's `PHONE_MAX_TEXTURE_PX`). */
export const PHONE_TEXTURE_CAP_MIN_PX = 512;
export const PHONE_TEXTURE_CAP_MAX_PX = 4096;
/** Which budget each build destination's package is measured against. */
const ASSET_DESTINATION_OF = Object.freeze({
  [BuildTarget.Mac]: AssetDestination.Desktop,
  [BuildTarget.Windows]: AssetDestination.Desktop,
  [BuildTarget.Linux]: AssetDestination.Desktop,
  [BuildTarget.Ios]: AssetDestination.Ios,
  [BuildTarget.Android]: AssetDestination.Android,
  [BuildTarget.Web]: AssetDestination.Web,
} as const satisfies Record<BuildTarget, AssetDestination>);
const ASSET_DESTINATIONS: readonly AssetDestination[] = Object.values(AssetDestination);

/**
 * The matchmaking presets Genex's relay runs (`genex.matchmaking.preset` in a draft's package.json).
 * Wire values: Genex's own spelling, never renamed.
 */
export const MatchmakingPreset = {
  Open: "open",
  Duel: "duel",
  Arena: "arena",
  Teams: "teams",
  Private: "private",
} as const;
export type MatchmakingPreset = (typeof MatchmakingPreset)[keyof typeof MatchmakingPreset];

/** How a batteries-included preset ends a round (`genex.matchmaking.winCondition`). Wire values: Genex's spelling. */
export const MatchWinCondition = {
  LastStanding: "lastStanding",
  FirstToScore: "firstToScore",
  HighScoreInTime: "highScoreInTime",
  FirstToFinish: "firstToFinish",
} as const;
export type MatchWinCondition = (typeof MatchWinCondition)[keyof typeof MatchWinCondition];

/** The most knobs a `[net.matchmaking.config]` table names. */
export const NET_MATCH_CONFIG_MAX_KEYS = 16;
/** The largest value one matchmaking knob takes (Genex clamps each to its own range). */
export const NET_MATCH_KNOB_MAX = 1_000_000;
/** A knob's name: Genex's camelCase spelling, a lower-case letter then letters and digits, 32 at most. */
const NET_MATCH_KNOB_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;

/** The world target when `world_size` is absent. */
const DEFAULT_WORLD_SIZE = [960, 540] as const;
/** genex-core's `MIN_WORLD_PX..=MAX_WORLD_PX`. */
const MIN_WORLD_PX = 64;
const MAX_WORLD_PX = 4096;
const MAX_TITLE_CHARS = 80;
const MAX_SAVE_NAME_CHARS = 64;
/** The most of a `genex.toml` the host reads; a bigger one is `manifest-unreadable`. */
const GENEX_TOML_MAX_BYTES = 64 * 1024;
/** A crate version requirement the host writes into the cargo manifest: an optional `=`, `^` or `~`, then 1-3 numbers. */
const CRATE_VERSION = /^[=^~]?\d{1,6}(\.\d{1,6}){0,2}$/;
/** An approved crate's pin: `=` and one exact release. */
const EXACT_CRATE_VERSION = /^=\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** A requested crate: its registry name, and one exact release. */
const REQUEST_CRATE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const REQUEST_CRATE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/** The longest reason a request row carries to the person (the harness's `crates.request` cap). */
const REQUEST_REASON_MAX_CHARS = 500;
const SAVE_NAME = /^[A-Za-z0-9 _.-]+$/;

/** One allowlisted crate and its version requirement, or an approved crate at its exact version. */
export interface GameCrate {
  name: string;
  version: string;
}

/** One `[[crate_request]]` row: a crate the game asks the person for (extension ladder level 4). */
export interface GameCrateRequest {
  name: string;
  /** One exact release, `MAJOR.MINOR.PATCH` with an optional pre-release. */
  version: string;
  reason: string | null;
}

/** The `[engine]` row of an ejected game (extension ladder level 5): the build links its `engine/` fork. */
export interface GenexEngine {
  /** The genex release the person ejected, `X.Y.Z`: the version the fork's crates carry. */
  ejectedFrom: string;
}

/** One `[[wgsl]]` source. */
export interface WgslSource {
  /** Relative to the game folder, `/`-separated, ending in `.wgsl`. */
  path: string;
  kind: WgslKind;
  /** The extension API it is written against: 1 unless the row names one. */
  api: number;
}

/** One `[[asset_group]]` row (C-30): a named set of assets a game loads during play. */
export interface AssetGroupRow {
  name: string;
  /**
   * Globs relative to `assets/`, `/`-separated, in file order: `*` matches within one segment, `?`
   * one character of one, and a whole `**` segment any number of segments ({@link assetGroupMatches}).
   */
  paths: readonly string[];
}

/** `[assets]` and its `[assets.<destination>]` tables (C-17): the package's budgets, as the game names them. */
export interface AssetsToml {
  /** `[assets] budget_mb`: every destination's budget in MB; null: each destination's default. */
  budgetMb: number | null;
  /** `[assets] phone_max_texture_px`; null: the package step's default. */
  phoneMaxTexturePx: number | null;
  /** Each `[assets.<destination>] budget_mb` the game names, by destination. */
  destinations: Partial<Record<AssetDestination, number>>;
}

/** A destination's package budget in bytes: past `budgetBytes` an export warns, past `ceilingBytes` (null: none) a build is refused. */
export interface AssetBudget {
  budgetBytes: number;
  ceilingBytes: number | null;
}

/** `[net.matchmaking]`, checked: what `matchmake()` asks Genex's relay for on the draft. */
export interface NetMatchmaking {
  preset: MatchmakingPreset;
  /** Null when the table names none (the preset's own, or none for `open`). */
  winCondition: MatchWinCondition | null;
  /** The preset's numeric knobs by Genex's name (`maxPlayers`), in file order; empty when none. */
  config: Readonly<Record<string, number>>;
}

/** `[net]`, checked (G6 MP-5b). */
export interface NetToml {
  /** Whether the game is built with networking: Live links the in-process room, an export the relay. */
  enabled: boolean;
  /** `[net.matchmaking]`, or null when the file has none (`matchmake()` then gets Genex's `duel`). */
  matchmaking: NetMatchmaking | null;
}

/** A parsed, checked `genex.toml`. */
export interface GenexToml {
  title: string;
  worldSize: readonly [number, number];
  saveName: string | null;
  /** By name. */
  crates: readonly GameCrate[];
  /** The crates the game asks the person for, in file order; absent from a manifest built by hand. */
  crateRequests?: readonly GameCrateRequest[];
  wgsl: readonly WgslSource[];
  nativeFeatures: readonly NativeEnhancedFeature[];
  /** The ejected engine, or null (absent from a manifest built by hand): the store's engine. */
  engine?: GenexEngine | null;
  /** The `[render]` table, or null when the file has none (absent from a manifest built by hand). */
  render?: RenderToml | null;
  /** `[web] wasm_budget_mb`: the browser build's code budget in MB of gzip; null (or absent) when it names none. */
  wasmBudgetMb?: number | null;
  /**
   * `[physics] enabled`: false links the facade without Rapier (its `physics` feature), about a
   * fifth of a web build's code; absent or true keeps it (renderer pass 2, owner decision D11).
   */
  physics?: boolean;
  /** `[[texture]]` rows in file order: loose textures' usages (C-10); absent from a manifest built by hand. */
  textures?: readonly TextureRow[];
  /** `[[asset_group]]` rows in file order (C-30); absent from a manifest built by hand. */
  assetGroups?: readonly AssetGroupRow[];
  /** `[assets]`, or null when the file has none (absent from a manifest built by hand): every default. */
  assets?: AssetsToml | null;
  /** `[net]`, or null when the file has none (absent from a manifest built by hand): no networking. */
  net?: NetToml | null;
}

/** A refusal with its typed code and a short detail naming the offending value (never a host path). */
export interface GenexTomlRefusal<Code = GenexTomlCode> {
  ok: false;
  code: Code;
  detail: string;
}

/** What {@link parseGenexToml} and {@link readGenexToml} answer. */
export type GenexTomlResult = { ok: true; manifest: GenexToml } | GenexTomlRefusal;

/** What a check answers: nothing on success, the refusal otherwise. */
export type GenexTomlCheck<Code = GenexTomlCode> = { ok: true } | GenexTomlRefusal<Code>;

const refuse = <Code>(code: Code, detail: string): GenexTomlRefusal<Code> => ({ ok: false, code, detail });
const OK = { ok: true } as const;

/** Read and check `<dir>/genex.toml`: a plain file only, never through a link. */
export async function readGenexToml(dir: string): Promise<GenexTomlResult> {
  const bytes = await readRegularFile(path.join(dir, GENEX_MANIFEST), GENEX_TOML_MAX_BYTES).catch(() => null);
  if (bytes === null) return refuse(GenexTomlCode.Unreadable, GENEX_MANIFEST);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse(GenexTomlCode.Unreadable, `${GENEX_MANIFEST} is not UTF-8`);
  }
  return parseGenexToml(text);
}

/** Parse and check a `genex.toml` text. */
export function parseGenexToml(text: string): GenexTomlResult {
  let document: TomlTable;
  try {
    document = parseTomlDocument(text);
  } catch (error) {
    if (error instanceof TomlSyntaxError) return refuse(GenexTomlCode.Syntax, error.message);
    throw error;
  }
  const shaped = shapeManifest(document);
  if (!shaped.ok) return shaped;
  const net = netTable(document[NET_TABLE]);
  if (!net.ok) return net;
  const checked =
    checkGame(shaped.manifest) ??
    checkCrates(shaped.manifest) ??
    checkCrateRequests(shaped.manifest) ??
    checkWgsl(shaped.manifest) ??
    checkEngine(shaped.manifest) ??
    checkWeb(shaped.manifest) ??
    checkAssets(shaped.manifest);
  if (checked) return checked;
  const textures = checkTextures(shaped.rawTextures);
  if (!textures.ok) return textures;
  const groups = checkAssetGroups(shaped.assetGroups);
  if (groups) return groups;
  const checkedRows = { ...shaped.manifest, textures: textures.rows, assetGroups: shaped.assetGroups, net: net.net };
  const featured = checkFeatures(checkedRows, shaped.featureNames);
  if (!featured.ok || shaped.render === null) return featured;
  const render = checkRender(shaped.render);
  return render.ok ? { ok: true, manifest: { ...featured.manifest, render: render.render } } : render;
}

/** Whether the game is built with networking: a `[net]` table with `enabled = true`. */
export function netEnabled(manifest: Pick<GenexToml, "net">): boolean {
  return manifest.net?.enabled === true;
}

/** The `genex.matchmaking` block a draft's package.json carries, in Genex's spelling. */
export interface GenexMatchmakingBlock {
  preset: MatchmakingPreset;
  winCondition?: MatchWinCondition;
  config?: Readonly<Record<string, number>>;
}

/**
 * The matchmaking block a networked game's draft carries to Genex (`genex.matchmaking` in its
 * package.json, MP-5c): its preset, and its win condition and knobs when it names them. Null for a
 * game without networking or without `[net.matchmaking]`.
 */
export function genexMatchmakingBlock(manifest: Pick<GenexToml, "net">): GenexMatchmakingBlock | null {
  const matchmaking = manifest.net?.enabled === true ? manifest.net.matchmaking : null;
  if (!matchmaking) return null;
  const { preset, winCondition, config } = matchmaking;
  return {
    preset,
    ...(winCondition === null ? {} : { winCondition }),
    ...(Object.keys(config).length === 0 ? {} : { config: { ...config } }),
  };
}

/** Whether a game may be built for `target`: a game that declares any native feature has no web build. */
export function checkTargetFeatures(
  manifest: GenexToml,
  target: BuildTarget,
): GenexTomlCheck<typeof NativeRefusal.NativeFeaturesWeb> {
  if (target !== BuildTarget.Web || manifest.nativeFeatures.length === 0) return OK;
  return refuse(NativeRefusal.NativeFeaturesWeb, manifest.nativeFeatures.join(", "));
}

/**
 * Whether every WGSL source the manifest names is a regular file of at most
 * `NATIVE_WGSL_MAX_BYTES` under `root`, reached without a link at any step (a hard link counts)
 * and resolving by realpath inside it. `root` is the staged copy on the build path.
 */
export async function checkWgslFiles(root: string, manifest: GenexToml): Promise<GenexTomlCheck> {
  const realRoot = await realpath(root);
  for (const source of manifest.wgsl) {
    const found = await checkWgslFile(root, realRoot, source.path);
    if (!found.ok) return found;
  }
  return OK;
}

async function checkWgslFile(root: string, realRoot: string, rel: string): Promise<GenexTomlCheck> {
  const segments = rel.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const step = await lstat(path.join(root, ...segments.slice(0, depth))).catch(() => null);
    if (step?.isSymbolicLink()) return refuse(GenexTomlCode.WgslLinked, rel);
    if (!step?.isDirectory()) return refuse(GenexTomlCode.WgslNotAFile, rel);
  }
  const file = path.join(root, ...segments);
  const found = await lstat(file).catch(() => null);
  if (found?.isSymbolicLink()) return refuse(GenexTomlCode.WgslLinked, rel);
  if (!found?.isFile()) return refuse(GenexTomlCode.WgslNotAFile, rel);
  if (found.nlink > 1) return refuse(GenexTomlCode.WgslLinked, rel);
  if (found.size > NATIVE_WGSL_MAX_BYTES) return refuse(GenexTomlCode.WgslTooLarge, rel);
  const real = await realpath(file).catch(() => null);
  if (real === null || !isInside(realRoot, real)) return refuse(GenexTomlCode.WgslLinked, rel);
  return OK;
}

/**
 * `text` (a valid `genex.toml`) with its `[engine]` row set to `ejectedFrom`, or removed for null;
 * every other line kept byte for byte. The host alone calls this, on the person's eject and
 * un-eject (`main/rust-eject.ts`). Refused, with the text unchanged, when `text` does not parse or
 * the edit would change anything but the engine row.
 */
export function withEngineRow(
  text: string,
  ejectedFrom: string | null,
): { ok: true; text: string; manifest: GenexToml } | GenexTomlRefusal {
  const before = parseGenexToml(text);
  if (!before.ok) return before;
  if (ejectedFrom !== null && !GENEX_RELEASE.test(ejectedFrom)) return refuse(GenexTomlCode.InvalidEngine, ejectedFrom);
  const kept = withoutEngineSection(text);
  const base = kept.length === 0 || kept.endsWith("\n") ? kept : `${kept}\n`;
  const edited =
    ejectedFrom === null ? kept : `${base}\n${ENGINE_HEADER}\nejected_from = ${JSON.stringify(ejectedFrom)}\n`;
  const after = parseGenexToml(edited);
  if (!after.ok) return after;
  const engine = ejectedFrom === null ? null : { ejectedFrom };
  const same = JSON.stringify({ ...before.manifest, engine }) === JSON.stringify(after.manifest);
  if (!same) return refuse(GenexTomlCode.Syntax, "the [engine] row could not be edited alone");
  return { ok: true, text: edited, manifest: after.manifest };
}

/** `text` without its `[engine]` section: from that header to the next one (or the end). */
function withoutEngineSection(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const kept: string[] = [];
  let inEngine = false;
  for (const line of lines) {
    const header = SECTION_HEADER.exec(line.replace(/\r?\n$/, ""));
    if (header) {
      inEngine = header[1]?.replace(/^["']|["']$/g, "") === "engine" && !line.trim().startsWith("[[");
      // The blank line the host wrote before the row goes with it, so an eject and un-eject round-trip.
      if (inEngine && /^\r?\n$/.test(kept.at(-1) ?? "")) kept.pop();
    }
    if (!inEngine) kept.push(line);
  }
  return kept.join("");
}

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────

const TOP_KEYS = [
  "game",
  "crates",
  "crate_request",
  "wgsl",
  "gpu",
  "engine",
  "render",
  "web",
  "physics",
  "texture",
  "asset_group",
  "assets",
  "net",
] as const;
const ENGINE_KEYS = ["ejected_from"] as const;
/** The `[engine]` section header the host writes and removes. */
const ENGINE_HEADER = "[engine]";
/** A genex release as `ejected_from` names it: three numbers. */
const GENEX_RELEASE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
/** A section header line (`[name]`, `[name.sub]`, `[[name]]`), with an optional comment after it. */
const SECTION_HEADER =
  /^\s*\[\[?\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*\s*\]\]?\s*(#.*)?$/;
const REQUEST_KEYS = ["name", "version", "reason"] as const;
const GAME_KEYS = ["title", "world_size", "save_name"] as const;
const WGSL_KEYS = ["path", "kind", "api"] as const;
/** The extension API a `[[wgsl]]` row that names none is written against. */
const DEFAULT_WGSL_API = 1;
const RENDER_KEYS: readonly string[] = Object.values(RenderTomlKey);
const LOADING_KEYS: readonly LoadingKey[] = Object.values(LoadingKey);
const LOOK_KEYS: readonly string[] = Object.values(LookKey);
const SHADOW_KEYS: readonly string[] = Object.values(ShadowTomlKey);
const GPU_KEYS = ["native_features"] as const;
/** `[web]`'s keys (genex's `WebSection`). */
const WebKey = { WasmBudgetMb: "wasm_budget_mb" } as const;
const WEB_KEYS: readonly string[] = Object.values(WebKey);
const PhysicsKey = { Enabled: "enabled" } as const;
const PHYSICS_KEYS: readonly string[] = Object.values(PhysicsKey);
/** The `[net]` table's name, and its keys (genex's `NetSection`). */
const NET_TABLE = "net";
const NetKey = { Enabled: "enabled", Matchmaking: "matchmaking" } as const;
const NET_KEYS: readonly string[] = Object.values(NetKey);
/** `[net.matchmaking]`'s keys. */
const MatchmakingKey = { Preset: "preset", WinCondition: "win_condition", Config: "config" } as const;
const MATCHMAKING_KEYS: readonly string[] = Object.values(MatchmakingKey);
const MATCHMAKING_PRESETS: readonly string[] = Object.values(MatchmakingPreset);
const WIN_CONDITIONS: readonly string[] = Object.values(MatchWinCondition);
const isMatchmakingPreset = (value: string): value is MatchmakingPreset => MATCHMAKING_PRESETS.includes(value);
const isWinCondition = (value: string): value is MatchWinCondition => WIN_CONDITIONS.includes(value);
/** A `[[texture]]` row's keys (genex's `TextureRow`). */
const TextureKey = { Path: "path", Usage: "usage" } as const;
const TEXTURE_KEYS: readonly string[] = Object.values(TextureKey);
/** An `[[asset_group]]` row's keys (genex's `AssetGroupRow`). */
const AssetGroupKey = { Name: "name", Paths: "paths" } as const;
const ASSET_GROUP_KEYS: readonly string[] = Object.values(AssetGroupKey);
/** `[assets]`'s keys (genex's `AssetsSection`): its own two, and a table per destination. */
const AssetsKey = { BudgetMb: "budget_mb", PhoneMaxTexturePx: "phone_max_texture_px" } as const;
const ASSETS_KEYS: readonly string[] = [...Object.values(AssetsKey), ...ASSET_DESTINATIONS];
/** An `[assets.<destination>]` table's one key. */
const DESTINATION_KEYS: readonly string[] = [AssetsKey.BudgetMb];
const WGSL_KINDS: readonly string[] = Object.values(WgslKind);
const NATIVE_FEATURES: readonly string[] = Object.values(NativeEnhancedFeature);

const isWgslKind = (value: string): value is WgslKind => WGSL_KINDS.includes(value);
const isNativeFeature = (value: string): value is NativeEnhancedFeature => NATIVE_FEATURES.includes(value);

/**
 * A manifest of the right shape, before the value checks; the feature names are checked by
 * {@link checkFeatures}, the `[render]` values by {@link checkRender}.
 */
type Shaped =
  | {
      ok: true;
      manifest: GenexToml;
      featureNames: readonly string[];
      render: RawRender | null;
      rawTextures: readonly RawTexture[];
      /** `[[asset_group]]` rows of the right shape, their values not yet checked ({@link checkAssetGroups}). */
      assetGroups: readonly AssetGroupRow[];
    }
  | GenexTomlRefusal;

/** One `[[texture]]` row of the right shape: two strings, not yet checked. */
interface RawTexture {
  path: string;
  usage: string;
}

/** One `[render.class.<class>]` of the right shape: its name and values not yet checked. */
interface RawClass {
  name: string;
  preset: string | null;
  renderScale: number | null;
  fps: number | null;
  lodThresholdPx: number | null;
  lodFadeBand: number | null;
  farDensity: number | null;
  /** Every other key, each a boolean, in file order. */
  switches: Array<[string, boolean]>;
}

/** `[render.look]` of the right shape: its keys by value type, not yet checked. */
interface RawLook {
  strings: Array<[string, string]>;
  numbers: Array<[string, number]>;
  booleans: Array<[string, boolean]>;
  /** Arrays of numbers (a colour), their length not yet checked. */
  colors: Array<[string, number[]]>;
}

/** `[render.shadows]` of the right shape: its numbers, not yet checked. */
interface RawShadows {
  distance: number | null;
  blendBand: number | null;
}

/** `[render]` of the right shape (keys known, values typed), its vocabulary not yet checked. */
interface RawRender {
  formFactors: string[];
  preset: string | null;
  look: RawLook;
  classes: RawClass[];
  shadows: RawShadows | null;
  /** `[render.loading]`'s strings by key, not yet checked; null when the file has none. */
  loading: LoadingStyle | null;
}

/** Thrown inside {@link shapeManifest} for a value of the wrong shape. */
class ShapeError extends Error {}

function shapeManifest(document: TomlTable): Shaped {
  try {
    onlyKeys(document, TOP_KEYS, "the top level");
    const game = table(document.game, "[game]");
    onlyKeys(game, GAME_KEYS, "[game]");
    const featureNames = gpuFeatures(document.gpu);
    const render = renderTable(document.render);
    const rawTextures = textureRows(document.texture);
    const assetGroups = assetGroupRows(document.asset_group);
    const manifest: GenexToml = {
      title: string(game.title, "game.title"),
      worldSize: worldSize(game.world_size),
      saveName: game.save_name === undefined ? null : string(game.save_name, "game.save_name"),
      crates: crates(document.crates),
      crateRequests: crateRequests(document.crate_request),
      wgsl: wgslSources(document.wgsl),
      nativeFeatures: [],
      engine: engineRow(document.engine),
      render: null,
      wasmBudgetMb: webBudget(document.web),
      physics: physicsEnabled(document.physics),
      assets: assetsTable(document.assets),
    };
    return { ok: true, manifest, featureNames, render, rawTextures, assetGroups };
  } catch (error) {
    if (error instanceof ShapeError) return refuse(GenexTomlCode.Syntax, error.message);
    throw error;
  }
}

function onlyKeys(found: TomlTable, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(found).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new ShapeError(`unknown key "${unknown}" in ${where}`);
}

function table(value: TomlValue | undefined, where: string): TomlTable {
  if (!isTable(value)) throw new ShapeError(`${where} must be a table`);
  return value;
}

function string(value: TomlValue | undefined, where: string): string {
  if (typeof value !== "string") throw new ShapeError(`${where} must be a string`);
  return value;
}

/** A number, an integer or a float alike: what a scale or a look value is. */
function decimal(value: TomlValue | undefined, where: string): number {
  if (typeof value === "number") return value;
  if (value instanceof TomlFloat) return value.value;
  throw new ShapeError(`${where} must be a number`);
}

/** An integer (never a float). */
function integer(value: TomlValue | undefined, where: string): number {
  if (typeof value !== "number") throw new ShapeError(`${where} must be an integer`);
  return value;
}

function worldSize(value: TomlValue | undefined): readonly [number, number] {
  if (value === undefined) return DEFAULT_WORLD_SIZE;
  const [width, height, ...rest] = Array.isArray(value) ? value : [];
  const sides = typeof width === "number" && typeof height === "number" && rest.length === 0;
  if (!sides) throw new ShapeError("game.world_size must be two integers");
  return [width, height];
}

function crates(value: TomlValue | undefined): GameCrate[] {
  if (value === undefined) return [];
  const found = table(value, "[crates]");
  return Object.keys(found)
    .sort()
    .map((name) => ({ name, version: string(found[name], `crates.${name}`) }));
}

function crateRequests(value: TomlValue | undefined): GameCrateRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable))
    throw new ShapeError("[[crate_request]] must be an array of tables");
  return value.map((entry) => {
    const row = table(entry, "[[crate_request]]");
    onlyKeys(row, REQUEST_KEYS, "[[crate_request]]");
    const reason = row.reason === undefined ? null : string(row.reason, "crate_request.reason");
    return {
      name: string(row.name, "crate_request.name"),
      version: string(row.version, "crate_request.version"),
      reason,
    };
  });
}

function wgslSources(value: TomlValue | undefined): WgslSource[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable)) throw new ShapeError("[[wgsl]] must be an array of tables");
  return value.map((entry) => {
    const source = table(entry, "[[wgsl]]");
    onlyKeys(source, WGSL_KEYS, "[[wgsl]]");
    const kind = string(source.kind, "wgsl.kind");
    if (!isWgslKind(kind)) throw new ShapeError(`unknown wgsl.kind "${kind}"`);
    const api = source.api === undefined ? DEFAULT_WGSL_API : integer(source.api, "wgsl.api");
    return { path: string(source.path, "wgsl.path"), kind, api };
  });
}

/** `[[texture]]` rows as two strings each, in file order (their values are {@link checkTextures}'s). */
function textureRows(value: TomlValue | undefined): RawTexture[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable)) throw new ShapeError("[[texture]] must be an array of tables");
  return value.map((entry) => {
    const row = table(entry, "[[texture]]");
    onlyKeys(row, TEXTURE_KEYS, "[[texture]]");
    return {
      path: string(row[TextureKey.Path], `texture.${TextureKey.Path}`),
      usage: string(row[TextureKey.Usage], `texture.${TextureKey.Usage}`),
    };
  });
}

/** `[[asset_group]]` rows as a name and a list of strings each, in file order (their values are {@link checkAssetGroups}'s). */
function assetGroupRows(value: TomlValue | undefined): AssetGroupRow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isTable))
    throw new ShapeError("[[asset_group]] must be an array of tables");
  return value.map((entry) => {
    const row = table(entry, "[[asset_group]]");
    onlyKeys(row, ASSET_GROUP_KEYS, "[[asset_group]]");
    const paths = row[AssetGroupKey.Paths];
    if (!Array.isArray(paths)) throw new ShapeError(`asset_group.${AssetGroupKey.Paths} must be an array of strings`);
    return {
      name: string(row[AssetGroupKey.Name], `asset_group.${AssetGroupKey.Name}`),
      paths: paths.map((rel) => string(rel, `asset_group.${AssetGroupKey.Paths}`)),
    };
  });
}

/** `[render]` as {@link RawRender}, or null when the file has none. */
function renderTable(value: TomlValue | undefined): RawRender | null {
  if (value === undefined) return null;
  const render = table(value, "[render]");
  onlyKeys(render, RENDER_KEYS, "[render]");
  const factors = render.form_factors ?? [];
  if (!Array.isArray(factors)) throw new ShapeError("render.form_factors must be an array of strings");
  const preset = render.preset === undefined ? null : string(render.preset, "render.preset");
  const classes = render.class === undefined ? [] : renderClasses(table(render.class, "[render.class]"));
  return {
    formFactors: factors.map((factor) => string(factor, "render.form_factors")),
    preset,
    look: renderLook(render.look),
    classes,
    shadows: renderShadows(render.shadows),
    loading: renderLoading(render.loading),
  };
}

/** `[render.loading]`: each key a string, or null when the file has none. */
function renderLoading(value: TomlValue | undefined): LoadingStyle | null {
  if (value === undefined) return null;
  const loading = table(value, "[render.loading]");
  onlyKeys(loading, LOADING_KEYS, "[render.loading]");
  const style: LoadingStyle = {};
  for (const key of LOADING_KEYS) {
    if (loading[key] !== undefined) style[key] = string(loading[key], `render.loading.${key}`);
  }
  return style;
}

/** `[render.shadows]`: a whole distance and a decimal blend band, or null when the file has none. */
function renderShadows(value: TomlValue | undefined): RawShadows | null {
  if (value === undefined) return null;
  const shadows = table(value, "[render.shadows]");
  onlyKeys(shadows, SHADOW_KEYS, "[render.shadows]");
  const distance = shadows[ShadowTomlKey.Distance];
  const band = shadows[ShadowTomlKey.BlendBand];
  return {
    distance: distance === undefined ? null : integer(distance, `render.shadows.${ShadowTomlKey.Distance}`),
    blendBand: band === undefined ? null : decimal(band, `render.shadows.${ShadowTomlKey.BlendBand}`),
  };
}

/** The `[render.look]` keys whose values are numbers. */
const NUMERIC_LOOK_KEYS = [
  LookKey.EvCompensation,
  LookKey.BloomIntensity,
  LookKey.EvMin,
  LookKey.EvMax,
  LookKey.AdaptationSpeedUp,
  LookKey.AdaptationSpeedDown,
  LookKey.BloomThreshold,
  LookKey.BloomRadius,
  LookKey.AoIntensity,
  LookKey.AoRadius,
  LookKey.FogDensity,
  LookKey.FogHeightFalloff,
  LookKey.FogBaseHeight,
  LookKey.FogStart,
  LookKey.FogMaxOpacity,
  LookKey.ContactShadowLength,
] as const;

/** `[render.look]`: its known keys, the vocabulary keys as strings, the switch as a boolean, the colour as numbers and the rest as numbers. */
function renderLook(value: TomlValue | undefined): RawLook {
  const look: TomlTable = value === undefined ? Object.create(null) : table(value, "[render.look]");
  onlyKeys(look, LOOK_KEYS, "[render.look]");
  const raw: RawLook = { strings: [], numbers: [], booleans: [], colors: [] };
  for (const key of [LookKey.Tonemapper, LookKey.Exposure, LookKey.Metering]) {
    if (look[key] !== undefined) raw.strings.push([key, string(look[key], `render.look.${key}`)]);
  }
  for (const key of NUMERIC_LOOK_KEYS) {
    if (look[key] !== undefined) raw.numbers.push([key, decimal(look[key], `render.look.${key}`)]);
  }
  const aerial = look[LookKey.FogAerialPerspective];
  if (aerial !== undefined) {
    if (typeof aerial !== "boolean")
      throw new ShapeError(`render.look.${LookKey.FogAerialPerspective} must be true or false`);
    raw.booleans.push([LookKey.FogAerialPerspective, aerial]);
  }
  const color = look[LookKey.FogColor];
  if (color !== undefined) {
    const where = `render.look.${LookKey.FogColor}`;
    if (!Array.isArray(color)) throw new ShapeError(`${where} must be an array of numbers`);
    raw.colors.push([LookKey.FogColor, color.map((channel) => decimal(channel, where))]);
  }
  return raw;
}

/** `value` as a decimal, or null when the table leaves the key out. */
function optionalDecimal(value: TomlValue | undefined, where: string): number | null {
  return value === undefined ? null : decimal(value, where);
}

/** Every `[render.class.<class>]`, in file order. */
function renderClasses(classes: TomlTable): RawClass[] {
  return Object.keys(classes).map((name) => {
    const row = table(classes[name], `[render.class.${name}]`);
    const where = `render.class.${name}`;
    const switches: Array<[string, boolean]> = [];
    for (const key of Object.keys(row)) {
      if ((Object.values(QualityKey) as string[]).includes(key)) continue;
      const on = row[key];
      if (typeof on !== "boolean") throw new ShapeError(`${where}.${key} must be true or false`);
      switches.push([key, on]);
    }
    return {
      name,
      preset: row.preset === undefined ? null : string(row.preset, `${where}.preset`),
      renderScale: row.render_scale === undefined ? null : decimal(row.render_scale, `${where}.render_scale`),
      fps: row.fps === undefined ? null : integer(row.fps, `${where}.fps`),
      lodThresholdPx: optionalDecimal(row.lod_threshold_px, `${where}.lod_threshold_px`),
      lodFadeBand: optionalDecimal(row.lod_fade_band, `${where}.lod_fade_band`),
      farDensity: optionalDecimal(row.far_density, `${where}.far_density`),
      switches,
    };
  });
}

function engineRow(value: TomlValue | undefined): GenexEngine | null {
  if (value === undefined) return null;
  const engine = table(value, "[engine]");
  onlyKeys(engine, ENGINE_KEYS, "[engine]");
  return { ejectedFrom: string(engine.ejected_from, "engine.ejected_from") };
}

/** `[web] wasm_budget_mb` as an integer, or null when the file names none (its range is {@link checkWeb}'s). */
function webBudget(value: TomlValue | undefined): number | null {
  if (value === undefined) return null;
  const web = table(value, "[web]");
  onlyKeys(web, WEB_KEYS, "[web]");
  const budget = web[WebKey.WasmBudgetMb];
  return budget === undefined ? null : integer(budget, `web.${WebKey.WasmBudgetMb}`);
}

/** An integer key of `found`, or null when it is absent. */
function optionalInteger(found: TomlTable, key: string, where: string): number | null {
  return found[key] === undefined ? null : integer(found[key], where);
}

/** `[assets]` and its destination tables as integers, or null when the file has none (their ranges are {@link checkAssets}'). */
function assetsTable(value: TomlValue | undefined): AssetsToml | null {
  if (value === undefined) return null;
  const assets = table(value, "[assets]");
  onlyKeys(assets, ASSETS_KEYS, "[assets]");
  const destinations: Partial<Record<AssetDestination, number>> = {};
  for (const destination of ASSET_DESTINATIONS) {
    if (assets[destination] === undefined) continue;
    const where = `[assets.${destination}]`;
    const row = table(assets[destination], where);
    onlyKeys(row, DESTINATION_KEYS, where);
    const budget = optionalInteger(row, AssetsKey.BudgetMb, `assets.${destination}.${AssetsKey.BudgetMb}`);
    if (budget !== null) destinations[destination] = budget;
  }
  return {
    budgetMb: optionalInteger(assets, AssetsKey.BudgetMb, `assets.${AssetsKey.BudgetMb}`),
    phoneMaxTexturePx: optionalInteger(assets, AssetsKey.PhoneMaxTexturePx, `assets.${AssetsKey.PhoneMaxTexturePx}`),
    destinations,
  };
}

/** `[physics] enabled`, true when the file has no table or the table no key. */
function physicsEnabled(value: TomlValue | undefined): boolean {
  if (value === undefined) return true;
  const physics = table(value, "[physics]");
  onlyKeys(physics, PHYSICS_KEYS, "[physics]");
  const enabled = physics[PhysicsKey.Enabled];
  if (enabled === undefined) return true;
  if (typeof enabled !== "boolean") throw new ShapeError(`physics.${PhysicsKey.Enabled} must be true or false`);
  return enabled;
}

/** What a `[net]` check answers: the checked table (null when the file has none), or the refusal. */
type NetChecked<T> = { ok: true; value: T } | GenexTomlRefusal;
const netRefused = (detail: string): GenexTomlRefusal => refuse(GenexTomlCode.InvalidNet, detail);
const unknownKeyOf = (found: TomlTable, allowed: readonly string[]) =>
  Object.keys(found).find((key) => !allowed.includes(key));

/**
 * `[net]` checked (G6 MP-5b): every fault of its shape or values is `invalid-net`, so the person
 * reads one code for the one table. `enabled` is required in the table.
 */
function netTable(value: TomlValue | undefined): { ok: true; net: NetToml | null } | GenexTomlRefusal {
  if (value === undefined) return { ok: true, net: null };
  if (!isTable(value)) return netRefused("[net] must be a table");
  const unknown = unknownKeyOf(value, NET_KEYS);
  if (unknown !== undefined) return netRefused(`unknown key "${unknown}" in [net]`);
  const enabled = value[NetKey.Enabled];
  if (typeof enabled !== "boolean") return netRefused(`net.${NetKey.Enabled} must be true or false`);
  const raw = value[NetKey.Matchmaking];
  if (raw === undefined) return { ok: true, net: { enabled, matchmaking: null } };
  const matchmaking = matchmakingOf(raw);
  return matchmaking.ok ? { ok: true, net: { enabled, matchmaking: matchmaking.value } } : matchmaking;
}

/** `[net.matchmaking]`: a preset of the vocabulary, an optional win condition, optional knobs. */
function matchmakingOf(value: TomlValue): NetChecked<NetMatchmaking> {
  const where = `[${NET_TABLE}.${NetKey.Matchmaking}]`;
  if (!isTable(value)) return netRefused(`${where} must be a table`);
  const unknown = unknownKeyOf(value, MATCHMAKING_KEYS);
  if (unknown !== undefined) return netRefused(`unknown key "${unknown}" in ${where}`);
  const preset = value[MatchmakingKey.Preset];
  if (typeof preset !== "string" || !isMatchmakingPreset(preset))
    return netRefused(`${where} ${MatchmakingKey.Preset} ${JSON.stringify(preset ?? null)}`);
  const win = value[MatchmakingKey.WinCondition];
  const winKnown = win === undefined || (typeof win === "string" && isWinCondition(win));
  if (!winKnown) return netRefused(`${where} ${MatchmakingKey.WinCondition} ${JSON.stringify(win)}`);
  const config = knobsOf(value[MatchmakingKey.Config]);
  if (!config.ok) return config;
  return { ok: true, value: { preset, winCondition: win ?? null, config: config.value } };
}

/** `[net.matchmaking.config]`: at most the cap of camelCase knobs, each a number from 0 to the cap. */
function knobsOf(value: TomlValue | undefined): NetChecked<Record<string, number>> {
  const where = `[${NET_TABLE}.${NetKey.Matchmaking}.${MatchmakingKey.Config}]`;
  if (value === undefined) return { ok: true, value: {} };
  if (!isTable(value)) return netRefused(`${where} must be a table`);
  const names = Object.keys(value);
  if (names.length > NET_MATCH_CONFIG_MAX_KEYS) return netRefused(`${where} names ${names.length} knobs`);
  const knobs: Record<string, number> = {};
  for (const name of names) {
    const raw = value[name];
    const number = raw instanceof TomlFloat ? raw.value : raw;
    const fits = typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= NET_MATCH_KNOB_MAX;
    if (!NET_MATCH_KNOB_NAME.test(name) || !fits) return netRefused(`${where} ${JSON.stringify(name)}`);
    knobs[name] = number;
  }
  return { ok: true, value: knobs };
}

function gpuFeatures(value: TomlValue | undefined): readonly string[] {
  if (value === undefined) return [];
  const gpu = table(value, "[gpu]");
  onlyKeys(gpu, GPU_KEYS, "[gpu]");
  const features = gpu.native_features ?? [];
  if (!Array.isArray(features)) throw new ShapeError("gpu.native_features must be an array of strings");
  return features.map((feature) => string(feature, "gpu.native_features"));
}

/** Each `[[texture]]` row names a usage of the vocabulary and an encodable image under `assets/`, and no path twice. */
function checkTextures(rows: readonly RawTexture[]): { ok: true; rows: TextureRow[] } | GenexTomlRefusal {
  const seen = new Set<string>();
  const checked: TextureRow[] = [];
  for (const { path: file, usage } of rows) {
    if (!isTextureUsage(usage)) return refuse(GenexTomlCode.InvalidTextureUsage, `${file} usage ${usage}`);
    if (!isTextureRowPath(file) || seen.has(file)) return refuse(GenexTomlCode.InvalidTextureUsage, file);
    seen.add(file);
    checked.push({ path: file, usage });
  }
  return { ok: true, rows: checked };
}

/**
 * Each `[[asset_group]]` has a free, unreserved name and 1..={@link ASSET_GROUP_PATHS_MAX} distinct
 * globs under `assets/`; at most {@link ASSET_GROUP_MAX} rows. One path in two groups is allowed.
 */
function checkAssetGroups(rows: readonly AssetGroupRow[]): GenexTomlRefusal | null {
  if (rows.length > ASSET_GROUP_MAX) return refuse(GenexTomlCode.InvalidAssetGroup, `${rows.length} groups`);
  const names = new Set<string>();
  for (const { name, paths } of rows) {
    const reserved = RESERVED_ASSET_GROUPS.includes(name.toLowerCase());
    if (!ASSET_GROUP_NAME.test(name) || reserved || names.has(name)) {
      return refuse(GenexTomlCode.InvalidAssetGroup, JSON.stringify(name));
    }
    names.add(name);
    const sized = paths.length > 0 && paths.length <= ASSET_GROUP_PATHS_MAX;
    if (!sized) return refuse(GenexTomlCode.InvalidAssetGroup, `${name} has ${paths.length} paths`);
    const bad = paths.find((glob, at) => !isAssetGlob(glob) || paths.indexOf(glob) !== at);
    if (bad !== undefined) return refuse(GenexTomlCode.InvalidAssetGroup, `${name} ${JSON.stringify(bad)}`);
  }
  return null;
}

/**
 * Whether `glob` stays under `assets/`: the safe asset path rule ({@link isSafeAssetPath}) with
 * `*` and `?` allowed inside a segment and `**` as a whole segment; no other glob syntax.
 */
function isAssetGlob(glob: string): boolean {
  if (glob === "") return false;
  return glob.split("/").every((segment) => {
    if (segment === ANY_SEGMENTS) return true;
    if (!GLOB_SEGMENT.test(segment) || segment.includes(ANY_SEGMENTS)) return false;
    if (/[*?]/.test(segment)) return segment !== "." && segment !== "..";
    return isSafeAssetPath(segment);
  });
}

/** `glob` as an anchored expression over `/`-separated asset paths ({@link AssetGroupRow.paths}). */
function globExpression(glob: string): RegExp {
  const segments = glob.split("/");
  const parts = segments.map((segment, at) => {
    if (segment === ANY_SEGMENTS) return at === segments.length - 1 ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
    const body = segment.replace(/[.*?+^${}()|[\]\\-]/g, (char) => {
      if (char === "*") return "[^/]*";
      return char === "?" ? "[^/]" : `\\${char}`;
    });
    return at === segments.length - 1 ? body : `${body}/`;
  });
  return new RegExp(`^${parts.join("")}$`);
}

/** Each group row's compiled globs: the package step asks once per asset, so a row compiles once. */
const compiledGroups = new WeakMap<AssetGroupRow, readonly RegExp[]>();

/** Whether `rel` (relative to `assets/`, `/`-separated) is a member of `group`: some glob of it matches, case-sensitively. */
export function assetGroupMatches(group: AssetGroupRow, rel: string): boolean {
  let expressions = compiledGroups.get(group);
  if (!expressions) {
    expressions = group.paths.map(globExpression);
    compiledGroups.set(group, expressions);
  }
  return expressions.some((expression) => expression.test(rel));
}

/** Whether `mb` is a budget from the minimum to `maxMb`. */
const budgetFits = (mb: number, maxMb: number) => mb >= ASSET_BUDGET_MIN_MB && mb <= maxMb;

/** Whether `px` is a phone texture cap: a power of two from the smallest cap to the largest. */
const isTextureCap = (px: number) =>
  px >= PHONE_TEXTURE_CAP_MIN_PX && px <= PHONE_TEXTURE_CAP_MAX_PX && (px & (px - 1)) === 0;

/**
 * `[assets]` names budgets from 1 MB to {@link ASSET_BUDGET_MAX_MB}, each destination's at most its
 * hard cap, and a phone texture cap that is a power of two from 512 to 4096 px.
 */
function checkAssets(manifest: GenexToml): GenexTomlRefusal | null {
  const assets = manifest.assets ?? null;
  if (assets === null) return null;
  const { budgetMb, phoneMaxTexturePx } = assets;
  if (budgetMb !== null && !budgetFits(budgetMb, ASSET_BUDGET_MAX_MB))
    return refuse(GenexTomlCode.AssetBudgetOutOfRange, `assets.${AssetsKey.BudgetMb} ${budgetMb}`);
  for (const destination of ASSET_DESTINATIONS) {
    const named = assets.destinations[destination];
    const maxMb = ASSET_BUDGETS[destination].ceilingMb ?? ASSET_BUDGET_MAX_MB;
    if (named !== undefined && !budgetFits(named, maxMb))
      return refuse(GenexTomlCode.AssetBudgetOutOfRange, `assets.${destination}.${AssetsKey.BudgetMb} ${named}`);
  }
  if (phoneMaxTexturePx !== null && !isTextureCap(phoneMaxTexturePx))
    return refuse(GenexTomlCode.InvalidTextureCap, `assets.${AssetsKey.PhoneMaxTexturePx} ${phoneMaxTexturePx}`);
  return null;
}

/**
 * The package budget `target` is measured against: its own `[assets.<destination>]` budget, else
 * `[assets] budget_mb`, else the default (owner call C8), never past the destination's hard cap.
 */
export function assetBudgetOf(assets: AssetsToml | null | undefined, target: BuildTarget): AssetBudget {
  const destination = ASSET_DESTINATION_OF[target];
  const { defaultMb, ceilingMb } = ASSET_BUDGETS[destination];
  const named = assets?.destinations[destination] ?? assets?.budgetMb ?? defaultMb;
  const budgetMb = ceilingMb === null ? named : Math.min(named, ceilingMb);
  return {
    budgetBytes: budgetMb * ASSET_BUDGET_MB_BYTES,
    ceilingBytes: ceilingMb === null ? null : ceilingMb * ASSET_BUDGET_MB_BYTES,
  };
}

/** A web budget the game names is a whole number of MB from the minimum to the ceiling. */
function checkWeb(manifest: GenexToml): GenexTomlRefusal | null {
  const budget = manifest.wasmBudgetMb ?? null;
  if (budget === null || isWebWasmBudgetMb(budget)) return null;
  return refuse(GenexTomlCode.InvalidWebBudget, `web.${WebKey.WasmBudgetMb} ${budget}`);
}

function checkGame(manifest: GenexToml): GenexTomlRefusal | null {
  const title = manifest.title.trim();
  if (title.length === 0 || [...title].length > MAX_TITLE_CHARS)
    return refuse(GenexTomlCode.InvalidTitle, manifest.title);
  const [width, height] = manifest.worldSize;
  const inRange = (side: number) => side >= MIN_WORLD_PX && side <= MAX_WORLD_PX;
  if (!inRange(width) || !inRange(height)) return refuse(GenexTomlCode.InvalidWorldSize, `${width}x${height}`);
  if (manifest.saveName !== null && !validSaveName(manifest.saveName))
    return refuse(GenexTomlCode.InvalidSaveName, manifest.saveName);
  return null;
}

/** The C++ template's save-name rule: letters, digits, space, `_`, `-`, `.`; never `.` or `..`. */
function validSaveName(name: string): boolean {
  const length = [...name].length;
  const sized = length >= 1 && length <= MAX_SAVE_NAME_CHARS;
  return sized && SAVE_NAME.test(name) && name !== "." && name !== "..";
}

function checkCrates(manifest: GenexToml): GenexTomlRefusal | null {
  // A crate off the allowlist may only be one the person approved, which is always an exact pin.
  const offList = manifest.crates.find((crate) => !GAME_CRATE_ALLOWLIST.includes(crate.name) && !approvablePin(crate));
  if (offList) return refuse(GenexTomlCode.CrateNotAllowlisted, offList.name);
  // An approved pin is held to the pin rule (as request and approval take it), the rest to the requirement rule.
  const versionFits = (crate: GameCrate) =>
    GAME_CRATE_ALLOWLIST.includes(crate.name) ? CRATE_VERSION.test(crate.version) : approvablePin(crate);
  const loose = manifest.crates.find((crate) => !versionFits(crate));
  if (loose) return refuse(GenexTomlCode.InvalidCrateVersion, `${loose.name} ${JSON.stringify(loose.version)}`);
  return null;
}

/** A crate off the allowlist the build may accept once the person approved it: a crate name at `=X.Y.Z`. */
function approvablePin(crate: GameCrate): boolean {
  return REQUEST_CRATE_NAME.test(crate.name) && EXACT_CRATE_VERSION.test(crate.version);
}

function checkCrateRequests(manifest: GenexToml): GenexTomlRefusal | null {
  const seen = new Set<string>();
  for (const row of manifest.crateRequests ?? []) {
    const named = REQUEST_CRATE_NAME.test(row.name) && REQUEST_CRATE_VERSION.test(row.version);
    const reasonFits = row.reason === null || [...row.reason].length <= REQUEST_REASON_MAX_CHARS;
    const key = `${row.name}@${row.version}`;
    if (!named || !reasonFits || seen.has(key)) return refuse(GenexTomlCode.InvalidCrateRequest, key);
    seen.add(key);
  }
  return null;
}

function checkWgsl(manifest: GenexToml): GenexTomlRefusal | null {
  const seen = new Set<string>();
  for (const source of manifest.wgsl) {
    if (!validWgslPath(source.path)) return refuse(GenexTomlCode.InvalidWgslPath, source.path);
    if (seen.has(source.path)) return refuse(GenexTomlCode.DuplicateWgslPath, source.path);
    seen.add(source.path);
    const api = checkWgslApi(source);
    if (api) return api;
  }
  return null;
}

/** A source's api: one the facade defined, and one this renderer serves. */
function checkWgslApi(source: WgslSource): GenexTomlRefusal | null {
  const detail = `${source.path} api ${source.api}`;
  if (!WGSL_EXTENSION_APIS.includes(source.api)) return refuse(GenexTomlCode.UnknownExtensionApi, detail);
  if (source.api > NATIVE_EXTENSION_API_VERSION) return refuse(GenexTomlCode.ExtensionApiUnavailable, detail);
  return null;
}

/** Thrown inside {@link checkRender} for a value outside its vocabulary or range. */
class RenderRefused extends Error {
  readonly code: GenexTomlCode;
  constructor(code: GenexTomlCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

const renderRefused = (code: GenexTomlCode, detail: string): never => {
  throw new RenderRefused(code, detail);
};

/** `[render]`'s values checked against the render vocabulary, in the order genex's `manifest.rs` checks them. */
function checkRender(raw: RawRender): { ok: true; render: RenderToml } | GenexTomlRefusal {
  try {
    return { ok: true, render: renderOf(raw) };
  } catch (error) {
    if (error instanceof RenderRefused) return refuse(error.code, error.message);
    throw error;
  }
}

function renderOf(raw: RawRender): RenderToml {
  const formFactors: FormFactor[] = [];
  for (const factor of raw.formFactors) {
    const known = isFormFactor(factor) && !formFactors.includes(factor);
    formFactors.push(known ? factor : renderRefused(GenexTomlCode.InvalidFormFactor, factor));
  }
  const preset = raw.preset === null ? null : presetOf(raw.preset);
  const look = lookOf(raw.look);
  const classes: Partial<Record<DeviceClass, RenderClassOverride>> = {};
  for (const row of raw.classes) {
    const name = isDeviceClass(row.name) ? row.name : renderRefused(GenexTomlCode.UnknownDeviceClass, row.name);
    classes[name] = classOf(row);
  }
  const shadows = raw.shadows === null ? undefined : shadowsOf(raw.shadows);
  const loading = raw.loading === null ? undefined : loadingOf(raw.loading);
  return {
    formFactors,
    preset,
    look,
    classes,
    ...(shadows === undefined ? {} : { shadows }),
    ...(loading === undefined ? {} : { loading }),
  };
}

/** `[render.loading]` with every key it sets within its rule. */
function loadingOf(style: LoadingStyle): LoadingStyle {
  const problem = loadingStyleProblem(style);
  if (problem === null) return style;
  return renderRefused(GenexTomlCode.InvalidRenderLoading, `${problem} ${JSON.stringify(style[problem])}`);
}

/** `[render.shadows]`'s values held to their ranges. */
function shadowsOf(raw: RawShadows): RenderShadows {
  const bad = (key: string, value: number) => renderRefused(GenexTomlCode.InvalidRenderShadows, `${key} ${value}`);
  const shadows: RenderShadows = {};
  if (raw.distance !== null)
    shadows.distance = isShadowDistance(raw.distance) ? raw.distance : bad(ShadowTomlKey.Distance, raw.distance);
  if (raw.blendBand !== null)
    shadows.blendBand = isShadowBlendBand(raw.blendBand) ? raw.blendBand : bad(ShadowTomlKey.BlendBand, raw.blendBand);
  return shadows;
}

function presetOf(preset: string) {
  return isQualityPreset(preset) ? preset : renderRefused(GenexTomlCode.InvalidRenderPreset, preset);
}

function lookOf(raw: RawLook): RenderLook {
  const look: RenderLook = {};
  const strings = new Map(raw.strings);
  const numbers = new Map(raw.numbers);
  const bad = (key: string, value: unknown) =>
    renderRefused(GenexTomlCode.InvalidRenderLook, `${key} ${String(value)}`);
  const tonemapper = strings.get(LookKey.Tonemapper);
  if (tonemapper !== undefined)
    look.tonemapper = isTonemapper(tonemapper) ? tonemapper : bad(LookKey.Tonemapper, tonemapper);
  const exposure = strings.get(LookKey.Exposure);
  if (exposure !== undefined) look.exposure = isExposureMode(exposure) ? exposure : bad(LookKey.Exposure, exposure);
  const metering = strings.get(LookKey.Metering);
  if (metering !== undefined) look.metering = isMetering(metering) ? metering : bad(LookKey.Metering, metering);
  const ev = numbers.get(LookKey.EvCompensation);
  if (ev !== undefined) look.evCompensation = isEvCompensation(ev) ? ev : bad(LookKey.EvCompensation, ev);
  const bloom = numbers.get(LookKey.BloomIntensity);
  if (bloom !== undefined) look.bloomIntensity = isBloomIntensity(bloom) ? bloom : bad(LookKey.BloomIntensity, bloom);
  return { ...look, ...autoExposureOf(numbers, bad), ...effectsOf(raw, bad) };
}

/** The RQ4 effect keys' numbers, each with its range check and the look field it sets. */
const EFFECT_NUMBERS: ReadonlyArray<
  readonly [LookKey, (value: unknown) => value is number, (look: RenderLook, value: number) => void]
> = [
  [LookKey.BloomThreshold, isBloomThreshold, (look, value) => (look.bloomThreshold = value)],
  [LookKey.BloomRadius, isBloomRadius, (look, value) => (look.bloomRadius = value)],
  [LookKey.AoIntensity, isAoIntensity, (look, value) => (look.aoIntensity = value)],
  [LookKey.AoRadius, isAoRadius, (look, value) => (look.aoRadius = value)],
  [LookKey.FogDensity, isFogDensity, (look, value) => (look.fogDensity = value)],
  [LookKey.FogHeightFalloff, isFogHeightFalloff, (look, value) => (look.fogHeightFalloff = value)],
  [LookKey.FogBaseHeight, isFogBaseHeight, (look, value) => (look.fogBaseHeight = value)],
  [LookKey.FogStart, isFogStart, (look, value) => (look.fogStart = value)],
  [LookKey.FogMaxOpacity, isFogOpacity, (look, value) => (look.fogMaxOpacity = value)],
  [LookKey.ContactShadowLength, isContactShadowLength, (look, value) => (look.contactShadowLength = value)],
];

/** Bloom's threshold and spread, GTAO's strength and radius, the fog and the contact shadows' length (RQ4), in file-key order. */
function effectsOf(raw: RawLook, bad: (key: string, value: unknown) => never): RenderLook {
  const look: RenderLook = {};
  const numbers = new Map(raw.numbers);
  for (const [key, valid, set] of EFFECT_NUMBERS) {
    const value = numbers.get(key);
    if (value !== undefined) set(look, valid(value) ? value : bad(key, value));
  }
  const color = new Map(raw.colors).get(LookKey.FogColor);
  if (color !== undefined) {
    if (!isFogColor(color)) bad(LookKey.FogColor, `[${color.join(", ")}]`);
    look.fogColor = [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0];
  }
  const aerial = new Map(raw.booleans).get(LookKey.FogAerialPerspective);
  if (aerial !== undefined) look.fogAerialPerspective = aerial;
  return look;
}

/** Auto exposure's limits (within `±EXPOSURE_EV_LIMIT`, the floor not above the ceiling) and speeds. */
function autoExposureOf(numbers: Map<string, number>, bad: (key: string, value: unknown) => never): RenderLook {
  const look: RenderLook = {};
  const evMin = numbers.get(LookKey.EvMin);
  if (evMin !== undefined) look.evMin = isExposureEv(evMin) ? evMin : bad(LookKey.EvMin, evMin);
  const evMax = numbers.get(LookKey.EvMax);
  if (evMax !== undefined) look.evMax = isExposureEv(evMax) ? evMax : bad(LookKey.EvMax, evMax);
  if (look.evMin !== undefined && look.evMax !== undefined && look.evMin > look.evMax) bad(LookKey.EvMin, look.evMin);
  const up = numbers.get(LookKey.AdaptationSpeedUp);
  if (up !== undefined) look.adaptationSpeedUp = isAdaptationSpeed(up) ? up : bad(LookKey.AdaptationSpeedUp, up);
  const down = numbers.get(LookKey.AdaptationSpeedDown);
  if (down !== undefined)
    look.adaptationSpeedDown = isAdaptationSpeed(down) ? down : bad(LookKey.AdaptationSpeedDown, down);
  return look;
}

function classOf(row: RawClass): RenderClassOverride {
  const where = `render.class.${row.name}`;
  const quality: RenderClassOverride = { features: {} };
  if (row.preset !== null) quality.preset = presetOf(row.preset);
  if (row.renderScale !== null)
    quality.renderScale = isRenderScale(row.renderScale)
      ? row.renderScale
      : renderRefused(GenexTomlCode.InvalidRenderScale, `${where}.render_scale ${row.renderScale}`);
  if (row.fps !== null)
    quality.fps = isFpsTarget(row.fps)
      ? row.fps
      : renderRefused(GenexTomlCode.InvalidRenderFps, `${where}.fps ${row.fps}`);
  Object.assign(quality, lodOf(row));
  for (const [name, on] of row.switches) {
    const feature: RenderFeature = isRenderFeature(name)
      ? name
      : renderRefused(GenexTomlCode.UnknownRenderFeature, `${where}.${name}`);
    quality.features[feature] = on;
  }
  return quality;
}

/** A class table's LOD keys (game systems LOD-06), each refused outside its range. */
function lodOf(row: RawClass): Pick<RenderClassOverride, "lodThresholdPx" | "lodFadeBand" | "farDensity"> {
  const where = `render.class.${row.name}`;
  const bad = (key: string, value: number): never =>
    renderRefused(GenexTomlCode.InvalidRenderLod, `${where}.${key} ${value}`);
  const lod: Pick<RenderClassOverride, "lodThresholdPx" | "lodFadeBand" | "farDensity"> = {};
  if (row.lodThresholdPx !== null)
    lod.lodThresholdPx = isLodThreshold(row.lodThresholdPx)
      ? row.lodThresholdPx
      : bad(QualityKey.LodThresholdPx, row.lodThresholdPx);
  if (row.lodFadeBand !== null)
    lod.lodFadeBand = isLodFadeBand(row.lodFadeBand) ? row.lodFadeBand : bad(QualityKey.LodFadeBand, row.lodFadeBand);
  if (row.farDensity !== null)
    lod.farDensity = isFarDensity(row.farDensity) ? row.farDensity : bad(QualityKey.FarDensity, row.farDensity);
  return lod;
}

function checkEngine(manifest: GenexToml): GenexTomlRefusal | null {
  const ejectedFrom = manifest.engine?.ejectedFrom;
  if (ejectedFrom === undefined || GENEX_RELEASE.test(ejectedFrom)) return null;
  return refuse(GenexTomlCode.InvalidEngine, ejectedFrom);
}

/** A plain relative `/`-separated path ending in `.wgsl`, with no empty, `.` or `..` segment. */
function validWgslPath(rel: string): boolean {
  const plain = !/^[/~]/.test(rel) && !/[\\:\0]/.test(rel) && rel.endsWith(".wgsl");
  return plain && rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function checkFeatures(manifest: GenexToml, names: readonly string[]): GenexTomlResult {
  const features: NativeEnhancedFeature[] = [];
  for (const name of names) {
    if (!isNativeFeature(name)) return refuse(GenexTomlCode.UnknownNativeFeature, name);
    if (features.includes(name)) return refuse(GenexTomlCode.DuplicateNativeFeature, name);
    features.push(name);
  }
  return { ok: true, manifest: { ...manifest, nativeFeatures: features } };
}

// ── Fragments the build lane compiles in ────────────────────────────────────────────────────────

/** A TOML basic string (JSON's escapes are TOML's). */
const tomlString = (value: string): string => JSON.stringify(value);
/** A TOML float, always with a decimal point (so `1` reads back as a float, never an integer). */
const tomlFloat = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** `key = value` lines for the entries of `table` that are set. */
function assignments(table: ReadonlyArray<readonly [string, string | undefined]>): string[] {
  return table.flatMap(([key, value]) => (value === undefined ? [] : [`${key} = ${value}`]));
}

/** One `[render.class.<class>]` table's lines. */
function classLines(name: DeviceClass, quality: RenderClassOverride): string[] {
  const keys: ReadonlyArray<readonly [string, string | undefined]> = [
    [QualityKey.Preset, quality.preset === undefined ? undefined : tomlString(quality.preset)],
    [QualityKey.RenderScale, quality.renderScale === undefined ? undefined : tomlFloat(quality.renderScale)],
    [QualityKey.Fps, quality.fps === undefined ? undefined : String(quality.fps)],
    [QualityKey.LodThresholdPx, quality.lodThresholdPx === undefined ? undefined : tomlFloat(quality.lodThresholdPx)],
    [QualityKey.LodFadeBand, quality.lodFadeBand === undefined ? undefined : tomlFloat(quality.lodFadeBand)],
    [QualityKey.FarDensity, quality.farDensity === undefined ? undefined : tomlFloat(quality.farDensity)],
  ];
  const switches = Object.entries(quality.features).map(([feature, on]) => `${feature} = ${String(on)}`);
  return [`[render.${RenderTomlKey.Class}.${name}]`, ...assignments(keys), ...switches];
}

/** The `[render.shadows]` table's lines. */
function shadowLines({ distance, blendBand }: RenderShadows): string[] {
  const keys: ReadonlyArray<readonly [string, string | undefined]> = [
    [ShadowTomlKey.Distance, distance === undefined ? undefined : String(distance)],
    [ShadowTomlKey.BlendBand, blendBand === undefined ? undefined : tomlFloat(blendBand)],
  ];
  return [`[render.${RenderTomlKey.Shadows}]`, ...assignments(keys)];
}

/** The `[render.loading]` table's lines. */
function loadingLines(style: LoadingStyle): string[] {
  const keys = LOADING_KEYS.map((key) => [key, style[key] === undefined ? undefined : tomlString(style[key])] as const);
  return [`[render.${RenderTomlKey.Loading}]`, ...assignments(keys)];
}

/** The RQ4 effect keys of `look` as `key = value` entries (unset ones left out). */
function effectLines(look: RenderLook): ReadonlyArray<readonly [string, string | undefined]> {
  const float = (value: number | undefined) => (value === undefined ? undefined : tomlFloat(value));
  const color = look.fogColor === undefined ? undefined : `[${look.fogColor.map(tomlFloat).join(", ")}]`;
  const aerial = look.fogAerialPerspective === undefined ? undefined : String(look.fogAerialPerspective);
  return [
    [LookKey.BloomThreshold, float(look.bloomThreshold)],
    [LookKey.BloomRadius, float(look.bloomRadius)],
    [LookKey.AoIntensity, float(look.aoIntensity)],
    [LookKey.AoRadius, float(look.aoRadius)],
    [LookKey.FogDensity, float(look.fogDensity)],
    [LookKey.FogHeightFalloff, float(look.fogHeightFalloff)],
    [LookKey.FogBaseHeight, float(look.fogBaseHeight)],
    [LookKey.FogStart, float(look.fogStart)],
    [LookKey.FogMaxOpacity, float(look.fogMaxOpacity)],
    [LookKey.FogColor, color],
    [LookKey.FogAerialPerspective, aerial],
    [LookKey.ContactShadowLength, float(look.contactShadowLength)],
  ];
}

/**
 * The checked `[render]` table as a `genex.toml` fragment of only `[render]` tables: what the build
 * lane compiles into every destination as `GENEX_RENDER_TOML` (the facade's
 * `RenderConfig::from_build`), which has no game folder to read it from on the web, a phone or an
 * export. The facade parses it back with the same checks.
 */
export function renderTomlFragment(render: RenderToml): string {
  const top: ReadonlyArray<readonly [string, string | undefined]> = [
    [
      RenderTomlKey.FormFactors,
      render.formFactors.length ? `[${render.formFactors.map(tomlString).join(", ")}]` : undefined,
    ],
    [RenderTomlKey.Preset, render.preset === null ? undefined : tomlString(render.preset)],
  ];
  const { look } = render;
  const lookKeys: ReadonlyArray<readonly [string, string | undefined]> = [
    [LookKey.Tonemapper, look.tonemapper === undefined ? undefined : tomlString(look.tonemapper)],
    [LookKey.Exposure, look.exposure === undefined ? undefined : tomlString(look.exposure)],
    [LookKey.Metering, look.metering === undefined ? undefined : tomlString(look.metering)],
    [LookKey.EvCompensation, look.evCompensation === undefined ? undefined : tomlFloat(look.evCompensation)],
    [LookKey.BloomIntensity, look.bloomIntensity === undefined ? undefined : tomlFloat(look.bloomIntensity)],
    [LookKey.EvMin, look.evMin === undefined ? undefined : tomlFloat(look.evMin)],
    [LookKey.EvMax, look.evMax === undefined ? undefined : tomlFloat(look.evMax)],
    [LookKey.AdaptationSpeedUp, look.adaptationSpeedUp === undefined ? undefined : tomlFloat(look.adaptationSpeedUp)],
    [
      LookKey.AdaptationSpeedDown,
      look.adaptationSpeedDown === undefined ? undefined : tomlFloat(look.adaptationSpeedDown),
    ],
    ...effectLines(look),
  ];
  const lines = ["[render]", ...assignments(top), `[render.${RenderTomlKey.Look}]`, ...assignments(lookKeys)];
  for (const [name, quality] of Object.entries(render.classes) as [DeviceClass, RenderClassOverride][]) {
    lines.push(...classLines(name, quality));
  }
  if (render.shadows !== undefined) lines.push(...shadowLines(render.shadows));
  if (render.loading !== undefined) lines.push(...loadingLines(render.loading));
  return `${lines.join("\n")}\n`;
}

/**
 * The checked `[[wgsl]]` rows as a fragment of only `[[wgsl]]` tables (`GENEX_WGSL_TOML`): empty for
 * a game with none, which the lane still compiles in, so a source compiled into the binary is
 * admitted on every destination exactly when the game folder's `genex.toml` declares it.
 */
export function wgslTomlFragment(rows: readonly WgslSource[]): string {
  return rows
    .map(
      (row) => `[[wgsl]]\npath = ${tomlString(row.path)}\nkind = ${tomlString(row.kind)}\napi = ${String(row.api)}\n`,
    )
    .join("");
}

// ── The TOML subset ─────────────────────────────────────────────────────────────────────────────

/** A float the subset read: kept apart from integers, which are plain numbers. */
export class TomlFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** A value the subset reads: an integer is a `number`, a float a {@link TomlFloat}. */
export type TomlValue = string | number | boolean | TomlFloat | TomlValue[] | TomlTable;
/** A table: a null-prototype record, so a key such as `__proto__` is only a key. */
export interface TomlTable {
  [key: string]: TomlValue;
}

/** Text outside the subset; the message names the line. */
export class TomlSyntaxError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const INTEGER = /^[+-]?(0|[1-9](_?[0-9])*)$/;
/** A decimal float: an integer part, then a fraction, an exponent or both. */
const FLOAT = /^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};
/** How many hex digits follow `\u` and `\U`. */
const UNICODE_ESCAPE_DIGITS: Readonly<Record<string, number>> = { u: 4, U: 8 };

/** Whether a value is a table (not an array). */
export function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof TomlFloat);
}

/**
 * Parse a TOML document of the subset described at the top of this module (also what a
 * `Cargo.lock` is). Throws {@link TomlSyntaxError} for anything else, a duplicate key or section
 * included.
 */
export function parseTomlDocument(text: string): TomlTable {
  const reader = new TomlReader(text.startsWith("﻿") ? text.slice(1) : text);
  const root: TomlTable = Object.create(null);
  const tables: HeaderTables = { arrays: new Set(), defined: new Set(), implicit: new Set() };
  let current = root;
  for (;;) {
    reader.skipBlank();
    if (reader.done()) return root;
    if (reader.peek() === "[") current = reader.header(root, tables);
    else reader.keyValue(current);
    reader.endOfLine();
  }
}

/** What the headers made so far: arrays of tables, tables a header defined, and tables made on the way to one. */
interface HeaderTables {
  arrays: Set<TomlValue[]>;
  defined: Set<TomlTable>;
  implicit: Set<TomlTable>;
}

/** A cursor over a TOML text. */
class TomlReader {
  readonly #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  done(): boolean {
    return this.#at >= this.#text.length;
  }

  peek(offset = 0): string {
    return this.#text[this.#at + offset] ?? "";
  }

  fail(why: string): never {
    const line = this.#text.slice(0, this.#at).split("\n").length;
    throw new TomlSyntaxError(`line ${line}: ${why}`);
  }

  /** Skip spaces and tabs. */
  skipSpace(): void {
    while (this.peek() === " " || this.peek() === "\t") this.#at += 1;
  }

  /** Skip a comment to (not past) the end of its line. */
  skipComment(): void {
    if (this.peek() !== "#") return;
    while (!this.done() && this.peek() !== "\n") {
      const code = this.#text.charCodeAt(this.#at);
      if (code < 0x20 && code !== 0x09 && !(code === 0x0d && this.peek(1) === "\n")) this.fail("control character");
      this.#at += 1;
    }
  }

  /** Skip blank lines, comments and the space around them. */
  skipBlank(): void {
    for (;;) {
      this.skipSpace();
      this.skipComment();
      if (!this.newline()) return;
    }
  }

  /** Consume one line ending, if there is one. */
  newline(): boolean {
    if (this.peek() === "\n") this.#at += 1;
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.#at += 2;
    else return false;
    return true;
  }

  endOfLine(): void {
    this.skipSpace();
    this.skipComment();
    if (!this.done() && !this.newline()) this.fail("expected the end of the line");
  }

  expect(text: string): void {
    if (!this.#text.startsWith(text, this.#at)) this.fail(`expected "${text}"`);
    this.#at += text.length;
  }

  /** `[name]`, `[name.sub]` or `[[name]]`: the table that keys after it go into. */
  header(root: TomlTable, tables: HeaderTables): TomlTable {
    const array = this.peek(1) === "[";
    this.expect(array ? "[[" : "[");
    const names = this.headerPath();
    this.expect(array ? "]]" : "]");
    const last = names.at(-1) ?? this.fail("expected a key");
    const parent = names.slice(0, -1).reduce((table, name) => this.subTable(table, name, tables), root);
    const existing = parent[last];
    if (array) return this.arrayTable(parent, last, tables);
    if (existing === undefined) {
      const fresh: TomlTable = Object.create(null);
      parent[last] = fresh;
      tables.defined.add(fresh);
      return fresh;
    }
    // A table first made on the way to a sub-table may be defined once, later.
    const implicit = isTable(existing) && tables.implicit.has(existing);
    if (!implicit) this.fail(`[${names.join(".")}] is defined twice`);
    tables.implicit.delete(existing);
    tables.defined.add(existing);
    return existing;
  }

  /** The dotted key path of a header, up to its closing bracket. */
  headerPath(): string[] {
    const names: string[] = [];
    for (;;) {
      this.skipSpace();
      names.push(this.key());
      this.skipSpace();
      if (this.peek() !== ".") return names;
      this.#at += 1;
    }
  }

  /** `name` under `table` on the way to a header: a table made for it, or the last of an array of tables. */
  subTable(table: TomlTable, name: string, tables: HeaderTables): TomlTable {
    const existing = table[name];
    if (existing === undefined) {
      const made: TomlTable = Object.create(null);
      table[name] = made;
      tables.implicit.add(made);
      return made;
    }
    if (isTable(existing)) return existing;
    const lastOfArray = Array.isArray(existing) && tables.arrays.has(existing) ? existing.at(-1) : undefined;
    if (!isTable(lastOfArray)) return this.fail(`${name} is not a table`);
    return lastOfArray;
  }

  /** A new table appended to the array of tables `name` under `parent`. */
  arrayTable(parent: TomlTable, name: string, tables: HeaderTables): TomlTable {
    const fresh: TomlTable = Object.create(null);
    const existing = parent[name];
    if (existing === undefined) {
      const made = [fresh];
      parent[name] = made;
      tables.arrays.add(made);
    } else if (Array.isArray(existing) && tables.arrays.has(existing)) existing.push(fresh);
    else this.fail(`[[${name}]] redefines a value`);
    return fresh;
  }

  keyValue(into: TomlTable): void {
    const name = this.key();
    this.skipSpace();
    if (this.peek() === ".") this.fail("dotted keys are not read");
    this.expect("=");
    this.skipSpace();
    if (name in into) this.fail(`"${name}" is defined twice`);
    into[name] = this.value();
  }

  key(): string {
    if (this.peek() === '"') return this.basicString();
    if (this.peek() === "'") return this.literalString();
    const start = this.#at;
    while (BARE_KEY.test(this.peek())) this.#at += 1;
    if (this.#at === start) this.fail("expected a key");
    return this.#text.slice(start, this.#at);
  }

  value(): TomlValue {
    const next = this.peek();
    if (next === '"') return this.basicString();
    if (next === "'") return this.literalString();
    if (next === "[") return this.array();
    if (next === "{") return this.fail("inline tables are not read");
    return this.scalar();
  }

  /** An integer, a float or a boolean, up to the next delimiter. */
  scalar(): number | boolean | TomlFloat {
    const start = this.#at;
    while (!this.done() && !/[\s,\]#]/.test(this.peek())) this.#at += 1;
    const word = this.#text.slice(start, this.#at);
    if (word === "true") return true;
    if (word === "false") return false;
    if (INTEGER.test(word)) {
      const number = Number(word.replaceAll("_", ""));
      if (!Number.isSafeInteger(number)) this.fail(`${word} is too large`);
      return number;
    }
    if (!FLOAT.test(word)) this.fail(`"${word}" is not a value this file holds`);
    const float = Number(word.replaceAll("_", ""));
    if (!Number.isFinite(float)) this.fail(`${word} is too large`);
    return new TomlFloat(float);
  }

  array(): TomlValue[] {
    this.expect("[");
    const items: TomlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.peek() === "]") break;
      items.push(this.value());
      this.skipBlank();
      if (this.peek() === ",") this.#at += 1;
      else if (this.peek() !== "]") this.fail("expected , or ]");
    }
    this.#at += 1;
    return items;
  }

  literalString(): string {
    if (this.#text.startsWith("'''", this.#at)) this.fail("multi-line strings are not read");
    this.#at += 1;
    const start = this.#at;
    while (this.peek() !== "'") this.stringCharacter();
    const text = this.#text.slice(start, this.#at);
    this.#at += 1;
    return text;
  }

  basicString(): string {
    if (this.#text.startsWith('"""', this.#at)) this.fail("multi-line strings are not read");
    this.#at += 1;
    let text = "";
    while (this.peek() !== '"') {
      if (this.peek() === "\\") text += this.escape();
      else {
        text += this.peek();
        this.stringCharacter();
      }
    }
    this.#at += 1;
    return text;
  }

  /** Step over one character of a string, refusing its end, a newline or a control character. */
  stringCharacter(): void {
    if (this.done()) this.fail("unterminated string");
    const code = this.#text.charCodeAt(this.#at);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) this.fail("control character in a string");
    this.#at += 1;
  }

  escape(): string {
    const letter = this.peek(1);
    this.#at += 2;
    const simple = SIMPLE_ESCAPES[letter];
    if (simple !== undefined) return simple;
    const digits = UNICODE_ESCAPE_DIGITS[letter] ?? 0;
    const hex = this.#text.slice(this.#at, this.#at + digits);
    if (digits === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== digits) this.fail(`unknown escape \\${letter}`);
    const point = Number.parseInt(hex, 16);
    const scalar = point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
    if (!scalar) this.fail(`\\${letter}${hex} is not a Unicode scalar value`);
    this.#at += digits;
    return String.fromCodePoint(point);
  }
}
