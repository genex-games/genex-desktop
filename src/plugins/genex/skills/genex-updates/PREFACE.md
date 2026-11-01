# Genex updates in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's updates card,
with the passages of advice Studio does not ship taken out. Where it disagrees with this preface,
this preface wins.

- Studio ships and pins the Genex CLI, so ignore its update nudges and skills-refresh lines: never
  run `npm i -D @genex-ai/cli-demo`. Skill cards are never written into the game.
- Studio also pins `@genex-ai/multiplayer` and `@genex-ai/embed-sdk`: add them only with
  `genex__package`, which installs Studio's version. Never run `npm i …@latest` for them.
- If a Genex tool reports that the CLI is below the minimum supported version (HTTP 426,
  `cli_update_required`), tell the user Studio needs an update; there is nothing to run.
- The email-verification row applies as the card says.
