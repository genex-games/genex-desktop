//! The HUD a runtime owns: one egui context stepped by the simulation, the legacy HUD, and what
//! the display paints from them.

use crate::input::{HudInput, raw_input};
use crate::legacy::{self, Color, Legacy};
use crate::record::{self, HudWidget};
use egui::epaint::textures::TexturesDelta;
use egui::epaint::{ClippedPrimitive, ClippedShape, Shape};
use std::num::NonZeroUsize;

/// The most entries `state().hud.items` lists: legacy items first, then egui widgets.
pub const MAX_HUD_ITEMS: usize = legacy::MAX_ITEMS;
/// How many characters of a text, bar id or widget label name it in `state().hud.items`.
pub const MAX_ITEM_NAME: usize = legacy::MAX_NAME;
/// egui runs a UI once per tick: a second "sizing" pass would run the game's UI hooks twice.
const PASSES_PER_TICK: NonZeroUsize = NonZeroUsize::MIN;

/// `state().hud`: what the last drawn frame and the last tick showed.
#[derive(Clone, Debug, PartialEq)]
pub struct HudSummary {
    /// Legacy text and bar names, then egui widget labels, in drawing order.
    pub items: Vec<String>,
    /// Whether the legacy crosshair is on.
    pub crosshair: bool,
    /// The legacy flash's alpha after the last drawn frame.
    pub flash: f32,
}

/// What a display paints for the HUD: egui-wgpu input over the world target. Take the texture
/// deltas out with `std::mem::take` before applying them; what is left is dropped silently.
#[derive(Debug, Default)]
pub struct HudPaint {
    /// Triangles and callbacks, legacy HUD first, egui widgets over it.
    pub primitives: Vec<ClippedPrimitive>,
    /// Texture changes since the last paint (the font atlas first); apply before drawing.
    pub textures_delta: TexturesDelta,
    /// Device pixels per world pixel the primitives were tessellated for.
    pub pixels_per_point: f32,
}

/// The HUD of one running game.
pub struct Hud {
    ctx: egui::Context,
    passes: u64,
    widgets: Vec<HudWidget>,
    shapes: Vec<ClippedShape>,
    textures: TexturesDelta,
    legacy: Legacy,
    world_size: [u32; 2],
}

impl Default for Hud {
    fn default() -> Hud {
        Hud::new()
    }
}

fn fresh_context() -> egui::Context {
    let ctx = egui::Context::default();
    ctx.options_mut(|options| options.max_passes = PASSES_PER_TICK);
    // The AccessKit tree is how widgets are recorded into hud.items.
    ctx.enable_accesskit();
    ctx
}

impl Hud {
    /// A HUD with fresh egui memory.
    pub fn new() -> Hud {
        Hud {
            ctx: fresh_context(),
            passes: 0,
            widgets: Vec::new(),
            shapes: Vec::new(),
            textures: TexturesDelta::default(),
            legacy: Legacy::default(),
            world_size: [1, 1],
        }
    }

    /// `seed`: forget egui's memory (focus, open headers, scroll, animations) and the legacy HUD.
    /// Texture frees for the old context's images are kept for the next paint.
    pub fn reset(&mut self) {
        if self.passes > 0 {
            // The fresh context uploads its own font atlas under the same id on its first pass.
            self.textures.set.clear();
        }
        self.ctx = fresh_context();
        self.passes = 0;
        self.widgets.clear();
        self.shapes.clear();
        self.legacy = Legacy::default();
    }

    /// One tick's UI: build egui's input from the tick's merged input and `seconds` of simulated
    /// time, run `ui` exactly once, and keep what it drew for [`Hud::widgets`] and [`Hud::paint`].
    pub fn run(&mut self, world_size: [u32; 2], seconds: f64, input: &HudInput, mut ui: impl FnMut(&mut egui::Ui)) {
        let output = self.ctx.run_ui(raw_input(world_size, seconds, input), |root| ui(root));
        self.passes += 1;
        self.world_size = world_size;
        self.widgets = record::widgets(output.platform_output.accesskit_update.as_ref(), MAX_HUD_ITEMS);
        self.shapes = output.shapes;
        self.textures.append(output.textures_delta);
    }

