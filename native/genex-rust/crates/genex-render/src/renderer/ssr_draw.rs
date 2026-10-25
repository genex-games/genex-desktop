//! Screen-space reflections on the frame (renderer pass 2 B.9's frame hook, graph node 10b).
//!
//! - **Where they run** ([`Renderer::prepare_ssr`]): a frame of the HDR scene under TAA whose
//!   prepass ran and whose quality traces (`ssr::frame_ssr`: desktop `high` and `ultra`), once the
//!   previous frame left its colour pyramid on the same history and size. The other frames bind a
//!   zero texel at forward binding 30, so the probes and the sky reflect everything.
//! - **The surface** (lane FR; `vs_prepass_surface`/`fs_prepass_surface`,
//!   shaders/screen/prepass_surface.wgsl, [`Renderer::encode_prepass_surface`]): the prepass draws
//!   the opaque plain batches last, in a pass of their own over the depth the rest of the prepass
//!   wrote, with the forward module's surface twin, which writes the motion prepass's three
//!   targets and A.6's normal and roughness as the forward pass will shade them (normal maps,
//!   specular AA, the decals' wet patches) in one draw. Variants, meshlets, the terrain, grass
//!   and custom geometry draw first and write nothing there, so a batch they hide fails the depth
//!   test and leaves the cleared texel (rough: nothing traced, the probes reflect them); prepass
//!   part 2's meshlets write that texel (`fs_prepass_motion_rough`). Before lane FR a pass of its
//!   own drew the batches again `Equal` over the prepass depth for the texel alone: the same
//!   texels, without the second geometry pass.
//! - **The trace** ([`crate::ssr::SsrNode`]): the nearest-depth Hi-Z, the half-size trace and the
//!   resolve into `screen reflections`, which the world pass binds at 30 (D1: the 16th sampled
//!   texture).
//! - **Nothing to reflect** (lane FQ, [`crate::ssr::frame_can_reflect`]): a frame whose surfaces
//!   and decals are all at or past the cutoff opens none of the passes above; its binding 30 is
//!   the zero texel the trace would have resolved to, the same picture.
//! - **The pyramid** ([`Renderer::encode_ssr_pyramid`], after node 17): TAA's resolve halved into
//!   A.6's colour pyramid, the next frame's reflected colour, reprojected along TAA's camera row
//!   and re-exposed by the exposure ratio. On a frame that traces, the water (B.3) reads this
//!   pyramid too and builds none of its own ([`Renderer::ssr_history`]).

use glam::Mat4;
use wgpu::{RenderPipeline, TextureFormat, TextureView};

use super::{FramePrep, FrameStats, Renderer, ScenePath, SurfaceKey, mesh_buffers_layout, shader, surface_constants};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::graph::FrameEncoder;
use crate::screen_inputs::{PyramidInput, PyramidNode, ScreenInputs};
use crate::settle::HistorySet;
use crate::ssr::{SsrCamera, SsrInput, SsrNode};
use crate::target_pool::TargetDesc;

/// The prepass surface twin's fragment entry point (shaders/screen/prepass_surface.wgsl).
const SURFACE_ENTRY: &str = "fs_prepass_surface";
/// Its vertex entry point.
const SURFACE_VERTEX: &str = "vs_prepass_surface";

/// What the surface pipeline was made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SurfacePipelineKey {
    reversed: bool,
    format: TextureFormat,
    surface: SurfaceKey,
}

/// One frame's targets (taken from the pool, so the ledger counts them).
struct SsrTargets {
    normal_roughness: TextureView,
    hiz: wgpu::Texture,
    trace: wgpu::Texture,
    reflections: wgpu::Texture,
    reflections_view: TextureView,
    pyramid: wgpu::Texture,
    pyramid_view: TextureView,
    render: (u32, u32),
}

/// When and how the pyramid was last built: the next frame reads it only when it follows.
#[derive(Clone, Copy, Debug)]
struct PyramidStamp {
    frame: u64,
    set: HistorySet,
    render: (u32, u32),
    pre_exposure: f32,
}

/// The reflections' node, pipelines and this frame's targets.
pub(super) struct SsrHook {
    /// A 1 x 1 zero texel: binding 30 on frames that trace nothing.
    neutral: TextureView,
    node: Option<SsrNode>,
    pyramid_node: Option<PyramidNode>,
    surface: Option<(SurfacePipelineKey, Compiled<RenderPipeline>)>,
    /// This frame's targets while the frame traces.
    frame: Option<SsrTargets>,
    /// Whether this frame's reflections were written (binding 30 binds them).
    written: bool,
    /// Whether this frame's prepass wrote the surface texel ([`Renderer::encode_prepass_surface`]).
    surface_written: bool,
    /// The pyramid the last frame built.
    built: Option<PyramidStamp>,
}

