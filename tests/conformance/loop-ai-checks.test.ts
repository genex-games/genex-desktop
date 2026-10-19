/**
 * The harness's play-time AI checks (`loop/ai-checks.ts`, kind `ai`): which board carries them, what
 * each one asks the host (`ai.replay` on tapes, with no answer and with the worst answers a shape
 * allows), what it reads from the evidence, and the scan of a build for direct vendor calls — whose
 * folder is a path boundary, so it gets a hostile table that asserts nothing outside it is read.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runDeterministicChecks } from "../../src/harness-seed/loop/checks.ts";
import {
  AI_CHECK_MAX_DEMOS,
  AI_CHECK_SEEDS,
  AI_SCAN_MAX_FILE_BYTES,
  AiCheckTest,
  aiCheckId,
  scanForDirectCalls,
} from "../../src/harness-seed/loop/ai-checks.ts";
import { AiReplayAnswers, AiRequirement } from "../../src/harness-seed/loop/ai-contract.ts";
import {
  type Check,
  CheckKind,
  CheckOrigin,
  normalizeCheck,
  withHarnessChecks,
} from "../../src/harness-seed/loop/spec.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { normalizeGameTraits } from "../../src/harness-seed/loop/kinds.ts";
import { compilePlan } from "../../src/harness-seed/loop/director/rules.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "oracle";
const ROOT = "/scratch/autopilot/run_ai/worktree";
const ALL_TESTS = Object.values(AiCheckTest);
/** A board with no checks yet. */
const emptyBoard = (): { checks: Check[] } => ({ checks: [] });

/** A replay result as the host answers it. */
function replayed(demo: string, extra: Record<string, unknown> = {}) {
  return {
    demo,
    deterministic: true,
    stateDigests: [["a"], ["a"], ["a"]],
    misses: 0,
    fallbacks: 0,
    rejected: 0,
    stuck: 0,
    settled: true,
    refused: {},
    ...extra,
  };
}

/** The harness's own AI check for a test, as the board carries it. */
function aiCheck(test: string) {
  const check = normalizeCheck({ id: aiCheckId(test), kind: CheckKind.Ai, test, origin: CheckOrigin.Harness });
  assert.ok(check);
  return check;
}

/** Evidence of a pass on a build: its project and folder, its demos and the states it read. */
function evidenceOf(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    build: { project: PROJECT, root: ROOT },
    registeredDemos: ["turn-three"],
    state: { ai: { disclosed: true } },
    ...extra,
  };
}

/** Score `tests` on `evidence` with the host answering replays through `replay`. */
async function score(
  tests: readonly string[],
  evidence: Record<string, unknown>,
  replay: (params: Record<string, unknown>) => unknown = (p) => replayed(String(p.demo)),
) {
  const recorder = ctxRecorder({ handlers: { [HostMethod.AiReplay]: replay } });
  const { results } = await runDeterministicChecks(recorder.ctx as never, {
    spec: { checks: tests.map(aiCheck) },
    evidence: evidence as never,
  });
  return { results, recorder };
}

