//! The `genex.toml` schema: the only build input a game folder declares. It is read as data;
//! the host writes the real `Cargo.toml` from it (M2.2) and the lane refuses what does not fit.
//!
//! ```toml
//! [game]
//! title = "Pond"            # required
//! world_size = [960, 540]   # optional, each side 64..=4096
//! save_name = "pond"        # optional: letters, digits, space, _ - .
//!
//! [crates]                  # optional: the reviewed allowlist by requirement, or a crate the
//! noise = "0.9"             # person approved for this game, at its exact version
//! tidy = "=1.0.0"
//!
//! [[crate_request]]         # optional: ask the person for a crate (extension ladder level 4)
//! name = "tidy"
//! version = "1.0.0"         # one exact release
//! reason = "tidy layouts"   # optional, one sentence for the person
//!
//! [[wgsl]]                  # optional: WGSL extension sources under the game folder
//! path = "shaders/water.wgsl"
//! kind = "material"         # material | post | pass
//! api = 1                   # optional: the extension API it is written against (default 1)
//!
//! [gpu]                     # optional: native-enhanced features (refused for web builds)
//! native_features = ["subgroup"]
//!
//! [web]                     # optional: the browser build's code budget, in MB of gzip
//! wasm_budget_mb = 8        # 1..=32 (default 4): past it the host's export warns, past 32 refuses
//!
//! [physics]                 # optional: a game without physics is built without Rapier
//! enabled = false           # default true
//!
//! [[texture]]               # optional: a loose texture's usage, where no material slot tells it
//! path = "textures/flow.png"   # under assets/: a PNG, JPEG or WebP
//! usage = "data"            # color | data | normal
//!
//! [[asset_group]]           # optional: assets a game loads during play, by name (C-30)
//! name = "castle"           # letters, digits, _ and -; never boot, sim or stream (the build's own groups)
//! paths = ["interiors/castle/**", "props/throne.glb"]  # globs under assets/: *, ? and whole-segment **
//!
//! [assets]                  # optional: the package's budgets in MB, read by the host's package step (C-17)
//! budget_mb = 300           # every destination's budget: past it the host's export warns
//! phone_max_texture_px = 2048  # iOS and Android packages drop KTX2 levels above it: 512..=4096, a power of two
//!
//! [assets.web]              # one destination's budget: web, ios, android or desktop
//! budget_mb = 64            # defaults web 64, ios 200, android 200, desktop 2048; at most web 512, phones 4096
//!
//! [render]                  # optional: the renderer's quality and the game's look
//! form_factors = ["desktop", "mobile"]
//! preset = "auto"           # auto | low | medium | high | ultra
//!
//! [render.look]             # the same on every preset and device
//! tonemapper = "agx-punchy" # khronos-neutral (default) | agx | agx-punchy | aces | none
//! exposure = "auto"         # manual (default) | auto
//! metering = "center"       # average | center | spot | ground
//! ev_compensation = -0.5    # within ±10
//! bloom_intensity = 0.04    # 0..=1
//! ev_min = -6               # auto exposure's metered EV range, within ±16 (default -8..=8)
//! ev_max = 8
//! adaptation_speed_up = 3   # EV per second, 0 < speed <= 20 (defaults 3 and 1)
//! adaptation_speed_down = 1
//! bloom_threshold = 0       # 0..=16, 0 = threshold-free (default)
//! bloom_radius = 1.0        # the spread, 0.25..=4
//! ao_intensity = 1.0        # GTAO's strength, 0..=1
//! ao_radius = 0.5           # world units, 0 < radius <= 8
//! fog_density = 0.02        # per world unit, 0..=1 (default 0: no fog)
//! fog_height_falloff = 0.2  # per world unit, 0..=10
//! fog_base_height = 0       # within ±100000
//! fog_start = 0             # world units, 0..=100000
//! fog_max_opacity = 1.0     # 0..=1
//! fog_color = [1.0, 1.0, 1.0]   # tint on the sky's in-scatter, each 0..=16
//! fog_aerial_perspective = true # the sky's own scattering where the quality has it
//! contact_shadow_length = 0.25  # world units, 0 < length <= 2
//!
//! [render.shadows]          # the sun's shadows on every preset (held to each class's caps)
//! distance = 80             # world units, 10..=400 (default: each preset's own, 30..80)
//! blend_band = 0.1          # share of each cascade blended into the next, 0..=0.5
//!
//! [render.loading]          # the loading screen until the first lit frame (every key optional)
//! title = "Harbour Nights"  # default: [game] title; 1..=60 characters
//! background = "#1b2233"    # sRGB #rrggbb
//! accent = "#7fb2ec"        # the spinner and the progress bar
//! text = "#eceae4"          # the title and the stage
//! logo = "ui/logo.png"      # a PNG, JPEG or WebP under assets/
//!
//! [render.class.mobile-mid] # quality on one device class
//! preset = "low"
//! render_scale = 0.67       # 0.5..=1
//! fps = 30                  # 30 | 60
//! bloom = false             # a feature switch
//! lod_threshold_px = 2.5    # the error a level may show, output pixels, 0.5..=8 (held to 0.5x..2x the preset's)
//! lod_fade_band = 0.15      # the LOD crossfade band, a share of the threshold, 0..=0.5 (0: hard switches)
//! far_density = 0.35        # the share of far-field copies kept, 0.1..=1
//! ```
//!
//! The `[render]` vocabulary is the host's `src/shared/render-quality.ts`, held equal through
//! `tests/fixtures/native-wire-v2.json`; both parsers read `tests/fixtures/genex-toml-render.json`.
//!
//! Unknown keys are refused, so a game cannot smuggle cargo configuration through this file. The
//! native feature names are `NativeEnhancedFeature`'s in `src/shared` (the host parses this file
//! itself, `src/substrate/genex-toml.ts`, and compiles the declared ones in for the facade).
//! A crate off the allowlist is named only at an exact pin (`=X.Y.Z`): whether the person approved
//! it for this game is the host build's check, never this file's (the crate request flow, M3.15).

use crate::map::Map;
use genex_core::protocol::{MAX_WORLD_PX, MIN_WORLD_PX};
use genex_render::EXTENSION_APIS;
use serde::Deserialize;
use std::fmt;

/// The Level-2 calls of the facade, by their spelling in agent guidance (each one ships): a custom
/// material (`gfx.material(path, uniforms)`, its uniforms changed with
/// `gfx.set_material_uniforms`) drawn with `frame.custom(..)`, a post pass (`gfx.post_pass(path)`
/// or `gfx.post_pass_with(path, uniforms)`) run with `frame.post_pass(..)`, and the source compiled
/// into the binary with `game.wgsl(path, include_str!(..))`. A game texture call joins the list
/// when it ships.
pub const LEVEL_TWO_CALLS: [&str; 7] = [
    "gfx.material",
    "gfx.set_material_uniforms",
    "gfx.post_pass",
    "gfx.post_pass_with",
    "frame.custom",
    "frame.post_pass",
    "game.wgsl",
];
/// The frame calls temporal effects (TAA, motion vectors) need from a game, as agents call them:
/// `frame.id(key)` names the following draws across frames (so a moving object's pixels find
/// where they were) until `frame.end_id()`, and `frame.camera_cut()` starts every history over
/// on a new shot.
pub const TEMPORAL_CALLS: [&str; 3] = ["frame.id", "frame.end_id", "frame.camera_cut"];
/// The environment calls of the facade (RQ2), as agents call them: `frame.environment(..)` with
/// the physical sky (`Environment::sky()`, tuned as `Environment::Sky(SkyParams::default()..)`) or
/// an HDR map (`Environment::hdri(path)`, or `Environment::Hdri(HdriEnvironment::new(path)..)`).
pub const ENVIRONMENT_CALLS: [&str; 5] = ["frame.environment", "Environment::sky", "Environment::hdri", "HdriEnvironment::new", "SkyParams::default"];
/// The local-light and emission calls of the facade (RQ6), as agents call them: point and spot
/// lights on a frame (`frame.spot_light_with(&SpotLight::new(..)..)` for its own cone or a shadow
/// map), and a glowing surface (`Material::emissive(..)`, `.with_emissive(..)`,
/// `.with_emissive_texture(..)`).
pub const LIGHT_CALLS: [&str; 7] =
    ["frame.point_light", "frame.spot_light", "frame.spot_light_with", "SpotLight::new", "Material::emissive", ".with_emissive", ".with_emissive_texture"];
/// The retained instance group calls of the facade (renderer pass 2 A.0b), as agents call them:
/// a group made once (`InstanceGroup::cubes(..)`, `::spheres(..)`, `::models(..)`,
/// `::models_with(..)`), changed by range (`group.update(..)`) and drawn each frame
/// (`frame.group(..)`).
pub const INSTANCE_GROUP_CALLS: [&str; 6] =
    ["InstanceGroup::cubes", "InstanceGroup::spheres", "InstanceGroup::models", "InstanceGroup::models_with", "group.update", "frame.group"];
/// The particle calls of the facade (renderer pass 2 A.11), as agents call them: an emitter made
/// once from a kind (`Particles::steam(..)`, `Particles::rain(..)`, `Particles::fountain(..)`),
/// changed (`.with_rate(..)`, `.with_soft(..)`, `.with_sorted(..)`, `.with_collision(..)`,
/// `.with_flipbook(..)`) and drawn each frame (`frame.particles(..)`).
pub const PARTICLE_CALLS: [&str; 9] =
    ["Particles::steam", "Particles::rain", "Particles::fountain", ".with_rate", ".with_soft", ".with_sorted", ".with_collision", ".with_flipbook", "frame.particles"];
