//! Local exposure (AAA push P3): one global exposure cannot hold a sunlit window and the dark
//! corridor around it, so the tonemap moves each region of the frame towards middle grey by its own
//! amount before the curve. Bright regions (a window onto a snowy yard) come down by the look's
//! `highlights` contrast, dark ones (a ceiling the sun never reaches) come up by its `shadows`
//! contrast, and the detail inside each region is kept as it was.
//!
//! After Unreal Engine 5's local exposure (a bilateral grid of log luminance, its contrast scales
//! and its blend with a blurred luminance) and Paris, Kornprobst and Tumblin's bilateral grid
//! (2009): a compute pass ([`crate::shaders::LOCAL_EXPOSURE`], `cs_local_exposure_grid` or
//! `cs_local_exposure_grid_msaa`) reads the scene the tonemap reads, one sample per 4² block,
//! and for each [`GRID_CELL`]² cell splats the samples' EV (`log2(luminance / 0.18)` of the
//! pre-exposed scene, held to [`EV_RANGE`]) into [`GRID_SLICES`] slices with a tent, as
//! (weighted EV sum, weight) pairs; a second texture holds each cell's plain mean EV. Counting
//! uses workgroup `u32` atomics in fixed point (WebGPU core), so the grid is independent of
//! invocation order.
//!
//! The tonemap slices the grid trilinearly at the pixel's own EV (an edge-aware base: a window
//! pixel reads the bright slice, the wall beside it the dark one), mixes it with the cells' plain
//! mean (bilinear) by [`BLURRED_BLEND`] and changes the pixel by `exp2(base × (contrast − 1))`, held to
//! ±[`CHANGE_LIMIT_EV`], where the contrast is `highlights` above middle grey and `shadows` below
//! ([`LocalExposure::change_ev`] is the CPU reference). A look with both contrasts at 1
//! ([`LocalExposure::OFF`]) or a quality without it draws nothing and binds neutral textures: the
//! picture is byte for byte the one before.

use wgpu::{BindGroupLayout, CommandEncoder, ComputePipeline, Device, Sampler, Texture, TextureFormat, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::tables::pipeline_layout;

/// The side of one grid cell in scene texels.
pub const GRID_CELL: u32 = 32;
/// The grid's EV slices.
pub const GRID_SLICES: u32 = 16;
/// The scene EVs the grid holds; darker and brighter samples count at the ends.
pub const EV_RANGE: [f32; 2] = [-8.0, 8.0];
/// How much of the base is the cell's plain mean instead of the edge-aware slice: some keeps a
/// small bright spot (a lamp, a glint) from being flattened into its surround; more makes halos.
pub const BLURRED_BLEND: f32 = 0.3;
/// The most local exposure changes a pixel by, either way, in EV.
pub const CHANGE_LIMIT_EV: f32 = 3.0;
/// The lowest contrast the look may ask for (0 would flatten every region onto middle grey).
pub const CONTRAST_MIN: f32 = 0.25;
/// The default highlights contrast: a region 4 EV over middle grey (a sunlit yard through a
/// window, seen from inside) comes down 1.6 EV.
pub const DEFAULT_HIGHLIGHTS: f32 = 0.6;
/// The default shadows contrast: a region 4 EV under middle grey (a corridor ceiling) comes up
/// 0.8 EV, so it reads without turning a night scene grey.
pub const DEFAULT_SHADOWS: f32 = 0.8;
/// The tonemap's binding of the grid ([`GRID_FORMAT`], a 3D texture read through its filtering
/// sampler).
pub const TONEMAP_GRID_BINDING: u32 = 6;
/// The tonemap's binding of the cells' plain mean EVs.
pub const TONEMAP_MEAN_BINDING: u32 = 7;
/// The grid's and the means' format (storage-writable and filterable in WebGPU core).
pub const GRID_FORMAT: TextureFormat = TextureFormat::Rgba16Float;

/// The look's local exposure (`[render.look]`'s `local_exposure_highlights` and
/// `local_exposure_shadows`): how strongly bright and dark regions are moved towards middle grey.
/// Each contrast is `CONTRAST_MIN..=1`; 1 leaves that side as it is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocalExposure {
    /// The contrast of the regions above middle grey (lower brings bright regions down more).
    pub highlights: f32,
    /// The contrast of the regions below middle grey (lower brings dark regions up more).
    pub shadows: f32,
}

impl Default for LocalExposure {
    fn default() -> LocalExposure {
        LocalExposure::DEFAULT
    }
}

impl LocalExposure {
    /// No local exposure: every region keeps the global exposure.
    pub const OFF: LocalExposure = LocalExposure { highlights: 1.0, shadows: 1.0 };
    /// The default look's ([`DEFAULT_HIGHLIGHTS`], [`DEFAULT_SHADOWS`]).
    pub const DEFAULT: LocalExposure = LocalExposure { highlights: DEFAULT_HIGHLIGHTS, shadows: DEFAULT_SHADOWS };