impl SsrHook {
    /// The zero texel; the node and pipelines come with the first frame that traces.
    pub(super) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> SsrHook {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("screen reflections (neutral)"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: crate::screen_inputs::REFLECTIONS_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // rgba16float zero: eight zero bytes.
        queue.write_texture(
            texture.as_image_copy(),
            &[0u8; 8],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        let neutral = texture.create_view(&wgpu::TextureViewDescriptor::default());
        SsrHook { neutral, node: None, pyramid_node: None, surface: None, frame: None, written: false, surface_written: false, built: None }
    }

    /// The texture binding 30 holds now: this frame's reflections once written, else the zero texel.
    pub(super) fn view(&self) -> TextureView {
        match &self.frame {
            Some(targets) if self.written => targets.reflections_view.clone(),
            _ => self.neutral.clone(),
        }
    }

    /// The zero texel (a probe capture's binding 30).
    pub(super) fn neutral(&self) -> &TextureView {
        &self.neutral
    }

    /// Whether this frame traces (its targets are held).
    pub(super) fn traces(&self) -> bool {
        self.frame.is_some()
    }
}

/// The cleared surface texel: straight up and fully rough, so nothing is traced where no plain
/// batch is in front (the sky, the terrain, variants): the probes reflect it.
fn rough_clear() -> wgpu::Color {
    let texel = crate::screen_inputs::pack_normal_roughness([0.0, 1.0, 0.0], 1.0).map(|c| f64::from(c) / 255.0);
    wgpu::Color { r: texel[0], g: texel[1], b: texel[2], a: texel[3] }
}

/// The surface target's row at `render` size.
fn surface_target(render: (u32, u32), format: TextureFormat) -> TargetDesc {
    let only = ScreenInputs { normal_roughness: true, ..ScreenInputs::NONE };
    crate::screen_inputs::targets(render, format, only).remove(0)
}

/// The prepass depth's operations in its surface pass: kept as the rest of the prepass wrote it,
/// and stored with the batches' depth.
fn keep_depth() -> wgpu::Operations<f32> {
    wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }
}

/// The colour pyramid's row at `render` size.
fn pyramid_target(render: (u32, u32), format: TextureFormat) -> TargetDesc {
    let only = ScreenInputs { history_pyramid: true, ..ScreenInputs::NONE };
    crate::screen_inputs::targets(render, format, only).remove(0)
}

/// The prepass surface twin's pipeline (lane FR): `vs_prepass_surface` and `fs_prepass_surface`
/// of the forward module's twin over the frame and pass-view groups and `node`'s motion group,
/// into the prepass's three targets and A.6's target, depth written as the motion prepass's, the
/// forward constants of `key`.
fn ssr_surface_pipeline(device: &wgpu::Device, layouts: &super::Layouts, node: &crate::motion::MotionNode, key: SurfacePipelineKey) -> Result<Compiled<RenderPipeline>, RenderError> {
    let module = shader(device, "prepass surface", crate::shaders::PREPASS_SURFACE)?;
    let meshes = mesh_buffers_layout();
    let constants = surface_constants(key.reversed, key.format, key.surface);
    Ok(node.surface_pipeline(device, &module, (SURFACE_VERTEX, SURFACE_ENTRY), &meshes, [&layouts.frame, &layouts.pass], key.reversed, &constants))
}

/// Every pool label the reflections hold.
const LABELS: [&str; 5] = [
    crate::screen_inputs::NORMAL_ROUGHNESS_LABEL,
    crate::screen_inputs::PYRAMID_LABEL,
    crate::ssr::HIZ_LABEL,
    crate::ssr::TRACE_LABEL,
    crate::ssr::REFLECTIONS_LABEL,
];

impl Renderer {
    /// Before the frame's groups: whether the frame on `path` traces (its prepass ran with motion
    /// under TAA on a quality that asks), with its targets taken and its node and surface pipeline
    /// made; otherwise the targets are given back and binding 30 holds the zero texel.
    pub(super) fn prepare_ssr(&mut self, path: &ScenePath, prepass: bool, motion: bool) -> Result<(), RenderError> {
        let traces = crate::ssr::LANDED && crate::ssr::frame_ssr(&self.quality, path.hdr) && path.taa && prepass && motion && self.samples == 1;
        let hook = self.ssr.get_mut();
        hook.written = false;
        hook.surface_written = false;
        if !traces || self.motion_node.is_none() {
            if hook.frame.take().is_some() {
                LABELS.iter().for_each(|label| self.pool.release(label));
            }
            hook.built = None;
            return Ok(());
        }
        let render = self.targets.render_size;
        let format = path.format;
        let surface = self.pool.acquire(&self.device, surface_target(render, format))?.view().clone();
        let pyramid = self.pool.acquire(&self.device, pyramid_target(render, format))?;
        let (pyramid, pyramid_view) = (pyramid.texture().clone(), pyramid.view().clone());
        let rows = crate::ssr::targets(render);
        let hiz = self.pool.acquire(&self.device, rows[0])?.texture().clone();
        let trace = self.pool.acquire(&self.device, rows[1])?.texture().clone();
        let reflections = self.pool.acquire(&self.device, rows[2])?;
        let (reflections, reflections_view) = (reflections.texture().clone(), reflections.view().clone());
        let key = SurfacePipelineKey { reversed: path.depth_reversed, format, surface: self.surface_key(path.hdr) };
        let made = self.ssr.get_mut().surface.as_ref().is_some_and(|(made, _)| *made == key);
        if let (false, Some(node)) = (made, self.motion_node.as_ref()) {
            let pipeline = ssr_surface_pipeline(&self.device, &self.layouts, node, key)?;
            self.ssr.get_mut().surface = Some((key, pipeline));
            self.note_pipeline_build();
        }
        let hook = self.ssr.get_mut();
        if hook.node.is_none() {
            hook.node = Some(SsrNode::new(&self.device)?);
        }
        if hook.pyramid_node.is_none() {
            hook.pyramid_node = Some(PyramidNode::new(&self.device)?);
        }
        hook.frame = Some(SsrTargets { normal_roughness: surface, hiz, trace, reflections, reflections_view, pyramid, pyramid_view, render });
        Ok(())
    }

