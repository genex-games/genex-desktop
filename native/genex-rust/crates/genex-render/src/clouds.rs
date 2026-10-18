//! The cloud panorama seen from the ground (renderer pass 2 B.5, plan section 5's B2a): a layer of
//! cumulus marched by a compute kernel (`shaders/sky/clouds.wgsl`) into a panorama of the sky above
//! the horizon (`rgba16float`: rgb the clouds' light as it reaches the camera plus the sky's in front
//! of them, a the clouds' transmittance), which the sky's background (`sky_draw.wgsl`) and its environment cube
//! (`cs_sky_cube`) read over the sky-view LUT, so reflections, probes and the ambient light see the
//! clouds. It takes no forward binding.
//!
//! The march is takram's `@takram/three-clouds` 0.7.6 (MIT) in outline: a weather field for the
//! coverage, a Perlin-Worley shape and a Worley detail volume (sebh's `TileableVolumeNoise`, MIT,
//! made once on the GPU by `cs_cloud_shape`, `cs_cloud_detail` and `cs_cloud_weather`), a
//! dual-lobe Henyey-Greenstein phase with Wrenninge's multiple-scattering octaves, a short march
//! towards the sun, the sky's own light as the ambient term and Hillaire's energy-conserving
//! integration (Frostbite 2016). takram's spatiotemporal blue noise (`stbn.bin`, NVIDIA's
//! non-commercial STBN) is not used: each texel's start along its ray is an interleaved gradient
//! noise of its own position, fixed over time, so a texel marched again under the same sun writes
//! the same value and amortising cannot flicker.
//!
//! Amortised (plan: "written into the sky-view LUT and sky cube, amortised"): the panorama is a
//! function of the layer, the sun and the camera's height. While those move, each frame marches one
//! texel of every block of the grid's ([`CloudGrid::block`]: 4x4 on medium and high, 8x8 on ultra,
//! in Bayer order), so any block² frames visit every texel once; once they stop nothing is marched.
//! A change of the layer (a game drifting its offset, a change of coverage) is amortised the same
//! way, dissolving in over a pass. A settled capture, the first frame, a new medium or grid, or a
//! sun that jumps more than [`SUN_JUMP_DEGREES`] in a frame marches every texel at once.
//!
//! The layer is the world's, not the camera's: the panorama assumes the camera stays near its
//! origin (a game's few kilometres change nothing a viewer sees at these distances).

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, ComputePipeline, Device, Queue, Sampler, ShaderStages, Texture, TextureFormat, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;

/// Whether the sky marches clouds where the game's sky and the quality ask for them.
pub const LANDED: bool = true;

/// The march and its composite's shared mapping (`sky/clouds_map.wgsl`) and the kernels.
pub const CLOUDS: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/sky/clouds_map.wgsl"),
    include_str!("../shaders/sky/clouds.wgsl")
));
/// The noise kernels (made once): the shape and detail volumes and the weather field.
pub const CLOUD_NOISE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/sky/cloud_noise.wgsl"));

/// The panorama's format: `rgba16float`, write-only storage in compute, sampled afterwards.
pub const PANORAMA_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The noise volumes' and the weather field's format (write-only storage in core).
pub const NOISE_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The shape volume's side (Perlin-Worley and three Worley octaves; 8 MB).
pub const SHAPE_SIDE: u32 = 128;
/// The detail volume's side (three Worley octaves).
pub const DETAIL_SIDE: u32 = 32;
/// The weather field's side (coverage and type).
pub const WEATHER_SIDE: u32 = 256;
/// A sun that turns more than this between two frames marches the whole panorama.
pub const SUN_JUMP_DEGREES: f32 = 2.0;
/// The march's workgroup side (8x8 threads).
const WORKGROUP_SIDE: u32 = 8;
/// The noise kernels' workgroup (4x4x4 threads for the volumes, 8x8 for the weather).
const NOISE_GROUP_3D: u32 = 4;

