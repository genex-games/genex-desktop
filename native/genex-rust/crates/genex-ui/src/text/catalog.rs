//! Catalog: one locale's Fluent messages, looked up by key, and the text issues they raised.
//!
//! A catalog holds one locale at a time (`assets/lang/<locale>.ftl`); switching drops the old
//! bundle, so nothing of the previous locale is left to fall back on. Unicode isolation marks are
//! off (the HUD fonts have no glyphs for U+2068/2069). A missing key draws the key itself and
//! raises one `text-missing` issue per key, not one per call; a file with broken entries keeps its
//! valid messages and raises `text-invalid` with each broken entry's line; a file over
//! [`TEXT_FILE_BYTES_MAX`] or with more than [`TEXT_KEYS_MAX`] entries loads nothing and raises
//! `text-too-large`. Numbers print with Rust's shortest round-trip form, the same text on every
//! target (no locale grouping in v1).

use std::collections::BTreeSet;
use std::fmt;

use fluent_bundle::{FluentBundle, FluentError, FluentResource};

use crate::text::args::{TEXT_ARGS_MAX, TextArgs};
use crate::text::locale::Locale;
use crate::text::pseudo;

/// The largest `.ftl` file a catalog reads.
pub const TEXT_FILE_BYTES_MAX: usize = 256 * 1024;
/// The most entries (messages and terms) one locale's file may hold.
pub const TEXT_KEYS_MAX: usize = 4096;

const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

/// What went wrong with a game's text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum TextErrorCode {
    /// A key the loaded locale has no message for (the key is drawn instead).
    Missing,
    /// A broken `.ftl` entry, a file that is not UTF-8, or a message whose arguments did not resolve.
    Invalid,
    /// A file over [`TEXT_FILE_BYTES_MAX`] or with more than [`TEXT_KEYS_MAX`] entries.
    TooLarge,
    /// A chosen locale the game does not offer.
    LocaleUnknown,
    /// A locale's fallback font is not among the game's assets.
    FontMissing,
}

impl TextErrorCode {
    /// Every value, in declaration order.
    pub const ALL: &'static [TextErrorCode] =
        &[TextErrorCode::Missing, TextErrorCode::Invalid, TextErrorCode::TooLarge, TextErrorCode::LocaleUnknown, TextErrorCode::FontMissing];

    /// The exact wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            TextErrorCode::Missing => "text-missing",
            TextErrorCode::Invalid => "text-invalid",
            TextErrorCode::TooLarge => "text-too-large",
            TextErrorCode::LocaleUnknown => "text-locale-unknown",
            TextErrorCode::FontMissing => "text-font-missing",
        }
    }

    /// The value a wire spelling names, if any.
    pub fn from_wire(wire: &str) -> Option<TextErrorCode> {
        TextErrorCode::ALL.iter().copied().find(|code| code.wire() == wire)
    }
}

impl fmt::Display for TextErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.wire())
    }
}

/// One text issue: the code, what it is about (a key, a locale tag), the file line when known, and
/// a detail for a person to read (never matched on).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextIssue {
    code: TextErrorCode,
    subject: String,
    line: Option<u32>,
    detail: String,
}

impl TextIssue {
    /// An issue with `code` about `subject`.
    pub fn new(code: TextErrorCode, subject: &str, line: Option<u32>, detail: impl Into<String>) -> TextIssue {
        TextIssue { code, subject: subject.to_owned(), line, detail: detail.into() }
    }

    /// What went wrong.
    pub fn code(&self) -> TextErrorCode {
        self.code
    }

    /// The key or locale tag it is about.
    pub fn subject(&self) -> &str {
        &self.subject
    }

    /// The 1-based line of the `.ftl` file, for file issues.
    pub fn line(&self) -> Option<u32> {
        self.line
    }

    /// What was wrong, for a person.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

/// The 1-based line holding byte `at` of `text`.
fn line_of(text: &[u8], at: usize) -> u32 {
    let newlines = text[..at.min(text.len())].iter().filter(|&&byte| byte == b'\n').count();
    u32::try_from(newlines + 1).unwrap_or(u32::MAX)
}

/// One locale's messages and the issues raised since they were last taken.
pub struct Catalog {
    locale: Locale,
    bundle: Option<FluentBundle<FluentResource>>,
    keys: usize,
    reported: BTreeSet<(TextErrorCode, String)>,
    issues: Vec<TextIssue>,
}

impl fmt::Debug for Catalog {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Catalog").field("locale", &self.locale).field("keys", &self.keys).field("issues", &self.issues).finish_non_exhaustive()
    }
}

impl Catalog {
    /// A catalog of `locale` with no text: every key is missing.
    pub fn empty(locale: Locale) -> Catalog {
        Catalog { locale, bundle: None, keys: 0, reported: BTreeSet::new(), issues: Vec::new() }
    }

    /// `locale`'s messages from its `.ftl` bytes.
    pub fn load(locale: Locale, source: &[u8]) -> Catalog {
        let mut catalog = Catalog::empty(locale);
        catalog.fill(source, None);
        catalog
    }

    /// `xx-pseudo` over `base`'s `.ftl` bytes: plurals follow `base`, text is accented and framed.
    pub fn load_pseudo(base: Locale, source: &[u8]) -> Catalog {
        let mut catalog = Catalog::empty(Locale::pseudo());
        catalog.fill(source, Some(&base));
        catalog
    }

    /// Show `locale` instead: the old bundle is dropped first, and keys are reported again.
    /// Issues not yet taken are kept.
    pub fn switch(&mut self, locale: Locale, source: &[u8]) {
        self.reset(locale);
        self.fill(source, None);
    }