/// The terrain calls of the facade (renderer pass 2 A.7), as agents call them: a height field made
/// once (`Terrain::from_fn(..)`, `Terrain::from_heights(..)`), its layers (`TerrainLayer::textured(..)`,
/// `TerrainLayer::flat(..)`, `.with_layers(..)`) and control map (`TerrainTexel::blend(..)`,
/// `.with_control(..)`), drawn each frame (`frame.terrain(..)`) and asked for its height
/// (`terrain.height(..)`).
pub const TERRAIN_CALLS: [&str; 13] = [
    "Terrain::from_fn",
    "Terrain::from_heights",
    "TerrainLayer::textured",
    "TerrainLayer::flat",
    ".with_layers",
    "TerrainTexel::blend",
    ".with_control",
    "frame.terrain",
    "terrain.height",
    // Renderer pass 2 A.8: grass on a terrain layer, and scatter on the terrain.
    "Grass::meadow",
    ".with_grass",
    "Scatter::new",
    "terrain.scatter",
];
/// The look's fog calls of the facade, as agents call them: the fog a config draws
/// (`RenderConfig::new().fog(..)`), made from `Fog::default()` and shaped (`.with_density(..)`,
/// `.with_height(..)`, `.with_range(..)`, `.with_color(..)`, `.with_aerial_perspective(..)`), and
/// renderer pass 2 A.5's opt-out of the lit volume on `high` and `ultra` (`.with_volumetric(..)`).
pub const FOG_CALLS: [&str; 8] =
    [".fog", "Fog::default", ".with_density", ".with_height", ".with_range", ".with_color", ".with_aerial_perspective", ".with_volumetric"];
/// Game systems (EP-0a1): the call and refusal blocks of the five areas, empty until each area's
/// work package pins what works (`tests/fixtures/rust-facade-vocabulary.json` holds the same).
/// The animation calls of the facade (`.wire` is a refusal code's wire spelling): the rig, the
/// character controller (AN-19), ragdolls (AN-20) and the animation surface (AN-15: the graph,
/// the animator, `frame.character` and its skeleton overlay).
pub const ANIMATION_CALLS: [&str; 50] = [
    "gfx.character", ".joint_count", ".skeleton", ".path", ".wire", "Character::spawn", "Character::on_ground",
    ".drive", ".drive_on", ".ground_ray", ".remove", ".feet", ".facing", ".transform", ".velocity", ".grounded",
    ".nav_config", ".snapshot", ".restore", "Ragdoll::build", ".follow", ".go_limp", ".power", ".recover", ".view",
    "RagdollProfile::humanoid", ".with_mass", ".graph", ".clip", ".clip_names", ".animator", ".with_root_motion",
    ".with_retargeted_clips",
    ".float", ".trigger", ".layer", ".state", ".transition", ".when", ".build", ".set_float", ".fire", ".update",
    ".probe", "frame.character", "frame.character_with", "frame.skeleton_debug", "CharacterDraw::new", ".tint",
    ".material",
];
/// The streaming calls of the facade (STR-9; the view set, STR-16; kept cells and saves, STR-12;
/// terrain tiles, STR-23).
pub const STREAM_CALLS: [&str; 32] = [
    "Streaming::grid", ".sim_radius", ".hysteresis", ".prefetch", ".anchors", "game.streaming", "game.cell_content",
    "CellBuild::default", ".thing", "sim.stream.set_anchor", "sim.stream.clear_anchor", "sim.stream.entered",
    "sim.stream.left", ".part", "CellColliders::new", ".with", "game.stream_colliders", ".handles", ".view_radius",
    ".model", "frame.cells_debug", "sim.stream.keep", "sim.stream.release", "sim.stream.snapshot", "sim.stream.restore",
    "TerrainTiles::procedural", "TerrainTiles::authored", ".with_height_range", ".with_colliders", ".terrain",
    "sim.stream.ground", ".colliders_content",
];
/// The navigation calls of the facade (NAV-11; agents, links, bodies, queries and saves, NAV-12;
/// collider input, NAV-5; debug drawing, NAV-16).
pub const NAV_CALLS: [&str; 52] = [
    "frame.lines", "game.navigation", "NavConfig::walker", "NavInput::new", "NavMesh::bake", "NavMesh::bake_tile",
    "NavMesh::from_bytes_for", "nav.add_mesh", "nav.add_tile", "nav.remove_tile", "nav.set_area_cost",
    "nav.set_area_open", "nav.add_obstacle", "nav.move_obstacle", "nav.remove_obstacle", "nav.pending_rebuilds",
    "nav.update", "NavAgent::new", "NavLink::between", "nav.add_agent", "nav.remove_agent", "nav.move_to", "nav.stop",
    "nav.set_position", "nav.desired_velocity", "nav.status", "nav.next_corner", "nav.take_link", "nav.finish_link",
    "nav.add_link", "nav.remove_link", "nav.set_link_open", "nav.add_body", "nav.set_body", "nav.remove_body",
    "nav.closest_point", "nav.path", "nav.raycast", "nav.move_along", "nav.random_point", "nav.distance_to_wall",
    "nav.probe", "nav.snapshot", "nav.restore", ".with_colliders", ".with_static_colliders", "frame.nav_debug",
    "NavDebug::mesh", "NavDebug::borders", "NavDebug::everything", ".with_links", ".with_paths",
];
/// The input calls of the facade (IN-11, IN-12).
pub const INPUT_CALLS: [&str; 30] = [
    "game.input", "game.touch_controls", "ActionMap::new", ".context", "Context::new", ".button", ".axis1", ".axis2",
    ".when", ".modify", ".pass_through", ".starts_off", "ctx.actions.down", "ctx.actions.pressed",
    "ctx.actions.released", "ctx.actions.fired", "ctx.actions.value", "ctx.actions.axis2", "ctx.actions.held_ticks",
    "ctx.actions.device", "ctx.actions.glyph", "ctx.actions.is_on", "ctx.actions.enable", "ctx.actions.disable",
    "ctx.actions.free_touches", "TouchControls::new", ".stick", ".dpad", ".show", "controls_panel",
];
/// The sim-side asset read calls of the facade, as a reset calls them (SF-1a); `.wire` is a
/// refusal code's wire spelling.
pub const ASSET_CALLS: [&str; 9] =
    ["gfx.assets().bytes", "gfx.assets().triangles", "gfx.assets().info", ".json", ".digest", ".as_str", ".code", ".detail", ".wire"];
/// The sim-side asset read refusals: [`crate::AssetErrorCode::ALL`]'s wire spellings.
pub const ASSET_REFUSALS: [&str; 6] = ["unsafe-path", "missing", "too-large", "malformed", "not-at-reset", "not-preloaded"];
/// The level-of-detail calls of the facade.
pub const LOD_CALLS: [&str; 0] = [];
/// The level-of-detail refusals (`__render.lodRefused` codes).
pub const LOD_REFUSALS: [&str; 0] = [];
/// The `[[wgsl]] api` versions the facade has defined; the runtime admits those genex-render
/// serves (`EXTENSION_APIS`; `extension-api-unavailable` for the rest).
pub const WGSL_EXTENSION_APIS: [i64; 2] = [1, 2];
/// The lowest render scale (of the output size) a class may name.
pub const RENDER_SCALE_MIN: f64 = 0.5;
/// The highest render scale.
pub const RENDER_SCALE_MAX: f64 = 1.0;
/// The frame-rate targets a class may hold (the simulation ticks at 60 Hz).
pub const RENDER_FPS_TARGETS: [i64; 2] = [30, 60];
/// The largest exposure compensation either way, in EV.
pub const EV_COMPENSATION_LIMIT: f64 = 10.0;
/// The strongest bloom a look may ask for.
pub const BLOOM_INTENSITY_MAX: f64 = 1.0;
/// The largest auto exposure limit (`ev_min`, `ev_max`) either way, in EV.
pub const EXPOSURE_EV_LIMIT: f64 = 16.0;
/// The fastest auto exposure adaptation, in EV per second.
pub const ADAPTATION_SPEED_MAX: f64 = 20.0;
/// The highest bloom threshold a look may ask for, in scene units (0: threshold-free).
pub const BLOOM_THRESHOLD_MAX: f64 = 16.0;
/// The narrowest bloom spread.
pub const BLOOM_RADIUS_MIN: f64 = 0.25;
/// The widest bloom spread.
pub const BLOOM_RADIUS_MAX: f64 = 4.0;
/// The strongest ambient occlusion.
pub const AO_INTENSITY_MAX: f64 = 1.0;
/// The largest ambient occlusion radius, in world units (above 0).
pub const AO_RADIUS_MAX: f64 = 8.0;
/// The densest fog, per world unit.
pub const FOG_DENSITY_MAX: f64 = 1.0;
/// The steepest fog height falloff, per world unit.
pub const FOG_HEIGHT_FALLOFF_MAX: f64 = 10.0;
/// The largest fog base height either way and fog start distance, in world units.
pub const FOG_DISTANCE_LIMIT: f64 = 100_000.0;
/// The brightest fog colour channel (linear, scene units).
pub const FOG_COLOR_MAX: f64 = 16.0;
/// The longest contact-shadow ray, in world units (above 0).
pub const CONTACT_SHADOW_LENGTH_MAX: f64 = 2.0;
/// The shortest and longest `[render.shadows] distance`, whole world units (the renderer's
/// `SHADOW_DISTANCE_MIN_M`, `SHADOW_DISTANCE_MAX_M`).
pub const SHADOW_DISTANCE_MIN: i64 = genex_render::settings::SHADOW_DISTANCE_MIN_M as i64;
/// See [`SHADOW_DISTANCE_MIN`].
pub const SHADOW_DISTANCE_MAX: i64 = genex_render::settings::SHADOW_DISTANCE_MAX_M as i64;
/// The widest `[render.shadows] blend_band` (the renderer's `SHADOW_BLEND_BAND_MAX`).
pub const SHADOW_BLEND_BAND_MAX: f64 = genex_render::settings::SHADOW_BLEND_BAND_MAX as f64;
/// The finest `lod_threshold_px` a class table may name, output pixels (the renderer's
/// `LOD_THRESHOLD_PX_MIN`).
pub const LOD_THRESHOLD_PX_MIN: f64 = genex_render::settings::LOD_THRESHOLD_PX_MIN as f64;
/// The coarsest `lod_threshold_px` (the renderer's `LOD_THRESHOLD_PX_MAX`).
pub const LOD_THRESHOLD_PX_MAX: f64 = genex_render::settings::LOD_THRESHOLD_PX_MAX as f64;
/// The widest `lod_fade_band` (the renderer's `LOD_FADE_BAND_MAX`).
pub const LOD_FADE_BAND_MAX: f64 = genex_render::settings::LOD_FADE_BAND_MAX as f64;
/// The smallest `far_density` (the renderer's `FAR_DENSITY_MIN`, written as the decimal the file
/// spells: the renderer's `f32` widens to a different `f64`).
pub const FAR_DENSITY_MIN: f64 = 0.1;
/// The smallest `[web] wasm_budget_mb` (the host's `WEB_WASM_BUDGET_MIN_MB`).
pub const WEB_WASM_BUDGET_MIN_MB: i64 = 1;
/// The largest `[web] wasm_budget_mb`: the host's hard ceiling on a browser build's gzip size
/// (`WEB_WASM_CEILING_MB`); an export past it is refused whatever the game names.
pub const WEB_WASM_CEILING_MB: i64 = 32;
/// The `[render.shadows]` keys, in file-documentation order.
pub const SHADOW_KEYS: [&str; 2] = ["distance", "blend_band"];
/// The keys of `[render.look]`, in the wire table's order (the host's `LookKey`).
pub const LOOK_KEYS: [&str; 21] = [
    "tonemapper",
    "exposure",
    "metering",
    "ev_compensation",
    "bloom_intensity",
    "ev_min",
    "ev_max",
    "adaptation_speed_up",
    "adaptation_speed_down",
    "bloom_threshold",
    "bloom_radius",
    "ao_intensity",
    "ao_radius",
    "fog_density",
    "fog_height_falloff",
    "fog_base_height",
    "fog_start",
    "fog_max_opacity",
    "fog_color",
    "fog_aerial_perspective",
    "contact_shadow_length",
];

