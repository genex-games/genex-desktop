# Text

Every word a game shows comes from a Fluent file, so a translation is a file and a check can show
the game in another language. Register the locales once with
`game.ui(UiConfig::new().locales(&["en", "fr"]))`: the first is the fallback, and each one's text
is `assets/lang/<locale>.ftl` in the boot group. The person's saved choice wins, then the OS
locale (the desktop window and the phone shells read it once at start), then the first listed. A
Genex run ignores both, so a check sees the first locale unless the session sets one (`uiSettings`).
Every call in one line:

```rust
use genex::prelude::*;                                         // UiConfig, TextArgs
use genex::ui::{Locale, PSEUDO_LOCALE};                        // PSEUDO_LOCALE: "xx-pseudo"
game.ui(UiConfig::new().locales(&["en", "ja"]).font("ja", "fonts/NotoSansJP.ttf").pseudo_locale(true));
genex::ui::tr("title-new");                                    // -> String: the key itself outside the hooks
genex::ui::tr_args("toast-saved", &TextArgs::new().str("slot", "quick").num("coins", 3)); // -> String
genex::ui::locale();                                           // -> Option<Locale>; locale.tag() -> &str
```

```ftl
title-new = New game
toast-saved = Saved to { $slot }
hud-coins = { $coins ->
    [one] { $coins } coin
   *[other] { $coins } coins
}
```

- **Looking up.** Inside `on_update` and `on_ui`, `genex::ui::tr("title-new")` answers a key's text
  and `genex::ui::tr_args("hud-coins", &TextArgs::new().num("coins", 3))` fills its arguments (at
  most 8; `.str(name, text)` for words). Outside those hooks, or without `game.ui`, `tr` answers the
  key itself. Keep a label's key stable and change its text in the file.
- **Plurals** follow each language's CLDR rules: French puts 0 in `one` (`0 pièce`), English in
  `other` (`0 coins`). Always write the `*[other]` default.
- **The settings menu's own words** are keys too, English when the game's file lacks them:
  `settings-tab-<tab>`, `settings-preset`, `settings-custom`, `settings-default`, `settings-reset`, `settings-on`,
  `settings-off`, `settings-audio-<bus>`, `settings-language`, `settings-ui-scale`,
  `settings-text-size`, `settings-subtitles`, `settings-reduced-motion`, `settings-screen-shake`,
  the preset names `default`, `quiet`, `dialogue`, `comfort`, the choices `auto`,
  `ui-scale-<75|100|125|150|200>` and `text-size-<100|125|150|200>`, and one key per locale tag
  for the language row (`en`, `fr`). Put them in every file to translate the whole menu.
- **Fonts.** The HUD's fonts are Latin text fonts. `.font("ja", "fonts/NotoSansJP.ttf")` adds a
  game-shipped fallback font for one locale; an emoji or icon glyph draws as a box.
- **Pseudo-locale.** `.pseudo_locale(true)` offers `xx-pseudo`, which accents, pads by 40% and
  brackets every catalog string, so a label that would overflow in a longer language overflows
  in a capture. A key missing from the catalog shows plain, so a plain word in a pseudo capture
  is a key the files lack.
- **Issues.** A key the locale lacks draws as itself and records `text-missing` (once per key); a
  broken file `text-invalid` (its valid messages still load), a file over 256 KiB
  `text-too-large`, a font that is not an asset `text-font-missing`, and a session locale the game
  does not offer `text-locale-unknown`. They appear in `state().volatile.ui.issues`, and a file's
  issues also in `state().__render.assetIssues`. A check that switches locale should expect `[]`.
- Right-to-left scripts are not supported yet.

Check a translated game under the `xx-pseudo` locale on a landscape screen and on a phone with a
notch: a label that leaves the screen or its cell is a defect.
