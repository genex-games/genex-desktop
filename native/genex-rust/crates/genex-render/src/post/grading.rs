//! Colour grading (A.2): the look's parametric grading and its display-referred 3D LUT, both drawn
//! inside the tonemap (graph node 21, [`crate::post::tonemap`]); no pass of its own.
//!
//! - **Parametric** ([`Grading`]): Bevy 0.16's `sectional_color_grading` knobs (MIT OR Apache-2.0):
//!   saturation, contrast, gamma, gain and lift per section (shadows, midtones, highlights, blended
//!   across a margin as Blender's compositor does), on the white-balanced scene-linear colour
//!   before the curve. Contrast turns in log space about [`MIDDLE_GREY`] as Filament's does
//!   (`ColorGrading.cpp`, Apache-2.0), not about Bevy's linear 0.5, so a contrast never shifts the
//!   exposure (pass-2 finding C12); vibrance is Filament's. Bevy blends the shadows' margin into
//!   the highlights' weight (`levels.z`); here it blends shadows into midtones.
//! - **LUT** ([`GradingLut`]): an Adobe Cube LUT 1.0 `.cube` (parsed here: `LUT_3D_SIZE`
//!   [`LUT_SIDE_MIN`]..=[`LUT_SIDE_MAX`], signed `DOMAIN_MIN`/`DOMAIN_MAX`, a typed
//!   [`GradingLutError`] for anything else), applied to the encoded display colour after the curve
//!   and before the dither, with pmndrs/postprocessing's tetrahedral interpolation (`lut-3d.frag`,
//!   Zlib): four loads and barycentric weights, no hardware filter whose fractions are 8-bit.
//!   The GPU holds each texel's change from the identity in `rgba16float` ([`LutUpload`]), so an
//!   identity LUT stores zeros and draws the ungraded picture byte for byte. The upload is
//!   resampled to the encoded colour's `[0, 1]` domain and to the class's side
//!   ([`lut_side_max`]: 16³ on mobile-low).
//!
//! A look holds its LUT as `&'static GradingLut` ([`GradingLut::intern`]) so [`crate::Look`] stays
//! `Copy`: a table interns once per content, and at most [`INTERNED_LUTS_MAX`] tables a process.
//!
//! Shader: `shaders/post/tonemap.wgsl` (`gx_grade`, `gx_grade_lut`), held to [`Grading::grade`]
//! and [`LutUpload::apply`] by `tests/grading.rs`.

use std::sync::Mutex;

use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
use crate::post::tonemap::{f16_to_f32, f32_to_f16};

/// Scene-linear middle grey: the pivot contrast turns about.
pub const MIDDLE_GREY: f32 = 0.18;
/// The smallest `LUT_3D_SIZE` a `.cube` may name.
pub const LUT_SIDE_MIN: u32 = 2;
/// The largest `LUT_3D_SIZE` a `.cube` may name (65³, the largest common grading export).
pub const LUT_SIDE_MAX: u32 = 65;
/// The longest `.cube` text read (a 65³ table at about 30 bytes a row is 8.2 MB).
pub const CUBE_TEXT_BYTES_MAX: usize = 16 << 20;
/// The most distinct LUTs a process interns.
pub const INTERNED_LUTS_MAX: usize = 32;
/// The LUT's texel format: each texel's change from the identity, a half float a channel.
pub const LUT_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// The LUT's binding in the tonemap's group (`gx_grading_lut`).
pub const GRADING_LUT_BINDING: u32 = 5;
/// The largest radiance grading writes (the scene's own limit, `post::tonemap::SCENE_RADIANCE_MAX`).
const GRADED_RADIANCE_MAX: f32 = 64512.0;
/// Half the width of the blend between two sections, in level units (Bevy's `LEVEL_MARGIN`).
const LEVEL_MARGIN: f32 = 0.1;
/// Bevy's default midtones: levels from 0.2 to 0.7.
const MIDTONES_RANGE: [f32; 2] = [0.2, 0.7];
/// Rec. 709 luminance weights.
const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];
/// The darkest value the log-space contrast reads (0 has no logarithm).
const CONTRAST_FLOOR: f32 = 1.0e-10;
/// Vibrance's steepness over a colour's red excess (Filament's 3).
const VIBRANCE_STEEPNESS: f32 = 3.0;

