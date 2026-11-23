# Calibrate, then declare

An in-game call is paid from the player's Genex credits and **billed as used**:
its real provider cost plus the platform fee. The game declares no price. It
declares a per-call **ceiling** — `maxCredits` on `generate()`,
`perCallMaxCredits` on a standing budget — and no call is ever billed past it.

The ceiling is still a number with two jobs, and both punish a guess:

- **It bounds the cost.** A budget's worst case, shown to the player beside
  your own estimate, is built from `perCallMaxCredits`. A ceiling far above what
  a call really costs asks the player to approve money the game will never
  spend, and makes the sheet look like a withdrawal.
- **It sizes the answer.** Each call's room to answer is funded from its
  ceiling, so a ceiling below what the answer needs cuts it off — and a cut-off
  attempt is still billed for the work it did.

There is one honest way to pick it: run the real prompt on your own credits,
read what it really cost, and declare the numbers the benchmark prints.

Never derive them from a model vendor's published rates. Three layers sit
between that rate and what the player is billed — the provider's cost for YOUR
prompt, the platform fee, and the headroom a ceiling needs — and only the
benchmark sees the first. The other two come from the server; a number worked
out from the vendor's page drops at least one of them.

## 1. Freeze the prompt first

Benchmark the prompt you are actually shipping, with a realistic example filled
in: the longest NPC memory you will pass, the fullest world snapshot, a player
line of the length people really type. Short test prompts produce a cheap number
that the real game then cannot fund.

If the feature returns structured data, write the schema to a file now
(`./answer.schema.json`) and benchmark with it. Schema'd JSON and free text do
not cost the same, and shipping without a schema is the commonest way a call is
billed for an unusable result.

## 2. Run the benchmark

```bash
npx genex llm models        # which models this stand serves; pick candidates

npx genex llm bench "<the frozen prompt, one real example filled in>" \
  --model <id from the line above> \
  --schema ./answer.schema.json \
  --samples 3 \
  --max-credits <n> --user-approved
```

- It spends **your** credits, on the development lane, through the CLI's own
  credential. Nothing here runs in a shipped build. The build's asset allowance
  does not count it, which is why it has its own gate.
- `--max-credits <n> --user-approved` is a hard gate, refused before any network
  call. That is the same shape as every other spend approval in the CLI: you
  state the ceiling for this run, out loud, once. Your spendable balance has to
  cover one attempt at it, or the run is refused before it starts.
  `--max-coins` is the old name of the same flag and still works.
- `--samples 3` is the floor. The same prompt costs different amounts on
  different runs, because the model's own output length varies.

## 3. Read the output

Each sample prints its real cost and the whole credits it was charged. The
aggregate prints p50, p95 and max of both **over the samples that succeeded and
settled**. A sample that failed is printed with its code and stays out of the
numbers; a sample the provider refused at its door (`provider_http_<status>`)
ran no inference, cost nothing, and prints the provider's own message under its
row — on a 401 or 403 that is the stand's provider configuration refusing the
model, which is the operator's to fix. A sample refused as `generation_limit`
never started and ends the run: the account's three ad-hoc calls are open or
recently stopped with a pending bill. `npx genex llm status` lists them with
what each holds; `npx genex llm cancel <id>` stops an active one; a stopped one
frees on its own once its bill resolves, and stops holding a slot ten minutes
after dispatch. Re-running the bench into the same refusal spends nothing and
learns nothing.

A sample the model had to stop writing (`provider_token_limit`) was cut off at
your `--max-credits`: it was billed, it is not a sample, and its real length is
unknown — so the run recommends no ceiling and asks you to re-run with a higher
`--max-credits`. When the stand itself cannot hold the answer, the run says the
answer is longer than one call there may produce; no ceiling fixes that, a
shorter answer does.

- **p50** is what a typical call costs. It is the number to reason about when
  you ask "can the game afford this loop?".
- **p95** is what a bad-but-normal call costs: a long answer, a model that
  reasons its way around. It is what the **ceiling** has to cover, because a
  ceiling below it cuts the unlucky calls off.
- **max** is diagnostic. When max sits far above p95, the prompt has an
  unbounded branch in it — usually an unconstrained list or a missing schema.
  Fix the prompt rather than declaring a bigger number.

Then the run prints what to declare:

- **`Declare maxCredits`** — the p95 real cost with the platform fee and the
  **server's own recommended headroom** applied, in whole credits. It also
  covers the answer's **length**: it is never below the smallest ceiling that
  leaves room for the benchmarked answer, and when the length is what set it
  the run says so in one sentence. A ceiling built from cost alone can cut the
  answer off in the game while the bench — run under a larger `--max-credits`
  — never saw it.
- **`Grant perCallMaxCredits`** — the same over the worst sample, never below
  the line above it. It is emphatically NOT the benchmark's `max` of charged
  credits: that number carries neither the headroom nor the answer's length,
  so a ceiling set from it lands under the call ceiling and the budget's calls
  are refused (`grant_price_unreasonable`).
- **`Per-call estimate: about … credits per call`** — the measured average,
  fee included, no headroom: a fraction of a credit for a short call. It is the
  honest figure for the disclosure.