    /// The widgets the last tick drew, in drawing order.
    pub fn widgets(&self) -> &[HudWidget] {
        &self.widgets
    }

    /// The egui context, for the runtime's own reads (never for running a pass outside a tick).
    pub fn context(&self) -> &egui::Context {
        &self.ctx
    }

    /// Legacy: text at world pixel `(x, y)`, `size` pixels high.
    pub fn text(&mut self, text: &str, x: i32, y: i32, size: i32, color: Color) {
        self.legacy.text(text, [x, y], size, color);
    }

    /// Legacy: a bar named `id`, `fraction` full.
    #[allow(clippy::too_many_arguments)]
    pub fn bar(&mut self, id: &str, fraction: f32, x: i32, y: i32, width: i32, height: i32, color: Color) {
        self.legacy.bar(id, fraction, [x, y, width, height], color);
    }

    /// Legacy: a centred crosshair until turned off.
    pub fn crosshair(&mut self, visible: bool, size: i32, color: Color) {
        self.legacy.crosshair(visible, size, color);
    }

    /// Legacy: a full-frame flash that fades over the drawn frames.
    pub fn flash(&mut self, color: Color, alpha: f32) {
        self.legacy.flash(color, alpha);
    }

    /// A frame was drawn over a world of `world_size`: the legacy queue becomes what it showed.
    pub fn end_frame(&mut self, world_size: [u32; 2]) {
        self.world_size = world_size;
        self.legacy.end_frame();
    }

    /// `state().hud`.
    pub fn summary(&self) -> HudSummary {
        let legacy = self.legacy.names().map(str::to_owned);
        let widgets = self.widgets.iter().map(|w| w.label.chars().take(MAX_ITEM_NAME).collect());
        HudSummary {
            items: legacy.chain(widgets).take(MAX_HUD_ITEMS).collect(),
            crosshair: self.legacy.crosshair_visible(),
            flash: self.legacy.flash_alpha(),
        }
    }

    /// Tessellate the last drawn frame's legacy HUD and the last tick's widgets for a display at
    /// `pixels_per_point` device pixels per world pixel. Display only: a later tick sees nothing
    /// of it. Glyphs only legacy text uses reach the atlas with the next tick's texture delta.
    pub fn paint(&mut self, pixels_per_point: f32) -> HudPaint {
        let textures_delta = std::mem::take(&mut self.textures);
        if self.passes == 0 {
            // egui has no fonts before its first pass.
            return HudPaint { primitives: Vec::new(), textures_delta, pixels_per_point };
        }
        let world = egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(self.world_size[0] as f32, self.world_size[1] as f32),
        );
        let legacy = self.ctx.fonts_mut(|fonts| {
            self.legacy.shapes(self.world_size, |text, size, color| {
                Shape::text(&mut *fonts, egui::Pos2::ZERO, egui::Align2::LEFT_TOP, text, egui::FontId::proportional(size), color)
            })
        });
        let mut shapes: Vec<ClippedShape> = legacy.into_iter().map(|shape| ClippedShape { clip_rect: world, shape }).collect();
        shapes.extend(self.shapes.iter().cloned());
        HudPaint { primitives: self.ctx.tessellate(shapes, pixels_per_point), textures_delta, pixels_per_point }
    }
}

impl Drop for Hud {
    fn drop(&mut self) {
        // Deltas nobody painted (a headless run) are dropped on purpose.
        self.textures.clear();
    }
}

impl Drop for HudPaint {
    fn drop(&mut self) {
        // A display takes the deltas it applies (`std::mem::take`); the rest are dropped on purpose.
        self.textures_delta.clear();
    }
}

impl std::fmt::Debug for Hud {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hud").field("passes", &self.passes).field("widgets", &self.widgets).finish_non_exhaustive()
    }
}
