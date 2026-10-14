//! Renderers warmed off the frame thread (pass-1 gate: a native game in Studio was killed leaving
//! the Medium preset). A settings change that needs pipelines the renderer in use has not compiled
//! (another anti-aliasing build, or new features) used to compile them on the frame thread, every
//! one cold inside the game box: 4-8 s under load, past the host's 5 s heartbeat. With
//! [`super::Presenter::set_off_thread_changes`] the presenter instead keeps drawing the frame's last
//! Live settings and hands another thread what a renderer for the new ones needs: it builds that
//! renderer (or takes the spare built for the same samples), draws one frame with the new choice,
//! which compiles every pipeline the frame uses, and hands it back for the presenter to swap in.
//! The same thread warms a capture's pinned profile as the spare renderer, so a capture after Live
//! left the pinned samples swaps instead of compiling.
//!
//! The warm frame is the frame Live drew when the change was seen, without the HUD or the game's
//! own passes (those are the game's objects; they rebuild on the frame thread, as after any
//! pipeline change): timed as a Live frame for Live, settled and read back as a capture for the
//! spare. It is lit as that frame was ([`WarmLight`]: the environment the renderer in use holds,
//! an HDR map's texels uploaded with it), so the sky's, the environment bake's and the fog's
//! pipelines compile and the bake is made here too (pass-1 fix: a renderer warmed under the flat
//! colour compiled them on the frame thread at its first frame under the sky).

use std::sync::Arc;
use std::thread::JoinHandle;

use genex_render::device_class::DeviceClass;
use genex_render::device_loss::{Prepared, RendererPlan};
use genex_render::hdri::PreparedMap;
use genex_render::settings::Environment;
use genex_render::presets::with_world_samples;
use genex_render::renderer::landed_samples;
use genex_render::{CullPath, Gpu, ImmediateFrame, MSAA_SAMPLES, RenderError, RenderOptions};

use super::{Presenter, set_choice};
use crate::render::{FrameChoice, RenderHandle};
use crate::runtime::{Runtime, View};

/// What a warmed renderer is for once it is back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WarmFor {
    /// Live's frames from the settings generation it was started at.
    Live { generation: u64 },
    /// The spare kept for a capture's pinned profile.
    Spare,
}

/// Where the warmed renderer comes from (boxed: it moves to the warm-up thread whole).
pub(super) enum WarmSource {
    /// A new renderer built from the plan.
    Plan(Box<RendererPlan>),
    /// The spare, which already holds pipelines for its samples.
    Spare(Box<Prepared>),
}

/// What the warm frame is lit with: the environment the renderer in use holds, and an HDR map's
/// prepared texels when it is one (uploaded to the warmed renderer first; a refusal there lights
/// the frame with the flat colour, as `Presenter::light` does).
pub(super) struct WarmLight {
    pub(super) environment: Environment,
    pub(super) map: Option<Arc<PreparedMap>>,
}

impl WarmLight {
    /// Hand `renderer` the environment, its map first.
    fn apply(&self, renderer: &mut genex_render::Renderer, gpu: &Gpu) {
        let refused = self.map.as_deref().is_some_and(|map| renderer.set_prepared_environment_map(gpu, map).is_err());
        let environment = if refused { Environment::Color } else { self.environment.clone() };
        if *renderer.environment() != environment {
            renderer.set_environment(&environment);
        }
    }
}

/// A renderer being warmed on its thread.
pub(super) struct Warming {
    pub(super) purpose: WarmFor,
    thread: JoinHandle<Result<Prepared, RenderError>>,
}

impl Warming {
    /// Whether the thread is done (never waits).
    pub(super) fn is_finished(&self) -> bool {
        self.thread.is_finished()
    }

    /// The warmed renderer, waiting for the thread; a refusal or a panic there is an error (the
    /// panic's message has gone to the panic hook already).
    pub(super) fn join(self) -> Result<Prepared, String> {
        match self.thread.join() {
            Ok(Ok(prepared)) => Ok(prepared),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err("the warm-up thread panicked".to_owned()),
        }
    }
}

/// The frame a warm-up draws: the Live frame kept for it, and how it is lit.
pub(super) struct WarmFrame {
    pub(super) frame: ImmediateFrame,
    pub(super) light: WarmLight,
}