/// The LUT side `class` uploads at most: a phone samples a smaller table (mobile-low 16³), a
/// desktop keeps every `.cube`'s own size.
pub const fn lut_side_max(class: DeviceClass) -> u32 {
    match (class.form, class.tier) {
        (FormFactor::Mobile, PerformanceTier::Low) => 16,
        (FormFactor::Mobile, PerformanceTier::Mid) => 25,
        (FormFactor::Mobile, _) => 33,
        (FormFactor::Desktop, _) => LUT_SIDE_MAX,
    }
}

/// `value` held to `min..=max`, or `default` when it is not a number.
fn held(value: f32, default: f32, min: f32, max: f32) -> f32 {
    if value.is_nan() { default } else { value.clamp(min, max) }
}

/// One section's knobs (Bevy's `ColorGradingSection`): neutral at saturation, contrast, gamma and
/// gain 1 and lift 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GradingSection {
    /// Saturation about Rec. 709 luminance, `0..=2`.
    pub saturation: f32,
    /// Contrast in log space about middle grey, `0..=2`.
    pub contrast: f32,
    /// The ASC CDL power's inverse, `0.1..=10` (above 1 brightens the section's midpoint).
    pub gamma: f32,
    /// The ASC CDL slope, `0..=4`.
    pub gain: f32,
    /// The ASC CDL offset in scene units, `-1..=1`.
    pub lift: f32,
}

impl GradingSection {
    /// A section that changes nothing.
    pub const NEUTRAL: GradingSection = GradingSection { saturation: 1.0, contrast: 1.0, gamma: 1.0, gain: 1.0, lift: 0.0 };

    /// The section with every knob held to its range (a value that is not a number is neutral).
    pub fn held(self) -> GradingSection {
        GradingSection {
            saturation: held(self.saturation, 1.0, 0.0, 2.0),
            contrast: held(self.contrast, 1.0, 0.0, 2.0),
            gamma: held(self.gamma, 1.0, 0.1, 10.0),
            gain: held(self.gain, 1.0, 0.0, 4.0),
            lift: held(self.lift, 0.0, -1.0, 1.0),
        }
    }
}

/// What the tonemap's grading draws: the `GX_GRADING` override's bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ShaderGrading(u32);

impl ShaderGrading {
    /// No grading: the pipeline the picture had before A.2, byte for byte.
    pub const NONE: ShaderGrading = ShaderGrading(0);
    const PARAMETRIC: u32 = 1;
    const LUT: u32 = 2;

    /// Whether the parametric knobs run.
    pub const fn parametric(self) -> bool {
        self.0 & ShaderGrading::PARAMETRIC != 0
    }

    /// Whether the LUT runs.
    pub const fn lut(self) -> bool {
        self.0 & ShaderGrading::LUT != 0
    }

    /// The `GX_GRADING` override value.
    pub const fn shader_id(self) -> u32 {
        self.0
    }

    /// This grading without its LUT (no LUT bound).
    pub const fn without_lut(self) -> ShaderGrading {
        ShaderGrading(self.0 & !ShaderGrading::LUT)
    }
}

