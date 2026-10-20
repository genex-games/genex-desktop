//! The controls panel and the touch-control painter (IN-9), driven the way a play script drives
//! the HUD: clicks and keys as egui events at the rects the AccessKit tree reports, and the
//! tick's merged input (genex-core's merger) for what listen mode captures. Every row is new
//! behaviour: before IN-9 the panel and the painter were stubs.
//!
//! Rows: clicking "Rebind Jump" then pressing KeyJ answers `Rebind(jump, 0, key:KeyJ)`; a conflict
//! shows a prompt naming Move and answers nothing until Swap; each touch control is an AccessKit
//! node with its label and its zone as its rect. And the settings-panel pattern: Escape cancels,
//! the panel is keyboard reachable down to Reset on a short screen, accessibility changes answer a
//! whole valid `Access`, and two runs of one script draw and answer the same.

use std::num::NonZeroUsize;
use std::sync::Arc;

use egui::accesskit::{Node, NodeId, TreeUpdate};
use egui::{FontData, FontDefinitions, FontFamily, Pos2};
use genex_core::input::{Injection, InputMerger, TickInput, TouchPhase, TouchPoint};
use genex_input::binding::{Binding, KeyCode, PadButton, Stick};
use genex_input::glyph::{Glyph, GlyphShape, KeyLabels};
use genex_input::id::{ActionId, ContextId, ControlId};
use genex_input::map::{ActionMap, Context};
use genex_input::paint::{TouchArea, glyph_ui, paint_touch_controls};
use genex_input::panel::{ControlsChange, ControlsPanel, ControlsView, controls_panel};
use genex_input::state::Device;
use genex_input::touch::{Anchor, StickMode, TouchControls, TouchState, evaluate_touch};

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");
const SCREEN: [f32; 2] = [1280.0, 720.0];
const WORLD: [u32; 2] = [1280, 720];
/// The most Tab presses the keyboard walk takes to reach Reset.
const TABS_MAX: usize = 60;

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn game() -> ActionMap {
    ActionMap::new().context(
        Context::new(PLAY, 0)
            .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
            .button(JUMP, &[key("Space"), Binding::Pad(PadButton::South)]),
    )
}

fn context() -> egui::Context {
    let ctx = egui::Context::default();
    let mut fonts = FontDefinitions::empty();
    fonts.font_data.insert("text".to_owned(), Arc::new(FontData::from_static(epaint_default_fonts::UBUNTU_LIGHT)));
    fonts.families.insert(FontFamily::Proportional, vec!["text".to_owned()]);
    fonts.families.insert(FontFamily::Monospace, vec!["text".to_owned()]);
    ctx.set_fonts(fonts);
    ctx.options_mut(|options| options.max_passes = NonZeroUsize::MIN);
    ctx.enable_accesskit();
    ctx
}

fn raw(tick: u64, size: [f32; 2], events: Vec<egui::Event>) -> egui::RawInput {
    egui::RawInput {
        screen_rect: Some(egui::Rect::from_min_size(Pos2::ZERO, size.into())),
        time: Some(tick as f64 / 60.0),
        predicted_dt: 1.0 / 60.0,
        focused: true,
        events,
        ..egui::RawInput::default()
    }
}

/// What a node reads as: its label, or a text label's value.
fn text_of(node: &Node) -> Option<&str> {
    node.label().or_else(|| node.value())
}

fn node_by_label<'a>(update: &'a TreeUpdate, label: &str) -> Option<&'a Node> {
    update.nodes.iter().map(|(_, node)| node).find(|node| text_of(node) == Some(label))
}

fn label_of(update: &TreeUpdate, id: NodeId) -> Option<String> {
    update.nodes.iter().find(|(node_id, _)| *node_id == id).and_then(|(_, node)| text_of(node).map(str::to_owned))
}

fn labels(update: &TreeUpdate) -> Vec<String> {
    update.nodes.iter().filter_map(|(_, node)| text_of(node).map(str::to_owned)).collect()
}

