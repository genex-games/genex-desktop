# Design board

The stage's **Design** tab is a canvas that holds a game's design: artboards the game's agent
makes for the person to see, choose from and keep, and pictures the person adds. It comes before
the build: for a new game the agent asks a few questions, puts the design here, and builds what
the person agrees to.

## What the person sees

- **The tab.** Design stands after Builds for every game. An empty board says what it is for and
  offers **Ask for a design**, which leaves a request in the game's chat to finish and send.
- **The canvas.** Every artboard of the board, section under section: a section's name stands
  above its first artboard, each artboard under its caption. Wheel zooms about the cursor, a drag
  of the bare canvas pans, the zoom control fits everything, and a press on a caption brings that
  artboard into view, as on Builds and Assets. The canvas stays fitted until the person moves it; a
  moved canvas comes back as they left it.
- **Moving artboards.** A drag of an artboard's caption, or of a picture itself, moves it anywhere
  on the canvas, and it stays there. The artboards the person has not moved keep their rows, as if
  the moved one were not on the board. **Tidy up**, beside the zoom once anything was moved, puts
  every artboard back in its row.
- **Artboards.** A **picture** hangs large (one height for all, its own shape). A **3D model** is a
  tile marked 3D that shows the model itself, to turn by hand: the board's first four load by
  themselves, shimmering as an asset card does while they load, and one past that, or one that
  failed to load, is a tile to press. The model is read
  through the asset preview, which reads `docs/design/` beside a game's asset folders
  (`main/core/assets.ts`). A **page** is a sheet in the
  app's own look (dark or light with the app, Genex's typefaces), 1200 px wide and at least 800 px
  tall, that grows to what it holds (to 4000 × 12000) and never scrolls.
- **No buttons on a page.** A page is read, not pressed: the person answers on the canvas (notes,
  picks) and in the chat. A link to another page brings it into view and an `https` link opens in
  the browser. A page written when pages had buttons (`data-say`) no longer shows them.
- **Live.** A new or changed file shows within two seconds, and for a few seconds carries Genex's
  mark (an accent ring and a cursor named Genex). A changed page loads behind its sheet and takes
  its place once loaded, so it never blinks through an empty sheet; nothing else reloads.
- **Dropping pictures.** A picture dragged onto the canvas hangs where it was let go, its middle
  under the pointer, and is the person's to move like any artboard; it carries no mark of Genex's.
  There is no section for these: one that has no place (dropped on an empty board, or after Tidy
  up) hangs in a last row with no name. The agent is told to look at them before it designs.
- **Tools.** Bottom centre: **Move** (the tool in hand unless another is taken), **Note**, and
  **Add a picture**, which hangs pictures chosen from the computer at the canvas's middle.
- **Notes.** With Note in hand a press pins a yellow sticky there and opens it to type (Enter keeps
  it, Escape drops it). A note pressed on an artboard is pinned to it and goes where it goes; one
  on the bare canvas stays on the canvas. A note is dragged to move, pressed twice to reword, and
  removed with its ×. It says **Not sent yet** until the agent was told, then **Sent to Genex**; a
  reworded note is new again.
- **Picks.** Only the artboards the agent offers to pick among (`show_design`'s `choose`) wear
  **Use this** and **Not this**, under the pointer; no other artboard does. The one to go with
  wears a ring and **Chosen**; one set aside fades under **Not this**. Pressing the pick it has
  takes it away.
- **The agent's pointer.** Shown with a spot (`show_design`'s `spot`), an artboard comes into view
  with a ring at that spot and the agent's few words beside it, under its cursor. It stays until
  the person next presses the canvas, or the agent shows something else.
