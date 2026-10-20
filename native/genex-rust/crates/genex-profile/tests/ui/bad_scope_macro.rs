//! `profile_scope!` checks its name in a const, so a bad name fails the build at the call site.

fn update() {
    genex_profile::profile_scope!("enemy AI");
}

fn main() {
    update();
}