/// The default layer's coverage (a broken cumulus sky), its base and thickness (km) and density.
pub const DEFAULT_COVERAGE: f32 = 0.45;
/// The default base above the ground, km.
pub const DEFAULT_BASE_KM: f32 = 1.5;
/// The default thickness, km.
pub const DEFAULT_THICKNESS_KM: f32 = 2.5;
/// The default density (a multiplier on the clouds' extinction).
pub const DEFAULT_DENSITY: f32 = 1.0;
/// The lowest base a layer may take, km (above the ground the camera stands on).
const BASE_MIN_KM: f32 = 0.2;
/// The highest base, km.
const BASE_MAX_KM: f32 = 12.0;
/// The thinnest and thickest layer, km.
const THICKNESS_MIN_KM: f32 = 0.1;
const THICKNESS_MAX_KM: f32 = 8.0;
/// The largest density multiplier.
const DENSITY_MAX: f32 = 4.0;
/// The largest weather offset, km (the field tiles far below this).
const OFFSET_MAX_KM: f32 = 1.0e4;

/// A layer of clouds in the physical sky ([`crate::settings::SkyParams::with_clouds`]).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Clouds {
    /// How much of the sky the layer covers, 0 (clear) to 1 (overcast).
    pub coverage: f32,
    /// The layer's base above the ground, km.
    pub base_km: f32,
    /// The layer's thickness, km.
    pub thickness_km: f32,
    /// A multiplier on the clouds' extinction (thin wisps below 1, heavy clouds above).
    pub density: f32,
    /// Where the weather field is shifted to over the ground (x and z, km): a game moves it to let
    /// the clouds drift (each change marches the panorama again, amortised).
    pub offset_km: [f32; 2],
    /// How much of the sky a thin sheet of cirrus streaks high above the layer covers, 0 (none,
    /// the default) to 1: ice cloud the low sun lights gold and pink, the deck of a fair evening.
    pub cirrus: f32,
}

/// The default layer, as a constant ([`Clouds::default`]).
const DEFAULT_CLOUDS: Clouds = Clouds {
    coverage: DEFAULT_COVERAGE,
    base_km: DEFAULT_BASE_KM,
    thickness_km: DEFAULT_THICKNESS_KM,
    density: DEFAULT_DENSITY,
    offset_km: [0.0, 0.0],
    cirrus: 0.0,
};

impl Default for Clouds {
    fn default() -> Self {
        DEFAULT_CLOUDS
    }
}

/// `value` held to `low..=high`, or `fallback` when it is not a number.
fn held(value: f32, fallback: f32, low: f32, high: f32) -> f32 {
    if value.is_finite() { value.clamp(low, high) } else { fallback }
}

impl Clouds {
    /// The layer held to what the kernel takes (a value that is not a number takes the default's).
    pub fn validated(self) -> Clouds {
        let default = DEFAULT_CLOUDS;
        Clouds {
            coverage: held(self.coverage, default.coverage, 0.0, 1.0),
            base_km: held(self.base_km, default.base_km, BASE_MIN_KM, BASE_MAX_KM),
            thickness_km: held(self.thickness_km, default.thickness_km, THICKNESS_MIN_KM, THICKNESS_MAX_KM),
            density: held(self.density, default.density, 0.0, DENSITY_MAX),
            offset_km: self.offset_km.map(|o| held(o, 0.0, -OFFSET_MAX_KM, OFFSET_MAX_KM)),
            cirrus: held(self.cirrus, default.cirrus, 0.0, 1.0),
        }
    }

    /// The layer covering `coverage` of the sky (0 clear to 1 overcast).
    pub fn with_coverage(mut self, coverage: f32) -> Clouds {
        self.coverage = coverage;
        self.validated()
    }

    /// The layer from `base_km` above the ground, `thickness_km` thick.
    pub fn with_layer(mut self, base_km: f32, thickness_km: f32) -> Clouds {
        self.base_km = base_km;
        self.thickness_km = thickness_km;
        self.validated()
    }

    /// The layer with its extinction times `density`.
    pub fn with_density(mut self, density: f32) -> Clouds {
        self.density = density;
        self.validated()
    }

    /// The layer with a sheet of cirrus covering `cirrus` of the sky (0 none to 1) above it.
    pub fn with_cirrus(mut self, cirrus: f32) -> Clouds {
        self.cirrus = cirrus;
        self.validated()
    }

    /// The layer's weather field shifted to `offset_km` (x and z) over the ground.
    pub fn with_offset(mut self, offset_km: [f32; 2]) -> Clouds {
        self.offset_km = offset_km;
        self.validated()
    }
}