/// The look's colour grading: parametric knobs on the scene before the curve and a `.cube` LUT
/// on the display colour after it. [`Grading::NEUTRAL`] (the default look's) draws nothing.
#[derive(Clone, Copy)]
pub struct Grading {
    /// Contrast in log space about middle grey, `0..=2` (1: none). Middle grey stays where the
    /// exposure put it; each stop away from it moves `contrast` stops.
    pub contrast: f32,
    /// Saturation about Rec. 709 luminance, `0..=2` (1: none; 0: grey).
    pub saturation: f32,
    /// Filament's vibrance, `0..=2` (1: none): saturation weighted towards colours whose red does
    /// not already lead.
    pub vibrance: f32,
    /// The shadows' knobs (levels below the midtones).
    pub shadows: GradingSection,
    /// The midtones' knobs.
    pub midtones: GradingSection,
    /// The highlights' knobs (levels above the midtones).
    pub highlights: GradingSection,
    /// The display LUT (None: none).
    pub lut: Option<&'static GradingLut>,
    /// How much of the LUT's change is drawn, `0..=1`.
    pub lut_intensity: f32,
}

impl PartialEq for Grading {
    fn eq(&self, other: &Grading) -> bool {
        let same_lut = match (self.lut, other.lut) {
            (Some(a), Some(b)) => std::ptr::eq(a, b),
            (a, b) => a.is_none() && b.is_none(),
        };
        same_lut
            && self.contrast == other.contrast
            && self.saturation == other.saturation
            && self.vibrance == other.vibrance
            && self.shadows == other.shadows
            && self.midtones == other.midtones
            && self.highlights == other.highlights
            && self.lut_intensity == other.lut_intensity
    }
}

impl std::fmt::Debug for Grading {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Grading")
            .field("contrast", &self.contrast)
            .field("saturation", &self.saturation)
            .field("vibrance", &self.vibrance)
            .field("shadows", &self.shadows)
            .field("midtones", &self.midtones)
            .field("highlights", &self.highlights)
            .field("lut_side", &self.lut.map(GradingLut::side))
            .field("lut_intensity", &self.lut_intensity)
            .finish()
    }
}

impl Default for Grading {
    fn default() -> Grading {
        Grading::NEUTRAL
    }
}

/// Section weights of `level` (shadows, midtones, highlights; they sum to 1): Blender's
/// compositor's cut-offs with a blend [`LEVEL_MARGIN`] wide either side of each.
fn section_weights(level: f32) -> [f32; 3] {
    let [low, high] = MIDTONES_RANGE;
    let blend = |edge: f32| ((level - edge) / (2.0 * LEVEL_MARGIN) + 0.5).clamp(0.0, 1.0);
    let (into_mid, into_high) = (blend(low), blend(high));
    [1.0 - into_mid, into_mid - into_high, into_high]
}

fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `x^power` keeping `x`'s sign (Bevy's `powsafe`).
fn powsafe(x: f32, power: f32) -> f32 {
    libm::powf(x.abs(), power).copysign(x)
}

impl Grading {
    /// The grading that changes nothing.
    pub const NEUTRAL: Grading = Grading {
        contrast: 1.0,
        saturation: 1.0,
        vibrance: 1.0,
        shadows: GradingSection::NEUTRAL,
        midtones: GradingSection::NEUTRAL,
        highlights: GradingSection::NEUTRAL,
        lut: None,
        lut_intensity: 1.0,
    };

    /// The grading with every knob held to its range (a value that is not a number is neutral).
    pub fn held(self) -> Grading {
        Grading {
            contrast: held(self.contrast, 1.0, 0.0, 2.0),
            saturation: held(self.saturation, 1.0, 0.0, 2.0),
            vibrance: held(self.vibrance, 1.0, 0.0, 2.0),
            shadows: self.shadows.held(),
            midtones: self.midtones.held(),
            highlights: self.highlights.held(),
            lut: self.lut,
            lut_intensity: held(self.lut_intensity, 1.0, 0.0, 1.0),
        }
    }

    /// The grading with `contrast` (held to `0..=2`).
    pub fn with_contrast(self, contrast: f32) -> Grading {
        Grading { contrast: held(contrast, 1.0, 0.0, 2.0), ..self }
    }

    /// The grading with `saturation` (held to `0..=2`).
    pub fn with_saturation(self, saturation: f32) -> Grading {
        Grading { saturation: held(saturation, 1.0, 0.0, 2.0), ..self }
    }

