/**
 * The transcript census (M4.11c): both engines' formats, one set of numbers, and a script that
 * cannot write where it reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHANGE_HEADING,
  COMPLETION_ROLES,
  HEADINGS,
  ROLE_LITERALS,
  STUDIO_SCRATCH_PREFIXES,
  classifyBrief,
  defaultHomes,
  lookLine,
  ownedByStudio,
  readClaudeSession,
  readCodexSession,
  refuseOwnedOutput,
  renderMarkdown,
  runCensus,
  tally,
  type Homes,
} from "../../scripts/transcript-census.ts";
import { PRICE_TABLE_SCHEMA, PRICE_UNIT, validatePriceTable } from "../../scripts/evals/prices.ts";
import { CodexEngine, type CodexExec } from "../../src/substrate/engines/codex.ts";
import { normalizeToolName } from "../../src/shared/tool-category.ts";
import { replanCheck } from "../../src/harness-seed/loop/replan.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.resolve("tests/fixtures/transcripts");
const CLAUDE = path.join(FIXTURES, "claude-worker-facet.jsonl");
/** Three requests on two models, one 5-minute cache write among the 1-hour ones, and a failed Bash call. */
const CLAUDE_PRICED = path.join(FIXTURES, "claude-worker-priced.jsonl");
/** One priced model; the fixture's other model has no row, so its turn is counted, never guessed. */
const PRICES = validatePriceTable({
  schema: PRICE_TABLE_SCHEMA,
  asOf: "2026-10-03",
  unit: PRICE_UNIT,
  models: { "claude-opus-5-5": { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 } },
});
/** Dollars to the micro-dollar, so float sums compare. */
const usd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const CODEX = path.join(FIXTURES, "codex-director-rollout.jsonl");
/** A rollout with three tool calls, an answer, one more call and a last answer: five responses. */
const CODEX_TOOLS = path.join(FIXTURES, "codex-worker-facet.jsonl");
/** A playtester: read-only, started in a scratch folder the studio named, in nobody's game. */
const CODEX_SCRATCH = path.join(FIXTURES, "codex-playtester-scratch.jsonl");
/** The temp root the scratch fixture's cwd sits in. */
const SCRATCH_TMP = "/tmp/studio-scratch-fixture";

const seedFiles = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? seedFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

