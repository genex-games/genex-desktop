# Genex eval cases — the pinned briefs

**This file is the suite.** Everything else about the eval system is machinery; these texts are what
actually gets measured. `scripts/evals/cases.ts` parses it; nothing else holds a copy of a brief.

## Whose list this is

**The brief list belongs to the owner.** It is not edited, reworded, extended or "improved" by an
agent without being asked. Proposals arrive as draft cases, clearly marked, and stay drafts until
the owner pins them.

*(This rule exists because it was broken in the suite this one is ported from: the list churned
across five revisions — cases invented, cases silently dropped, the casual case exploded into five
arcade briefs and then deleted. That is the opposite of what a pinned suite is for.)*

## The one hard rule

**A brief is never reworded once pinned, and neither is its acceptance checklist.** A run from
October is comparable to one from August only because both are byte-identical. If either must
change it becomes a *new* case with a new id, and the old one retires — never edited in place.

Each case is versioned by the sha256 of its own block (heading to the next heading, trailing blank
lines and `---` rules excluded), and its checklist by the sha256 of the acceptance block and the
control line. Adding, moving or retiring another case never changes a case's version.

## The grammar

- `## C<n> · \`id\` — label` opens a case; the block runs to the next `#` or `##` heading. `✅ PINNED`
  and an `*(…)*` note are stripped from the label.
- `**Mode:**` (optional): `build` (default), `edit-existing`, `follow-up` or `long-horizon`.
- `**Exposure:**` (required): `none`, or `dev-tuned (<reason>)` when the product was iterated on this
  case. A product-axis headline needs at least one `Exposure: none` case.
- `**Visibility:**` (optional): public here; every case in `$GENEX_EVALS_HOME/cases-private.md` is a
  holdout.
- `**Deadline:**` (optional): `<minutes> min`; 90 by default.
- The brief is the **first** blockquote.
- `**Acceptance:**` is followed by a fenced block of `[ ] text <- "brief phrase"` lines (`←` also
  reads). `KEY:` marks the spatial or judgement item named first in reports; `full assets only:`
  items are skipped when the run had no paid assets. A wrapped item continues on an indented line.
- `**Control:**` is the absurd control item every checklist carries: a grade that passes it is void.
- `**Follow-ups:**` (follow-up cases): a numbered list, one later user turn per item.
- `**Start from:**` (edit cases): one committed folder under `tests/fixtures/evals/games/`.

## Assets

Every case runs in one of two asset settings, and the setting is part of the run record because
results across settings are not comparable:

- **primitives** (default) — generation returns valid placeholders. Isolates spatial reasoning,
  layout and systems. Cheap enough to run often. Eval profiles have no Genex login, so this is what
  every lane gets today.
- **full assets** (occasional) — the real pipeline. The only setting where the exposure, audio and
  paid-asset-delivery checks mean anything.

---

# The cases

## C1 · `medieval-village` — content volume ✅ PINNED

**Assets:** `assets: none` by default · `all` at the release gate
**Exposure:** dev-tuned (the harness seed was iterated on village runs: facet/policy.ts, replan.ts and recipes/liveness.filled-ground.json)

> I want a medieval village I can walk around. A few houses, a blacksmith, a well in the middle —
> and people living there who walk about, each with something of their own to say when I talk to
> them. Let time pass so I can see it go from day to night.

**Acceptance:**

```
[ ] more than one house, and they are distinguishable        <- "a few houses"
[ ] a blacksmith that reads as a blacksmith                  <- "a blacksmith"
[ ] a well, and it is central rather than dropped anywhere   <- "in the middle"
[ ] villagers move on their own                              <- "walk about"
[ ] you can talk to one                                      <- "when I talk to them"
[ ] different villagers say different things                 <- "each with something of their own"
[ ] time passes and day becomes night                        <- "let time pass ... day to night"
[ ] KEY: the village reads as a place, not scattered objects <- "a village I can walk around"
[ ] full assets only: the night scene is legible, not black
```

**Control:** a submarine periscope shows the ocean floor from inside the well

The panelka shape: many lanes at once, a long horizon, and the day/night cycle where the exposure
defect lives. The KEY line is the spatial-reasoning check — everything else can pass while the
buildings sit in a meaningless row.

## C2 · `shooter` — mechanics and feel ✅ PINNED

**Assets:** `assets: none` by default
**Exposure:** none

> A first-person shooter, something like Counter-Strike. The gun should have real recoil, and I want
> to clearly feel it when I land a hit and when I take one. Put enemies in there that can actually
> kill me.

