# Genex publishing in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's publishing card,
unchanged. Where it disagrees with this preface, this preface wins.

- Publishing is one step: `genex__publish {"operation":"gallery"}` exports the game, updates its
  draft page and makes that same build the public version (`npx genex publish` the first time,
  `preview` then `promote` after). Use it when the user wants the game published or online.
  `npx genex preview` alone is `genex__publish {"operation":"draft"}`: an unlisted test build that
  leaves the public version as it is. Each asks the user first and returns a job: follow it with
  `genex__publish-status {"operation":"wait","jobId":"<jobId>"}`, then give the user the operation’s
  reported link verbatim: `galleryUrl` for a public release, `draftUrl` for a draft. Do not
  construct a URL or report a draft link as the public release. If the job has not succeeded,
  report its actual state rather than claiming publication.
- Studio exports and uploads the game itself. Glue step 3 (the CLI as a dev dependency) and
  `init --convert` do not apply, and `npx genex pull` is not available. Glue steps 1 and 2 still
  apply; for step 2 read `genex__skill {"name":"genex-threejs-embed-auth"}`.
- Studio does not pass on the CLI's preflight lines. `warnings` in `genex__publish-status` carries
  lines about the game's Genex cover instead (no shot sent, a frame refused or not sent, a frame too
  small or not 16:9): after the link, relay each one as the card says to relay the preflight.
- The card's opening ("The user built this game themselves", "as it is") describes only a game
  whose code its owner keeps untouched, such as a folder they brought and asked only to publish.
  Publishing a game Studio built starts no rework either, but its cover demo is not a rework: see
  the next point.
- The card's "The cover": in Studio the frame is the game's demo named `genex-cover`, game code the
  game keeps, and Publish shoots and sends it; read `genex__skill {"name":"genex-cover"}`. Before
  any publish of a game Studio built, the first or an update, check `genex__cover
  {"operation":"status"}`: with no kept shot it gets its `genex-cover` demo, shot and checked,
  first. After a publish whose own cover outcome is `none` (`cover.last.jobId` is its `jobId`),
  offer once to make one, and not again in this chat once the user says no. Only a game whose
  owner keeps its code untouched gets none: Publish then sends no cover and Genex keeps its own.
- `npx genex doctor` is `genex__cli {"command":"doctor"}`. Other commands map onto Studio tools as
  the `genex` skill describes (`genex__skill {"name":"genex"}`).

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-tool-publish/SKILL.md v1.36.4 sha256 5fb8097f9cd1285227d25f09498d3e87d52ba5e3af8d5b5083e715bf91e3c9fc -->
---
name: genex-tool-publish
description: Put the game in this folder on the web with Genex — the draft page, `npx genex preview`, then `promote` / `publish`; the link you hand the user, the size limits, and what to do with the preflight lines. Installed once the folder is connected to a hosted Genex game (`npx genex init --convert`). Load it before the first preview.
---

# Genex Tools · Publish

The user built this game themselves and asked for it online. Your job is to
put it there **as it is** — the code, the structure and the assets stay
exactly what they are. Publishing adds glue and nothing else; it never starts
a rework, a design document or a build plan.

## The glue (all of it)

1. **A static build.** The game must build to files with its own build
   command — `npm run build` into `dist/`, or an `index.html` at the root
   with no build step. Asset paths must work from the game's own hosted URL,
   so prefer relative ones (Vite: `base: './'`). Files the game loads at
   runtime — everything in `./assets` — must end up inside the build (Vite:
   a `public/` folder, or copy `assets/` into `dist/` in the build).
2. **Player identity.** Load `$genex-threejs-embed-auth` and add the one
   `initEmbed(...)` call at the very top of the boot code. Create the
   renderer and draw a frame BEFORE any `await waitForPlayer()` — on a hosted
   page identity takes seconds, and a game that awaits it first ships black.
3. **The CLI as a dev dependency** so plain `npx genex` keeps resolving here
   (setup already did this; check `package.json` if in doubt).

Commit the glue as its own small commit when the folder is a git repo, so the
line between the user's game and what publishing added stays visible.

## Preview

```bash
npx genex preview
```

Builds, uploads and puts the build on the game's **draft page** — unlisted,
only the user can open it. When it reports live, open the hosted build once
yourself and confirm it loads with no missing files (the dev server forgives
paths the hosted build will not), then hand over the link.

**The link is always the game's page on Genex, never the raw play address,
never localhost, never a file path:**

- draft: `<dashboard>/draft/<slug>`
- public, once published: `<dashboard>/<slug>`

`<dashboard>` is the first `dashboardOrigins` entry in `.genex/project.json`
and `<slug>` is the `slug` there. `preview` prints the exact page link as
"your game's page" — use that line verbatim.

## The preflight is a report, not a to-do list

`preview` prints warning lines before it uploads — an estimated phone GPU
budget, a music track with no volume slider, a paid asset nobody wired, a
viewport meta line. None of them blocks the deploy, and none of them was
asked for. So: **ship first**, hand over the link, then relay each line to
the user in one plain sentence with an offer ("phones will struggle with the
textures — want me to shrink them?"). Fix one only on the user's yes. Never
turn the report into a milestone before the link.

## The cover

The game's cover is one real frame of it — what its gallery card, its page and
every shared link show — and `preview` ends with a line while it has none.
Once the first preview is up, `$genex-cover` says how to choose, frame and send that
frame. The game stays as it is: take the frame from play and add no code for
it, and never set up a browser just for this.

## Draft and public version

`preview` updates the **draft** and never touches what players are on. The
first release lists the game:

```bash
npx genex publish --categories games
```

Pick 1–3 categories that fit (`games`, `assets`, `physics`, `terrain`,
`lighting`, `vfx`); `games` when unsure. Ask before the first publish — "This
is a private draft only you can open. Say the word and I'll publish it for
anyone to play." — and celebrate the public page link when it lands.

After that first release the game is two versions, and the user only ever
hears these two words for them: the **draft** (updated by `preview`) and the
**public version** (what everyone plays). "Publish it", "update it" and "yes"
after the first release ALL mean:

```bash
npx genex promote      # the exact draft build goes public — no rebuild
```

Never run `publish` a second time (it would ship an untried rebuild). If
anything changed since the last `preview`, preview again before promoting.
Ask once per round of work, in one line, and keep working while you wait.

## Limits and refusals

- **Upload size**: ~95 MB per file, ~500 MB in total. Over that, tell the user
  plainly which part is too large (usually a video, model or audio file) and by
  roughly how much; ask before compressing or removing anything.
- **Terms refusal**: the CLI prints a link, waits for the user's click and
  re-sends by itself — hand the link over and let it finish.
- **`preview` says the folder is behind another machine** (`stale_source`):
  `npx genex pull` takes the newer draft, then redo the change — never
  `--force` over somebody else's work.
- **Out of credits or a lane down**: `npx genex doctor` says which; publishing
  itself costs nothing.
