//! UIS-15: the host's `uiSettings` contract (`shared/game-saves.ts`) and this crate's text codes,
//! scale range and locale tags are one table, held together through
//! `tests/fixtures/native-saves.json`: every `TextErrorCode` in order, the scale range, the tag
//! cap, and the locales the host passes or refuses by shape are the ones this crate parses or not.

use genex_ui::settings::scale::{UI_SCALE_MAX, UI_SCALE_MIN};
use genex_ui::text::catalog::TextErrorCode;
use genex_ui::text::locale::{LOCALE_TAG_CHARS_MAX, Locale};
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
fn text_error_codes_are_the_hosts_in_order() {
    let wires: Vec<String> = TextErrorCode::ALL.iter().map(|code| code.wire().to_owned()).collect();
    assert_eq!(wires, strings(&fixture(), "textErrorCodes"));
}

#[test]
fn scale_range_and_tag_cap_are_the_hosts() {
    let fixture = fixture();
    let range = fixture["uiScale"].as_array().expect("uiScale is a pair");
    assert_eq!(range[0].as_f64(), Some(f64::from(UI_SCALE_MIN)));
    assert_eq!(range[1].as_f64(), Some(f64::from(UI_SCALE_MAX)));
    assert_eq!(fixture["localeTagCharsMax"].as_u64(), Some(LOCALE_TAG_CHARS_MAX as u64));
}

#[test]
fn a_locale_the_host_passes_parses_and_one_it_refuses_does_not() {
    let fixture = fixture();
    for tag in strings(&fixture, "wellFormedLocales") {
        assert!(Locale::parse(&tag).is_some(), "{tag:?} parses");
    }
    for tag in strings(&fixture, "malformedLocales") {
        assert!(Locale::parse(&tag).is_none(), "{tag:?} is refused");
    }
}