    /// Whether node 10b has work: the frame traces and last frame's pyramid follows.
    pub(super) fn ssr_runs(&self) -> bool {
        let hook = self.ssr.borrow();
        hook.traces() && self.ssr_pyramid_follows(&hook)
    }

    /// Whether the pyramid the last frame built is this frame's previous one (same history set and
    /// size, no reset).
    fn ssr_pyramid_follows(&self, hook: &SsrHook) -> bool {
        let temporal = self.temporal;
        let render = self.targets.render_size;
        hook.built.is_some_and(|built| built.render == render && built.set == temporal.set && built.frame.wrapping_add(1) == self.frame_index && !temporal.reset)
    }

    /// Whether this frame traces screen-space reflections (its pyramid is built after node 17).
    pub(super) fn ssr_traces(&self) -> bool {
        self.ssr.borrow().traces()
    }

    /// Last frame's colour pyramid and the exposure it was built at, when this frame traces and
    /// follows it: the water's screen reflection reads the same one (B.3 and B.9 share it).
    pub(super) fn ssr_history(&self) -> Option<(TextureView, f32)> {
        let hook = self.ssr.borrow();
        let built = hook.built.filter(|_| self.ssr_pyramid_follows(&hook))?;
        hook.frame.as_ref().map(|targets| (targets.pyramid_view.clone(), built.pre_exposure))
    }

    /// Whether this frame's prepass writes the reflections' surface texel (lane FR): node 10b will
    /// trace (the frame traces, last frame's pyramid follows and something can reflect,
    /// [`crate::ssr::frame_can_reflect`]) and the surface twin's pipeline is made.
    pub(super) fn ssr_surface_in_prepass(&self, prep: &FramePrep) -> bool {
        let made = self.ssr.borrow().surface.is_some();
        made && self.ssr_runs() && crate::ssr::frame_can_reflect(&prep.plan)
    }