/// Declares a `[render]` vocabulary: its values, wire spellings, `ALL`, `as_str` and `from_wire`.
macro_rules! vocabulary {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $wire:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
        }

        impl $name {
            /// Every value, in the wire table's order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The wire spelling. Never renamed once shipped.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $wire,)+
                }
            }

            /// The value a wire spelling names, if any.
            pub fn from_wire(text: &str) -> Option<$name> {
                $name::ALL.iter().copied().find(|value| value.as_str() == text)
            }
        }
    };
}

vocabulary! {
    /// A quality preset; `auto` follows the device class.
    QualityPreset {
        /// The device class's default.
        Auto => "auto",
        /// The cheapest.
        Low => "low",
        /// Mid-range.
        Medium => "medium",
        /// High.
        High => "high",
        /// Everything on.
        Ultra => "ultra",
    }
}

vocabulary! {
    /// What kind of device a game is made for (`[render] form_factors`).
    FormFactor {
        /// Desktops and laptops.
        Desktop => "desktop",
        /// Phones and tablets.
        Mobile => "mobile",
    }
}

vocabulary! {
    /// A device class, `<form factor>-<tier>` (`[render.class.<class>]`).
    DeviceClass {
        /// A high-end desktop.
        DesktopUltra => "desktop-ultra",
        /// A good desktop or laptop.
        DesktopHigh => "desktop-high",
        /// A mid-range desktop.
        DesktopMid => "desktop-mid",
        /// An old or integrated laptop.
        DesktopLow => "desktop-low",
        /// A recent iPhone or flagship Android.
        MobileHigh => "mobile-high",
        /// An older iPhone or mid-range Android.
        MobileMid => "mobile-mid",
        /// A weak phone.
        MobileLow => "mobile-low",
    }
}

vocabulary! {
    /// A renderer feature with its own switch in a class table.
    RenderFeature {
        /// The HDR scene target.
        Hdr => "hdr",
        /// The tonemapper.
        Tonemap => "tonemap",
        /// Exposure.
        Exposure => "exposure",
        /// Image-based lighting.
        Ibl => "ibl",
        /// The physical sky.
        Sky => "sky",
        /// Shadows.
        Shadows => "shadows",
        /// Contact shadows.
        ContactShadows => "contact-shadows",
        /// Bloom.
        Bloom => "bloom",
        /// Ambient occlusion.
        Ao => "ao",
        /// Fog.
        Fog => "fog",
        /// Temporal anti-aliasing.
        Taa => "taa",
        /// The spatial upscaler.
        Upscaler => "upscaler",
        /// Clustered local lights.
        Clustered => "clustered",
        /// Meshlets.
        Meshlets => "meshlets",
        /// Hi-Z occlusion culling.
        Occlusion => "occlusion",
        /// The depth/normal prepass.
        Prepass => "prepass",
        /// Texture size classes above 256 and Toksvig normal-map mips.
        TextureQuality => "texture-quality",
        /// Shadow maps for spot lights that ask for one.
        SpotShadows => "spot-shadows",
        /// The crossfade between levels of detail.
        LodFade => "lod-fade",
        /// Impostors past a model's last mesh level.
        Impostors => "impostors",
    }
}

vocabulary! {
    /// The tonemapper of a game's look.
    Tonemapper {
        /// Khronos PBR Neutral: today's picture.
        KhronosNeutral => "khronos-neutral",
        /// AgX.
        Agx => "agx",
        /// ACES (Hill).
        Aces => "aces",
        /// No tonemapping.
        None => "none",
        /// AgX with the punchy look: AgX's highlights, saturation and mid contrast kept.
        AgxPunchy => "agx-punchy",
    }
}

vocabulary! {
    /// Fixed or adapting exposure.
    ExposureMode {
        /// Fixed by the game.
        Manual => "manual",
        /// Adapts to the scene.
        Auto => "auto",
    }
}

vocabulary! {
    /// Where auto exposure looks.
    Metering {
        /// The whole frame.
        Average => "average",
        /// Weighted to the centre.
        Center => "center",
        /// The centre spot.
        Spot => "spot",
        /// Sky-aware: the lower rows weigh more, so an open sky does not darken the ground.
        Ground => "ground",
    }
}

/// Extra crates a game may name without a person's approval (plan "Agent policy").
pub const GAME_CRATE_ALLOWLIST: [&str; 2] = ["fastrand", "noise"];
const MAX_TITLE_CHARS: usize = 80;
const MAX_SAVE_NAME_CHARS: usize = 64;
/// The longest crate name: a letter, then letters, digits, `-` and `_`.
const MAX_CRATE_NAME_CHARS: usize = 64;
/// The longest pre-release suffix of an exact release.
const MAX_PRE_RELEASE_CHARS: usize = 40;
/// The longest reason a request row carries to the person (the harness's `crates.request` cap).
const MAX_REQUEST_REASON_CHARS: usize = 500;

/// A parsed, checked `genex.toml`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GenexToml {
    /// Title, size and save folder.
    pub game: GameSection,
    /// Extra crates: an allowlisted one by version requirement, an approved one at `=X.Y.Z`.
    #[serde(default)]
    pub crates: Map<String, String>,
    /// Crates the game asks the person for, in file order.
    #[serde(default)]
    pub crate_request: Vec<CrateRequest>,
    /// WGSL extension sources.
    #[serde(default)]
    pub wgsl: Vec<WgslSource>,
    /// GPU tier requirements.
    #[serde(default)]
    pub gpu: GpuSection,
    /// The renderer's quality and the game's look.
    #[serde(default)]
    pub render: RenderSection,
    /// The browser build's code budget.
    #[serde(default)]
    pub web: WebSection,
    /// Whether the game is built with physics.
    #[serde(default)]
    pub physics: PhysicsSection,
    /// Loose textures' usages, read by the host's import step (C-10).
    #[serde(default)]
    pub texture: Vec<TextureRow>,
    /// Named groups of assets a game loads during play, read by the host's package step (C-30).
    #[serde(default)]
    pub asset_group: Vec<AssetGroupRow>,
    /// The package's budgets and a phone's texture cap, read by the host's package step (C-17).
    #[serde(default)]
    pub assets: AssetsSection,
}

impl GenexToml {
    /// Whether the game or any of its WGSL needs a native-enhanced feature (so no web build).
    pub fn needs_native_features(&self) -> bool {
        !self.gpu.native_features.is_empty()
    }
}

/// `[game]`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GameSection {
    /// Window and export title.
    pub title: String,
    /// The fixed world target size in pixels.
    #[serde(default = "default_world_size")]
    pub world_size: [u32; 2],
    /// The save folder name.
    #[serde(default)]
    pub save_name: Option<String>,
}

fn default_world_size() -> [u32; 2] {
    [960, 540]
}

/// `[[crate_request]]`: one crate at one exact release, and why.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CrateRequest {
    /// The crate's registry name.
    pub name: String,
    /// One exact release, `MAJOR.MINOR.PATCH` with an optional pre-release.
    pub version: String,
    /// One sentence for the person.
    #[serde(default)]
    pub reason: Option<String>,
}