describe("which boards carry the AI checks", () => {
  it("puts every AI check on the entry owner's board of a game that declares AI, and on no other", () => {
    for (const ai of Object.values(AiRequirement)) {
      const game = normalizeGameTraits({ ai });
      const owner = withHarnessChecks(emptyBoard(), { ownsMain: true, game });
      const integration = withHarnessChecks(emptyBoard(), { role: "integration", game });
      const part = withHarnessChecks(emptyBoard(), { ownsMain: false, game });
      const ids = ALL_TESTS.map(aiCheckId);
      assert.deepEqual(
        owner.checks.filter((c) => c.kind === CheckKind.Ai).map((c) => c.id),
        ids,
      );
      assert.deepEqual(
        integration.checks.filter((c) => c.kind === CheckKind.Ai).map((c) => c.id),
        ids,
      );
      assert.deepEqual(part.checks, []);
      assert.ok(owner.checks.every((c) => c.origin === CheckOrigin.Harness));
    }
    const plain = withHarnessChecks(emptyBoard(), { ownsMain: true, game: normalizeGameTraits({}) });
    assert.deepEqual(plain.checks, []);
  });

  it("reads a game's AI only from the typed word, never from what a plan says in prose", () => {
    assert.equal(normalizeGameTraits({ ai: AiRequirement.Optional }).ai, AiRequirement.Optional);
    for (const ai of ["AI", "yes", true, "the game uses an LLM", null, 1, { requires: "ai" }])
      assert.equal(normalizeGameTraits({ ai }).ai, undefined, JSON.stringify(ai));
  });

  it("takes the plan's ai and refuses one that is not a requirement", () => {
    const plan = compilePlan({ summary: "An oracle answers.", workers: '["oracle"]', ai: AiRequirement.Ai });
    assert.equal(plan.plan?.game?.ai, AiRequirement.Ai);
    const refused = compilePlan({ summary: "An oracle answers.", workers: '["oracle"]', ai: "lots" });
    assert.match(String(refused.error), /ai "lots" is not/);
    const none = compilePlan({ summary: "An oracle answers.", workers: '["oracle"]' });
    assert.equal(none.plan?.game, null);
  });

  it("refuses an ai check whose test it does not know, and keeps a known one", () => {
    assert.equal(normalizeCheck({ kind: CheckKind.Ai, test: "replay-deterministic" })?.test, "replay-deterministic");
    assert.equal(normalizeCheck({ kind: CheckKind.Ai, test: "vibes" })?.test, undefined);
  });
});