    /// Graph node 7's last pass on a frame whose prepass writes the surface texel (lane FR): the
    /// opaque plain batches (`counts`: the camera view's on the CPU path) over the depth the rest of
    /// the prepass wrote, with the surface twin into the prepass's three targets (`colors`, kept)
    /// and A.6's normal and roughness (cleared rough first). False when the frame has no target.
    pub(super) fn encode_prepass_surface(&self, frame: &mut FrameEncoder, prep: &FramePrep, counts: Option<&[u32]>, (colors, depth, motion): (&[&TextureView; 3], &TextureView, &wgpu::BindGroup)) -> bool {
        let hook = self.ssr.borrow();
        let (Some(targets), Some((_, surface))) = (hook.frame.as_ref(), hook.surface.as_ref()) else { return false };
        let keep = wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store };
        let cleared = wgpu::Operations { load: wgpu::LoadOp::Clear(rough_clear()), store: wgpu::StoreOp::Store };
        let views = [(colors[0], keep), (colors[1], keep), (colors[2], keep), (&targets.normal_roughness, cleared)];
        let attachments = views.map(|(view, ops)| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops }));
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("prepass surface"),
            color_attachments: &attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(keep_depth()), stencil_ops: None }),
            ..Default::default()
        });
        if !prep.plan.batches.is_empty() {
            pass.set_pipeline(surface);
            pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.set_bind_group(0, &prep.groups.frame, &[]);
            pass.set_bind_group(1, &prep.groups.pass, &[0]);
            pass.set_bind_group(2, motion, &[]);
            let meshlets = prep.meshlets.as_ref().map(|meshlets| &meshlets.frame);
            self.draw_batches(&mut pass, &prep.plan, 0, counts, meshlets, &mut FrameStats::default());
        }
        drop(pass);
        drop(hook);
        self.ssr.borrow_mut().surface_written = true;
        true
    }

    /// The surface texel's view while this frame's prepass wrote it (prepass part 2's meshlets
    /// write the rough texel over it, lane FR).
    pub(super) fn ssr_written_surface(&self) -> Option<TextureView> {
        let hook = self.ssr.borrow();
        hook.frame.as_ref().filter(|_| hook.surface_written).map(|targets| targets.normal_roughness.clone())
    }

    /// Graph node 10b: the Hi-Z, the trace and the resolve over the surface texel the prepass wrote
    /// (lane FR). The compute passes it opened. A frame whose prepass wrote none (nothing in it
    /// can reflect, [`crate::ssr::frame_can_reflect`], lane FQ) opens none: binding 30 keeps the
    /// zero texel the trace would have resolved to, and the pyramid is still built after node 17
    /// for the next frame.
    pub(super) fn encode_ssr(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> u32 {
        let Some(prepass) = self.targets.prepass.as_ref() else { return 0 };
        let mut hook = self.ssr.borrow_mut();
        let Some(built) = hook.built.filter(|_| hook.surface_written) else { return 0 };
        let hook = &mut *hook;
        let (Some(targets), Some(node)) = (hook.frame.as_ref(), hook.node.as_mut()) else { return 0 };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let camera = self.ssr_camera(prep);
        let radiance_scale = self.path.pre_exposure / built.pre_exposure.max(f32::MIN_POSITIVE);
        let params = crate::ssr::params(&camera, self.quality.ssr, targets.render, targets.pyramid.mip_level_count(), radiance_scale);
        let input = SsrInput {
            depth: &prepass.depth_view,
            normal_roughness: &targets.normal_roughness,
            history: &targets.pyramid_view,
            hiz: &targets.hiz,
            trace: &targets.trace,
            reflections: &targets.reflections,
            render: targets.render,
            params,
            reversed: camera.reversed,
        };
        if node.encode(&device, &queue, frame.encoder(), input, None).is_err() {
            return 0;
        }
        hook.written = true;
        3
    }

    /// The trace's camera: this frame's jitter-free view and projection, and last frame's
    /// view-projection along TAA's reprojection row (identity after a reset).
    fn ssr_camera(&self, prep: &FramePrep) -> SsrCamera {
        let camera = &prep.camera;
        let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::from(camera.eye), glam::Vec3::from(camera.target), glam::Vec3::from(camera.up));
        let view_proj = Mat4::from_cols_array(&prep.plan.frame.view_proj);
        let proj = view_proj * view.inverse();
        let prev_view_proj = Mat4::from_cols_array(&self.taa_reproject) * view_proj;
        SsrCamera { proj, view, view_proj, prev_view_proj, reversed: self.path.depth_reversed, orthographic: proj.col(3).w == 1.0 }
    }

    /// After node 17 on a frame that traces: TAA's resolve `source` halved into the colour pyramid
    /// the next frame reflects. The compute passes it opened.
    pub(super) fn encode_ssr_pyramid(&self, frame: &mut FrameEncoder, source: &TextureView) -> u32 {
        let mut hook = self.ssr.borrow_mut();
        let hook = &mut *hook;
        let (Some(targets), Some(node)) = (hook.frame.as_ref(), hook.pyramid_node.as_mut()) else { return 0 };
        let device = frame.device().clone();
        let input = PyramidInput { source, pyramid: &targets.pyramid, render: targets.render };
        if node.encode(&device, frame.encoder(), input, None).is_err() {
            return 0;
        }
        hook.built = Some(PyramidStamp { frame: self.frame_index, set: self.temporal.set, render: targets.render, pre_exposure: self.path.pre_exposure });
        1
    }
}
