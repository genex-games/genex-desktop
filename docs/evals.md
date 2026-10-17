# Evals

The offline eval harness measures how well Genex and the raw coding CLIs build a frozen game
brief. It runs four lanes (the Genex app or a raw CLI, on Claude or Codex), measures every lane
with one instrument, grades every lane with the same lane-neutral graders, and appends one
closed-schema, metrics-only row per run to a local append-only ledger. Code lives in
`scripts/evals/` (CLI `npm run eval`, table in `scripts/eval.ts`), the app's side in
`src/main/smoke/eval-lane.ts` and `src/shared/eval-lane.ts`, and committed inputs in
[`evals/`](../evals/README.md). Judge calibration policy is in
[judge evaluation](judge-evaluation.md). This page describes what exists today.

Live evals spend the owner's subscriptions and run only on the owner's Mac. Nothing here signs
in to a provider in CI; the [fixture lanes](#fixture-lanes-and-ci) run the whole pipeline with no
account and no network.

## Lanes and fairness

`evals/lanes.json` is the lane registry (`scripts/evals/lanes/registry.ts` validates it). Lane ids
are data, never an engine id; binaries resolve through `codingCliBinary`
(`src/substrate/engines/external-cli.ts`).

| Lane | Id | Agent | Model | Status |
| --- | --- | --- | --- | --- |
| A | `genex-claude` | Genex app, product default | `claude-opus-5-5` | primary |
| B | `raw-claude` | Claude Code CLI | `claude-opus-5-5` | primary |
| C | `raw-codex` | Codex CLI | `gpt-6.1-sol` | primary |
| D | `genex-codex` | Genex app, product default | `gpt-6.1-sol` | primary |
| | `genex-claude-auto`, `genex-codex-auto` | Genex app, Auto mode | as A, D | harness |
| | `genex-claude-plugin-off`, `genex-codex-plugin-off` | Genex app, product default, Genex plugin off | as A, D | harness |
| | `fixture-genex`, `fixture-raw`, `fixture-raw-codex`, `fixture-genex-codex` | A, B, C, D on fixtures | `fixture-v1` | fixture |

Each comparison changes one variable: the product axis (A↔B, D↔C), the model-stack axis (A↔D,
B↔C), the product-harness axis (an `-auto` lane against its raw sibling), the version axis (one
lane on a base and a candidate app build in the same campaign) and the cli axis. Rows from
different lanes never average.

A Genex lane can run without some of the app's plugins: its row lists them in `disabledPlugins`
(plugin ids; Genex lanes only). A fresh eval profile has every bundled plugin but Blender on, so
`genex-claude` and `genex-codex` run with the Genex plugin; their `-plugin-off` twins are the same
lanes with it off. Pick either with `--lanes`, e.g. `--lanes
genex-claude-plugin-off,raw-claude,genex-codex-plugin-off,raw-codex` for the 2×2 without it.

What every lane shares:

- The same text: the case brief, then the shared suffix ("You have about N minutes… Nobody will
  answer questions; make reasonable assumptions and continue."). The one deliberate asymmetry:
  raw lanes are also told the deliverable shape Genex lanes get from the template, plus a
  look-at-page line when their browser pin is `look-at-page`.
- The case's deadline (90 minutes unless the case says otherwise) and the same answer policy.
- Effort pinned `high` for both models.
- Eval-owned CLI homes (`$GENEX_EVALS_HOME/homes/{claude,codex}` as `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME`), so the operator's `~/.claude` and `~/.codex` never load. Children start from the
  parent environment minus provider keys and base URLs, `CLAUDE_CODE_*`, `CLAUDE_AGENT_*` and
  `GENEX_*`, with `DISABLE_AUTOUPDATER=1`. Raw lanes also pass the app's contractor filter
  (`childEnv` in `src/substrate/child-env.ts`): every credential-shaped variable and the other
  vendor's variables are dropped and the studio's commit identity is set, as for the app's agents.
- Codex host-skill suppression: every `~/.agents/skills/*/SKILL.md` is disabled by path (a linked
  skill also by its real path, the app's `hostSkillFiles`) and `computer_use`, `in_app_browser`,
  `browser_use` and `browser_use_external` are turned off, on lanes C and D and on the Codex
  grader (`hostSkillSuppressionArgs`). Lane D and the grader run the app's engine, which turns
  these and Codex's own sub-agents off in every session.
- The containment the app gives that engine's main agent. Every argv builder refuses
  `bypassPermissions`, `--dangerously-*` and `danger-full-access`. Each registry row's
  `flagsDigest` pins its argv shape, suffix, answer sentence, deliverable and stripped
  environment, plus the raw lanes' credential policy, raw Claude's permission mode and the
  plugins a Genex lane turns off (`laneFlagsDigest` in `scripts/evals/lanes/argv.ts`); a test
  fails when they drift.
- A live workspace outside the evals home. While a run is live its agent works in a randomly
  named lane root inside `<tmpdir>/genex-evals-lanes/`, a folder its owner can enter but not list
  (a lanes folder inside the evals home is refused). When the run ends, what it made moves into
  `$GENEX_EVALS_HOME/work/<runId>/`; the stream, logs, snapshots and `pinned/` live there
  throughout.

### Raw lanes (B, C)

The agent works in an empty `project/` in the run's lane root. Creating it is refused for a
relative path or a `..` segment, an ancestor holding `.git`, `AGENTS.md`, `CLAUDE.md` or
`CLAUDE.local.md`, an ancestor below `$HOME` holding `.claude`, or an existing non-empty folder,
judged lexically and on the real path. The look-at-page shim runs an eval-owned copy of the
command and its Playwright packages under `builds/look-at-page-<digest>/`, never the checkout's
file.

- Claude: `-p --output-format stream-json --verbose --model --effort --setting-sources ""
  --strict-mcp-config --mcp-config <work>/pinned/empty-mcp.json --permission-mode auto <prompt>`
  (the harness checkout's `DEFAULT_PERMISSION_MODE`).
- Codex: `exec --json --skip-git-repo-check --ignore-user-config -m -c model_reasoning_effort`
  with the app's workspace-write sandbox (the project is the only writable root, approval
  `never`, network per the pin), `allow_login_shell=false`, `forced_login_method="chatgpt"`, the
  suppression above and the prompt on stdin.

The CLI runs as a detached process group. Each stdout line lands in `stream.jsonl` as
`{"receivedAt": <epoch ms>, "line": "<raw line>"}` as it arrives; `stdout.log` and `stderr.log`
keep the raw output. At deadline plus 5 minutes the group gets SIGTERM, then SIGKILL 10 s later;
anything the agent left running is reaped the same way. Guards read typed fields only, never
message text: Claude's assistant error codes, 401/429 and rejected rate-limit events; Claude's
init line must show no MCP servers, plugins or operator skills and the pinned permission mode;
Codex's parent rollout must list only stock skills and inject no `AGENTS.md`. A run that writes
no file fails the zero-files guard. A failure is a typed `harnessFailure`.

### Genex lanes (A, D)

The runner builds the SHA under test once into `$GENEX_EVALS_HOME/builds/<sha>` (`git archive`,
`npm ci`, `node scripts/build.mjs`), reads the commission and permission mode from that build's
own `loop-setting.ts` and `permissions.ts`, writes `lane-spec.json` in the lane root and launches
`electron <build> --studio-smoke --userdata=<lane root>/userdata --studio-eval-lane=<spec>`
(`--studio-eval-fixture` selects the scripted fixture engines). A live spec pins `executables` to
the CLIs the raw lanes resolve; a fixture spec pins none.

Before writing anything, main refuses with exit 78 and `eval lane refused (<code>)` when the launch
is not a smoke launch or is a developer launch (`dev-launch`), the spec is invalid, a live spec
lacks `STUDIO_ALLOW_LIVE_CREDENTIAL_CHECKS=1`, the mode is `bypassPermissions`, or any root it
writes resolves outside `spec.workRoot` (the lane root) or inside `~/AI Games` or the normal
profile. Games live in `spec.gamesRoot`, the only allowed project root; background improvement
is off.

`runEvalLane` checks the engine is ready and lists the model, turns off the spec's
`disabledPlugins` as the Plugins panel's switch does and reads each back, opens a fresh game chat
in the pinned permission mode, sends the brief and suffix with the commission, answers each `ask_user`
question with the policy sentence and approves plan reviews (up to `maxAnswers`), and waits for
idle on two consecutive polls. At the deadline it asks a running build to finish; at deadline
plus grace it takes Stop and ends as `deadline`. `lane-report.json` records the launch path and
budgets, run ids, the permission mode and mode served, questions and answers, the harness digest
against the shipped seed, the template digest taken when the app seeded the game, the first
preview proxy, CLI versions, every installed plugin with whether it was on at the end, and errors. Exit is 0 when the lane reported, 1 when it failed.

The runner types the app's failures like a raw lane's: an engine that was not ready is
`engine-not-ready`; an unknown model, a plugin to turn off that is not installed or stays on, a
failed thread, an unwritten report, a report ending in a harness failure, or a refused (78) or
failed (1) launch with no report is `app-failed`. Any `engine_fallback` event during a run is
`contamination`, and so is a report that does not show a lane's `disabledPlugins` off (a build
from before plugin pins reports no plugins, so its canary fails).

## Eval homes and operator setup

`$GENEX_EVALS_HOME` (default `~/.genex-evals`; an override must be absolute) lives outside any
checkout, resolved by `scripts/evals/home.ts`:

| Path | Holds |
| --- | --- |
| `ledger/{runs,pairwise,human}.jsonl` | The ledger |
| `campaigns/<id>/campaign.json` | Each campaign's plan |
| `work/<runId>/` | The run's project or app user data, snapshots, stream and logs, lane spec and report, `pinned/`, `.lane.pid` while it runs |
| `work/grade-copies/`, `work/npm-cache/`, `work/sandbox-scratch/` | The snapshot server's sandboxed rebuild copies, their npm cache and the sandbox's scratch, shared by grading and the canary (`EvalsPaths` in `scripts/evals/ledger/paths.ts`) |
| `evidence/<runId>/` | Canary boot frames and `grade-<seq>/` folders |
| `builds/<sha>/`, `builds/look-at-page-<digest>/` | Eval-owned app builds; the raw lanes' look-at-page install |
| `homes/{claude,codex}/` | Eval-owned CLI homes |
| `calibration/results.jsonl`, `diagnostics/<campaign>/` | Calibration results, repeatability samples |
| `reports/`, `locks/probe.lock` | `report --html` output, the machine-wide probe lock |
| `secrets/` | Ingest key, install identities (`install.json`) and the shared-rows record (`shared.jsonl`) |
| `reviewer-id`, `cases-private.md` | Reviewer id, holdouts |

Running lane roots (`run-*`) live in `<tmpdir>/genex-evals-lanes/`, outside the home. `gc` sweeps
run-named folders (runs, `<runId>.abandoned-<ms>`, `calibration-<stamp>`) under `work/` and
`evidence/`, aged by their name's stamp; then each entry of the three snapshot-server folders and
each lane root an interrupted run left behind, aged by the newest modification time inside it.
`builds/` grows until removed by hand, as do `copies/`, `npm-cache/` and `scratch/` at the home's
top, where the canary kept its rebuilds before it shared grading's folders.

The harness never reads, copies or resets credentials: the operator signs in to the eval homes
themselves, once:

```bash
CLAUDE_CONFIG_DIR="$HOME/.genex-evals/homes/claude" claude    # then /login
CODEX_HOME="$HOME/.genex-evals/homes/codex" codex login
```

`npm run eval -- doctor` installs and spends nothing. It checks Node 24, both CLIs through the
app's discovery, each home's sign-in status (a Codex API-key login fails), the host skills that
will be disabled, Playwright's Chromium (never downloaded; install it yourself), at least 20 GiB
free, the home outside any repository, `home-env`, and each provider's quota windows against
70%. Reading quota opens a status-only CLI session (no turn sent; its scratch folder under the
system temp folder) for each signed-in home, and that CLI may write its own state there; a home
that is not signed in reports quota unknown and starts nothing. `home-env` fails with
`refused other-cli-home <VAR>` when this process's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` names
another home; `campaign run` and grading refuse with the same line.

## Cases, exposure and holdouts

`evals/cases.md` holds the public cases, parsed by `scripts/evals/cases.ts`. A case opens with
`## C<n> · `id` — label`, needs `**Exposure:** none | dev-tuned (<reason>)`, and may set `Mode`
(build, edit-existing, follow-up, long-horizon), `Visibility`, `Deadline`, `Follow-ups` and
`Start from` (one folder under `tests/fixtures/evals/games/`). The brief is the first blockquote;
`**Acceptance:**` is a fence of `[ ] text <- "phrase"` items with exactly one `**Control:**`
item, an absurd claim no honest grader passes. `version` is sha256[:12] of the case's own block
and `checklistVersion` the same over its checklist, so editing another case never moves it. A
malformed case throws `CaseFileError` naming the case and field.

Pinned: C1 `medieval-village` (dev-tuned: the seed was iterated on village runs), C2 `shooter`,
C3 `mini-golf`, C5 `vague-brief` and C8 `canary` (no checklist; its verdict is machine-only).
C9 `edit-existing`, C10 `follow-up`, C11 `long-horizon` and C12-C18 (projects, engines and the
Loop's finish: `vague-unreal-on`, `unreal-plugin-off`, `port-to-unreal`, `godot-no-plugin`,
`loop-finish-check`, `timed-wrap-up`, `godot-loop`; C12-C15 and C18 on Genex lanes only) are drafts
the owner pins before a first baseline. Private holdouts live in `$GENEX_EVALS_HOME/cases-private.md`, every case
marked holdout; holdout rows never enter Git or an export.

Anti-fitting is a static check: `npm run check:isolation` (in `check:static` and CI, public
cases only) scans the seed, the game template, plugin skills and `*-prompts.ts` for any 7-word
brief shingle or traced checklist phrase of 4 or more words; `--with-holdouts` adds the private
cases locally.

## Metrics

Collectors (`scripts/evals/collect/`) normalize every lane's artifacts into one typed
`RunObservation` timeline stamped by receive time; `scripts/evals/metrics.ts` computes the row
blocks from it. A missing measurement is never zero: a pin is a value, `{unavailable, reason}`
(refuses comparison) or `{na}` (compares equal).

| Metric | Definition |
| --- | --- |
| `time.wallMs` | Prompt to idle or exit; descriptive, lane-shaped |
| `time.toDoneMs` | `wallMs`, censored unless the run ended `agent-finished` (rails are not the model's decision) |
| `time.firstBootMs`, `firstPlayableMs` | Earliest snapshot that boots, and that also passes `l2.enterable` and `l2.input_changes_state`, from the [boot scan](#grading) |
| `time.firstPreviewMs` | Genex: the first `preview_ready`; raw: the first look-at-page |
| `time.builds`, `delegationP50Ms` | Chat delegations and facet builds (Genex lanes) |
| `tokens` | Uncached input, cache write, cache read, output, reasoning; by role (lead, workers, judges, subagents, auxiliary) and by model; `coverage` full, stream-only, partial-judges, trace-dirty or unmeasured |
| `context` | Peak and compactions |
| `calls` | Model calls, and tool calls by `ToolCategory` (`src/shared/eval-lane.ts`: read, search, edit, shell, build, install, browser, studio, subagent, web, planning, skill, other), all classified by `src/shared/tool-category.ts`. In Genex lanes and the app's field rows a tool call is a `tool_use` part of a delegated record; raw Claude and Codex lanes count the stream's tool calls |
| `cost.apiEquivalentUsd` | Tokens priced by `evals/prices.json`; one unpriced model makes it `unavailable: price-unknown` |
| `outcome`, `output` | How the run ended, harness failure, typed no-build, questions, trace completeness, provider noise; `validateGameDir` of the stop-time snapshot, `verifiedBeforeDone` |

Claude calls are counted once per `message.id`. Tokens are normalized per engine by one rule
the app's field rows share (`normalizedTokens` in `src/shared/eval-lane.ts`): Codex input, which
includes cache reads, is reduced to the uncached share, and reasoning already sits inside output.
Auxiliary tokens are each model's reported total (the raw stream's `modelUsage`; for Genex lanes
`Usage.by_model` on `messages`, `build_observation` and `completion_call` records, each engine call
once) minus the calls naming that model. Model ids match without Claude Code's context tag
(`untaggedModelId` in `src/shared/model-id.ts`, the rule the app's field rows use), so a
`claude-opus-5-5[1m]` total and its `claude-opus-5-5` calls are one model, keyed, priced and
given its context window under the untagged id. A delegated chat turn's reply carries its contractor's
report and the turn's `build_observation` repeats it; both readers take it from the reply and skip
that build record (`repeatedBuildUsages` in `src/shared/eval-lane.ts`). A reply marked
`usage_source: delegation` repeats every build record of its turn; in a log from before the
marker, a build record repeats an unmarked reply of the same turn reporting the same five counts,
and a record with no turn never pairs. Genex judges count each logged `completion_call`; Claude ones are left to the
transcripts when those hold the critics' own `judge:*` sessions, and Codex ones always count.
Sub-agent rollouts chain by `parent_thread_id`; transcripts count only sessions in the run's
roots and window, never following symlinks. Studio scratch sessions (`studio-judge-*`,
`studio-playtest-*`) count only for Genex lanes and only between prompt and end. A transcript
main session more than 2% from the stream total trips `token-mismatch`; another main-loop model
trips `served-model-mismatch`, where the served main model is read from a main-loop call (never a
sub-agent's) and one trailing context tag or date suffix (`[1m]`, `-20260901`) still matches. A
torn last line or a missing terminal record marks the trace truncated.
Shell commands are classified at command position after unwrapping and heredoc removal; a
write-then-build command counts once, as build.

### What the app records for evals

The Genex lanes read these from the eval profile's event log (`genex-events.ts`, read-only):

- Engine `Usage` fields are absent, never 0, when unreported: top-level tokens are the main loop;
  `output_tokens` includes reasoning and `reasoning_tokens` is its thinking share; `by_model`
  (Claude) covers every model the session called (field rows count the main model's share beyond
  the main loop as `subagents` and every other model as `auxiliary`); `compactions`,
  `duration_api_ms` and `ttft_ms`. A delegated Claude call's `cost_usd` and `by_model` are its own
  share of its session's running totals: Claude Code reports both as totals a resumed session
  carries on, so the engine subtracts what the same session reported last (remembered across
  restarts; a counter that went down counts from zero, `substrate/engines/session-cost.ts`). The
  calls of one session add up to what it spent, and one turn's passes are joined by adding them
  (`plan-approval.ts` `joinedResult`).
  Context readings keep their source ([native context telemetry](connections-and-context.md#native-context-telemetry)).
- `completion_call` records every `engine.complete`: requested and served model, usage, latency,
  failure kind and the caller's provenance (judge, playtester or SkillOpt gate).
- `build_observation` keeps a chat build's duration, turns, usage and the `preview.ready` answer
  (`ready.pageMs` is a field row's first boot); the delegated turn's reply (`messages`) carries
  the same usage, marked `usage_source: delegation`, and is the one counted;
  `preview_ready` marks a project's first ready preview after a chat build
  ([conversation lifecycle](conversation-coordinator.md)).
- Blind verdicts carry `judged` provenance and the `judgeCall` audit, an eval profile may pin its
  judge, and autopilot closes carry a `stopCode` ([harness runtime](harness-runtime.md)).

A Genex row's tokens are `full` once a judge-role call with measured tokens reaches the timeline,
else `partial-judges`; partial rows are left out of token and cost comparisons.

## Grading

Grading runs after all builds, under the machine-wide probe lock, and only behind a green
calibration covering the current prober version, grader prompt sha and grader models. The lock's
holder touches it every minute; a waiter breaks it only when the holder is gone or its heartbeat
stopped for 30 minutes, atomically (renamed aside, then checked again).

- **Snapshots.** A watcher clones the game folder every 30 s when it changed (APFS clonefile;
  `node_modules` and `.git` skipped; symlinks stay links) into `snapshots/<seq>-<atMs>/` with an
  `index.jsonl`, and always takes a read-only `final` clone at stop. The stop-time snapshot
  decides the typed no-build: `template-untouched` against the lane's template digest,
  `no-entry`, `no-dist` or `build-failed`.
- **Serving.** `grade/serve.ts` serves 127.0.0.1 only, GET and HEAD, real paths inside the root,
  its own Host only. `/vendor/**` maps to a Genex run's own build,
  `builds/<appSha>/dist/resources/vendor` (the run is skipped as `app-build-missing` when that
  build is gone), and to the checkout's `dist/resources/vendor` for raw runs and calibration;
  `grade`, `regrade` and `calibrate` refuse `vendor-missing` (exit 2) until `npm run build` has
  put three.js there. A game with a build script is rebuilt in a writable copy inside
  ProcessSandbox, each step writing only its copy and the npm cache: `npm ci --ignore-scripts`
  with network to registry.npmjs.org only, then `npm run build` offline. A failed rebuild, or an
  output folder outside the copy (`../dist`, an absolute path, a linked `dist`), is unknown, never
  probed.
- **Boot scan.** Coarse (every 4th snapshot plus the last), then bisection; at most 12 probes and
  10 minutes. Past the time budget both times are null with coverage `scan-budget`. When the
  probe cap stops a metric's coarse pass before it finds a pass, that metric is null and coverage
  is `scan-budget`; a time measured before the cap keeps its value, and a bisection the cap cuts
  short keeps its best bracket.
- **Network policy** (`prober/network-policy.ts`): the probe's Chromium reaches only the grade
  server's own origin, `data:`/`blob:` and https reads of the preview's CDN hosts
  (`PREVIEW_CDN_HOSTS`, the product preview's rule). Every other request is aborted and recorded
  as `blocked-by-policy`, WebSockets are closed and service workers blocked. The policy's digest
  is part of `PROBER_VERSION` (`genex-prober/6+desktop.3+cdn.<digest>`), so changing the CDN list
  asks for a new calibration and regrades.
- **Quick probe** (`grade/quick-probe.ts`, `PROBER_VERSION` in `scripts/evals/prober/types.ts`):
  boot within the first-draw timeout, a 3 s idle baseline, the entrance judged by witnesses (never
  a pixel diff), a 4 s gameplay baseline and seven input bursts. It answers the eight quick rows
  with a 20 s error window. Headless Chromium uses ANGLE Metal, falling back to SwiftShader; the
  renderer is read back and frame-rate rows never gate on software.
- **Full prober** (`prober/full-probe.ts`, phases in `prober/phases/`): the quick phases, then
  directions, acknowledgement, interaction, a look sweep, a seeded 300 s soak and a 390×844 phone
  pass, answering every probe row (a 60 s error window, 5-minute survival, frame-rate floor,
  audio, phone viewport). `l3.dark_phase` is `unknown` without an operator review, and
  `l3.spatially_legible` is judge-owned and always `unknown`.
- **Checklist grader** (`grade/checklist/`): one acceptance item per call, `VERDICT: YES|NO`, "if
  the evidence does not show it, NO". Two families, `claude-sonnet-5-5` and `gpt-6.1-sol` at low
  effort, three votes each; families combine by conjunction and are never summed. Evidence is at
  most 8 gameplay frames on the game's origin plus 4 kB console and network summaries; a typed
  no-build or fewer than 2 witnessed frames skips the judge. A family passing the control voids
  the grade (`graderVoid: control-passed`).
- **Pairwise judge** (`grade/pairwise.ts`, rubric `grade/pairwise-prompt.md`): per case and rep,
  (A,B), (D,C), (A,D), (B,C) and each `-auto` lane against its raw sibling, both orders, both
  families, seeded placement. A `-plugin-off` lane takes its twin's slot; two Genex lanes pair
  only when they turn off the same plugins. Only agreeing orders count; an unparsed facet is `invalid`, never a
  tie. When exactly one side is a typed no-build and the other has enough evidence, the pair is a
  forfeit decided with no model call: the side that built wins every facet and the rows carry
  `forfeit: true`. Rows stay in the local ledger.
- **Canary.** C8 opens and closes each provider stream with a boot-only check
  (`l1.builds_and_boots`); a harness failure or no-build fails it.
- **Calibration** (`calibrate [--quick]`): the committed fixtures in
  `tests/fixtures/evals/calibration` plus the untouched template, probed with the full prober (the
  quick probe on `--quick`) and graded. Null fixtures must pass nothing, `broken-build` and
  `template-untouched` must be typed no-builds, and the known-good mini golf must pass L2 and score
  at least 0.75. Results append to `calibration/results.jsonl` with the probe kind: a full
  calibration covers every grade, a quick one only `grade --quick` (older records read as quick).
  The newest record under the grade's pins whose probe kind covers it decides, so a later
  `--quick` run never revokes a full one, while a newer red run of a covering kind does.

`grade <campaign>` scans, probes the `final` snapshot (the full prober; `--quick` uses the quick
probe, marks `quick-grade` and can never be promoted), grades the checklist, writes
`evidence/<runId>/grade-<seq>/{scan,final,grade.json}` and appends a new `gradeSeq` row, then
judges the pairs. It skips runs already graded under the same versions, non-builds, harness
failures, cases whose version moved and Genex runs whose app build is gone. `regrade` reuses the retained probe unless `--reprobe` is
given or the prober version moved; `--baseline` regrades every run a committed baseline names.

### Human review

`review <campaign>` serves a blind page on 127.0.0.1 at a random port. Pair mode shows the pairs
the pairwise judge saw (before any judge ran, every two runs of one case and rep), sides placed
by a recorded seed and the order shuffled; no run id, lane, engine, model or path reaches the
page. `--graders` samples 10% (at least 5) of judged checklist items for grader validation,
showing each family's verdict. Answers are `genex-evals/human/1` rows in the local ledger;
the reviewer is a random id in `$GENEX_EVALS_HOME/reviewer-id` (`--reviewer` for a second one),
and a resumed session skips what that reviewer answered.

Every request needs the session's 32-byte token; the Host must be exactly 127.0.0.1:<port> and
answers must come from the same origin as small JSON. Media is served by opaque ids, re-checked
by real path under `evidence/<runId>/`, opened without following links, size-capped and sniffed
as PNG, JPEG, WebP or WebM. Responses carry a strict CSP with nothing inline.

## The ledger

The ledger is local, append-only JSONL under `$GENEX_EVALS_HOME/ledger/`: run rows
(`genex-evals/run/1`), pairwise rows and human rows (`scripts/evals/ledger/`).

- **Closed schema** (`schema.ts`): every string is a vocabulary code or matches a field pattern,
  every map has a closed key set, `time.toDoneMs` is null unless the run ended `agent-finished`,
  and notes are `NoteCode[]`. A refusal names the dotted field, never the value.
- **Guard** (`guard.ts`, denylist in `denylist.ts`): a denylist over every string and key:
  absolute or home paths, emails, credential shapes (`src/shared/redact.ts`, JWTs,
  `genex_sk_v1_` keys), long base64 runs, strings over 120 characters and internal hosts. Lane
  ids in `lanes.json`, case ids and campaign labels are refused when defined if the denylist
  would reject them (an `sk-` segment, for example), before any run.
- **Writer** (`write.ts`): every check runs before the append. It refuses a wrong `gradeId`
  (sha256[:12] of run, grading pins and time), a ledger inside the studio's or an engine's own
  home, and holdout rows in a ledger inside a Git working tree.
- **Reader** (`read.ts`): names a bad line as `file:line`; `currentRows()` keeps each run's latest
  `gradeSeq`. A collected row is `gradeSeq` 1 and every grade or void appends the next one.

## Comparison, gates and diagnostics

Every statistic is pure and seeded (`scripts/evals/report/`). Comparability keys each row on run
and grading pins; an axis may move only its own pins, `unavailable` refuses and grading pins never
move. The pre-registered primaries (`endpoints.ts`, hashed into `ENDPOINTS_SHA`) are
`scoreAllRuns` for the product and model axes and the L1 boot rate for version and cli, with a
`minActionableDelta` of 0.10. n is distinct cases: below 5 a comparison refuses, 5–7 gives a
direction, 8 or more a magnitude with its interval. Times, tokens and calls collapse reps to
per-case medians and compare as ratios of geometric means. Rates (`rate.boot`,
`rate.playableWithin30Min`) never collapse to medians: each case is a 2×2 stratum of pass counts,
pooled at 8 or more cases as a Mantel–Haenszel odds ratio of B passing against A with its 95%
interval and a Wilson interval per arm. When the odds ratio cannot be estimated, a direction is
claimed only if the arms' Wilson intervals are disjoint; `compare` prints the pooled rates and
each case's `p/r → p/r`. Descriptive metrics carry no direction words.

- **`check`**: a cell is armed when its base has at least 6 runs with a Wilson lower bound of
  0.5 or more; harness failures, void and unprobed rows are left out. A cell is clear only when
  every candidate attempt booted and flaky when any pass sits beside any failure, in any order;
  with no pass, one failure asks for a rerun, 2 of 2 is probable and 3 of 3 is regression. Each
  state prints its false-alarm and detection odds for that count rule over the attempts
  measured: flaky or worse is 1 − p^n, every attempt failing is (1 − p)^n. Drift is printed only against bases of 8 or
  more runs. A committed baseline (`--baseline`, or no base app) arms a cell only when its
  `ENDPOINTS_SHA`, case version and every pin outside the version axis match the candidate's
  counted rows; otherwise `check` prints `refused baseline <case> × <lane>: <field> <a> vs <b>`,
  the cell stays unarmed and a verdict that would be clear exits 1. A CLI, model, prober or
  grader change therefore needs a new or regraded baseline.
- **Baselines**: `baseline promote` writes one `genex-evals/baseline/1` file per public case with
  raw values per metric per lane, run ids, endings, pins, epoch and `ENDPOINTS_SHA`, formatted by
  Biome. It refuses on a red diagnostic, a failed canary, an unreplaced harness failure, a cell
  under 3 counted runs or with mixed pins, a red calibration, a quick grade, a void campaign or
  no public case (`no-public-cases`). Holdout cells gate the promotion but are never written; it
  prints `withheld-holdouts N`.
- **Diagnostics**: grader repeatability (red over 10% per family), plumbing (red over 5% of a
  cell), headroom, always-failing items, the noise floor per axis and scaling sanity. `report`,
  `check` and `baseline promote` print the block before anything else (`check`: before any
  baseline refusal, the cells and drift; its withheld-verdict line comes last). A red diagnostic
  exits 1 and withholds a clear verdict.
- **Reports**: a headline per run, the Markdown scorecard (lanes A–D, exposure in the header,
  missing values as words), trends over app builds, and `report --html`, a self-contained
  explorer that never plots a missing value as zero. `scoreAllRuns` counts a judge-skipped or
  no-build run as 0, per family and combined; pairwise tallies read only each run pair's latest
  judging pass and show forfeit wins and losses apart from judged ones.

## Commands

`npm run eval -- --help` lists every command and `<command> --help` gives its usage. Shared exit
codes (`scripts/evals/cli/exit.ts`): 0 ok, 1 refused or red, 2 not ready (a precondition another
command fulfils), 64 bad usage. "Live" commands spend quota or send data: without `--live` they
exit 64, and with it they exit 1 in CI.

| Command | Live | Does | Exits beyond 0/1/64 |
| --- | --- | --- | --- |
| `doctor` | | Machine check; installs and spends nothing | |
| `cases [--check]` | | Lists and validates cases | |
| `campaign plan --cases … [--lanes primary] [--reps N] [--apps base,cand] [--deadline-min N] [--seed s] [--label l]` | | Prints the matrix, seeded order, canary brackets and estimates; writes `campaign.json` | 64 also for a refused plan |
| `campaign run <id> [--live] [--budget-hours 8] [--max-quota 70] [--max-runs N] [--account-exclusive] [--serial]` | switch | Dry run without `--live` | 3 aborted, 4 void, 65 refused, 75 stopped (resumable), 128 + signal interrupted |
| `grade <campaign> [--quick]` | yes | Grades runs and pairs | 2 no covering calibration, no runs or `vendor-missing` |
| `regrade <runId> \| --baseline [--reprobe]` | yes | New `gradeSeq` from retained evidence | 2 as grade |
| `calibrate [--quick]` | yes | Grades the calibration fixtures | 1 red, 2 `vendor-missing` |
| `diagnostics <campaign> [--repeatability] [--seed s]` | with `--repeatability` | The diagnostics block; `--repeatability` re-grades a seeded sample | 2 |
| `report <campaign> [--md \| --html \| --trend [--metric m]]` | | Scorecard, explorer or trends | 2 no rows |
| `compare --axis <axis> --a <campaign>:<lane>[@sha] --b …` | | Compares two arms on the axis's endpoints | 2 an empty arm |
| `check <campaign> [--baseline]` | | The total-break gate per cell | clear 0, regression 2, probable 3, flaky 4; 1 withheld |
| `baseline promote --campaign <id>` | | Writes `evals/baselines/<case>.json` | 2 no rows or no repeatability sample |
| `ledger export --release <sha>` | | Writes `evals/ledger/export-<full sha>.jsonl`; a short sha must start exactly one build's sha | 2 no rows, 64 ambiguous sha |
| `ledger publish <campaign> [--publish-evidence]` | yes | Owner upload | |
| `ledger share <campaign> [--yes]` | yes | Anonymous public-case share | 1 also declined or a send failed |
| `ledger unshare [--yes]` | yes | Deletes every row this machine shared | 1 also declined or a delete failed |
| `review <campaign> [--graders] [--sample N] [--seed S] [--reviewer ID]` | | Blind review page | |
| `gc --older-than <N>d [--apply]` | | Lists (or removes) old run folders, snapshot-server copies and caches, and leftover lane roots | |
| `validate-ledger` | | Checks every ledger line | |

`gc` never removes a run a committed baseline names, a symlink (at any level, the folders it reads
included) or the ledger. It makes read-only clones writable just before removing them, and opens
the unlistable lanes folder only while it reads it.

## Campaign runbook

Steps marked **live** have not run outside the owner's Mac: the fixture pipeline covers every
other step, and these wait on the [spikes](#known-limits).

1. Sign in to the eval homes (**live**), then `nvm use && npm run build && npm run eval --
   doctor` (grading serves `/vendor` from `dist/resources/vendor`; doctor's quota read is
   **live**).
2. `npm run eval -- calibrate --live` until green (**live**; the full prober, so it covers full
   and quick grades).
3. Smoke campaign: `campaign plan --cases mini-golf,shooter --lanes primary --reps 1`, then
   `campaign run <id>` to read the dry run, `campaign run <id> --live --budget-hours 8
   --max-quota 70` (**live**: the eval-owned app build, the raw CLIs' flags and the quota
   guard), `grade <id> --live` (**live**), `report <id>` and `report <id> --html`. One rep proves
   the pipeline and is never promotable.
4. Baseline campaign: the same with `--reps 3` or more, so every case × lane cell holds the 3
   counted runs `baseline promote` needs (a harness failure leaves the count and its replacement
   fills it). A version campaign (`--apps base,cand`) needs `--reps 6` or more for `check <id>`,
   which arms a cell only when its base has 6 runs.
5. Before promoting: `diagnostics <id> --repeatability --live` (**live**), `review <id>`, then
   `baseline promote --campaign <id>` and `ledger export --release <sha>`, committed in an
   `evals: <campaignId>` PR against `dev` with the report summarized. `ledger publish` and
   `ledger share` are optional (**live**).

A campaign runs one stream per provider, at most one live run each, side by side unless
`--serial`. Builds are ordered per rep by sha256 of the seed and run key. Each stream opens with a
canary (one retry; a second failure aborts with `opening-canary`) and closes with one (a failure
voids with `closing-canary`). A harness failure is replaced by a new rep, at most 2 per cell, with
`supersededBy`. A provider failure (`auth-expired`, `quota-exhausted`, `rate-limited`,
`cli-missing`, `engine-not-ready`) writes no row and spends no replacement or canary verdict: the
campaign stops as `provider-unavailable` (exit 75) and resumes after a sign-in, a reset or an
install. Hour, run and quota caps are checked before every run (never quota for a fixture lane);
the quota guard sleeps until a window resets inside the budget, else stops cleanly (exit 75). A
CLI version change voids the campaign with `cli-changed`; a void appends a later `gradeSeq` of
every current row. Ctrl-C, SIGTERM or SIGHUP stops every live lane's process group (SIGTERM, then
SIGKILL 10 s later) before the command exits. Resume skips runs with a row, reruns owed
replacements, sets an abandoned work folder aside as `<runId>.abandoned-<ms>` (refusing
`abandoned-run-live`, exit 64, while the group its `.lane.pid` names still runs), and refuses a
void campaign, a moved case version or lane digest, and holdouts whose ledger is inside a Git
working tree.

## What is committed

`evals/baselines/` and `evals/ledger/export-*.jsonl` are the only committed measurement records:
metrics-only, guard-checked and public cases only. An export holds the current public rows of
every campaign that evaluated that app build, including the raw lanes it co-ran; holdouts,
pairwise and human rows are never exported. The registry, price table and cases are committed
inputs ([`evals/README.md`](../evals/README.md)). Everything else from a campaign stays under
`$GENEX_EVALS_HOME`: the ledger, streams, transcripts, snapshots, frames, grade records, reports,
calibration results and human labels.

## Publishing and sharing

- **`ledger publish`** uploads the owner's rows to the Genex API's `/api/evals/desktop/*` routes
  on `STUDIO_RUNS_URL` (default `https://api.genex.games`; empty removes publishing and sharing;
  otherwise https, or http on loopback, with no path). Its one credential is an `evals_ingest` key
  file (`GENEX_EVALS_KEY_FILE`, default `$GENEX_EVALS_HOME/secrets/genex-evals.key`), refused
  inside a Git worktree, when readable by group or others, or unless it is one `genex_sk_v1_`
  key; the key is never printed. Every row is checked (campaign, run id, guard, nothing
  credential-shaped) before the key is read; one bad row refuses the whole campaign. Each run's
  current grade (highest `gradeSeq`) goes up as the run upsert, so the server's run columns are
  the graded ones, then every grade oldest first; both routes are idempotent. Requests retry only
  on 5xx. `--publish-evidence` uploads the prober's `.png` frames and any `.jpg`, `.jpeg` and
  `.webm` files (24 per run, 5 MiB per frame, 50 MiB per video) to presigned PUTs that carry no
  key or cookie.
- **`ledger share`** prints the exact public-case rows (holdouts are counted as withheld) and asks
  each time unless `--yes`, then posts each as a `community-eval` contribution to
  `/api/desktop/contributions` with no Authorization header or cookie, a random install id from
  `$GENEX_EVALS_HOME/secrets/install.json` (rotated every 90 days, made only after a yes) and its
  secret. Each accepted row is recorded at once in `secrets/shared.jsonl`, so a re-run skips rows
  already shared under any of this machine's install ids (`already-shared N`); a regrade's new
  `gradeSeq` is shared again. At most 20 rows (the per-install daily cap) go per run and the rest
  print as `deferred N`. Any refusal (410, 429, 5xx) stops the send, never retried, and the next
  run resumes after the last accepted row. A replayed row is answered 200 and spends no cap.
- **`ledger unshare`** lists the current and retired install ids and asks unless `--yes`, then
  deletes every row of each with its own secret; a 404 counts as already gone and a failed
  identity exits 1 after the rest are tried. A retired identity is kept 180 days, the server's
  retention; an `install.json` that does not parse is refused, never re-minted.
- **Share build metrics** (Settings → Privacy) is the app's own opt-in, off by default; the app
  never asks (`RUN_SHARING_ASK` is `never`). A finished build becomes one closed
  `genex-evals/field/1` row built from typed log fields (`src/main/run-sharing-facts.ts`),
  guarded by `checkFieldRow`, queued in `<userData>/run-sharing/` (0700/0600, at most 50 rows, 7
  days) and posted by `src/main/run-sharing.ts` with no credentials or redirects. Its tokens are
  normalized like the ledger's, its first boot is `build_observation.ready.pageMs`, its
  `recordedAt` is the finish hour, and a chat build's row comes from the handled message's own
  turn (a message that opened no turn shares nothing); a run's records in that thread stay in the
  run's row. Its `calls.tools` counts builder tool calls by category, as a Genex lane does; rows
  from app versions up to 0.1.7 counted the chat's own tool requests in total only, so split any
  `calls.tools` analysis by `app.version`. A 410 on a POST pauses sending for a day;
  Delete what I shared keeps working while it is paused, and a partial delete reports the rows
  it removed. Only a packaged app with no `--studio-*` switch, dev profile or test user data
  sends. [PRIVACY.md](../PRIVACY.md) is the consent text; `RUN_SHARING_CONSENT_VERSION`
  names its version and is bumped whenever that text changes.

### Security model

The repository holds no secret, and the server enforces everything. Owner uploads use a scoped
`evals_ingest` key that reaches only `/api/evals/desktop/*` and only for an owner on the server's
admin list, never the full CLI session. Evidence goes to a private R2 bucket only through
presigned URLs that live 5 minutes, kept 180 days. Anonymous contributions are untrusted: a
separate table, a per-kind size cap (field 8 KiB, community-eval 32 KiB), 20 per install per
day (replays of a shared row count once), a kill switch answering POSTs with 410 while DELETE
stays open, no account link, and a per-install secret that proves every
POST and DELETE and is kept server-side only as a keyed hash. `src/shared/redact.ts` treats
`genex_sk_v1_` keys as credentials in logs, events and errors. A fork points sharing at its own
server with `STUDIO_RUNS_URL` or removes it by setting it empty.

## Fixture lanes and CI

The four fixture lanes mirror A–D with status `fixture` and model `fixture-v1`.
`fixture-genex` and `fixture-genex-codex` launch the app with `--studio-eval-fixture`, so its
scripted fixture engines answer; `fixture-raw` and `fixture-raw-codex` run the stub CLIs
`tests/fixtures/evals/bin/{claude,codex}-stub` (`scripts/evals/lanes/fixture-stubs.ts`). A stub
prints its version, replays a recorded, redacted stream with its recorded gaps, writes the
calibration mini golf and keeps its transcript or rollout in the eval home. `campaign run` never
reads quota for a fixture lane.

`npm run test:eval-fixture` (or `npm run test:ui -- eval-fixture`) builds the app and drives the
whole pipeline through the CLI in a disposable evals home outside any repository: `campaign plan`
and `campaign run` over the four lanes, `grade --quick` with fixture graders (evidence-reading
functions under a synthetic calibration, never a model), `report`, `validate-ledger` and the
guard; then a version campaign of `fixture-genex` on a base build and a candidate with a
boot-breaking defect, where `check` must exit regression (2) or probable (3). The runner writes
the calibration game into the game the app seeded, since fixture engines never edit one. Probing
uses Playwright's Chromium when it launches, else a typed `scripted` stand-in (`--scripted-probe`
forces it). It needs a logged-in macOS GUI session; evidence goes to
`.studio-dev/evidence/eval-fixture/<stamp>/`. It is a local or dispatched runner, not a CI job.

CI is hermetic only: the `gate` job runs `check-isolation` and the affected
`tests/conformance/eval-*.test.ts` suites (registry, schema, guard, collectors, lanes on stubs,
graders with scripted engines, statistics, CLI registry and live gate). The real-Chromium suites
are opt-in and need Playwright's Chromium on disk: `npm run test:eval-prober-browser` (the quick
probe) and `npm run test:eval-full-prober-browser` (the full prober, with a shortened soak, so its
five-minute rows read `unknown`); both set `STUDIO_BROWSER_TESTS=1`.

## Known limits

- The live path has not run: the six spikes need the owner's live opt-in. S1: eval homes and
  complete Codex host-skill suppression (whether `codex exec` accepts the suppression flags in
  leaf position). S2: raw Claude in `auto` with the eval home and the Codex lead's sandbox
  settings. S3: template games boot without a shim (grades pin `shimMode: none`). S4: Lane A runs
  headless with zero clicks. S5: Chromium with ANGLE Metal on Apple Silicon (without it, probes fall back
  to SwiftShader and frame-rate rows do not gate). S6: stream facts on the
  installed CLIs; until then a Codex auth or quota failure ends as `crash`, not a typed failure.
- No axis compares a lane with its `-plugin-off` twin: every `compare` axis is labelled for
  another question, and pairwise judging never pairs the two. Read them side by side in the
  report, or compare each against its raw lane on the product axis.
- Edit-existing, follow-up and long-horizon cases run as plain builds: no start-folder seeding or
  follow-up turns yet.
- The prober writes PNG frames and no video; pairwise rows are never published.
- The lane root keeps the evals home out of an agent's casual listing, not out of reach: its
  `CLAUDE_CONFIG_DIR` or `CODEX_HOME` still names a folder inside it.
- Studio scratch sessions are attributed by time, so two streams sharing one engine home (a Genex
  Codex lane's Claude judges beside a Genex Claude lane) can cross-attribute them.
- Grader thresholds (known-good 0.75, `minActionableDelta` 0.10) and the draft cases are owner
  placeholders; changing an endpoint moves `ENDPOINTS_SHA`.