/// Start warming a renderer from `source` on `gpu` with `warm` drawn at `choice` as `class`.
/// None when no thread could start (the caller then changes settings on the frame thread).
pub(super) fn start(purpose: WarmFor, source: WarmSource, gpu: Gpu, choice: FrameChoice, class: DeviceClass, warm: WarmFrame) -> Option<Warming> {
    let WarmFrame { frame, light } = warm;
    let warm = move || {
        let mut prepared = match source {
            WarmSource::Plan(plan) => plan.build()?,
            WarmSource::Spare(spare) => *spare,
        };
        let renderer = prepared.renderer_mut();
        light.apply(renderer.renderer_mut(), &gpu);
        set_choice(renderer.renderer_mut(), &choice, class);
        if purpose == WarmFor::Spare {
            // Drawn as a capture is: settled on the capture's history, then read back.
            let frames = renderer.settle_frames_graded(false);
            renderer.render_settled(&gpu, &frame, CullPath::Gpu, None, frames)?;
            renderer.capture(&gpu)?;
            return Ok(prepared);
        }
        // Timed as a Live frame is, so the frame timer's pipelines are among those compiled here.
        let _landed = renderer.renderer_mut().arm_frame_timer(&gpu.queue);
        let drawn = renderer.render(&gpu, &frame, CullPath::Gpu, None);
        renderer.renderer_mut().finish_frame_timer();
        drawn?;
        Ok(prepared)
    };
    let thread = std::thread::Builder::new().name("genex-warm".to_owned()).spawn(warm).ok()?;
    Some(Warming { purpose, thread })
}

/// The renderer options a world pass of `samples` per pixel is built with.
fn options_for(samples: u32) -> RenderOptions {
    RenderOptions { msaa: samples > 1 }
}

