//! The builder a game's `main` fills: title, sizes and hooks. Facets add their own hooks through
//! `<slug>::wire(&mut game)` from the entry file's `// FACET WIRING` block.

use crate::camera::Camera;
use crate::ctx::Ctx;
use crate::frame::{Color, Frame};
use crate::gfx::Gfx;
use crate::rng::Pcg32;
use crate::runtime::DemoDriver;
use crate::sim::{FacetRegistration, Sim};
use serde_json::Value;

pub(crate) type ResetHook<W> = Box<dyn Fn(&mut Sim<W>, u32, &mut Pcg32, &Gfx)>;
pub(crate) type UpdateHook<W> = Box<dyn Fn(&mut Sim<W>, &Ctx<'_>)>;
pub(crate) type UiHook<W> = Box<dyn Fn(&mut Sim<W>, &mut egui::Ui, &Ctx<'_>)>;
pub(crate) type DrawHook<W> = Box<dyn Fn(&Sim<W>, &mut Frame, &Camera)>;
pub(crate) type CameraHook<W> = Box<dyn Fn(&Sim<W>) -> Camera>;
pub(crate) type ValueHook<W> = Box<dyn Fn(&Sim<W>) -> Value>;
pub(crate) type DemoHook<W> = Box<dyn Fn(&mut DemoDriver<'_, W>) -> Value>;

/// A single-valued registration (`camera`, `player`) and whether it may replace an earlier one.
pub(crate) struct Single<F> {
    pub hook: F,
    pub overrides: bool,
}

/// A named registration (named cameras, eyes, demos).
pub(crate) struct Named<F> {
    pub name: String,
    pub hook: F,
}

/// A probe: a named leaf of `state()`; volatile ones stay out of the checksum.
pub(crate) struct Probe<W> {
    pub name: String,
    pub volatile: bool,
    pub hook: ValueHook<W>,
}

/// Everything a game hands the runtime. Build it with [`Game::new`], register hooks, and pass it
/// to [`crate::install`].
pub struct Game<W> {
    pub(crate) initial: W,
    pub(crate) title: String,
    pub(crate) world_size: [u32; 2],
    pub(crate) background: Color,
    pub(crate) save_name: Option<String>,
    pub(crate) resets: Vec<ResetHook<W>>,
    pub(crate) updates: Vec<UpdateHook<W>>,
    pub(crate) uis: Vec<UiHook<W>>,
    pub(crate) draws: Vec<DrawHook<W>>,
    pub(crate) cameras: Vec<Single<CameraHook<W>>>,
    pub(crate) players: Vec<Single<ValueHook<W>>>,
    pub(crate) named_cameras: Vec<Named<CameraHook<W>>>,
    pub(crate) eyes: Vec<Named<CameraHook<W>>>,
    pub(crate) probes: Vec<Probe<W>>,
    pub(crate) demos: Vec<Named<DemoHook<W>>>,
    pub(crate) facets: Vec<FacetRegistration>,
    /// Custom GPU passes (`game.gpu_pass`, extension ladder level 3, M2.19).
    pub(crate) gpu_passes: Vec<crate::gpu::GpuPassEntry<W>>,
    /// The game's render look and quality (`game.render_settings`, the `[render]` layer).
    pub(crate) render: crate::render::RenderConfig,
    /// Where its Level-2 `[[wgsl]]` sources come from (`game.wgsl`, extension ladder level 2).
    pub(crate) wgsl: crate::extend::WgslSetup,
    /// Play-time AI, when the game uses it (`game.ai`).
    pub(crate) ai: Option<genex_ai::AiOptions>,
}

/// The handle `game.camera(..)` returns; `.camera_override()` lets this camera replace an
/// earlier one instead of failing `install`.
pub struct CameraRegistration<'a, W> {
    game: &'a mut Game<W>,
}

impl<W> CameraRegistration<'_, W> {
    /// This camera intentionally replaces the one registered before it.
    pub fn camera_override(self) {
        if let Some(last) = self.game.cameras.last_mut() {
            last.overrides = true;
        }
    }
}

/// The handle `game.player(..)` returns; `.player_override()` lets this hook replace an earlier
/// one instead of failing `install`.
pub struct PlayerRegistration<'a, W> {
    game: &'a mut Game<W>,
}

impl<W> PlayerRegistration<'_, W> {
    /// This player hook intentionally replaces the one registered before it.
    pub fn player_override(self) {
        if let Some(last) = self.game.players.last_mut() {
            last.overrides = true;
        }
    }
}