/// What a WGSL source extends.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WgslKind {
    /// A custom material: `gfx.material(path, uniforms)`, drawn with `frame.custom(..)` (extension
    /// ladder level 2).
    Material,
    /// A post pass: `gfx.post_pass(path)`, run with `frame.post_pass(..)` (level 2).
    Post,
    /// A custom GPU pass through `genex::gpu`, `game.gpu_pass(..)` (level 3, M2.19).
    Pass,
}

impl WgslKind {
    /// Every kind.
    pub const ALL: &'static [WgslKind] = &[WgslKind::Material, WgslKind::Post, WgslKind::Pass];

    /// The wire spelling (`[[wgsl]] kind`).
    pub const fn as_str(self) -> &'static str {
        match self {
            WgslKind::Material => "material",
            WgslKind::Post => "post",
            WgslKind::Pass => "pass",
        }
    }

    /// The facade call that takes a source of this kind.
    pub const fn facade_call(self) -> &'static str {
        match self {
            WgslKind::Material => "gfx.material",
            WgslKind::Post => "gfx.post_pass",
            WgslKind::Pass => "game.gpu_pass",
        }
    }
}

/// `[[wgsl]]`.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WgslSource {
    /// Relative path under the game folder, ending in `.wgsl`.
    pub path: String,
    /// What it extends.
    pub kind: WgslKind,
    /// The extension API it is written against.
    #[serde(default = "default_wgsl_api")]
    pub api: i64,
}

fn default_wgsl_api() -> i64 {
    1
}

/// `[render]`: the form factors a game is made for, its preset, its look and per-class quality.
/// Read as data; the values are checked by [`parse`] and read typed through the accessors.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderSection {
    /// `FormFactor` spellings (every form factor when empty).
    #[serde(default)]
    pub form_factors: Vec<String>,
    /// A `QualityPreset` spelling.
    #[serde(default)]
    pub preset: Option<String>,
    /// The game's look.
    #[serde(default)]
    pub look: LookSection,
    /// Quality per device class, by `DeviceClass` spelling (ordered by name: TOML tables are maps).
    #[serde(default)]
    pub class: Map<String, ClassSection>,
    /// The sun's shadows on every preset.
    #[serde(default)]
    pub shadows: ShadowsSection,
    /// The loading screen every destination shows until the first lit frame.
    #[serde(default)]
    pub loading: LoadingSection,
}

/// `[render.loading]`: how the game's loading screen looks (owner decision D11), the same keys and
/// checks as the host's `src/shared/loading-style.ts`. A key left out takes the default (the title
/// the game's own).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LoadingSection {
    /// What the screen names, 1..=[`LOADING_TITLE_MAX_CHARS`] characters, no control character.
    #[serde(default)]
    pub title: Option<String>,
    /// The screen's colour, sRGB `#rrggbb`.
    #[serde(default)]
    pub background: Option<String>,
    /// The spinner's and the progress bar's colour, `#rrggbb`.
    #[serde(default)]
    pub accent: Option<String>,
    /// The title's and the stage's colour, `#rrggbb`.
    #[serde(default)]
    pub text: Option<String>,
    /// A PNG, JPEG or WebP under the game's `assets/`, shown above the title.
    #[serde(default)]
    pub logo: Option<String>,
}

/// The longest loading title, in characters.
pub const LOADING_TITLE_MAX_CHARS: usize = 60;

/// Whether `value` is a loading colour: `#` and six hex digits.
pub fn is_loading_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Whether `value` is a loading title: not blank, at most [`LOADING_TITLE_MAX_CHARS`], no control character.
pub fn is_loading_title(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= LOADING_TITLE_MAX_CHARS && !value.chars().any(char::is_control)
}

/// Whether `value` is a logo path under `assets/`: `/`-separated segments of letters, digits,
/// `_`, `-` and `.`, none empty, `.` or `..`, ending in `.png`, `.jpg`, `.jpeg` or `.webp`.
pub fn is_loading_logo(value: &str) -> bool {
    let chars = value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'/'));
    let segments = value.split('/').all(|segment| !matches!(segment, "" | "." | ".."));
    let lower = value.to_ascii_lowercase();
    let image = [".png", ".jpg", ".jpeg", ".webp"].iter().any(|extension| lower.ends_with(extension));
    chars && segments && image
}

/// `[render.shadows]`: the sun's shadows a game asks for on every preset, held to each device
/// class's caps. A key left out keeps each preset's own value.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ShadowsSection {
    /// How far from the camera the shadows reach, whole world units
    /// ([`SHADOW_DISTANCE_MIN`]..=[`SHADOW_DISTANCE_MAX`]).
    #[serde(default)]
    pub distance: Option<i64>,
    /// The share of each cascade's depth range blended into the next (0..=[`SHADOW_BLEND_BAND_MAX`]).
    #[serde(default)]
    pub blend_band: Option<f64>,
}

impl RenderSection {
    /// The form factors, typed (a checked manifest names only known ones).
    pub fn form_factors(&self) -> Vec<FormFactor> {
        self.form_factors.iter().filter_map(|name| FormFactor::from_wire(name)).collect()
    }

    /// The preset, typed.
    pub fn preset(&self) -> Option<QualityPreset> {
        self.preset.as_deref().and_then(QualityPreset::from_wire)
    }

    /// The class tables, typed.
    pub fn classes(&self) -> Vec<(DeviceClass, &ClassSection)> {
        self.class.iter().filter_map(|(name, class)| DeviceClass::from_wire(name).map(|known| (known, class))).collect()
    }
}

/// `[render.look]`: the game's look, the same on every preset.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LookSection {
    /// A `Tonemapper` spelling.
    #[serde(default)]
    pub tonemapper: Option<String>,
    /// An `ExposureMode` spelling.
    #[serde(default)]
    pub exposure: Option<String>,
    /// A `Metering` spelling.
    #[serde(default)]
    pub metering: Option<String>,
    /// EV compensation, within ±[`EV_COMPENSATION_LIMIT`].
    #[serde(default)]
    pub ev_compensation: Option<f64>,
    /// Bloom intensity, 0..=[`BLOOM_INTENSITY_MAX`].
    #[serde(default)]
    pub bloom_intensity: Option<f64>,
    /// Auto exposure's lowest metered EV, within ±[`EXPOSURE_EV_LIMIT`] and at most `ev_max`.
    #[serde(default)]
    pub ev_min: Option<f64>,
    /// Auto exposure's highest metered EV, within ±[`EXPOSURE_EV_LIMIT`].
    #[serde(default)]
    pub ev_max: Option<f64>,
    /// EV per second auto exposure brightens by, in `(0, ADAPTATION_SPEED_MAX]`.
    #[serde(default)]
    pub adaptation_speed_up: Option<f64>,
    /// EV per second auto exposure darkens by, in `(0, ADAPTATION_SPEED_MAX]`.
    #[serde(default)]
    pub adaptation_speed_down: Option<f64>,
    /// Bloom's optional threshold, `0..=BLOOM_THRESHOLD_MAX` (0: threshold-free).
    #[serde(default)]
    pub bloom_threshold: Option<f64>,
    /// Bloom's spread, `BLOOM_RADIUS_MIN..=BLOOM_RADIUS_MAX`.
    #[serde(default)]
    pub bloom_radius: Option<f64>,
    /// GTAO's strength, `0..=AO_INTENSITY_MAX`.
    #[serde(default)]
    pub ao_intensity: Option<f64>,
    /// GTAO's radius in world units, `(0, AO_RADIUS_MAX]`.
    #[serde(default)]
    pub ao_radius: Option<f64>,
    /// Fog's extinction per world unit, `0..=FOG_DENSITY_MAX` (0: no fog).
    #[serde(default)]
    pub fog_density: Option<f64>,
    /// Fog's height falloff per world unit, `0..=FOG_HEIGHT_FALLOFF_MAX`.
    #[serde(default)]
    pub fog_height_falloff: Option<f64>,
    /// The height where the fog's density holds, within ±`FOG_DISTANCE_LIMIT`.
    #[serde(default)]
    pub fog_base_height: Option<f64>,
    /// The distance from the camera where fog starts, `0..=FOG_DISTANCE_LIMIT`.
    #[serde(default)]
    pub fog_start: Option<f64>,
    /// The most the fog hides a surface, `0..=1`.
    #[serde(default)]
    pub fog_max_opacity: Option<f64>,
    /// Linear rgb tint on the environment's in-scatter: three channels, each `0..=FOG_COLOR_MAX`.
    #[serde(default)]
    pub fog_color: Option<Vec<f64>>,
    /// Whether the aerial-perspective volume adds the sky's scattering where the quality has it.
    #[serde(default)]
    pub fog_aerial_perspective: Option<bool>,
    /// Contact shadows' ray length in world units, `(0, CONTACT_SHADOW_LENGTH_MAX]`.
    #[serde(default)]
    pub contact_shadow_length: Option<f64>,
}

impl LookSection {
    /// The tonemapper, typed.
    pub fn tonemapper(&self) -> Option<Tonemapper> {
        self.tonemapper.as_deref().and_then(Tonemapper::from_wire)
    }

    /// The exposure mode, typed.
    pub fn exposure(&self) -> Option<ExposureMode> {
        self.exposure.as_deref().and_then(ExposureMode::from_wire)
    }

    /// The metering, typed.
    pub fn metering(&self) -> Option<Metering> {
        self.metering.as_deref().and_then(Metering::from_wire)
    }

