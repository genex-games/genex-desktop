/**
 * The Rust · wgpu renderer's quality vocabulary, shared by the host's `genex.toml` reader
 * (`substrate/genex-toml.ts`), the native wire (`shared/native-contract.ts`: the `renderSettings`
 * verb, `state().volatile.render` and a capture's `render` provenance) and the conformance suite.
 * Browser-safe: the renderer words the presets and classes.
 *
 * Two kinds of setting: a **look** is the game's (tonemapper, exposure, bloom intensity; the same
 * on every preset and device), **quality** is the device's (a preset per device class, each
 * feature's switch, the render scale and the frame-rate target). A device class is a form factor
 * times a performance tier (`desktop-high`, `mobile-mid`); the renderer probes it at boot and the
 * person, `genex.toml` or the `renderSettings` verb may override the preset it picks.
 *
 * Copies held to this one: genex's `manifest.rs` (the `[render]` table) and genex-studio's
 * `wire.rs` (the verb, the volatile key and the provenance), both through
 * `tests/fixtures/native-wire-v2.json`'s `render` block; the harness seed's
 * `loop/native-contract.ts`, through `seed-contracts.test.ts`. Later renderer tiers append values
 * here and in those copies together; a value is never renamed.
 */

import type { LoadingStyle } from "./loading-style.ts";

/** A quality preset: what a device class defaults to, or what the person or a game picks. Wire values. */
export const QualityPreset = {
  /** The device class's own default (the probe decides). Never an effective preset. */
  Auto: "auto",
  Low: "low",
  Medium: "medium",
  High: "high",
  Ultra: "ultra",
} as const;
export type QualityPreset = (typeof QualityPreset)[keyof typeof QualityPreset];

/** A preset a frame is actually drawn with: never `auto`. */
export type EffectivePreset = Exclude<QualityPreset, typeof QualityPreset.Auto>;

/** The effective presets, cheapest first. */
export const EFFECTIVE_PRESETS: readonly EffectivePreset[] = Object.freeze([
  QualityPreset.Low,
  QualityPreset.Medium,
  QualityPreset.High,
  QualityPreset.Ultra,
]);

/** What kind of device a game runs on. The web is classified by the renderer's probe. Wire values. */
export const FormFactor = {
  Desktop: "desktop",
  Mobile: "mobile",
} as const;
export type FormFactor = (typeof FormFactor)[keyof typeof FormFactor];

/** How capable a device is within its form factor. Wire values. */
export const PerformanceTier = {
  Low: "low",
  Mid: "mid",
  High: "high",
  Ultra: "ultra",
} as const;
export type PerformanceTier = (typeof PerformanceTier)[keyof typeof PerformanceTier];

/** A device class, `<form factor>-<tier>`: the classes the renderer's preset table names. Wire values. */
export const DeviceClass = {
  DesktopUltra: "desktop-ultra",
  DesktopHigh: "desktop-high",
  DesktopMid: "desktop-mid",
  /** Old and integrated laptops. */
  DesktopLow: "desktop-low",
  /** Recent iPhones, flagship Android. */
  MobileHigh: "mobile-high",
  /** Older iPhones, mid-range Android (Vulkan 1.1, tile GPUs, thermal limits). */
  MobileMid: "mobile-mid",
  MobileLow: "mobile-low",
} as const satisfies Record<string, `${FormFactor}-${PerformanceTier}`>;
export type DeviceClass = (typeof DeviceClass)[keyof typeof DeviceClass];

/**
 * A renderer feature with its own switch (on or off, per class or by the verb). Turning one off
 * picks its cheaper variant or leaves it out, never refuses the game. Wire values.
 */
export const RenderFeature = {
  Hdr: "hdr",
  Tonemap: "tonemap",
  Exposure: "exposure",
  Ibl: "ibl",
  Sky: "sky",
  Shadows: "shadows",
  ContactShadows: "contact-shadows",
  Bloom: "bloom",
  Ao: "ao",
  Fog: "fog",
  Taa: "taa",
  Upscaler: "upscaler",
  Clustered: "clustered",
  Meshlets: "meshlets",
  Occlusion: "occlusion",
  Prepass: "prepass",
  /** Texture size classes above 256 and Toksvig normal-map mips (a boot knob: kept until reload). */
  TextureQuality: "texture-quality",
  /** Shadow maps for spot lights that ask for one. */
  SpotShadows: "spot-shadows",
  /** The crossfade between levels of detail (off: hard switches). */
  LodFade: "lod-fade",
  /** Impostors past a model's last mesh level (off: the last level stays). */
  Impostors: "impostors",
} as const;
export type RenderFeature = (typeof RenderFeature)[keyof typeof RenderFeature];

