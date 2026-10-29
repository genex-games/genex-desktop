//! The `use` lines and signature lists that open the app-facing reference pages
//! (`docs/api/ui.md`, `text.md`, `settings.md`, `saves.md`, `profiling.md`), and the corrected forms
//! the "Common mistakes" lines of `characters.md`, `animation.md` and `net.md` teach, written out as
//! code: a facade change that moves a type or a call breaks this build before it misleads a game.
//! `loading-screen.md` and `genex-toml.md` teach toml keys only; neither has a Rust call.

use genex::animation::{JointId, Limb, LimbTarget, LookTarget};
use genex::net::NetEvent;
use genex::prelude::*;
use genex::profile::ScopeName;
use genex::saves::{SaveConfig, SaveError, SlotEvent, SlotInfo, SlotOp, SlotState};
use genex::settings::{MenuAnswer, SettingDef, SettingValue, SettingsConfig, SettingsTab};
use genex::ui::{Bar, Dialog, GridAnswer, ItemGrid, ItemList, Locale, Menu, PSEUDO_LOCALE, ToastKind, Toasts};
use genex::CharacterAsset;

/// A world the saves page can keep whole, through the facade's serde.
#[derive(Default, Serialize, Deserialize)]
#[serde(crate = "genex::serde")]
struct World {
    door_open: bool,
    names: Vec<String>,
}

/// profiling.md: a counter's name, checked when the game compiles.
const ENEMIES: ScopeName = ScopeName::new("enemies");

/// ui.md: the hook, the config, the screen's rect, the person layer's reads and the kit.
fn ui_page(game: &mut Game<World>, ui: &mut egui::Ui) {
    game.on_ui(|_sim, _ui, _ctx| {});
    game.ui(UiConfig::new().locales(&["en", "fr"]).scale(UiScale::Fixed(1.25)));
    let _: (egui::Rect, egui::Rect) = (ui.ctx().content_rect(), ui.max_rect());
    let _: (String, String) = (genex::ui::tr("title-new"), genex::ui::tr_args("hud-coins", &TextArgs::new().num("coins", 3)));
    let _: (Option<Locale>, bool, egui::Margin) = (genex::ui::locale(), genex::ui::reduced_motion(), genex::ui::safe_area(ui));
    let (resume, sure, yes) = (genex::ui::tr("resume"), genex::ui::tr("quit-sure"), genex::ui::tr("yes"));
    let _: Option<&str> = Menu::new("pause").item("resume", &resume).back("resume").show(ui);
    let _: Option<&str> = Dialog::new("quit").title(&sure).body(&sure).button("yes", &yes).cancel("no").show(ui);
    let label_of = |index: usize| format!("item {index}");
    let grid: GridAnswer = ItemGrid::new("bag", 6).cell(64.0).show(ui, 12, |_ui, index, _rect| label_of(index));
    let GridAnswer { activated: _, moved: _, focused: _ } = grid;
    let _: GridAnswer = ItemList::new("quests").show(ui, 3, |_ui, index, _rect| label_of(index));
    let _: egui::Response = Bar::new("hp", 0.5).label("Health").show(ui);
    Toasts::push(ui.ctx(), ToastKind::Info, &resume);
    Toasts::show(ui);
    let _: egui::Response = genex::render::settings_button(ui, "Settings");
}

/// text.md: locales with a fallback font and the pseudo-locale, and the lookups.
fn text_page(game: &mut Game<World>) {
    game.ui(UiConfig::new().locales(&["en", "ja"]).font("ja", "fonts/NotoSansJP.ttf").pseudo_locale(true));
    let _: String = genex::ui::tr_args("toast-saved", &TextArgs::new().str("slot", "quick").num("coins", 3));
    if let Some(locale) = genex::ui::locale() {
        let _: &str = locale.tag();
    }
    let _: &str = PSEUDO_LOCALE;
}

/// settings.md: the game's options and presets, the menu and the reads.
fn settings_page(game: &mut Game<World>, ui: &mut egui::Ui) {
    game.settings(
        SettingsConfig::new()
            .option(SettingsTab::Game, SettingDef::toggle("tips", "settings-tips", true))
            .option(SettingsTab::Game, SettingDef::slider("fov", "settings-fov", 60.0, 110.0, 5.0, 90.0))
            .option(SettingsTab::Game, SettingDef::choice("hints", "settings-hints", &["off", "some", "all"], 1))
            .preset(SettingsTab::Game, "veteran", &[("hints", SettingValue::Choice(0))]),
    );
    let _: bool = genex::settings::menu(ui);
    let MenuAnswer { tab, changed: _, back: _ } = genex::settings::menu_answer(ui);
    match tab {
        SettingsTab::Graphics | SettingsTab::Audio | SettingsTab::Controls => {}
        SettingsTab::Accessibility | SettingsTab::Game => {}
        _ => {}
    }
    match genex::settings::value("ui.subtitles") {
        Some(SettingValue::Bool(_) | SettingValue::Number(_) | SettingValue::Choice(_)) | None => {}
        Some(_) => {}
    }
    let _: (f32, bool) = (genex::settings::number("ui.screen_shake"), genex::settings::flag("ui.subtitles"));
}