/// The presenter's warm-ups (see the module docs).
impl Presenter {
    pub(super) fn start_boot_warm<W: Default + 'static>(&mut self, runtime: &mut Runtime<W>) {
        if !self.off_thread || self.warming.is_some() || self.held.is_some() {
            return;
        }
        let (Some(camera), Some(frame)) = (runtime.camera(View::Game), runtime.frame(View::Game)) else { return };
        let handle = self.attach(runtime);
        // The frame's models, extensions and environment on the device, as its first draw would.
        if self.admit(&frame).and_then(|()| self.load(&frame)).and_then(|()| self.light(&frame)).is_err() {
            return;
        }
        let (immediate, _) = self.immediate(&frame, &camera);
        let warm = WarmFrame { frame: immediate, light: self.warm_light() };
        let (choice, class, samples) = self.live_wanted(&handle);
        let plan = self.resilient.plan(options_for(samples));
        let generation = handle.borrow().pipeline_generation();
        let gpu = self.resilient.gpu().share();
        self.warming = start(WarmFor::Live { generation }, WarmSource::Plan(Box::new(plan)), gpu, choice, class, warm);
    }

    /// What a Live frame of `handle`'s current settings draws: its choice on the samples its
    /// anti-aliasing lands on, and its class.
    fn live_wanted(&self, handle: &RenderHandle) -> (FrameChoice, DeviceClass, u32) {
        let class = handle.borrow().live_class();
        let asked = self.on_scene(handle.borrow().live_asked(), class);
        let samples = landed_samples(asked.quality.anti_aliasing);
        (FrameChoice { quality: with_world_samples(&asked.quality, samples, class), ..asked }, class, samples)
    }

    /// What a capture draws now: its pinned choice on its own samples, and its class.
    fn capture_wanted(&self, handle: &RenderHandle) -> (FrameChoice, DeviceClass, u32) {
        let class = handle.borrow().capture_class();
        let asked = self.on_scene(handle.borrow().capture_frame().0, class);
        let samples = landed_samples(asked.quality.anti_aliasing);
        (FrameChoice { quality: with_world_samples(&asked.quality, samples, class), ..asked }, class, samples)
    }

    /// Whether a capture's pinned samples have a renderer neither in use nor kept as a spare that
    /// drew a settled capture already (one that never did is warmed as a capture).
    fn capture_needs_spare(&self, handle: &RenderHandle) -> bool {
        let options = options_for(self.capture_wanted(handle).2);
        let spare_ready = self.resilient.spare().is_some_and(|(spare, renderer)| spare == options && renderer.settled_captures() > 0);
        options != self.resilient.options() && !spare_ready
    }

    /// Whether a renderer is warmed after this Live frame (`holding`: Live kept its drawn settings
    /// for a change): the frame is then kept for the warm-up.
    pub(super) fn wants_warm(&self, handle: &RenderHandle, holding: bool) -> bool {
        let unchecked = self.spare_checked != Some(handle.borrow().pipeline_generation());
        self.off_thread && self.warming.is_none() && (holding || (unchecked && self.capture_needs_spare(handle)))
    }

    /// How the frame just drawn was lit: the environment the renderer in use holds (handed over
    /// by `Presenter::light` this frame), with an HDR map's prepared texels.
    fn warm_light(&self) -> WarmLight {
        let environment = self.resilient.renderer().renderer().environment().clone();
        let map = match &environment {
            Environment::Hdri(hdri) => self.assets.shared_environment_map(&hdri.path),
            _ => None,
        };
        WarmLight { environment, map }
    }

    pub(super) fn start_warm(&mut self, handle: &RenderHandle, holding: bool) {
        let Some(frame) = self.warm_frame.take() else { return };
        if !self.off_thread || self.warming.is_some() {
            return;
        }
        let frame = WarmFrame { frame, light: self.warm_light() };
        let gpu = self.resilient.gpu().share();
        if holding {
            let (choice, class, samples) = self.live_wanted(handle);
            let options = options_for(samples);
            let source = match self.resilient.take_spare(options) {
                Ok(Some(spare)) => WarmSource::Spare(Box::new(spare)),
                _ => WarmSource::Plan(Box::new(self.resilient.plan(options))),
            };
            let generation = handle.borrow().pipeline_generation();
            self.warming = start(WarmFor::Live { generation }, source, gpu, choice, class, frame);
            if self.warming.is_none() {
                // No thread: the change is drawn on the frame thread, as without warm-ups.
                self.held = None;
            }
            return;
        }
        let generation = handle.borrow().pipeline_generation();
        if self.spare_checked == Some(generation) {
            return;
        }
        self.spare_checked = Some(generation);
        if self.capture_needs_spare(handle) {
            let (choice, class, samples) = self.capture_wanted(handle);
            let options = options_for(samples);
            let source = match self.resilient.take_spare(options) {
                Ok(Some(spare)) => WarmSource::Spare(Box::new(spare)),
                _ => WarmSource::Plan(Box::new(self.resilient.plan(options))),
            };
            self.warming = start(WarmFor::Spare, source, gpu, choice, class, frame);
        }
    }

    /// A renderer whose warm-up finished (or Live's, waited for when `wait_for_live`): Live's
    /// swapped in when its settings are still the ones asked (Live then draws them), else kept as
    /// the spare for its samples. A warm-up that failed leaves the change to the frame thread,
    /// which meets the same refusal and reports it.
    pub(super) fn take_warmed(&mut self, handle: &RenderHandle, wait_for_live: bool) {
        let ready = |warming: &mut Warming| warming.is_finished() || (wait_for_live && matches!(warming.purpose, WarmFor::Live { .. }));
        let Some(warming) = self.warming.take_if(ready) else { return };
        let purpose = warming.purpose;
        let prepared = match warming.join() {
            Ok(prepared) => prepared,
            Err(why) => {
                (self.log)(&format!("settings warm-up refused: {why}"));
                if matches!(purpose, WarmFor::Live { .. }) {
                    self.held = None;
                }
                return;
            }
        };
        let generation = handle.borrow().pipeline_generation();
        if purpose != (WarmFor::Live { generation }) {
            self.resilient.keep_as_spare(prepared);
            return;
        }
        let samples = if prepared.options().msaa { MSAA_SAMPLES } else { 1 };
        match self.resilient.adopt(prepared) {
            Ok(true) => {
                self.live_samples = Some((samples, generation));
                self.held = None;
            }
            Ok(false) => {}
            Err(error) => (self.log)(&format!("warmed renderer refused: {error}")),
        }
    }
}
