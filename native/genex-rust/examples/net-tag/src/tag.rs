//! net-tag's world, rules, drawing and demos.

use std::collections::BTreeMap;

use genex::net::{NetControl, NetEvent, NetPlayer, NetStatus, NetTicket, PlayerId};
use genex::prelude::*;

use crate::teams::{BLUE, RED, reconcile};

/// Half the arena's side, in metres: players and the tag stay within `-ARENA_HALF..=ARENA_HALF`.
pub const ARENA_HALF: f32 = 10.0;
/// How close a player's raw position must come to the tag to score.
pub const TAG_RADIUS: f32 = 1.0;
/// The connected players a round needs (the quorum); below it the round waits.
pub const MIN_PLAYERS: usize = 2;
/// The shared object the host simulates: the tag.
pub const TAG_OBJECT: &str = "tag";
/// The shared key holding each player's team (host only).
pub const SHARED_TEAMS: &str = "teams";
/// The shared key holding the score (host only).
pub const SHARED_SCORE: &str = "score";
/// Every demo, in registration order.
pub const DEMOS: [&str; 5] = ["solo", "two_players", "host_leaves", "reconnect", "match_quorum"];

/// How far you move in a tick while a direction is held.
const SPEED_PER_TICK: f32 = 0.15;
/// How far a bot moves toward the tag in a tick.
const BOT_SPEED_PER_TICK: f32 = 0.06;
/// Where you and the bots start, and where the tag first appears.
const MY_SPAWN: [f32; 2] = [0.0, 6.0];
const BOT_SPAWNS: [[f32; 2]; 3] = [[-7.0, -7.0], [7.0, -7.0], [0.0, -9.0]];
const TAG_SPAWN: [f32; 2] = [0.0, 0.0];
/// Where the camera looks from.
const CAMERA_EYE: [f32; 3] = [0.0, 20.0, 15.0];
/// A demo's step: three ticks.
const DEMO_STEP_MS: u32 = 50;
const GROUND: Color = Color::rgb(46, 74, 52);
const WALL: Color = Color::rgb(120, 116, 108);
const TAG: Color = Color::rgb(240, 200, 48);
const RED_PLAYER: Color = Color::rgb(220, 64, 56);
const BLUE_PLAYER: Color = Color::rgb(56, 112, 224);
const UNASSIGNED: Color = Color::rgb(200, 200, 200);

/// What the player picked on the menu.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// The menu: nothing touches the network.
    #[default]
    Menu,
    /// Online: the commitment point that connects.
    Online,
    /// Bots: offline play against three bots.
    Bots,
}

impl Mode {
    /// The mode's probe name.
    pub fn wire(self) -> &'static str {
        match self {
            Mode::Menu => "menu",
            Mode::Online => "online",
            Mode::Bots => "bots",
        }
    }
}

/// Whether a round plays: online it needs `MIN_PLAYERS` connected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// Too few players are connected.
    #[default]
    Waiting,
    /// Touching the tag scores.
    Playing,
}

impl Phase {
    /// The phase's probe name.
    pub fn wire(self) -> &'static str {
        match self {
            Phase::Waiting => "waiting",
            Phase::Playing => "playing",
        }
    }
}

/// The game's state. Everything online is read from `sim.net`; the world keeps only what this
/// seat decides (its own position, its pending claim, the menu) and the host's copy of the tag.
#[derive(Debug, Default)]
pub struct World {
    /// What the menu picked.
    pub mode: Mode,
    /// A menu button the HUD clicked this tick, applied by the next update.
    pub pick: Option<Mode>,
    /// Whether this seat has asked to connect (once per Play online).
    pub connect_sent: bool,
    /// Why the room closed this seat, shown on the menu (`replaced` never rejoins).
    pub notice: Option<String>,
    /// My position (x, z), moved locally on the input tick.
    pub me: [f32; 2],
    /// The bots' positions in Bots mode.
    pub bots: Vec<[f32; 2]>,
    /// The tag's position: Bots mode's tag, and online the host's copy of the shared object.
    pub tag: [f32; 2],
    /// Whether the host's copy is seeded from the object it owns.
    pub tag_live: bool,
    /// A claim on the tag waiting for its answer, and the tick a held claim may retry from.
    pub tag_claim: Option<NetTicket>,
    /// The tick a held claim may retry from.
    pub claim_retry_at: u64,
    /// Accepted claims on the tag (a migration adds one).
    pub claims_accepted: u32,
    /// The teams the host published last, so it never repeats a write the room has not echoed.
    pub teams_sent: Option<BTreeMap<String, String>>,
    /// Bots mode's score (red, blue); online the score lives in the shared `score` key.
    pub bot_score: [u32; 2],
    /// The round's phase.
    pub phase: Phase,
}

