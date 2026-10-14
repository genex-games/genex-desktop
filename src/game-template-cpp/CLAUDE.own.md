# This game's workspace — read this page, then `.studio/BRIEF.md`

You are building inside Genex as a contractor, in a C++ raylib game **the studio did not write**.
Its entry is `__ENTRY_MAIN__`, and the studio builds it with CMake for the destinations in
`studio.json`. Its structure, its libraries, its screen and its controls are decisions somebody
made — they are the game, not defects to correct. Change what the brief asks for and leave the
rest standing.

1. **Read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first.
2. **Keep the studio able to build and see this game.** `CMakeLists.txt` must reach
   `include("${GENEX_CMAKE}")` and `genex_add_game(...)`: the studio's own `genex.cmake` owns the
   toolchain, raylib and the flags, so `find_package(raylib)`, `FetchContent` and a second copy of
   raylib are defects. Where the entry calls `studio::install({...})`, keep it and every verb in
   `src/studio.h`; a build the studio cannot run is a black screen for every critic.
3. **Keep this game's screen and its controls.** Its UI and its input handling are its own. Do not
   move them into `studio::hud` or `ctx` unless the brief asks: the one-screen checks do not apply
   here. The harness drives the game with real key, mouse and gamepad input, so keep it playable.
4. **Tag what you add, make it measurable.** Tag what you draw (`studio::tag`), a probe in
   `probes()` per mechanic you build, a camera that shows it, a demo when a generic walk cannot
   reach it. Tag the game's existing draws when a check needs them, and no further.
5. **Deterministic play, and this game's own assets.** Randomness only from a generator seeded in
   `reset(seed)` (or `ctx.rng`); time only from `dt`. Two builds that cannot be run on one seed
   cannot be compared. Whatever this game already loads keeps loading; new models come from the
   studio's own tools; `references/` is for you to LOOK at.

Two lessons every contractor re-learned: before re-tuning lighting, fog or a material, capture the
game and look at what it already draws; and a check that cannot pass as written is not yours to
force — write a `HARNESS:` line naming the check id and why in your notes
(`docs/notes/NOTES.<facet-id>.md` in a facet run, `NOTES.md` in a chat build), whose
`## Fixed by looking` section is mined into the next run. Never run `build/…` yourself: the first
`error:` of a failed studio build is the one that matters.

Where the game runs: `capture` builds it and looks through its cameras; Live shows the web build
when Browser is a destination; **Play on Mac** opens it in a window of its own that belongs to the
person, never to you. A studio run gives the game its own `state/` folder to save in (captures land
in `state/captures/`), never this one. `build/` is scratch: never committed, served or judged.
When your shell has `GENEX_CMAKE`, `cmake -S . -B build -DGENEX_CMAKE="$GENEX_CMAKE"` then
`cmake --build build` compiles there (CMake never reads `GENEX_CMAKE` from the environment).
