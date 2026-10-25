//! Screen-space reflections on the frame (renderer pass 2 B.9's frame hook, graph node 10b).
//!
//! - **Where they run** ([`Renderer::prepare_ssr`]): a frame of the HDR scene under TAA whose
//!   prepass ran and whose quality traces (`ssr::frame_ssr`: desktop `high` and `ultra`), once the
//!   previous frame left its colour pyramid on the same history and size. The other frames bind a
//!   zero texel at forward binding 30, so the probes and the sky reflect everything.
//! - **The surface** (`fs_ssr_surface`, shaders/screen/ssr_surface.wgsl): the opaque plain batches
//!   drawn again `Equal` over the prepass depth with the forward module, writing A.6's normal and
//!   roughness as the forward pass will shade them (normal maps, specular AA, the decals' wet
//!   patches). Variants, meshlets, the terrain, grass and custom geometry keep the cleared texel
//!   (rough: nothing traced, the probes reflect them).
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

use super::{FramePrep, FrameStats, PipelineSpec, Renderer, ScenePath, SurfaceKey, mesh_buffers_layout, render_pipeline_with, shader, surface_constants};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::graph::FrameEncoder;
use crate::screen_inputs::{PyramidInput, PyramidNode, ScreenInputs};
use crate::settle::HistorySet;
use crate::ssr::{SsrCamera, SsrInput, SsrNode};
use crate::tables::pipeline_layout;
use crate::target_pool::TargetDesc;

/// The surface pass's fragment entry point (shaders/screen/ssr_surface.wgsl).
const SURFACE_ENTRY: &str = "fs_ssr_surface";
/// The forward vertex entry point the surface pass draws the batches with.
const SURFACE_VERTEX: &str = "vs_main";

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
        SsrHook { neutral, node: None, pyramid_node: None, surface: None, frame: None, written: false, built: None }
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

/// The cleared surface texel: straight up and fully rough, so nothing is traced where the surface
/// pass drew nothing (the sky, the terrain, variants): the probes reflect it.
fn rough_clear() -> wgpu::Color {
    let texel = crate::screen_inputs::pack_normal_roughness([0.0, 1.0, 0.0], 1.0).map(|c| f64::from(c) / 255.0);
    wgpu::Color { r: texel[0], g: texel[1], b: texel[2], a: texel[3] }
}

/// The surface target's row at `render` size.
fn surface_target(render: (u32, u32), format: TextureFormat) -> TargetDesc {
    let only = ScreenInputs { normal_roughness: true, ..ScreenInputs::NONE };
    crate::screen_inputs::targets(render, format, only).remove(0)
}

/// The colour pyramid's row at `render` size.
fn pyramid_target(render: (u32, u32), format: TextureFormat) -> TargetDesc {
    let only = ScreenInputs { history_pyramid: true, ..ScreenInputs::NONE };
    crate::screen_inputs::targets(render, format, only).remove(0)
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
        if !traces {
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
        if !made {
            let pipeline = self.ssr_surface_pipeline(key)?;
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

    /// The surface pass's pipeline: the forward vertex shader and `fs_ssr_surface` into A.6's
    /// target, `Equal` over the prepass depth with depth writes off, the forward constants of `key`.
    fn ssr_surface_pipeline(&self, key: SurfacePipelineKey) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "forward", crate::shaders::FORWARD)?;
        let layout = pipeline_layout(&self.device, "ssr surface", &[&self.layouts.frame, &self.layouts.pass]);
        let meshes = mesh_buffers_layout();
        let equal = wgpu::DepthStencilState { depth_compare: Some(wgpu::CompareFunction::Equal), ..super::depth_state(false, key.reversed) };
        let spec = PipelineSpec {
            label: "ssr surface",
            module: &module,
            vertex: SURFACE_VERTEX,
            fragment: Some(SURFACE_ENTRY),
            buffers: &meshes,
            topology: wgpu::PrimitiveTopology::TriangleList,
            depth: Some(equal),
            format: crate::screen_inputs::NORMAL_ROUGHNESS_FORMAT,
            blend: None,
            samples: 1,
            layout: &layout,
        };
        Ok(render_pipeline_with(&self.device, &spec, &surface_constants(key.reversed, key.format, key.surface)))
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

    /// Graph node 10b: the surface pass over the prepass depth (`counts`: the camera view's on the
    /// CPU path), then the Hi-Z, the trace and the resolve. The render and compute passes it opened.
    /// A frame nothing in can reflect ([`crate::ssr::frame_can_reflect`], lane FQ) opens none:
    /// binding 30 keeps the zero texel the trace would have resolved to, and the pyramid is still
    /// built after node 17 for the next frame.
    pub(super) fn encode_ssr(&self, frame: &mut FrameEncoder, prep: &FramePrep, counts: Option<&[u32]>) -> (u32, u32) {
        let Some(prepass) = self.targets.prepass.as_ref() else { return (0, 0) };
        if !self.ssr_runs() || !crate::ssr::frame_can_reflect(&prep.plan) {
            return (0, 0);
        }
        let mut hook = self.ssr.borrow_mut();
        let Some(built) = hook.built else { return (0, 0) };
        let hook = &mut *hook;
        let (Some(targets), Some(node), Some((_, surface))) = (hook.frame.as_ref(), hook.node.as_mut(), hook.surface.as_ref()) else { return (0, 0) };
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("ssr surface"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &targets.normal_roughness,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(rough_clear()), store: wgpu::StoreOp::Store },
            })],
            // Read-only: the batches land `Equal` on the depth the prepass wrote.
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &prepass.depth_view, depth_ops: None, stencil_ops: None }),
            ..Default::default()
        });
        if !prep.plan.batches.is_empty() {
            pass.set_pipeline(surface);
            pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.set_bind_group(0, &prep.groups.frame, &[]);
            pass.set_bind_group(1, &prep.groups.pass, &[0]);
            let meshlets = prep.meshlets.as_ref().map(|meshlets| &meshlets.frame);
            self.draw_batches(&mut pass, &prep.plan, 0, counts, meshlets, &mut FrameStats::default());
        }
        drop(pass);
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
            return (1, 0);
        }
        hook.written = true;
        (1, 3)
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