fn reset(sim: &mut Sim<World>, _seed: u32, _rng: &mut Pcg32, _gfx: &Gfx) {
    sim.world = World { me: MY_SPAWN, tag: TAG_SPAWN, ..World::default() };
}

/// The direction the held keys point (x, z), unnormalised.
fn input_direction(ctx: &Ctx) -> [f32; 2] {
    let axis = |minus: [Key; 2], plus: [Key; 2]| {
        let held = |keys: [Key; 2]| keys.iter().any(|key| ctx.keys.down(*key));
        f32::from(i8::from(held(plus)) - i8::from(held(minus)))
    };
    [axis([Key::KeyA, Key::ArrowLeft], [Key::KeyD, Key::ArrowRight]), axis([Key::KeyW, Key::ArrowUp], [Key::KeyS, Key::ArrowDown])]
}

fn clamp_to_arena(at: [f32; 2]) -> [f32; 2] {
    at.map(|v| v.clamp(-ARENA_HALF, ARENA_HALF))
}

fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let (dx, dz) = (a[0] - b[0], a[1] - b[1]);
    (dx * dx + dz * dz).sqrt()
}

/// A fresh tag position, drawn from the seeded stream.
fn tag_spot(ctx: &Ctx) -> [f32; 2] {
    let reach = ARENA_HALF - 2.0;
    [(ctx.rng.unit() * 2.0 - 1.0) * reach, (ctx.rng.unit() * 2.0 - 1.0) * reach]
}

/// A JSON state's `x`/`z` as a position, when it has both.
fn position_of(state: &Value) -> Option<[f32; 2]> {
    let read = |key: &str| state.get(key).and_then(Value::as_f64).map(|v| v as f32);
    Some([read("x")?, read("z")?])
}

fn update(sim: &mut Sim<World>, ctx: &Ctx) {
    if let Some(pick) = sim.world.pick.take() {
        choose(&mut sim.world, pick);
    }
    match sim.world.mode {
        Mode::Menu => menu_keys(&mut sim.world, ctx),
        Mode::Bots => bots(&mut sim.world, ctx),
        Mode::Online => online(sim, ctx),
    }
}

fn choose(world: &mut World, mode: Mode) {
    world.mode = mode;
    world.notice = None;
    world.me = MY_SPAWN;
    world.tag = TAG_SPAWN;
    world.bots = if mode == Mode::Bots { BOT_SPAWNS.to_vec() } else { Vec::new() };
}

fn menu_keys(world: &mut World, ctx: &Ctx) {
    if ctx.keys.pressed(Key::Enter) {
        choose(world, Mode::Online);
    } else if ctx.keys.pressed(Key::KeyB) {
        choose(world, Mode::Bots);
    }
}

fn move_me(world: &mut World, ctx: &Ctx) {
    let [dx, dz] = input_direction(ctx);
    world.me = clamp_to_arena([world.me[0] + dx * SPEED_PER_TICK, world.me[1] + dz * SPEED_PER_TICK]);
}

/// Bots mode: three bots chase the tag; nothing here touches `sim.net`.
fn bots(world: &mut World, ctx: &Ctx) {
    if ctx.keys.pressed(Key::Escape) {
        return choose(world, Mode::Menu);
    }
    move_me(world, ctx);
    let tag = world.tag;
    for bot in &mut world.bots {
        let gap = distance(*bot, tag);
        if gap > f32::EPSILON {
            let step = BOT_SPEED_PER_TICK.min(gap) / gap;
            *bot = [bot[0] + (tag[0] - bot[0]) * step, bot[1] + (tag[1] - bot[1]) * step];
        }
    }
    world.phase = Phase::Playing;
    let scorer = if distance(world.me, tag) <= TAG_RADIUS {
        Some(0)
    } else {
        world.bots.iter().any(|bot| distance(*bot, tag) <= TAG_RADIUS).then_some(1)
    };
    if let Some(team) = scorer {
        world.bot_score[team] += 1;
        world.tag = tag_spot(ctx);
    }
}

