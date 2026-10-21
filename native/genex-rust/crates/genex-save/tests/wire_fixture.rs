//! UIS-15: the host's saves contract (`shared/game-saves.ts`) and this crate's codes and slot
//! names are one table, held together through `tests/fixtures/native-saves.json`: every
//! `SaveErrorCode` in order, the restore issue, the caps, and every slot name the host refuses as
//! unsafe is one this crate refuses too (`save-slot-invalid`).

use genex_save::envelope::LABEL_CHARS_MAX;
use genex_save::error::{SAVE_RESTORE_DIVERGED, SaveErrorCode};
use genex_save::slot::{SLOT_NAME_MAX, SlotName};
use serde_json::Value;

/// The fixture the host's tests read too.
const FIXTURE: &str = include_str!("../../../../../tests/fixtures/native-saves.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("native-saves.json is JSON")
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    value[key].as_array().unwrap_or_else(|| panic!("{key} is a list")).iter().map(|v| v.as_str().expect("a string").to_owned()).collect()
}

#[test]
fn save_error_codes_are_the_hosts_in_order() {
    let wires: Vec<String> = SaveErrorCode::ALL.iter().map(|code| code.wire().to_owned()).collect();
    assert_eq!(wires, strings(&fixture(), "saveErrorCodes"));
    for code in SaveErrorCode::ALL {
        assert_eq!(SaveErrorCode::from_wire(code.wire()), Some(code));
    }
    assert_eq!(fixture()["saveRestoreDiverged"], SAVE_RESTORE_DIVERGED);
}

#[test]
fn caps_are_the_hosts() {
    let fixture = fixture();
    assert_eq!(fixture["slotNameMax"].as_u64(), Some(SLOT_NAME_MAX as u64));
    assert_eq!(fixture["labelCharsMax"].as_u64(), Some(LABEL_CHARS_MAX as u64));
}

#[test]
fn a_slot_name_the_host_refuses_is_refused_here_too() {
    let fixture = fixture();
    for name in strings(&fixture, "unsafeSlotNames") {
        let refused = SlotName::lookup(&name).expect_err(&format!("{name:?} is refused"));
        assert_eq!(refused.code, SaveErrorCode::SlotInvalid, "{name:?}");
    }
    for name in strings(&fixture, "safeSlotNames") {
        assert!(SlotName::lookup(&name).is_ok(), "{name:?} is a slot name");
    }
}