    /// Local exposure at `highlights` and `shadows`, each held to `CONTRAST_MIN..=1` (a value that
    /// is not finite is 1: that side off).
    pub fn new(highlights: f32, shadows: f32) -> LocalExposure {
        let held = |contrast: f32| if contrast.is_finite() { contrast.clamp(CONTRAST_MIN, 1.0) } else { 1.0 };
        LocalExposure { highlights: held(highlights), shadows: held(shadows) }
    }

    /// Whether it changes anything (either contrast under 1).
    pub fn is_on(&self) -> bool {
        self.highlights < 1.0 || self.shadows < 1.0
    }

    /// The change in EV of a pixel whose base (its region's EV, about middle grey) is `base_ev`:
    /// the tonemap's `gx_tm_local`, expression for expression.
    pub fn change_ev(&self, base_ev: f32) -> f32 {
        let contrast = if base_ev > 0.0 { self.highlights } else { self.shadows };
        (base_ev * (contrast - 1.0)).clamp(-CHANGE_LIMIT_EV, CHANGE_LIMIT_EV)
    }
}

/// The grid's cells across and down for a `size` scene.
pub fn grid_size(size: (u32, u32)) -> (u32, u32) {
    (size.0.div_ceil(GRID_CELL).max(1), size.1.div_ceil(GRID_CELL).max(1))
}

/// The tonemap uniform's two local exposure rows for `local` over a `size` scene (None: off):
/// `[highlights, shadows, on, blend]` and `[uv → grid uv x, y, one cell in grid uv x, y]`.
pub fn tonemap_rows(local: Option<LocalExposure>, size: (u32, u32)) -> [[f32; 4]; 2] {
    let Some(local) = local.filter(LocalExposure::is_on) else { return [[1.0, 1.0, 0.0, BLURRED_BLEND], [1.0, 1.0, 1.0, 1.0]] };
    let (cells_x, cells_y) = grid_size(size);
    let covered = ((cells_x * GRID_CELL) as f32, (cells_y * GRID_CELL) as f32);
    [
        [local.highlights, local.shadows, 1.0, BLURRED_BLEND],
        [size.0 as f32 / covered.0, size.1 as f32 / covered.1, 1.0 / cells_x as f32, 1.0 / cells_y as f32],
    ]
}

/// What the grid pass reads: the scene the tonemap reads.
#[derive(Clone, Copy)]
pub(crate) enum GridSource<'a> {
    /// The 1x scene.
    Scene(&'a TextureView),
    /// The multisampled scene (the tonemap resolves it in its own pass).
    Msaa(&'a TextureView),
}

/// The grid a frame's tonemap binds.
pub(crate) struct GridOutput {
    /// The (EV sum, weight) grid, [`TONEMAP_GRID_BINDING`].
    pub grid: TextureView,
    /// The cells' plain mean EVs, [`TONEMAP_MEAN_BINDING`].
    pub mean: TextureView,
    /// Bumped whenever the textures are made again (the tonemap's bind group follows).
    pub generation: u64,
}

struct GridTargets {
    cells: (u32, u32),
    grid: Texture,
    mean: Texture,
}

/// The grid pass (in the tonemap node, before the tonemap pass): its pipelines, made at once, and
/// its textures, made for the scene's size.
pub(crate) struct LocalExposureNode {
    scene_layout: BindGroupLayout,
    msaa_layout: BindGroupLayout,
    scene: Compiled<ComputePipeline>,
    msaa: Compiled<ComputePipeline>,
    sampler: Sampler,
    targets: Option<GridTargets>,
    generation: u64,
}

fn storage_entry(binding: u32, dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: GRID_FORMAT, view_dimension: dimension },
        count: None,
    }
}

fn texture_entry(binding: u32, multisampled: bool) -> wgpu::BindGroupLayoutEntry {
    let sample_type = wgpu::TextureSampleType::Float { filterable: !multisampled };
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled },
        count: None,
    }
}

fn sampler_entry() -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 1,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    }
}

fn grid_pipeline(device: &Device, module: &wgpu::ShaderModule, entry_point: &str, layout: &BindGroupLayout) -> Compiled<ComputePipeline> {
    let pipeline_layout = pipeline_layout(device, "local exposure grid", &[layout]);
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some("local exposure grid"),
        layout: Some(&pipeline_layout),
        module,
        entry_point: Some(entry_point),
        // The workgroup's counters are cleared before they are read.
        compilation_options: crate::compile::written_first(),
        cache: None,
    })
}

/// A texture of the grid's format the grid pass writes and the tonemap samples.
fn grid_texture(device: &Device, label: &str, size: wgpu::Extent3d, dimension: wgpu::TextureDimension) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension,
        format: GRID_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

