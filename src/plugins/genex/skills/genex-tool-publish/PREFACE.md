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