impl<W: Default + 'static> Game<W> {
    /// A game over `world` (the world before the first seed; every seed rebuilds `W::default()`).
    pub fn new(world: W) -> Game<W> {
        Game {
            initial: world,
            title: "Genex game".to_owned(),
            world_size: [960, 540],
            background: Color::BACKGROUND,
            save_name: None,
            resets: Vec::new(),
            updates: Vec::new(),
            uis: Vec::new(),
            draws: Vec::new(),
            cameras: Vec::new(),
            players: Vec::new(),
            named_cameras: Vec::new(),
            eyes: Vec::new(),
            probes: Vec::new(),
            demos: Vec::new(),
            facets: Vec::new(),
            gpu_passes: Vec::new(),
            render: crate::render::RenderConfig::from_build(),
            wgsl: crate::extend::WgslSetup::default(),
            ai: None,
        }
    }

    /// The name a destination keeps this game's saves under: its `save_name`, else its title
    /// (the web shell's IndexedDB database is `genex-saves:<this>`).
    pub fn saves_name(&self) -> &str {
        self.save_name.as_deref().unwrap_or(&self.title)
    }

    /// The window and export title.
    pub fn title(mut self, title: &str) -> Game<W> {
        title.clone_into(&mut self.title);
        self
    }

    /// The fixed world target size in pixels; the window letterboxes it.
    pub fn world_size(mut self, width: u32, height: u32) -> Game<W> {
        self.world_size = [width, height];
        self
    }

    /// The colour the world target clears to.
    pub fn background(mut self, color: Color) -> Game<W> {
        self.background = color;
        self
    }

    /// The folder saves go under (letters, digits, space, `_`, `-`, `.`); by default the name the
    /// studio's build gives the game.
    pub fn save_name(mut self, name: &str) -> Game<W> {
        self.save_name = Some(name.to_owned());
        self
    }

    /// Rebuild state after a seed: runs in registration order on a fresh `Sim`, with `rng`
    /// seeded from `seed`.
    pub fn on_reset<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, u32, &mut Pcg32, &Gfx) + 'static,
    {
        self.resets.push(Box::new(hook));
        self
    }

    /// One fixed tick, in registration order; physics steps once after every update hook.
    pub fn on_update<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, &Ctx<'_>) + 'static,
    {
        self.updates.push(Box::new(hook));
        self
    }

    /// egui widgets, run inside the tick from the merged input and the simulated clock.
    pub fn on_ui<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&mut Sim<W>, &mut egui::Ui, &Ctx<'_>) + 'static,
    {
        self.uis.push(Box::new(hook));
        self
    }

    /// Draw the world (read-only) from `camera`.
    pub fn on_draw<F>(&mut self, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>, &mut Frame, &Camera) + 'static,
    {
        self.draws.push(Box::new(hook));
        self
    }

    /// The game's own view. Single-valued: a second one needs `.camera_override()`.
    pub fn camera<F>(&mut self, hook: F) -> CameraRegistration<'_, W>
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.cameras.push(Single { hook: Box::new(hook), overrides: false });
        CameraRegistration { game: self }
    }

    /// A named observer camera: it moves the view, never the simulation.
    pub fn named_camera<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.named_cameras.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// A player-eye camera ("eye:spawn"): where the player would look from.
    pub fn eye<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Camera + 'static,
    {
        self.eyes.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// Where the player is (`{x, y, z, yaw?}`), or `null`. Single-valued: a second one needs
    /// `.player_override()`.
    pub fn player<F>(&mut self, hook: F) -> PlayerRegistration<'_, W>
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.players.push(Single { hook: Box::new(hook), overrides: false });
        PlayerRegistration { game: self }
    }

    /// A probe leaf `state().<name>` that checks read; part of the checksum.
    pub fn probe<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.probes.push(Probe { name: name.to_owned(), volatile: false, hook: Box::new(hook) });
        self
    }

    /// A probe reported under `state().volatile.<name>` and left out of the checksum.
    pub fn probe_volatile<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&Sim<W>) -> Value + 'static,
    {
        self.probes.push(Probe { name: name.to_owned(), volatile: true, hook: Box::new(hook) });
        self
    }

    /// A scripted drive a generic walk cannot reach. It may inject input, advance time and
    /// request captures through its driver; the runtime pauses after it.
    pub fn demo<F>(&mut self, name: &str, hook: F) -> &mut Self
    where
        F: Fn(&mut DemoDriver<'_, W>) -> Value + 'static,
    {
        self.demos.push(Named { name: name.to_owned(), hook: Box::new(hook) });
        self
    }

    /// The game uses play-time AI (`ctx.ai`): the studio's `ready` declares `capabilities.ai`,
    /// and a studio that takes it answers the game's calls (a build without one plays every
    /// call's fallback). `options` say whether the game needs AI to mean anything and which call
    /// sites it uses.
    pub fn ai(&mut self, options: genex_ai::AiOptions) -> &mut Self {
        self.ai = Some(options);
        self
    }

    /// Register a facet's private state type; `sim.facets.get::<T>()` reads it and every seed
    /// rebuilds it from `T::default()`.
    pub fn facet_state<T: Default + 'static>(&mut self) -> &mut Self {
        self.facets.push(FacetRegistration::of::<T>());
        self
    }
}
