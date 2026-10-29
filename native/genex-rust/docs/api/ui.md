# UI

`on_ui` draws egui widgets inside the tick; this is the whole HUD (score, health, a menu, a
button), and a game has no other UI path. It runs exactly once per tick with the egui `Ui` laid
over the world: one egui point is one world pixel, y down. egui reads only the merged input
(keys, touches and the pointer as touch 0) and the simulated clock, and its memory resets on
every seed, so a scripted click on a button replays exactly and the HUD of two runs on one seed
is the same picture. Painting is display only. It never changes what a later tick sees, so keep
state in the world and let `on_ui` read it. Give a widget its visible label: checks find widgets
by it (`state().hud.items`). While a widget holds the keyboard's focus (Tab to it, or a tapped
text field), keys are the widget's and the update hooks see none until Escape or a click
elsewhere; mouse buttons and touches stay the game's. On a phone keep tap targets large and clear
of the screen edges. The HUD's fonts are text fonts only (letters, digits, punctuation): an emoji
or icon glyph draws as a box, so draw icons with shapes (`ui.painter()`), and open the settings
panel with `genex::render::settings_button(ui, "Settings")`, a drawn gear beside its label.
The whole settings menu (graphics, audio, controls, language and accessibility, the game's own
options) is `genex::settings::menu(ui)` (`docs/api/settings.md`).

The HUD is egui 0.36 (pinned `=0.36.2`, re-exported as `genex::egui`; never add egui to
`[crates]`). Inside a hook `ui.max_rect()` is the hook's area (its centre is the screen's, for a
crosshair); the whole window is `ui.ctx().content_rect()`. This egui has no `screen_rect`. Every
type and call in one line:

```rust
use genex::prelude::*;                                         // UiConfig, UiScale, TextArgs, egui
use genex::ui::{Bar, Dialog, GridAnswer, ItemGrid, ItemList, Locale, Menu, ToastKind, Toasts};
game.on_ui(|sim, ui, ctx| {});                                 // ui: &mut egui::Ui, once per tick
game.ui(UiConfig::new().locales(&["en", "fr"]).scale(UiScale::Fixed(1.25))); // -> &mut Game
ui.ctx().content_rect(); ui.max_rect();                        // -> egui::Rect: the screen, the hook's area
genex::ui::tr("title-new"); genex::ui::tr_args("hud-coins", &TextArgs::new().num("coins", 3)); // -> String
genex::ui::locale(); genex::ui::reduced_motion(); genex::ui::safe_area(ui); // -> Option<Locale>, bool, egui::Margin
Menu::new("pause").item("resume", &resume).back("resume").show(ui); // -> Option<&str>, the picked key
Dialog::new("quit").body(&sure).button("yes", &yes).cancel("no").show(ui); // -> Option<&str>; .title too
ItemGrid::new("bag", 6).cell(64.0).show(ui, count, |ui, i, rect| label_of(i)); // -> GridAnswer
ItemList::new("quests").show(ui, count, |ui, i, rect| label_of(i)); // GridAnswer { activated, moved, focused }
Bar::new("hp", 0.5).label("Health").show(ui);                  // -> egui::Response
Toasts::push(ui.ctx(), ToastKind::Info, &saved); Toasts::show(ui);
genex::render::settings_button(ui, "Settings");                // -> egui::Response
```

A label is a `&str` the widget borrows: keep a `tr(..)` in a `let` before the builder when you
keep the answer.

## The kit (`game.ui`)

Register the gameplay UI once with `game.ui(UiConfig::new().locales(&["en", "fr"]))`; its text,
locales, fonts and `xx-pseudo` are `docs/api/text.md`. `.scale(UiScale::Fixed(1.25))` fixes the UI
scale (by default `UiScale::Auto`: 1.5 on a phone in an export, 1 elsewhere). Install refuses a
second registration (`duplicate-ui`) and a locale that is not BCP-47 or a font for a locale the
list does not name (`ui-locale-invalid`). The `on_ui` hooks draw inside the safe area plus a
16 pt margin, at the person's text size; touch controls, `egui::Area`s and `ui.put` keep the whole
world. `genex::ui::locale()`, `genex::ui::reduced_motion()` and `genex::ui::safe_area(ui)` (what of
`ui`'s rect a phone's notch, island or home indicator still covers, as an egui margin; zero inside
the hook's own rect) read the same layers; lay menus out inside `ui`'s rect less that margin. A
Genex run has no safe area. In a Studio run the `uiSettings` verb sets a session layer (locale,
scale, safe area, text size) from the next tick. `textSize` is answered back; the hooks read the
settings menu's text size. Reduced motion, screen shake and head bob also reach the camera:
`FirstPersonRig` obeys them in the camera hook (`docs/api/camera.md`), and an animated widget of
your own checks `genex::ui::reduced_motion()`.

The kit draws in one pass and moves by pad or keys: `Menu::new("pause").item("resume", &tr("resume")).back("resume").show(ui)`
answers the picked item's key (its `back` key on B or Escape), and `Dialog::new("quit")`,
`ItemGrid::new("bag", 6)`, `ItemList::new("quests")` and `Bar::new("hp", 0.5)` follow the same
pattern; `Toasts::push(ui.ctx(), ToastKind::Info, &tr("saved"))` queues a notice and
`Toasts::show(ui)` draws the queue at the top right of `ui`'s rect: inside the safe area and the
16 pt margin for a hook's ui. A menu focuses its first item when it opens and
remembers its focused item, so a menu opened again lands where the player left it. A `Bar`'s
label is what checks and screen readers read, not drawn: draw the words beside it. The d-pad or left
stick moves focus, A accepts, B cancels and the bumpers walk in drawing order; a held direction
repeats after 24 ticks, then every 6. A game with `game.input` navigates by its `ui_*` actions
instead. While a widget holds focus, the update hooks read the d-pad, the left stick, A, B and the
bumpers as released, so a menu never moves the player.

Every kit widget has a key (`pause.settings`), so a check finds it in `state().hud.widgets`
(`{role, label, key, rect, focused}`), reads `state().hud.focus` and clicks its rect. An invalid or
repeated key records `ui-key-invalid` or `ui-key-duplicate`. `state().volatile.ui` shows
`{locale, scale, safeArea, issues}`, and a text file's issues also appear in
`state().__render.assetIssues`. None of it enters the checksum.

`docs/examples/menus-saves/` is a complete menu game: title, pause, the settings menu, save and
load slot lists over an autosave ring, a quit dialog and toasts, all by pad or keys. A screen there ignores answers on the tick it opened, so the press
that opened it (Escape opening a pause menu whose back key is also Escape) never picks in it.