/// The panorama a preset marches: its size (azimuth by elevation above the horizon, each a multiple
/// of `block`), the steps along each ray and towards the sun, and the block an amortised frame
/// marches one texel of. A resource knob.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CloudGrid {
    /// Texels around the horizon and from the horizon to the zenith.
    pub panorama: (u32, u32),
    /// Steps along a ray through the layer.
    pub steps: u32,
    /// Steps towards the sun from each.
    pub light_steps: u32,
    /// The side of the block an amortised frame marches one texel of (a power of two): a pass over
    /// the panorama takes `block²` frames.
    pub block: u32,
}

/// Desktop `medium`'s panorama (about 0.35 degrees a texel around the horizon).
pub const MEDIUM_GRID: CloudGrid = CloudGrid { panorama: (1024, 256), steps: 48, light_steps: 4, block: 4 };
/// Desktop `high`'s panorama (about 0.18 degrees a texel: four pixels of a 1440p frame at 60
/// degrees).
pub const HIGH_GRID: CloudGrid = CloudGrid { panorama: (2048, 512), steps: 72, light_steps: 5, block: 4 };
/// Desktop `ultra`'s panorama (about 0.09 degrees a texel: three pixels of a 4K frame), a pass over
/// it in 64 frames.
pub const ULTRA_GRID: CloudGrid = CloudGrid { panorama: (4096, 1024), steps: 96, light_steps: 6, block: 8 };

impl CloudGrid {
    /// Frames one amortised pass over the panorama takes.
    pub const fn slices(self) -> u32 {
        self.block * self.block
    }

    /// Bytes the panorama holds (the noise is [`noise_bytes`]).
    pub const fn bytes(self) -> u64 {
        self.panorama.0 as u64 * self.panorama.1 as u64 * 8
    }
}

/// Bytes the noise holds (both volumes and the weather field), once made.
pub const fn noise_bytes() -> u64 {
    4 * ((SHAPE_SIDE as u64).pow(3) + (DETAIL_SIDE as u64).pow(3) + (WEATHER_SIDE as u64).pow(2))
}

/// The march's uniform (`CloudParams` in `shaders/sky/clouds.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuClouds {
    /// x: the base above the ground (km); y: the top; z: the coverage; w: the density.
    pub layer: [f32; 4],
    /// xy: the weather offset (km); z: the camera's height (km); w: the sky's radiance multiplier.
    pub offset: [f32; 4],
    /// xyz: towards the light (the sun, or the moon on a moonlit night); w: 1 for the moon.
    pub sun_dir: [f32; 4],
    /// rgb: the sun's illuminance outside the atmosphere; w: the cirrus sheet's coverage.
    pub sun_illuminance: [f32; 4],
    /// x, y: the slice's texel in each block (0 for a whole march); z: the block's side (1: whole);
    /// w: unused.
    pub slice: [u32; 4],
    /// x: steps along a ray; y: steps towards the sun; z, w: unused.
    pub steps: [u32; 4],
}

/// The Bayer order of texel (`x`, `y`) in a `block`-sided block (a power of two): the low bits of
/// the coordinates are the high bits of the order, so consecutive orders sit far apart.
pub const fn bayer(x: u32, y: u32, block: u32) -> u32 {
    let bits = block.trailing_zeros();
    let mut order = 0;
    let mut bit = 0;
    while bit < bits {
        let (xb, yb) = ((x >> bit) & 1, (y >> bit) & 1);
        order |= (2 * (xb ^ yb) + yb) << (2 * (bits - 1 - bit));
        bit += 1;
    }
    order
}

/// The texel of every `block`-sided block that slice `index` (0..block²) marches: the one whose
/// Bayer order is `index`, so consecutive frames spread over the block.
pub fn slice_texel(index: u32, block: u32) -> (u32, u32) {
    let index = index % (block * block);
    (0..block * block).map(|i| (i % block, i / block)).find(|(x, y)| bayer(*x, *y, block) == index).unwrap_or((0, 0))
}

/// What the panorama is a function of: the layer, the sun, the camera's height and the sky's
/// radiance multiplier.
#[derive(Clone, Copy, Debug, PartialEq)]
struct CloudKey {
    clouds: Clouds,
    sun_dir: [f32; 3],
    sun_illuminance: [f32; 3],
    camera_height_km: f32,
    intensity: f32,
    medium: [u32; 4],
    moonlit: bool,
}

/// The angle between unit vectors `a` and `b`, in degrees.
fn degrees_between(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0);
    libm::acosf(dot).to_degrees()
}

/// What one frame of the panorama is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum March {
    /// Nothing moved.
    Idle,
    /// Every texel.
    Whole,
    /// One texel of every block (the slice), and whether it ends a pass over the panorama.
    Slice(u32, bool),
}

