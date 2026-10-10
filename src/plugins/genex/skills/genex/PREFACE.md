# Genex in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's own guide, unchanged.
Where it disagrees with this preface, this preface wins.

## What does not apply in Studio

- "Where to run this", "Setup" and the CLI version paragraph. The game's folder is already the
  workspace, Studio ships and pins the Genex CLI, and the user signs in to Genex once in Studio.
  Never check or install Node, never run `npx genex`, `npm i -g` or `npm i -D @genex-ai/cli-demo`,
  and never run `auth`, `tools` or `init`.
- Skill cards are never copied into the game: no `.claude/skills`, `.agents/skills` or `AGENTS.md`
  is written. The Genex cards Studio carries are this plugin's skills, listed in your brief; read
  one with `genex__skill {"name":"<skill>"}`.

## Commands, as Studio tools

- Generation (`image`, `model`, `model segment|rig|animate`, `texture`, `sfx`, `music`, `voice`,
  `character`, `animations search`) and `wait`: `genex__asset`. Call it with operation `status`
  first; it reports the account, credits and live lanes that `doctor` would. Its description lists
  the operations; delivered files land in the game, so wire in those local paths.
- `doctor`, `budget`, `llm models`, `llm status`, `llm cancel` and `shop list`: `genex__cli`.
  `budget --assets` is not available: Studio's own asset allowance and the user's approval govern
  asset spending.
- `llm bench` and `shop add|set|remove|test`: `genex__cli-paid`. The user approves each call,
  because it spends coin or changes what the game sells.
- `publish` and `promote`: `genex__publish {"operation":"gallery"}`, which also updates the draft;
  use it when the user wants the game published. `preview` alone: `genex__publish
  {"operation":"draft"}`, a test build that leaves the public version as it is. Follow a publish
  with `genex__publish-status` for the job and the links.
- `cover`, and the frame `preview` picks up from `.genex/scratch/cover.png`: the game's demo named
  `genex-cover`, checked with `genex__cover {"operation":"shoot"}`. Publish (`genex__publish`)
  shoots it again and sends it, and `genex__cover-set` sends it now; `genex__cover
  {"operation":"status"}` is `npx genex cover` with no file. Read `genex__skill
  {"name":"genex-cover"}` first, and never save a frame in `.genex/scratch`.
- `npm i @genex-ai/multiplayer`: `genex__package {"package":"@genex-ai/multiplayer"}`, and
  `npm i @genex-ai/embed-sdk`: `genex__package {"package":"@genex-ai/embed-sdk"}`. Studio picks
  the version and the user approves the install.
- A `genex__cli` call carries the words of the command, its positional argument and its flags by
  name without dashes: `npx genex llm cancel <id>` is
  `genex__cli {"command":"llm cancel","args":"<id>"}`, and `--all` is `"options":{"all":true}`.
- Any other `npx genex` command is not available in Studio. Say so rather than work around it.
