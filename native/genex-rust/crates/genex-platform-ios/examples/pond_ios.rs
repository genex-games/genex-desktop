//! The pond `.app` executable (M0a.16 spike; `scripts/spike/rust-wgpu/ios-app.sh` packages it):
//! the pond on the iOS shell, with its 600-tick self-test written to Documents on first launch.

fn main() {
    let outcome = genex_platform_ios::run(pond_game::NAME, pond_game::game(), pond_game::DEFAULT_DEMO, pond_game::ASSETS);
    if outcome != genex_platform_ios::ShellOutcome::Ran {
        eprintln!("pond: {outcome:?}");
        std::process::exit(1);
    }
}
