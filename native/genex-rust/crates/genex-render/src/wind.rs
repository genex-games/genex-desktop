//! The shared wind (renderer pass 2, B.7; A.8's A4.3 wind field builds on it): one gust and one
//! flutter field over the world, a function of a plant's root and simulated seconds only, so a
//! vertex animation evaluates it at this frame's time and at last frame's and draws its own motion
//! vectors ([`crate::custom_pass::PassFrame::motion_draws`]). Its WGSL (`gx_wind`, `GxWind`,
//! `GX_WIND_DIR`) is part of `shaders/common.wgsl`, so every renderer module, the custom-pass
//! tables ([`crate::custom_pass::TABLES_V2_WGSL`]) and the grass read the same field; [`wind`] is
//! its CPU twin.
//!
//! **Model wind** (vegetation lane): a draw whose material carries a [`Sway`]
//! ([`crate::pbr::Material::sway`]) bends in that field in the vertex stage of every pass that
//! draws it (the world pass, the prepass and its motion, the sun and spot casters, the meshlet
//! path), after the layered scheme of Sousa's "Vegetation Procedural Animation" (GPU Gems 3,
//! ch. 16; the idea only, no code):
//!
//! - **Trunk**: the whole plant leans down the wind by the gust, by the square of a vertex's
//!   height over the plant's height, and sinks as it leans so the trunk keeps its length.
//! - **Branches**: a slower bob, by the square of a vertex's reach from the trunk over the
//!   plant's reach, out of phase across the crown and from plant to plant.
//! - **Flutter**: leaves (a material whose sway flutters) shiver at the flutter's rate, each in
//!   its own phase from its model-space position.
//!
//! The weights come from the vertex's model-space position and the model's extent alone, so any
//! GLB sways without painted vertex colours. The sway is display-only: it never reaches the sim or
//! its checksum. Its words ride in the instance row ([`crate::layout::GpuInstance::wind`]); a row
//! without wind has zero words and is drawn bit for bit as before. The row's bounding sphere grows
//! by [`Sway::reach`] so the cull never cuts a swaying tip; its LOD row keeps the still sphere, so
//! wind never moves a level switch. Motion vectors come from last frame's wind seconds
//! (`GpuFrame::texture_lod` z), so TAA reprojects the sway instead of trailing it; a swaying row
//! is never a still motion row and never a cached shadow caster.

use crate::post::tonemap::{f16_to_f32, f32_to_f16};

/// The wind's direction over the ground (unit, y 0): `GX_WIND_DIR`.
pub const WIND_DIR: [f32; 3] = [0.552_380_4, 0.0, 0.833_592_2];

/// The smallest extent (metres) a swaying model keeps: a flatter model sways as one this tall.
pub const SWAY_EXTENT_MIN: f32 = 0.05;
/// The largest bend or flutter (metres at full gust) a sway keeps.
pub const SWAY_BEND_MAX: f32 = 8.0;
/// The fastest flutter (hertz) a sway keeps.
pub const SWAY_FLUTTER_HZ_MAX: f32 = 20.0;
/// The largest finite half float: the words are `pack2x16float` pairs.
const HALF_MAX: f32 = 65504.0;
/// The branches' bob rate (radians a second).
const BRANCH_RATE: f32 = 1.9;
/// The share of the branches' bob that does not wait for a gust.
const BRANCH_CALM: f32 = 0.35;
/// The share of the leaves' flutter that does not wait for a gust.
const FLUTTER_CALM: f32 = 0.5;

/// The wind at one plant at one time: `GxWind`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Wind {
    /// The slow gust, 0.0..1.0 (0.5 on average): how far the wind leans a stem.
    pub gust: f32,
    /// The fast flutter, -1.0..1.0: a stem's quick shiver.
    pub flutter: f32,
}

/// `gx_wind`: the wind at a plant rooted at `root`, `t` simulated seconds in.
pub fn wind(root: [f32; 3], t: f32) -> Wind {
    let [x, _, z] = root;
    let gust = 0.5 + 0.3 * libm::sinf(t * 1.6 + x * 0.21 + z * 0.13) + 0.2 * libm::sinf(t * 0.55 + x * 0.045 - z * 0.03);
    let flutter = libm::sinf(t * 4.0 + x * 1.7 + z * 1.3);
    Wind { gust, flutter }
}

/// How one draw bends in the wind (model wind): the model's extent the weights are measured over
/// and each layer's size. Lengths are metres for a copy of scale 1 and scale with the copy.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sway {
    /// The model's height above its origin (metres): the trunk's weight is a vertex's height over
    /// it, squared.
    pub height: f32,
    /// The model's reach from its vertical axis (metres): the branches' and leaves' weight is a
    /// vertex's reach over it.
    pub reach: f32,
    /// How far the top leans down the wind at full gust (metres).
    pub trunk: f32,
    /// How far a branch tip bobs (metres).
    pub branch: f32,
    /// How far a leaf shivers (metres); 0 for bark and stems.
    pub flutter: f32,
    /// How fast a leaf shivers (hertz).
    pub flutter_hz: f32,
}