    /// Show `xx-pseudo` over `base` instead, as [`Catalog::switch`] does.
    pub fn switch_pseudo(&mut self, base: Locale, source: &[u8]) {
        self.reset(Locale::pseudo());
        self.fill(source, Some(&base));
    }

    fn reset(&mut self, locale: Locale) {
        self.bundle = None;
        self.keys = 0;
        self.reported.clear();
        self.locale = locale;
    }

    fn fill(&mut self, source: &[u8], base: Option<&Locale>) {
        let tag = self.locale.tag().to_owned();
        if source.len() > TEXT_FILE_BYTES_MAX {
            let detail = format!("{} bytes; the cap is {TEXT_FILE_BYTES_MAX}", source.len());
            self.issues.push(TextIssue::new(TextErrorCode::TooLarge, &tag, None, detail));
            return;
        }
        let source = source.strip_prefix(UTF8_BOM).unwrap_or(source);
        let text = match std::str::from_utf8(source) {
            Ok(text) => text.to_owned(),
            Err(error) => {
                let line = line_of(source, error.valid_up_to());
                self.issues.push(TextIssue::new(TextErrorCode::Invalid, &tag, Some(line), "the file is not UTF-8"));
                return;
            }
        };
        let (resource, errors) = match FluentResource::try_new(text) {
            Ok(resource) => (resource, Vec::new()),
            Err(partial) => partial,
        };
        for error in &errors {
            let line = line_of(resource.source().as_bytes(), error.pos.start);
            self.issues.push(TextIssue::new(TextErrorCode::Invalid, &tag, Some(line), error.kind.to_string()));
        }
        // Each parser error leaves exactly one junk entry behind; the rest are messages and terms.
        let keys = resource.entries().count().saturating_sub(errors.len());
        if keys > TEXT_KEYS_MAX {
            let detail = format!("{keys} entries; the cap is {TEXT_KEYS_MAX}");
            self.issues.push(TextIssue::new(TextErrorCode::TooLarge, &tag, None, detail));
            return;
        }
        let plurals = base.unwrap_or(&self.locale).langid().clone();
        let mut bundle = FluentBundle::new(vec![plurals]);
        bundle.set_use_isolating(false);
        if self.locale.is_pseudo() {
            bundle.set_transform(Some(pseudo::accent));
        }
        if let Err(errors) = bundle.add_resource(resource) {
            for error in errors {
                let subject = match &error {
                    FluentError::Overriding { id, .. } => id.clone(),
                    _ => tag.clone(),
                };
                self.issues.push(TextIssue::new(TextErrorCode::Invalid, &subject, None, error.to_string()));
            }
        }
        self.keys = keys;
        self.bundle = Some(bundle);
    }

    /// The locale shown.
    pub fn locale(&self) -> &Locale {
        &self.locale
    }

    /// How many entries (messages and terms) are loaded.
    pub fn len(&self) -> usize {
        self.keys
    }

    /// Whether no text is loaded.
    pub fn is_empty(&self) -> bool {
        self.keys == 0
    }

    /// Whether `key` (`message` or `message.attribute`) has text in the loaded locale.
    pub fn has(&self, key: &str) -> bool {
        self.resolve(key, None).is_some()
    }

    /// The text of `key` (`message` or `message.attribute`); the key itself when it is missing.
    pub fn tr(&mut self, key: &str) -> String {
        self.format(key, None)
    }

    /// The text of `key` with `args` filled in; the key itself when it is missing.
    pub fn tr_args(&mut self, key: &str, args: &TextArgs) -> String {
        if args.dropped() > 0 {
            self.report(TextErrorCode::Invalid, key, format!("more than {TEXT_ARGS_MAX} arguments"));
        }
        self.format(key, Some(args))
    }

    /// The issues raised since they were last taken, oldest first.
    pub fn issues(&self) -> &[TextIssue] {
        &self.issues
    }

    /// Take the issues raised so far.
    pub fn take_issues(&mut self) -> Vec<TextIssue> {
        std::mem::take(&mut self.issues)
    }

    fn format(&mut self, key: &str, args: Option<&TextArgs>) -> String {
        let Some((text, unresolved)) = self.resolve(key, args) else {
            self.report(TextErrorCode::Missing, key, format!("no message in {}", self.locale.tag()));
            return key.to_owned();
        };
        if unresolved {
            self.report(TextErrorCode::Invalid, key, "a placeable did not resolve (a missing argument or reference)");
        }
        if self.locale.is_pseudo() {
            return pseudo::frame(&text);
        }
        text
    }

    /// The formatted text of `key` and whether a placeable failed, or `None` when it has no text.
    fn resolve(&self, key: &str, args: Option<&TextArgs>) -> Option<(String, bool)> {
        let bundle = self.bundle.as_ref()?;
        let (id, attribute) = key.split_once('.').map_or((key, None), |(id, attribute)| (id, Some(attribute)));
        let message = bundle.get_message(id)?;
        let pattern = match attribute {
            Some(name) => message.get_attribute(name)?.value(),
            None => message.value()?,
        };
        let fluent_args = args.map(TextArgs::to_fluent);
        let mut errors = Vec::new();
        let text = bundle.format_pattern(pattern, fluent_args.as_ref(), &mut errors).into_owned();
        Some((text, !errors.is_empty()))
    }

    fn report(&mut self, code: TextErrorCode, subject: &str, detail: impl Into<String>) {
        if self.reported.insert((code, subject.to_owned())) {
            self.issues.push(TextIssue::new(code, subject, None, detail));
        }
    }
}