    /// `look` with this table's RQ4 keys (bloom's threshold and spread, GTAO's strength and
    /// radius, the fog, the contact shadows' length) applied; a key left out keeps `look`'s value.
    /// The table is checked when parsed, and the renderer holds each value to its limits again.
    pub fn apply_effects(&self, look: genex_render::Look) -> genex_render::Look {
        let some = |value: Option<f64>, current: f32| value.map_or(current, |v| v as f32);
        let mut look = look
            .with_bloom(look.bloom_intensity, some(self.bloom_threshold, look.bloom_threshold), some(self.bloom_radius, look.bloom_radius))
            .with_ao(some(self.ao_intensity, look.ao_intensity), some(self.ao_radius, look.ao_radius))
            .with_contact_shadow_length(some(self.contact_shadow_length, look.contact_shadow_length));
        let fog = look.fog;
        let mut fog = fog
            .with_density(some(self.fog_density, fog.density))
            .with_height(some(self.fog_height_falloff, fog.height_falloff), some(self.fog_base_height, fog.base_height))
            .with_range(some(self.fog_start, fog.start), some(self.fog_max_opacity, fog.max_opacity));
        if let Some([r, g, b]) = self.fog_color.as_deref().and_then(|color| <[f64; 3]>::try_from(color).ok()) {
            fog = fog.with_color([r as f32, g as f32, b as f32]);
        }
        if let Some(aerial) = self.fog_aerial_perspective {
            fog = fog.with_aerial_perspective(aerial);
        }
        look.fog = fog;
        look
    }
}

/// `[render.class.<class>]`: the quality a game asks for on one device class.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ClassSection {
    /// A `QualityPreset` spelling.
    #[serde(default)]
    pub preset: Option<String>,
    /// The render scale, [`RENDER_SCALE_MIN`]..=[`RENDER_SCALE_MAX`].
    #[serde(default)]
    pub render_scale: Option<f64>,
    /// The frame-rate target, one of [`RENDER_FPS_TARGETS`].
    #[serde(default)]
    pub fps: Option<i64>,
    /// The error a drawn level of detail may show, output pixels
    /// ([`LOD_THRESHOLD_PX_MIN`]..=[`LOD_THRESHOLD_PX_MAX`]).
    #[serde(default)]
    pub lod_threshold_px: Option<f64>,
    /// The LOD crossfade band, a share of the threshold (0..=[`LOD_FADE_BAND_MAX`]; 0: hard switches).
    #[serde(default)]
    pub lod_fade_band: Option<f64>,
    /// The share of far-field copies kept ([`FAR_DENSITY_MIN`]..=1).
    #[serde(default)]
    pub far_density: Option<f64>,
    /// Every other key: a feature switch, by `RenderFeature` spelling.
    #[serde(flatten)]
    pub switches: Map<String, bool>,
}

impl ClassSection {
    /// The preset, typed.
    pub fn preset(&self) -> Option<QualityPreset> {
        self.preset.as_deref().and_then(QualityPreset::from_wire)
    }

    /// The feature switches, typed.
    pub fn switches(&self) -> Vec<(RenderFeature, bool)> {
        let typed = |(name, on): (&String, &bool)| RenderFeature::from_wire(name).map(|feature| (feature, *on));
        self.switches.iter().filter_map(typed).collect()
    }
}

/// `[web]`: the browser build's code budget, read by the host's web export (it warns past the
/// budget and refuses only past [`WEB_WASM_CEILING_MB`]).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WebSection {
    /// MB of gzip, [`WEB_WASM_BUDGET_MIN_MB`]..=[`WEB_WASM_CEILING_MB`]; none: the host's default (4).
    #[serde(default)]
    pub wasm_budget_mb: Option<i64>,
}

/// `[physics]`: a game that uses no physics turns it off and is built without Rapier (the facade's
/// `physics` feature; the host writes the facade line without default features). Renderer pass 2, D11.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PhysicsSection {
    /// False builds the game without physics; none or true keeps it.
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl PhysicsSection {
    /// Whether the game is built with physics (the default).
    pub fn enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}

/// A `[[texture]]` row: a loose texture's usage, for what no material slot can tell (C-10).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TextureRow {
    /// Under assets/: a safe asset path to a PNG, JPEG or WebP.
    pub path: String,
    /// color, data or normal.
    pub usage: String,
}

/// An `[[asset_group]]` row: a named set of assets a game loads during play (C-30).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssetGroupRow {
    /// A letter or digit, then letters, digits, `_` and `-`; never one of [`RESERVED_ASSET_GROUPS`].
    pub name: String,
    /// Globs under assets/: `*` and `?` inside a segment, `**` as a whole segment.
    pub paths: Vec<String>,
}

/// `[assets]`: the package's budgets, read by the host's package step (C-17, owner call C8). Past a
/// budget the host's export warns; only a destination's hard cap refuses.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssetsSection {
    /// Every destination's budget in MB, [`ASSET_BUDGET_MIN_MB`]..=[`ASSET_BUDGET_MAX_MB`]; none: each destination's default.
    #[serde(default)]
    pub budget_mb: Option<i64>,
    /// The largest texture side an iOS or Android package keeps: a power of two in
    /// [`PHONE_TEXTURE_CAP_MIN_PX`]..=[`PHONE_TEXTURE_CAP_MAX_PX`]; none: the host's default (2048).
    #[serde(default)]
    pub phone_max_texture_px: Option<i64>,
    /// The browser package's own budget, at most [`WEB_ASSETS_CEILING_MB`].
    #[serde(default)]
    pub web: Option<AssetDestinationBudget>,
    /// The iPhone package's own budget, at most [`PHONE_ASSETS_CEILING_MB`].
    #[serde(default)]
    pub ios: Option<AssetDestinationBudget>,
    /// The Android package's own budget, at most [`PHONE_ASSETS_CEILING_MB`].
    #[serde(default)]
    pub android: Option<AssetDestinationBudget>,
    /// The Mac, Windows and Linux packages' own budget, at most [`ASSET_BUDGET_MAX_MB`].
    #[serde(default)]
    pub desktop: Option<AssetDestinationBudget>,
}

/// An `[assets.<destination>]` table.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssetDestinationBudget {
    /// The destination's budget in MB.
    #[serde(default)]
    pub budget_mb: Option<i64>,
}

/// `[gpu]`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GpuSection {
    /// Optional wgpu native features the game requires (tier native-enhanced).
    #[serde(default)]
    pub native_features: Vec<NativeFeature>,
}

/// A native-enhanced wgpu feature a game may declare.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum NativeFeature {
    /// `SHADER_INT64_ATOMIC_MIN_MAX`.
    ShaderInt64AtomicMinMax,
    /// `SHADER_INT64_ATOMIC_ALL_OPS`.
    ShaderInt64AtomicAllOps,
    /// `SUBGROUP`.
    Subgroup,
    /// `EXPERIMENTAL_RAY_QUERY`.
    RayQuery,
    /// `EXPERIMENTAL_MESH_SHADER`.
    MeshShader,
    /// `TEXTURE_BINDING_ARRAY` and its non-uniform indexing companions.
    TextureBindingArray,
    /// `MULTI_DRAW_INDIRECT_COUNT`.
    MultiDrawIndirectCount,
}

impl NativeFeature {
    /// Every feature.
    pub const ALL: &'static [NativeFeature] = &[
        NativeFeature::ShaderInt64AtomicMinMax,
        NativeFeature::ShaderInt64AtomicAllOps,
        NativeFeature::Subgroup,
        NativeFeature::RayQuery,
        NativeFeature::MeshShader,
        NativeFeature::TextureBindingArray,
        NativeFeature::MultiDrawIndirectCount,
    ];

    /// The wire spelling in `genex.toml` and the capability receipt.
    pub const fn as_str(self) -> &'static str {
        match self {
            NativeFeature::ShaderInt64AtomicMinMax => "shader-int64-atomic-min-max",
            NativeFeature::ShaderInt64AtomicAllOps => "shader-int64-atomic-all-ops",
            NativeFeature::Subgroup => "subgroup",
            NativeFeature::RayQuery => "ray-query",
            NativeFeature::MeshShader => "mesh-shader",
            NativeFeature::TextureBindingArray => "texture-binding-array",
            NativeFeature::MultiDrawIndirectCount => "multi-draw-indirect-count",
        }
    }
}

/// Why a `genex.toml` was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ManifestErrorCode {
    /// Not TOML, a missing required key, an unknown key or a value of the wrong shape.
    Syntax,
    /// An empty or overlong title.
    InvalidTitle,
    /// A world size side outside 64..=4096 (genex-core's `MIN_WORLD_PX..=MAX_WORLD_PX`).
    InvalidWorldSize,
    /// A save name with characters outside letters, digits, space, `_`, `-`, `.`.
    InvalidSaveName,
    /// A crate off the reviewed allowlist, named by anything but an exact pin (`=X.Y.Z`).
    CrateNotAllowlisted,
    /// A WGSL path that is not a plain relative `.wgsl` path.
    InvalidWgslPath,
    /// The same WGSL path twice.
    DuplicateWgslPath,
    /// The same native feature twice.
    DuplicateNativeFeature,
    /// An allowlisted crate whose version is not a plain requirement (`0.9`, `^0.9.0`, `~2.5`, `=2.5.0`).
    InvalidCrateVersion,
    /// A `[[crate_request]]` row without a crate name and one exact release, with an overlong reason, or twice.
    InvalidCrateRequest,
    /// A `[[wgsl]] api` the facade never defined.
    UnknownExtensionApi,
    /// A `[[wgsl]] api` this renderer does not serve yet.
    ExtensionApiUnavailable,
    /// A preset outside [`QualityPreset`], in `[render]` or a class table.
    InvalidRenderPreset,
    /// A `[render.class.<class>]` naming no [`DeviceClass`].
    UnknownDeviceClass,
    /// A form factor outside [`FormFactor`], or one named twice.
    InvalidFormFactor,
    /// A render scale outside [`RENDER_SCALE_MIN`]..=[`RENDER_SCALE_MAX`].
    InvalidRenderScale,
    /// An fps other than one of [`RENDER_FPS_TARGETS`].
    InvalidRenderFps,
    /// A class switch naming no [`RenderFeature`].
    UnknownRenderFeature,
    /// A `[render.look]` value outside its vocabulary or range.
    InvalidRenderLook,
    /// A `[render.shadows]` value outside its range.
    InvalidRenderShadows,
    /// A class table's LOD key outside its range (`lod_threshold_px`, `lod_fade_band`, `far_density`).
    InvalidRenderLod,
    /// A `[render.loading]` value that breaks its rule (a colour not `#rrggbb`, a logo outside `assets/`).
    InvalidRenderLoading,
    /// A `[web] wasm_budget_mb` outside [`WEB_WASM_BUDGET_MIN_MB`]..=[`WEB_WASM_CEILING_MB`].
    InvalidWebBudget,
    /// A `[[texture]]` row whose usage is not color, data or normal, whose path is not a safe path under assets/ to a PNG, JPEG or WebP, or whose path another row names.
    InvalidTextureUsage,
    /// An `[[asset_group]]` row whose name is malformed, reserved or taken, whose paths are none, too
    /// many, repeated or a glob outside assets/; or more rows than [`MAX_ASSET_GROUPS`].
    InvalidAssetGroup,
    /// An `[assets]` or `[assets.<destination>]` budget below [`ASSET_BUDGET_MIN_MB`] or past the
    /// destination's hard cap ([`ASSET_BUDGET_MAX_MB`] for `[assets]` and desktop).
    AssetBudgetOutOfRange,
    /// An `[assets] phone_max_texture_px` that is not a power of two from [`PHONE_TEXTURE_CAP_MIN_PX`] to [`PHONE_TEXTURE_CAP_MAX_PX`].
    InvalidTextureCap,
}