impl LocalExposureNode {
    pub(crate) fn new(device: &Device) -> Result<LocalExposureNode, RenderError> {
        let module = crate::shaders::module(device, "local exposure", crate::shaders::LOCAL_EXPOSURE)?;
        let outputs = [storage_entry(2, wgpu::TextureViewDimension::D3), storage_entry(3, wgpu::TextureViewDimension::D2)];
        let scene_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("local exposure grid"),
            entries: &[texture_entry(0, false), sampler_entry(), outputs[0], outputs[1]],
        });
        let msaa_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("local exposure grid msaa"),
            entries: &[outputs[0], outputs[1], texture_entry(4, true)],
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("local exposure grid"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Ok(LocalExposureNode {
            scene: grid_pipeline(device, &module, "cs_local_exposure_grid", &scene_layout),
            msaa: grid_pipeline(device, &module, "cs_local_exposure_grid_msaa", &msaa_layout),
            scene_layout,
            msaa_layout,
            sampler,
            targets: None,
            generation: 0,
        })
    }

    /// The grid textures for a `size` scene, made again when its cells change.
    fn targets(&mut self, device: &Device, size: (u32, u32)) -> Option<&GridTargets> {
        let cells = grid_size(size);
        if self.targets.as_ref().is_none_or(|targets| targets.cells != cells) {
            self.generation += 1;
            let grid_extent = wgpu::Extent3d { width: cells.0, height: cells.1, depth_or_array_layers: GRID_SLICES };
            let mean_extent = wgpu::Extent3d { width: cells.0, height: cells.1, depth_or_array_layers: 1 };
            self.targets = Some(GridTargets {
                cells,
                grid: grid_texture(device, "local exposure grid", grid_extent, wgpu::TextureDimension::D3),
                mean: grid_texture(device, "local exposure mean", mean_extent, wgpu::TextureDimension::D2),
            });
        }
        self.targets.as_ref()
    }

    /// Record the grid pass over `source`, a `size` scene: one workgroup per cell.
    pub(crate) fn encode(&mut self, device: &Device, encoder: &mut CommandEncoder, source: GridSource<'_>, size: (u32, u32)) -> Option<GridOutput> {
        let targets = self.targets(device, size)?;
        let cells = targets.cells;
        let grid = targets.grid.create_view(&wgpu::TextureViewDescriptor::default());
        let mean = targets.mean.create_view(&wgpu::TextureViewDescriptor::default());
        let outputs = [
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&grid) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&mean) },
        ];
        let (pipeline, group) = match source {
            GridSource::Scene(view) => {
                let entries = [
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                    outputs[0].clone(),
                    outputs[1].clone(),
                ];
                (&self.scene, device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("local exposure grid"), layout: &self.scene_layout, entries: &entries }))
            }
            GridSource::Msaa(view) => {
                let entries = [outputs[0].clone(), outputs[1].clone(), wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(view) }];
                (&self.msaa, device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("local exposure grid msaa"), layout: &self.msaa_layout, entries: &entries }))
            }
        };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("local exposure grid"), timestamp_writes: None });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(cells.0, cells.1, 1);
        drop(pass);
        Some(GridOutput { grid, mean, generation: self.generation })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contrasts_are_held_and_one_is_off() {
        assert_eq!(LocalExposure::new(f32::NAN, 2.0), LocalExposure::OFF);
        assert_eq!(LocalExposure::new(0.0, 0.5), LocalExposure { highlights: CONTRAST_MIN, shadows: 0.5 });
        assert!(!LocalExposure::OFF.is_on());
        assert!(LocalExposure::DEFAULT.is_on());
        assert_eq!(tonemap_rows(Some(LocalExposure::OFF), (64, 64))[0][2], 0.0);
    }

    #[test]
    fn bright_regions_come_down_dark_ones_come_up_and_grey_stays() {
        let local = LocalExposure::DEFAULT;
        assert_eq!(local.change_ev(0.0), 0.0);
        assert!((local.change_ev(4.0) + 1.6).abs() < 1e-6, "a window 4 EV over grey comes down 1.6 EV");
        assert!((local.change_ev(-4.0) - 0.8).abs() < 1e-6, "a ceiling 4 EV under grey comes up 0.8 EV");
        assert_eq!(local.change_ev(20.0), -CHANGE_LIMIT_EV);
    }

    #[test]
    fn the_grid_covers_the_scene_and_maps_its_uv() {
        assert_eq!(grid_size((1920, 1080)), (60, 34));
        let [_, grid] = tonemap_rows(Some(LocalExposure::DEFAULT), (1920, 1080));
        assert_eq!(grid[0], 1.0);
        assert!((grid[1] - 1080.0 / 1088.0).abs() < 1e-6);
    }
}
