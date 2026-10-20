//! Localized text (UIS-6, new behaviour): Fluent catalogs loaded one locale at a time with no
//! isolation marks, plurals per locale, one `text-missing` issue per key, a broken file that keeps
//! its valid messages, the size and key caps, `xx-pseudo`, locale negotiation and number
//! formatting that is the same text on every target.

use genex_ui::text::args::{TEXT_ARGS_MAX, TextArgs};
use genex_ui::text::catalog::{Catalog, TEXT_FILE_BYTES_MAX, TEXT_KEYS_MAX, TextErrorCode, TextIssue};
use genex_ui::text::locale::{Locale, LocaleSource, negotiate};
use genex_ui::text::pseudo::{PSEUDO_LOCALE, pseudo};

const EN: &[u8] = include_bytes!("fixtures/lang/en.ftl");
const DE: &[u8] = include_bytes!("fixtures/lang/de.ftl");
const BROKEN: &[u8] = include_bytes!("fixtures/lang/broken.ftl");

fn locale(tag: &str) -> Locale {
    Locale::parse(tag).expect("a BCP-47 tag")
}

fn codes(issues: &[TextIssue]) -> Vec<(TextErrorCode, &str)> {
    issues.iter().map(|issue| (issue.code(), issue.subject())).collect()
}

#[test]
fn english_and_german_resolve_items_count_plurals_for_0_1_and_5() {
    let mut en = Catalog::load(locale("en"), EN);
    let mut de = Catalog::load(locale("de"), DE);
    let mut said = Vec::new();
    for n in [0, 1, 5] {
        let args = TextArgs::new().num("n", n);
        said.push((en.tr_args("items-count", &args), de.tr_args("items-count", &args)));
    }
    assert_eq!(
        said,
        [
            ("No items".to_owned(), "0 Gegenstände".to_owned()),
            ("1 item".to_owned(), "1 Gegenstand".to_owned()),
            ("5 items".to_owned(), "5 Gegenstände".to_owned()),
        ]
    );
    assert!(en.issues().is_empty() && de.issues().is_empty(), "{:?} {:?}", en.issues(), de.issues());
}

#[test]
fn output_never_carries_unicode_isolation_marks() {
    let mut en = Catalog::load(locale("en"), EN);
    let mut pseudo_catalog = Catalog::load_pseudo(locale("en"), EN);
    let args = TextArgs::new().num("n", 5).str("name", "Ada");
    for text in [
        en.tr_args("items-count", &args),
        en.tr_args("greeting", &args),
        en.tr_args("value", &args),
        pseudo_catalog.tr_args("items-count", &args),
        pseudo_catalog.tr_args("greeting", &args),
    ] {
        assert!(!text.contains(['\u{2068}', '\u{2069}']), "isolation marks in {text:?}");
    }
    assert_eq!(en.tr_args("greeting", &args), "Hello, Ada!");
}

#[test]
fn a_missing_key_returns_the_key_and_one_issue_per_key() {
    let mut en = Catalog::load(locale("en"), EN);
    for _ in 0..3 {
        assert_eq!(en.tr("no-such-key"), "no-such-key");
    }
    assert_eq!(en.tr("other-missing"), "other-missing");
    assert_eq!(en.tr("menu.no-such-attribute"), "menu.no-such-attribute");
    assert_eq!(
        codes(en.issues()),
        [(TextErrorCode::Missing, "no-such-key"), (TextErrorCode::Missing, "other-missing"), (TextErrorCode::Missing, "menu.no-such-attribute")]
    );
    let taken = en.take_issues();
    assert_eq!(taken.len(), 3);
    assert_eq!(en.tr("no-such-key"), "no-such-key");
    assert!(en.issues().is_empty(), "a key is reported once per loaded locale, not once per call");
    assert_eq!((en.tr("menu"), en.tr("menu.title")), ("Menu".to_owned(), "Main menu".to_owned()), "attributes read as message.attribute");
}

#[test]
fn a_broken_file_gives_text_invalid_with_its_line_and_keeps_the_valid_messages() {
    let mut catalog = Catalog::load(locale("en"), BROKEN);
    let issues = catalog.take_issues();
    assert_eq!(issues.len(), 1, "{issues:?}");
    assert_eq!((issues[0].code(), issues[0].line()), (TextErrorCode::Invalid, Some(3)));
    assert_eq!((catalog.tr("good-one"), catalog.tr("good-two")), ("Fine".to_owned(), "Also fine".to_owned()));
    assert_eq!(catalog.len(), 2);

    let not_utf8 = b"ok = fine\nbad = \xff\xfe\n";
    let issues = Catalog::load(locale("en"), not_utf8).take_issues();
    assert_eq!(codes(&issues), [(TextErrorCode::Invalid, "en")]);
    assert_eq!(issues[0].line(), Some(2));

    let mut bom = b"\xef\xbb\xbf".to_vec();
    bom.extend_from_slice(b"play = Play\n");
    assert_eq!(Catalog::load(locale("en"), &bom).tr("play"), "Play", "a UTF-8 byte-order mark is not text");
}

