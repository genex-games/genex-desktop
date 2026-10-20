// `#[genex_ai(...)]` takes the dialect's bounds and annotations only.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
#[serde(deny_unknown_fields)]
struct Turn {
    #[genex_ai(pattern = "a+")]
    headline: String,
}

fn main() {}
