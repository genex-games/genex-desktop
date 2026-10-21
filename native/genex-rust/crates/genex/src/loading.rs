//! What a native boot shows while it loads (renderer pass 2, owner decision D11): the game's
//! `[render.loading]` look as the lane compiled it in (`GENEX_RENDER_TOML`, the same table the web
//! shell's page is styled by), and the boot's progress in the screen's words. A desktop window
//! paints it with [`genex_hud::LoadingScreen`] while the boot's warm-up compiles the first frame's
//! pipelines (`desktop.rs`); Live shows the same stages from the `starting` events (`studio.rs`).
//!
//! Host glue, not game API: a game styles its screen in `genex.toml`, never in code.

use crate::manifest::{self, LoadingSection};
use genex_core::protocol::BootStage;
use genex_hud::{LoadingLook, LoadingProgress, parse_hex_color};
use genex_render::compile::CompileTally;

/// The `[render]` tables the build lane compiled in (`render.rs` reads the same).
const BUILD_RENDER_TOML: Option<&str> = option_env!("GENEX_RENDER_TOML");
/// The `[game]` table a fragment is read under (a fragment has none).
const FRAGMENT_GAME: &str = "[game]\ntitle = \"loading\"\n";
/// Where the bar starts once the window is up (the device opened before it), and where the
/// pipelines' share of it ends: the first frame fills the rest.
const FILL_AT_PIPELINES: f32 = 0.1;
const FILL_PIPELINES_END: f32 = 0.95;

/// The words the screen shows for each stage (the web shell's `MESSAGE.loading`).
pub const fn stage_words(stage: BootStage) -> &'static str {
    match stage {
        BootStage::Wasm => "Downloading the game",
        BootStage::Assets => "Loading assets",
        BootStage::Device => "Starting the graphics",
        BootStage::Pipelines => "Preparing shaders",
        BootStage::Frame => "Drawing the first frame",
        BootStage::Ready => "Ready",
    }
}

/// The look `section` sets around the game's `title` (a key left out keeps the default; the
/// manifest's check has refused anything malformed already, so an unreadable colour is the default).
pub fn look_of(title: &str, section: &LoadingSection) -> LoadingLook {
    let mut look = LoadingLook::new(section.title.as_deref().unwrap_or(title));
    let colors = [(&section.background, &mut look.background), (&section.accent, &mut look.accent), (&section.text, &mut look.text)];
    for (set, slot) in colors {
        if let Some(color) = set.as_deref().and_then(parse_hex_color) {
            *slot = color;
        }
    }
    look
}

/// The look the build lane compiled in (`[render.loading]` in `GENEX_RENDER_TOML`) around the
/// game's `title`; the defaults when the build compiled none.
pub fn look_from_build(title: &str) -> LoadingLook {
    let section = BUILD_RENDER_TOML
        .and_then(|text| manifest::parse(&format!("{FRAGMENT_GAME}{text}")).ok())
        .map(|parsed| parsed.render.loading)
        .unwrap_or_default();
    look_of(title, &section)
}

/// The screen while the pipelines compile and the impostors bake (game systems LOD-16: a GPU bake
/// needs the device, so the `pipelines` stage counts it): "Preparing shaders · n of m" over both,
/// and the bar at their share.
pub fn preparing(compiles: CompileTally, bakes: crate::present::BakeTally) -> LoadingProgress {
    let submitted = compiles.submitted.saturating_add(bakes.submitted as usize);
    let finished = compiles.finished.min(compiles.submitted).saturating_add(bakes.finished.min(bakes.submitted) as usize);
    compiling(CompileTally { submitted, finished })
}

/// The screen while the pipelines compile: "Preparing shaders · n of m" and the bar at their share.
pub fn compiling(tally: CompileTally) -> LoadingProgress {
    let words = stage_words(BootStage::Pipelines);
    if tally.submitted == 0 {
        return LoadingProgress { words: words.to_owned(), fill: FILL_AT_PIPELINES };
    }
    let share = tally.finished.min(tally.submitted) as f32 / tally.submitted as f32;
    LoadingProgress {
        words: format!("{words} · {} of {}", tally.finished, tally.submitted),
        fill: FILL_AT_PIPELINES + (FILL_PIPELINES_END - FILL_AT_PIPELINES) * share,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_look_takes_the_games_table_and_keeps_the_defaults_it_leaves_out() {
        let section = LoadingSection {
            title: Some("Harbour Nights".to_owned()),
            background: Some("#203040".to_owned()),
            accent: None,
            text: Some("#F0E0D0".to_owned()),
            logo: None,
        };
        let look = look_of("Harbour", &section);
        assert_eq!(look.title, "Harbour Nights");
        assert_eq!(look.background, [0x20, 0x30, 0x40]);
        assert_eq!(look.accent, LoadingLook::new("").accent, "an accent left out is the default");
        assert_eq!(look.text, [0xf0, 0xe0, 0xd0]);
        assert_eq!(look_of("Harbour", &LoadingSection::default()), LoadingLook::new("Harbour"), "no table: the game's title, the defaults");
    }

    #[test]
    fn the_compiles_read_as_n_of_m_and_only_fill_the_bar() {
        let empty = compiling(CompileTally::default());
        assert_eq!(empty.words, "Preparing shaders");
        let some = compiling(CompileTally { submitted: 40, finished: 12 });
        assert_eq!(some.words, "Preparing shaders · 12 of 40");
        let all = compiling(CompileTally { submitted: 40, finished: 40 });
        assert!(empty.fill < some.fill && some.fill < all.fill && all.fill < 1.0, "{empty:?} {some:?} {all:?}");
    }

    #[test]
    fn pipelines_stage_counts_impostor_bakes() {
        use crate::present::BakeTally;
        let compiles = CompileTally { submitted: 40, finished: 40 };
        let waiting = preparing(compiles, BakeTally { submitted: 2, finished: 0 });
        assert_eq!(waiting.words, "Preparing shaders · 40 of 42", "two bakes still to run keep the stage open");
        let done = preparing(compiles, BakeTally { submitted: 2, finished: 2 });
        assert_eq!(done.words, "Preparing shaders · 42 of 42");
        assert!(waiting.fill < done.fill, "{waiting:?} {done:?}");
        assert_eq!(preparing(compiles, BakeTally::default()), compiling(compiles), "a game without impostors reads as before");
    }

    #[test]
    fn every_stage_has_words_and_the_wire_order_is_the_hosts() {
        let wire: Vec<&str> = BootStage::ALL.iter().map(|stage| stage.wire()).collect();
        assert_eq!(wire, ["wasm", "assets", "device", "pipelines", "frame", "ready"]);
        assert!(BootStage::ALL.iter().all(|stage| !stage_words(*stage).is_empty()));
    }
}
