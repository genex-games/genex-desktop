//! The courtyard: a player walking a 9 by 9 grid of tiles, coins that respawn from the tick rng, a
//! bag that fills with loot every third coin, and health that drains while you play. Everything
//! the game plays with is in [`World`] and saved whole (`game.save_world`); which screen is open is
//! display state, skipped by serde, so a load always lands in play.

use genex::prelude::*;
use serde::{Deserialize, Serialize};

/// Tiles from the centre to an edge of the courtyard.
pub const ARENA_HALF: i32 = 4;
/// Coins lying in the courtyard at once.
pub const COINS: usize = 5;
/// Cells in the bag (a 4 by 3 grid).
pub const BAG_SLOTS: usize = 12;
/// The named save slots the slot lists offer.
pub const SLOT_NAMES: [&str; 3] = ["slot-1", "slot-2", "slot-3"];
/// Full health.
pub const HEALTH_MAX: u32 = 100;
/// Ticks of play per point of health lost.
const DRAIN_TICKS: u64 = 90;
/// Health a potion gives back.
const POTION_HEALTH: u32 = 30;
/// Coins collected per piece of loot.
const COINS_PER_LOOT: u32 = 3;
/// Standard-mapping pad buttons the game reads itself (the menus read theirs through the kit).
const PAD_START: usize = 9;
const PAD_UP: usize = 12;
const PAD_DOWN: usize = 13;
const PAD_LEFT: usize = 14;
const PAD_RIGHT: usize = 15;

const GROUND: Color = Color::rgb(52, 70, 60);
const TILE_LINE: Color = Color::rgb(70, 92, 78);
const WALL: Color = Color::rgb(120, 112, 100);
const COIN: Color = Color::rgb(240, 196, 60);
const PLAYER: Color = Color::rgb(90, 160, 230);
const PLAYER_ARMED: Color = Color::rgb(220, 120, 80);
/// The camera on a landscape screen, and on a portrait one (higher and further back, so the
/// whole courtyard fits the narrow view).
const CAMERA_EYE: [f32; 3] = [0.0, 9.5, 8.5];
const CAMERA_EYE_PORTRAIT: [f32; 3] = [0.0, 24.0, 19.0];

/// What can sit in a bag cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Item {
    /// Nothing in the cell.
    #[default]
    Empty,
    /// Gives back health and is used up.
    Potion,
    /// Equips.
    Sword,
    /// Equips.
    Shield,
    /// Equips.
    Key,
    /// Equips.
    Map,
    /// Equips.
    Gem,
}

/// The loot table a third coin draws from.
const LOOT: [Item; 6] = [Item::Potion, Item::Potion, Item::Sword, Item::Shield, Item::Key, Item::Gem];

impl Item {
    /// The item's text key (`item-potion`).
    pub const fn text_key(self) -> &'static str {
        match self {
            Item::Empty => "item-empty",
            Item::Potion => "item-potion",
            Item::Sword => "item-sword",
            Item::Shield => "item-shield",
            Item::Key => "item-key",
            Item::Map => "item-map",
            Item::Gem => "item-gem",
        }
    }

    /// Whether activating the item equips it (a potion is used up instead).
    pub const fn equips(self) -> bool {
        matches!(self, Item::Sword | Item::Shield | Item::Key | Item::Map | Item::Gem)
    }
}

/// Which screen is open: display state, never saved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Screen {
    /// The title menu (after a reset, or quitting to it).
    Title,
    /// Play with the HUD (where a load lands).
    #[default]
    Playing,
    /// The pause menu.
    Pause,
    /// The settings menu.
    Settings {
        /// Opened from the title (else from the pause menu).
        from_title: bool,
    },
    /// The inventory grid.
    Inventory,
    /// A slot list.
    Slots {
        /// Saving into a slot (else loading one).
        saving: bool,
        /// Opened from the title (else from the pause menu).
        from_title: bool,
    },
}

impl Screen {
    /// The screen's wire name in the `menus` probe.
    pub const fn wire(self) -> &'static str {
        match self {
            Screen::Title => "title",
            Screen::Playing => "playing",
            Screen::Pause => "pause",
            Screen::Settings { .. } => "settings",
            Screen::Inventory => "inventory",
            Screen::Slots { saving: true, .. } => "save-slots",
            Screen::Slots { saving: false, .. } => "load-slots",
        }
    }
}

