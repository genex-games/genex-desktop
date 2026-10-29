# Evals data

The committed inputs of the offline eval harness (`scripts/evals/`, CLI `npm run eval`), and the
rule for what never enters Git. The current behaviour is described in [docs/evals.md](../docs/evals.md).

## Committed here

| File | What it is |
| --- | --- |
| `lanes.json` | The lane registry: one row per lane (`genex-claude`, `raw-claude`, `raw-codex`, `genex-codex`, the two `-auto` lanes, the two `-plugin-off` lanes, which turn the Genex plugin off through `disabledPlugins`, and the four fixture lanes). Validated by `scripts/evals/lanes/registry.ts`. Adding a model or a lane is a new row. `flagsDigest` pins each lane to `laneFlagsDigest` (`scripts/evals/lanes/argv.ts`: its argv shape, the shared suffix and answer sentence, the raw deliverable, the stripped environment, for raw lanes the credential policy and permission mode, and the plugins a Genex lane turns off); a test fails when they drift. Lane ids must pass the ledger guard. |
| `prices.json` | Dated API-equivalent USD per million tokens. Anthropic first-party rates as of the date in `asOf` (cache writes at the 1-hour rate, 2× input, because Claude Code on a subscription writes every cache entry with a 1-hour TTL; cache reads at the published rate). `gpt-6.1-sol` is `{"unknown": true}` because no public price is known: its cost is reported as unavailable, never guessed. |
| `cases.md` | The frozen public cases, parsed by `scripts/evals/cases.ts`; each case is versioned by the sha256 of its own block. Drafts are marked and pinned by the owner before a first baseline. `npm run check:isolation` (part of `check:static` and CI) fails when a case's words appear in what the in-app agent or the graders read. |
| `aaa/suite.json` | The AA+ release-gate suite: held-out Rust-stack briefs with the views, demos and CC0 references each is graded on, validated by `scripts/evals/aaa/suite.ts` and held out by `check:isolation` ([the AA+ release gate](../docs/evals.md#the-aa-release-gate)). Its reports and reference stills stay local. |
| `baselines/<case>.json` | Promoted raw values per public case × lane, written by `npm run eval -- baseline promote`; holdouts are never written. |
| `ledger/export-<appSha>.jsonl` | Per-release, public-cases-only, guard-checked ledger snapshots, written by `npm run eval -- ledger export`. |

`ledger/` exports are generated data and are excluded from Biome; `baselines/` stay under Biome,
and `baseline promote` formats each file it writes with `biome format --write`.

Version reference #0 is the app at `47f7e286` (the `dev` commit the harness was designed against);
every later `appSha` is compared to it on the version axis.

## Local only, never committed

Everything a run produces stays under `$GENEX_EVALS_HOME` (default `~/.genex-evals`): the ledger
(`ledger/{runs,pairwise,human}.jsonl`), evidence (`evidence/<runId>/`), work folders, eval-owned app
builds, the CLI homes (`homes/claude`, `homes/codex`) and the private holdout cases
(`cases-private.md`); a running lane's agent works in a lane root under the system temp folder
until the run ends. The repository holds no secret: the operator signs in to the eval homes
themselves, and the eval ingest key, the sharing install identities and the record of shared rows
live in `$GENEX_EVALS_HOME/secrets/`.

## Running

`npm run eval -- --help` lists the commands. Commands that spend provider quota or send data need
`--live` and never run in CI; the fixture lanes run without any account. The campaign runbook is
in [docs/evals.md](../docs/evals.md#campaign-runbook).