impl ManifestErrorCode {
    /// The typed code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ManifestErrorCode::Syntax => "manifest-syntax",
            ManifestErrorCode::InvalidTitle => "invalid-title",
            ManifestErrorCode::InvalidWorldSize => "invalid-world-size",
            ManifestErrorCode::InvalidSaveName => "invalid-save-name",
            ManifestErrorCode::CrateNotAllowlisted => "crate-not-allowlisted",
            ManifestErrorCode::InvalidWgslPath => "invalid-wgsl-path",
            ManifestErrorCode::DuplicateWgslPath => "duplicate-wgsl-path",
            ManifestErrorCode::DuplicateNativeFeature => "duplicate-native-feature",
            ManifestErrorCode::InvalidCrateVersion => "invalid-crate-version",
            ManifestErrorCode::InvalidCrateRequest => "invalid-crate-request",
            ManifestErrorCode::UnknownExtensionApi => "unknown-extension-api",
            ManifestErrorCode::ExtensionApiUnavailable => "extension-api-unavailable",
            ManifestErrorCode::InvalidRenderPreset => "invalid-render-preset",
            ManifestErrorCode::UnknownDeviceClass => "unknown-device-class",
            ManifestErrorCode::InvalidFormFactor => "invalid-form-factor",
            ManifestErrorCode::InvalidRenderScale => "invalid-render-scale",
            ManifestErrorCode::InvalidRenderFps => "invalid-render-fps",
            ManifestErrorCode::UnknownRenderFeature => "unknown-render-feature",
            ManifestErrorCode::InvalidRenderLook => "invalid-render-look",
            ManifestErrorCode::InvalidRenderShadows => "invalid-render-shadows",
            ManifestErrorCode::InvalidRenderLod => "invalid-render-lod",
            ManifestErrorCode::InvalidRenderLoading => "invalid-render-loading",
            ManifestErrorCode::InvalidWebBudget => "invalid-web-budget",
            ManifestErrorCode::InvalidTextureUsage => "invalid-texture-usage",
            ManifestErrorCode::InvalidAssetGroup => "invalid-asset-group",
            ManifestErrorCode::AssetBudgetOutOfRange => "asset-budget-out-of-range",
            ManifestErrorCode::InvalidTextureCap => "invalid-texture-cap",
        }
    }
}

/// A refused `genex.toml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestError {
    code: ManifestErrorCode,
    detail: String,
}

impl ManifestError {
    fn new(code: ManifestErrorCode, detail: impl Into<String>) -> ManifestError {
        ManifestError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> ManifestErrorCode {
        self.code
    }
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for ManifestError {}

/// Parse and check a `genex.toml`.
pub fn parse(text: &str) -> Result<GenexToml, ManifestError> {
    let manifest: GenexToml =
        toml::from_str(text).map_err(|error| ManifestError::new(ManifestErrorCode::Syntax, error.message()))?;
    check_game(&manifest.game)?;
    check_crates(&manifest.crates)?;
    check_crate_requests(&manifest.crate_request)?;
    check_wgsl(&manifest.wgsl)?;
    check_features(&manifest.gpu.native_features)?;
    check_render(&manifest.render)?;
    check_web(&manifest.web)?;
    check_textures(&manifest.texture)?;
    check_asset_groups(&manifest.asset_group)?;
    check_assets(&manifest.assets)?;
    Ok(manifest)
}

/// The smallest package budget a game may name, in MB (the host's `ASSET_BUDGET_MIN_MB`).
pub const ASSET_BUDGET_MIN_MB: i64 = 1;
/// The largest `[assets] budget_mb` and desktop budget (the host's `ASSET_BUDGET_MAX_MB`): a bound on the key.
pub const ASSET_BUDGET_MAX_MB: i64 = 65536;
/// The web package's hard cap in MB: the shell admits at most this much (genex-platform-web's `MAX_ASSETS_TOTAL_BYTES`).
pub const WEB_ASSETS_CEILING_MB: i64 = 512;
/// A phone package's hard cap in MB.
pub const PHONE_ASSETS_CEILING_MB: i64 = 4096;
/// The smallest and largest `[assets] phone_max_texture_px`.
pub const PHONE_TEXTURE_CAP_MIN_PX: i64 = 512;
/// See [`PHONE_TEXTURE_CAP_MIN_PX`].
pub const PHONE_TEXTURE_CAP_MAX_PX: i64 = 4096;

/// Budgets from 1 MB to each destination's cap, and a phone texture cap that is a power of two from
/// 512 to 4096 px (the host's `checkAssets`).
fn check_assets(assets: &AssetsSection) -> Result<(), ManifestError> {
    let destinations = [
        ("web", &assets.web, WEB_ASSETS_CEILING_MB),
        ("ios", &assets.ios, PHONE_ASSETS_CEILING_MB),
        ("android", &assets.android, PHONE_ASSETS_CEILING_MB),
        ("desktop", &assets.desktop, ASSET_BUDGET_MAX_MB),
    ];
    if let Some(mb) = assets.budget_mb.filter(|mb| !(ASSET_BUDGET_MIN_MB..=ASSET_BUDGET_MAX_MB).contains(mb)) {
        return Err(ManifestError::new(ManifestErrorCode::AssetBudgetOutOfRange, format!("assets.budget_mb {mb}")));
    }
    for (name, row, max) in destinations {
        let named = row.as_ref().and_then(|row| row.budget_mb);
        if let Some(mb) = named.filter(|mb| !(ASSET_BUDGET_MIN_MB..=max).contains(mb)) {
            let detail = format!("assets.{name}.budget_mb {mb}");
            return Err(ManifestError::new(ManifestErrorCode::AssetBudgetOutOfRange, detail));
        }
    }
    let cap_fits = |px: &i64| (PHONE_TEXTURE_CAP_MIN_PX..=PHONE_TEXTURE_CAP_MAX_PX).contains(px) && px & (px - 1) == 0;
    match assets.phone_max_texture_px {
        Some(px) if !cap_fits(&px) => {
            Err(ManifestError::new(ManifestErrorCode::InvalidTextureCap, format!("assets.phone_max_texture_px {px}")))
        }
        _ => Ok(()),
    }
}

fn check_web(web: &WebSection) -> Result<(), ManifestError> {
    match web.wasm_budget_mb {
        Some(mb) if !(WEB_WASM_BUDGET_MIN_MB..=WEB_WASM_CEILING_MB).contains(&mb) => {
            Err(ManifestError::new(ManifestErrorCode::InvalidWebBudget, format!("web.wasm_budget_mb {mb}")))
        }
        _ => Ok(()),
    }
}

/// The usages a `[[texture]]` row may name (the host's TextureUsage).
const TEXTURE_USAGES: [&str; 3] = ["color", "data", "normal"];

/// The image extensions a `[[texture]]` row may name (the host's encodable raster textures).
const TEXTURE_EXTENSIONS: [&str; 4] = [".png", ".jpg", ".jpeg", ".webp"];

/// Each `[[texture]]` row names a known usage and an encodable image under assets/, and no path twice.
fn check_textures(rows: &[TextureRow]) -> Result<(), ManifestError> {
    let mut seen = crate::map::Set::default();
    for row in rows {
        if !TEXTURE_USAGES.contains(&row.usage.as_str()) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidTextureUsage, format!("{} usage {}", row.path, row.usage)));
        }
        let lower = row.path.to_ascii_lowercase();
        let image = TEXTURE_EXTENSIONS.iter().any(|extension| lower.ends_with(extension));
        if !genex_core::paths::is_safe_asset_path(&row.path) || !image || !seen.insert(row.path.clone()) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidTextureUsage, row.path.clone()));
        }
    }
    Ok(())
}

/// The asset groups every build already has (the web map's boot, sim and stream groups): an
/// `[[asset_group]]` may not take one of these names, in any case.
pub const RESERVED_ASSET_GROUPS: [&str; 3] = ["boot", "sim", "stream"];
/// The most `[[asset_group]]` rows a game declares.
pub const MAX_ASSET_GROUPS: usize = 64;
/// The most paths one `[[asset_group]]` lists.
pub const MAX_ASSET_GROUP_PATHS: usize = 256;
/// The longest asset group name.
const MAX_ASSET_GROUP_NAME_CHARS: usize = 64;
/// The glob segment that matches any number of whole segments.
const ANY_SEGMENTS: &str = "**";

