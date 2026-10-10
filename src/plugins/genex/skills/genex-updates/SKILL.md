# Genex updates in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's updates card,
unchanged. Where it disagrees with this preface, this preface wins.

- Studio ships and pins the Genex CLI, so ignore its update nudges and skills-refresh lines: never
  run `npm i -D @genex-ai/cli-demo`. Skill cards are never written into the game.
- Studio also pins `@genex-ai/multiplayer` and `@genex-ai/embed-sdk`: add them only with
  `genex__package`, which installs Studio's version. Never run `npm i …@latest` for them.
- If a Genex tool reports that the CLI is below the minimum supported version (HTTP 426,
  `cli_update_required`), tell the user Studio needs an update; there is nothing to run.
- The out-of-credits and email-verification rows still apply as the card says.

<!-- upstream @genex-ai/cli-demo/templates/skills/genex-updates/SKILL.md v1.36.4 sha256 abebfaa0d8d27ce76e24b8455873ec775a43fbb9098c99b465bdb404de292d89 -->
---
name: genex-updates
description: Apply Genex platform updates safely. Use when a genex command prints an update nudge ("⬆ Genex … available — run: …"), a skills-refresh line ("🔄 Genex skills updated"), or an update-required refusal (HTTP 426, cli_update_required), or when the user asks about updating Genex packages.
---

# Genex Updates — apply platform updates at safe moments

Genex ships improvements continuously. The `genex` CLI tells you when something
is stale; you (the agent) apply the update at the right moment and tell the
user what happened. The user never manages versions themselves.

## The signals in `genex` output

| Line | Meaning | What you do |
| -- | -- | -- |
| `🔄 Genex skills updated to X.Y.Z` | Skills were auto-refreshed to match the installed CLI. | Nothing — informational. Skills stay in sync on their own. |
| `⬆ Genex <package> X.Y.Z available (installed A.B.C) — run: <command>` | A newer npm package exists. | Run the printed command at a **safe moment** (below), then tell the user. |
| `✗ … below the minimum supported version … Update now — run: <command>` | The API refuses this CLI version (HTTP 426, `cli_update_required`). | Run the printed command **now**, then re-run the refused genex command. |
| `✗ Out of credits — … costs N credits; your balance is M.` | The account can't cover this generation (HTTP 402, `insufficient_credits`). | Relay the printed facts (balance, cost, refill date, link) to the user; offer a procedural placeholder so the build continues — see the generation skill's Troubleshooting. |
| `✗ Email not verified — …` | Generation credits are locked until the email is verified (HTTP 403, `email_verification_required`). | Give the user the printed verify link, wait for them to confirm, then re-run the command. |

## Safe moments — when to apply a nudge

Update when nothing is in flight:

- at the start of a session, before you begin the user's task;
- between tasks, after the current change is finished and working;
- right before a `genex preview`/`publish` you have **not** started yet.

Never mid-task: not during a build or deploy, not halfway through a code
change, not while the user is waiting for something else. A nudge is a
suggestion — if now is not a safe moment, finish first; the nudge reappears on
the next command. (The 426 refusal is the exception: nothing works until you
update, so update immediately.)

## How to apply

Run exactly the command the nudge printed, from the game project root:

```bash
npm i -D @genex-ai/cli-demo@latest   # the genex CLI (a dev dependency)
npm i @genex-ai/embed-sdk@latest     # identity/saves SDK (ships inside the game)
npm i @genex-ai/multiplayer@latest   # multiplayer SDK (only if the game uses it)
```

Skills refresh automatically on the next `genex` command after a CLI update —
no extra step. Then tell the user in one short line what changed and why it
matters, e.g. "I also updated Genex to 0.22 — skills and SDK refreshed." For
what's new, check the package page: https://www.npmjs.com/package/@genex-ai/cli-demo

## Hard rules

- **Never touch game code as part of an update.** Everything in the game's
  `src/` — including vendored controller code in `src/controllers/` — is
  user-owned and may carry customizations. Updates never overwrite it. If a
  newer controller exists you may *mention* that `genex controller <type>
  --force` re-vendors it, but run that only when the user explicitly opts in
  (it overwrites their changes).
- **Never update silently.** `npm i …@latest` changes `package.json` — that is
  the sanctioned path, but always say in chat that you did it.
- **Never downgrade**, and never pin to an old version to "fix" an error —
  report the error instead.
- **Never switch the CLI's channel.** A project built from the dev stand
  (`dev.genex.games` — check `dashboardOrigins` in `.genex/project.json`)
  runs `@genex-ai/cli-demo@dev`; installing `@latest` there is a downgrade to
  the production build — it swaps the installed skills and re-points every
  command at the wrong stand. Run exactly what the nudge printed (it is
  channel-aware; on the dev channel it never offers a CLI update at all).
- **Verify after updating**: the game should still build/run. If it does not,
  say exactly what broke rather than quietly reverting.
- If `npm i` fails (offline, registry down), say so and continue on the
  current version — everything keeps working, and the nudge will reappear.
- A published game is never affected by any of this: its live bundle is frozen
  and keeps working regardless of local package versions.
