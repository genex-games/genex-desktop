//! Graph nodes 17a and 17b (renderer pass 2 A.9): the look's depth of field
//! ([`crate::post::dof`]) and motion blur ([`crate::post::motion_blur`]) on the HDR scene, after
//! TAA's resolve (node 17) and before `post-hdr` (node 18), so bloom, auto exposure and the
//! tonemap see the blurred scene and TAA's history never does.
//!
//! - **Where they run**: a frame of the HDR scene whose prepass ran (its single-sample depth is
//!   the lens's; motion blur also needs the prepass's motion, which TAA's frames write) and which
//!   holds a 1x scene. Elsewhere (the legacy path, a phone's MSAA frame without a prepass) the look
//!   asks for nothing the frame can draw, and the frame is drawn without it.
//! - **Where they write**: the first node after TAA reads TAA's resolve and writes the 1x scene
//!   (then the later nodes read the scene, as after a `post-hdr` copy). A node that reads the
//!   scene (no TAA, or motion blur after depth of field) writes its own output, copied back into
//!   the scene.
//! - **Settled captures** draw neither unless the shot asks ([`CaptureLens`],
//!   [`Renderer::set_capture_lens`]): a capture is a still of the held frame.
//! - **Budget**: the targets come from the target pool and are counted under
//!   [`crate::budget::DEPTH_OF_FIELD_LABEL`] and [`crate::budget::MOTION_BLUR_LABEL`].

use glam::Mat4;
use wgpu::{Texture, TextureFormat, TextureView};

use super::{Renderer, ScenePath, WorldNodes};
use crate::error::RenderError;
use crate::graph::FrameEncoder;
use crate::scene::{CameraDesc, FramePlan};
use crate::post::dof::{self, DofFrame, DofFrameSettings, DofInput, DofNode};
use crate::post::motion_blur::{self, MotionBlurFrame, MotionBlurFrameSettings, MotionBlurInput, MotionBlurNode};

/// What a settled capture's shot asks of the look's lens: neither by default, so a capture is a
/// still of the held frame (the capture verb's `lens`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaptureLens {
    /// Draw the look's depth of field.
    pub depth_of_field: bool,
    /// Draw the look's motion blur.
    pub motion_blur: bool,
}

impl CaptureLens {
    /// Both, as a Live frame draws them.
    pub const ALL: CaptureLens = CaptureLens { depth_of_field: true, motion_blur: true };
}

/// What the lens nodes draw this frame, and whether each writes its own output.
#[derive(Clone, Copy, Debug, Default)]
struct LensFrame {
    dof: Option<(DofFrameSettings, bool)>,
    motion_blur: Option<(MotionBlurFrameSettings, bool)>,
}

/// The lens nodes, made on the first frame that draws each, and this frame's settings.
#[derive(Default)]
pub(super) struct LensNodes {
    dof: Option<DofNode>,
    motion_blur: Option<MotionBlurNode>,
    frame: LensFrame,
    /// What a settled capture's shot asks.
    capture: CaptureLens,
}

impl LensNodes {
    /// Whether node 17a draws this frame.
    pub(super) fn draws_dof(&self) -> bool {
        self.frame.dof.is_some()
    }

    /// Whether node 17b draws this frame.
    pub(super) fn draws_motion_blur(&self) -> bool {
        self.frame.motion_blur.is_some()
    }
}

/// The projection a frame planned as `plan` from `camera` is drawn through (its jitter does not
/// matter to either node).
pub(super) fn frame_proj(plan: &FramePlan, camera: &CameraDesc) -> Mat4 {
    let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::from(camera.eye), glam::Vec3::from(camera.target), glam::Vec3::from(camera.up));
    Mat4::from_cols_array(&plan.frame.view_proj) * view.inverse()
}

impl Renderer {
    /// Draw a settled capture with what its shot asks of the look's lens (default: neither).
    pub fn set_capture_lens(&mut self, lens: CaptureLens) {
        self.lens.get_mut().capture = lens;
    }

