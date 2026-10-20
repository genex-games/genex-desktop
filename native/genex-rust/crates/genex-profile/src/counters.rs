//! Counters: a number a game reports under a [`ScopeName`] (live enemies, pooled bullets), shown
//! in the summary beside the scopes. Display only: a counter lands in `state().volatile.profile`,
//! never in the checksum, and keeps its last value until the game sets it again. At most
//! [`PROFILE_COUNTERS_MAX`] names per run; a later name, or a value that is not finite, is dropped
//! and counted.

use std::collections::BTreeMap;

use crate::caps::PROFILE_COUNTERS_MAX;
use crate::scope::ScopeName;

/// One run's counters, by name, with how many sets were dropped.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Counters {
    values: BTreeMap<&'static str, f64>,
    dropped: u64,
}

impl Counters {
    /// No counters yet.
    pub fn new() -> Counters {
        Counters::default()
    }

    /// Set `name` to `value`; false, counted as dropped, for a value that is not finite or a new
    /// name past [`PROFILE_COUNTERS_MAX`].
    pub fn set(&mut self, name: ScopeName, value: f64) -> bool {
        let known = self.values.contains_key(name.as_str());
        let admitted = value.is_finite() && (known || self.values.len() < PROFILE_COUNTERS_MAX);
        if !admitted {
            self.dropped = self.dropped.saturating_add(1);
            return false;
        }
        self.values.insert(name.as_str(), value);
        true
    }

    /// The last value of `name`, if it was ever set.
    pub fn get(&self, name: &str) -> Option<f64> {
        self.values.get(name).copied()
    }

    /// Every counter, by name.
    pub fn values(&self) -> &BTreeMap<&'static str, f64> {
        &self.values
    }

    /// How many sets were dropped.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// How many names are set.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Whether no counter is set.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}
