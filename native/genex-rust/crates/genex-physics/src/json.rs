//! The command JSON form (CONTRACT.md §7.3).

use serde_json::Value;

use crate::command::Command;
use crate::error::{PhysicsError, PhysicsFailure, fail};

/// Reads one command in its JSON form.
pub(crate) fn command(_value: &Value) -> Result<Command, PhysicsFailure> {
    fail(PhysicsError::BadCommand, "not read yet")
}