/// Each `[[asset_group]]` has a free, unreserved name and 1..=[`MAX_ASSET_GROUP_PATHS`] distinct globs
/// under assets/; at most [`MAX_ASSET_GROUPS`] rows. One path in two groups is allowed (the host's
/// `checkAssetGroups`).
fn check_asset_groups(rows: &[AssetGroupRow]) -> Result<(), ManifestError> {
    if rows.len() > MAX_ASSET_GROUPS {
        return Err(ManifestError::new(ManifestErrorCode::InvalidAssetGroup, format!("{} groups", rows.len())));
    }
    let mut names = crate::map::Set::default();
    for row in rows {
        let reserved = RESERVED_ASSET_GROUPS.contains(&row.name.to_ascii_lowercase().as_str());
        if !valid_asset_group_name(&row.name) || reserved || !names.insert(row.name.clone()) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidAssetGroup, format!("{:?}", row.name)));
        }
        if row.paths.is_empty() || row.paths.len() > MAX_ASSET_GROUP_PATHS {
            let detail = format!("{} has {} paths", row.name, row.paths.len());
            return Err(ManifestError::new(ManifestErrorCode::InvalidAssetGroup, detail));
        }
        let mut seen = crate::map::Set::default();
        if let Some(bad) = row.paths.iter().find(|glob| !is_asset_glob(glob) || !seen.insert(glob.as_str())) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidAssetGroup, format!("{} {bad:?}", row.name)));
        }
    }
    Ok(())
}

/// A letter or digit, then letters, digits, `_` and `-`, at most [`MAX_ASSET_GROUP_NAME_CHARS`].
fn valid_asset_group_name(name: &str) -> bool {
    let first = name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let rest = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    first && rest && name.chars().count() <= MAX_ASSET_GROUP_NAME_CHARS
}

/// Whether `glob` stays under assets/: the safe asset path rule with `*` and `?` inside a segment and
/// `**` as a whole segment; no other glob syntax (the host's `isAssetGlob`).
fn is_asset_glob(glob: &str) -> bool {
    !glob.is_empty() && glob.split('/').all(is_asset_glob_segment)
}

fn is_asset_glob_segment(segment: &str) -> bool {
    if segment == ANY_SEGMENTS {
        return true;
    }
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '*' | '?' | '-');
    if segment.is_empty() || !segment.chars().all(allowed) || segment.contains(ANY_SEGMENTS) {
        return false;
    }
    segment.contains(['*', '?']) || genex_core::paths::is_safe_asset_path(segment)
}

fn check_game(game: &GameSection) -> Result<(), ManifestError> {
    let title = game.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(ManifestError::new(ManifestErrorCode::InvalidTitle, format!("{:?}", game.title)));
    }
    if !game.world_size.iter().all(|side| (MIN_WORLD_PX..=MAX_WORLD_PX).contains(side)) {
        let [w, h] = game.world_size;
        return Err(ManifestError::new(ManifestErrorCode::InvalidWorldSize, format!("{w}x{h}")));
    }
    match &game.save_name {
        Some(name) if !valid_save_name(name) => Err(ManifestError::new(ManifestErrorCode::InvalidSaveName, name.clone())),
        _ => Ok(()),
    }
}

/// The C++ template's save-name rule: letters, digits, space, `_`, `-`, `.`; never `.` or `..`.
fn valid_save_name(name: &str) -> bool {
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.');
    let length = name.chars().count();
    (1..=MAX_SAVE_NAME_CHARS).contains(&length) && name.chars().all(allowed) && !matches!(name, "." | "..")
}

fn allowlisted(name: &str) -> bool {
    GAME_CRATE_ALLOWLIST.contains(&name)
}

/// A crate off the allowlist the host build may accept once the person approved it: a crate name at `=X.Y.Z`.
fn approvable_pin(name: &str, version: &str) -> bool {
    valid_crate_name(name) && version.strip_prefix('=').is_some_and(exact_release)
}

fn check_crates(crates: &Map<String, String>) -> Result<(), ManifestError> {
    let off_list = crates.iter().find(|(name, version)| !allowlisted(name) && !approvable_pin(name, version));
    if let Some((name, _)) = off_list {
        return Err(ManifestError::new(ManifestErrorCode::CrateNotAllowlisted, name.clone()));
    }
    match crates.iter().find(|(name, version)| allowlisted(name) && !plain_requirement(version)) {
        Some((name, version)) => {
            Err(ManifestError::new(ManifestErrorCode::InvalidCrateVersion, format!("{name} {version:?}")))
        }
        None => Ok(()),
    }
}

fn check_crate_requests(rows: &[CrateRequest]) -> Result<(), ManifestError> {
    let mut seen = crate::map::Set::default();
    for row in rows {
        let named = valid_crate_name(&row.name) && exact_release(&row.version);
        let reason_fits =
            row.reason.as_ref().is_none_or(|reason| reason.chars().count() <= MAX_REQUEST_REASON_CHARS);
        let key = format!("{}@{}", row.name, row.version);
        if !named || !reason_fits || seen.contains(&key) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidCrateRequest, key));
        }
        seen.insert(key);
    }
    Ok(())
}

/// A registry name: an ASCII letter, then letters, digits, `-` and `_`, at most 64 in all.
fn valid_crate_name(name: &str) -> bool {
    let rest_fits = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_');
    let first_is_letter = name.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    first_is_letter && name.len() <= MAX_CRATE_NAME_CHARS && name.chars().all(rest_fits)
}

/// `count` dot-separated runs of 1..=`width` ASCII digits.
fn numbers(text: &str, count: usize, width: usize) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    let digits = |part: &&str| (1..=width).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit());
    parts.len() == count && parts.iter().all(digits)
}

/// One exact release: `MAJOR.MINOR.PATCH` (each 1..=9 digits) with an optional `-pre-release`.
fn exact_release(version: &str) -> bool {
    let (release, pre) = match version.split_once('-') {
        Some((release, pre)) => (release, Some(pre)),
        None => (version, None),
    };
    let pre_fits = pre.is_none_or(|pre| {
        let fits = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-');
        (1..=MAX_PRE_RELEASE_CHARS).contains(&pre.len()) && pre.chars().all(fits)
    });
    numbers(release, 3, 9) && pre_fits
}

/// A requirement the host writes into the cargo manifest: an optional `=`, `^` or `~`, then 1 to 3 numbers.
fn plain_requirement(version: &str) -> bool {
    let bare = version.strip_prefix(['=', '^', '~']).unwrap_or(version);
    (1..=3).any(|count| numbers(bare, count, 6))
}

fn check_wgsl(sources: &[WgslSource]) -> Result<(), ManifestError> {
    let mut seen = crate::map::Set::default();
    for source in sources {
        if !valid_wgsl_path(&source.path) {
            return Err(ManifestError::new(ManifestErrorCode::InvalidWgslPath, source.path.clone()));
        }
        if !seen.insert(source.path.as_str()) {
            return Err(ManifestError::new(ManifestErrorCode::DuplicateWgslPath, source.path.clone()));
        }
        check_declared_api(source, &EXTENSION_APIS)?;
    }
    Ok(())
}

/// The `[[wgsl]] api` versions the facade's Level-2 calls admit a source at: each against its own
/// prelude (v1 `GxMaterialIn`/`GxPostIn`, v2 `GxMaterialInV2`/`GxPostInV2` with the game group).
pub const LEVEL_TWO_ADMITTED_APIS: [u32; 2] = [1, 2];

/// A source's api as its call admits it: one the facade defined, and one the Level-2 calls admit
/// ([`LEVEL_TWO_ADMITTED_APIS`]).
pub(crate) fn check_wgsl_api(source: &WgslSource) -> Result<(), ManifestError> {
    check_declared_api(source, &LEVEL_TWO_ADMITTED_APIS)
}

/// A declared api: one the facade defined (`unknown-extension-api` otherwise), and one of `served`
/// (`extension-api-unavailable` otherwise).
fn check_declared_api(source: &WgslSource, served: &[u32]) -> Result<(), ManifestError> {
    let detail = || format!("{} api {}", source.path, source.api);
    if !WGSL_EXTENSION_APIS.contains(&source.api) {
        return Err(ManifestError::new(ManifestErrorCode::UnknownExtensionApi, detail()));
    }
    if !served.iter().any(|api| i64::from(*api) == source.api) {
        return Err(ManifestError::new(ManifestErrorCode::ExtensionApiUnavailable, detail()));
    }
    Ok(())
}

/// `[render]`'s values, in the order the host's reader checks them: form factors, the preset, the
/// look, each class table (its name, preset, scale, fps, then its switches), then the shadows.
fn check_render(render: &RenderSection) -> Result<(), ManifestError> {
    let mut seen: Vec<FormFactor> = Vec::new();
    for name in &render.form_factors {
        match FormFactor::from_wire(name) {
            Some(factor) if !seen.contains(&factor) => seen.push(factor),
            _ => return Err(ManifestError::new(ManifestErrorCode::InvalidFormFactor, name.clone())),
        }
    }
    check_preset(render.preset.as_deref())?;
    check_look(&render.look)?;
    for (name, class) in &render.class {
        if DeviceClass::from_wire(name).is_none() {
            return Err(ManifestError::new(ManifestErrorCode::UnknownDeviceClass, name.clone()));
        }
        check_class(name, class)?;
    }
    check_shadows(&render.shadows)?;
    check_loading(&render.loading)
}

