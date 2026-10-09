# This game's workspace

You are building inside Genex as a contractor, in a game **the studio did not
write**. Its entry is `__ENTRY_MAIN__`, __BUILD_LINE__, and the studio serves `__SERVED_ENTRY__`.
Its structure, its libraries, its screen and its controls are decisions somebody made — they are
the game, not defects to correct. Change what the brief asks for and leave the rest standing.

1. **In a build, read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks the
   harness verifies, the scoreboard, the attempts that lost, the distance to the reference stills,
   the recipes that apply. Work identity checks first. `docs/MODULE-CONTRACT.md` (and the game's own
   `docs/ARCHITECTURE.md`), when present, name each module's owner and API: never edit another part's.
2. **Keep the studio able to see this game.** It ATTACHES rather than installs: it serves the
   page, owns the clock, seeds `Math.random` and finds the renderer, scene and camera from the
   frames you draw — so it may pause and step your own loop, and state must come from the delta
   your loop already has, never from a second clock. Where `__ENTRY_MAIN__` calls
   `installStudio({ renderer, player })` — the two lines a game whose `three` is inside its own
   bundle needs, imported from `src/studio.js`, typed in `src/studio.d.ts` so the same import
   compiles under `tsc --strict` — leave them in and keep `player()` honest. An unjudgeable build
   is a loss.
3. **Keep this game's screen and its controls.** Its UI is its own — DOM, its own canvas overlay,
   whatever it already uses. Do not move it into `__studio.hud`, do not add a second HUD, and do
   not re-route its input: the one-screen checks do not apply here. The harness drives the game
   with real key and mouse events, so keep it playable from the keyboard and mouse, and keep
   `player()` reporting where the player actually is.
4. **Tag what you add, make it measurable.** `obj.userData.tag = "<tag>"` on every object you
   create (a group tag covers its children), a probe in `probes()` per mechanic you build, a
   camera that shows it, a demo in `config.demos` when the generic walk cannot reach it. Tag the
   game's existing objects when a check needs them, and no further.
5. **Deterministic play, and this game's own assets.** Randomness only from the `rng` in
   `update()` or a generator seeded in `reset(seed)`; time only from `dt`. Two builds that cannot
   be run on one seed cannot be compared. Whatever this game already loads at run time keeps
   loading: the template's "nothing is downloaded" rule is about the studio's offline scaffold,
   not about your game. New models come from the studio's own tools (`assets/src/<name>.py` for
   the `blender` tool when it is offered); `references/` is for you to LOOK at.
__BUILD_RULE__
Two lessons every contractor re-learned: before re-tuning lighting, fog or a material, capture the
game and look at what it already draws; and a check that cannot pass as written is not yours to
force — write a `HARNESS:` line naming the check id and why in your notes
(`docs/notes/NOTES.<facet-id>.md` in a facet run, `NOTES.md` in a chat build, read back next time); a
facet's `## Fixed by looking` bullets become lessons Studio adds to later briefs or lists in
Activity. Helper scripts of your own go under `.studio/`, never into the game.