/** Why a frame runs with less than asked: `state().volatile.render.degraded`. Typed, never prose. Wire values. */
export const DegradeReason = {
  /** A custom pass at extension API v1 in the world (after-opaque, after-transparent): the frame stays LDR. */
  CustomPassV1InWorld: "custom-pass-v1-in-world",
  /** A v1 custom material in a frame that asked for HDR: the frame stays LDR. */
  MaterialV1InHdr: "material-v1-in-hdr",
  /** The preset did not fit the class's memory budget: one entry per rung stepped down, the subject naming it (`ao`, `shadow-size`, ...). */
  Budget: "budget",
  /** The class's scene format cannot be rendered to on this adapter: the next one is used. */
  FormatUnrenderable: "format-unrenderable",
  /** A custom pass's declared bytes are over its share of the budget. */
  PassOverBudget: "pass-over-budget",
  /** A pipeline-shaping change waits for the next loading point, or (a studio run) for its renderer to compile off the frame thread. */
  PipelineChangeDeferred: "pipeline-change-deferred",
  /** Transient attachments are not offered: they are allocated in full. */
  TransientUnsupported: "transient-unsupported",
  /** The preset asks for a knob this build does not draw yet (it arrives with its tier); the subject names it. */
  NotLanded: "not-landed",
} as const;
export type DegradeReason = (typeof DegradeReason)[keyof typeof DegradeReason];

/** The tonemapper a game's look uses. The default keeps today's picture. Wire values. */
export const Tonemapper = {
  KhronosNeutral: "khronos-neutral",
  Agx: "agx",
  Aces: "aces",
  None: "none",
  /** AgX with the punchy look: AgX's highlights, saturation and mid contrast kept. */
  AgxPunchy: "agx-punchy",
} as const;
export type Tonemapper = (typeof Tonemapper)[keyof typeof Tonemapper];

/** Whether exposure is fixed by the game or adapts to the scene. Wire values. */
export const ExposureMode = {
  Manual: "manual",
  Auto: "auto",
} as const;
export type ExposureMode = (typeof ExposureMode)[keyof typeof ExposureMode];

/** Where auto exposure looks (`ground`: sky-aware, the lower rows weigh more). Wire values. */
export const Metering = {
  Average: "average",
  Center: "center",
  Spot: "spot",
  Ground: "ground",
} as const;
export type Metering = (typeof Metering)[keyof typeof Metering];

/**
 * The keys of `genex.toml`'s `[render.look]`: the game's look, equal on every preset. Exposure is in
 * relative scene units (EV 0 is an exposure of 1.0; no aperture, shutter or ISO): auto exposure
 * meters the scene's EV, clamps it to `ev_min..=ev_max` and adapts by at most
 * `adaptation_speed_up` / `adaptation_speed_down` EV per simulated second. Bloom is threshold-free
 * and energy-conserving unless `bloom_threshold` asks for a stylistic knee; fog in-scatters the
 * environment (tinted by `fog_color`) and is off at the default density 0. Wire values.
 */
export const LookKey = {
  Tonemapper: "tonemapper",
  Exposure: "exposure",
  Metering: "metering",
  EvCompensation: "ev_compensation",
  BloomIntensity: "bloom_intensity",
  EvMin: "ev_min",
  EvMax: "ev_max",
  AdaptationSpeedUp: "adaptation_speed_up",
  AdaptationSpeedDown: "adaptation_speed_down",
  BloomThreshold: "bloom_threshold",
  BloomRadius: "bloom_radius",
  AoIntensity: "ao_intensity",
  AoRadius: "ao_radius",
  FogDensity: "fog_density",
  FogHeightFalloff: "fog_height_falloff",
  FogBaseHeight: "fog_base_height",
  FogStart: "fog_start",
  FogMaxOpacity: "fog_max_opacity",
  FogColor: "fog_color",
  FogAerialPerspective: "fog_aerial_perspective",
  ContactShadowLength: "contact_shadow_length",
  /** Local exposure: how strongly bright regions come down towards middle grey (1: not at all). */
  LocalExposureHighlights: "local_exposure_highlights",
  /** Local exposure: how strongly dark regions come up towards middle grey (1: not at all). */
  LocalExposureShadows: "local_exposure_shadows",
} as const;
export type LookKey = (typeof LookKey)[keyof typeof LookKey];

/**
 * The keys of a `[render.class.<class>]` table besides the feature switches (each a
 * {@link RenderFeature} set to true or false). Wire values.
 */
export const QualityKey = {
  Preset: "preset",
  RenderScale: "render_scale",
  Fps: "fps",
  /** The error a drawn level of detail may show, output pixels. */
  LodThresholdPx: "lod_threshold_px",
  /** The LOD crossfade band, a share of the threshold (0: hard switches). */
  LodFadeBand: "lod_fade_band",
  /** The share of far-field copies kept. */
  FarDensity: "far_density",
} as const;
export type QualityKey = (typeof QualityKey)[keyof typeof QualityKey];

/** The keys of `genex.toml`'s `[render]` table. Build destinations stay the project's own `targets`. Wire values. */
export const RenderTomlKey = {
  FormFactors: "form_factors",
  Preset: "preset",
  Look: "look",
  Class: "class",
  Shadows: "shadows",
  /** The loading screen (`shared/loading-style.ts`). */
  Loading: "loading",
} as const;
export type RenderTomlKey = (typeof RenderTomlKey)[keyof typeof RenderTomlKey];