    /// What the next settled captures ask of the look's lens.
    pub fn capture_lens(&self) -> CaptureLens {
        self.lens.borrow().capture
    }

    /// This frame's depth of field and motion blur on `path` (the prepass ran: `prepass`; it
    /// wrote motion: `motion`), drawn through `proj`, and their targets from the pool (released
    /// when a node does not draw).
    pub(super) fn prepare_lens(&mut self, path: &ScenePath, prepass: bool, motion: bool, proj: Mat4) -> Result<(), RenderError> {
        let scene = self.targets.scene_texture.as_ref().filter(|_| prepass).map(Texture::format);
        let capture = self.lens.get_mut().capture;
        let settled = self.environment_settle;
        let dof_frame = if settled { DofFrame::Settled { shot_asks: capture.depth_of_field } } else { DofFrame::Live };
        let blur_frame = if settled { MotionBlurFrame::Settled { shot_asks: capture.motion_blur } } else { MotionBlurFrame::Live };
        let dof = scene.and_then(|_| dof::frame_settings(&self.look.depth_of_field, &self.quality, path.hdr, proj, dof_frame));
        let blur = scene.and_then(|_| motion_blur::frame_settings(&self.look.motion_blur, &self.quality, path.hdr, motion, blur_frame));
        // Under TAA the first node writes the scene; every later one, and every node without TAA,
        // reads the scene and so writes its own output.
        let taa = path.taa && motion;
        let dof_own = !taa;
        let blur_own = !taa || dof.is_some();
        let render = self.targets.render_size;
        let lens = self.lens.get_mut();
        lens.frame = LensFrame { dof: dof.map(|settings| (settings, dof_own)), motion_blur: blur.map(|settings| (settings, blur_own)) };
        match dof {
            Some(settings) => {
                if lens.dof.is_none() {
                    lens.dof = Some(DofNode::new(&self.device)?);
                }
                if let Some(node) = lens.dof.as_mut() {
                    node.acquire(&self.device, &mut self.pool, render, settings.tier, scene.filter(|_| dof_own))?;
                }
            }
            None => {
                if let Some(node) = lens.dof.as_mut() {
                    node.release(&mut self.pool);
                }
            }
        }
        match blur {
            Some(settings) => {
                if lens.motion_blur.is_none() {
                    lens.motion_blur = Some(MotionBlurNode::new(&self.device)?);
                }
                if let Some(node) = lens.motion_blur.as_mut() {
                    node.acquire(&self.device, &mut self.pool, render, settings.tier, scene.filter(|_| blur_own))?;
                }
            }
            None => {
                if let Some(node) = lens.motion_blur.as_mut() {
                    node.release(&mut self.pool);
                }
            }
        }
        Ok(())
    }

    /// The bytes the look's lens takes from the target pool at this frame's render size (the
    /// [`crate::budget::DEPTH_OF_FIELD_LABEL`] and [`crate::budget::MOTION_BLUR_LABEL`] entries).
    pub(super) fn lens_bytes(&self) -> [u64; 2] {
        let lens = self.lens.borrow();
        let render = self.targets.render_size;
        let format = self.targets.scene_texture.as_ref().map(Texture::format);
        let dof = lens.frame.dof.map_or(0, |(settings, own)| dof::target_bytes(render, settings.tier, format.filter(|_| own)));
        let blur = lens.frame.motion_blur.map_or(0, |(settings, own)| motion_blur::target_bytes(render, settings.tier, format.filter(|_| own)));
        [dof, blur]
    }
}

/// Where a lens node reads the scene from and writes it to.
struct LensTargets {
    /// TAA's resolve (the node then writes the scene), or None (it reads the scene).
    from_taa: Option<TextureView>,
    scene: Texture,
    scene_view: TextureView,
    depth: TextureView,
    motion: Option<TextureView>,
}