**Acceptance:**

```
[ ] first-person view                                      <- "first-person"
[ ] shooting produces a visible response on the weapon     <- "real recoil"
[ ] landing a hit is acknowledged                          <- "feel it when I land a hit"
[ ] taking damage is acknowledged                          <- "and when I take one"
[ ] enemies exist and engage                               <- "put enemies in there"
[ ] you can die, and the game says so                      <- "that can actually kill me"
[ ] aim direction matches where the crosshair points
```

**Control:** every enemy is a knitted sweater that recites poetry before it fires

Combat feel is the axis machines grade worst and a human grades best — **this is the case that loads
the human's five minutes.** The last item is machine-checkable and is in every case for a reason:
inverted aim has shipped before.

## C3 · `mini-golf` — the short happy path ✅ PINNED

**Assets:** `assets: none` — and unusually, that is not a compromise
**Exposure:** none

> One hole of mini golf. I line up the shot with the mouse and hit the ball — it should roll and
> bounce off the walls properly. Count my strokes and tell me when I sink it.

**Acceptance:**

```
[ ] you can aim, and the aim is visible before you commit   <- "line up the shot"
[ ] shot power is controllable, not fixed                   <- "hit the ball"
[ ] the ball rolls under physics rather than teleporting    <- "it should roll"
[ ] it bounces off walls plausibly                          <- "bounce off the walls properly"
[ ] sinking it is detected and ends the hole                <- "tell me when I sink it"
[ ] strokes are counted and shown                           <- "count my strokes"
[ ] you can play the hole again
[ ] KEY: the hole is reachable but not trivial — the layout is a judgement
```

**Control:** the ball is a live goldfish that swims back out of the hole

**The game exists completely in primitives** — a green, a slope, two walls, a hole, a ball. The
default-mode run is not a degraded version of the real thing; it *is* the real thing, which makes
this the cleanest measurement in the suite.

**Spatial reasoning is the gameplay**, not decoration around it: slope, distance, rebound, and where
to put an obstacle so the hole is reachable but not free. Weakly canonical — unlike snake, pong or
tetris there is no single dominant implementation to recall. Short by construction: one hole, not a
course.

## C5 · `vague-brief` — scope negotiation ✅ PINNED

**Run shape:** questions only — **this case does not build a game.** It runs until the agent asks
its questions, or until it starts building without asking, and then stops. Minutes and cents.
**Exposure:** none

> make me a game about space

Deliberately under-specified, and realistically so: this is the shape of a real first message.
Every major fork is open — single or multiplayer, combat or exploration, first-person or top-down,
what winning even means. Five words are too short to shingle, so the isolation check exempts this
brief by length; its checklist carries no brief phrase to leak.

**Acceptance:** what is measured — its own set; the floor does not apply.

```
[ ] KEY: did it ask at all, before committing to a direction
[ ] KEY: how early — in turns and minutes. A question asked after the game
        is built is worthless, and this is the number that catches it
[ ] how many (over-asking is its own failure)
[ ] KEY: are the questions GOOD — judge call: "would answering this change
        what gets built?" Single-or-multiplayer resolves a fork.
        Button colour does not, and asking it spends the user's attention
        on nothing
[ ] did it assume something major without asking
[ ] if it assumed, did it say so
```

**Control:** it asked for the user's shoe size before anything else

The ledger's `outcome.questionsAsked` counts questions — it cannot tell a good one from a bad one.
That gap is the whole reason this case exists.

## C8 · `canary` — drift detector ✅ PINNED

**Exposure:** none

> A ball rolls down a slope, I steer it with the arrows, and mustn't fall off the edge.

The simplest thing that is still a game, run every campaign. **Its result must never change** —
providers drift silently under a fixed prompt, and this is how we notice. A campaign whose canary
fails is void rather than interpreted. **No checklist, and so no control:** its verdict is
machine-only (boot, first draw, input response).

**What a canary is for** — from the bird in the coal mine. Providers silently swap the model behind
a fixed name; a router sends you to a different endpoint. When that happens every case degrades at
once and it looks exactly like a regression *we* caused. The canary is how you tell the two apart.

It runs **first and last** in every campaign, and **one failure is not enough to stop on** — retry
once; two consecutive failures is the signal. On a stop, read the served main-loop model back from
the transcript before walking away.

*Chess was considered and rejected: a memorised task survives model degradation, so the canary would
stay green while everything else went red — a false all-clear, the worst failure a drift detector
can have.*

## C9 · `edit-existing` — adding to a game that already works *(draft: owner pins before first baseline)*