/** The keys of `genex.toml`'s `[render.shadows]` table: the sun's shadows on every preset. Wire values. */
export const ShadowTomlKey = {
  /** How far from the camera the shadows reach, whole world units. */
  Distance: "distance",
  /** The share of each cascade's depth range blended into the next. */
  BlendBand: "blend_band",
} as const;
export type ShadowTomlKey = (typeof ShadowTomlKey)[keyof typeof ShadowTomlKey];

/** Where a capture's settings came from. Captures never read the person's saved overrides. Wire values. */
export const SettingsSource = {
  /** The game's `genex.toml` `[render]` preset. */
  Toml: "toml",
  /** The fixed reference class the host recorded for this adapter. */
  ReferenceClass: "reference-class",
  /** The `renderSettings` verb in this session. */
  Verb: "verb",
} as const;
export type SettingsSource = (typeof SettingsSource)[keyof typeof SettingsSource];

/** How a capture's exposure was settled. Wire values. */
export const CaptureExposure = {
  /** Converged at once: no adaptation history. */
  Instant: "instant",
} as const;
export type CaptureExposure = (typeof CaptureExposure)[keyof typeof CaptureExposure];

/**
 * Optional adapter features the renderer requests for itself when offered (never a game's
 * declaration, never a WGSL capability): the receipt's `rendererFeatures`. Wire values.
 */
export const RendererFeature = {
  TimestampQuery: "timestamp-query",
  Rg11b10UfloatRenderable: "rg11b10ufloat-renderable",
  DepthClipControl: "depth-clip-control",
  /** Compressed material textures (BC7, ASTC 4x4, ETC2 RGBA8). */
  TextureCompressionBc: "texture-compression-bc",
  TextureCompressionAstc: "texture-compression-astc",
  TextureCompressionEtc2: "texture-compression-etc2",
} as const;
export type RendererFeature = (typeof RendererFeature)[keyof typeof RendererFeature];

/** A frame input a v2 extension may read; the receipt's `renderInputs` lists those really produced. Wire values. */
export const RenderInput = {
  Depth: "depth",
  Normals: "normals",
  Motion: "motion",
  Environment: "environment",
  HdrScene: "hdr-scene",
} as const;
export type RenderInput = (typeof RenderInput)[keyof typeof RenderInput];

/** Where a Level-2 post pass (`gfx.post_pass(path, stage)`) runs. Wire values. */
export const PostPassStage = {
  /** After the tonemap, on the display-ready frame (extension API v1's place). */
  Ldr: "ldr",
  /** Before bloom and the tonemap, on linear HDR at render size (extension API v2). */
  Hdr: "hdr",
} as const;
export type PostPassStage = (typeof PostPassStage)[keyof typeof PostPassStage];

/** What a game answers a `renderSettings` it refuses (`{ok: false, error}`). Wire values. */
export const RenderSettingsRefusal = {
  /** The game knows the verb but this build cannot serve it yet. */
  Unavailable: "unavailable",
  UnknownPreset: "unknown-preset",
  UnknownDeviceClass: "unknown-device-class",
  UnknownFeature: "unknown-render-feature",
  /** A scale lock outside `RENDER_SCALE_MIN..=RENDER_SCALE_MAX`. */
  InvalidScale: "invalid-render-scale",
  /** A frame budget outside `FRAME_BUDGET_MS_MIN..=FRAME_BUDGET_MS_MAX`. */
  InvalidFrameBudget: "invalid-frame-budget",
  /** A `look` the game cannot read as `[render.look]` keys (an unknown key, a wrong value). */
  InvalidLook: "invalid-look",
} as const;
export type RenderSettingsRefusal = (typeof RenderSettingsRefusal)[keyof typeof RenderSettingsRefusal];

/** The lowest and highest render scale (of the output size) a class, a lock or `genex.toml` may name. */
export const RENDER_SCALE_MIN = 0.5;
export const RENDER_SCALE_MAX = 1;
/**
 * The shortest and longest frame time `renderSettings` may ask dynamic resolution to hold, in
 * milliseconds (this session only): a budget under the class's own makes a fast GPU show how the
 * scale steps down, as a weaker device would.
 */
