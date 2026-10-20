// The model picks a tool by its description: every tool of an act call needs a doc comment.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
#[serde(deny_unknown_fields)]
enum Order {
    /// Hit a target.
    Attack { target: u8 },
    Flee { far: bool },
}

fn main() {}