- **`Grant perCallEstimateCredits`** — that average rounded up to a whole
  credit.

Declare each verbatim:

```ts
const NPC_CALL_MAX = <Declare maxCredits>;                 // from `npx genex llm bench`, <date>
const NPC_GRANT_MAX = <Grant perCallMaxCredits>;           // same run — budgets only
const NPC_CALL_ESTIMATE = <Grant perCallEstimateCredits>;  // same run — budgets only
const NPC_CALL_AVERAGE = <the "about … credits per call" figure>;  // same run
```

Do not add a margin of your own on
top, and do not round them down to look cheaper.

The invariants, which the SDK and the server both enforce:

```
perCallEstimateCredits  ≤  perCallMaxCredits  ≤  the limit the player approves
maxCredits on each call  ≤  perCallMaxCredits
```

A ceiling is not a second price: a call is billed the real cost of the work it
did plus the fee (a one-time call rounded up to a whole credit), and never past
its ceiling.

**One-time calls round up; budgets do not.** A one-time `generate()` is captured
rounded UP to a whole credit when it settles, so a call that really costs a
fraction of a credit still costs the player one whole credit each time. Under a
budget each call adds its exact fraction and the player's credits move one
whole credit at a time. That is one more reason a repeated call belongs under a
budget.

## 4. Turn the game's loop into the disclosure

A standing budget asks the player to approve a rate, so the numbers have to come
from the loop you wrote, counted honestly:

1. **Count the callers.** How many things call the model at once? Five thinking
   NPCs, one director, one narrator.
2. **Count each one's cadence.** How often does each decide? Once every thirty
   seconds of play.
3. **Multiply, and pick the period that makes the number legible.** Five NPCs at
   one call per thirty seconds is ten calls a minute, so `periodLabel: 'minute'`
   and `estimatedCallsPerPeriod: 10`.
4. **Credits per period is calls × the measured average, rounded up** —
   `estimatedCreditsPerPeriod: Math.ceil(10 * NPC_CALL_AVERAGE)`. Not the
   ceiling: a call is billed what it uses, so the honest estimate is what calls
   really average.

```ts
perCallMaxCredits: NPC_GRANT_MAX,
perCallEstimateCredits: NPC_CALL_ESTIMATE,
disclosure: {
  periodLabel: 'minute',
  estimatedCallsPerPeriod: 10,
  estimatedCreditsPerPeriod: Math.ceil(10 * NPC_CALL_AVERAGE),
}
```

The player sees this attributed to your game — "the game estimates about …" —
beside the platform's own worst case computed from `perCallMaxCredits`. The two
being far apart is normal; the estimate being far below what the game really
does is what breaks trust and burns the grant mid-session.

**Batching changes this arithmetic more than any tuning can.** Five NPCs
answered by one call that returns five decisions is two calls a minute, not ten,
and one benchmark of the batched prompt replaces five of the unbatched one. Do
that before you reach for a cheaper model.

## Old code

`estimateCoins`, `perCallMaxCoins`, `perCallEstimateCoins` and
`disclosure.estimatedCoinsPerPeriod` are the names from before credits. The
server still accepts them and reads them as the same numbers in credits, but
they are deprecated: rename them to `maxCredits`, `perCallMaxCredits`,
`perCallEstimateCredits` and `estimatedCreditsPerPeriod` when you touch the
code, and re-benchmark — a number measured as a Nex price is not a ceiling.

## Worked example

A tavern with five NPCs who react to what the player says. Each NPC decides once
every thirty seconds; a decision is a short JSON object (a mood, one line of
speech). The prompt carries the NPC's memory and the last two player lines.

1. Freeze the prompt with a full memory and a long player line. Write
   `./answer.schema.json` with the two fields.
2. `npx genex llm bench "<that prompt>" --schema ./answer.schema.json
   --samples 3 --max-credits <ceiling> --user-approved`.
3. Read: p50 `<p50>`, p95 `<p95>`, max `<max>`, and the printed lines —
   `Declare maxCredits: <call ceiling>`, `Grant perCallMaxCredits: <grant ceiling>`,
   `Per-call estimate: about <average> credits per call` and
   `Grant perCallEstimateCredits: <estimate>`.
4. Declare `NPC_CALL_MAX`, `NPC_GRANT_MAX`, `NPC_CALL_ESTIMATE` and
   `NPC_CALL_AVERAGE`, each verbatim from the line that printed it.
5. Unbatched, the loop is ten calls a minute, so the disclosure is `10` calls
   and `Math.ceil(10 * NPC_CALL_AVERAGE)` credits per minute.
6. Batch the five NPCs into one call — benchmark the batched prompt separately,
   because it is a different prompt — and the disclosure becomes two calls a
   minute at the batched average.
7. Re-run steps 1–4 whenever the prompt, the schema or the model changes. A
   prompt edit changes the ceiling; treat it like one.

Every `<placeholder>` above is read off your own benchmark run. None of these
figures is a platform constant, and none of them should be copied from another
game — a different prompt has a different cost.
