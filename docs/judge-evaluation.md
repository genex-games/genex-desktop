# Evaluating game judges

Protocol tests prove the mechanics of judging. They do not establish that a model agrees with
people about game quality. Use this procedure before claiming a judge, prompt or learned
instruction improves games. Keep captures, labels and reports in ignored evidence directories;
publish only an independently reviewed dataset with established redistribution rights.

## Fixed comparisons

Use owned disposable games. Freeze each game's starting commit, seed, camera, viewport, device
pixel ratio, action sequence and evidence budget. Record the provider, model, prompt version,
runtime context, permission mode, source revision and build identity. Change one variable per
comparison. Start with these authored tasks; use the same inputs for every candidate:

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
Shuffle left/right placement independently for humans and judges. Hide engine, author and
incumbent identity; retain an internal mapping to the exact commits. Reviewers record A, B,
tie or insufficient evidence, plus the decisive defect and whether the request was satisfied.
Preserve disagreements and adjudicate them separately; do not manufacture a consensus label.
For eval campaigns, `npm run eval -- review` serves this blind pair review and a grader-validation
sample locally, and its labels stay in the local eval ledger ([evals](evals.md#human-review)).

Report sample size and counts, human agreement, judge agreement with adjudicated labels,
the full A/B/tie/insufficient confusion table, invalid/abstained responses, false acceptance of
broken or regressed builds, and requested-change satisfaction. Reversing A/B must not alter
the semantic choice. Show each task's result alongside the aggregate; report unlabelled pairs
as unlabelled. Include calls, tokens, recorded spend, latency, cancellations and failures.

Run a candidate in shadow mode on the frozen set before letting its decisions change games or
automatically apply learning. Set acceptance thresholds and the campaign's budget before
running it; retain the baseline and every failure. Wider acceptance needs fresh tasks and
independent reviewers, not repeated tuning on the same examples. Keep automatic learning off
until its own measured acceptance is established.