    /// The grading with `vibrance` (held to `0..=2`).
    pub fn with_vibrance(self, vibrance: f32) -> Grading {
        Grading { vibrance: held(vibrance, 1.0, 0.0, 2.0), ..self }
    }

    /// The grading drawing `lut` at `intensity` (held to `0..=1`).
    pub fn with_lut(self, lut: &'static GradingLut, intensity: f32) -> Grading {
        Grading { lut: Some(lut), lut_intensity: held(intensity, 1.0, 0.0, 1.0), ..self }
    }

    /// What the tonemap draws of this grading: the parametric knobs unless every one is neutral,
    /// the LUT when there is one at an intensity above 0.
    pub fn shader(&self) -> ShaderGrading {
        let sections = [self.shadows, self.midtones, self.highlights];
        let parametric = [self.contrast, self.saturation, self.vibrance] != [1.0; 3] || sections.iter().any(|section| *section != GradingSection::NEUTRAL);
        let lut = self.lut.is_some() && self.lut_intensity > 0.0;
        let parametric_bit = if parametric { ShaderGrading::PARAMETRIC } else { 0 };
        let lut_bit = if lut { ShaderGrading::LUT } else { 0 };
        ShaderGrading(parametric_bit | lut_bit)
    }

    /// The parametric grading of one pre-exposed, white-balanced scene colour: the CPU reference of
    /// the shader's `gx_grade`. Sections by level, then saturation, contrast about middle grey,
    /// the ASC CDL (gain, lift, gamma) and vibrance; held to `0..=` the scene's largest radiance.
    pub fn grade(&self, rgb: [f32; 3]) -> [f32; 3] {
        let weights = section_weights((rgb[0] + rgb[1] + rgb[2]) / 3.0);
        let knob = |pick: fn(&GradingSection) -> f32| dot3(weights, [pick(&self.shadows), pick(&self.midtones), pick(&self.highlights)]);
        let saturation = knob(|s| s.saturation) * self.saturation;
        let contrast = knob(|s| s.contrast) * self.contrast;
        let (gamma, gain, lift) = (knob(|s| s.gamma), knob(|s| s.gain), knob(|s| s.lift));
        let luma = dot3(rgb, LUMA);
        let mut c = rgb.map(|c| luma + saturation * (c - luma));
        // The shader skips a step whose knob is neutral (its weighted contrast, every section's
        // gamma, the vibrance); so does its twin.
        if contrast != 1.0 {
            c = c.map(|c| MIDDLE_GREY * libm::exp2f(libm::log2f(c.max(CONTRAST_FLOOR) / MIDDLE_GREY) * contrast));
        }
        c = c.map(|c| c * gain + lift);
        if [self.shadows.gamma, self.midtones.gamma, self.highlights.gamma] != [1.0; 3] {
            c = c.map(|c| powsafe(c, 1.0 / gamma));
        }
        if self.vibrance != 1.0 {
            c = vibrance(c, self.vibrance);
        }
        c.map(|c| c.clamp(0.0, GRADED_RADIANCE_MAX))
    }

    /// The uniform's grading rows (`GpuTonemapParams::grade` onwards), for a LUT of `lut_side`.
    pub(crate) fn rows(&self, lut_side: u32) -> [[f32; 4]; 7] {
        let per_section = |pick: fn(&GradingSection) -> f32| [pick(&self.shadows), pick(&self.midtones), pick(&self.highlights), 0.0];
        [
            [self.contrast, self.saturation, self.vibrance, self.lut_intensity],
            [MIDTONES_RANGE[0], MIDTONES_RANGE[1], lut_side as f32, 0.0],
            per_section(|s| s.saturation),
            per_section(|s| s.contrast),
            per_section(|s| s.gamma),
            per_section(|s| s.gain),
            per_section(|s| s.lift),
        ]
    }
}

