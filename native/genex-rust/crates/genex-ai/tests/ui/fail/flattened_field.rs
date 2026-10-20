// `flatten` merges another type's fields in a way the closed dialect cannot say.
use genex_ai::Schema;
use serde::Deserialize;

#[derive(Deserialize, Schema)]
#[serde(deny_unknown_fields)]
struct Inner {
    a: u8,
}

#[derive(Deserialize, Schema)]
#[serde(deny_unknown_fields)]
struct Outer {
    #[serde(flatten)]
    inner: Inner,
}

fn main() {}
