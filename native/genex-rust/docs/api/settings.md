# Settings

`genex::settings::menu(ui)` draws the whole settings menu from `on_ui`: a row of tabs over the open
tab. RB and LB (Tab and Shift+Tab) switch tabs, up and down move along the rows, left and right
change the focused row, A activates, and B backs out. The pointer moving onto a row focuses it,
so one row is outlined at a time. `menu` answers whether something changed;
`genex::settings::menu_answer(ui)` also answers the tab drawn and `back`, so a pause menu can close
it.
The types live in `genex::settings`, not the prelude. Every type and call in one line:

```rust
use genex::settings::{MenuAnswer, SettingDef, SettingValue, SettingsConfig, SettingsTab};
game.settings(SettingsConfig::new().option(tab, def).preset(tab, "veteran", &[("game.hints", value)])); // -> &mut Game
SettingDef::toggle(key, label, default);                       // default: bool
SettingDef::slider(key, label, min, max, step, default);       // all f32
SettingDef::choice(key, label, &["off", "some", "all"], default); // default: u16, an index
// SettingValue::Bool(bool) | Number(f32) | Choice(u16); SettingsTab::Graphics | Audio | Controls | Accessibility | Game
genex::settings::menu(ui);                                     // -> bool: something changed
genex::settings::menu_answer(ui);                              // -> MenuAnswer { tab, changed, back }
genex::settings::value("ui.subtitles");                        // -> Option<SettingValue>
genex::settings::number("ui.screen_shake"); genex::settings::flag("ui.subtitles"); // -> f32, bool
genex::settings::comfort();                                    // -> genex::camera::Comfort, in any hook
```

`SettingValue` and `SettingsTab` are `#[non_exhaustive]`: a `match` on one ends with `_ => {}`.

| Tab | What it holds |
|-|-|
| Graphics | field of view offset (`graphics.fov_offset`, -10 to +20 degrees), brightness (`graphics.brightness`, -1.5 to +1.5 stops over the game's exposure), motion blur (`graphics.motion_blur`; off drops the look's blur), then `genex::render::settings_panel`: quality preset, upscaling, frame rate, dynamic resolution, features (saved in `genex-render.json`) |
| Audio | master volume and the `music`, `sfx`, `ui`, `voice` and `ambience` buses; presets Default, Quiet, Dialogue (not in a build with `[audio] enabled = false`) |
| Controls | `controls_panel` (`docs/api/ctx.md`; only with `game.input`; saved in `genex-input.json`) |
| Language & Accessibility | language (with `game.ui` locales), UI scale, text size, subtitles, reduced motion, screen shake, head bob; presets Default, Comfort (reduced motion, no shake, no head bob, 125% text) |
| Game | the game's own options and presets (only when it registers some) |

Every tab has presets plus per-option control. A change applies after the tick's UI hooks, outside
the simulation: a bus volume reaches the mixer at once, and the UI scale, language and reduced
motion reach `genex::ui` from the next tick (a Studio `uiSettings` session layer stays on top).
`genex::settings::value("ui.subtitles")`, `genex::settings::number("ui.screen_shake")` and
`genex::settings::flag("ui.subtitles")` read any option in any hook: the update and UI hooks see
this tick's menu change, and the read hooks (camera, draw, probe) the settings as of the last
tick. `genex::settings::comfort()` gathers what a camera obeys (`ui.head_bob`, `ui.screen_shake`,
`ui.reduced_motion`, `graphics.fov_offset`); `FirstPersonRig::camera` reads it itself
(`docs/api/camera.md`). Brightness and motion blur reach the renderer's live frames by
themselves; a capture shows the game's own look. Text size (100% to 200%) scales the text of everything the UI hooks draw from the next
tick. A preset row reads Default while no preset is chosen and every option is at its default. A
game's option whose text the catalog lacks reads as its words (`settings-hints` as "Hints") and
records `text-missing`.

```rust
use genex::settings::{SettingDef, SettingValue, SettingsConfig, SettingsTab};

game.settings(
    SettingsConfig::new()
        .option(SettingsTab::Game, SettingDef::choice("game.hints", "settings-hints", &["off", "some", "all"], 1))
        .preset(SettingsTab::Game, "veteran", &[("game.hints", SettingValue::Choice(0))]),
);
```

Key a game's options `game.<name>` (`game.difficulty`, `game.hints`) so they read apart from the
built-in rows. A game option is `SettingDef::toggle(key, label, default)`, `SettingDef::slider(key, label, min,
max, step, default)` or `SettingDef::choice(key, label, &options, default)`. The game's options go
on the Game tab and take no reserved prefix (`audio.`, `ui.`, `input.`, `graphics.`); a preset may
set any tab's options. Install refuses a second `game.settings`, an option off the Game tab or with
a reserved prefix, and a preset that does not fit (`settings-invalid`). Labels and option names are
text keys looked up in the game's catalog; the built-in ones fall back to English, and
`docs/api/text.md` lists them so a game can translate the whole menu. A row shows a
0-to-1 slider as a whole percent and any other slider as its number.

The person's choices are saved as `genex-settings.json` in the game's saves (a preset per tab plus
only what the person moved), never per slot. A file that is not a format-1 settings file within the
caps (64 KiB, 256 keys) is refused with `settings-invalid` in `state().volatile.settings.issues`:
the defaults apply and the file is kept until the person changes something; rows for options that no
longer exist are skipped with `settings-key-unknown`, and a value of the wrong type or out of range
with `settings-value-invalid`. A Genex run never reads the saved file, so judged runs start from the
defaults. Nothing here enters the checksum: anything that changes play, such as difficulty, belongs
in the world and its save, not in settings.

`docs/examples/menus-saves/` opens the menu from its title and pause menus and closes it on
`menu_answer(ui).back`.
