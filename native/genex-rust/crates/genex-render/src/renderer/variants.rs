//! Draw variants (renderer pass 2, P2-0.12: S11, prior-art A4.0): the pipelines and draws of the
//! batches whose material is double-sided, alpha-tested (glTF `MASK`) or both
//! ([`DrawVariant`]). A frame plans their batches after the plain ones ([`FramePlan::variants`]),
//! each variant reading its own region of the slot-base table through its own pass-view rows
//! ([`variant_pass_entry`]), so a scene without them draws, compiles and costs exactly what it
//! did before.
//!
//! - **World pass.** A double-sided batch draws with no culling, each back face shaded with its
//!   tangent frame turned to the viewer. An alpha-tested batch first writes its depth with the
//!   cutout cut away (`fs_mask_depth`; alpha-to-coverage under MSAA, a hashed threshold under
//!   TAA, the plain test otherwise), then shades with an `Equal` depth test and no discard, so a
//!   tile GPU's hidden-surface removal keeps working for every other draw. Where the world pass
//!   reuses the prepass depth with `Equal` (an immediate GPU at 1x), the prepass already cut the
//!   cutout and the shading pass is the only step.
//! - **Prepass.** `vs_prepass_mask` / `vs_prepass_motion_mask` with the alpha test (hashed under
//!   TAA), so AO, contact shadows, TAA's motion and the Hi-Z see the cutout too.
//! - **Sun casters.** `vs_shadow_mask` with the plain test at the cutoff (a hashed or coverage edge
//!   would shimmer in the filtered map); double-sided casters draw both faces.
//! - **Spot casters** draw a variant's batches with the plain spot pipeline (whole and culled, as
//!   before P2-0.12; spot cutouts are open).

use wgpu::{BindGroup, CompareFunction, Face, RenderPass, RenderPipeline, TextureFormat};

use super::{
    FramePrepass, FrameStats, Layouts, Renderer, ScenePath, SurfaceKey, depth_state, mesh_buffers_layout, shader, surface_constants,
};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::scene::{DRAW_VARIANTS, DrawVariant, FramePlan, VariantRun};
use crate::settings::ShadowFormat;
use crate::shadow::{CASTER_CONSTANT_BIAS, CASTER_SLOPE_BIAS, CasterDepth, DEPTH16_UNIT};
use crate::tables::{ARGS_STRIDE, PASS_VIEW_STRIDE, pipeline_layout, variant_pass_entry};

/// How a pipeline resolves a cutout's edge (`GX_ALPHA_MODE` in `shaders/alpha_mask.wgsl`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AlphaMode {
    /// The plain test against the cutoff.
    Test,
    /// The sharpened alpha turned into MSAA sample coverage.
    Coverage,
    /// A hashed threshold turned by the frame, averaged by TAA.
    Hashed,
}

impl AlphaMode {
    /// Its `GX_ALPHA_MODE` value.
    const fn shader_id(self) -> u32 {
        match self {
            AlphaMode::Test => 0,
            AlphaMode::Coverage => 1,
            AlphaMode::Hashed => 2,
        }
    }

    /// The mode of a camera depth writer drawing `samples` per pixel, under TAA (`temporal`) or not.
    pub(super) const fn for_camera(samples: u32, temporal: bool) -> AlphaMode {
        if samples > 1 {
            return AlphaMode::Coverage;
        }
        if temporal { AlphaMode::Hashed } else { AlphaMode::Test }
    }
}

/// What the world pass's variant pipelines are made for.
#[derive(Clone, Copy, Debug, PartialEq)]
struct WorldKey {
    format: TextureFormat,
    reversed: bool,
    samples: u32,
    surface: SurfaceKey,
    /// Whether the world pass tests `Equal` against the prepass depth (which then holds the
    /// cutouts already).
    equal: bool,
}

