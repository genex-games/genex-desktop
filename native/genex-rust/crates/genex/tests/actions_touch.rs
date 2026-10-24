//! Touch controls, prompts and the Controls panel on the facade (G6 input, IN-12): a click on a
//! control's HUD rect is touch 0 on the control, showing the controls never moves a checksum, key
//! labels are display only, and the panel's rebind is saved as `genex-input.json`.

use genex::actions::{ActionId, ActionMap, Anchor, Binding, ContextId, ControlId, ShowWhen, TouchControls, controls_panel};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, Map, Runtime};

const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");
const JUMP_BUTTON: ControlId = ControlId::new("jump");
const WORLD: [u32; 2] = [400, 300];

#[derive(Default)]
struct World {
    jumps: u32,
    free: u32,
    prompt: String,
}

fn map() -> ActionMap {
    ActionMap::new().context(genex::actions::Context::new(PLAY, 0).button(JUMP, &[Key::Space.into(), Binding::Touch(JUMP_BUTTON)]))
}

fn layout(show: ShowWhen) -> TouchControls {
    TouchControls::new().button(JUMP_BUTTON, "Jump", Anchor::BottomRight([60.0, 60.0]), 40.0).show(show)
}

fn game(show: ShowWhen) -> Game<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.input(map());
    game.touch_controls(layout(show));
    game.on_update(|sim, ctx| {
        if ctx.actions.pressed(JUMP) {
            sim.world.jumps += 1;
        }
        sim.world.free += ctx.actions.free_touches().count() as u32;
        sim.world.prompt = ctx.actions.glyph(JUMP).label;
    });
    game.probe("jumps", |sim| json!({ "jumps": sim.world.jumps, "free": sim.world.free }));
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("a consistent game installs")
}

fn jump_rect_centre(rt: &Runtime<World>) -> [f32; 2] {
    let widget = rt.hud_widgets().into_iter().find(|w| w.label == "Jump").expect("the jump button is a HUD item");
    widget.center_fraction(WORLD)
}

#[test]
fn a_click_on_the_jump_buttons_hud_rect_fires_jump_through_touch_zero() {
    let mut rt = runtime(game(ShowWhen::Always));
    rt.step(FIXED_STEP_MS);
    let items = rt.state()["hud"]["items"].clone();
    assert!(items.as_array().is_some_and(|items| items.iter().any(|item| item == "Jump")), "{items}");
    let [x, y] = jump_rect_centre(&rt);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.jumps, 1, "Mouse1 is touch 0, which lands on the control");
    assert_eq!(rt.sim().world.free, 0, "the control took the touch");
    rt.inject(Input::click_at(0.1, 0.1));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!((rt.sim().world.jumps, rt.sim().world.free), (1, 1), "a touch elsewhere is free");
}

fn touch_script(rt: &mut Runtime<World>) -> String {
    rt.seed(4);
    for (x, y) in [(340.0, 240.0), (20.0, 20.0), (345.0, 236.0)] {
        rt.inject(Input::touch_start(1, x, y));
        rt.step(FIXED_STEP_MS * 3.0);
        rt.inject(Input::touch_end(1, x, y));
        rt.step(FIXED_STEP_MS * 2.0);
    }
    rt.checksum()
}

#[test]
fn checksums_are_equal_with_the_controls_never_and_always_shown() {
    let never = touch_script(&mut runtime(game(ShowWhen::Never)));
    let mut shown = runtime(game(ShowWhen::Always));
    let always = touch_script(&mut shown);
    assert_eq!(never, always);
    assert_eq!(shown.sim().world.jumps, 2, "two of the touches land on the button");
    assert_eq!(shown.state()["__input"]["touchControls"]["shown"], json!(true));
}

