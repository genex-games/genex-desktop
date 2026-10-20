// An internally tagged enum is a union the dialect has no word for.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Order {
    /// Hit.
    Attack { target: u8 },
}

fn main() {}
