// An act answer names its tool under `tool`: no tool may take the name.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
#[serde(deny_unknown_fields, rename_all = "lowercase")]
enum Order {
    /// Hit a target.
    Attack { target: u8 },
    /// Pick a tool.
    Tool { name: String },
}

fn main() {}