/// One variant's world-pass pipelines.
struct WorldSet {
    /// The shading: `fs_main` with the variant's culling, testing `Equal` against the depth the
    /// variant's depth step or the prepass wrote (alpha-tested, or any variant under `Equal`
    /// reuse), else depth-tested and written like the plain batches.
    shade: Compiled<RenderPipeline>,
    /// An alpha-tested variant's depth step (`fs_mask_depth`), when the world pass keeps its own
    /// depth.
    depth: Option<Compiled<RenderPipeline>>,
}

/// What the prepass's variant pipelines are made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrepassKey {
    reversed: bool,
    mode: AlphaMode,
    /// The motion variants (normals, motion and the reactive flags) rather than normals alone.
    motion: bool,
}

/// The draw variants' pipelines, made on the first frame that draws each variant.
#[derive(Default)]
pub(super) struct VariantPipelines {
    world: Option<(WorldKey, [Option<WorldSet>; DRAW_VARIANTS])>,
    prepass: Option<(PrepassKey, [Option<Compiled<RenderPipeline>>; DRAW_VARIANTS])>,
    /// Each variant's sun casters into `depth32float` and `depth16unorm` maps.
    casters: [Option<[Compiled<RenderPipeline>; 2]>; DRAW_VARIANTS],
}

/// The parts of a variant pipeline the variants choose.
struct VariantSpec<'a> {
    label: &'a str,
    module: &'a wgpu::ShaderModule,
    vertex: &'a str,
    fragment: Option<&'a str>,
    layout: &'a wgpu::PipelineLayout,
    targets: &'a [Option<wgpu::ColorTargetState>],
    depth: wgpu::DepthStencilState,
    variant: DrawVariant,
    samples: u32,
    alpha_to_coverage: bool,
    unclipped_depth: bool,
    constants: &'a [(&'a str, f64)],
}

fn variant_pipeline(device: &wgpu::Device, spec: &VariantSpec<'_>) -> Compiled<RenderPipeline> {
    let options = wgpu::PipelineCompilationOptions { constants: spec.constants, ..Default::default() };
    let cull_mode = (!spec.variant.double_sided).then_some(Face::Back);
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(spec.label),
        layout: Some(spec.layout),
        vertex: wgpu::VertexState { module: spec.module, entry_point: Some(spec.vertex), compilation_options: options.clone(), buffers: &mesh_buffers_layout() },
        primitive: wgpu::PrimitiveState { cull_mode, unclipped_depth: spec.unclipped_depth, ..Default::default() },
        depth_stencil: Some(spec.depth.clone()),
        multisample: wgpu::MultisampleState { count: spec.samples, alpha_to_coverage_enabled: spec.alpha_to_coverage, ..Default::default() },
        fragment: spec.fragment.map(|entry_point| wgpu::FragmentState { module: spec.module, entry_point: Some(entry_point), compilation_options: options, targets: spec.targets }),
        multiview_mask: None,
        cache: None,
    })
}

/// The `Equal` depth test that shades only what a depth step wrote (no depth writes).
fn equal_depth(reversed: bool) -> wgpu::DepthStencilState {
    wgpu::DepthStencilState { depth_compare: Some(CompareFunction::Equal), ..depth_state(false, reversed) }
}