/// Online: connect once at the commitment point, publish my position, and run the host's work.
fn online(sim: &mut Sim<World>, ctx: &Ctx) {
    if ctx.keys.pressed(Key::Escape) {
        sim.net.leave();
        sim.world.connect_sent = false;
        return choose(&mut sim.world, Mode::Menu);
    }
    if !sim.world.connect_sent {
        sim.net.connect();
        sim.world.connect_sent = true;
    }
    read_events(sim);
    if sim.world.mode != Mode::Online {
        return;
    }
    move_me(&mut sim.world, ctx);
    let [x, z] = sim.world.me;
    if sim.net.status() == NetStatus::Joined {
        sim.net.set_me(json!({ "x": x, "z": z })).ok();
    }
    sim.world.phase = if sim.net.connected() >= MIN_PLAYERS { Phase::Playing } else { Phase::Waiting };
    if sim.net.is_host() {
        host_teams(sim);
        host_tag(sim, ctx);
    }
}

/// This tick's events: claim answers, losing the tag, and a closed seat (back to the menu; a
/// `replaced` seat is shown and never rejoins).
fn read_events(sim: &mut Sim<World>) {
    let world = &mut sim.world;
    for event in sim.net.events() {
        match event {
            NetEvent::Control { ticket, result, retry_at_tick } if world.tag_claim == Some(*ticket) => {
                world.tag_claim = None;
                world.claims_accepted += u32::from(*result == NetControl::Accepted);
                world.claim_retry_at = retry_at_tick.unwrap_or(0);
            }
            NetEvent::Owner { object, owner } if object == TAG_OBJECT && owner.as_ref() != sim.net.me() => world.tag_live = false,
            NetEvent::Closed { reason } => {
                let reason = reason.wire().to_owned();
                choose(world, Mode::Menu);
                world.connect_sent = false;
                world.notice = Some(reason);
            }
            _ => {}
        }
    }
}

/// The host keeps the shared teams reconciled with the seated players.
fn host_teams(sim: &mut Sim<World>) {
    let seated: Vec<&str> = sim.net.players().map(|player| player.id().as_str()).collect();
    let current = sim.net.shared(SHARED_TEAMS);
    let teams = reconcile(current, &seated);
    let published = current == Some(&json!(teams));
    if published || sim.world.teams_sent.as_ref() == Some(&teams) {
        return;
    }
    if sim.net.set_shared(SHARED_TEAMS, json!(teams)).is_ok() {
        sim.world.teams_sent = Some(teams);
    }
}

/// The host owns the tag: claim it (again after a migration), seed the copy from the last raw
/// state, and while a round plays score the first player, in id order, whose raw position touches it.
fn host_tag(sim: &mut Sim<World>, ctx: &Ctx) {
    let mine = sim.net.object(TAG_OBJECT).is_some_and(|tag| tag.mine());
    if !mine {
        sim.world.tag_live = false;
        let may_claim = sim.world.tag_claim.is_none() && ctx.tick >= sim.world.claim_retry_at;
        if may_claim {
            sim.world.tag_claim = sim.net.claim_as_host(TAG_OBJECT).ok();
        }
        return;
    }
    if !sim.world.tag_live {
        let last = sim.net.object(TAG_OBJECT).and_then(|tag| position_of(tag.state_raw()));
        sim.world.tag = last.unwrap_or(TAG_SPAWN);
        sim.world.tag_live = true;
        let [x, z] = sim.world.tag;
        sim.net.snap_object(TAG_OBJECT, json!({ "x": x, "z": z })).ok();
    }
    if sim.world.phase == Phase::Playing {
        score(sim, ctx);
    }
}

fn score(sim: &mut Sim<World>, ctx: &Ctx) {
    let tag = sim.world.tag;
    let me = sim.net.me().cloned();
    let touching = |player: &NetPlayer| {
        let at = if Some(player.id()) == me.as_ref() { Some(sim.world.me) } else { position_of(player.state_raw()) };
        at.is_some_and(|at| distance(at, tag) <= TAG_RADIUS)
    };
    let Some(scorer) = sim.net.players().find(|player| touching(player)).map(|player| player.id().clone()) else {
        return;
    };
    let Some(team) = team_of(sim, &scorer) else { return };
    let mut score = sim.net.shared(SHARED_SCORE).filter(|score| score.is_object()).cloned().unwrap_or_else(|| json!({ RED: 0, BLUE: 0 }));
    let points = score.get(team).and_then(Value::as_u64).unwrap_or(0) + 1;
    score[team] = json!(points);
    sim.net.set_shared(SHARED_SCORE, score).ok();
    sim.world.tag = tag_spot(ctx);
    let [x, z] = sim.world.tag;
    sim.net.snap_object(TAG_OBJECT, json!({ "x": x, "z": z })).ok();
}

