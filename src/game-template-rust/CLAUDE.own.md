# This game's workspace — read this page, then `.studio/BRIEF.md`

You are building inside Genex as a contractor, in a Rust game **the studio did not write**. Its
entry is `__ENTRY_MAIN__`, and the studio builds it with its own Rust toolchain from `genex.toml`
for the destinations in `studio.json`. Its structure, its screen and its controls are decisions
somebody made — they are the game, not defects to correct. Change what the brief asks for and
leave the rest standing.

1. **Read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first.
2. **Keep the studio able to build and see this game.** Keep `genex::install(game)` at the end of
   the entry's `main`, and keep `genex.toml` the only build input: the studio writes the cargo
   manifest and the lock, so a `Cargo.toml`, a build script, cargo configuration or `unsafe` here
   are defects. `docs/GENEX_API.md` is the API; a build the studio cannot run is a black screen for
   every critic.
3. **Keep this game's screen and its controls.** Its UI and its input handling are its own. The
   harness drives the game with real key, pointer, touch and gamepad input, so keep it playable.
4. **Tag what you add, make it measurable.** `frame.tag(..)` before what you draw, a probe per
   mechanic you build, a camera that shows it, a demo when a generic walk cannot reach it. Tag the
   game's existing draws when a check needs them, and no further.
5. **Deterministic play, and this game's own assets.** Randomness only from `ctx.rng` or the reset
   `rng`; time only from `ctx.tick` and `ctx.dt`. Two builds that cannot be run on one seed cannot
   be compared. Whatever this game already loads keeps loading; new models come from the studio's
   own tools; `references/` is for you to LOOK at.

Two lessons every contractor re-learned: before re-tuning lighting or a material, capture the game
and look at what it already draws; and a check that cannot pass as written is not yours to force —
write a `HARNESS:` line naming the check id and why in your notes
(`docs/notes/NOTES.<facet-id>.md` in a facet run, `NOTES.md` in a chat build), whose
`## Fixed by looking` section is mined into the next run. `target/` is scratch: never committed,
served or judged.