/// `variant`'s world-pass pipelines for `key`.
fn world_set(device: &wgpu::Device, layouts: &Layouts, key: &WorldKey, variant: DrawVariant) -> Result<WorldSet, RenderError> {
    let module = shader(device, "forward", crate::shaders::FORWARD)?;
    let layout = pipeline_layout(device, "forward variant", &[&layouts.frame, &layouts.pass]);
    let constants = surface_constants(key.reversed, key.format, key.surface);
    let writes = [Some(wgpu::ColorTargetState { format: key.format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
    let tested = variant.masked || key.equal;
    let shade_spec = VariantSpec {
        label: "forward variant",
        module: &module,
        vertex: "vs_main",
        fragment: Some("fs_main"),
        layout: &layout,
        targets: &writes,
        depth: if tested { equal_depth(key.reversed) } else { depth_state(true, key.reversed) },
        variant,
        samples: if key.equal { 1 } else { key.samples },
        alpha_to_coverage: false,
        unclipped_depth: false,
        constants: &constants,
    };
    let shade = variant_pipeline(device, &shade_spec);
    let depth = (variant.masked && !key.equal).then(|| {
        let mode = AlphaMode::for_camera(key.samples, key.surface.shadow_temporal);
        let mut masked = constants.to_vec();
        masked.push(("GX_ALPHA_MODE", f64::from(mode.shader_id())));
        // The colour target is bound and never written: under alpha-to-coverage its alpha becomes
        // the samples' coverage.
        let silent = [Some(wgpu::ColorTargetState { format: key.format, blend: None, write_mask: wgpu::ColorWrites::empty() })];
        let spec = VariantSpec {
            label: "forward variant depth",
            fragment: Some("fs_mask_depth"),
            targets: &silent,
            depth: depth_state(true, key.reversed),
            alpha_to_coverage: mode == AlphaMode::Coverage,
            constants: &masked,
            ..shade_spec
        };
        variant_pipeline(device, &spec)
    });
    Ok(WorldSet { shade, depth })
}

/// `variant`'s prepass pipeline for `key` (its motion twin when `key.motion`, over `motion`'s
/// group 2).
fn prepass_pipeline(device: &wgpu::Device, layouts: &Layouts, motion: Option<&crate::motion::MotionNode>, key: &PrepassKey, variant: DrawVariant) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = shader(device, "prepass", crate::shaders::PREPASS)?;
    let (vertex, fragment) = match (key.motion, variant.masked) {
        (false, false) => ("vs_prepass", "fs_prepass"),
        (false, true) => ("vs_prepass_mask", "fs_prepass_mask"),
        (true, false) => (crate::motion::VERTEX_ENTRY, crate::motion::FRAGMENT_ENTRY),
        (true, true) => ("vs_prepass_motion_mask", "fs_prepass_motion_mask"),
    };
    let normals = [Some(wgpu::ColorTargetState { format: crate::prepass::NORMALS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
    let all = crate::motion::TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
    let layout = match motion.filter(|_| key.motion) {
        Some(node) => pipeline_layout(device, "prepass motion variant", &[&layouts.frame, &layouts.pass, node.layout()]),
        None => pipeline_layout(device, "prepass variant", &[&layouts.frame, &layouts.pass]),
    };
    let constants = [("GX_ALPHA_MODE", f64::from(key.mode.shader_id()))];
    Ok(variant_pipeline(device, &VariantSpec {
        label: vertex,
        module: &module,
        vertex,
        fragment: Some(fragment),
        layout: &layout,
        targets: if key.motion { &all } else { &normals },
        depth: depth_state(true, key.reversed),
        variant,
        samples: 1,
        alpha_to_coverage: false,
        unclipped_depth: false,
        constants: if variant.masked { &constants } else { &[] },
    }))
}

/// `variant`'s sun casters into a map of `format`: both faces for a double-sided variant, the
/// cutout's shape for an alpha-tested one (the plain test), the casters' bias as
/// `shadow::caster_pipeline` sets it.
fn caster_pipeline(device: &wgpu::Device, layouts: &Layouts, casters: CasterDepth, format: TextureFormat, variant: DrawVariant) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = shader(device, "shadow", crate::shaders::SHADOW)?;
    let layout = pipeline_layout(device, "shadow variant", &[&layouts.shadow, &layouts.pass]);
    let unclipped = casters == CasterDepth::Unclipped;
    let unit = if format == TextureFormat::Depth16Unorm { DEPTH16_UNIT } else { 0.0 };
    let constants = [
        ("GX_UNCLIPPED_DEPTH", f64::from(u8::from(unclipped))),
        ("GX_SHADOW_DEPTH_UNIT", unit),
        ("GX_SHADOW_BIAS_CONSTANT", f64::from(CASTER_CONSTANT_BIAS)),
        ("GX_SHADOW_BIAS_SLOPE", f64::from(CASTER_SLOPE_BIAS)),
        ("GX_ALPHA_MODE", f64::from(AlphaMode::Test.shader_id())),
    ];
    let (vertex, fragment) = match (variant.masked, unclipped) {
        (false, true) => ("vs_shadow", None),
        (false, false) => ("vs_shadow", Some("fs_shadow_caster")),
        (true, true) => ("vs_shadow_mask", Some("fs_shadow_mask")),
        (true, false) => ("vs_shadow_mask", Some("fs_shadow_mask_depth")),
    };
    // A fragment that writes its depth gets no hardware bias: the shader applies it.
    let bias = if unclipped {
        wgpu::DepthBiasState { constant: CASTER_CONSTANT_BIAS, slope_scale: CASTER_SLOPE_BIAS, clamp: 0.0 }
    } else {
        wgpu::DepthBiasState::default()
    };
    let depth = wgpu::DepthStencilState {
        format,
        depth_write_enabled: Some(true),
        depth_compare: Some(CompareFunction::Less),
        stencil: wgpu::StencilState::default(),
        bias,
    };
    Ok(variant_pipeline(device, &VariantSpec {
        label: "shadow variant",
        module: &module,
        vertex,
        fragment,
        layout: &layout,
        targets: &[],
        depth,
        variant,
        samples: 1,
        alpha_to_coverage: false,
        unclipped_depth: unclipped,
        constants: &constants,
    }))
}

impl Renderer {
    /// Make the pipelines the variants `plan` draws need this frame, on `path`, with the frame's
    /// `prepass` (motion when `motion`): nothing for a plan without variants.
    pub(super) fn ensure_variants(&mut self, plan: &FramePlan, path: &ScenePath, prepass: Option<&FramePrepass>, motion: bool) -> Result<(), RenderError> {
        if plan.variants.is_empty() {
            return Ok(());
        }
        let surface = self.surface_key(path.hdr);
        let world = WorldKey { format: path.format, reversed: path.depth_reversed, samples: self.samples, surface, equal: prepass.is_some_and(|prepass| prepass.equal) };
        if self.variants.world.as_ref().is_none_or(|(made, _)| *made != world) {
            self.variants.world = Some((world, Default::default()));
        }
        let prepass_key = prepass.map(|_| PrepassKey { reversed: path.depth_reversed, mode: AlphaMode::for_camera(1, path.taa), motion });
        if let Some(key) = prepass_key
            && self.variants.prepass.as_ref().is_none_or(|(made, _)| *made != key)
        {
            self.variants.prepass = Some((key, Default::default()));
        }
        for run in &plan.variants {
            let at = run.variant.index();
            if let Some((key, sets)) = self.variants.world.as_mut()
                && sets[at].is_none()
            {
                sets[at] = Some(world_set(&self.device, &self.layouts, key, run.variant)?);
            }
            if let (Some(_), Some((key, pipelines))) = (prepass_key, self.variants.prepass.as_mut())
                && pipelines[at].is_none()
            {
                pipelines[at] = Some(prepass_pipeline(&self.device, &self.layouts, self.motion_node.as_ref(), key, run.variant)?);
            }
            if plan.cascades.is_some() && self.variants.casters[at].is_none() {
                let caster = |format: ShadowFormat| caster_pipeline(&self.device, &self.layouts, self.casters, format.texture_format(), run.variant);
                self.variants.casters[at] = Some([caster(ShadowFormat::Depth32)?, caster(ShadowFormat::Depth16)?]);
            }
        }
        Ok(())
    }

    /// Draw `run`'s batches of view `view` through its rows of `pass_views` (the plan's culled
    /// counts on the CPU path).
    fn draw_run(&self, pass: &mut RenderPass<'_>, pass_views: &BindGroup, (plan, run): (&FramePlan, &VariantRun), view: u32, counts: Option<&[u32]>, stats: &mut FrameStats) {
        let total = plan.batches.len() as u32;
        pass.set_bind_group(1, pass_views, &[(variant_pass_entry(plan, view, run.variant.index()) * PASS_VIEW_STRIDE) as u32]);
        let sources = [
            (run.batches.start..run.skinned_from, &self.meshes.vertices, &self.meshes.slots),
            (run.skinned_from..run.batches.end, self.tables.skinned.get(), self.tables.skinned_slots.get()),
        ];
        for (range, vertices, slots) in sources {
            if range.is_empty() {
                continue;
            }
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.set_vertex_buffer(1, slots.slice(..));
            let Some(counts) = counts else {
                let offset = (u64::from(view) * u64::from(total) + u64::from(range.start)) * ARGS_STRIDE;
                pass.multi_draw_indexed_indirect(self.tables.args.get(), offset, range.len() as u32);
                stats.multi_draws += 1;
                stats.indirect_draws += range.len() as u32;
                continue;
            };
            for i in range {
                let (batch, count) = (&plan.batches[i as usize], counts[i as usize]);
                if count > 0 {
                    pass.draw_indexed(batch.first_index..batch.first_index + batch.index_count, batch.base_vertex, 0..count);
                    stats.direct_opaque_draws += 1;
                }
            }
        }
    }

    /// The world pass's variant batches (the camera view), after the plain ones, with the frame
    /// group bound at group 0: each alpha-tested run's depth step, then its shading.
    pub(super) fn draw_world_variants(&self, pass: &mut RenderPass<'_>, pass_views: &BindGroup, plan: &FramePlan, counts: Option<&[u32]>, stats: &mut FrameStats) {
        let Some((_, sets)) = self.variants.world.as_ref() else { return };
        for run in &plan.variants {
            let Some(set) = sets[run.variant.index()].as_ref() else { continue };
            if let Some(depth) = &set.depth {
                pass.set_pipeline(depth);
                self.draw_run(pass, pass_views, (plan, run), 0, counts, stats);
            }
            pass.set_pipeline(&set.shade);
            self.draw_run(pass, pass_views, (plan, run), 0, counts, stats);
        }
    }

    /// The prepass's variant batches (the camera view), after the plain ones, with its groups 0 and
    /// (on motion frames) 2 bound.
    pub(super) fn draw_prepass_variants(&self, pass: &mut RenderPass<'_>, pass_views: &BindGroup, plan: &FramePlan, counts: Option<&[u32]>, motion: bool) {
        let Some((_, pipelines)) = self.variants.prepass.as_ref().filter(|(key, _)| key.motion == motion) else { return };
        // The world pass's statistics count its own draws; the prepass's repeat them.
        let mut stats = FrameStats::default();
        for run in &plan.variants {
            let Some(pipeline) = pipelines[run.variant.index()].as_ref() else { continue };
            pass.set_pipeline(pipeline);
            self.draw_run(pass, pass_views, (plan, run), 0, counts, &mut stats);
        }
    }

    /// A cascade's variant casters (view `view`) into a map of `format`, after the plain ones,
    /// with the shadow group bound at group 0.
    pub(super) fn draw_caster_variants(&self, pass: &mut RenderPass<'_>, pass_views: &BindGroup, (plan, view): (&FramePlan, u32), format: TextureFormat, counts: Option<&[u32]>, stats: &mut FrameStats) {
        let at = usize::from(format == ShadowFormat::Depth16.texture_format());
        for run in &plan.variants {
            let Some(casters) = self.variants.casters[run.variant.index()].as_ref() else { continue };
            pass.set_pipeline(&casters[at]);
            self.draw_run(pass, pass_views, (plan, run), view, counts, stats);
        }
    }

    /// A shadowed spot's variant batches (view `view`) with the spot pipeline already set: whole and
    /// culled as before P2-0.12.
    pub(super) fn draw_spot_variants(&self, pass: &mut RenderPass<'_>, pass_views: &BindGroup, plan: &FramePlan, view: u32, counts: Option<&[u32]>, stats: &mut FrameStats) {
        for run in &plan.variants {
            self.draw_run(pass, pass_views, (plan, run), view, counts, stats);
        }
    }
}