#[test]
fn a_300_kib_file_or_too_many_keys_gives_text_too_large_and_loads_nothing() {
    let mut big = b"play = Play\n".to_vec();
    big.resize(300 * 1024, b'#');
    assert!(big.len() > TEXT_FILE_BYTES_MAX);
    let mut catalog = Catalog::load(locale("en"), &big);
    assert_eq!(codes(&catalog.take_issues()), [(TextErrorCode::TooLarge, "en")]);
    assert_eq!((catalog.len(), catalog.tr("play")), (0, "play".to_owned()));

    let many: String = (0..=TEXT_KEYS_MAX).map(|n| format!("k{n} = x\n")).collect();
    assert!(many.len() <= TEXT_FILE_BYTES_MAX);
    let mut catalog = Catalog::load(locale("en"), many.as_bytes());
    assert_eq!(codes(&catalog.take_issues()), [(TextErrorCode::TooLarge, "en")]);
    assert_eq!(catalog.len(), 0);

    let at_cap: String = (0..TEXT_KEYS_MAX).map(|n| format!("k{n} = x\n")).collect();
    let catalog = Catalog::load(locale("en"), at_cap.as_bytes());
    assert!(catalog.issues().is_empty());
    assert_eq!(catalog.len(), TEXT_KEYS_MAX);
}

#[test]
fn xx_pseudo_is_stable_wider_and_leaves_numbers_alone() {
    assert_eq!(pseudo("Play"), "[Pĺàý~~]");
    assert_eq!(pseudo("Play"), pseudo("Play"));
    let mut catalog = Catalog::load_pseudo(locale("en"), EN);
    assert_eq!(catalog.locale().tag(), PSEUDO_LOCALE);
    assert_eq!(catalog.tr("play"), pseudo("Play"));
    for source in ["Play", "Resume", "Main menu", "A much longer sentence that a button would have to fit"] {
        let wide = pseudo(source);
        let ratio = wide.chars().count() as f64 / source.chars().count() as f64;
        assert!(ratio >= 1.4, "{source:?} -> {wide:?} is only {ratio:.2}x");
    }
    let five = catalog.tr_args("items-count", &TextArgs::new().num("n", 5));
    assert!(five.contains('5') && five.starts_with('[') && five.ends_with(']'), "{five}");
    assert_eq!(five, "[5 îţémš~~~]", "plurals follow the base locale, digits stay digits");
    assert!(catalog.issues().is_empty());
}

#[test]
fn numbers_format_to_the_same_text_on_every_target() {
    let mut en = Catalog::load(locale("en"), EN);
    let cases: [(f64, &str); 9] = [
        (0.0, "0"),
        (1.0, "1"),
        (-3.0, "-3"),
        (1.5, "1.5"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1_234_567.891, "1234567.891"),
        (1e21, "1000000000000000000000"),
        (2.5e-7, "0.00000025"),
        (-0.0, "-0"),
    ];
    for (n, text) in cases {
        assert_eq!(en.tr_args("value", &TextArgs::new().num("n", n)), text, "{n:e}");
    }
    let mut de = Catalog::load(locale("de"), DE);
    assert_eq!(de.tr_args("value", &TextArgs::new().num("n", 1_234_567.891)), "1234567.891", "no locale grouping in v1");
}

#[test]
fn argument_problems_report_text_invalid_once_per_key() {
    let mut en = Catalog::load(locale("en"), EN);
    assert_eq!(en.tr("greeting"), "Hello, {$name}!");
    assert_eq!(en.tr("greeting"), "Hello, {$name}!");
    let mut args = TextArgs::new();
    for n in 0..=TEXT_ARGS_MAX {
        args = args.num(&format!("a{n}"), 1);
    }
    assert_eq!((args.len(), args.dropped()), (TEXT_ARGS_MAX, 1));
    assert_eq!(en.tr_args("play", &args), "Play");
    assert_eq!(codes(en.issues()), [(TextErrorCode::Invalid, "greeting"), (TextErrorCode::Invalid, "play")]);
    let replaced = TextArgs::new().num("n", 1).num("n", 2);
    assert_eq!((replaced.len(), en.tr_args("value", &replaced)), (1, "2".to_owned()), "a name set twice keeps the last value");
}

