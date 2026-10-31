# Calibrate, then declare

`estimateCoins` is the **fixed price of a started attempt**, not a guess about
one. The platform charges exactly what you declare, whether the call succeeds,
fails, is canceled, or stops at its own budget. There is one honest way to pick
it: run the real prompt on your own coins, read what it charged, and declare the
number the benchmark recommends.

Never derive it from a model vendor's published rates. Three layers sit between
that rate and what the player is charged — the provider's cost, the platform's
tariff, and the headroom a declared price needs — and only the benchmark sees
all three. A number worked out from the vendor's page silently drops the middle
layer and under-prices every call you will ever make.

## 1. Freeze the prompt first

Benchmark the prompt you are actually shipping, with a realistic example filled
in: the longest NPC memory you will pass, the fullest world snapshot, a player
line of the length people really type. Short test prompts produce a cheap number
that the real game then cannot fund.

If the feature returns structured data, write the schema to a file now
(`./answer.schema.json`) and benchmark with it. Schema'd JSON and free text do
not cost the same, and shipping without a schema is the commonest way a call is
charged for an unusable result.

## 2. Run the benchmark

```bash
npx genex llm models        # which models this stand serves; pick candidates

npx genex llm bench "<the frozen prompt, one real example filled in>" \
  --model <id from the line above> \
  --schema ./answer.schema.json \
  --samples 3 \
  --max-coins <n> --user-approved
```

- It spends **your** coins, on the development lane, through the CLI's own
  credential. Nothing here runs in a shipped build.
- `--max-coins <n> --user-approved` is a hard gate, refused before any network
  call. That is the same shape as every other spend approval in the CLI: you
  state the ceiling for this run, out loud, once.
- `--samples 3` is the floor. The same prompt costs different amounts on
  different runs, because the model's own output length varies.
- `npx genex llm price` re-prints the last run's recommendation without spending
  anything again.

## 3. Read the output

Each sample prints what it actually charged. The aggregate prints p50, p95 and
max of the charged coins **over the samples that succeeded and settled**, plus
one recommendation. A sample that failed is printed with its code and stays
out of the numbers; a sample the provider refused at its door
(`provider_http_<status>`) ran no inference, cost nothing, and prints the
provider's own message under its row — on a 401 or 403 that is the stand's
provider configuration refusing the model, which is the operator's to fix. A
sample refused as `generation_limit` never started and ends the run: the
account's three ad-hoc calls are open or recently stopped with a pending
bill. `npx genex llm status` lists them with what each holds;
`npx genex llm cancel <id>` stops an active one; a stopped one frees on its
own once its bill resolves, and stops holding a slot ten minutes after
dispatch. Re-running the bench into the same refusal spends nothing and
learns nothing.

A sample the model had to stop writing (`provider_token_limit`) was cut off at
your `--max-coins`: it was charged, it is not a sample, and its real length is
unknown — so the run recommends no price and asks you to re-run with a higher
`--max-coins`. When the stand itself cannot hold the answer, the run says the
answer is longer than one call there may produce; no price fixes that, a
shorter answer does.

- **p50** is what a typical call costs. It is the number to reason about when
  you ask "can the game afford this loop?" — multiply it by the calls per
  minute you are about to disclose.
- **p95** is what a bad-but-normal call costs: a long answer, a model that
  reasons its way around. It is the number to **declare**, because a declared
  price below it means the unlucky calls cannot fund themselves and get refused
  mid-session.
- **max** is diagnostic. When max sits far above p95, the prompt has an
  unbounded branch in it — usually an unconstrained list or a missing schema.
  Fix the prompt rather than declaring a bigger number.

The recommendation line already applies the **server's own recommended
headroom** on top of p95. It also covers the answer's **length**: the declared
price decides how long each call's answer may be, because the room to answer is
funded from it, so a price built from charged coins alone can cut the answer
off in the game while the bench — run under a larger `--max-coins` — never saw
it. The recommendation is never below the smallest price that leaves room for
the benchmarked answer, and when the length is what set it the run says so in
one sentence. Either way, declare that figure verbatim — never the bare charged
number:

```ts
const NPC_CALL_PRICE = <the recommended figure>;    // from `npx genex llm bench`, <date>
const NPC_CALL_CEILING = <the printed ceiling>;     // same run — grants only
```

Do not add a margin of your own on top
of the recommendation, and do not round it down to look cheaper.

For a grant, the run prints a **second** number beside the price: the ceiling,
`perCallMaxCoins`. Declare that one verbatim too, and do not work it out by
hand. It is emphatically NOT the benchmark's `max`: p95 is nearest-rank, so at
the sample counts a benchmark actually takes, p95 and max are the same figure —
a ceiling set from `max` therefore lands *below* the recommended price, and
`requestSpendGrant()` refuses that pair before the request ever leaves the page.

The invariant, which the SDK and the server both enforce:

```
perCallEstimateCoins  ≤  perCallMaxCoins  ≤  the limit the player approves
```

The ceiling is the price's room to be wrong, not a second price: no call is ever
charged more than the price it declares, and the platform separately refuses any
declared price out of proportion to what the model could really cost.

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
4. **Coins per period is calls × the declared price** —
   `estimatedCoinsPerPeriod: 10 * NPC_CALL_PRICE`. Not the p50, not a hope: the
   price you declare is the price charged.

```ts
disclosure: {
  periodLabel: 'minute',
  estimatedCallsPerPeriod: 10,
  estimatedCoinsPerPeriod: 10 * NPC_CALL_PRICE,
}
```

The player sees this attributed to your game — "the game estimates about …" —
beside the platform's own worst case computed from `perCallMaxCoins`. The two
being far apart is normal; the estimate being far below what the game really
does is what breaks trust and burns the grant mid-session.

**Batching changes this arithmetic more than any price tuning can.** Five NPCs
answered by one call that returns five decisions is two calls a minute, not ten,
and one benchmarked price for the batched prompt replaces five of the unbatched
one. Do that before you reach for a cheaper model.

## Worked example

A tavern with five NPCs who react to what the player says. Each NPC decides once
every thirty seconds; a decision is a short JSON object (a mood, one line of
speech). The prompt carries the NPC's memory and the last two player lines.

1. Freeze the prompt with a full memory and a long player line. Write
   `./answer.schema.json` with the two fields.
2. `npx genex llm bench "<that prompt>" --schema ./answer.schema.json
   --samples 3 --max-coins <ceiling> --user-approved`.
3. Read: p50 `<p50>`, p95 `<p95>`, max `<max>`, and the two printed
   declarations — `Declare estimateCoins: <recommended>` and
   `Grant perCallMaxCoins: <ceiling>`.
4. Declare `NPC_CALL_PRICE = <recommended>` and
   `NPC_CALL_CEILING = <ceiling>`, each verbatim from the line that printed it.
5. Unbatched, the loop is ten calls a minute, so the disclosure is
   `10` and `10 * <recommended>` coins per minute.
6. Batch the five NPCs into one call — benchmark the batched prompt separately,
   because it is a different prompt — and the disclosure becomes two calls a
   minute at the batched price.
7. Re-run steps 1–4 whenever the prompt, the schema or the model changes. A
   prompt edit is a price change; treat it like one.

Every `<placeholder>` above is read off your own benchmark run. None of these
figures is a platform constant, and none of them should be copied from another
game — a different prompt has a different price.