/// Filament's vibrance (`ColorGrading.cpp` `vibrance`, Rec. 709 luminance here): a saturation of
/// `1 + (vibrance - 1) / (1 + e^(-3 r))`, `r` the colour's red excess over its other channels.
fn vibrance(v: [f32; 3], vibrance: f32) -> [f32; 3] {
    let r = v[0] - v[1].max(v[2]);
    let s = (vibrance - 1.0) / (1.0 + libm::expf(-r * VIBRANCE_STEEPNESS)) + 1.0;
    let luma = (1.0 - s) * dot3(v, LUMA);
    v.map(|c| luma + s * c)
}

/// Why a `.cube` was refused.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum GradingLutError {
    /// The text is longer than [`CUBE_TEXT_BYTES_MAX`].
    #[error("the .cube is {bytes} bytes, past the {CUBE_TEXT_BYTES_MAX}-byte limit")]
    TooLarge {
        /// Its length.
        bytes: usize,
    },
    /// No `LUT_3D_SIZE` before the rows.
    #[error("the .cube names no LUT_3D_SIZE")]
    MissingSize,
    /// A `LUT_3D_SIZE` outside [`LUT_SIDE_MIN`]..=[`LUT_SIDE_MAX`].
    #[error("LUT_3D_SIZE {size} is outside {LUT_SIDE_MIN}..={LUT_SIDE_MAX}")]
    SizeOutOfRange {
        /// The size named.
        size: u64,
    },
    /// A 1D LUT (`LUT_1D_SIZE`): grading takes 3D tables only.
    #[error("the .cube is a 1D LUT; grading takes a 3D one")]
    OneDimensional,
    /// A keyword line that is malformed, repeated or after the rows.
    #[error("line {line}: a malformed, repeated or late keyword")]
    Keyword {
        /// The 1-based line.
        line: usize,
    },
    /// A row that is not three numbers.
    #[error("line {line}: a row is three numbers")]
    Row {
        /// The 1-based line.
        line: usize,
    },
    /// A number that is not finite.
    #[error("line {line}: a value is not finite")]
    NotFinite {
        /// The 1-based line.
        line: usize,
    },
    /// Not `size³` rows.
    #[error("{found} rows where LUT_3D_SIZE asks for {expected}")]
    RowCount {
        /// `size³`.
        expected: usize,
        /// The rows read.
        found: usize,
    },
    /// A domain whose minimum is not below its maximum in every channel.
    #[error("DOMAIN_MIN is not below DOMAIN_MAX in every channel")]
    Domain,
    /// Past [`INTERNED_LUTS_MAX`] distinct LUTs this process.
    #[error("more than {INTERNED_LUTS_MAX} distinct grading LUTs")]
    TooManyLuts,
}

/// A 3D grading LUT: `side³` output colours, red varying fastest, over an input domain.
#[derive(Clone, PartialEq)]
pub struct GradingLut {
    side: u32,
    domain_min: [f32; 3],
    domain_max: [f32; 3],
    rows: Vec<[f32; 3]>,
}

impl std::fmt::Debug for GradingLut {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GradingLut").field("side", &self.side).field("domain_min", &self.domain_min).field("domain_max", &self.domain_max).finish()
    }
}

/// The header a `.cube` reader has seen.
struct CubeHeader {
    size: Option<u32>,
    domain_min: Option<[f32; 3]>,
    domain_max: Option<[f32; 3]>,
}

/// The three finite numbers of `words` (`line` names the line in an error).
fn three_numbers<'a>(mut words: impl Iterator<Item = &'a str>, line: usize, error: GradingLutError) -> Result<[f32; 3], GradingLutError> {
    let mut values = [0.0f32; 3];
    for value in &mut values {
        *value = words.next().and_then(|word| word.parse::<f32>().ok()).ok_or_else(|| error.clone())?;
    }
    if words.next().is_some() {
        return Err(error);
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(GradingLutError::NotFinite { line });
    }
    Ok(values)
}