/// The courtyard and its menus.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct World {
    /// The player's tile, `[x, z]` from the centre.
    pub player: [i32; 2],
    /// Coins lying in the courtyard.
    pub coins_at: Vec<[i32; 2]>,
    /// Coins collected.
    pub coins: u32,
    /// Health, 0 to [`HEALTH_MAX`].
    pub hp: u32,
    /// The bag's cells, left to right and top to bottom.
    pub bag: [Item; BAG_SLOTS],
    /// The equipped bag cell.
    pub equipped: Option<usize>,
    /// Ticks spent playing (not in menus).
    pub played: u64,
    /// The open screen.
    #[serde(skip)]
    pub screen: Screen,
    /// The tick the open screen opened on: a menu ignores the press that opened it.
    #[serde(skip)]
    pub since: u64,
    /// A slot waiting for the overwrite dialog's answer.
    #[serde(skip)]
    pub confirm: Option<String>,
    /// The quit-to-title dialog is open.
    #[serde(skip)]
    pub quitting: bool,
    /// The settings tab drawn on the last pass (its wire name).
    #[serde(skip)]
    pub tab: Option<&'static str>,
    /// The item found on the last coin, for its toast.
    #[serde(skip)]
    pub found: Option<Item>,
    /// Painted labels wider than their cell or row on the last pass (the overflow check).
    #[serde(skip)]
    pub clipped: usize,
}

impl Default for World {
    fn default() -> World {
        World {
            player: [0, 0],
            coins_at: Vec::new(),
            coins: 0,
            hp: HEALTH_MAX,
            bag: [Item::Empty; BAG_SLOTS],
            equipped: None,
            played: 0,
            screen: Screen::default(),
            since: 0,
            confirm: None,
            quitting: false,
            tab: None,
            found: None,
            clipped: 0,
        }
    }
}

impl World {
    /// Open `screen` on `tick`.
    pub fn open(&mut self, screen: Screen, tick: u64) {
        self.screen = screen;
        self.since = tick;
        self.confirm = None;
        self.quitting = false;
    }

    /// Use or equip the item in bag cell `index`.
    pub fn activate(&mut self, index: usize) {
        let Some(item) = self.bag.get(index).copied() else { return };
        if item == Item::Potion {
            self.hp = (self.hp + POTION_HEALTH).min(HEALTH_MAX);
            self.bag[index] = Item::Empty;
            if self.equipped == Some(index) {
                self.equipped = None;
            }
        } else if item.equips() {
            self.equipped = if self.equipped == Some(index) { None } else { Some(index) };
        }
    }

    /// Swap bag cells `from` and `to` (a drag), keeping the equipped item equipped.
    pub fn swap(&mut self, from: usize, to: usize) {
        if from >= BAG_SLOTS || to >= BAG_SLOTS {
            return;
        }
        self.bag.swap(from, to);
        self.equipped = self.equipped.map(|cell| match cell {
            c if c == from => to,
            c if c == to => from,
            c => c,
        });
    }
}

/// A free tile for a coin, from `draw` (the reset's or the tick's rng): never the player's tile
/// or another coin's. A full courtyard keeps the last tile tried.
fn free_tile(world: &World, mut draw: impl FnMut(u32) -> u32) -> [i32; 2] {
    let side = u32::try_from(ARENA_HALF * 2 + 1).unwrap_or(1);
    let mut tile = [0, 0];
    for _ in 0..16 {
        let x = i32::try_from(draw(side)).unwrap_or(0) - ARENA_HALF;
        let z = i32::try_from(draw(side)).unwrap_or(0) - ARENA_HALF;
        tile = [x, z];
        if tile != world.player && !world.coins_at.contains(&tile) {
            break;
        }
    }
    tile
}

/// A new game: the player in the middle, a potion in the bag and coins placed by `draw` (the
/// reset's rng, or the tick's when New game is picked from the title).
pub fn new_world(mut draw: impl FnMut(u32) -> u32) -> World {
    let mut world = World::default();
    for _ in 0..COINS {
        let tile = free_tile(&world, &mut draw);
        world.coins_at.push(tile);
    }
    world.bag[0] = Item::Potion;
    world
}

fn reset(sim: &mut Sim<World>, _seed: u32, rng: &mut Pcg32, _gfx: &Gfx) {
    sim.world = new_world(|bound| rng.below(bound));
    sim.world.screen = Screen::Title;
}

/// The step the player asked for this tick: arrows or the d-pad, one tile per press.
fn step_of(ctx: &Ctx) -> [i32; 2] {
    let pressed = |key: Key, button: usize| ctx.keys.pressed(key) || ctx.pads.pressed(0, button);
    let x = i32::from(pressed(Key::ArrowRight, PAD_RIGHT)) - i32::from(pressed(Key::ArrowLeft, PAD_LEFT));
    let z = i32::from(pressed(Key::ArrowDown, PAD_DOWN)) - i32::from(pressed(Key::ArrowUp, PAD_UP));
    [x, z]
}

