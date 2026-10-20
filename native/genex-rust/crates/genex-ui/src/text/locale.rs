//! Locale: a BCP-47 tag in canonical form, and the negotiation that picks the one a game shows.
//!
//! The order is the person's choice, then the OS locale (read by the shells, never by the sim),
//! then the first locale the game lists. A request matches an offered locale exactly first, then
//! by language (`de-AT` takes `de`); `xx-pseudo` only matches itself. A choice that matches nothing
//! falls through with one `text-locale-unknown` issue; an unoffered OS locale is not an issue.

use std::fmt;

use unic_langid::LanguageIdentifier;

use crate::text::catalog::{TextErrorCode, TextIssue};
use crate::text::pseudo::PSEUDO_LOCALE;

/// The longest tag a locale may have.
pub const LOCALE_TAG_CHARS_MAX: usize = 35;

/// A locale a game offers or a person picks, in canonical BCP-47 form (`en-US`, `de`, `xx-pseudo`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Locale {
    tag: String,
    langid: LanguageIdentifier,
}

impl Locale {
    /// The locale `tag` names, or `None` when it is not a BCP-47 language tag (empty, `und`, over
    /// [`LOCALE_TAG_CHARS_MAX`], or malformed). `_` separators and any letter case are accepted.
    pub fn parse(tag: &str) -> Option<Locale> {
        if tag.is_empty() || tag.len() > LOCALE_TAG_CHARS_MAX {
            return None;
        }
        let langid: LanguageIdentifier = tag.parse().ok()?;
        if langid.language.is_empty() {
            return None;
        }
        Some(Locale { tag: langid.to_string(), langid })
    }

    /// `xx-pseudo`, the pseudo-locale.
    pub fn pseudo() -> Locale {
        // The constant is a well-formed tag (language `xx`, variant `pseudo`), so parse succeeds.
        Locale::parse(PSEUDO_LOCALE).unwrap_or_else(|| Locale { tag: PSEUDO_LOCALE.to_owned(), langid: LanguageIdentifier::default() })
    }

    /// The canonical tag.
    pub fn tag(&self) -> &str {
        &self.tag
    }

    /// The language subtag (`de` of `de-AT`).
    pub fn language(&self) -> &str {
        self.langid.language.as_str()
    }

    /// Whether this is `xx-pseudo`.
    pub fn is_pseudo(&self) -> bool {
        self.tag == PSEUDO_LOCALE
    }

    /// The identifier Fluent selects plural rules by.
    pub(crate) fn langid(&self) -> &LanguageIdentifier {
        &self.langid
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.tag)
    }
}

/// Which step of the negotiation picked the locale.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[non_exhaustive]
pub enum LocaleSource {
    /// The person's choice.
    Choice,
    /// The OS locale.
    Os,
    /// The first locale the game lists.
    Fallback,
}

impl LocaleSource {
    /// Every value, in negotiation order.
    pub const ALL: &'static [LocaleSource] = &[LocaleSource::Choice, LocaleSource::Os, LocaleSource::Fallback];

    /// The exact wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LocaleSource::Choice => "choice",
            LocaleSource::Os => "os",
            LocaleSource::Fallback => "fallback",
        }
    }
}

/// The negotiation's answer.
#[derive(Clone, Debug, PartialEq)]
pub struct Negotiated {
    locale: Locale,
    source: LocaleSource,
    issue: Option<TextIssue>,
}

impl Negotiated {
    /// The locale to load.
    pub fn locale(&self) -> &Locale {
        &self.locale
    }

    /// Which step picked it.
    pub fn source(&self) -> LocaleSource {
        self.source
    }

    /// `text-locale-unknown` when the person's choice matched nothing offered.
    pub fn issue(&self) -> Option<&TextIssue> {
        self.issue.as_ref()
    }
}

/// The offered locale `wanted` matches: the same tag first, then the first with its language.
fn best_match<'a>(offered: &'a [Locale], wanted: &Locale) -> Option<&'a Locale> {
    if let Some(exact) = offered.iter().find(|locale| locale.tag == wanted.tag) {
        return Some(exact);
    }
    if wanted.is_pseudo() {
        return None;
    }
    offered.iter().find(|locale| !locale.is_pseudo() && locale.language() == wanted.language())
}

fn matched<'a>(offered: &'a [Locale], tag: Option<&str>) -> Option<&'a Locale> {
    best_match(offered, &Locale::parse(tag?)?)
}

/// Pick the locale to show from `offered` (the first is the fallback): the person's `choice`,
/// then the `os` locale, then the first offered. `None` when nothing is offered.
pub fn negotiate(offered: &[Locale], choice: Option<&str>, os: Option<&str>) -> Option<Negotiated> {
    let fallback = offered.first()?;
    if let Some(locale) = matched(offered, choice) {
        return Some(Negotiated { locale: locale.clone(), source: LocaleSource::Choice, issue: None });
    }
    let issue = choice.map(|tag| TextIssue::new(TextErrorCode::LocaleUnknown, tag, None, "the chosen locale is not offered"));
    let (locale, source) = match matched(offered, os) {
        Some(locale) => (locale, LocaleSource::Os),
        None => (fallback, LocaleSource::Fallback),
    };
    Some(Negotiated { locale: locale.clone(), source, issue })
}