export const FRAME_BUDGET_MS_MIN = 1;
export const FRAME_BUDGET_MS_MAX = 100;
/** The frame-rate targets a class may hold. The simulation ticks at 60 Hz, so no more is drawn. */
export const RENDER_FPS_TARGETS: readonly number[] = Object.freeze([30, 60]);
/** The largest exposure compensation either way, in EV. */
export const EV_COMPENSATION_LIMIT = 10;
/** The strongest bloom a look may ask for (an energy-conserving mix). */
export const BLOOM_INTENSITY_MAX = 1;
/** The largest auto exposure limit (`ev_min`, `ev_max`) either way, in EV. */
export const EXPOSURE_EV_LIMIT = 16;
/** The fastest auto exposure adaptation, in EV per second. */
export const ADAPTATION_SPEED_MAX = 20;
/** The highest bloom threshold a look may ask for, in pre-exposed scene units (0: threshold-free). */
export const BLOOM_THRESHOLD_MAX = 16;
/** The narrowest and widest bloom spread (a multiplier on the upsample filter's radius). */
export const BLOOM_RADIUS_MIN = 0.25;
export const BLOOM_RADIUS_MAX = 4;
/** The strongest ambient occlusion (GTAO). */
export const AO_INTENSITY_MAX = 1;
/** The largest ambient occlusion radius, in world units (above 0). */
export const AO_RADIUS_MAX = 8;
/** The densest fog, per world unit. */
export const FOG_DENSITY_MAX = 1;
/** The steepest fog height falloff, per world unit. */
export const FOG_HEIGHT_FALLOFF_MAX = 10;
/** The largest fog base height either way and fog start distance, in world units. */
export const FOG_DISTANCE_LIMIT = 100_000;
/** The brightest fog colour channel (linear, scene units). */
export const FOG_COLOR_MAX = 16;
/** The longest contact-shadow ray, in world units (above 0). */
export const CONTACT_SHADOW_LENGTH_MAX = 2;
/** The lowest local exposure contrast (genex-render's `local_exposure::CONTRAST_MIN`); 1 is off. */
export const LOCAL_EXPOSURE_CONTRAST_MIN = 0.25;
/** The shortest and longest shadow distance a game may ask for, whole world units (genex-render's `SHADOW_DISTANCE_MIN_M`, `SHADOW_DISTANCE_MAX_M`). */
export const SHADOW_DISTANCE_MIN = 10;
export const SHADOW_DISTANCE_MAX = 400;
/** The widest cascade blend band, a share of a cascade's depth range (genex-render's `SHADOW_BLEND_BAND_MAX`). */
export const SHADOW_BLEND_BAND_MAX = 0.5;
/** The finest and coarsest LOD threshold a game may ask for, output pixels (genex-render's `LOD_THRESHOLD_PX_MIN`, `LOD_THRESHOLD_PX_MAX`). */
export const LOD_THRESHOLD_PX_MIN = 0.5;
export const LOD_THRESHOLD_PX_MAX = 8;
/** The widest LOD crossfade band, a share of the threshold (genex-render's `LOD_FADE_BAND_MAX`). */
export const LOD_FADE_BAND_MAX = 0.5;
/** The smallest share of far-field copies a game may keep (genex-render's `FAR_DENSITY_MIN`). */
export const FAR_DENSITY_MIN = 0.1;
/** The `[[wgsl]] api` versions the facade has defined; the host admits those up to `NATIVE_EXTENSION_API_VERSION`. */
export const WGSL_EXTENSION_APIS: readonly number[] = Object.freeze([1, 2]);

// ── meshlets (R2): the `genex_meshlets` glTF extras the importer writes and the renderer reads ──

/** The member of a glTF primitive's `extras` holding its meshlets: never an extension, never in `extensionsRequired`. */
export const MESHLETS_EXTRAS_KEY = "genex_meshlets";
/** The `genex_meshlets` schema version the renderer reads; another version is ignored (the mesh clusters at runtime). */
export const MESHLET_SCHEMA_VERSION = 1;
/** Most vertices and triangles in one meshlet. */
export const MESHLET_MAX_VERTICES = 64;
export const MESHLET_MAX_TRIANGLES = 124;
/** Bytes of one meshlet record in the `meshlets` bufferView (little-endian, the renderer's `GpuMeshlet`). */
export const MESHLET_RECORD_BYTES = 48;
/** The fewest triangles a mesh needs to be split into meshlets, unless the game sets its own. */
export const MESHLET_MIN_TRIANGLES_DEFAULT = 2048;

/**
 * The members of the `genex_meshlets` extras object: the schema version, the limits the set was
 * built with, and the bufferView indices of the meshlet records, the meshlet vertices (one `u32`
 * primitive vertex index each) and the packed triangles (three local indices, one byte each, low
 * byte first, in a `u32`). Wire values.
 */
export const MeshletExtrasKey = {
  Version: "version",
  MaxVertices: "max_vertices",
  MaxTriangles: "max_triangles",
  Meshlets: "meshlets",
  Vertices: "vertices",
  Triangles: "triangles",
} as const;
export type MeshletExtrasKey = (typeof MeshletExtrasKey)[keyof typeof MeshletExtrasKey];

/** Why the renderer drops a primitive's `genex_meshlets` and clusters it at runtime instead: the typed warning. Wire values. */
export const MeshletFault = {
  UnknownVersion: "meshlets-unknown-version",
  OverLimit: "meshlets-over-limit",
  RangeOutOfBounds: "meshlets-range-out-of-bounds",
  RangesNotTiled: "meshlets-ranges-not-tiled",
  VertexOutOfMesh: "meshlets-vertex-out-of-mesh",
  LocalIndexOutOfMeshlet: "meshlets-local-index-out-of-meshlet",
  TrianglesDiffer: "meshlets-triangles-differ",
} as const;
export type MeshletFault = (typeof MeshletFault)[keyof typeof MeshletFault];