#[test]
fn switching_locale_drops_the_old_bundle() {
    let mut catalog = Catalog::load(locale("en"), EN);
    assert_eq!(catalog.tr("only-en"), "English only");
    assert_eq!(catalog.tr("gone-before"), "gone-before");
    catalog.switch(locale("de"), DE);
    assert_eq!(catalog.locale().tag(), "de");
    assert_eq!(catalog.tr("play"), "Spielen");
    assert_eq!(catalog.tr("only-en"), "only-en", "nothing of the English bundle is left");
    assert_eq!(catalog.tr("gone-before"), "gone-before");
    assert_eq!(
        codes(catalog.issues()),
        [(TextErrorCode::Missing, "gone-before"), (TextErrorCode::Missing, "only-en"), (TextErrorCode::Missing, "gone-before")],
        "a switch keeps untaken issues and reports each key again for the new locale"
    );
    assert_eq!(catalog.len(), 5);
}

#[test]
fn locales_parse_as_bcp_47_and_canonicalize() {
    assert_eq!(locale("EN-us").tag(), "en-US");
    assert_eq!(locale("de_AT").tag(), "de-AT");
    assert_eq!(locale("de-AT").language(), "de");
    assert!(locale(PSEUDO_LOCALE).is_pseudo());
    assert_eq!(Locale::pseudo().tag(), PSEUDO_LOCALE);
    assert!(!locale("en").is_pseudo());
    for hostile in ["", "und", "!!", "e", "en-", "a-very-long-tag-that-is-not-a-language-at-all-and-keeps-going-past-the-cap", "en\u{0}"] {
        assert!(Locale::parse(hostile).is_none(), "{hostile:?} parsed");
    }
}

#[test]
fn negotiation_takes_the_choice_then_the_os_locale_then_the_first_listed() {
    let offered = [locale("en"), locale("de"), Locale::pseudo()];
    let pick = |choice: Option<&str>, os: Option<&str>| {
        let negotiated = negotiate(&offered, choice, os).expect("locales offered");
        let issue = negotiated.issue().map(|issue| (issue.code(), issue.subject().to_owned()));
        (negotiated.locale().tag().to_owned(), negotiated.source(), issue)
    };
    assert_eq!(pick(Some("de"), Some("en-US")), ("de".into(), LocaleSource::Choice, None));
    assert_eq!(pick(Some("de-AT"), None), ("de".into(), LocaleSource::Choice, None), "the language matches without the region");
    assert_eq!(pick(None, Some("de_DE")), ("de".into(), LocaleSource::Os, None));
    assert_eq!(pick(None, Some("fr-FR")), ("en".into(), LocaleSource::Fallback, None), "an unoffered OS locale is not an issue");
    assert_eq!(pick(None, None), ("en".into(), LocaleSource::Fallback, None));
    assert_eq!(pick(Some(PSEUDO_LOCALE), None), (PSEUDO_LOCALE.into(), LocaleSource::Choice, None));
    let unknown = Some((TextErrorCode::LocaleUnknown, "fr".to_owned()));
    assert_eq!(pick(Some("fr"), Some("de")), ("de".into(), LocaleSource::Os, unknown), "an unoffered choice falls through and says so");
    let not_pseudo = Some((TextErrorCode::LocaleUnknown, "xx".to_owned()));
    assert_eq!(pick(Some("xx"), None), ("en".into(), LocaleSource::Fallback, not_pseudo), "only the exact tag picks xx-pseudo");
    let garbage = Some((TextErrorCode::LocaleUnknown, "!!".to_owned()));
    assert_eq!(pick(Some("!!"), None), ("en".into(), LocaleSource::Fallback, garbage));
    assert!(negotiate(&[], Some("en"), None).is_none(), "nothing offered");
    let regional = [locale("en-GB"), locale("en-US")];
    let negotiated = negotiate(&regional, Some("en-US"), None).expect("offered");
    assert_eq!(negotiated.locale().tag(), "en-US", "an exact match beats a language match");
}

#[test]
fn text_error_codes_round_trip_their_wire_spelling() {
    let wires: Vec<&str> = TextErrorCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(wires, ["text-missing", "text-invalid", "text-too-large", "text-locale-unknown", "text-font-missing"]);
    for code in TextErrorCode::ALL {
        assert_eq!(TextErrorCode::from_wire(code.wire()), Some(*code));
    }
    assert_eq!(TextErrorCode::from_wire("text-other"), None);
    let sources: Vec<&str> = LocaleSource::ALL.iter().map(|source| source.wire()).collect();
    assert_eq!(sources, ["choice", "os", "fallback"]);
}
