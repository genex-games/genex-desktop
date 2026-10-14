//! The facade's compile-time guarantees, checked with trybuild: `advance` is unreachable from
//! `on_update`, a demo driver cannot escape its demo, and read hooks cannot mutate the
//! simulation. The pass case, the plan's pond snippet verbatim apart from stub game types, is the
//! `pond-snippet` example (`tests/snippets/pond_snippet.rs`): `cargo test` compiles it and never runs it,
//! since its `genex::install` hands the game to the desktop shell, which runs until it is closed.

#[test]
fn compile_time_guarantees() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/fail/*.rs");
}