- **Being drawn.** Artboards the agent said it is about to make (`show_design`'s `making`) hang
  before their files exist, each at the end of its section: the one being drawn shimmers under
  **Genex is drawing …**, the ones after it wait as empty frames named **… · next**. Each becomes
  the artboard when its file arrives; a list the agent never made good on goes after 15 minutes.
  The Design tab opens when the agent says what it is making, so the person watches it appear.
- **Tell Genex.** Bottom right, while there are new notes or picks: how many, and **Tell Genex**,
  which sends them as the person's own message in the game's chat. Each note names its artboard by
  title and file and where on it the note is (percent across and down); each pick names the
  artboard to use or to drop. They count as told once the chat has really sent them.
- **The block in the chat.** Where the agent showed an artboard (`show_design`), the chat holds
  one block: a small stack of the board's artboards with the shown one on top (pictures as
  themselves, pages as a sheet's shape, never as text), a **Game design** tag, the artboard's title
  and the agent's few words (else how many artboards the board holds). One press opens the Design
  tab on that artboard. An artboard has one block, where it was last shown; one that left the
  board leaves a line.
- **News.** A board that changed since the person last looked marks its tab (`Design ●`). A page's
  name in the chat (`docs/design/world/map.html`) says **Opens in Design** and does.

## Where the board lives

`docs/design/` in the game folder. A file there is an artboard by its kind: `.html` a page, an
image a picture, a `.glb` (or another model the Assets viewer opens) a model. A folder is a
section, named as it reads (`world`, `game-ui`; a leading number only orders it); `from-you` is
the person's and always last; `img` is never a section, at the top or inside one: pictures only a
page needs go there. Nothing deeper is read. The app keeps no layout of its own: the files are the
board, read again every two seconds while the tab or a block is on show, every ten while not. The
folder is documentation: saved and rewound with the game, never exported or published
(`substrate/game-export.ts` skips `docs`).

What a plugin generates lands in the game folder (Genex's under `assets/`); a page shows such a
picture, sound or video by its path, and the agent copies or generates into the board what belongs
to the design.

## What a page may do

A page is agent-written, so it is drawn as an inert document:

| Rule | How it is held |
| --- | --- |
| HTML and CSS only; no script of the page's runs | Policy `script-src 'sha256-…'` names Genex's bridge alone; no `.js` is ever served |
| No network | `default-src 'none'`, `connect-src 'none'`; pictures and media only from `genex-design:`, fonts from it or `data:` |
| No frame, form, base or navigation | Policy; the frame is `sandbox="allow-scripts"`; main keeps the window's frames on its own schemes (`subframeMayLoad`, `will-frame-navigate`) |
| Reads only the game | Pages from the board only; pictures, sounds, videos and style sheets from the game folder; never a hidden file, `node_modules`, code, or anything a link leads out to. A page's version reads the same set, by `lstat` |
| Cannot name another game | Each game's host on the scheme is random per launch (`DesignHosts`) |
| Says only six things | The tab reads a frame's message only from its own frame, as a `DesignSignal`, every field checked and cut (`readDesignSignal`) |

Genex puts three things on a served page (`main/design-bridge.ts`): its two typefaces, from a
reserved folder of the scheme (`/~genex/fonts/`, the app's own font files and nothing else); its
colours as variables in the app's look (`--genex-bg`, `--genex-ink`, `--genex-accent`, …; the
address carries `t=light` for the light look), so a page built with them looks like Genex; and the
bridge, the one script, which reports the page's title and size, hands the wheel and drags to the
canvas, and reports what was pressed.

A dropped picture is kept by main (`core.design.drop`): only a picture, at most 20 MB, under its
own file name (a taken name is numbered), in `docs/design/from-you/`, a folder reached by no link.

## When the agent uses it

The chat's per-turn rules (the harness seed's `chat-session.ts`) decide the order for a new game,
or a large new part of one: ask (a few plain-text questions, one at a time), then design, then
build once the person agrees. A game named by a likeness ("a game like GunZ") is asked about like
any other. Only an ask to just build, or a small game the request gives whole ("make me Pong"),
builds at once.

The board of a game that is not built yet gives its folder no kind: a `docs/` holding only
`design/` is Genex's output (`substrate/project-shape.ts`), so the game still takes its starter
when its first build begins.

`show_design` (`main/core/design-board-prompts.ts`) is handed to the chat's own session on every
turn. Beside the artboard to show (`page`, with a `note` for its block in the chat) it takes `spot`
(where on that artboard to point, as percent across and down), `making` (the artboards it is about
to make, in order) and `choose` (the artboards the person is to pick among; a new list replaces
the last and an empty one ends the choosing). A call that only announces answers in a line; the
app tells the canvas with `design.shown`, `design.making` and `design.choices`. Its description says what the board is, that the design goes here before a build once the
direction is settled, when not to use it (a small fix, a question, a progress report, "just
build"), and that the person's pictures are in `from-you`. Called with no page it answers how to
design on the board (pictures first, pages for what a picture cannot say, Genex's variables, what
to make for a concept, a world, characters, game UI, systems or a change) and lists what the board
holds now, the person's pictures apart. Called with an artboard and a `note` it emits
`design.shown`, so the tab opens on it when its game is on the stage, and from the game's own chat
records `design_shown` (`{project, file, title, note}`, host-written only): the block. It writes no
file, so Plan mode lets it run.

Not yet: the person cannot move artboards, write on the canvas or leave notes; a build's lead has
no `show_design` (it works in its build's own folder, which the board does not read); a local
model's turn has none either; a chat in Plan mode cannot write an artboard before its plan is
approved.

## What the person did

Where the person put artboards, their notes and their picks, and the artboards the agent offers to
pick among, are kept in one hidden file of the
board, `docs/design/.genex-board.json` (`shared/design-marks.ts`), so it travels with the game.
The board never lists it and no page can read it. It is read as untrusted: only the board's own
artboards are named in it, every number and text is bounded, and anything else is dropped. What is
saved is what a read would take. `core.design.marks` reads it (the file itself, never a link) and
`core.design.saveMarks` writes it in the board's own folder, reached by no link. `core.design.offer`
replaces the choices and leaves the rest as it is.

The agent never reads this file. Notes and picks reach it as the person's message (Tell Genex), and
the guide `show_design` answers says what they are: a note names its artboard and the spot on it, a
note on one of the person's own pictures says what that reference is for, and a pick is the
artboard to go with or to drop.

## Where to work

- Contract: [`shared/design-board.ts`](../src/shared/design-board.ts) (kinds, sections, signals,
  `design_shown`, the page look), [`shared/design-marks.ts`](../src/shared/design-marks.ts) (what
  the person did on the board).
- Main: [`main/design-pages.ts`](../src/main/design-pages.ts) (list, titles, versions, serve,
  policy, fonts), [`main/design-bridge.ts`](../src/main/design-bridge.ts),
  [`main/core/design-board.ts`](../src/main/core/design-board.ts) (`core.design`: board, serve,
  drop, marks, show), `showDesign` in `main/core/project-tools.ts`, the scheme and the frame guard
  in `main/index.ts`, IPC `studio:design.board`, `studio:design.drop`, `studio:design.marks` and
  `studio:design.marks.save` (fixture-safe).
- Renderer: [`panels/design/`](../src/renderer/panels/design/): `DesignStage.tsx` (the canvas,
  loaded with the tab), the pure `design-model.ts` (sizes, layout, names), `board-marks.ts` (what a drag, a drop, Tidy
  up, a note and a pick do to the marks) and `board-tell.ts` (the message Tell Genex sends),
  `BoardNotes.tsx`, `BoardPick.tsx`, `BoardTools.tsx` and `BoardAgent.tsx` (the agent's pointer and
  the artboards being made) with their words in `board-words.ts`,
  `use-board-marks.ts` and `use-artboard-drag.ts`, `design-frames.tsx`,
  `design-boards.ts` (every reader's board) and `design-asks.ts` (the tab's mark, and asking for
  an artboard); the block in `chat/DesignPageCard.tsx` (on `chat/BuildCard.tsx`, loaded with the
  first block a chat shows).
- Tests: `design-pages`, `design-bridge`, `design-tab`, `design-tool`, `design-marks`,
  `design-notes`, `design-agent` and `design-card` conformance. The `design-board` fixture's agent
  offers three places, announces two artboards and points at a spot once the window is up.
- See it: `npm run studio:dev -- start --profile design --fixture design-board`
  (`STUDIO_FIXTURE_INTERACTIVE=1` for a visible window).