/// Ticks for a section opened on this tick to finish unfolding (egui animates it).
const UNFOLD_TICKS: usize = 20;

/// A click at the centre of the node labelled `label`.
fn click(update: &TreeUpdate, label: &str) -> Vec<egui::Event> {
    let node = node_by_label(update, label).unwrap_or_else(|| panic!("no node {label:?} in {:?}", labels(update)));
    let bounds = node.bounds().expect("the node has a rect");
    let at = Pos2::new(((bounds.x0 + bounds.x1) / 2.0) as f32, ((bounds.y0 + bounds.y1) / 2.0) as f32);
    let button = |pressed| egui::Event::PointerButton {
        pos: at,
        button: egui::PointerButton::Primary,
        pressed,
        modifiers: egui::Modifiers::NONE,
    };
    vec![egui::Event::PointerMoved(at), button(true), button(false)]
}

fn press(key: egui::Key) -> Vec<egui::Event> {
    vec![egui::Event::Key { key, physical_key: None, pressed: true, repeat: false, modifiers: egui::Modifiers::NONE }]
}

fn tap(key: &str) -> Injection {
    Injection { tap: vec![key.to_owned()], ..Injection::default() }
}

/// The panel over a map, one tick per step: egui events for the clicks, an injection for what the
/// tick's merged input holds.
struct Panel {
    ctx: egui::Context,
    state: ControlsPanel,
    merger: InputMerger,
    map: ActionMap,
    tick: u64,
    size: [f32; 2],
    update: TreeUpdate,
    shapes: Vec<String>,
}

impl Panel {
    fn new(size: [f32; 2]) -> Panel {
        let mut panel = Panel {
            ctx: context(),
            state: ControlsPanel::default(),
            merger: InputMerger::default(),
            map: game(),
            tick: 0,
            size,
            update: TreeUpdate {
                nodes: Vec::new(),
                tree: None,
                tree_id: egui::accesskit::TreeId::ROOT,
                focus: NodeId(0),
            },
            shapes: Vec::new(),
        };
        panel.step(Vec::new(), Injection::default());
        panel.step(Vec::new(), Injection::default());
        panel
    }

    fn step(&mut self, events: Vec<egui::Event>, injection: Injection) -> Vec<ControlsChange> {
        self.merger.inject(&injection);
        let input: TickInput = self.merger.next_tick();
        let labels = KeyLabels::new();
        let view = ControlsView::new(&self.map, &input, &labels, Device::KeyboardMouse);
        let mut changes = Vec::new();
        let state = &mut self.state;
        let mut output = self.ctx.run_ui(raw(self.tick, self.size, events), |ui| {
            changes = controls_panel(ui, state, &view);
        });
        output.textures_delta.clear();
        self.tick += 1;
        self.shapes = output.shapes.iter().map(|shape| format!("{shape:?}")).collect();
        self.update = output.platform_output.accesskit_update.expect("AccessKit is on");
        changes
    }

    fn click(&mut self, label: &str) -> Vec<ControlsChange> {
        let events = click(&self.update, label);
        self.step(events, Injection::default())
    }

    fn quiet(&mut self) -> Vec<ControlsChange> {
        self.step(Vec::new(), Injection::default())
    }

    /// Open the Accessibility section and let it unfold; answers what the ticks answered.
    fn open_access(&mut self) -> Vec<ControlsChange> {
        let mut changes = self.click("Accessibility");
        for _ in 0..UNFOLD_TICKS {
            changes.extend(self.quiet());
        }
        changes
    }

    fn focused(&self) -> Option<String> {
        label_of(&self.update, self.update.focus)
    }
}

