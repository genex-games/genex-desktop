/**
 * A delegation's cost is its own. Claude Code reports a session's cost (`total_cost_usd`) and every
 * model's tokens (`modelUsage`) as running totals that a resumed session carries on from, so adding
 * up its turns' reports counted the early turns again in every later one. The engine reports each
 * delegation's share instead: this result's totals minus the totals the same session reported
 * last, remembered across engine restarts. A counter that went down started again (the CLI did not
 * carry it on), and counts from zero.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { joinedResult } from "../../src/main/core/plan-approval.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import type { DelegateResult } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

// An engine resolves its login homes the moment it is built: these get tmp homes of their own.
delete process.env.CLAUDE_CONFIG_DIR;

const SESSION = "ses_cost";
const MODEL = "claude-fixture-main";

/** One reply's running totals: the session's cost so far and the main model's output so far. */
interface Totals {
  cost: number;
  output: number;
  /** The session the CLI answers as; the resumed one unless named. */
  session?: string;
}

/** A Claude Code engine whose every session answers the next of `totals`, keeping its costs in `ledger`. */
async function engineAnswering(totals: Totals[], ledger: string): Promise<ClaudeCodeEngine> {
  const root = await tmpDir("engine-cost-");
  const home = path.join(root, "claude-home");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, ".credentials.json"), "{}");
  const queue = [...totals];
  return new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: home,
    systemHome: path.join(root, "no-system-login"),
    judgeCwd: path.join(root, "judge"),
    sessionCosts: ledger,
    queryFn: (() => {
      const next = queue.shift();
      assert.ok(next, "a session ran that the test did not script");
      return {
        async *[Symbol.asyncIterator]() {
          const session = next.session ?? SESSION;
          yield { type: "system", subtype: "init", model: MODEL, session_id: session, tools: [] };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "Built.",
            num_turns: 1,
            session_id: session,
            total_cost_usd: next.cost,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {
              [MODEL]: {
                inputTokens: 1,
                outputTokens: next.output,
                cacheReadInputTokens: 0,
                cacheCreationInputTokens: 0,
              },
            },
          };
        },
      };
    }) as never,
  });
}

/** A ledger file of the test's own. */
async function ledgerFile(): Promise<string> {
  return path.join(await tmpDir("engine-cost-ledger-"), "claude-code.json");
}

/** One turn of the session: the first starts it, every later one resumes it. */
async function turn(engine: ClaudeCodeEngine, resume: boolean): Promise<DelegateResult> {
  const cwd = await tmpDir("engine-cost-run-");
  return engine.delegate({ cwd, prompt: "Build", ...(resume ? { resume: SESSION } : {}) });
}

const cents = (value: number | undefined) => Math.round((value ?? Number.NaN) * 100);

describe("a delegation's cost", () => {
  it("is its own share of a resumed session's running total, so the turns add up to the total", async () => {
    const engine = await engineAnswering(
      [
        { cost: 4.31, output: 100 },
        { cost: 5.89, output: 160 },
        { cost: 9.92, output: 400 },
      ],
      await ledgerFile(),
    );
    const turns = [await turn(engine, false), await turn(engine, true), await turn(engine, true)];
    assert.deepEqual(
      turns.map((t) => cents(t.usage.cost_usd)),
      [431, 158, 403],
    );
    assert.equal(
      turns.reduce((sum, t) => sum + cents(t.usage.cost_usd), 0),
      992,
      "9.92 spent, not 20.12",
    );
    assert.deepEqual(
      turns.map((t) => t.usage.by_model?.[MODEL]?.output_tokens),
      [100, 60, 240],
      "every model's tokens are the turn's own too",
    );
  });

  it("counts from zero when the session's counter started again", async () => {
    const engine = await engineAnswering(
      [
        { cost: 4.31, output: 100 },
        { cost: 0.5, output: 20 },
      ],
      await ledgerFile(),
    );
    const turns = [await turn(engine, false), await turn(engine, true)];
    assert.deepEqual(
      turns.map((t) => cents(t.usage.cost_usd)),
      [431, 50],
    );
    assert.equal(turns[1]?.usage.by_model?.[MODEL]?.output_tokens, 20);
  });

  it("is the whole total when the CLI answered as another session than the one resumed", async () => {
    const engine = await engineAnswering(
      [
        { cost: 4.31, output: 100 },
        { cost: 6.2, output: 120, session: "ses_other" },
      ],
      await ledgerFile(),
    );
    const turns = [await turn(engine, false), await turn(engine, true)];
    assert.deepEqual(
      turns.map((t) => cents(t.usage.cost_usd)),
      [431, 620],
    );
  });

  it("remembers the session's last total across an engine restart", async () => {
    const ledger = await ledgerFile();
    const first = await engineAnswering([{ cost: 4.31, output: 100 }], ledger);
    assert.equal(cents((await turn(first, false)).usage.cost_usd), 431);
    const restarted = await engineAnswering([{ cost: 5.89, output: 160 }], ledger);
    assert.equal(cents((await turn(restarted, true)).usage.cost_usd), 158);
  });

  it("is not counted twice when one turn's two passes of the same session are joined", async () => {
    const engine = await engineAnswering(
      [
        { cost: 3, output: 50 },
        { cost: 3.5, output: 70 },
      ],
      await ledgerFile(),
    );
    const plan = await turn(engine, false);
    const build = await turn(engine, true);
    const joined = joinedResult(plan, build);
    assert.equal(cents(joined.usage.cost_usd), 350, "3.50 spent, not 6.50");
    assert.equal(joined.usage.by_model?.[MODEL]?.output_tokens, 70, "both passes' model tokens, each once");
  });
});