/// The inputs of one frame's march.
#[derive(Clone, Copy, Debug)]
pub struct CloudFrame {
    /// The game's layer.
    pub clouds: Clouds,
    /// The sky's atmosphere row this frame (its sun, its camera height, its medium).
    pub atmosphere: crate::layout::GpuSkyAtmosphere,
    /// March every texel (a settled capture).
    pub force: bool,
    /// The light is the moon's (`atmosphere` is the moonlit sky's row): the air's reddening of its
    /// light is taken as its luminance alone, so the clouds keep the moon's own tint (night vision
    /// sees no warm cast in moonlight; a low moon's reddened light drew them sepia).
    pub moonlit: bool,
}

/// What the march reads from the sky: its atmosphere row, its transmittance and sky-view LUTs and
/// their sampler.
pub struct CloudInputs<'a> {
    /// The sky's atmosphere uniform (its medium and radii).
    pub atmosphere: &'a Buffer,
    /// The transmittance LUT.
    pub transmittance: &'a TextureView,
    /// The sky-view LUT (the clouds' ambient light).
    pub sky_view: &'a TextureView,
    /// The LUTs' sampler.
    pub sampler: &'a Sampler,
}

/// One noise kernel's dispatch: its pipeline, its bind group and its workgroup counts.
type NoisePass = (Compiled<ComputePipeline>, wgpu::BindGroup, [u32; 3]);

/// The panorama, its noise and its pipelines at one grid.
#[derive(Debug)]
pub struct CloudPanorama {
    grid: CloudGrid,
    panorama: Texture,
    view: TextureView,
    noise: [(Texture, TextureView); 3],
    uniform: Buffer,
    layout: BindGroupLayout,
    pipeline: Compiled<ComputePipeline>,
    noise_sampler: Sampler,
    /// The noise kernels' pipelines and bind groups until the noise is made (then dropped).
    noise_passes: Option<Vec<NoisePass>>,
    held: Option<CloudKey>,
    pending: u32,
    cursor: u32,
    texels_written: u64,
}

fn noise_texture(device: &Device, label: &str, side: u32, depth: u32) -> (Texture, TextureView) {
    let dimension = if depth > 1 { wgpu::TextureDimension::D3 } else { wgpu::TextureDimension::D2 };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: depth },
        mip_level_count: 1,
        sample_count: 1,
        dimension,
        format: NOISE_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn entry(binding: u32, ty: BindingType) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry { binding, visibility: ShaderStages::COMPUTE, ty, count: None }
}

fn uniform() -> BindingType {
    BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }
}

fn sampled(dimension: wgpu::TextureViewDimension) -> BindingType {
    BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: dimension, multisampled: false }
}

fn storage(format: TextureFormat, dimension: wgpu::TextureViewDimension) -> BindingType {
    BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format, view_dimension: dimension }
}

fn compute_pipeline(device: &Device, label: &str, module: &wgpu::ShaderModule, entry_point: &str, layout: &BindGroupLayout) -> Compiled<ComputePipeline> {
    let pipeline_layout = crate::tables::pipeline_layout(device, label, &[layout]);
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    })
}

/// The sampler the sky's composite reads the panorama with: around the horizon it wraps, up to the
/// zenith it clamps.
pub fn panorama_sampler(device: &Device) -> Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("cloud panorama"),
        address_mode_u: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    })
}