fn team_of(sim: &Sim<World>, player: &PlayerId) -> Option<&'static str> {
    let team = sim.net.shared(SHARED_TEAMS)?.get(player.as_str())?.as_str()?;
    [RED, BLUE].into_iter().find(|known| *known == team)
}

fn team_color(team: Option<&str>) -> Color {
    match team {
        Some(RED) => RED_PLAYER,
        Some(BLUE) => BLUE_PLAYER,
        _ => UNASSIGNED,
    }
}

fn at(position: [f32; 2], height: f32) -> Vec3 {
    vec3(position[0], height, position[1])
}

fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    let side = ARENA_HALF * 2.0 + 1.0;
    frame.tag("arena").cube(Transform::from_xyz(0.0, -0.1, 0.0).with_scale(vec3(side, 0.2, side)), GROUND);
    for (x, z, sx, sz) in [(0.0, -ARENA_HALF - 0.75, side, 0.5), (0.0, ARENA_HALF + 0.75, side, 0.5), (-ARENA_HALF - 0.75, 0.0, 0.5, side), (ARENA_HALF + 0.75, 0.0, 0.5, side)] {
        frame.cube(Transform::from_xyz(x, 0.4, z).with_scale(vec3(sx, 0.8, sz)), WALL);
    }
    let online = world.mode == Mode::Online;
    // A remote host's tag draws its smoothed state; the host's own copy is live.
    let remote_tag = sim.net.object(TAG_OBJECT).filter(|tag| !tag.mine()).and_then(|tag| position_of(tag.state()));
    let tag = remote_tag.filter(|_| online).unwrap_or(world.tag);
    frame.tag("tag").cube(Transform::from_translation(at(tag, 0.5)).with_scale(Vec3::splat(0.8)), TAG);
    frame.tag("players");
    if !online {
        frame.sphere(at(world.me, 0.5), 0.5, RED_PLAYER);
        for bot in &world.bots {
            frame.sphere(at(*bot, 0.5), 0.5, BLUE_PLAYER);
        }
        return;
    }
    // Me where I moved this tick; everyone else at their smoothed state, coloured by team.
    for player in sim.net.players() {
        let position = if player.is_me() { Some(world.me) } else { position_of(player.state()) };
        if let Some(position) = position {
            frame.sphere(at(position, 0.5), 0.5, team_color(team_of(sim, player.id())));
        }
    }
}

fn hud(sim: &mut Sim<World>, ui: &mut egui::Ui, _ctx: &Ctx) {
    let world = &mut sim.world;
    match world.mode {
        Mode::Menu => {
            ui.heading("Net tag");
            if let Some(notice) = &world.notice {
                ui.label(format!("Left the room: {notice}"));
            }
            if ui.button("Play online").clicked() {
                world.pick = Some(Mode::Online);
            }
            if ui.button("Bots").clicked() {
                world.pick = Some(Mode::Bots);
            }
        }
        Mode::Bots => {
            ui.label(format!("Bots   Red {}   Blue {}", world.bot_score[0], world.bot_score[1]));
        }
        Mode::Online => {
            let score = sim.net.shared(SHARED_SCORE);
            let points = |team: &str| score.and_then(|score| score.get(team)).and_then(Value::as_u64).unwrap_or(0);
            let status = sim.net.status().wire();
            ui.label(format!("Online ({status})   Red {}   Blue {}", points(RED), points(BLUE)));
            if world.phase == Phase::Waiting {
                ui.label(format!("Waiting for {MIN_PLAYERS} players"));
            }
        }
    }
}

/// Where the tag is for gameplay: online the shared object's raw state (the host's copy when it
/// owns it), offline the local tag.
fn tag_position(sim: &Sim<World>) -> [f32; 2] {
    let shared = sim.net.object(TAG_OBJECT).filter(|tag| !tag.mine()).and_then(|tag| position_of(tag.state_raw()));
    shared.filter(|_| sim.world.mode == Mode::Online).unwrap_or(sim.world.tag)
}