impl CubeHeader {
    /// Read keyword line `line` (`keyword` and the rest of its `words`); unknown keywords are skipped.
    fn read<'a>(&mut self, keyword: &str, mut words: impl Iterator<Item = &'a str>, line: usize) -> Result<(), GradingLutError> {
        let malformed = GradingLutError::Keyword { line };
        match keyword {
            "LUT_1D_SIZE" => Err(GradingLutError::OneDimensional),
            "LUT_3D_SIZE" => {
                let size = words.next().and_then(|word| word.parse::<u64>().ok()).ok_or_else(|| malformed.clone())?;
                if self.size.is_some() || words.next().is_some() {
                    return Err(malformed);
                }
                if !(u64::from(LUT_SIDE_MIN)..=u64::from(LUT_SIDE_MAX)).contains(&size) {
                    return Err(GradingLutError::SizeOutOfRange { size });
                }
                self.size = Some(size as u32);
                Ok(())
            }
            "DOMAIN_MIN" if self.domain_min.is_none() => {
                self.domain_min = Some(three_numbers(words, line, malformed)?);
                Ok(())
            }
            "DOMAIN_MAX" if self.domain_max.is_none() => {
                self.domain_max = Some(three_numbers(words, line, malformed)?);
                Ok(())
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => Err(malformed),
            _ => Ok(()),
        }
    }
}

/// Whether a `.cube` line is a keyword (it starts with a letter or `_`; rows start with a number).
fn is_keyword(word: &str) -> bool {
    let first = word.as_bytes()[0];
    let starts_like_a_keyword = first.is_ascii_alphabetic() || first == b'_';
    // `NaN` and `inf` parse as floats: a row holding one is refused as not finite, not skipped.
    let number_word = matches!(word.to_ascii_lowercase().as_str(), "nan" | "inf" | "infinity");
    starts_like_a_keyword && !number_word
}

/// The interned LUTs ([`GradingLut::intern`]).
static INTERNED: Mutex<Vec<&'static GradingLut>> = Mutex::new(Vec::new());

impl GradingLut {
    /// Read an Adobe Cube LUT 1.0 `.cube`: `#` comments, `TITLE`, `LUT_3D_SIZE`, optional signed
    /// `DOMAIN_MIN` and `DOMAIN_MAX` (default 0 and 1), other header keywords skipped, then
    /// `size³` rows of three numbers, red varying fastest. Anything else is refused.
    pub fn parse_cube(text: &str) -> Result<GradingLut, GradingLutError> {
        if text.len() > CUBE_TEXT_BYTES_MAX {
            return Err(GradingLutError::TooLarge { bytes: text.len() });
        }
        let mut header = CubeHeader { size: None, domain_min: None, domain_max: None };
        let mut rows = Vec::new();
        // Rows past `size³` are counted, not kept: a padded file costs no memory past its table.
        let mut extra_rows = 0usize;
        // A byte-order mark some exporters write is not part of the first keyword.
        for (index, raw) in text.trim_start_matches('\u{feff}').lines().enumerate() {
            let line = index + 1;
            let content = raw.split('#').next().unwrap_or("").trim();
            let mut words = content.split_whitespace();
            let Some(first) = words.next() else { continue };
            if is_keyword(first) {
                if !rows.is_empty() {
                    return Err(GradingLutError::Keyword { line });
                }
                header.read(first, words, line)?;
                continue;
            }
            let Some(size) = header.size else { return Err(GradingLutError::MissingSize) };
            if rows.len() >= (size as usize).pow(3) {
                extra_rows += 1;
                continue;
            }
            rows.push(three_numbers(content.split_whitespace(), line, GradingLutError::Row { line })?);
        }
        let size = header.size.ok_or(GradingLutError::MissingSize)?;
        let expected = (size as usize).pow(3);
        let found = rows.len() + extra_rows;
        if found != expected {
            return Err(GradingLutError::RowCount { expected, found });
        }
        let (domain_min, domain_max) = (header.domain_min.unwrap_or([0.0; 3]), header.domain_max.unwrap_or([1.0; 3]));
        if (0..3).any(|i| domain_min[i] >= domain_max[i]) {
            return Err(GradingLutError::Domain);
        }
        Ok(GradingLut { side: size, domain_min, domain_max, rows })
    }

