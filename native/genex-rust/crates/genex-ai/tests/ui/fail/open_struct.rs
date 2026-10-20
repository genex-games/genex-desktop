// An answer's object is closed: a type that reads one must refuse unknown fields too.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
struct Turn {
    headline: String,
}

fn main() {}
