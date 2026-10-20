//! UIS-3: a slot of an older schema migrates forward one step at a time, in order, over the game's
//! sections only; a gap, a failing step and a newer slot refuse with their codes; the chain a game
//! registers is checked at install.

use std::cell::RefCell;
use std::rc::Rc;

use genex_save::envelope::{Envelope, decode};
use genex_save::error::SaveErrorCode;
use genex_save::index::SlotState;
use genex_save::migrate::{MIGRATION_STEPS_MAX, Migrations, MigrationsInvalid};
use serde_json::{Value, json};

/// The schema-1 golden UIS-2 committed (`tests/envelope.rs` builds it).
const GOLDEN_SCHEMA1: &[u8] = include_bytes!("goldens/schema1.sav");

fn golden() -> Envelope {
    decode(GOLDEN_SCHEMA1).expect("the schema-1 golden decodes")
}

/// Schema 3's chain: 1->2 renames `world.hp` to `health`, 2->3 gives `quests` a `log`. Each step
/// records its `from` in `seen`.
fn chain(seen: &Rc<RefCell<Vec<u32>>>) -> Migrations {
    let (one, two) = (Rc::clone(seen), Rc::clone(seen));
    Migrations::new(3)
        .step(2, move |mut game: Value| {
            two.borrow_mut().push(2);
            game["quests"]["log"] = json!(["migrated"]);
            Ok(game)
        })
        .step(1, move |mut game: Value| {
            one.borrow_mut().push(1);
            let hp = game["world"].as_object_mut().and_then(|world| world.remove("hp")).unwrap_or(Value::Null);
            game["world"]["health"] = hp;
            Ok(game)
        })
}

#[test]
fn the_schema_1_golden_migrates_1_2_3_in_order_over_the_game_sections_only() {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let migrations = chain(&seen);
    assert_eq!(migrations.check(), Ok(()));
    let slot = golden();
    let nav_before = slot.sections["genex.nav"].clone();
    let migrated = migrations.migrate(slot).expect("migrates");
    assert_eq!(*seen.borrow(), [1, 2], "steps run in schema order, whatever order they were registered in");
    assert_eq!(migrated.schema, 3);
    assert_eq!(migrated.sections["world"], json!({"name": "hero", "pos": [1.5, 0.0, -3.25], "health": 10}));
    assert_eq!(migrated.sections["quests"], json!({"done": ["intro"], "log": ["migrated"]}));
    assert_eq!(migrated.sections["genex.nav"], nav_before, "built-in sections never reach a game's step");
    let keys: Vec<&str> = migrated.sections.keys().map(String::as_str).collect();
    assert_eq!(keys, ["genex.nav", "world", "quests"]);
    assert_eq!((migrated.tick, migrated.seed, migrated.rng), (600, 7, golden().rng), "the sim position is kept");
}

#[test]
fn a_slot_at_the_games_schema_migrates_through_no_step() {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let mut slot = golden();
    slot.schema = 3;
    let same = chain(&seen).migrate(slot.clone()).expect("nothing to do");
    assert_eq!(same, slot);
    assert!(seen.borrow().is_empty());
}

#[test]
fn a_gap_in_the_chain_is_save_migration_missing() {
    let migrations = Migrations::new(3).step(2, Ok);
    let refusal = migrations.migrate(golden()).expect_err("no step from 1");
    assert_eq!(refusal.code, SaveErrorCode::MigrationMissing);
    assert!(refusal.detail.contains('1'), "the missing step is named: {}", refusal.detail);
}

#[test]
fn a_failing_step_is_save_migration_failed_with_the_step_named() {
    let migrations = Migrations::new(3).step(1, Ok).step(2, |_| Err("quests are unreadable".to_owned()));
    let refusal = migrations.migrate(golden()).expect_err("step 2 fails");
    assert_eq!(refusal.code, SaveErrorCode::MigrationFailed);
    assert!(refusal.detail.contains("2 -> 3"), "the step is named: {}", refusal.detail);
    assert!(refusal.detail.contains("quests are unreadable"));
    let not_object = Migrations::new(2).step(1, |_| Ok(json!([1])));
    assert_eq!(not_object.migrate(golden()).map_err(|e| e.code), Err(SaveErrorCode::MigrationFailed));
    let writes_builtin = Migrations::new(2).step(1, |mut game: Value| {
        game["genex.nav"] = json!({});
        Ok(game)
    });
    assert_eq!(writes_builtin.migrate(golden()).map_err(|e| e.code), Err(SaveErrorCode::MigrationFailed));
}

#[test]
fn a_schema_4_slot_under_a_schema_3_game_is_newer_and_refuses_save_newer() {
    let migrations = Migrations::new(3).step(1, Ok).step(2, Ok);
    let mut slot = golden();
    slot.schema = 4;
    assert_eq!(migrations.state_of(4), SlotState::Newer);
    assert_eq!(migrations.state_of(3), SlotState::Ready);
    assert_eq!(migrations.state_of(1), SlotState::NeedsMigration);
    assert_eq!(migrations.migrate(slot).map_err(|e| e.code), Err(SaveErrorCode::Newer));
}

#[test]
fn a_chain_is_checked_at_install() {
    let mut too_many = Migrations::new(100);
    for from in 1..=u32::try_from(MIGRATION_STEPS_MAX).expect("small") + 1 {
        too_many = too_many.step(from, Ok);
    }
    let rows: Vec<(&str, Migrations, MigrationsInvalid)> = vec![
        ("schema 0", Migrations::new(0), MigrationsInvalid::SchemaZero),
        ("a step from 0", Migrations::new(2).step(0, Ok), MigrationsInvalid::StepOutOfRange(0)),
        ("a step at the schema", Migrations::new(2).step(2, Ok), MigrationsInvalid::StepOutOfRange(2)),
        ("a step above the schema", Migrations::new(2).step(5, Ok), MigrationsInvalid::StepOutOfRange(5)),
        ("a gap", Migrations::new(5).step(1, Ok).step(3, Ok).step(4, Ok), MigrationsInvalid::Gap { missing: 2 }),
        ("a repeated step", Migrations::new(3).step(1, Ok).step(1, Ok), MigrationsInvalid::Repeated(1)),
        ("too many steps", too_many, MigrationsInvalid::TooMany),
    ];
    for (row, migrations, expected) in rows {
        assert_eq!(migrations.check(), Err(expected), "{row}");
    }
    assert_eq!(Migrations::new(1).check(), Ok(()), "schema 1 needs no step");
    assert_eq!(Migrations::new(4).step(2, Ok).step(3, Ok).check(), Ok(()), "a chain may start above 1");
}
