## Building a web game

This game is a web page, and these rules come on top of the ones above.

1. **Look in the preview.** After changing the game, reload the preview, press a control
   (`press_keys`, `look`, `click`), take a screenshot, and read `game_state()`.
2. **Keep `window.__studio` working** when the game has it: the preview and a Loop's checks drive
   and inspect the game through it (seed, start, pause, step, state, debugCamera).
3. **Keep play comparable.** No `Math.random()` and no wall-clock time in gameplay: a Loop compares
   builds on one seed.
