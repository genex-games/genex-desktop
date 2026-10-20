//! Migrations: a game's chain of steps `from -> from + 1` that brings a slot saved at an older
//! schema up to the game's, one step at a time and in schema order, over the slot's game sections
//! only (built-in `genex.*` sections are the runtime's and never reach a step). The idea of a
//! version-keyed migrator chain comes from bevy_save (MIT OR Apache-2.0); no code is copied: it is
//! restated over `serde_json::Value` without reflection.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::envelope::Envelope;
use crate::error::{SaveError, SaveErrorCode};
use crate::index::{SlotState, state_against};

/// The most steps one chain holds.
pub const MIGRATION_STEPS_MAX: usize = 64;
/// The prefix of the runtime's built-in sections, which no step reads or writes.
pub const BUILTIN_SECTION_PREFIX: &str = "genex.";

/// One step: the game sections (an object of section name to value) at schema `from`, answered at
/// `from + 1`, or why they cannot be.
pub type MigrationStep = Box<dyn Fn(Value) -> Result<Value, String>>;

/// Why a registered chain is refused at install (the facade's `save-schema-invalid`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationsInvalid {
    /// The schema is 0; schemas start at 1.
    SchemaZero,
    /// A step from 0, or from the game's schema or above.
    StepOutOfRange(u32),
    /// Two steps from the same schema.
    Repeated(u32),
    /// The steps skip a schema between the first and the game's.
    Gap {
        /// The first schema with no step.
        missing: u32,
    },
    /// More than [`MIGRATION_STEPS_MAX`] steps.
    TooMany,
}

/// A game's save schema and the steps that bring older slots up to it.
pub struct Migrations {
    schema: u32,
    steps: BTreeMap<u32, MigrationStep>,
    repeated: Option<u32>,
    registered: usize,
}

impl Migrations {
    /// Saves at schema `schema`, with no steps yet.
    pub fn new(schema: u32) -> Migrations {
        Migrations { schema, steps: BTreeMap::new(), repeated: None, registered: 0 }
    }

    /// Add the step from schema `from` to `from + 1`.
    pub fn step(mut self, from: u32, step: impl Fn(Value) -> Result<Value, String> + 'static) -> Migrations {
        self.registered += 1;
        if self.steps.insert(from, Box::new(step)).is_some() && self.repeated.is_none() {
            self.repeated = Some(from);
        }
        self
    }

    /// The schema the game saves at.
    pub fn schema(&self) -> u32 {
        self.schema
    }

    /// Whether the chain can be installed: a schema of at least 1, at most
    /// [`MIGRATION_STEPS_MAX`] steps, each from 1 to below the schema, none repeated, and no gap
    /// between the first step and the schema. A chain may start above 1 (older slots then refuse
    /// `save-migration-missing`).
    pub fn check(&self) -> Result<(), MigrationsInvalid> {
        if self.schema == 0 {
            return Err(MigrationsInvalid::SchemaZero);
        }
        if self.registered > MIGRATION_STEPS_MAX {
            return Err(MigrationsInvalid::TooMany);
        }
        if let Some(from) = self.repeated {
            return Err(MigrationsInvalid::Repeated(from));
        }
        if let Some(&from) = self.steps.keys().find(|&&from| from == 0 || from >= self.schema) {
            return Err(MigrationsInvalid::StepOutOfRange(from));
        }
        let Some(&first) = self.steps.keys().next() else { return Ok(()) };
        match (first..self.schema).find(|from| !self.steps.contains_key(from)) {
            Some(missing) => Err(MigrationsInvalid::Gap { missing }),
            None => Ok(()),
        }
    }

    /// How a slot saved at `slot_schema` stands against the game's schema.
    pub fn state_of(&self, slot_schema: u32) -> SlotState {
        state_against(slot_schema, self.schema)
    }

    /// `envelope` brought up to the game's schema. Refuses `save-newer` for a slot above it,
    /// `save-migration-missing` naming the first schema with no step, and `save-migration-failed`
    /// naming the step that answered an error, a value that is not an object, or a built-in section.
    pub fn migrate(&self, envelope: Envelope) -> Result<Envelope, SaveError> {
        if envelope.schema > self.schema {
            return Err(SaveError::new(
                SaveErrorCode::Newer,
                format!("the slot is at schema {}; the game saves at {}", envelope.schema, self.schema),
            ));
        }
        if envelope.schema == self.schema {
            return Ok(envelope);
        }
        let Envelope { schema, sections, .. } = &envelope;
        if let Some(missing) = (*schema..self.schema).find(|from| !self.steps.contains_key(from)) {
            return Err(SaveError::new(
                SaveErrorCode::MigrationMissing,
                format!("no migration step from schema {missing} to {}", missing + 1),
            ));
        }
        let (builtin, mut game): (Map<String, Value>, Map<String, Value>) = split_sections(sections.clone());
        for from in *schema..self.schema {
            game = self.run_step(from, game)?;
        }
        let mut migrated = envelope;
        migrated.schema = self.schema;
        migrated.sections = builtin.into_iter().chain(game).collect();
        Ok(migrated)
    }

    /// The game sections after the step from `from`.
    fn run_step(&self, from: u32, game: Map<String, Value>) -> Result<Map<String, Value>, SaveError> {
        let failed =
            |why: &str| SaveError::new(SaveErrorCode::MigrationFailed, format!("step {from} -> {}: {why}", from + 1));
        let step = self.steps.get(&from).ok_or_else(|| failed("missing"))?;
        let Value::Object(next) = step(Value::Object(game)).map_err(|why| failed(&why))? else {
            return Err(failed("the step answered a value that is not an object of sections"));
        };
        if let Some(name) = next.keys().find(|name| name.starts_with(BUILTIN_SECTION_PREFIX)) {
            return Err(failed(&format!("the step wrote the built-in section {name:?}")));
        }
        Ok(next)
    }
}

impl std::fmt::Debug for Migrations {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Migrations").field("schema", &self.schema).field("steps", &self.steps.keys()).finish()
    }
}

/// The built-in sections and the game's, each in their stored order.
fn split_sections(sections: Map<String, Value>) -> (Map<String, Value>, Map<String, Value>) {
    sections.into_iter().partition(|(name, _)| name.starts_with(BUILTIN_SECTION_PREFIX))
}