#[test]
fn click_rebind_jump_then_press_key_j_answers_the_rebind() {
    let mut panel = Panel::new(SCREEN);
    assert!(node_by_label(&panel.update, "Rebind Jump").is_some(), "{:?}", labels(&panel.update));
    assert_eq!(panel.click("Rebind Jump"), [ControlsChange::Listen(JUMP, 0)]);
    assert!(panel.quiet().is_empty(), "nothing pressed, nothing answered");
    assert!(
        labels(&panel.update).iter().any(|label| label == "Press a key or button for Jump (Escape cancels)"),
        "listen mode says what it waits for: {:?}",
        labels(&panel.update)
    );
    let changes = panel.step(Vec::new(), tap("KeyJ"));
    assert_eq!(changes, [ControlsChange::Rebind(JUMP, 0, key("KeyJ"))]);
    assert_eq!(changes[0].binding().map(|binding| binding.wire()).as_deref(), Some("key:KeyJ"));
    assert!(panel.quiet().is_empty(), "listen mode ended with the answer");

    // The second slot has its own label.
    assert_eq!(panel.click("Rebind Jump (2)"), [ControlsChange::Listen(JUMP, 1)]);
}

#[test]
fn a_conflict_shows_the_prompt_naming_move_and_answers_nothing_until_swap() {
    let mut panel = Panel::new(SCREEN);
    panel.click("Rebind Jump");
    assert!(panel.step(Vec::new(), tap("KeyW")).is_empty(), "a conflict answers nothing yet");
    let prompt = labels(&panel.update).into_iter().find(|label| label.contains("is used by"));
    assert_eq!(prompt.as_deref(), Some("W is used by Move"), "{:?}", labels(&panel.update));
    for _ in 0..3 {
        assert!(panel.quiet().is_empty());
    }
    assert!(panel.step(Vec::new(), tap("KeyK")).is_empty(), "the prompt captures nothing");
    let changes = panel.click("Swap");
    assert_eq!(changes, [ControlsChange::Swap(JUMP, 0, key("KeyW"))]);

    // The answer applies: jump takes W, move's WASD takes the Space jump gave up.
    let mut map = game();
    assert_eq!(map.rebind_swap(JUMP, 0, key("KeyW")).expect("the swap applies"), Some(MOVE));
    assert_eq!(map.bindings(JUMP)[0], key("KeyW"));
    assert_eq!(map.bindings(MOVE)[0].wire(), "keys4:Space,KeyS,KeyA,KeyD");
    assert!(panel.quiet().is_empty(), "the prompt is gone");
}

#[test]
fn cancel_and_escape_leave_listen_mode_and_the_prompt() {
    let mut panel = Panel::new(SCREEN);
    panel.click("Rebind Jump");
    assert_eq!(panel.step(Vec::new(), tap("Escape")), [ControlsChange::Cancel]);
    assert!(panel.step(Vec::new(), tap("KeyJ")).is_empty(), "no longer listening");
    panel.click("Rebind Jump");
    panel.step(Vec::new(), tap("KeyW"));
    assert_eq!(panel.click("Cancel"), [ControlsChange::Cancel]);
    assert!(panel.quiet().is_empty());
    assert!(!labels(&panel.update).iter().any(|label| label.contains("is used by")), "the prompt closed");
}

#[test]
fn reserved_inputs_are_refused_while_listening_goes_on() {
    let mut panel = Panel::new(SCREEN);
    panel.click("Rebind Jump");
    let home = {
        let mut pad = genex_core::input::PadState { connected: true, ..genex_core::input::PadState::default() };
        pad.buttons[PadButton::Home.index()] = 1.0;
        Injection { pads: vec![(0, pad)], ..Injection::default() }
    };
    assert!(panel.step(Vec::new(), home).is_empty(), "the home button stays the system's");
    assert!(labels(&panel.update).iter().any(|label| label == "That input is kept by the system"));
    assert_eq!(panel.step(Vec::new(), tap("KeyJ")), [ControlsChange::Rebind(JUMP, 0, key("KeyJ"))]);
}