/// The panorama a sky without clouds binds: one texel that leaves the sky as it is (no light, all
/// of the sky behind).
pub fn clear_panorama(device: &Device, queue: &Queue) -> (Texture, TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("cloud panorama (clear)"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: PANORAMA_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    // rgba16f (0, 0, 0, 1): 1.0 is 0x3c00.
    let texel: [u16; 4] = [0, 0, 0, 0x3c00];
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        bytemuck::cast_slice(&texel),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

impl CloudPanorama {
    /// The panorama at `grid`, its noise kernels ready to run on the first march.
    pub fn new(device: &Device, grid: CloudGrid) -> Result<CloudPanorama, RenderError> {
        let (width, height) = grid.panorama;
        let panorama = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("cloud panorama"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: PANORAMA_FORMAT,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = panorama.create_view(&wgpu::TextureViewDescriptor::default());
        let noise = [
            noise_texture(device, "cloud shape noise", SHAPE_SIDE, SHAPE_SIDE),
            noise_texture(device, "cloud detail noise", DETAIL_SIDE, DETAIL_SIDE),
            noise_texture(device, "cloud weather", WEATHER_SIDE, 1),
        ];
        let d2 = wgpu::TextureViewDimension::D2;
        let d3 = wgpu::TextureViewDimension::D3;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("clouds"),
            entries: &[
                entry(0, uniform()),
                entry(1, uniform()),
                entry(2, sampled(d2)),
                entry(3, sampled(d2)),
                entry(4, BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                entry(5, sampled(d3)),
                entry(6, sampled(d3)),
                entry(7, sampled(d2)),
                entry(8, BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                entry(9, storage(PANORAMA_FORMAT, d2)),
            ],
        });
        let module = crate::shaders::module(device, "clouds", CLOUDS)?;
        let pipeline = compute_pipeline(device, "clouds", &module, "cs_clouds", &layout);
        let noise_module = crate::shaders::module(device, "cloud noise", CLOUD_NOISE)?;
        let volume_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cloud noise volume"),
            entries: &[entry(0, storage(NOISE_FORMAT, d3))],
        });
        let field_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("cloud noise field"),
            entries: &[entry(1, storage(NOISE_FORMAT, d2))],
        });
        let group = |layout: &BindGroupLayout, binding: u32, view: &TextureView| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("cloud noise"),
                layout,
                entries: &[wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }],
            })
        };
        let volume_groups = |side: u32| [side.div_ceil(NOISE_GROUP_3D); 3];
        let noise_passes = vec![
            (compute_pipeline(device, "cloud shape noise", &noise_module, "cs_cloud_shape", &volume_layout), group(&volume_layout, 0, &noise[0].1), volume_groups(SHAPE_SIDE)),
            (compute_pipeline(device, "cloud detail noise", &noise_module, "cs_cloud_detail", &volume_layout), group(&volume_layout, 0, &noise[1].1), volume_groups(DETAIL_SIDE)),
            (
                compute_pipeline(device, "cloud weather", &noise_module, "cs_cloud_weather", &field_layout),
                group(&field_layout, 1, &noise[2].1),
                [WEATHER_SIDE.div_ceil(WORKGROUP_SIDE), WEATHER_SIDE.div_ceil(WORKGROUP_SIDE), 1],
            ),
        ];
        let noise_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("cloud noise"),
            address_mode_u: wgpu::AddressMode::Repeat,
            address_mode_v: wgpu::AddressMode::Repeat,
            address_mode_w: wgpu::AddressMode::Repeat,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("clouds"),
            size: size_of::<GpuClouds>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(CloudPanorama {
            grid,
            panorama,
            view,
            noise,
            uniform,
            layout,
            pipeline,
            noise_sampler,
            noise_passes: Some(noise_passes),
            held: None,
            pending: 0,
            cursor: 0,
            texels_written: 0,
        })
    }

    /// The grid this panorama was made at.
    pub fn grid(&self) -> CloudGrid {
        self.grid
    }

    /// The panorama's view (what the sky's composite samples).
    pub fn view(&self) -> &TextureView {
        &self.view
    }

    /// The panorama's texture (diagnostics).
    pub fn texture(&self) -> &Texture {
        &self.panorama
    }

    /// Texels the last [`CloudPanorama::encode`] marched (0: none).
    pub fn texels_written(&self) -> u64 {
        self.texels_written
    }

    /// Bytes held: the panorama and the noise.
    pub fn bytes(&self) -> u64 {
        self.grid.bytes() + noise_bytes()
    }

    /// What this frame marches for `frame` ([`March`]), the held key and the amortised pass moved on.
    fn plan(&mut self, frame: &CloudFrame) -> March {
        let a = &frame.atmosphere;
        let key = CloudKey {
            clouds: frame.clouds,
            sun_dir: [a.sun_dir[0], a.sun_dir[1], a.sun_dir[2]],
            sun_illuminance: [a.sun_illuminance[0], a.sun_illuminance[1], a.sun_illuminance[2]],
            camera_height_km: a.ground_albedo[3],
            intensity: a.sun_illuminance[3],
            medium: bytemuck::cast([a.radii[0], a.radii[1], a.mie[0], a.rayleigh[2]]),
            moonlit: frame.moonlit,
        };
        let held = self.held.replace(key);
        let jumped = held.is_some_and(|held| degrees_between(held.sun_dir, key.sun_dir) > SUN_JUMP_DEGREES);
        // A new layer (a drifting offset, a change of coverage) is amortised like a moving sun: it
        // dissolves in over a pass instead of a whole march every frame it changes.
        let new_sky = held.is_none_or(|held| held.medium != key.medium);
        if frame.force || new_sky || jumped {
            self.pending = 0;
            return March::Whole;
        }
        if held != Some(key) {
            self.pending = self.grid.slices();
        }
        if self.pending == 0 {
            return March::Idle;
        }
        self.pending -= 1;
        let slice = self.cursor;
        self.cursor = (self.cursor + 1) % self.grid.slices();
        March::Slice(slice, self.pending == 0)
    }

    /// One frame of the panorama for `frame` (the noise made first, once): the whole panorama, a
    /// slice of it, or nothing ([`CloudPanorama`]'s amortisation). One compute pass when anything
    /// is marched (timestamped with `writes`). Whether the panorama is new (marched whole, or the
    /// last slice of a pass over it): the sky's ambient projects it again.
    pub fn encode(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        (inputs, frame): (&CloudInputs<'_>, &CloudFrame),
        writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> Option<bool> {
        let march = self.plan(frame);
        if march == March::Idle {
            self.texels_written = 0;
            return None;
        }
        let (width, height) = self.grid.panorama;
        let (slice, block) = match march {
            March::Slice(index, _) => (slice_texel(index, self.grid.block), self.grid.block),
            _ => ((0, 0), 1),
        };
        let a = &frame.atmosphere;
        let clouds = frame.clouds;
        let params = GpuClouds {
            layer: [clouds.base_km, clouds.base_km + clouds.thickness_km, clouds.coverage, clouds.density],
            offset: [clouds.offset_km[0], clouds.offset_km[1], a.ground_albedo[3], a.sun_illuminance[3]],
            sun_dir: [a.sun_dir[0], a.sun_dir[1], a.sun_dir[2], if frame.moonlit { 1.0 } else { 0.0 }],
            sun_illuminance: [a.sun_illuminance[0], a.sun_illuminance[1], a.sun_illuminance[2], clouds.cirrus],
            slice: [slice.0, slice.1, block, 0],
            steps: [self.grid.steps, self.grid.light_steps, 0, 0],
        };
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(&params));
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("clouds"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: inputs.atmosphere.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(inputs.transmittance) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(inputs.sky_view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(inputs.sampler) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&self.noise[0].1) },
                wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(&self.noise[1].1) },
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::TextureView(&self.noise[2].1) },
                wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(&self.noise_sampler) },
                wgpu::BindGroupEntry { binding: 9, resource: wgpu::BindingResource::TextureView(&self.view) },
            ],
        });
        let (threads_x, threads_y) = (width / block, height / block);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("clouds"), timestamp_writes: writes });
        // The noise is made once, before the first march (each dispatch is its own usage scope: a
        // volume written by one is sampled by the next).
        if let Some(passes) = self.noise_passes.take() {
            for (pipeline, group, [x, y, z]) in &passes {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, group, &[]);
                pass.dispatch_workgroups(*x, *y, *z);
            }
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(threads_x.div_ceil(WORKGROUP_SIDE), threads_y.div_ceil(WORKGROUP_SIDE), 1);
        drop(pass);
        self.texels_written = u64::from(threads_x) * u64::from(threads_y);
        Some(matches!(march, March::Whole | March::Slice(_, true)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slices_visit_every_texel_of_a_block_once() {
        assert_eq!([bayer(0, 0, 2), bayer(1, 0, 2), bayer(0, 1, 2), bayer(1, 1, 2)], [0, 2, 3, 1], "the 2x2 Bayer matrix");
        for block in [4u32, 8] {
            let mut seen = vec![false; (block * block) as usize];
            for index in 0..block * block {
                let (x, y) = slice_texel(index, block);
                let at = (y * block + x) as usize;
                assert!(!seen[at], "block {block}: slice {index} repeats ({x}, {y})");
                seen[at] = true;
            }
            let (a, b) = (slice_texel(0, block), slice_texel(1, block));
            assert!(a.0.abs_diff(b.0) >= block / 2 && a.1.abs_diff(b.1) >= block / 2, "consecutive slices sit apart ({a:?}, {b:?})");
        }
    }

    #[test]
    fn the_march_uniform_has_the_shader_s_size() {
        assert_eq!(size_of::<GpuClouds>(), 96);
    }
}