// ── LODs (renderer pass 2, A6.9): the `genex_lods` glTF extras the importer writes and the renderer reads ──

/** The member of a glTF primitive's `extras` holding its simplified levels: never an extension. */
export const LODS_EXTRAS_KEY = "genex_lods";
/** The `genex_lods` schema version the renderer reads; another version is ignored (the mesh draws whole). */
export const LOD_SCHEMA_VERSION = 1;
/** Most levels past the primitive's own triangles. */
export const LOD_MAX_LEVELS = 4;
/** The fewest triangles a GLB needs to get import-time levels. */
export const LOD_MIN_TRIANGLES = 512;

/**
 * The members of the `genex_lods` extras object: the schema version, the bufferView of every
 * level's triangle list (little-endian `u32` primitive vertex indices, level after level), the
 * levels, coarser and coarser, and how many of the first levels only shadow casters draw (lane FR:
 * 1 for a finer level measured on positions alone, absent for none). Wire values.
 */
export const LodExtrasKey = { Version: "version", Indices: "indices", Levels: "levels", Casters: "casters" } as const;
/** The most leading levels a chain may keep for its shadow casters alone (lane FR). */
export const LOD_MAX_CASTER_LEVELS = 1;
export type LodExtrasKey = (typeof LodExtrasKey)[keyof typeof LodExtrasKey];

/**
 * The members of one level: its first index in the view, its index count, and its simplification
 * error, an object-space distance (meshoptimizer's relative error times the mesh's extent). Wire values.
 */
export const LodLevelKey = { First: "first", Count: "count", Error: "error" } as const;
export type LodLevelKey = (typeof LodLevelKey)[keyof typeof LodLevelKey];

/** Why the renderer drops a primitive's `genex_lods` (the mesh then draws whole): the typed warning. Wire values. */
export const LodFault = {
  UnknownVersion: "lods-unknown-version",
  OverLimit: "lods-over-limit",
  RangeOutOfBounds: "lods-range-out-of-bounds",
  VertexOutOfMesh: "lods-vertex-out-of-mesh",
  NotCoarser: "lods-not-coarser",
} as const;
export type LodFault = (typeof LodFault)[keyof typeof LodFault];

// ── genex.toml's [render] ───────────────────────────────────────────────────────────────────────

/** A game's look from `[render.look]`; a key left out keeps the facade's default. */
export interface RenderLook {
  tonemapper?: Tonemapper;
  exposure?: ExposureMode;
  metering?: Metering;
  evCompensation?: number;
  bloomIntensity?: number;
  /** Auto exposure's lowest metered EV (at most `evMax`). */
  evMin?: number;
  evMax?: number;
  /** EV per second auto exposure brightens by. */
  adaptationSpeedUp?: number;
  /** EV per second auto exposure darkens by. */
  adaptationSpeedDown?: number;
  /** Bloom's optional threshold in scene units (0: threshold-free). */
  bloomThreshold?: number;
  /** Bloom's spread, a multiplier on its filter radius. */
  bloomRadius?: number;
  aoIntensity?: number;
  /** Ambient occlusion's radius in world units. */
  aoRadius?: number;
  /** Fog's extinction per world unit at its base height (0: no fog). */
  fogDensity?: number;
  fogHeightFalloff?: number;
  fogBaseHeight?: number;
  /** The distance from the camera where fog starts. */
  fogStart?: number;
  fogMaxOpacity?: number;
  /** Linear rgb: the tint on the environment's in-scatter. */
  fogColor?: readonly [number, number, number];
  /** Whether the aerial-perspective volume adds the sky's scattering where the quality has it. */
  fogAerialPerspective?: boolean;
  /** Contact shadows' ray length in world units. */
  contactShadowLength?: number;
  /** Local exposure's contrast above middle grey (lower brings bright regions down more; 1: off). */
  localExposureHighlights?: number;
  /** Local exposure's contrast below middle grey (lower brings dark regions up more; 1: off). */
  localExposureShadows?: number;
}

/** One `[render.class.<class>]` table: the quality a game asks for on that class. */
export interface RenderClassOverride {
  preset?: QualityPreset;
  renderScale?: number;
  fps?: number;
  /** `lod_threshold_px`: output pixels, `LOD_THRESHOLD_PX_MIN..=LOD_THRESHOLD_PX_MAX`. */
  lodThresholdPx?: number;
  /** `lod_fade_band`: `0..=LOD_FADE_BAND_MAX`. */
  lodFadeBand?: number;
  /** `far_density`: `FAR_DENSITY_MIN..=1`. */
  farDensity?: number;
  /** Each switch the table names, in file order. */
  features: Partial<Record<RenderFeature, boolean>>;
}