    /// The `side³` LUT of `look` over `[0, 1]` (red varying fastest).
    pub fn from_fn(side: u32, look: impl Fn([f32; 3]) -> [f32; 3]) -> Result<GradingLut, GradingLutError> {
        if !(LUT_SIDE_MIN..=LUT_SIDE_MAX).contains(&side) {
            return Err(GradingLutError::SizeOutOfRange { size: u64::from(side) });
        }
        let step = 1.0 / (side - 1) as f32;
        let rows = (0..side.pow(3)).map(|i| look([i % side, i / side % side, i / (side * side)].map(|k| k as f32 * step))).collect();
        Ok(GradingLut { side, domain_min: [0.0; 3], domain_max: [1.0; 3], rows })
    }

    /// The `side³` identity LUT.
    pub fn identity(side: u32) -> Result<GradingLut, GradingLutError> {
        GradingLut::from_fn(side, |rgb| rgb)
    }

    /// Its side.
    pub fn side(&self) -> u32 {
        self.side
    }

    /// Its input domain: (minimum, maximum) per channel.
    pub fn domain(&self) -> ([f32; 3], [f32; 3]) {
        (self.domain_min, self.domain_max)
    }

    /// Its rows, red varying fastest.
    pub fn rows(&self) -> &[[f32; 3]] {
        &self.rows
    }

    /// The `.cube` text of this LUT titled `title`; each value printed so it reads back to the
    /// same float.
    pub fn to_cube(&self, title: &str) -> String {
        let title: String = title.chars().filter(|c| *c != '"' && !c.is_control()).collect();
        let [a, b, c] = self.domain_min;
        let [d, e, f] = self.domain_max;
        let mut text = format!("TITLE \"{title}\"\nLUT_3D_SIZE {}\nDOMAIN_MIN {a} {b} {c}\nDOMAIN_MAX {d} {e} {f}\n", self.side);
        for [r, g, b] in &self.rows {
            text.push_str(&format!("{r} {g} {b}\n"));
        }
        text
    }

    fn row(&self, [r, g, b]: [u32; 3]) -> [f32; 3] {
        self.rows[(r + self.side * (g + self.side * b)) as usize]
    }

    /// The LUT at `rgb` (in its domain, clamped to it), interpolated tetrahedrally: the CPU form of
    /// the shader's lookup.
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let last = (self.side - 1) as f32;
        let grid: [f32; 3] = std::array::from_fn(|i| ((rgb[i] - self.domain_min[i]) / (self.domain_max[i] - self.domain_min[i])).clamp(0.0, 1.0) * last);
        tetrahedral(grid, self.side, |corner| self.row(corner))
    }

    /// This LUT resampled to `side³` over `[0, 1]` (the encoded colour's domain).
    pub fn resampled(&self, side: u32) -> GradingLut {
        let side = side.clamp(LUT_SIDE_MIN, LUT_SIDE_MAX);
        let step = 1.0 / (side - 1) as f32;
        let rows = (0..side.pow(3)).map(|i| self.sample([i % side, i / side % side, i / (side * side)].map(|k| k as f32 * step))).collect();
        GradingLut { side, domain_min: [0.0; 3], domain_max: [1.0; 3], rows }
    }

    /// What the GPU holds for this LUT on a class of `side_max`: on `[0, 1]`, at most `side_max`
    /// a side (resampled only when the domain or the size asks), each texel's change from the
    /// identity rounded to a half float.
    pub fn upload(&self, side_max: u32) -> LutUpload {
        let unit_domain = self.domain_min == [0.0; 3] && self.domain_max == [1.0; 3];
        let resampled;
        let table = if unit_domain && self.side <= side_max {
            self
        } else {
            resampled = self.resampled(self.side.min(side_max));
            &resampled
        };
        let side = table.side;
        let step = 1.0 / (side - 1) as f32;
        let deltas = table
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                let i = i as u32;
                let identity = [i % side, i / side % side, i / (side * side)].map(|k| k as f32 * step);
                std::array::from_fn(|c| f16_to_f32(f32_to_f16(row[c] - identity[c])))
            })
            .collect();
        LutUpload { side, deltas }
    }

    /// This LUT for a look: a `&'static` shared by every LUT of the same content, so a
    /// [`Grading`] stays `Copy`. At most [`INTERNED_LUTS_MAX`] distinct tables a process.
    pub fn intern(self) -> Result<&'static GradingLut, GradingLutError> {
        let mut interned = INTERNED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(held) = interned.iter().find(|held| ***held == self) {
            return Ok(held);
        }
        if interned.len() >= INTERNED_LUTS_MAX {
            return Err(GradingLutError::TooManyLuts);
        }
        let leaked: &'static GradingLut = Box::leak(Box::new(self));
        interned.push(leaked);
        Ok(leaked)
    }
}

