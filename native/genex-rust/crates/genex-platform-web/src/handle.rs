//! The object-safe view of a game runtime a shell keeps: wasm-bindgen exports cannot be generic
//! over the game's world type, so the web shell holds a `Box<dyn GameHandle>`. It also draws the
//! game through genex's shared presenter ([`GameHandle::draw`]), which binds the game's custom GPU
//! passes to its simulation, as a native run does.

use genex::audio::{AudioLevel, Device};
use genex::gpu::PassStage;
use genex::present::{Drawn, Presenter};
use genex::{Camera, Frame, Input, Runtime, StepResult, UnknownName, Value, View};
use genex_core::saves::mirror;
use genex_render::RenderError;

/// What a shell drives a game through: the facade [`Runtime`] behind a trait object.
pub trait GameHandle {
    /// Rebuild the simulation on `seed`.
    fn seed(&mut self, seed: u32);
    /// Run `step_ticks(ms)` ticks, running or not.
    fn step(&mut self, ms: f64) -> StepResult;
    /// Live play: the ticks one rendered frame of `frame_ms` is worth (none while paused).
    fn advance_live(&mut self, frame_ms: f64) -> u32;
    /// Resume live play.
    fn start(&mut self) -> bool;
    /// Freeze live play.
    fn pause(&mut self) -> bool;
    /// Inject input for the next tick; answers the keys now held.
    fn inject(&mut self, input: Input) -> Vec<String>;
    /// The `state()` verb's answer; on the web it carries the saves mirror's account
    /// ([`crate::saves::with_saves`]).
    fn state(&self) -> Value;
    /// The non-volatile probe leaves, in registration order.
    fn probes(&self) -> Value;
    /// FNV-1a 64 (hex) of the seed, the tick and the non-volatile probes.
    fn checksum(&self) -> String;
    /// Ticks since the last seed.
    fn tick(&self) -> u64;
    /// The fixed world target size, in pixels.
    fn world_size(&self) -> [u32; 2];
    /// Demo names, in registration order.
    fn demos(&self) -> Vec<String>;
    /// Run a demo; the runtime is paused after it.
    fn demo(&mut self, name: &str) -> Result<Value, UnknownName>;
    /// The game's own view: its draws and the camera they are drawn from.
    fn frame(&mut self) -> (Frame, Camera);
    /// Named observer cameras, in registration order.
    fn cameras(&self) -> Vec<String>;
    /// Player eyes, in registration order.
    fn eyes(&self) -> Vec<String>;
    /// The draws and camera of a named camera or eye (None: the game's own view); None for a name
    /// the game does not have.
    fn view_frame(&mut self, view: Option<&str>) -> Option<(Frame, Camera)>;
    /// What the HUD paints over the next drawn frame, at `pixels_per_point` device pixels per
    /// world pixel (display only).
    fn hud_paint(&mut self, pixels_per_point: f32) -> genex_hud::HudPaint;
    /// Whether the HUD wants a soft keyboard (a text field has focus); a phone shell follows it.
    fn keyboard_wanted(&self) -> bool;
    /// Draw `view` (a camera or eye name; None for the game's own) through `presenter`: the game's
    /// custom passes inside the frame, the HUD over it, the triangles noted for `state()`. None for
    /// a view the game does not have.
    fn draw(&mut self, presenter: &mut Presenter, view: Option<&str>) -> Option<Result<Drawn, RenderError>>;
    /// Register the game's custom GPU passes on `presenter`'s device; answers the refused ones by
    /// name (a refused pass stays out of every frame).
    fn install_passes(&mut self, presenter: &mut Presenter) -> Vec<(String, RenderError)>;
    /// The custom GPU passes the game registered, `(name, stage)` in registration order.
    fn gpu_passes(&mut self) -> Vec<(String, PassStage)>;
    /// After a device loss: `presenter`'s device re-created through its opener, every upload
    /// replayed and the game's custom passes rebuilt on it; answers whether a new device is in use
    /// (false while the device is not lost).
    fn recover(&mut self, presenter: &mut Presenter) -> Result<bool, RenderError>;
    /// Start compiling the first Live frame's pipelines off the frame thread
    /// ([`Presenter::warm_boot`]): a phone shows its loading screen meanwhile (owner decision D11).
    fn warm_boot(&mut self, presenter: &mut Presenter);
    /// The game's title (`genex.toml`), which its loading screen names.
    fn title(&self) -> String;
    /// `audio({muted})` and a phone's audio gate: silence the device output; the mix, the meter
    /// and the simulation go on (AU-8).
    fn set_output_muted(&mut self, muted: bool);
    /// Whether the device output is muted.
    fn output_muted(&self) -> bool;
    /// `audioLevel`: the game's own mix, the last 2048 frames before the mute.
    fn audio_level(&self) -> AudioLevel;
    /// Open `device` on the game's audio queue (once: a run a person sees) and report it to
    /// `state().volatile.audio.device`; an open device's last fault is reported again each call.
    fn follow_device(&mut self, device: &mut Device);
}