/// `[render.loading]`'s title, colours and logo each within its rule (`shared/loading-style.ts`).
fn check_loading(loading: &LoadingSection) -> Result<(), ManifestError> {
    let bad = |key: &str, value: &str| Err(ManifestError::new(ManifestErrorCode::InvalidRenderLoading, format!("{key} {value:?}")));
    if let Some(title) = loading.title.as_deref().filter(|title| !is_loading_title(title)) {
        return bad("title", title);
    }
    for (key, color) in [("background", &loading.background), ("accent", &loading.accent), ("text", &loading.text)] {
        if let Some(color) = color.as_deref().filter(|color| !is_loading_color(color)) {
            return bad(key, color);
        }
    }
    match loading.logo.as_deref().filter(|logo| !is_loading_logo(logo)) {
        Some(logo) => bad("logo", logo),
        None => Ok(()),
    }
}

/// `[render.shadows]`'s distance and blend band within their ranges (a NaN band refused too).
fn check_shadows(shadows: &ShadowsSection) -> Result<(), ManifestError> {
    let bad = |what: String| Err(ManifestError::new(ManifestErrorCode::InvalidRenderShadows, what));
    if shadows.distance.is_some_and(|distance| !(SHADOW_DISTANCE_MIN..=SHADOW_DISTANCE_MAX).contains(&distance)) {
        return bad(format!("distance {:?}", shadows.distance));
    }
    if shadows.blend_band.is_some_and(|band| !(0.0..=SHADOW_BLEND_BAND_MAX).contains(&band)) {
        return bad(format!("blend_band {:?}", shadows.blend_band));
    }
    Ok(())
}

fn check_preset(preset: Option<&str>) -> Result<(), ManifestError> {
    match preset {
        Some(name) if QualityPreset::from_wire(name).is_none() => {
            Err(ManifestError::new(ManifestErrorCode::InvalidRenderPreset, name))
        }
        _ => Ok(()),
    }
}

fn check_look(look: &LookSection) -> Result<(), ManifestError> {
    let bad = |what: String| Err(ManifestError::new(ManifestErrorCode::InvalidRenderLook, what));
    let known = |value: &Option<String>, known: fn(&str) -> bool| value.as_deref().is_none_or(known);
    if !known(&look.tonemapper, |name| Tonemapper::from_wire(name).is_some()) {
        return bad(format!("tonemapper {:?}", look.tonemapper));
    }
    if !known(&look.exposure, |name| ExposureMode::from_wire(name).is_some()) {
        return bad(format!("exposure {:?}", look.exposure));
    }
    if !known(&look.metering, |name| Metering::from_wire(name).is_some()) {
        return bad(format!("metering {:?}", look.metering));
    }
    let ev_range = -EV_COMPENSATION_LIMIT..=EV_COMPENSATION_LIMIT;
    if look.ev_compensation.is_some_and(|ev| !ev_range.contains(&ev)) {
        return bad(format!("ev_compensation {:?}", look.ev_compensation));
    }
    if look.bloom_intensity.is_some_and(|bloom| !(0.0..=BLOOM_INTENSITY_MAX).contains(&bloom)) {
        return bad(format!("bloom_intensity {:?}", look.bloom_intensity));
    }
    check_auto_exposure(look)?;
    check_effects(look)
}

/// A `[render.look]` key, its value and the range it must be in.
type LookRange<'a> = (&'static str, Option<f64>, &'a dyn Fn(f64) -> bool);

/// The RQ4 keys' ranges: bloom's threshold and spread, GTAO's strength and radius, the fog and
/// the contact shadows' length (each written so a NaN, TOML's `nan`, is refused too).
fn check_effects(look: &LookSection) -> Result<(), ManifestError> {
    let bad = |key: &str, value: Option<f64>| Err(ManifestError::new(ManifestErrorCode::InvalidRenderLook, format!("{key} {value:?}")));
    let within = |min: f64, max: f64| move |v: f64| (min..=max).contains(&v);
    let positive_up_to = |max: f64| move |v: f64| v > 0.0 && v <= max;
    let ranges: [LookRange<'_>; 10] = [
        ("bloom_threshold", look.bloom_threshold, &within(0.0, BLOOM_THRESHOLD_MAX)),
        ("bloom_radius", look.bloom_radius, &within(BLOOM_RADIUS_MIN, BLOOM_RADIUS_MAX)),
        ("ao_intensity", look.ao_intensity, &within(0.0, AO_INTENSITY_MAX)),
        ("ao_radius", look.ao_radius, &positive_up_to(AO_RADIUS_MAX)),
        ("fog_density", look.fog_density, &within(0.0, FOG_DENSITY_MAX)),
        ("fog_height_falloff", look.fog_height_falloff, &within(0.0, FOG_HEIGHT_FALLOFF_MAX)),
        ("fog_base_height", look.fog_base_height, &within(-FOG_DISTANCE_LIMIT, FOG_DISTANCE_LIMIT)),
        ("fog_start", look.fog_start, &within(0.0, FOG_DISTANCE_LIMIT)),
        ("fog_max_opacity", look.fog_max_opacity, &within(0.0, 1.0)),
        ("contact_shadow_length", look.contact_shadow_length, &positive_up_to(CONTACT_SHADOW_LENGTH_MAX)),
    ];
    for (key, value, valid) in ranges {
        if value.is_some_and(|v| !valid(v)) {
            return bad(key, value);
        }
    }
    let channel = within(0.0, FOG_COLOR_MAX);
    if let Some(color) = &look.fog_color
        && (color.len() != 3 || !color.iter().all(|c| channel(*c)))
    {
        return Err(ManifestError::new(ManifestErrorCode::InvalidRenderLook, format!("fog_color {color:?}")));
    }
    Ok(())
}

/// Auto exposure's limits (each within ±[`EXPOSURE_EV_LIMIT`], the floor not above the ceiling)
/// and speeds (each in `(0, ADAPTATION_SPEED_MAX]`).
fn check_auto_exposure(look: &LookSection) -> Result<(), ManifestError> {
    let bad = |key: &str, value: Option<f64>| Err(ManifestError::new(ManifestErrorCode::InvalidRenderLook, format!("{key} {value:?}")));
    let ev_range = -EXPOSURE_EV_LIMIT..=EXPOSURE_EV_LIMIT;
    for (key, value) in [("ev_min", look.ev_min), ("ev_max", look.ev_max)] {
        if value.is_some_and(|ev| !ev_range.contains(&ev)) {
            return bad(key, value);
        }
    }
    if let (Some(floor), Some(ceiling)) = (look.ev_min, look.ev_max)
        && floor > ceiling
    {
        return bad("ev_min", look.ev_min);
    }
    for (key, value) in [("adaptation_speed_up", look.adaptation_speed_up), ("adaptation_speed_down", look.adaptation_speed_down)] {
        // Written so a NaN (TOML's `nan`) is refused too.
        if value.is_some_and(|speed| !(speed > 0.0 && speed <= ADAPTATION_SPEED_MAX)) {
            return bad(key, value);
        }
    }
    Ok(())
}

fn check_class(name: &str, class: &ClassSection) -> Result<(), ManifestError> {
    check_preset(class.preset.as_deref())?;
    if class.render_scale.is_some_and(|scale| !(RENDER_SCALE_MIN..=RENDER_SCALE_MAX).contains(&scale)) {
        let detail = format!("render.class.{name}.render_scale {:?}", class.render_scale);
        return Err(ManifestError::new(ManifestErrorCode::InvalidRenderScale, detail));
    }
    if class.fps.is_some_and(|fps| !RENDER_FPS_TARGETS.contains(&fps)) {
        let detail = format!("render.class.{name}.fps {:?}", class.fps);
        return Err(ManifestError::new(ManifestErrorCode::InvalidRenderFps, detail));
    }
    check_class_lod(name, class)?;
    match class.switches.keys().find(|key| RenderFeature::from_wire(key).is_none()) {
        Some(key) => {
            Err(ManifestError::new(ManifestErrorCode::UnknownRenderFeature, format!("render.class.{name}.{key}")))
        }
        None => Ok(()),
    }
}

/// A class table's LOD keys (game systems LOD-06), each within its range; written so a NaN (TOML's
/// `nan`) is refused too.
fn check_class_lod(name: &str, class: &ClassSection) -> Result<(), ManifestError> {
    let keys = [
        ("lod_threshold_px", class.lod_threshold_px, LOD_THRESHOLD_PX_MIN, LOD_THRESHOLD_PX_MAX),
        ("lod_fade_band", class.lod_fade_band, 0.0, LOD_FADE_BAND_MAX),
        ("far_density", class.far_density, FAR_DENSITY_MIN, 1.0),
    ];
    match keys.into_iter().find(|(_, value, low, high)| value.is_some_and(|v| !(v >= *low && v <= *high))) {
        Some((key, value, _, _)) => Err(ManifestError::new(ManifestErrorCode::InvalidRenderLod, format!("render.class.{name}.{key} {value:?}"))),
        None => Ok(()),
    }
}

/// A plain relative path ending in `.wgsl`. The host still resolves it by realpath inside the
/// staged copy and refuses links (plan "GPU bounds"); this is the data-level row.
pub(crate) fn valid_wgsl_path(path: &str) -> bool {
    let plain = !path.starts_with(['/', '~']) && !path.contains(['\\', ':']) && path.ends_with(".wgsl");
    plain && path.split('/').all(|segment| !matches!(segment, "" | "." | ".."))
}

fn check_features(features: &[NativeFeature]) -> Result<(), ManifestError> {
    let mut seen = crate::map::Set::default();
    match features.iter().find(|feature| !seen.insert(**feature)) {
        Some(feature) => Err(ManifestError::new(ManifestErrorCode::DuplicateNativeFeature, feature.as_str())),
        None => Ok(()),
    }
}