describe("what the AI checks ask the host and how they read its answers", () => {
  it("replays each demo once per kind of answer, shared by every check that reads it", async () => {
    const { results, recorder } = await score(
      ALL_TESTS.filter((t) => t !== AiCheckTest.NoDirectModelCalls),
      evidenceOf(),
    );
    assert.ok(
      results.every((r) => r.pass === true),
      JSON.stringify(results),
    );
    const replays = recorder.paramsOf(HostMethod.AiReplay);
    assert.deepEqual(
      replays.map((p) => [p.project, p.root, p.demo, p.answers, p.seeds]),
      [
        [PROJECT, ROOT, "turn-three", AiReplayAnswers.Tape, [...AI_CHECK_SEEDS]],
        [PROJECT, ROOT, "turn-three", AiReplayAnswers.None, [AI_CHECK_SEEDS[0]]],
        [PROJECT, ROOT, "turn-three", AiReplayAnswers.Edge, AI_CHECK_SEEDS.slice(0, 2)],
      ],
    );
  });

  it("replays at most a few demos, the game's own folder as no root", async () => {
    const demos = Array.from({ length: AI_CHECK_MAX_DEMOS + 2 }, (_, i) => `demo-${i}`);
    const { recorder } = await score([AiCheckTest.ReplayDeterministic], {
      ...evidenceOf({ registeredDemos: demos }),
      build: { project: PROJECT, root: null },
    });
    const replays = recorder.paramsOf(HostMethod.AiReplay);
    assert.equal(replays.length, AI_CHECK_MAX_DEMOS);
    assert.ok(replays.every((p) => !("root" in p)));
  });

  const VERDICTS: Array<{
    name: string;
    test: string;
    replay?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    pass: boolean | null;
    reason?: RegExp;
  }> = [
    {
      name: "seeds that replay different frames",
      test: AiCheckTest.ReplayDeterministic,
      replay: { deterministic: false },
      pass: false,
      reason: /turn-three.*different frames/,
    },
    {
      name: "a call the tape has no answer for",
      test: AiCheckTest.TapeCoversDemos,
      replay: { misses: 2 },
      pass: false,
      reason: /2 calls.*no answer.*ai_record/,
    },
    {
      name: "tape lines the reader refused",
      test: AiCheckTest.TapeCoversDemos,
      replay: { rejected: 1 },
      pass: false,
      reason: /1 line/,
    },
    {
      name: "an AI game with no demo at all",
      test: AiCheckTest.TapeCoversDemos,
      evidence: { registeredDemos: [] },
      pass: false,
      reason: /no demo/,
    },
    {
      name: "a demo that crashed or logged an error with AI off",
      test: AiCheckTest.HandlesNoAnswer,
      replay: { settled: false },
      pass: false,
      reason: /AI off/,
    },
    {
      name: "calls still pending when the demo ended with AI off",
      test: AiCheckTest.HandlesNoAnswer,
      replay: { stuck: 3 },
      pass: false,
      reason: /3 calls.*waiting/,
    },
    {
      name: "a host that cannot tell whether the demo settled",
      test: AiCheckTest.HandlesNoAnswer,
      replay: { settled: undefined, stuck: undefined },
      pass: null,
    },
    {
      name: "a game the largest answers its shapes allow break",
      test: AiCheckTest.OutputClamped,
      replay: { settled: false },
      pass: false,
      reason: /clamp/,
    },
    {
      name: "a grant asked for outside a gesture",
      test: AiCheckTest.BudgetInGesture,
      replay: { refused: { no_gesture: 1 } },
      pass: false,
      reason: /gesture/,
    },
    {
      name: "a host that does not count refusals",
      test: AiCheckTest.BudgetInGesture,
      replay: { refused: undefined },
      pass: null,
    },
    {
      name: "a state that says the disclosure is not drawn",
      test: AiCheckTest.DisclosureShown,
      evidence: { state: { ai: { disclosed: false } } },
      pass: false,
      reason: /disclosure/,
    },
    {
      name: "a demo's state that drew the disclosure",
      test: AiCheckTest.DisclosureShown,
      evidence: { state: { ai: { disclosed: false } }, demoStates: { "turn-three": { ai: { disclosed: true } } } },
      pass: true,
    },
    {
      name: "a state that reports no AI status",
      test: AiCheckTest.DisclosureShown,
      evidence: { state: { player: {} } },
      pass: null,
      reason: /state\(\)\.ai/,
    },
  ];

  for (const row of VERDICTS) {
    it(`reads ${row.name}`, async () => {
      const { results } = await score([row.test], evidenceOf(row.evidence), (p) =>
        replayed(String(p.demo), row.replay ?? {}),
      );
      const [entry] = results;
      assert.equal(entry?.pass, row.pass, JSON.stringify(entry));
      if (row.reason) assert.match(String(entry?.reason), row.reason);
    });
  }

  it("is unmeasured, never failed, when the studio cannot replay", async () => {
    const { results } = await score(
      [AiCheckTest.ReplayDeterministic, AiCheckTest.HandlesNoAnswer],
      evidenceOf(),
      () => {
        throw new Error("play-time AI isn't running in this studio");
      },
    );
    for (const entry of results) {
      assert.equal(entry.pass, null);
      assert.equal(entry.unavailable, true);
      assert.match(entry.reason, /isn't running/);
    }
  });

  it("is unmeasured when the evidence names no build", async () => {
    const { results, recorder } = await score([AiCheckTest.ReplayDeterministic], evidenceOf({ build: undefined }));
    assert.equal(results[0]?.pass, null);
    assert.deepEqual(recorder.paramsOf(HostMethod.AiReplay), []);
  });
});

describe("the scan of a build for direct model calls", () => {
  /** A build folder with `files` (path → text), and a folder beside it holding a secret. */
  async function build(files: Record<string, string>) {
    const dir = await tmpDir("ai-scan-");
    const root = path.join(dir, "game");
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    const outside = path.join(dir, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "net.js"), 'fetch("https://api.openai.com/v1/chat")');
    return { root, outside };
  }
  const OPENROUTER_KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

  const FINDS: Array<{ name: string; files: Record<string, string>; vendors: string[] }> = [
    { name: "a vendor URL", files: { "src/net.js": 'fetch("https://api.openai.com/v1/chat")' }, vendors: ["openai"] },
    {
      name: "a bare vendor host in a string",
      files: { "src/cfg.js": "const host = 'openrouter.ai';" },
      vendors: ["openrouter"],
    },
    {
      name: "a websocket to a vendor",
      files: { "index.html": "<script>new WebSocket('wss://api.x.ai/ws')</script>" },
      vendors: ["xai"],
    },
    {
      name: "a regional vendor host",
      files: { "src/g.ts": 'const u = "https://us-central1-aiplatform.googleapis.com/v1";' },
      vendors: ["google"],
    },
    {
      name: "a key in a module",
      files: { "src/key.js": `export const KEY = "${OPENROUTER_KEY}";` },
      vendors: ["openrouter"],
    },
    {
      name: "a built bundle",
      files: { "dist/assets/index-3f2a.js": 'n("https://api.anthropic.com/v1/messages")' },
      vendors: ["anthropic"],
    },
  ];
  for (const row of FINDS) {
    it(`finds ${row.name}`, async () => {
      const { root } = await build(row.files);
      const found = await scanForDirectCalls(root);
      assert.deepEqual(
        found.hits.map((hit) => hit.vendor),
        row.vendors,
      );
    });
  }

  const PASSES: Array<{ name: string; files: Record<string, string> }> = [
    {
      name: "a near-miss host",
      files: { "src/a.js": 'fetch("https://openai.com.evil.io/x"); fetch("https://notopenai.com")' },
    },
    { name: "another TLD", files: { "src/a.js": 'fetch("https://api.openai.co/v1")' } },
    { name: "a property chain that looks like a host", files: { "src/a.js": "const v = npc.x.ai + state.max.ai;" } },
    { name: "a key prefix in prose", files: { "README.md": "Keys start with sk-or- or sk-ant-; never paste one." } },
    {
      name: "a vendor host in node_modules",
      files: { "node_modules/openai/index.js": 'fetch("https://api.openai.com")' },
    },
    { name: "a vendor host in git's objects", files: { ".git/config": "url = https://api.openai.com" } },
    {
      name: "a vendor host in a saved playtest",
      files: { "ai/tapes/turn.jsonl": '{"value":"see https://openai.com"}' },
    },
    { name: "a binary file", files: { "assets/x.png": "https://api.openai.com" } },
  ];
  for (const row of PASSES) {
    it(`passes ${row.name}`, async () => {
      const { root } = await build(row.files);
      assert.deepEqual((await scanForDirectCalls(root)).hits, []);
    });
  }

  it("never names the key it found, only whose shape and where", async () => {
    const { root } = await build({ "src/key.js": `export const KEY = "${OPENROUTER_KEY}";` });
    const { results } = await score(
      [AiCheckTest.NoDirectModelCalls],
      evidenceOf({ build: { project: PROJECT, root } }),
    );
    assert.equal(results[0]?.pass, false);
    assert.match(String(results[0]?.reason), /src\/key\.js/);
    assert.ok(!String(results[0]?.reason).includes(OPENROUTER_KEY));
  });

  it("reads the game's own folder from the library when the build is the game itself", async () => {
    const { root } = await build({ "src/a.js": "export const x = 1;" });
    const recorder = ctxRecorder({
      handlers: {
        [HostMethod.GameList]: () => [
          { name: PROJECT, dir: root },
          { name: "other", dir: "/elsewhere" },
        ],
      },
    });
    const { results } = await runDeterministicChecks(recorder.ctx as never, {
      spec: { checks: [aiCheck(AiCheckTest.NoDirectModelCalls)] },
      evidence: evidenceOf({ build: { project: PROJECT, root: null } }) as never,
    });
    assert.equal(results[0]?.pass, true, JSON.stringify(results[0]));
  });

  it("never follows a link out of the build", async () => {
    const { root, outside } = await build({ "src/a.js": "export const x = 1;" });
    await symlink(outside, path.join(root, "linked"));
    await symlink(path.join(outside, "net.js"), path.join(root, "src", "net.js"));
    const found = await scanForDirectCalls(root);
    assert.deepEqual(found.hits, []);
    assert.equal(await readFile(path.join(outside, "net.js"), "utf8"), 'fetch("https://api.openai.com/v1/chat")');
  });

  it("skips a file over the size it reads and says so", async () => {
    const big = `${" ".repeat(AI_SCAN_MAX_FILE_BYTES)}fetch("https://api.openai.com")`;
    const { root } = await build({ "src/big.js": big });
    const found = await scanForDirectCalls(root);
    assert.deepEqual(found.hits, []);
    assert.deepEqual(found.skipped, ["src/big.js"]);
  });

  it("finds nothing in a folder that is not there", async () => {
    const found = await scanForDirectCalls("/nonexistent/genex/build");
    assert.deepEqual(found, { hits: [], scanned: 0, skipped: [] });
  });
});