/// One tick of play: move, collect, loot, drain.
fn play(world: &mut World, ctx: &Ctx) {
    world.played += 1;
    let [dx, dz] = step_of(ctx);
    world.player = [(world.player[0] + dx).clamp(-ARENA_HALF, ARENA_HALF), (world.player[1] + dz).clamp(-ARENA_HALF, ARENA_HALF)];
    if let Some(index) = world.coins_at.iter().position(|tile| *tile == world.player) {
        world.coins += 1;
        world.coins_at.remove(index);
        let tile = free_tile(world, |bound| ctx.rng.below(bound));
        world.coins_at.push(tile);
        if world.coins.is_multiple_of(COINS_PER_LOOT) {
            let loot = LOOT[ctx.rng.below(u32::try_from(LOOT.len()).unwrap_or(1)) as usize];
            if let Some(cell) = world.bag.iter().position(|item| *item == Item::Empty) {
                world.bag[cell] = loot;
                world.found = Some(loot);
            }
        }
    }
    if world.played.is_multiple_of(DRAIN_TICKS) {
        world.hp = world.hp.saturating_sub(1);
    }
}

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    let world = &mut sim.world;
    let start = ctx.pads.pressed(0, PAD_START);
    match world.screen {
        Screen::Playing if start || ctx.keys.pressed(Key::Escape) => world.open(Screen::Pause, ctx.tick),
        Screen::Playing => play(world, ctx),
        Screen::Pause if start && ctx.tick > world.since => world.open(Screen::Playing, ctx.tick),
        _ => {}
    }
}

fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    let side = (ARENA_HALF * 2 + 1) as f32;
    frame.tag("courtyard").cube(Transform::from_xyz(0.0, -0.1, 0.0).with_scale(vec3(side, 0.2, side)), GROUND);
    for line in -ARENA_HALF..=ARENA_HALF + 1 {
        let at = line as f32 - 0.5;
        frame.cube(Transform::from_xyz(at, 0.01, 0.0).with_scale(vec3(0.03, 0.02, side)), TILE_LINE);
        frame.cube(Transform::from_xyz(0.0, 0.01, at).with_scale(vec3(side, 0.02, 0.03)), TILE_LINE);
    }
    let edge = side / 2.0 + 0.25;
    for (x, z, sx, sz) in [(0.0, -edge, side + 1.0, 0.5), (0.0, edge, side + 1.0, 0.5), (-edge, 0.0, 0.5, side), (edge, 0.0, 0.5, side)] {
        frame.cube(Transform::from_xyz(x, 0.3, z).with_scale(vec3(sx, 0.6, sz)), WALL);
    }
    frame.tag("coins");
    for [x, z] in &world.coins_at {
        frame.cube(Transform::from_xyz(*x as f32, 0.25, *z as f32).with_scale(vec3(0.4, 0.4, 0.12)), COIN);
    }
    let color = if world.equipped.is_some() { PLAYER_ARMED } else { PLAYER };
    frame.tag("player").sphere(vec3(world.player[0] as f32, 0.45, world.player[1] as f32), 0.42, color);
}

/// The `world` probe: everything a save holds, so a load's checksum self-check covers it.
pub fn world_probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    json!({
        "player": world.player,
        "coins": world.coins,
        "coinsAt": world.coins_at,
        "hp": world.hp,
        "bag": world.bag,
        "equipped": world.equipped,
        "played": world.played,
    })
}

/// The volatile `menus` probe: the open screen and settings tab (never in the checksum).
pub fn menus_probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    json!({
        "screen": world.screen.wire(),
        "tab": world.tab,
        "confirm": world.confirm,
        "quitting": world.quitting,
        "clipped": world.clipped,
    })
}

/// Register the courtyard's hooks and probes for a world of `size` (its aspect picks the camera).
pub fn wire(game: &mut Game<World>, size: [u32; 2]) {
    let eye = if size[1] > size[0] { CAMERA_EYE_PORTRAIT } else { CAMERA_EYE };
    game.on_reset(reset);
    game.on_update(update);
    game.on_draw(draw);
    game.camera(move |_| Camera::look_at(Vec3::from_array(eye), Vec3::ZERO));
    game.probe("world", world_probe);
    game.probe_volatile("menus", menus_probe);
}
