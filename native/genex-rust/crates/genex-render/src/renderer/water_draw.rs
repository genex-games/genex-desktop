//! Graph node 16a: the scene's water on the frame (renderer pass 2 B.3, `crate::water`).
//!
//! After the world pass (and its MSAA resolve) the water draws its rectangle over the 1x HDR scene
//! in a pass of its own, depth-tested against the prepass depth held read-only, the same depth its
//! shader samples for the underwater path. Where the preset allows the opaque copy (desktop and
//! web `high` and `ultra`) the scene is copied first and the water refracts it; elsewhere it is
//! blended over the scene unrefracted. It reflects the probes over it and the sky, and where the
//! preset holds the history pyramid (desktop and web `high` and `ultra`) the screen first: after
//! node 17 a frame with water builds the colour pyramid from TAA's resolve, and the next frame's
//! water marches it (a frame that does not follow the pyramid's, a history reset or another render
//! size reflects the environment alone). On frames writing motion its motion key follows (T-01 step 3): the
//! surface's own motion, reactive 0 and its depth into the motion prepass's targets, so TAA
//! reprojects a water pixel by the water rather than the bed under it.

use wgpu::{Texture, TextureView};

use super::{FramePrep, Renderer};
use crate::device_class::{DeviceClass, PerformanceTier};
use crate::graph::FrameEncoder;
use crate::screen_inputs::{PyramidInput, PyramidNode, ScreenInputs};
use crate::settle::HistorySet;
use crate::water::reflect::{GpuWaterReflect, WaterReflectFrame};
use crate::water::{GpuWater, WaterFormats, WaterFrame, WaterInput, WaterNode};

/// The water's node for the formats it was made for, and its opaque copy at the render size.
pub(super) struct WaterHook {
    formats: WaterFormats,
    node: WaterNode,
    opaque: Option<(Texture, TextureView)>,
    /// A 1 x 1 depth the motion key's group binds: its pass writes the prepass depth, which the
    /// colour pass's group samples (one texture cannot be both in a pass), and the motion
    /// fragment reads no depth.
    no_depth: Option<TextureView>,
    /// The colour pyramid the next frame's water marches (made on the first frame that builds it).
    pyramid: Option<WaterPyramid>,
}

/// The history pyramid built after node 17 for the next frame's screen reflections, and what it was
/// built from.
struct WaterPyramid {
    node: PyramidNode,
    texture: Texture,
    view: TextureView,
    render: (u32, u32),
    /// The frame index and history set it was built on, and the exposure the scene had.
    frame: u64,
    set: HistorySet,
    pre_exposure: f32,
}

impl Renderer {
    /// Whether node 16a draws the scene's water this frame: the frame has water, draws the HDR
    /// scene into a 1x target (not the desktop weighted resolve's samples) and ran the prepass,
    /// whose depth the water samples and tests against.
    pub(super) fn water_runs(&self, prep: &FramePrep) -> bool {
        let targets = &self.targets;
        let inputs = targets.scene_texture.is_some() && targets.prepass.is_some() && prep.prepass.is_some();
        prep.water.is_some() && self.path.hdr && !targets.spec.msaa_read && inputs
    }

    /// Node 16a: the opaque copy (where the preset allows it) and the water's colour pass; the
    /// render passes it opened.
    pub(super) fn encode_water(&self, frame: &mut FrameEncoder, prep: &FramePrep) -> u32 {
        let Some(water) = prep.water else { return 0 };
        let targets = &self.targets;
        let (Some(scene_texture), Some(scene_view), Some(prepass)) = (targets.scene_texture.as_ref(), targets.scene_view.as_ref(), targets.prepass.as_ref()) else {
            return 0;
        };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let formats = WaterFormats { colour: self.path.format, depth: super::DEPTH_FORMAT, depth_reversed: self.path.depth_reversed, colour_writes_depth: false };
        let mut slot = self.water.borrow_mut();
        if slot.as_ref().is_none_or(|hook| hook.formats != formats) {
            let Ok(node) = WaterNode::new(&device, formats) else { return 0 };
            *slot = Some(WaterHook { formats, node, opaque: None, no_depth: None, pyramid: None });
        }
        let Some(hook) = slot.as_mut() else { return 0 };
        let no_depth = hook.no_depth(&device).clone();
        let render = targets.render_size;
        // No history pyramid on the frame yet: the reflection is the environment's.
        let asked = crate::screen_inputs::frame_inputs(&self.quality, self.path.hdr, crate::water::asked_inputs());
        let copied = asked.opaque_copy && hook.copy_opaque(&device, frame.encoder(), scene_texture, render);
        // Last frame's pyramid, when this frame follows it on the same history and size.
        let temporal = self.temporal;
        let follows = |p: &&WaterPyramid| p.render == render && p.set == temporal.set && p.frame.wrapping_add(1) == self.frame_index && !temporal.reset;
        let pyramid = hook.pyramid.as_ref().filter(follows).filter(|_| asked.history_pyramid);
        let inputs = ScreenInputs { opaque_copy: copied, history_pyramid: pyramid.is_some(), ..asked };
        let class = self.class.unwrap_or(DeviceClass::new(self.form, PerformanceTier::High));
        let environment = self.environment.borrow();
        // The forward pass's binding 11: the probe array (the sky in layer 0).
        let Some(wgpu::BindingResource::TextureView(env)) = environment.binding(crate::probes::ENV_PROBES) else { return 0 };
        let env_mips = environment.specular_texture().map_or(1, Texture::mip_level_count);
        let camera = &prep.camera;
        let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::from(camera.eye), glam::Vec3::from(camera.target), glam::Vec3::from(camera.up));
        let view_proj = glam::Mat4::from_cols_array(&prep.plan.frame.view_proj);
        // Last frame's unjittered view-projection: TAA's reprojection (identity after a reset) is
        // last frame's times this frame's inverse.
        let prev_view_proj = glam::Mat4::from_cols_array(&self.taa_reproject) * view_proj;
        let row = GpuWater::new(&WaterFrame {
            body: water.body,
            proj: view_proj * view.inverse(),
            prev_view_proj,
            render,
            time: water.time,
            env_mips,
            path: crate::water::path(inputs),
            reflection: crate::water::reflection_source(&self.quality, class, inputs),
            depth_reversed: self.path.depth_reversed,
        });
        let reflect = GpuWaterReflect::new(&WaterReflectFrame {
            body: &water.body,
            view_proj,
            prev_view_proj,
            radiance_scale: pyramid.map_or(1.0, |p| self.path.pre_exposure / p.pre_exposure.max(f32::MIN_POSITIVE)),
            probes: environment.probes().frame_rows(),
        });
        hook.node.set_reflection(&queue, &reflect);
        let history = pyramid.map(|p| p.view.clone());
        let opaque = hook.opaque.as_ref().filter(|_| copied).map(|(_, view)| view);
        hook.node.prepare(&device, &queue, &row, &WaterInput { frame: &self.frame_uniforms, opaque, depth: &prepass.depth_view, env, history: history.as_ref() });
        let mut pass = frame.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("water"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: scene_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            // Read-only: the water tests against the prepass depth its shader also samples.
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &prepass.depth_view, depth_ops: None, stencil_ops: None }),
            ..Default::default()
        });
        hook.node.draw_colour(&mut pass);
        drop(pass);
        let (Some((_, motion)), Some((_, reactive))) = (prepass.motion.as_ref(), prepass.reactive.as_ref()) else { return 1 };
        hook.node.prepare(&device, &queue, &row, &WaterInput { frame: &self.frame_uniforms, opaque, depth: &no_depth, env, history: history.as_ref() });
        hook.node.encode_motion(frame.encoder(), [&prepass.normals_view, motion, reactive], &prepass.depth_view);
        2
    }
}