/// The tetrahedral interpolation at `grid` (in texels, `0..=side - 1`) of the table `at` reads:
/// pmndrs/postprocessing's `lut-3d.frag` (Zlib), the cube's corner, the corner one step along the
/// largest fraction, one more along the second and the far corner, weighted barycentrically.
fn tetrahedral(grid: [f32; 3], side: u32, at: impl Fn([u32; 3]) -> [f32; 3]) -> [f32; 3] {
    let last = (side - 2) as f32;
    let base = grid.map(|g| g.floor().min(last));
    let f: [f32; 3] = std::array::from_fn(|i| grid[i] - base[i]);
    let mut order = [0usize, 1, 2];
    // The shader's comparisons: ties go to red, then green.
    order.sort_by(|a, b| f[*b].total_cmp(&f[*a]));
    let corner = base.map(|b| b as u32);
    let mut second = corner;
    second[order[0]] += 1;
    let mut third = second;
    third[order[1]] += 1;
    let far = corner.map(|c| c + 1);
    let weights = [1.0 - f[order[0]], f[order[0]] - f[order[1]], f[order[1]] - f[order[2]], f[order[2]]];
    let corners = [at(corner), at(second), at(third), at(far)];
    std::array::from_fn(|c| corners.iter().zip(weights).map(|(v, w)| v[c] * w).sum())
}

/// A LUT as the GPU holds it ([`GradingLut::upload`]): `side³` changes from the identity on
/// `[0, 1]`, each a half float.
#[derive(Clone, Debug, PartialEq)]
pub struct LutUpload {
    side: u32,
    deltas: Vec<[f32; 3]>,
}

impl LutUpload {
    /// Its side.
    pub fn side(&self) -> u32 {
        self.side
    }

    /// Its changes, red varying fastest (half floats as f32).
    pub fn deltas(&self) -> &[[f32; 3]] {
        &self.deltas
    }

    /// Its bytes on the GPU (`rgba16float`).
    pub fn bytes(&self) -> u64 {
        u64::from(self.side).pow(3) * 8
    }

    /// The texels to upload: rgba16float bits, alpha 0.
    pub(crate) fn texels(&self) -> Vec<u16> {
        self.deltas.iter().flat_map(|[r, g, b]| [f32_to_f16(*r), f32_to_f16(*g), f32_to_f16(*b), 0]).collect()
    }

    /// The LUT drawn at `intensity` over an encoded display colour: the CPU twin of the shader's
    /// `gx_grade_lut` (the colour plus the interpolated change, clamped to `[0, 1]`).
    pub fn apply(&self, encoded: [f32; 3], intensity: f32) -> [f32; 3] {
        let side = self.side;
        let grid = encoded.map(|c| c.clamp(0.0, 1.0) * (side - 1) as f32);
        let delta = tetrahedral(grid, side, |[r, g, b]| self.deltas[(r + side * (g + side * b)) as usize]);
        std::array::from_fn(|c| (encoded[c] + delta[c] * intensity).clamp(0.0, 1.0))
    }
}