/** `genex.toml`'s `[render]`: the form factors the game is made for, its preset, look and class overrides. */
export interface RenderToml {
  /** Empty when the table names none (every form factor). */
  formFactors: readonly FormFactor[];
  preset: QualityPreset | null;
  look: RenderLook;
  /** By class, in file order. */
  classes: Partial<Record<DeviceClass, RenderClassOverride>>;
  /** `[render.shadows]`: the sun's shadows on every preset (a key left out keeps each preset's own). */
  shadows?: RenderShadows;
  /** `[render.loading]`: the loading screen every destination shows (a key left out takes the default). */
  loading?: LoadingStyle;
}

/** `genex.toml`'s `[render.shadows]`, held to each device class's caps (a phone reaches 40 units at most). */
export interface RenderShadows {
  /** How far from the camera the shadows reach, whole world units. */
  distance?: number;
  /** The share of each cascade's depth range blended into the next (0: a hard switch). */
  blendBand?: number;
}

// ── the wire: renderSettings, volatile.render and capture provenance ───────────────────────────

/** What `renderSettings {set}` changes; a member left out stays as it is. */
export interface RenderSettingsChange {
  /** The preset to use; null gives the game's `[render]` and the person's own choice back. */
  preset?: QualityPreset | null;
  /** Emulate a device class (a judge capturing "as a phone"); null gives the probed class back. */
  deviceClass?: DeviceClass | null;
  /** Feature switches; null gives back the switches this verb set earlier. */
  features?: Partial<Record<RenderFeature, boolean>> | null;
  /** Hold the dynamic-resolution controller at this scale; null lets it move again. */
  renderScaleLock?: number | null;
  /** The frame time, in ms, dynamic resolution holds instead of the class's; null gives the class's back. */
  frameBudgetMs?: number | null;
  /** `[render.look]` keys the game overlays on its look, no rebuild (the game checks them); null gives its look back. */
  look?: Record<string, unknown> | null;
}

/** What `renderSettings` answers: the settings in force after the call. */
export interface RenderSettingsAnswer {
  preset: EffectivePreset;
  /** What was asked for (`auto` follows the class). */
  requested: QualityPreset;
  deviceClass: DeviceClass;
  /** What the probe found, whatever is emulated. */
  detectedClass: DeviceClass;
  features: Partial<Record<RenderFeature, boolean>>;
  renderScaleLock: number | null;
  /** The verb's frame budget, if one is held (a game built before it leaves it out). */
  frameBudgetMs?: number | null;
  /** The render scale of the last frame. */
  scale: number;
}

/** One reason the frame runs with less than asked, and what it concerns (a pass name, a feature) when it says. */
export interface RenderDegrade {
  reason: DegradeReason;
  subject: string | null;
}

/** `state().volatile.render`: what the renderer runs with. Outside the checksum; never compared. */
export interface RenderStatus {
  deviceClass: DeviceClass;
  preset: EffectivePreset;
  scale: number;
  features: Partial<Record<RenderFeature, boolean>>;
  degraded: RenderDegrade[];
  /** GPU milliseconds (p50 of the window), null without timestamp queries. */
  gpuMs: number | null;
  /** CPU encode and submit milliseconds (p50 of the window). */
  cpuMs: number | null;
  /** Frames that ran the graph and frames that re-presented the last one, since boot. */
  frames?: { rendered: number; repeated: number };
}

/**
 * A capture's `render` provenance: a capture is a pure function of (state, camera, these settings,
 * the adapter, the build). `settleFrames` frames re-rendered from one Sim state on capture-owned
 * history; `historyReset` says that history started empty.
 */
export interface CaptureProvenance {
  preset: EffectivePreset;
  deviceClass: DeviceClass;
  settingsSource: SettingsSource;
  scale: number;
  settleFrames: number;
  historyReset: boolean;
  exposure: CaptureExposure;
}

/** The most settle frames a capture re-renders (the longest jitter cycle). */
export const CAPTURE_SETTLE_FRAMES_MAX = 16;
/** The most degrade entries `volatile.render` lists, and the longest subject. */
const DEGRADED_MAX = 64;
const SUBJECT_MAX_CHARS = 256;
/** The largest millisecond figure a status reports. */
const MS_MAX = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether `value` is one of `vocabulary`'s values. */
const member =
  <T extends string>(vocabulary: Record<string, T>) =>
  (value: unknown): value is T =>
    typeof value === "string" && (Object.values(vocabulary) as string[]).includes(value);

export const isQualityPreset = member(QualityPreset);
export const isEffectivePreset = (value: unknown): value is EffectivePreset =>
  isQualityPreset(value) && value !== QualityPreset.Auto;
export const isDeviceClass = member(DeviceClass);
export const isFormFactor = member(FormFactor);
export const isRenderFeature = member(RenderFeature);
export const isDegradeReason = member(DegradeReason);
export const isSettingsSource = member(SettingsSource);
export const isCaptureExposure = member(CaptureExposure);
export const isRendererFeature = member(RendererFeature);
export const isRenderInput = member(RenderInput);
export const isTonemapper = member(Tonemapper);
export const isExposureMode = member(ExposureMode);
export const isMetering = member(Metering);

