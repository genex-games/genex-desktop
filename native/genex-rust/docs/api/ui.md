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

## Text, locales and the kit (`game.ui`)

Register the gameplay UI once with `game.ui(UiConfig::new().locales(&["en", "fr"]))`. The first
locale is the fallback, and each one's text is the Fluent file `assets/lang/<locale>.ftl` in the
boot group. `.font("ja", "fonts/NotoSansJP.ttf")` adds a fallback font for a locale (a font the
game ships; the HUD's own fonts are Latin), `.scale(UiScale::Fixed(1.25))` fixes the UI scale
(by default `UiScale::Auto`: 1.5 on a phone in an export, 1 elsewhere) and `.pseudo_locale(true)`
offers `xx-pseudo`, which accents, pads and brackets every string so overflow shows in a capture.
Install refuses a second registration (`duplicate-ui`) and a locale that is not BCP-47 or a font
for a locale the list does not name (`ui-locale-invalid`).

Inside `on_update` and `on_ui`, `genex::ui::tr("resume")` answers the text of a key and
`genex::ui::tr_args("coins", &TextArgs::new().num("n", 3))` fills its arguments (at most 8). A key
the locale lacks draws as itself and records `text-missing`; a broken file records `text-invalid`,
an oversized one `text-too-large`, a font that is not an asset `text-font-missing`. Outside those
hooks, or without `game.ui`, `tr` answers the key. `genex::ui::locale()`,
`genex::ui::reduced_motion()` and `genex::ui::safe_area(ui)` (the phone's insets as an egui margin)
read the same layers. The locale is the person's saved choice, then the OS locale, then the first
listed. A Genex run ignores the person's choice and the OS locale and has no safe area, so a check
sees the defaults unless the session sets them. In a Studio run the `uiSettings` verb sets that
session layer (locale, scale, safe area, text size) from the next tick; `xx-pseudo` shows pseudo
text when `.pseudo_locale(true)` offers it. `textSize` is recorded and answered back; gameplay UI
does not read it yet.

The kit draws in one pass and moves by pad or keys: `Menu::new("pause").item("resume", &tr("resume")).back("resume").show(ui)`
answers the picked item's key (its `back` key on B or Escape), and `Dialog::new("quit")`,
`ItemGrid::new("bag", 6)`, `ItemList::new("quests")` and `Bar::new("hp", 0.5)` follow the same
pattern; `Toasts::push(ui.ctx(), ToastKind::Info, &tr("saved"))` queues a notice and
`Toasts::show(ui)` draws the queue. A menu focuses its first item when it opens. The d-pad or left
stick moves focus, A accepts, B cancels and the bumpers walk in drawing order; a held direction
repeats after 24 ticks, then every 6. A game with `game.input` navigates by its `ui_*` actions
instead. While a widget holds focus, the update hooks read the d-pad, the left stick, A, B and the
bumpers as released, so a menu never moves the player.

Every kit widget has a key (`pause.settings`), so a check finds it in `state().hud.widgets`
(`{role, label, key, rect, focused}`), reads `state().hud.focus` and clicks its rect. An invalid or
repeated key records `ui-key-invalid` or `ui-key-duplicate`. `state().volatile.ui` shows
`{locale, scale, safeArea, issues}`, and a text file's issues also appear in
`state().__render.assetIssues`. None of it enters the checksum.