#[test]
fn the_panel_is_keyboard_reachable_down_to_reset_on_a_short_screen() {
    let mut panel = Panel::new([480.0, 200.0]);
    let mut tabs = 0;
    while panel.focused().as_deref() != Some("Reset controls") {
        assert!(tabs < TABS_MAX, "Reset is reachable with Tab");
        panel.step(press(egui::Key::Tab), Injection::default());
        tabs += 1;
    }
    let reset = node_by_label(&panel.update, "Reset controls").and_then(Node::bounds).expect("Reset's rect");
    assert!(reset.y1 <= 200.0 + 0.5, "the body scrolled Reset into view: {reset:?}");
    assert_eq!(panel.step(press(egui::Key::Space), Injection::default()), [ControlsChange::Reset]);

    // Tab to the first rebind button and Space: listening starts, and that Space is not captured.
    let mut panel = Panel::new(SCREEN);
    while panel.focused().as_deref() != Some("Rebind Move") {
        panel.step(press(egui::Key::Tab), Injection::default());
    }
    let changes = panel.step(press(egui::Key::Space), tap("Space"));
    assert_eq!(changes, [ControlsChange::Listen(MOVE, 0)]);
    assert!(panel.quiet().is_empty(), "the Space that opened listen mode is not its answer");
}

#[test]
fn accessibility_changes_answer_a_whole_valid_access() {
    let mut panel = Panel::new(SCREEN);
    assert!(panel.open_access().is_empty(), "opening the section changes nothing");
    let changes = panel.click("Invert left stick Y");
    let mut expected = game().access().clone();
    expected.invert_y[0] = true;
    assert_eq!(changes, [ControlsChange::Access(expected.clone())]);
    let changes = panel.click("Toggle Jump");
    let mut toggled = game().access().clone();
    toggled.hold_mode.insert(JUMP, genex_input::access::HoldMode::Toggle);
    assert_eq!(changes, [ControlsChange::Access(toggled)], "each answer is from the map's own settings");
    assert!(node_by_label(&panel.update, "Toggle Move").is_none(), "hold mode is for button actions only");
}

/// One fixed script over the panel: its answers and every frame's shapes.
fn scripted_run() -> (Vec<ControlsChange>, Vec<Vec<String>>) {
    let mut panel = Panel::new(SCREEN);
    let mut changes = Vec::new();
    let mut frames = Vec::new();
    changes.extend(panel.click("Rebind Jump"));
    frames.push(panel.shapes.clone());
    changes.extend(panel.step(Vec::new(), tap("KeyW")));
    frames.push(panel.shapes.clone());
    changes.extend(panel.click("Swap"));
    frames.push(panel.shapes.clone());
    changes.extend(panel.open_access());
    changes.extend(panel.click("Swap sticks"));
    frames.push(panel.shapes.clone());
    (changes, frames)
}

#[test]
fn two_runs_of_one_script_draw_and_answer_the_same() {
    let (first_changes, first_frames) = scripted_run();
    let (second_changes, second_frames) = scripted_run();
    assert_eq!(first_changes.len(), 3, "{first_changes:?}");
    assert_eq!(first_changes, second_changes);
    assert_eq!(first_frames, second_frames);
}

// ---- the touch-control painter -----------------------------------------------------------------

const MOVE_STICK: ControlId = ControlId::new("move");
const JUMP_BUTTON: ControlId = ControlId::new("jump");
const DPAD: ControlId = ControlId::new("dpad");

fn layout() -> TouchControls {
    TouchControls::new()
        .stick(MOVE_STICK, Anchor::BottomLeft([160.0, 160.0]), 80.0, StickMode::Floating)
        .button(JUMP_BUTTON, "Jump", Anchor::BottomRight([120.0, 120.0]), 60.0)
        .dpad(DPAD, Anchor::TopRight([120.0, 120.0]), 160.0)
}