/** A render scale inside `RENDER_SCALE_MIN..=RENDER_SCALE_MAX`. */
export function isRenderScale(value: unknown): value is number {
  return typeof value === "number" && value >= RENDER_SCALE_MIN && value <= RENDER_SCALE_MAX;
}

/** A frame budget inside `FRAME_BUDGET_MS_MIN..=FRAME_BUDGET_MS_MAX`. */
export function isFrameBudgetMs(value: unknown): value is number {
  return typeof value === "number" && value >= FRAME_BUDGET_MS_MIN && value <= FRAME_BUDGET_MS_MAX;
}

/** A held frame budget in an answer: absent (a game built before it), none, or inside its range. */
function isHeldFrameBudget(value: unknown): boolean {
  return value === undefined || value === null || isFrameBudgetMs(value);
}

/** A frame-rate target a class may hold. */
export function isFpsTarget(value: unknown): value is number {
  return typeof value === "number" && RENDER_FPS_TARGETS.includes(value);
}

/** An exposure compensation within `±EV_COMPENSATION_LIMIT`. */
export function isEvCompensation(value: unknown): value is number {
  return typeof value === "number" && Math.abs(value) <= EV_COMPENSATION_LIMIT;
}

/** A bloom intensity within `0..=BLOOM_INTENSITY_MAX`. */
export function isBloomIntensity(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= BLOOM_INTENSITY_MAX;
}

/** An auto exposure limit within `±EXPOSURE_EV_LIMIT`. */
export function isExposureEv(value: unknown): value is number {
  return typeof value === "number" && Math.abs(value) <= EXPOSURE_EV_LIMIT;
}

/** An adaptation speed in `(0, ADAPTATION_SPEED_MAX]` EV per second. */
export function isAdaptationSpeed(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= ADAPTATION_SPEED_MAX;
}

/** A number within `min..=max`. */
const within =
  (min: number, max: number) =>
  (value: unknown): value is number =>
    typeof value === "number" && value >= min && value <= max;
/** A number in `(0, max]`. */
const positiveUpTo =
  (max: number) =>
  (value: unknown): value is number =>
    typeof value === "number" && value > 0 && value <= max;

/** A bloom threshold within `0..=BLOOM_THRESHOLD_MAX`. */
export const isBloomThreshold = within(0, BLOOM_THRESHOLD_MAX);
/** A bloom spread within `BLOOM_RADIUS_MIN..=BLOOM_RADIUS_MAX`. */
export const isBloomRadius = within(BLOOM_RADIUS_MIN, BLOOM_RADIUS_MAX);
/** An ambient occlusion strength within `0..=AO_INTENSITY_MAX`. */
export const isAoIntensity = within(0, AO_INTENSITY_MAX);
/** An ambient occlusion radius in `(0, AO_RADIUS_MAX]`. */
export const isAoRadius = positiveUpTo(AO_RADIUS_MAX);
/** A fog density within `0..=FOG_DENSITY_MAX`. */
export const isFogDensity = within(0, FOG_DENSITY_MAX);
/** A fog height falloff within `0..=FOG_HEIGHT_FALLOFF_MAX`. */
export const isFogHeightFalloff = within(0, FOG_HEIGHT_FALLOFF_MAX);
/** A fog base height within `±FOG_DISTANCE_LIMIT`. */
export const isFogBaseHeight = within(-FOG_DISTANCE_LIMIT, FOG_DISTANCE_LIMIT);
/** A fog start distance within `0..=FOG_DISTANCE_LIMIT`. */
export const isFogStart = within(0, FOG_DISTANCE_LIMIT);
/** A fog opacity within `0..=1`. */
export const isFogOpacity = within(0, 1);
/** A contact-shadow length in `(0, CONTACT_SHADOW_LENGTH_MAX]`. */
export const isContactShadowLength = positiveUpTo(CONTACT_SHADOW_LENGTH_MAX);
/** A local exposure contrast within `LOCAL_EXPOSURE_CONTRAST_MIN..=1`. */
export const isLocalExposureContrast = within(LOCAL_EXPOSURE_CONTRAST_MIN, 1);
/** A shadow distance: a whole number within `SHADOW_DISTANCE_MIN..=SHADOW_DISTANCE_MAX`. */
export const isShadowDistance = (value: unknown): value is number =>
  Number.isInteger(value) && within(SHADOW_DISTANCE_MIN, SHADOW_DISTANCE_MAX)(value);
/** A cascade blend band within `0..=SHADOW_BLEND_BAND_MAX`. */
export const isShadowBlendBand = within(0, SHADOW_BLEND_BAND_MAX);
/** A LOD threshold within `LOD_THRESHOLD_PX_MIN..=LOD_THRESHOLD_PX_MAX` output pixels. */
export const isLodThreshold = within(LOD_THRESHOLD_PX_MIN, LOD_THRESHOLD_PX_MAX);
/** A LOD crossfade band within `0..=LOD_FADE_BAND_MAX`. */
export const isLodFadeBand = within(0, LOD_FADE_BAND_MAX);
/** A far-field density within `FAR_DENSITY_MIN..=1`. */
export const isFarDensity = within(FAR_DENSITY_MIN, 1);