/// saves.md: the config, the sections and a hook's slots, their events and refusals.
fn saves_page(game: &mut Game<World>) {
    game.saves(
        SaveConfig::schema(2)
            .migrate(1, |mut sections| {
                sections["world"]["door_open"] = sections["world"]["door"].take();
                Ok(sections)
            })
            .autosave(3600, 3)
            .autosave_on_suspend(true)
            .slots_max(16),
    );
    game.save_world();
    game.save_section("door", |sim| json!(sim.world.door_open), |sim, value, _gfx| {
        sim.world.door_open = value.as_bool().ok_or("not a bool")?;
        Ok(())
    });
    game.on_update(|sim, ctx| {
        let slots = ctx.slots();
        let _: Result<(), SaveError> = slots.save("quick", "Quick save");
        let _: Result<(), SaveError> = slots.load("quick");
        let _: Result<(), SaveError> = slots.delete("quick");
        let _: (&[SlotInfo], Option<&SlotInfo>, bool) = (slots.list(), slots.get("quick"), slots.busy());
        for event in slots.events() {
            let SlotEvent { op, slot, result } = event;
            let _: &str = slot.as_str();
            match result {
                Ok(info) => sim.world.door_open = *op == SlotOp::Load && info.state == SlotState::Ready,
                Err(error) => {
                    let _: (&str, &String) = (error.code.wire(), &error.detail);
                }
            }
        }
    });
}

/// profiling.md: a scope over a block and a counter.
fn profiling_page(enemies: u32) {
    genex::profile_scope!("enemy_ai");
    genex::profile::counter(ENEMIES, f64::from(enemies));
}

/// characters.md and animation.md: a joint is the skeleton's by name and its transform is the
/// animator's (`CharacterAsset` has no `joint`); the IK targets are struct literals (no `new`).
fn sockets(hero: &CharacterAsset, animator: &mut Animator, at: Transform) -> Option<Mat4> {
    let head: JointId = hero.skeleton().find("Head")?;
    animator.look_at(Some(LookTarget { target: vec3(0.0, 1.6, 2.0), weight: 1.0 }));
    animator.look_at(None);
    animator.reach(Limb::RightArm, Some(LimbTarget { target: Vec3::ZERO, pole: Vec3::Z, weight: 1.0 }));
    Some(animator.socket(head, at.matrix()))
}

/// net.md: the players are iterators (counted, never `len`), the events a slice (looped, or owned
/// with `to_vec`), and a `match` on `NetEvent` ends with the wildcard `#[non_exhaustive]` needs.
fn net_mistakes(sim: &mut Sim<World>) -> usize {
    let seated: usize = sim.net.players().count();
    let others: usize = sim.net.remotes().count();
    let _: usize = sim.net.connected();
    for event in sim.net.events() {
        match event {
            NetEvent::Joined { player } => {
                sim.world.names.push(player.as_str().to_owned());
            }
            NetEvent::Left { player } => {
                sim.world.names.retain(|name| name != player.as_str());
            }
            _ => {}
        }
    }
    for event in sim.net.events().to_vec() {
        if let NetEvent::Left { .. } = event {
            sim.net.send("bye", json!({})).ok();
        }
    }
    seated + others
}

/// What each page's code reaches is named where the page says it is.
#[test]
fn the_app_pages_name_real_paths_and_shapes() {
    let _ = (ui_page, settings_page, sockets, net_mistakes);
    let mut game = Game::new(World::default());
    text_page(&mut game);
    saves_page(&mut game);
    profiling_page(3);
    assert_eq!(genex::ui::tr("title-new"), "title-new", "outside the hooks tr answers the key");
    assert_eq!(genex::ui::locale(), None, "outside the hooks there is no locale");
    assert!(!genex::settings::flag("ui.subtitles"), "outside the hooks a flag reads false");
    assert_eq!(genex::settings::number("ui.screen_shake"), 0.0, "outside the hooks a number reads 0");
    assert_eq!(PSEUDO_LOCALE, "xx-pseudo");
}