impl Sway {
    /// A sway held to its ranges: extents at least [`SWAY_EXTENT_MIN`], bends and flutter in
    /// `0..=`[`SWAY_BEND_MAX`], the rate in `0..=`[`SWAY_FLUTTER_HZ_MAX`]; anything not finite is
    /// its floor. `None` when nothing would move.
    pub fn held(self) -> Option<Sway> {
        let range = |value: f32, low: f32, high: f32| if value.is_finite() { value.clamp(low, high) } else { low };
        let held = Sway {
            height: range(self.height, SWAY_EXTENT_MIN, HALF_MAX),
            reach: range(self.reach, SWAY_EXTENT_MIN, HALF_MAX),
            trunk: range(self.trunk, 0.0, SWAY_BEND_MAX),
            branch: range(self.branch, 0.0, SWAY_BEND_MAX),
            flutter: range(self.flutter, 0.0, SWAY_BEND_MAX),
            flutter_hz: range(self.flutter_hz, 0.0, SWAY_FLUTTER_HZ_MAX),
        };
        let moves = held.trunk > 0.0 || held.branch > 0.0 || held.flutter > 0.0;
        moves.then_some(held)
    }

    /// The instance row's wind words (`GpuInstance::wind`): half floats in pairs, height and
    /// reach, trunk and branch, flutter and its rate. The first word is never 0 for a sway, so a
    /// row without wind (zero words) is told apart by it alone.
    pub fn words(self) -> [u32; 3] {
        let Some(held) = self.held() else { return [0; 3] };
        let pair = |low: f32, high: f32| u32::from(f32_to_f16(low)) | u32::from(f32_to_f16(high)) << 16;
        [pair(held.height, held.reach), pair(held.trunk, held.branch), pair(held.flutter, held.flutter_hz)]
    }

    /// The sway the words carry (what the shader reads), or `None` for a row without wind.
    pub fn from_words(words: [u32; 3]) -> Option<Sway> {
        if words[0] == 0 {
            return None;
        }
        let low = |word: u32| f16_to_f32((word & 0xffff) as u16);
        let high = |word: u32| f16_to_f32((word >> 16) as u16);
        Some(Sway { height: low(words[0]), reach: high(words[0]), trunk: low(words[1]), branch: high(words[1]), flutter: low(words[2]), flutter_hz: high(words[2]) })
    }

    /// The farthest any vertex of a copy of scale 1 moves from where it stands (metres): what its
    /// bounding sphere grows by.
    pub fn reach(self) -> f32 {
        self.held().map_or(0.0, |held| held.trunk + held.branch + held.flutter)
    }
}

