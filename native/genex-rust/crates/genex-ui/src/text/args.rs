//! TextArgs: the named values a message's placeables read (`{ $n }`, `{ $name }`).
//!
//! `TextArgs::new().num("n", 3).str("name", "Ada")`. At most [`TEXT_ARGS_MAX`] names are kept; a
//! name set twice keeps its last value, and names past the cap are counted, not kept, so the
//! catalog can report `text-invalid` for the message they were meant for.

use fluent_bundle::{FluentArgs, FluentValue};

/// The most named values one message reads.
pub const TEXT_ARGS_MAX: usize = 8;

/// One named value.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum TextArg {
    /// A number: selects plural variants and prints with Rust's shortest round-trip form.
    Number(f64),
    /// Text, printed as given.
    Text(String),
}

/// The named values a message reads, in the order they were first set.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextArgs {
    values: Vec<(String, TextArg)>,
    dropped: usize,
}

impl TextArgs {
    /// No values.
    pub fn new() -> TextArgs {
        TextArgs::default()
    }

    /// A number named `name` (`{ $name }`, and the selector of plural variants).
    pub fn num(self, name: &str, value: impl Into<f64>) -> TextArgs {
        self.with(name, TextArg::Number(value.into()))
    }

    /// Text named `name`.
    pub fn str(self, name: &str, value: &str) -> TextArgs {
        self.with(name, TextArg::Text(value.to_owned()))
    }

    fn with(mut self, name: &str, value: TextArg) -> TextArgs {
        if let Some(slot) = self.values.iter_mut().find(|(known, _)| known == name) {
            slot.1 = value;
        } else if self.values.len() < TEXT_ARGS_MAX {
            self.values.push((name.to_owned(), value));
        } else {
            self.dropped += 1;
        }
        self
    }

    /// How many names are kept.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Whether no name is kept.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// How many names were past [`TEXT_ARGS_MAX`] and not kept.
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// The value named `name`.
    pub fn get(&self, name: &str) -> Option<&TextArg> {
        self.values.iter().find(|(known, _)| known == name).map(|(_, value)| value)
    }

    /// The values as Fluent reads them.
    pub(crate) fn to_fluent(&self) -> FluentArgs<'_> {
        let mut args = FluentArgs::with_capacity(self.values.len());
        for (name, value) in &self.values {
            let value = match value {
                TextArg::Number(number) => FluentValue::from(*number),
                TextArg::Text(text) => FluentValue::from(text.as_str()),
            };
            args.set(name.as_str(), value);
        }
        args
    }
}
