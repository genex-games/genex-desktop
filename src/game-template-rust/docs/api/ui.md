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