/// The facade view a studio camera name resolves to: the game's own for None, a named camera, or
/// an eye; None for a name the game does not have.
fn resolve<'a, W>(runtime: &Runtime<W>, name: Option<&'a str>) -> Option<View<'a>> {
    let Some(name) = name else { return Some(View::Game) };
    if runtime.cameras().iter().any(|camera| camera == name) {
        return Some(View::Named(name));
    }
    runtime.eyes().iter().any(|eye| eye == name).then_some(View::Eye(name))
}

impl<W: Default + 'static> GameHandle for Runtime<W> {
    fn seed(&mut self, seed: u32) {
        Runtime::seed(self, seed);
    }

    fn step(&mut self, ms: f64) -> StepResult {
        Runtime::step(self, ms)
    }

    fn advance_live(&mut self, frame_ms: f64) -> u32 {
        Runtime::advance_live(self, frame_ms)
    }

    fn start(&mut self) -> bool {
        Runtime::start(self)
    }

    fn pause(&mut self) -> bool {
        Runtime::pause(self)
    }

    fn inject(&mut self, input: Input) -> Vec<String> {
        Runtime::inject(self, input)
    }

    fn state(&self) -> Value {
        let state = Runtime::state(self);
        if !self.saves().is_mirrored() {
            return state;
        }
        crate::saves::with_saves(state, &mirror::status())
    }

    fn probes(&self) -> Value {
        Value::Object(Runtime::probes(self))
    }

    fn checksum(&self) -> String {
        Runtime::checksum(self)
    }

    fn tick(&self) -> u64 {
        Runtime::tick(self)
    }

    fn world_size(&self) -> [u32; 2] {
        Runtime::world_size(self)
    }

    fn demos(&self) -> Vec<String> {
        Runtime::demos(self)
    }

    fn demo(&mut self, name: &str) -> Result<Value, UnknownName> {
        Runtime::demo(self, name)
    }

    fn frame(&mut self) -> (Frame, Camera) {
        // The game's own view always resolves (`Camera::DEFAULT` without a camera hook).
        let camera = self.camera(View::Game).unwrap_or_default();
        let frame = Runtime::frame(self, View::Game).unwrap_or_default();
        (frame, camera)
    }

    fn cameras(&self) -> Vec<String> {
        Runtime::cameras(self)
    }

    fn eyes(&self) -> Vec<String> {
        Runtime::eyes(self)
    }

    fn view_frame(&mut self, view: Option<&str>) -> Option<(Frame, Camera)> {
        let view = resolve(self, view)?;
        let camera = self.camera(view)?;
        Some((Runtime::frame(self, view)?, camera))
    }

    fn hud_paint(&mut self, pixels_per_point: f32) -> genex_hud::HudPaint {
        Runtime::hud_paint(self, pixels_per_point)
    }

    fn keyboard_wanted(&self) -> bool {
        Runtime::keyboard_wanted(self)
    }

    fn draw(&mut self, presenter: &mut Presenter, view: Option<&str>) -> Option<Result<Drawn, RenderError>> {
        let view = resolve(self, view)?;
        presenter.draw_view(self, view)
    }

    fn install_passes(&mut self, presenter: &mut Presenter) -> Vec<(String, RenderError)> {
        presenter.install_for(self)
    }

    fn gpu_passes(&mut self) -> Vec<(String, PassStage)> {
        Runtime::gpu_passes(self)
    }

    fn recover(&mut self, presenter: &mut Presenter) -> Result<bool, RenderError> {
        presenter.recover_for(self)
    }

    fn warm_boot(&mut self, presenter: &mut Presenter) {
        presenter.warm_boot(self);
    }

    fn title(&self) -> String {
        Runtime::title(self).to_owned()
    }

    fn set_output_muted(&mut self, muted: bool) {
        Runtime::set_output_muted(self, muted);
    }

    fn output_muted(&self) -> bool {
        Runtime::output_muted(self)
    }

    fn audio_level(&self) -> AudioLevel {
        Runtime::audio_level(self)
    }

    fn follow_device(&mut self, device: &mut Device) {
        if device.tried() {
            self.note_audio_device(device.is_open(), device.fault());
            return;
        }
        device.open_for(self);
    }
}