describe("the transcript census", () => {
  it("classifies a role only on a literal that is really in the harness seed", () => {
    const seed = seedFiles(path.resolve("src/harness-seed")).map((file) => fs.readFileSync(file, "utf8"));
    for (const [role, literal] of ROLE_LITERALS) {
      assert.ok(
        seed.some((text) => text.includes(literal)),
        `${role}: "${literal}" is no longer a sentence the harness writes — reword the census with the brief, or drop the role`,
      );
    }
    assert.equal(new Set(ROLE_LITERALS.map(([role]) => role)).size, ROLE_LITERALS.length);
  });

  it("keys on the opening sentence and calls everything else other", () => {
    assert.equal(classifyBrief('You are the DIRECTOR of run run-7 on the game "Two Rooms".'), "director");
    assert.equal(
      classifyBrief("  You are building ONE FACET of a game inside Autopilot run r, iteration 1."),
      "worker:facet",
    );
    assert.equal(classifyBrief("."), "other");
    assert.equal(classifyBrief(""), "other");
    assert.equal(classifyBrief(null), "other");
    assert.equal(classifyBrief("what does this game do?"), "other");
  });

  it("reads a Claude session: role, turns deduplicated by message id, and the usage fields", async () => {
    const session = await readClaudeSession(CLAUDE);
    assert.ok(session);
    assert.equal(session.engine, "claude");
    assert.equal(session.role, "worker:facet");
    assert.equal(session.id, "11111111-2222-3333-4444-555555555555");
    assert.equal(session.briefBytes, 176);
    assert.equal(session.turns, 2, "the repeated msg_a1 is one API call, not two");
    assert.deepEqual(session.input, { fresh: 20, cacheCreate: 1500, cacheRead: 41000, total: 42520 });
    assert.equal(session.output, 420);
    assert.equal(session.firstAt, "2026-09-08T01:00:00.000Z");
  });

  it("prices each request at its own model, counts 1-hour cache writes, the peak context and failed calls", async () => {
    const session = (await readClaudeSession(CLAUDE_PRICED, PRICES))!;
    assert.equal(session.turns, 3);
    assert.equal(session.cacheWrite1h, 11_500, "the one 5-minute write is not a 1-hour one");
    assert.equal(session.peakInput, 12_003, "the largest context one request carried");
    assert.deepEqual(Object.fromEntries(Object.entries(session.cost).map(([kind, value]) => [kind, usd(value)])), {
      fresh: 0.00002,
      cacheWrite: 0.096,
      cacheRead: 0.002,
      output: 0.03,
      total: 0.12802,
    });
    assert.equal(session.unpricedTurns, 1, "a model the table has no price for is counted, not guessed");
    assert.deepEqual(session.toolErrors, { Bash: 1 });
    const unpriced = (await readClaudeSession(CLAUDE))!;
    assert.equal(unpriced.unpricedTurns, 2, "without a table nothing is priced");
    assert.equal(unpriced.cost.total, 0);
  });

  it("renders cost by billing type, the 1-hour share and each tool's failures", async () => {
    const markdown = renderMarkdown(tally([(await readClaudeSession(CLAUDE_PRICED, PRICES))!]));
    assert.ok(markdown.includes("- cache writes at a 1-hour TTL: 11,500 of 12,000 (95.8%)"), markdown);
    assert.ok(
      markdown.includes(
        "- API-equivalent cost: $0.13 (fresh $0.00, cache write $0.10, cache read $0.00, output $0.03); 1 turn on a model with no price",
      ),
      markdown,
    );
    assert.ok(markdown.includes("| Bash | 1 | 1 | 1 |"), markdown);
    assert.ok(markdown.includes("| worker:facet | 1 | 1 / 0 |"));
    assert.ok(markdown.includes("| 12,003 | $0.13 |"), "the role row carries its peak context and its cost");
  });

  it("reads a Codex rollout: the brief is the first user message that is not an envelope", async () => {
    const session = await readCodexSession(CODEX);
    assert.ok(session);
    assert.equal(session.engine, "codex");
    assert.equal(session.role, "director");
    assert.equal(session.briefBytes, 157, "the <environment_context> message is not the brief");
    assert.equal(session.turns, 2, "the tool call is one response and the answer after its output is another");
    assert.equal(session.cwd, "/Users/studio/AI Games/two-rooms");
  });

  /**
   * A turn has to mean the same thing on both engines or the column that holds them is a lie.
   * Claude counts one per assistant `message.id`, tool-only responses included; Codex writes a
   * response as its items and closes it with the tool outputs, so a response is the run between
   * two outputs. Counting only Codex's assistant messages made a rollout of ninety tool calls
   * read as one turn beside a Claude session that read ninety.
   */
  it("counts a Codex turn as one model response, tool calls included", async () => {
    const session = await readCodexSession(CODEX_TOOLS);
    assert.ok(session);
    assert.equal(session.role, "worker:facet");
    assert.equal(
      session.turns,
      5,
      "three calls each answered by their output, then an answer that also called a tool, then the last answer",
    );
    assert.deepEqual(session.tools, { "studio:preview_ready": 1, "studio:preview_screenshot": 2, shell: 1 });
    assert.equal(session.toolCalls, 4);
    const claude = (await readClaudeSession(CLAUDE))!;
    assert.equal(claude.turns, 2, "and the Claude side of the same column still counts API responses");
  });

  it("sums the two engines' different token field names onto the same four numbers", async () => {
    const claude = (await readClaudeSession(CLAUDE))!;
    const codex = (await readCodexSession(CODEX))!;
    // Codex reports a running total_token_usage whose input_tokens already contains the cached
    // ones; Claude reports fresh, cache-write and cache-read per message.
    assert.deepEqual(codex.input, { fresh: 2000, cacheCreate: 500, cacheRead: 28000, total: 30500 });
    assert.equal(codex.output, 900);
    const census = tally([claude, codex]);
    assert.equal(census.totals.input, 73020);
    assert.equal(census.totals.output, 1320);
    assert.equal(census.totals.turns, 4, "two Claude responses and two Codex ones, counted the same way");
    assert.equal(census.engines.claude.sessions, 1);
    assert.equal(census.engines.codex.sessions, 1);
  });

  it("counts a bridge call and an mcp call as the same tool", async () => {
    assert.equal(normalizeToolName("mcp__studio__preview_ready", ""), "studio:preview_ready");
    assert.equal(
      normalizeToolName(
        "shell",
        '{"command":["bash","-lc","node .studio/bridge/tool.mjs preview_ready --timeout_ms=15000"]}',
      ),
      "studio:preview_ready",
    );
    assert.equal(normalizeToolName("Bash", "node .studio/harness/selftest.mjs"), "Bash");
    const claude = (await readClaudeSession(CLAUDE))!;
    const codex = (await readCodexSession(CODEX))!;
    assert.deepEqual(claude.tools, { "studio:preview_screenshot": 1, Bash: 1 });
    assert.deepEqual(codex.tools, { "studio:preview_ready": 1 });
    const census = tally([claude, codex]);
    assert.equal(census.totals.toolCalls, 3);
    assert.deepEqual(census.tools.map((t) => t.name).sort(), [
      "Bash",
      "studio:preview_ready",
      "studio:preview_screenshot",
    ]);
  });

  it("renders the four headings, the where-I-looked lines and the honest other share", async () => {
    const claude = (await readClaudeSession(CLAUDE))!;
    const codex = (await readCodexSession(CODEX))!;
    const stranger = { ...claude, role: "other" as const, briefBytes: 24 };
    const census = tally(
      [claude, codex, stranger],
      [
        {
          engine: "claude",
          isolated: true,
          where: "/app/engine-homes/claude-code/projects",
          files: 2,
          note: "isolated home at /app/engine-homes/claude-code",
        },
        {
          engine: "codex",
          isolated: false,
          where: "/home/.codex/sessions",
          files: 449,
          note: "no isolated home at /app/engine-homes/codex; rerun with --system-codex to read the system home",
        },
      ],
    );
    const markdown = renderMarkdown(census);
    for (const heading of HEADINGS) assert.ok(markdown.includes(heading), `missing ${heading}`);
    assert.ok(!markdown.includes(CHANGE_HEADING), "no baseline, no change section");
    assert.ok(
      markdown.includes(
        "codex: no isolated home at /app/engine-homes/codex; rerun with --system-codex to read the system home — 449 transcripts under /home/.codex/sessions",
      ),
    );
    assert.ok(markdown.includes("1 of 3 sessions (33.3%) and 24 brief bytes"), markdown);
    assert.ok(markdown.includes("| worker:facet | 1 |"));
    assert.ok(!markdown.includes("REDACTED"), "no transcript text may reach the output");
  });

  it("prints a dash, not a zero, where Codex could never have written a session", async () => {
    // Every critic, the planner and the skill editor are asked with `engine.complete`, which
    // Codex runs as `codex exec --ephemeral`: those sessions write no rollout at all. A `0`
    // there is indistinguishable from a role that simply did not run, and it is not a
    // measurement — no file this census reads was ever written.
    const claude = (await readClaudeSession(CLAUDE))!;
    const critic = { ...claude, role: "judge:taste" as const };
    const markdown = renderMarkdown(tally([claude, critic]));
    assert.ok(markdown.includes("| judge:taste | 1 | 1 / — |"), markdown);
    assert.ok(markdown.includes("| worker:facet | 1 | 1 / 0 |"), "a delegated role keeps its real zero");
    assert.match(markdown, /A `—` in the codex column is not zero\./);
    // …and the list is the roles the harness really asks with engine.complete: the replan, run
    // against a recording ctx, is a completion whose brief the census reads as planner:replan.
    const calls: Array<{ method: string; params: { systemPrompt?: string } }> = [];
    const ctx = {
      workspace: "/nonexistent",
      cancelled: false,
      notify() {},
      setStatus() {},
      call: async (method: string, params: { systemPrompt?: string }) => (
        calls.push({ method, params }), { message: { role: "assistant", content: "{}" } }
      ),
    };
    await replanCheck(
      ctx as never,
      {
        run: { runId: "r", engine: "codex" },
        spec: { id: "f", title: "F", intent: "x", checks: [] },
        check: { id: "c", kind: "vision", camera: "default", ask: "?" },
        reason: "why",
      } as never,
    );
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["engine.complete"],
      "replan is a completion, so planner:replan belongs on the list",
    );
    assert.equal(classifyBrief(calls[0]!.params.systemPrompt ?? ""), "planner:replan");
    assert.ok(
      COMPLETION_ROLES.includes("planner:replan") &&
        COMPLETION_ROLES.every((role) => ROLE_LITERALS.some(([id]) => id === role)),
    );
    assert.ok(!COMPLETION_ROLES.includes("playtester"), "a playtester is a delegation and does leave a rollout");
    // That a Codex completion runs `--ephemeral` is proven against the engine itself below.
  });

  it("prints the change against a baseline when one is given", async () => {
    const claude = (await readClaudeSession(CLAUDE))!;
    const now = tally([claude, { ...claude, briefBytes: 200 }]);
    const before = tally([claude]);
    const markdown = renderMarkdown(now, before);
    assert.ok(markdown.includes(CHANGE_HEADING));
    assert.ok(markdown.includes("| worker:facet | +1 (+100%) |"), markdown.slice(markdown.indexOf(CHANGE_HEADING)));
  });

  it("walks both homes and says where it looked", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "census-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const homes: Homes = {
      appDir: path.join(home, "app"),
      claudeIsolated: path.join(home, "app", "engine-homes", "claude-code"),
      claudeSystem: path.join(home, ".claude"),
      codexIsolated: path.join(home, "app", "engine-homes", "codex"),
      codexSystem: path.join(home, ".codex"),
      gameRoots: ["/Users/studio/AI Games"],
      tmpDir: SCRATCH_TMP,
    };
    fs.mkdirSync(path.join(homes.claudeIsolated, "projects", "-Users-studio-AI-Games-two-rooms"), { recursive: true });
    fs.copyFileSync(
      CLAUDE,
      path.join(homes.claudeIsolated, "projects", "-Users-studio-AI-Games-two-rooms", "session.jsonl"),
    );
    fs.mkdirSync(path.join(homes.codexSystem, "sessions", "2026", "09", "08"), { recursive: true });
    fs.copyFileSync(CODEX, path.join(homes.codexSystem, "sessions", "2026", "09", "08", "rollout-fixture.jsonl"));
    fs.copyFileSync(
      CODEX_SCRATCH,
      path.join(homes.codexSystem, "sessions", "2026", "09", "08", "rollout-playtest.jsonl"),
    );

    const quiet = await runCensus({ homes });
    assert.equal(quiet.sessions, 1, "the system Codex home is not read unless it is asked for");
    assert.equal(quiet.looks[1]!.files, 2, "but the run still says what is there");
    assert.ok(lookLine(quiet.looks[1]!).includes("rerun with --system-codex"));
    assert.ok(lookLine(quiet.looks[0]!).includes("isolated home at"));

    const full = await runCensus({ homes, systemCodex: true });
    assert.equal(full.sessions, 3);
    assert.deepEqual(full.roles.map((r) => r.role).sort(), ["director", "playtester", "worker:facet"]);
    assert.equal(full.looks[1]!.dropped ?? 0, 0, "nothing was dropped, so the line says nothing about dropping");

    // A playtester and a judge run in a scratch folder the studio made, not in a game: filtering
    // the owner's own home on the game roots alone emptied both rows and said nothing about it.
    const noScratch = await runCensus({ homes: { ...homes, tmpDir: "/somewhere/else" }, systemCodex: true });
    assert.equal(noScratch.sessions, 2, "a scratch folder that is not the studio's temp root is not the studio's");
    assert.equal(noScratch.looks[1]!.dropped, 1, "and the line has to say one was dropped");
    assert.ok(lookLine(noScratch.looks[1]!).endsWith("; 1 not the studio's and dropped"));

    const elsewhere = await runCensus({
      homes: { ...homes, gameRoots: ["/somewhere/else"], tmpDir: "/somewhere/else" },
      systemCodex: true,
    });
    assert.equal(elsewhere.sessions, 1, "a Codex session that did not run in a game folder is not the studio's");
    assert.equal(elsewhere.looks[1]!.dropped, 2);
  });

  it("reads the system Claude home only when asked, and only the studio's own sessions", async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "census-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const homes: Homes = {
      appDir: path.join(home, "app"),
      claudeIsolated: path.join(home, "app", "engine-homes", "claude-code"),
      claudeSystem: path.join(home, ".claude"),
      codexIsolated: path.join(home, "app", "engine-homes", "codex"),
      codexSystem: path.join(home, ".codex"),
      gameRoots: ["/Users/studio/AI Games"],
      tmpDir: SCRATCH_TMP,
    };
    // A sign-in on this Mac puts the studio's sessions beside the owner's own, in ~/.claude.
    const game = path.join(homes.claudeSystem, "projects", "-Users-studio-AI-Games-two-rooms");
    const own = path.join(homes.claudeSystem, "projects", "-Users-studio-code-private");
    fs.mkdirSync(game, { recursive: true });
    fs.mkdirSync(own, { recursive: true });
    fs.copyFileSync(CLAUDE_PRICED, path.join(game, "session.jsonl"));
    const elsewhere = fs
      .readFileSync(CLAUDE_PRICED, "utf8")
      .replaceAll("/Users/studio/AI Games/two-rooms", "/Users/studio/code/private");
    fs.writeFileSync(path.join(own, "session.jsonl"), elsewhere);

    const quiet = await runCensus({ homes });
    assert.equal(quiet.sessions, 0, "the owner's own Claude home is not read unless it is asked for");
    assert.ok(lookLine(quiet.looks[0]!).includes("rerun with --system-claude"), lookLine(quiet.looks[0]!));
    assert.equal(quiet.looks[0]!.files, 2, "but the run still says what is there");

    const full = await runCensus({ homes, systemClaude: true });
    assert.equal(full.sessions, 1, "a session that did not run in a game folder is not the studio's");
    assert.equal(full.looks[0]!.dropped, 1);
    assert.ok(lookLine(full.looks[0]!).endsWith("; 1 not the studio's and dropped"));
  });

  it("names scratch prefixes the engine really writes, so a rename fails here", async () => {
    // The Codex engine run for real against a fake `codex exec`: a judge's completion and a
    // read-only playtest each start in a scratch folder of their own, and the census must own both.
    const seen: Array<{ argv: string[]; cwd: string }> = [];
    const execFn: CodexExec = (invocation) => {
      seen.push({ argv: invocation.argv, cwd: invocation.cwd });
      return (async function* () {
        yield { type: "thread.started", thread_id: "census-1" };
        yield { type: "item.completed", item: { id: "a", type: "agent_message", text: "ok" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
      })();
    };
    const root = await tmpDir("studio-census-codex-");
    const home = path.join(root, "codex-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    const engine = new CodexEngine({
      resolveCli: fixtureCodingCli,
      engineHome: home,
      systemHome: path.join(root, "no-system-login"),
      executable: "/fake/codex",
      authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
      execFn,
    });
    const game = path.join(root, "game");
    fs.mkdirSync(game);
    await engine.complete({
      systemPrompt: "You are the taste judge.",
      messages: [{ role: "user", content: "Which reads better?" }],
    });
    await engine.delegate({ prompt: "Play it", cwd: game, readOnly: true });
    const scratch = seen.map(({ cwd }) => cwd).filter((cwd) => cwd !== game);
    const homes: Homes = { ...defaultHomes("/Users/fixture"), tmpDir: os.tmpdir() };
    assert.equal(scratch.length, 2, "one scratch folder for the judge, one for the playtester");
    for (const cwd of scratch)
      assert.ok(
        ownedByStudio(cwd, homes),
        `${cwd} is a folder the Codex engine makes — follow the rename, or the census empties those rows again`,
      );
    assert.deepEqual(
      STUDIO_SCRATCH_PREFIXES.filter((prefix) => scratch.some((cwd) => path.basename(cwd).startsWith(prefix))),
      [...STUDIO_SCRATCH_PREFIXES],
      "every prefix the census names is one the engine still makes",
    );
    // A completion writes no rollout, which is why its roles are counted as completions.
    assert.ok(seen[0]!.argv.includes("--ephemeral"));
  });

  it("counts a scratch folder the studio named as the studio's, and nobody else's", () => {
    const homes: Homes = { ...defaultHomes("/Users/fixture"), tmpDir: "/var/folders/t1" };
    assert.equal(ownedByStudio("/Users/fixture/AI Games/two-rooms", homes), true);
    // Genex's data folder, and the one it had as AI Game Studio, which older transcripts name.
    for (const app of ["Genex", "AI Game Studio"])
      assert.equal(
        ownedByStudio(`/Users/fixture/Library/Application Support/${app}/scratch/autopilot/run-7`, homes),
        true,
        app,
      );
    for (const prefix of STUDIO_SCRATCH_PREFIXES) {
      assert.equal(
        ownedByStudio(`/var/folders/t1/${prefix}a1b2c3`, homes),
        true,
        `${prefix} is the studio's own scratch`,
      );
      // macOS reports the same folder to a child process under /private; Windows has no such alias.
      if (process.platform !== "win32")
        assert.equal(
          ownedByStudio(`/private/var/folders/t1/${prefix}a1b2c3`, homes),
          true,
          `${prefix} under /private is the same folder`,
        );
    }
    assert.equal(
      ownedByStudio("/var/folders/t1/some-other-tool", homes),
      false,
      "somebody else's temp folder is not ours",
    );
    assert.equal(ownedByStudio("/Users/fixture/work/notes", homes), false);
    assert.equal(ownedByStudio(null, homes), false);
    assert.equal(ownedByStudio("", homes), false);
  });

  it("refuses to write inside the studio's own data", () => {
    const homes = defaultHomes("/Users/fixture");
    for (const owned of [
      "/Users/fixture/Library/Application Support/Genex/census.json",
      "/Users/fixture/Library/Application Support/AI Game Studio/census.json",
      "/Users/fixture/Library/Application Support/AI Game Studio/engine-homes/claude-code/c.md",
      "/Users/fixture/.claude/c.json",
      "/Users/fixture/.codex/sessions/c.json",
    ]) {
      const refusal = refuseOwnedOutput(owned, homes);
      assert.ok(refusal, `${owned} must be refused`);
      assert.match(refusal, /refusing to write inside the studio's own data/);
    }
    assert.equal(refuseOwnedOutput("/tmp/census.json", homes), null);
    assert.equal(refuseOwnedOutput("/Users/fixture/notes/census.md", homes), null);
  });

  it("has no way to change what it reads", () => {
    const source = fs.readFileSync(path.resolve("scripts/transcript-census.ts"), "utf8");
    for (const call of [
      "rm(",
      "rmSync",
      "unlink",
      "rename",
      "mkdir",
      "rmdir",
      "truncate",
      "appendFile",
      "createWriteStream",
      "copyFile",
      "chmod",
      "utimes",
    ])
      assert.ok(!source.includes(call), `the census must not call ${call}`);
    assert.equal(source.match(/writeFile/g)?.length, 2, "exactly the two files --json and --md name");
  });
});