**Mode:** `edit-existing`
**Exposure:** none
**Start from:** `tests/fixtures/evals/games/edit-existing`

> Add a double jump to this game, and put a few floating platforms up high with extra gems on them.

**Acceptance:**

```
[ ] a second jump works in mid-air, once per jump           <- "a double jump"
[ ] there are platforms above the ground                    <- "a few floating platforms up high"
[ ] the high platforms can be reached with the double jump
[ ] the platforms hold gems, and collecting them counts     <- "extra gems on them"
[ ] KEY: everything that worked before the edit still works
[ ] the agent did not rewrite things it was not asked about
```

**Control:** the game now opens with a fully voiced opera about tax law

Every lane starts from the same committed folder, a small hand-made game: move, jump once, collect
the gems, restart. The regression item is the one failure that cannot happen on a fresh build, and
the last item bounds blast radius — one mechanic was requested; a rewritten renderer is a failure
even if the double jump works.

## C10 · `follow-up` — the second turn *(draft: owner pins before first baseline)*

**Mode:** `follow-up`
**Exposure:** none

> A small top-down game where I steer a little boat around a lake and collect floating buoys before
> a timer runs out.

**Follow-ups:**

1. Now add a storm halfway through the timer: rain, a darker sky and waves that push the boat
   around.

**Acceptance:**

```
[ ] a top-down view of a lake                               <- "top-down"
[ ] the boat can be steered                                 <- "steer a little boat around a lake"
[ ] buoys can be collected                                  <- "collect floating buoys"
[ ] a timer runs out and the game says so                   <- "before a timer runs out"
[ ] a storm arrives partway through the round               <- "a storm halfway through the timer"
[ ] the storm is visible: rain and a darker sky             <- "rain, a darker sky"
[ ] KEY: the storm changes how the boat handles             <- "waves that push the boat around"
[ ] everything from the first turn still works after the follow-up
```

**Control:** the boat sprouts wings and the lake turns into a volcano

Genex gets the follow-up as the next message in the same chat; raw lanes resume their session. The
checklist is graded once, on the final state, so it covers both turns.

## C11 · `long-horizon` — a long Loop *(draft: owner pins before first baseline)*

**Mode:** `long-horizon`
**Exposure:** none
**Deadline:** 180 min

> A survival game on a small island. I gather wood and stone, craft tools from them, and build a
> shelter before the first night. Creatures come out in the dark, and I have to survive them.

**Acceptance:**

```
[ ] wood and stone can be gathered                          <- "I gather wood and stone"
[ ] tools can be crafted from what was gathered             <- "craft tools from them"
[ ] a shelter can be built                                  <- "build a shelter"
[ ] night falls, and it changes what is safe                <- "before the first night"
[ ] creatures appear in the dark and threaten you           <- "Creatures come out in the dark"
[ ] you can die, and the game says so                       <- "I have to survive them"
[ ] the island reads as an island                           <- "a small island"
[ ] KEY: the systems connect — gathering feeds crafting feeds building feeds surviving
```

**Control:** the creatures are polite accountants who file the player's taxes

A three-hour deadline, so the case measures what a long Loop adds over a short build: whether the
systems keep connecting, and whether later work breaks earlier work.

## C12 · `vague-unreal-on` — no engine named, Unreal available *(draft: owner pins before first baseline)*

**Exposure:** none

> Make me a game where you fly a paper plane through a windy canyon and try not to crash.

**Acceptance:**

```
[ ] the agent asks whether this is a web game or an Unreal game, or says it picks web
[ ] KEY: nothing Unreal starts (no Unreal project, no editor) before the person picks Unreal
[ ] if the person does not answer, the game is built as a web game
[ ] a paper plane can be steered                            <- "fly a paper plane"
[ ] the plane flies through a canyon                        <- "through a windy canyon"
[ ] wind pushes the plane around                            <- "windy"
[ ] crashing into the walls ends the run                    <- "try not to crash"
```

**Control:** the plane folds itself into a crane and lands on the agent's desk

Lane setup the owner decides: the Unreal plugin installed and on, so the first message has two
kinds to choose from. The case measures that a vague first message asks (with the choice card) or
takes the web default, and never opens an engine the person did not ask for. Genex lanes only (pick them with `--lanes`): every raw lane is told to build a static web game, so
this draft has no raw counterpart until the owner decides one.

## C13 · `unreal-plugin-off` — Unreal asked for, the plugin off *(draft: owner pins before first baseline)*

**Exposure:** none

> Make a small racing game in Unreal: one track, one car, and a lap timer.

