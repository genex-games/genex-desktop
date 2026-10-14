# Evaluating game judges

Protocol tests prove the mechanics of judging, not that a model agrees with people about game
quality. Use this procedure before claiming a judge, prompt or learned
instruction improves games. Publish only an independently reviewed dataset with established
redistribution rights.

## Fixed comparisons

Use owned disposable games. Freeze each game's starting commit, seed, camera, viewport, pixel
ratio, actions and evidence budget; record provider, model, prompt version, runtime context,
permission mode, source revision and build. Change one variable per comparison and give every
candidate the same inputs:

| Task | Candidate difference | Required observations |
| --- | --- | --- |
| Starts | A valid page versus an intentional startup error | Startup result and console evidence; a broken build cannot win for appearance |
| Movement | Working move/jump controls versus a disconnected input handler | Identical input replay, player displacement and playable preview |
| Contact | Grounded geometry versus a visible floating object | Identical side and default views, with collision evidence kept separate |
| Readability | Legible HUD versus clipped/low-contrast text | Fixed viewport, keyboard traversal and screenshot; appearance alone is insufficient |
| Regressions | A prettier scene that breaks a previously passing control | Before/after behavioral checks plus the matched visual pair |
| No change | Identical builds with shuffled A/B placement | Equal bytes/settings; a genuine tie is a valid outcome |
| Missing evidence | An absent camera, malformed judge response or unavailable WebGPU measurement | Missing/invalid evidence remains distinguishable from a measured pass |
| Scope | The requested change versus an unrelated attractive addition | Frozen task brief and evidence of the requested behavior |
| Finish | The same build polished versus with an unfinished new system added | Finish-stage taste rubric; the polished build wins and a regression still loses |
| Corners | A racer that warns of each corner versus one that does not | The drive's `drive:corner` frame on both sides and its `CORNER:` fact line; a drive that reached no corner says so |
| Challenge | A field that beats a throttle-only bot versus one that loses to it | The bot's race under one seed (`throttle-bot-loses`, the `CHALLENGE:` line); a game reporting no race is not asked |

The art director's ship review (`judge/ship-review.md`, `loop/ship-review.ts`) is the one
absolute judge: one build and no pair, at 1600×900. Evaluate it on single builds that reviewers
label ship or not, each decisive defect with the plan part that owns it and its severity; a
malformed reply must stay no verdict, never a "no", and a camera it was not shown is dropped. It is
never put beside another build's frames. Its `doNotRegress` list (at most eight short names of
what already works) becomes the taste judge's regression guard: evaluate the taste judge on pairs
where the accepted build loses one listed item and must be called a regression, and on pairs that
keep every item, whose verdicts must not change.

When the run's plan carries a vision (`docs/VISION.md`, `loop/vision.ts`), the taste judge, the
liveness critic and the ship review also read a bounded excerpt of it as the direction to grow
toward. Freeze it with the task brief, and compare candidates under the same vision or none.

A finish-stage round's taste judge reads `judge/taste-finish.md` after its usual rubric
(`taste-veto.md`): polish is the work, the build a player would rather ship wins, and it lists up
to eight polish items. Evaluate it on finish pairs only, and confirm that build-stage pairs, judged
without it, keep their verdicts.

A new loop worker's first round is a build block ([harness runtime](harness-runtime.md)): the
taste judge still looks at it, but its pick and veto decide nothing — only its notes reach the next
round. Measure taste verdicts from round two on.

A C++ · raylib game is judged by the same rubrics; its code review reads
`judge/code-review-cpp.md` and its scene checks are unmeasured. A Mac-only game is judged on
native captures (`loop/native-evidence.ts`); an uncaptured frame fails its vision and play checks.
A Browser + Mac look carries the parity gate as one identity row, `native-parity`: host admission
facts (beating the game's backend claim), ready, step witness, the web pass's cameras and frame
verdicts, a seeded two-run replay, and `state()` agreement with the web build after 120 ticks
(per-game tolerance, only tightened). Cross-target agreement excludes backend render statistics
(`__render` and root `drawCalls`/`triangles`); gameplay and nested probes still compare. Native
replay keeps render counters and compares asset claims by logical asset path, not the temporary
bundle root. Frame similarity is unmeasured until PX10; unmeasured never
passes; Windows or Linux builds on a Mac are `not-runnable-here`. Campaigns compare stacks only on
tasks both measure.

A Rust · wgpu game is judged the same way, with its own rubric (`judge/code-review-rust.md`:
determinism, `ctx` input, tagged draws, no network, no build or dependency edits) and its own
parity row. Scene checks are unmeasured; a look that captured nothing fails its vision and play
checks. A web build refused `gpu-unsupported` (a preview without WebGPU) is unavailable, not
failed, and the gate is weighed over the other destinations. Tolerance is kept per stack and
target pair, so a Rust pair never inherits a raylib game's. Phone builds are built and admitted
only: their rows are unmeasured, so gameplay is judged on the Mac or web build of the same code,
and no judge starts a Simulator, emulator or phone.

These are test cases, not human-labelled quality results. Begin without model calls by checking
capture reproducibility, malformed responses, budget limits and blind-label handling through the
existing conformance and harness suites. A real-model campaign requires its own authorized
provider and spend limit. A judge whose provider is lost (a sign-in gone, a cap, a limit not yet
reset) is asked once per run (`loop/provider-loss.ts`): later calls fail at once with its kind and
the round waits, so a lapsed account leaves no verdicts, never ties or "no" answers.

Captures, judge verdicts and human labels stay in ignored evidence directories; only metrics-only
baselines and per-release ledger exports under `evals/` are committed ([evals](evals.md)).

## Human review and metrics

Have at least two reviewers label each pair independently before seeing the model's answer.
Shuffle placement separately for humans and judges. Hide engine, author and incumbent; keep a
mapping to the exact commits. Reviewers record A, B,
tie or insufficient evidence, plus the decisive defect and whether the request was satisfied.
Adjudicate disagreements separately; never manufacture a consensus label.
`npm run eval -- review` serves this blind review and a grader-validation sample locally; its
labels stay in the local eval ledger ([evals](evals.md#human-review)).

Report sample size, human agreement, judge agreement with adjudicated labels, the full
A/B/tie/insufficient confusion table, invalid or abstained responses, false acceptance of broken
or regressed builds, and requested-change satisfaction. Swapping A/B must not change the choice.
Show each task beside the aggregate; unlabelled pairs stay unlabelled. Include calls, tokens,
spend, latency, cancellations and failures.

Run a candidate in shadow mode on the frozen set before its decisions change games or apply
learning. Set thresholds and budget first; keep the baseline and every failure. Wider acceptance
needs fresh tasks and independent reviewers, not more tuning on the same examples. Automatic
learning stays off until its own acceptance is measured.