impl Renderer {
    /// After node 17 on a frame that drew water where the preset holds the history pyramid: the
    /// colour pyramid of TAA's resolve `source` for the next frame's screen reflections. The
    /// compute passes it opened.
    pub(super) fn encode_water_pyramid(&self, frame: &mut FrameEncoder, prep: &FramePrep, source: &TextureView) -> u32 {
        let asked = crate::screen_inputs::frame_inputs(&self.quality, self.path.hdr, crate::water::asked_inputs());
        if !(asked.history_pyramid && self.water_runs(prep)) {
            return 0;
        }
        let mut slot = self.water.borrow_mut();
        let Some(hook) = slot.as_mut() else { return 0 };
        let device = frame.device().clone();
        let render = self.targets.render_size;
        if hook.pyramid.as_ref().is_none_or(|p| p.render != render) {
            let Ok(node) = hook.pyramid.take().map_or_else(|| PyramidNode::new(&device), |p| Ok(p.node)) else { return 0 };
            let (w, h) = crate::screen_inputs::pyramid_size(render);
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(crate::screen_inputs::PYRAMID_LABEL),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: crate::screen_inputs::pyramid_mips(render),
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: crate::screen_inputs::PYRAMID_FORMAT,
                usage: crate::screen_inputs::PYRAMID_USAGE,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            hook.pyramid = Some(WaterPyramid { node, texture, view, render, frame: u64::MAX, set: self.temporal.set, pre_exposure: 1.0 });
        }
        let Some(pyramid) = hook.pyramid.as_mut() else { return 0 };
        let input = PyramidInput { source, pyramid: &pyramid.texture, render };
        if pyramid.node.encode(&device, frame.encoder(), input, None).is_err() {
            return 0;
        }
        (pyramid.frame, pyramid.set, pyramid.pre_exposure) = (self.frame_index, self.temporal.set, self.path.pre_exposure);
        1
    }
}

impl WaterHook {
    /// The 1 x 1 depth the motion key's group binds (made once).
    fn no_depth(&mut self, device: &wgpu::Device) -> &TextureView {
        self.no_depth.get_or_insert_with(|| {
            device
                .create_texture(&wgpu::TextureDescriptor {
                    label: Some("water no depth"),
                    size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: super::DEPTH_FORMAT,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                })
                .create_view(&wgpu::TextureViewDescriptor::default())
        })
    }

    /// Copy the opaque scene into the hook's copy (made at `render` size in the scene's format):
    /// false when the copy could not be recorded.
    fn copy_opaque(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, scene: &Texture, render: (u32, u32)) -> bool {
        let size = wgpu::Extent3d { width: render.0.max(1), height: render.1.max(1), depth_or_array_layers: 1 };
        let fits = self.opaque.as_ref().is_some_and(|(texture, _)| texture.size() == size && texture.format() == scene.format());
        if !fits {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(crate::screen_inputs::OPAQUE_LABEL),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: scene.format(),
                usage: crate::screen_inputs::OPAQUE_USAGE,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.opaque = Some((texture, view));
        }
        let Some((texture, _)) = self.opaque.as_ref() else { return false };
        crate::screen_inputs::encode_opaque_copy(encoder, scene, texture).is_ok()
    }
}
