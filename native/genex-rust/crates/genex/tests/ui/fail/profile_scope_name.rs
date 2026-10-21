//! `genex::profile_scope!` checks its name when the game compiles: a scope name is 1..=48 bytes of
//! a-z, 0-9, `_`, `.` and `-`, so a name with a space and capitals does not build.

fn update() {
    genex::profile_scope!("Enemy AI");
}

fn main() {
    update();
}