/// `gx_sway_offset`: how far the vertex at model-space `local` of a copy under `model`
/// (column-major) moves from where it stands, `t` wind seconds in (world units). The CPU twin of
/// the WGSL, sine for sine (the GPU's `sin` differs from libm's in the last bits).
pub fn sway_offset(model: &[f32; 16], local: [f32; 3], sway: Sway, t: f32) -> [f32; 3] {
    let root = [model[12], model[13], model[14]];
    let scale = libm::sqrtf(model[4] * model[4] + model[5] * model[5] + model[6] * model[6]);
    let field = wind(root, t);
    let height = (local[1] / sway.height).clamp(0.0, 1.0);
    let reach = (libm::sqrtf(local[0] * local[0] + local[2] * local[2]) / sway.reach).clamp(0.0, 1.0);
    let lean = sway.trunk * scale * field.gust * height * height;
    let branch_phase = 1.3 * (0.7 * local[0] + 0.3 * local[1] + 1.1 * local[2]) + 0.37 * root[0] + 0.51 * root[2];
    let gusting = |calm: f32| calm + (1.0 - calm) * field.gust;
    let branch = sway.branch * scale * reach * reach * height * gusting(BRANCH_CALM) * libm::sinf(t * BRANCH_RATE + branch_phase);
    let leaf_phase = 7.3 * local[0] + 5.1 * local[1] + 9.7 * local[2];
    let flutter = sway.flutter * scale * reach * gusting(FLUTTER_CALM) * libm::sinf(t * sway.flutter_hz * std::f32::consts::TAU + leaf_phase);
    // The leaf shivers about an axis of its own: up, tipped towards its phase.
    let axis = [0.45 * libm::sinf(leaf_phase), 0.8, 0.45 * libm::cosf(leaf_phase)];
    // The lean sinks the vertex so the trunk keeps its length (the circle's sagitta).
    let standing = (height * sway.height * scale).max(SWAY_EXTENT_MIN);
    let sink = lean * lean / (2.0 * standing);
    [
        WIND_DIR[0] * (lean + 0.4 * branch) + axis[0] * flutter,
        0.6 * branch - sink + axis[1] * flutter,
        WIND_DIR[2] * (lean + 0.4 * branch) + axis[2] * flutter,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    const TREE: Sway = Sway { height: 12.0, reach: 4.0, trunk: 0.3, branch: 0.12, flutter: 0.03, flutter_hz: 3.0 };
    const AT_ORIGIN: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

    fn length(v: [f32; 3]) -> f32 {
        libm::sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    }

    #[test]
    fn the_wind_direction_is_a_unit_vector_along_the_ground() {
        let [x, y, z] = WIND_DIR;
        assert_eq!(y, 0.0);
        assert!((x * x + z * z - 1.0).abs() < 1e-6);
        assert!(include_str!("../shaders/common.wgsl").contains("vec3<f32>(0.55238038, 0.0, 0.83359218)"), "the WGSL constant is the CPU one");
    }

    #[test]
    fn the_gust_stays_within_its_range_and_moves_with_time() {
        let root = [3.0, 0.0, -7.0];
        let samples: Vec<Wind> = (0..600).map(|tick| wind(root, tick as f32 / 60.0)).collect();
        assert!(samples.iter().all(|w| (0.0..=1.0).contains(&w.gust) && (-1.0..=1.0).contains(&w.flutter)));
        assert_ne!(samples[0], samples[1], "the wind moves from one tick to the next");
        assert_eq!(wind(root, 2.5), wind(root, 2.5), "a function of root and time only");
    }

    #[test]
    fn a_sway_round_trips_through_its_words_at_half_precision() {
        let back = Sway::from_words(TREE.words()).expect("a sway");
        for (got, want) in [(back.height, TREE.height), (back.reach, TREE.reach), (back.trunk, TREE.trunk), (back.branch, TREE.branch), (back.flutter, TREE.flutter), (back.flutter_hz, TREE.flutter_hz)] {
            assert!((got - want).abs() <= want * 1e-3, "{got} against {want}");
        }
        assert_ne!(TREE.words()[0], 0, "a sway's first word is never 0");
    }

    #[test]
    fn a_still_or_hostile_sway_has_no_words() {
        let still = Sway { trunk: 0.0, branch: 0.0, flutter: 0.0, ..TREE };
        assert_eq!(still.words(), [0; 3]);
        assert_eq!(still.reach(), 0.0);
        assert_eq!(Sway::from_words([0; 3]), None);
        let hostile = Sway { height: f32::NAN, reach: -3.0, trunk: f32::INFINITY, branch: -1.0, flutter: 1.0e9, flutter_hz: f32::NAN };
        let held = hostile.held().expect("the flutter still moves");
        assert_eq!((held.height, held.reach, held.trunk, held.branch, held.flutter, held.flutter_hz), (SWAY_EXTENT_MIN, SWAY_EXTENT_MIN, 0.0, 0.0, SWAY_BEND_MAX, 0.0));
    }

    #[test]
    fn the_root_stands_still_and_the_top_leans_down_the_wind() {
        for tick in 0..240 {
            let t = tick as f32 / 60.0;
            assert_eq!(sway_offset(&AT_ORIGIN, [0.0, 0.0, 0.0], TREE, t), [0.0; 3], "the root never moves");
            let top = sway_offset(&AT_ORIGIN, [0.0, 12.0, 0.0], TREE, t);
            let along = top[0] * WIND_DIR[0] + top[2] * WIND_DIR[2];
            assert!(along >= 0.0, "the top leans down the wind, never into it: {top:?}");
            assert!(top[1] <= 0.0, "a lean never lifts the top");
        }
    }

    #[test]
    fn no_vertex_moves_farther_than_the_reach_the_bounds_grow_by() {
        let scaled = [2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 30.0, 0.0, -9.0, 1.0];
        let mut farthest = 0.0_f32;
        for tick in 0..600 {
            for local in [[0.0, 12.0, 0.0], [4.0, 9.0, 0.0], [-2.0, 6.0, 3.0], [0.5, 14.0, -4.5]] {
                farthest = farthest.max(length(sway_offset(&scaled, local, TREE, tick as f32 / 30.0)));
            }
        }
        assert!(farthest <= TREE.reach() * 2.0, "{farthest} past the reach of a copy of scale 2");
        assert!(farthest > 0.1, "the crown moves");
    }

    #[test]
    fn the_sway_is_a_function_of_the_row_and_the_time_alone() {
        let a = sway_offset(&AT_ORIGIN, [1.0, 8.0, 2.0], TREE, 3.25);
        assert_eq!(a, sway_offset(&AT_ORIGIN, [1.0, 8.0, 2.0], TREE, 3.25));
        assert_ne!(a, sway_offset(&AT_ORIGIN, [1.0, 8.0, 2.0], TREE, 3.5), "it moves with time");
        let moved = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 17.0, 0.0, 5.0, 1.0];
        assert_ne!(a, sway_offset(&moved, [1.0, 8.0, 2.0], TREE, 3.25), "two plants sway out of step");
    }
}
