//! `#[derive(Schema)]`'s compile-time refusals, checked with trybuild: a type whose serde shape
//! the closed dialect cannot say is refused with the reason, before a game ever asks a model.
//! After an intended diagnostic change, rerun with `TRYBUILD=overwrite` and review the `.stderr`.

#[test]
fn shapes_the_dialect_cannot_say_are_refused_at_compile_time() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/fail/*.rs");
}