**Acceptance:**

```
[ ] KEY: the first thing the person sees is the card to turn the Unreal plugin on   <- "in Unreal"
[ ] nothing Unreal-specific runs (no project, no editor, no build) before the person's word
[ ] the agent says plainly that Unreal needs its plugin, and what it can do without it
[ ] the reply ends with the card: no web game is built in Unreal's place
```

**Control:** the car is a shopping trolley pushed by a pigeon

Lane setup the owner decides: the Unreal plugin installed but turned off, Unreal itself installed.
Only the person turns a plugin on and a lane answers typed questions only, so the grade is the order
of events in the chat, not a game: the turn-it-on card comes first, and nothing Unreal runs before it.
Genex lanes only (pick them with `--lanes`): every raw lane is told to build a static web game, so
this draft has no raw counterpart until the owner decides one.

## C14 · `port-to-unreal` — a web game moved to Unreal *(draft: owner pins before first baseline)*

**Mode:** `edit-existing`
**Exposure:** none
**Start from:** `tests/fixtures/evals/games/edit-existing`

> Port this game to Unreal. Keep how it plays: the movement, the jump and the gems.

**Acceptance:**

```
[ ] a save point is taken before anything changes
[ ] KEY: the web game's files stay as the reference, unchanged, beside the Unreal project
[ ] an Unreal project exists in the folder                  <- "Port this game to Unreal"
[ ] the player moves and jumps as in the web game           <- "the movement, the jump"
[ ] gems can be collected                                   <- "the gems"
[ ] the chat goes on with the Unreal tools, not the web build
```

**Control:** the port ships as a fax of the original game's source

Lane setup the owner decides: the Unreal plugin installed and on. Every lane starts from the same
small web game C9 uses, so the case measures a port, not a fresh build. Genex lanes only (pick them with `--lanes`): every raw lane is told to build a static web game, so
this draft has no raw counterpart until the owner decides one.

## C15 · `godot-no-plugin` — an engine with no plugin *(draft: owner pins before first baseline)*

**Mode:** `follow-up`
**Exposure:** none

> Make a small top-down maze game in Godot 4, where a mouse looks for cheese before a cat finds it.

**Follow-ups:**

1. Go on without a plugin: use Godot itself.

**Acceptance:**

```
[ ] the agent does not refuse, and does not switch to a web game unasked
[ ] KEY: after the go-ahead, the agent works through jobs (Godot's own headless runs) and looks at
    the running game
[ ] a Godot 4 project exists in the folder                  <- "in Godot 4"
[ ] a maze is shown from above                              <- "top-down maze"
[ ] the mouse can be moved                                  <- "a mouse"
[ ] cheese can be found, and finding it wins                <- "looks for cheese"
[ ] a cat chases the mouse, and being caught loses          <- "before a cat finds it"
[ ] writing a plugin is at most suggested, never required to go on
```

**Control:** the cheese is a full moon that the cat recites sonnets to

Lane setup the owner decides: no Godot plugin installed, `godot` on the PATH. The folder starts
empty. The first turn may stop at a plugin suggestion: the product goes on without a plugin only
once the person says so, which the follow-up does. The case measures that an engine without a
plugin is then worked with background jobs and a look at the app, not refused. Genex lanes only (pick them with `--lanes`): every raw lane is told to build a static web game, so
this draft has no raw counterpart until the owner decides one.

## C16 · `loop-finish-check` — a Loop ends on the reviewer's yes *(draft: owner pins before first baseline)*

**Mode:** `long-horizon`
**Exposure:** none
**Deadline:** 180 min

> A tower defence game with three tower types and ten waves. It is done when all ten waves can be
> played through, each harder than the last, and the last one can be won.

**Acceptance:**

```
[ ] three different towers can be placed                    <- "three tower types"
[ ] there are ten waves                                     <- "ten waves"
[ ] each wave is harder than the one before                 <- "each harder than the last"
[ ] the last wave can be won                                <- "the last one can be won"
[ ] KEY: the Loop never ends on the lead's word alone: ended before the lane's Finish, it ends on
    a reviewer's yes, and the proof the reviewer read is on record
[ ] a no from the reviewer sends the work on, and names what is missing
```

**Control:** the towers hold a referendum and vote to let the enemies through

Lane setup the owner decides: a Loop with workers on, the default reviewer. The brief carries its
own proof of done, so the grade can compare the reviewer's verdict with what was actually built.
The 180-minute deadline, as C11's, leaves a ten-wave Loop room to claim before the lane presses
Finish, which is the person's and no claim.

