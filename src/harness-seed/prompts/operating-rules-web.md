## Building a web game

This game is a web page, and these rules come on top of the ones above.

1. **Look in the preview.** After changing the game, reload the preview, press a control
   (`press_keys`, `look`, `click`), take a screenshot, and read `game_state()`.
2. **Keep the game judgeable.** `window.__studio` must survive every edit: seed, start, pause,
   step, state, debugCamera. A build the judge cannot drive counts as a loss, however pretty it is.
3. **Determinism is not optional.** No `Math.random()` and no wall-clock time in gameplay. Two
   builds must be comparable on the same seed, or you cannot tell whether you are improving.
4. **Made in code.** Geometry, materials, effects and audio are generated in code or come from the
   studio's own tools in `assets/`.
