//! The web streaming sample (gate GR's web streaming row): a streamed world of 64 m cells with the
//! player anchored in cell (0, 0), `KeyT` teleporting it to cell (10, 0), and the named group
//! `interior` required on the second tick, whose level file it reads once ready. Each reset records
//! what the sim's asset folder says about the far cell's body (`gfx.assets().info`), so a reseed
//! after the teleport shows whether the fetched file reached the sim's reads. The probe `stream`
//! reports all of it. Built as a wasm-bindgen `cdylib` for
//! `tests/conformance/rust-web-streamed-world.test.ts`, which stages the pack and the group beside
//! the page. On every other target it is empty.

#![cfg(target_arch = "wasm32")]

use genex::prelude::*;
use genex::{StreamTicket, Streaming};

/// The grid's cell side, in metres.
const CELL: f32 = 64.0;
/// The far cell's column (row 0).
const FAR_X: i32 = 10;
/// The far cell's body in the staged pack.
const FAR_BODY: &str = "valley/cells/10_0.cell";
/// The named group's level file.
const ROOM: &str = "interior/room.json";
/// The tick the game requires the interior on.
const REQUIRE_TICK: u32 = 2;

#[derive(Default)]
struct World {
    ticks: u32,
    far: bool,
    ticket: Option<StreamTicket>,
    ready_tick: Option<u32>,
    doors: Option<i64>,
    /// The far body's size and group as the sim's asset folder told the last reset.
    far_at_reset: Option<(u64, String)>,
}

/// The middle of the player's cell: (0, 0), or the far one after the teleport.
fn player(far: bool) -> Vec3 {
    let column = if far { FAR_X as f32 } else { 0.0 };
    vec3(column * CELL + CELL / 2.0, 0.0, CELL / 2.0)
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Web stream").world_size(320, 180);
    game.streaming(Streaming::grid(CELL).sim_radius(1));
    game.on_reset(|sim, _, _, gfx| {
        sim.world.far_at_reset = gfx.assets().info(FAR_BODY).map(|info| (info.bytes, info.group.wire().to_owned()));
        sim.stream.set_anchor("player", player(false)).expect("inside the world");
    });
    game.on_update(|sim, ctx| {
        sim.world.ticks += 1;
        if ctx.keys.pressed(Key::KeyT) {
            sim.world.far = true;
            sim.stream.set_anchor("player", player(true)).expect("inside the world");
        }
        if sim.world.ticks == REQUIRE_TICK {
            sim.world.ticket = sim.stream.require("interior").ok();
        }
        let Some(ticket) = sim.world.ticket else { return };
        if sim.world.ready_tick.is_some() {
            return;
        }
        if let Some(handles) = sim.stream.ready(ticket) {
            let room: Option<Value> = handles.bytes(ROOM).and_then(|bytes| serde_json::from_slice(bytes).ok());
            sim.world.doors = room.and_then(|room| room["doors"].as_i64());
            sim.world.ready_tick = Some(sim.world.ticks);
        }
    });
    game.on_draw(|_sim, frame, _camera| {
        frame.clear(Color::BACKGROUND).tag("stream");
        frame.cube(Transform::IDENTITY, Color::GREEN);
    });
    game.probe("stream", |sim| {
        let anchor: Vec<[i32; 2]> = sim.stream.anchors().map(|(_, cell)| [cell.x, cell.z]).collect();
        let far_at_reset = sim.world.far_at_reset.as_ref().map(|(bytes, group)| json!({ "bytes": bytes, "group": group }));
        json!({
            "ticks": sim.world.ticks,
            "far": sim.world.far,
            "anchor": anchor,
            "active": sim.stream.active().count(),
            "readyTick": sim.world.ready_tick,
            "doors": sim.world.doors,
            "farAtReset": far_at_reset,
        })
    });
    game
}

/// Hand the game to the web shell when the module is instantiated.
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named("web-stream", game(), &[]);
}