/// The `tag` probe: what a check reads to judge the mechanic.
pub fn tag_probe(sim: &Sim<World>) -> Value {
    let world = &sim.world;
    let net = &sim.net;
    let tag_owner = net.object(TAG_OBJECT).and_then(|tag| tag.owner()).map(PlayerId::as_str);
    let score = match world.mode {
        Mode::Online => net.shared(SHARED_SCORE).cloned().unwrap_or_else(|| json!({ RED: 0, BLUE: 0 })),
        _ => json!({ RED: world.bot_score[0], BLUE: world.bot_score[1] }),
    };
    json!({
        "mode": world.mode.wire(),
        "status": net.status().wire(),
        "phase": world.phase.wire(),
        "me": net.me().map(PlayerId::as_str),
        "host": net.host().map(PlayerId::as_str),
        "players": net.players().count(),
        "connected": net.connected(),
        "teams": net.shared(SHARED_TEAMS).cloned().unwrap_or(Value::Null),
        "score": score,
        "tagOwner": tag_owner,
        "tag": tag_position(sim),
        "claimsAccepted": world.claims_accepted,
        "notice": world.notice,
    })
}

/// Run `steps` demo steps of three ticks each.
fn run(d: &mut DemoDriver<'_, World>, steps: u32) {
    for _ in 0..steps {
        d.advance_ms(DEMO_STEP_MS);
    }
}

/// Pick Play online with a real key press and wait until the room seats me.
fn go_online(d: &mut DemoDriver<'_, World>) {
    d.inject(Input::key_tap(Key::Enter));
    run(d, 2);
}

fn demos(game: &mut Game<World>) {
    game.demo("solo", |d| {
        d.inject(Input::key_tap(Key::KeyB));
        run(d, 60);
        tag_probe(d.sim())
    });
    game.demo("two_players", |d| {
        go_online(d);
        let bea = d.net().join("Bea");
        d.net().set_state(&bea, json!({ "x": 4.0, "z": 0.0 }));
        run(d, 10);
        // Bea walks onto the tag: the host reads her raw state and scores for her team.
        let [x, z] = d.sim().world.tag;
        d.net().set_state(&bea, json!({ "x": x, "z": z }));
        run(d, 10);
        tag_probe(d.sim())
    });
    game.demo("host_leaves", |d| {
        go_online(d);
        let bea = d.net().join("Bea");
        d.net().set_state(&bea, json!({ "x": 4.0, "z": 0.0 }));
        run(d, 4);
        d.net().make_host(Some(&bea));
        d.net().set_object(TAG_OBJECT, &bea, json!({ "x": 3.0, "z": -2.0 }));
        run(d, 6);
        let before = tag_probe(d.sim());
        d.net().leave(&bea);
        run(d, 6);
        json!({ "before": before, "after": tag_probe(d.sim()) })
    });
    game.demo("reconnect", |d| {
        go_online(d);
        let bea = d.net().join("Bea");
        d.net().set_state(&bea, json!({ "x": 4.0, "z": 0.0 }));
        run(d, 6);
        let before = tag_probe(d.sim());
        d.net().reconnect_for(30);
        run(d, 4);
        let during = tag_probe(d.sim());
        run(d, 16);
        json!({ "before": before, "during": during, "after": tag_probe(d.sim()) })
    });
    game.demo("match_quorum", |d| {
        go_online(d);
        let mut phases = vec![tag_probe(d.sim())["phase"].clone()];
        let bea = d.net().join("Bea");
        run(d, 4);
        phases.push(tag_probe(d.sim())["phase"].clone());
        d.net().drop_connection(&bea);
        run(d, 4);
        phases.push(tag_probe(d.sim())["phase"].clone());
        d.net().join("Cy");
        run(d, 4);
        phases.push(tag_probe(d.sim())["phase"].clone());
        json!({ "phases": phases, "end": tag_probe(d.sim()) })
    });
}

/// Register every net-tag hook on `game`.
pub fn wire(game: &mut Game<World>) {
    game.on_reset(reset);
    game.on_update(update);
    game.on_ui(hud);
    game.on_draw(draw);
    game.camera(|_| Camera::look_at(Vec3::from_array(CAMERA_EYE), Vec3::ZERO));
    game.probe("tag", tag_probe);
    demos(game);
}