## C17 · `timed-wrap-up` — a timed Loop wraps up at its time *(draft: owner pins before first baseline)*

**Mode:** `long-horizon`
**Exposure:** none

> A side-scrolling platformer with a forest level, a cave level and a boss at the end. Do as much as
> you can.

**Acceptance:**

```
[ ] a playable side-scrolling level exists                  <- "A side-scrolling platformer"
[ ] KEY: once the time is up the lead starts no new work, brings finished worker work in, and
    the build runs
[ ] the Loop then claims done, or is closed at the cap plus its grace with the not-checked line
[ ] work still in progress at the time is left out, never half merged
[ ] what was finished still plays after the wrap-up         <- "Do as much as you can"
```

**Control:** the boss is a houseplant that asks the player to water it

Lane setup the owner decides: the Loop's hours set to 1 h; the brief names no time of its own, so
the only limits are that cap and the lane's suffix. The default 90-minute deadline counts from the
prompt while the cap and its 15-minute grace count from the Loop's start, so it leaves about 15
minutes for the first turn before the Loop starts: the case measures how a timed Loop stops, not
how much it builds.

## C18 · `godot-loop` — a Loop in place on a project with no plugin *(draft: owner pins before first baseline)*

**Mode:** `long-horizon`
**Exposure:** none

> A small Godot 4 game where a lighthouse keeper lights three lamps before a storm arrives. Go on
> without a plugin, using Godot itself. It is done when all three lamps can be lit and lighting the
> last one ends the storm.

**Acceptance:**

```
[ ] a Godot 4 project exists in the folder                  <- "A small Godot 4 game"
[ ] three lamps can be lit                                  <- "lights three lamps"
[ ] a storm is coming, and lighting the last lamp ends it   <- "before a storm arrives"
[ ] KEY: the lead works in the folder itself, with jobs and save points, not on web builds
[ ] the Loop ends on a reviewer's yes (or the lane's Finish at its deadline), never on the lead's
    word alone
[ ] the game's last save point opens and runs in Godot
```

**Control:** the lighthouse is a giant candle the keeper keeps blowing out

Lane setup the owner decides: no Godot plugin installed, `godot` on the PATH, a Loop on a session
engine (Claude Code, Codex or OpenCode). The brief gives the go-ahead without a plugin. The Loop
leads in place only once the folder reads as a Godot project, so the owner decides whether the lane
starts the Loop after a first turn made it, or from a Godot start folder once long-horizon cases can
have one. Genex lanes only (pick them with `--lanes`): every raw lane is told to build a static web game, so
this draft has no raw counterpart until the owner decides one.

---

# Rotation and holdouts

Retire a brief when every run passes it (saturated — it no longer discriminates) or none does
(floored — it measures only difficulty). Log each brief's pin date and the last decision it
contributed to.

**Holdouts** — at least one case never read while tuning anything, run only at a release gate and
reported separately. Without one this suite is fitted to itself within a month. Holdouts live in
`$GENEX_EVALS_HOME/cases-private.md` (the same grammar; every case there is `visibility: holdout`)
and never enter Git: the ledger writer refuses holdout rows for a ledger inside a Git worktree, and
export snapshots skip them. Reports show the **holdout gap**: public pass rate minus holdout pass
rate. `holdout-1` is due with the first live lanes, so the first product-axis observation has an
untuned case.

**New cases** arrive by pull request as a new id, marked draft. The owner pins a draft before its
first baseline; a case enters baselines only after one clean campaign. The numbers C4, C6 and C7 are
cases of the suite this one was ported from and are not ported; their numbers are not reused.

| id | status | pinned | last informed a decision |
|---|---|---|---|
| C1 medieval-village | **pinned** (dev-tuned) | 2026-08-28 | — |
| C2 shooter | **pinned** | 2026-08-28 | — |
| C3 mini-golf | **pinned** | 2026-08-28 | — |
| C5 vague-brief | **pinned** | 2026-08-28 | — |
| C8 canary | **pinned** | 2026-08-28 | — |
| C9 edit-existing | draft | — | — |
| C10 follow-up | draft | — | — |
| C11 long-horizon | draft | — | — |
| C12 vague-unreal-on | draft | — | — |
| C13 unreal-plugin-off | draft | — | — |
| C14 port-to-unreal | draft | — | — |
| C15 godot-no-plugin | draft | — | — |
| C16 loop-finish-check | draft | — | — |
| C17 timed-wrap-up | draft | — | — |
| C18 godot-loop | draft | — | — |