/** A fog colour: three linear channels, each within `0..=FOG_COLOR_MAX`. */
export function isFogColor(value: unknown): value is readonly [number, number, number] {
  const channel = within(0, FOG_COLOR_MAX);
  return Array.isArray(value) && value.length === 3 && value.every(channel);
}

/** A feature-switch record: known features only, each true or false. */
export function isFeatureSwitches(value: unknown): value is Partial<Record<RenderFeature, boolean>> {
  return isRecord(value) && Object.entries(value).every(([key, on]) => isRenderFeature(key) && typeof on === "boolean");
}

const isMs = (value: unknown): value is number =>
  value === null || (typeof value === "number" && value >= 0 && value <= MS_MAX);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Whether `value` is a `renderSettings` answer in its shape. */
export function isRenderSettingsAnswer(value: unknown): value is RenderSettingsAnswer {
  if (!isRecord(value)) return false;
  const classes = isDeviceClass(value.deviceClass) && isDeviceClass(value.detectedClass);
  const lock = value.renderScaleLock === null || isRenderScale(value.renderScaleLock);
  const budget = isHeldFrameBudget(value.frameBudgetMs);
  const presets = isEffectivePreset(value.preset) && isQualityPreset(value.requested);
  const held = lock && budget;
  return presets && classes && held && isFeatureSwitches(value.features) && isRenderScale(value.scale);
}

function isDegrade(value: unknown): value is RenderDegrade {
  if (!isRecord(value) || !isDegradeReason(value.reason)) return false;
  const subject = value.subject;
  return subject === null || (typeof subject === "string" && subject.length <= SUBJECT_MAX_CHARS);
}

function isDegradeList(value: unknown): value is RenderDegrade[] {
  return Array.isArray(value) && value.length <= DEGRADED_MAX && value.every(isDegrade);
}

function isFrameCounts(value: unknown): boolean {
  return value === undefined || (isRecord(value) && isCount(value.rendered) && isCount(value.repeated));
}

/** Whether `value` is a `volatile.render` status in its shape. */
export function isRenderStatus(value: unknown): value is RenderStatus {
  if (!isRecord(value) || !isDeviceClass(value.deviceClass) || !isEffectivePreset(value.preset)) return false;
  const timed = isMs(value.gpuMs) && isMs(value.cpuMs);
  const settings = isRenderScale(value.scale) && isFeatureSwitches(value.features);
  return isDegradeList(value.degraded) && timed && isFrameCounts(value.frames) && settings;
}

/** Whether `value` is a capture's `render` provenance in its shape. */
export function isCaptureProvenance(value: unknown): value is CaptureProvenance {
  if (!isRecord(value) || !isEffectivePreset(value.preset) || !isDeviceClass(value.deviceClass)) return false;
  const settle =
    Number.isSafeInteger(value.settleFrames) &&
    Number(value.settleFrames) >= 1 &&
    Number(value.settleFrames) <= CAPTURE_SETTLE_FRAMES_MAX;
  const settled = settle && typeof value.historyReset === "boolean" && isCaptureExposure(value.exposure);
  return settled && isSettingsSource(value.settingsSource) && isRenderScale(value.scale);
}

/** A copy of a feature-switch record with only its known entries. */
function switchesCopy(value: Partial<Record<RenderFeature, boolean>>): Partial<Record<RenderFeature, boolean>> {
  const copy: Partial<Record<RenderFeature, boolean>> = {};
  for (const feature of Object.values(RenderFeature)) {
    const on = value[feature];
    if (on !== undefined) copy[feature] = on;
  }
  return copy;
}

/** A checked `renderSettings` answer copied with only its fields, or null outside its shape. */
export function parseRenderSettingsAnswer(value: unknown): RenderSettingsAnswer | null {
  if (!isRenderSettingsAnswer(value)) return null;
  const { preset, requested, deviceClass, detectedClass, features, renderScaleLock, frameBudgetMs, scale } = value;
  const answer = { preset, requested, deviceClass, detectedClass, features: switchesCopy(features), renderScaleLock };
  return frameBudgetMs === undefined ? { ...answer, scale } : { ...answer, frameBudgetMs, scale };
}

/** A checked `volatile.render` copied with only its fields, or null outside its shape. */
export function parseRenderStatus(value: unknown): RenderStatus | null {
  if (!isRenderStatus(value)) return null;
  const { deviceClass, preset, scale, features, degraded, gpuMs, cpuMs, frames } = value;
  const status: RenderStatus = {
    deviceClass,
    preset,
    scale,
    features: switchesCopy(features),
    degraded: degraded.map(({ reason, subject }) => ({ reason, subject })),
    gpuMs,
    cpuMs,
  };
  return frames === undefined
    ? status
    : { ...status, frames: { rendered: frames.rendered, repeated: frames.repeated } };
}