impl WorldNodes<'_> {
    /// What a lens node reads and writes this frame (None: the frame holds no 1x scene or ran no
    /// prepass). Without TAA the scene is resolved first.
    fn lens_targets(&mut self, frame: &mut FrameEncoder) -> Option<LensTargets> {
        let renderer = self.renderer;
        let prepass = renderer.targets.prepass.as_ref()?;
        let from_taa = self.taa.as_ref().filter(|_| !self.taa_copied).map(|taa| taa.view.clone());
        if from_taa.is_none() {
            self.resolved_hdr_target(frame)?;
        }
        let scene = renderer.targets.scene_texture.clone()?;
        let scene_view = renderer.targets.scene_view.clone()?;
        let motion = prepass.motion.as_ref().map(|(_, view)| view.clone());
        Some(LensTargets { from_taa, scene, scene_view, depth: prepass.depth_view.clone(), motion })
    }

    /// After a lens node: TAA's resolve was written into the scene (the later nodes read it), or
    /// the node's own `output` is copied back into the scene.
    fn lens_written(&mut self, frame: &mut FrameEncoder, targets: &LensTargets, output: Option<&Texture>) {
        if targets.from_taa.is_some() {
            self.taa_copied = true;
            return;
        }
        if let Some(output) = output.filter(|output| output.size() == targets.scene.size() && output.format() == targets.scene.format()) {
            frame.encoder().copy_texture_to_texture(output.as_image_copy(), targets.scene.as_image_copy(), targets.scene.size());
        }
    }

    /// Graph node 17a: the look's depth of field.
    pub(super) fn encode_dof(&mut self, frame: &mut FrameEncoder) {
        let renderer = self.renderer;
        let Some((settings, _)) = renderer.lens.borrow().frame.dof else { return };
        let Some(targets) = self.lens_targets(frame) else { return };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let format: TextureFormat = targets.scene.format();
        let mut lens = renderer.lens.borrow_mut();
        let Some(node) = lens.dof.as_mut() else { return };
        let input = DofInput {
            scene: targets.from_taa.as_ref().unwrap_or(&targets.scene_view),
            depth: &targets.depth,
            depth_samples: 1,
            output: targets.from_taa.as_ref().map(|_| (&targets.scene_view, format)),
            render: renderer.targets.render_size,
            proj: frame_proj(&self.prep.plan, &self.prep.camera),
            frame: settings,
        };
        let passes = node.encode(&device, &queue, frame.encoder(), input, None);
        if passes == 0 {
            return;
        }
        let output = node.output_texture().cloned();
        drop(lens);
        self.lens_written(frame, &targets, output.as_ref());
        self.count_render(frame, passes);
    }

    /// Graph node 17b: the look's motion blur.
    pub(super) fn encode_motion_blur(&mut self, frame: &mut FrameEncoder) {
        let renderer = self.renderer;
        let Some((settings, _)) = renderer.lens.borrow().frame.motion_blur else { return };
        let Some(targets) = self.lens_targets(frame) else { return };
        let Some(motion) = targets.motion.clone() else { return };
        let (device, queue) = (frame.device().clone(), frame.queue().clone());
        let format: TextureFormat = targets.scene.format();
        let mut lens = renderer.lens.borrow_mut();
        let Some(node) = lens.motion_blur.as_mut() else { return };
        let input = MotionBlurInput {
            scene: targets.from_taa.as_ref().unwrap_or(&targets.scene_view),
            motion: &motion,
            depth: &targets.depth,
            depth_samples: 1,
            output: targets.from_taa.as_ref().map(|_| (&targets.scene_view, format)),
            render: renderer.targets.render_size,
            proj: frame_proj(&self.prep.plan, &self.prep.camera),
            frame: settings,
        };
        let passes = node.encode(&device, &queue, frame.encoder(), input, None);
        if passes == 0 {
            return;
        }
        let output = node.output_texture().cloned();
        drop(lens);
        self.lens_written(frame, &targets, output.as_ref());
        self.count_render(frame, passes);
    }
}