#[test]
fn key_labels_change_prompts_and_hints_only_and_are_ignored_in_a_studio_run() {
    let script = |rt: &mut Runtime<World>| {
        rt.seed(2);
        rt.inject(Input::key_tap(Key::Space));
        rt.step(FIXED_STEP_MS * 3.0);
        rt.checksum()
    };
    let mut plain = runtime(game(ShowWhen::Never));
    let expected = script(&mut plain);
    assert_eq!(plain.sim().world.prompt, "Space");
    let mut labels = Map::default();
    labels.insert("Space".to_owned(), "Leertaste".to_owned());
    let mut labelled = runtime(game(ShowWhen::Never));
    labelled.set_key_labels(&labels);
    assert_eq!(script(&mut labelled), expected, "labels never move a checksum");
    assert_eq!(labelled.sim().world.prompt, "Leertaste");
    assert_eq!(labelled.state()["__input"]["hints"]["jump"], json!("Leertaste"));
    let dir = std::env::temp_dir().join(format!("genex-touch-studio-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut studio = runtime(game(ShowWhen::Never));
    studio.use_studio_saves(&format!("{}/", dir.display()));
    studio.set_key_labels(&labels);
    script(&mut studio);
    assert_eq!(studio.sim().world.prompt, "Space", "a Studio run ignores the layout's labels");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn driving_the_panel_by_labels_rebinds_jump_writes_the_file_and_changes_the_digest() {
    let dir = std::env::temp_dir().join(format!("genex-touch-panel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut game = game(ShowWhen::Never);
    game.on_ui(|_sim, ui, _ctx| controls_panel(ui));
    let mut rt = runtime(game);
    rt.use_studio_saves(&format!("{}/", dir.display()));
    let before = rt.state()["__input"]["bindings"].clone();
    rt.step(FIXED_STEP_MS);
    let rebind = rt.hud_widgets().into_iter().find(|w| w.label == "Rebind Jump").expect("the panel's rebind button");
    let [x, y] = rebind.center_fraction(WORLD);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    rt.inject(Input::key_tap(Key::KeyJ));
    rt.step(FIXED_STEP_MS * 3.0);
    let written = std::fs::read(dir.join("genex-input.json")).expect("the panel's rebind is saved");
    assert!(String::from_utf8_lossy(&written).contains("key:KeyJ"), "{}", String::from_utf8_lossy(&written));
    assert_ne!(rt.state()["__input"]["bindings"], before, "the digest moved");
    let track = rt.journal().track().expect("a journal");
    let digest = format!("{:016x}", track.header().bindings_digest);
    assert_eq!(json!(digest), rt.state()["__input"]["bindings"], "the journal restarted under the new bindings");
    assert_eq!(track.anchor(), genex::actions::TrackAnchor::Snapshot, "anchored at the tick after the rebind");
    rt.inject(Input::key_tap(Key::KeyJ));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.jumps, 1, "KeyJ jumps now");
    let _ = std::fs::remove_dir_all(&dir);
}


/// The centre of the jump button's zone, as a fraction of the world (where a click lands on it).
fn jump_zone_centre(show: ShowWhen) -> [f32; 2] {
    let [x0, y0, x1, y1] = layout(show).controls()[0].zone(WORLD);
    [(x0 + x1) / 2.0 / WORLD[0] as f32, (y0 + y1) / 2.0 / WORLD[1] as f32]
}

#[test]
fn a_desktop_click_on_a_hidden_controls_rect_stays_the_games_click() {
    // Red before R-26: Mouse1 (touch 0) pressed the invisible Jump button.
    let mut rt = runtime(game(ShowWhen::Touch));
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.state()["__input"]["touchControls"]["shown"], json!(false), "hidden on a keyboard and mouse");
    let [x, y] = jump_zone_centre(ShowWhen::Touch);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!((rt.sim().world.jumps, rt.sim().world.free), (0, 1), "no jump; the click is a free touch");
    // A finger on the same spot presses it: the controls work for touches whether shown or not.
    let [px, py] = [x * WORLD[0] as f32, y * WORLD[1] as f32];
    rt.inject(Input::touch_start(1, px, py));
    rt.step(FIXED_STEP_MS * 2.0);
    rt.inject(Input::touch_end(1, px, py));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.jumps, 1, "a finger presses it");
}

#[test]
fn the_touch_prompt_reads_the_buttons_label() {
    // Red before R-26: the prompt read the control id.
    let mut rt = runtime(game(ShowWhen::Touch));
    rt.inject(Input::touch_start(3, 20.0, 20.0));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.prompt, "Jump");
    assert_eq!(rt.state()["__input"]["touchControls"]["shown"], json!(true), "shown once the player touches");
}
