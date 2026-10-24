//! The opt-in prompt atlas index (IN-16, release R-26): a binding's cell by its wire spelling (a
//! pad button's by its family too), the action's cell follows the prompt's binding, and a hostile
//! index is refused whole with a typed problem. Every row is new behaviour: before R-26 the atlas
//! module was a stub. The rows use a small made-up index; the Kenney atlas itself is an asset.

use genex_input::atlas::{ATLAS_CELL_PX, ATLAS_CELLS_MAX, ATLAS_INDEX_BYTES_MAX, AtlasProblem, GlyphAtlas, cell_name};
use genex_input::binding::{Binding, ChordInput, KeyCode, PadButton, PadFamily, Stick};
use genex_input::id::{ActionId, ContextId, ControlId};
use genex_input::map::{ActionMap, Context};
use genex_input::state::Device;
use serde_json::{Value, json};

const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");
const MOVE: ActionId = ActionId::new("move");

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn index() -> Value {
    json!({
        "format": "genex-glyph-atlas/1",
        "cell": 64,
        "size": [256, 128],
        "cells": {
            "key:Space": [0, 0],
            "pad:south@playstation": [64, 0],
            "pad:south@xbox": [128, 0],
            "stick:left": [192, 0],
            "dpad": [0, 64],
        },
    })
}

fn atlas() -> GlyphAtlas {
    GlyphAtlas::from_index(index().to_string().as_bytes()).expect("the made-up index loads")
}

#[test]
fn a_binding_names_its_cell_by_wire_spelling_and_a_pad_button_by_family() {
    let rows: [(Binding, Option<&str>); 9] = [
        (key("KeyW"), Some("key:KeyW")),
        (key("Mouse1"), Some("key:Mouse1")),
        (Binding::Pad(PadButton::South), Some("pad:south@playstation")),
        (Binding::Stick(Stick::Left), Some("stick:left")),
        (Binding::Dpad, Some("dpad")),
        (Binding::WASD, None),
        (Binding::chord(&[ChordInput::Key(KeyCode::of("ShiftLeft")), ChordInput::Key(KeyCode::of("KeyF"))]).expect("a chord"), None),
        (Binding::Touch(ControlId::new("jump")), None),
        (Binding::Look, None),
    ];
    for (binding, name) in rows {
        assert_eq!(cell_name(&binding, PadFamily::PlayStation).as_deref(), name, "{binding:?}");
    }
}

#[test]
fn pad_south_on_a_playstation_pad_draws_its_own_cell_and_text_glyphs_stay_for_the_rest() {
    let atlas = atlas();
    assert_eq!(atlas.size(), [256, 128]);
    assert_eq!(atlas.len(), 5);
    let south = Binding::Pad(PadButton::South);
    assert_eq!(atlas.binding_uv(&south, PadFamily::PlayStation), Some([0.25, 0.0, 0.5, 0.5]));
    assert_eq!(atlas.binding_uv(&south, PadFamily::Xbox), Some([0.5, 0.0, 0.75, 0.5]));
    assert_eq!(atlas.binding_uv(&south, PadFamily::Nintendo), None, "no Nintendo cell: the text glyph stays");
    assert_eq!(atlas.binding_uv(&key("KeyW"), PadFamily::Generic), None);

    let map = ActionMap::new().context(
        Context::new(PLAY, 0)
            .button(JUMP, &[key("Space"), Binding::Pad(PadButton::South)])
            .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)]),
    );
    assert_eq!(atlas.action_uv(&map, JUMP, Device::Pad(PadFamily::PlayStation)), Some([0.25, 0.0, 0.5, 0.5]));
    assert_eq!(atlas.action_uv(&map, JUMP, Device::KeyboardMouse), Some([0.0, 0.0, 0.25, 0.5]));
    assert_eq!(atlas.action_uv(&map, MOVE, Device::KeyboardMouse), None, "WASD has no single icon");
    assert_eq!(atlas.action_uv(&map, MOVE, Device::Pad(PadFamily::Xbox)), Some([0.75, 0.0, 1.0, 0.5]));
    assert_eq!(atlas.action_uv(&map, ActionId::new("unknown"), Device::KeyboardMouse), None);
}

#[test]
fn a_hostile_index_is_refused_whole() {
    let edit = |change: &dyn Fn(&mut Value)| {
        let mut value = index();
        change(&mut value);
        value.to_string().into_bytes()
    };
    let too_many: serde_json::Map<String, Value> =
        (0..=ATLAS_CELLS_MAX).map(|at| (format!("key:K{at}"), json!([0, 0]))).collect();
    let rows: Vec<(&str, Vec<u8>, AtlasProblem)> = vec![
        ("not JSON", b"{\"format\":".to_vec(), AtlasProblem::NotJson),
        ("over the size cap", vec![b' '; ATLAS_INDEX_BYTES_MAX + 1], AtlasProblem::NotJson),
        ("another format", edit(&|v| v["format"] = json!("genex-glyph-atlas/2")), AtlasProblem::Format),
        ("another cell size", edit(&|v| v["cell"] = json!(32)), AtlasProblem::Format),
        ("a size off the grid", edit(&|v| v["size"] = json!([250, 128])), AtlasProblem::Size),
        ("a zero side", edit(&|v| v["size"] = json!([0, 128])), AtlasProblem::Size),
        ("a side past the cap", edit(&|v| v["size"] = json!([4096, 128])), AtlasProblem::Size),
        ("a side past u32", edit(&|v| v["size"] = json!([u64::MAX, 128])), AtlasProblem::Size),
        ("a negative side", edit(&|v| v["size"] = json!([-64, 128])), AtlasProblem::Size),
        ("no cells", edit(&|v| v["cells"] = json!({})), AtlasProblem::Cells),
        ("cells as a list", edit(&|v| v["cells"] = json!([[0, 0]])), AtlasProblem::Cells),
        ("too many cells", edit(&|v| v["cells"] = Value::Object(too_many.clone())), AtlasProblem::Cells),
        ("two names on one cell", edit(&|v| v["cells"]["key:KeyW"] = json!([0, 0])), AtlasProblem::Cells),
        ("an empty name", edit(&|v| v["cells"][""] = json!([0, 64])), AtlasProblem::CellName),
        ("a name with a space", edit(&|v| v["cells"]["key: Space"] = json!([64, 64])), AtlasProblem::CellName),
        ("a name with a newline", edit(&|v| v["cells"]["key:\nW"] = json!([64, 64])), AtlasProblem::CellName),
        ("a name past the cap", edit(&|v| v["cells"]["k".repeat(49)] = json!([64, 64])), AtlasProblem::CellName),
        ("a cell off the grid", edit(&|v| v["cells"]["dpad"] = json!([10, 64])), AtlasProblem::CellRect),
        ("a cell leaving the image", edit(&|v| v["cells"]["dpad"] = json!([256, 64])), AtlasProblem::CellRect),
        ("a cell at u32's end", edit(&|v| v["cells"]["dpad"] = json!([u32::MAX - u32::MAX % ATLAS_CELL_PX, 0])), AtlasProblem::CellRect),
        ("a cell that is not a pair", edit(&|v| v["cells"]["dpad"] = json!([0, 64, 0])), AtlasProblem::CellRect),
    ];
    for (what, bytes, problem) in rows {
        assert_eq!(GlyphAtlas::from_index(&bytes), Err(problem), "{what}");
    }
    assert!(AtlasProblem::ALL.iter().all(|problem| AtlasProblem::from_wire(problem.as_str()) == Some(*problem)));
}