/// Paint `controls` over a world shown at `rect` with these fingers down; the tree and shapes.
fn paint(controls: &TouchControls, rect: egui::Rect, fingers: Vec<TouchPoint>) -> (TreeUpdate, Vec<String>) {
    let ctx = context();
    let mut state = TouchState::new(controls);
    let tick = TickInput { touches: fingers, ..TickInput::default() };
    let frame = evaluate_touch(controls, WORLD, &mut state, &tick);
    let mut last = None;
    for tick in 0..2 {
        let mut output = ctx.run_ui(raw(tick, SCREEN, Vec::new()), |ui| {
            paint_touch_controls(ui, controls, TouchArea { world: WORLD, rect }, &state, &frame);
        });
        output.textures_delta.clear();
        let shapes = output.shapes.iter().map(|shape| format!("{shape:?}")).collect();
        last = Some((output.platform_output.accesskit_update.expect("AccessKit is on"), shapes));
    }
    last.expect("two frames ran")
}

#[test]
fn each_touch_control_is_in_the_accesskit_tree_with_its_label_and_zone() {
    let controls = layout();
    let screen = egui::Rect::from_min_size(Pos2::ZERO, SCREEN.into());
    let (update, shapes) = paint(&controls, screen, Vec::new());
    assert!(!shapes.is_empty(), "the controls are drawn");
    for control in controls.controls() {
        let node = node_by_label(&update, &control.label)
            .unwrap_or_else(|| panic!("no node {:?} in {:?}", control.label, labels(&update)));
        let bounds = node.bounds().expect("a rect");
        let [x0, y0, x1, y1] = control.zone(WORLD).map(f64::from);
        assert_eq!([bounds.x0, bounds.y0, bounds.x1, bounds.y1], [x0, y0, x1, y1], "{}", control.label);
    }
    assert_eq!(
        controls.controls().iter().map(|control| control.label.as_str()).collect::<Vec<_>>(),
        ["move", "Jump", "dpad"],
        "a stick and a d-pad are labelled by their id"
    );

    // A world shown at half size in a corner: each rect is its zone mapped into that rect.
    let half = egui::Rect::from_min_size(Pos2::new(100.0, 50.0), egui::vec2(640.0, 360.0));
    let (update, _) = paint(&controls, half, Vec::new());
    let bounds = node_by_label(&update, "Jump").and_then(Node::bounds).expect("Jump's rect");
    let [x0, y0, x1, y1] = controls.controls()[1].zone(WORLD);
    let mapped = [100.0 + x0 / 2.0, 50.0 + y0 / 2.0, 100.0 + x1 / 2.0, 50.0 + y1 / 2.0].map(f64::from);
    assert_eq!([bounds.x0, bounds.y0, bounds.x1, bounds.y1], mapped);
}

#[test]
fn a_held_control_is_drawn_differently_and_the_same_on_every_run() {
    let controls = layout();
    let screen = egui::Rect::from_min_size(Pos2::ZERO, SCREEN.into());
    let jump_centre = controls.controls()[1].centre(WORLD);
    let finger = TouchPoint { id: 1, x: jump_centre[0], y: jump_centre[1], phase: TouchPhase::Began };
    let (_, idle) = paint(&controls, screen, Vec::new());
    let (_, held) = paint(&controls, screen, vec![finger]);
    let (_, held_again) = paint(&controls, screen, vec![finger]);
    assert_ne!(idle, held, "holding Jump changes what is drawn");
    assert_eq!(held, held_again, "deterministic over two runs");
}

#[test]
fn a_glyph_is_a_labelled_cap() {
    let ctx = context();
    let glyph = Glyph { label: "Cross".to_owned(), shape: GlyphShape::FaceButton, device: Device::KeyboardMouse };
    let mut update = None;
    for tick in 0..2 {
        let mut output = ctx.run_ui(raw(tick, SCREEN, Vec::new()), |ui| {
            glyph_ui(ui, &glyph);
        });
        output.textures_delta.clear();
        update = output.platform_output.accesskit_update;
    }
    let update = update.expect("AccessKit is on");
    assert!(node_by_label(&update, "Cross").is_some(), "{:?}", labels(&update));
}
