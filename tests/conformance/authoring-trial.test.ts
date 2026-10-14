/**
 * The M0a authoring-trial driver (`scripts/spike/rust-wgpu/authoring-trial.ts`, M0a.14a): the same
 * facet asks (`authoring-asks.json`) against the Rust pond and the raylib-cpp fishing baseline,
 * scored per stack as first-compile success, repair turns until a green build and warm
 * rebuild+link time, then compared in the table the paid M0a.14 gate fills.
 *
 * Every row runs without a provider: the dry run replays the fixture transcripts
 * (`tests/fixtures/authoring-trial/transcripts.json`) through the stub provider, and the
 * authorized rows inject a fake live provider. Without `GENEX_AUTHORING_TRIAL_AUTHORIZED` (an
 * attempt cap) a live run is refused before any provider exists and writes nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  agentTurn,
  type AttemptTranscript,
  type BuildOutput,
  type CommandSpec,
  checkTurnScope,
  liveAttempt,
  type LiveParts,
  DEFAULT_ASKS_FILE,
  DEFAULT_TRANSCRIPTS_FILE,
  KillReason,
  type LiveContext,
  loadAsks,
  loadTranscripts,
  parseCargoBuild,
  parseCppBuild,
  ProbeOutcome,
  REFUSAL_EXIT,
  REFUSAL_PREFIX,
  runTrial,
  scoreAttempt,
  summarizeTrial,
  TRIAL_AUTHORIZATION_VAR,
  TrialMode,
  TrialRefusalCode,
  TrialStack,
  TurnScopeCode,
  trialChildEnv,
  trialProbeLockPath,
} from "../../scripts/spike/rust-wgpu/authoring-trial.ts";
import { strippedEnv } from "../../scripts/evals/lanes/common.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DRIVER = path.join(REPO, "scripts", "spike", "rust-wgpu", "authoring-trial.ts");
/** A small folder with no symbolic links that stands in for a game copy (the provider is a fake). */
const FIXTURE_GAME = path.join(REPO, "tests", "fixtures", "authoring-trial");
const CLI_TIMEOUT_MS = 60_000;
/** How long a fake CLI that reads stdin to its end may take before the turn counts as waiting on it. */
const STDIN_WAIT_LIMIT_MS = 5_000;

/** One cargo `--message-format=json` line per object. */
const cargoLines = (...messages: object[]) => messages.map((m) => JSON.stringify(m)).join("\n");
const cargoMessage = (
  level: string,
  file: string,
  line: number,
  column: number,
  code: string | null,
  text: string,
) => ({
  reason: "compiler-message",
  package_id: "pond 0.1.0",
  message: {
    level,
    message: text,
    code: code === null ? null : { code },
    spans: [{ file_name: file, line_start: line, column_start: column, is_primary: true }],
  },
});
const spanless = (text: string) => ({
  reason: "compiler-message",
  package_id: "pond 0.1.0",
  message: { level: "error", message: text, code: null, spans: [] },
});
const finished = (success: boolean) => ({ reason: "build-finished", success });
const built = (stdout: string, stderr: string, exitCode: number): BuildOutput => ({ stdout, stderr, exitCode });

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const options = { env, cwd: REPO, timeout: CLI_TIMEOUT_MS };
    execFile(process.execPath, [DRIVER, ...args], options, (error, stdout, stderr) => {
      const failed = error ? 1 : 0;
      const code = error && typeof error.code === "number" ? error.code : failed;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The process environment without the owner's authorization variable. */
function unauthorizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[TRIAL_AUTHORIZATION_VAR];
  return env;
}

/** A live-provider factory that records whether it was ever asked for a provider. */
function recordingProvider(transcriptOf: (stack: TrialStack, askId: string) => AttemptTranscript) {
  const made: LiveContext[] = [];
  const attempts: Array<{ stack: TrialStack; ask: string }> = [];
  const factory = (ctx: LiveContext) => {
    made.push(ctx);
    return {
      attempt: async (stack: TrialStack, ask: { id: string }) => {
        attempts.push({ stack, ask: ask.id });
        return transcriptOf(stack, ask.id);
      },
    };
  };
  return { factory, made, attempts };
}

const greenBuild = (stack: TrialStack) =>
  stack === TrialStack.Rust
    ? built(cargoLines(finished(true)), "", 0)
    : built("", "[2/2] Linking CXX executable game\n", 0);

const greenTranscript = (stack: TrialStack, ask: string): AttemptTranscript => ({
  stack,
  ask,
  turns: [{ prompt: ask, build: greenBuild(stack) }],
  warmRebuildMs: 1000,
  probe: ProbeOutcome.Pass,
});

describe("cargo JSON diagnostics", () => {
  it("counts located errors only, keeps file:line:col and code, and reads build-finished", () => {
    const stdout = cargoLines(
      { reason: "compiler-artifact", package_id: "genex 0.1.0", fresh: true },
      cargoMessage("warning", "examples/pond/src/pond.rs", 88, 9, "unused_variables", "unused variable"),
      cargoMessage("error", "examples/pond/src/pond.rs", 181, 31, "E0308", "mismatched types"),
      spanless("aborting due to 1 previous error"),
      finished(false),
    );
    const parsed = parseCargoBuild(built(stdout, "", 101));
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.diagnostics, [
      { file: "examples/pond/src/pond.rs", line: 181, column: 31, code: "E0308", message: "mismatched types" },
    ]);
    assert.equal(parsed.unlocatedErrors, 1);
  });

  it("is green only when build-finished says so and no located error was seen", () => {
    assert.equal(parseCargoBuild(built(cargoLines(finished(true)), "", 0)).ok, true);
    // A link failure has no span: no located diagnostic, but the build is still red.
    const parsed = parseCargoBuild(built(cargoLines(spanless("linking with `cc` failed"), finished(false)), "", 101));
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.diagnostics, []);
    // Without a build-finished line (cargo killed), the exit code decides.
    assert.equal(parseCargoBuild(built("", "", 101)).ok, false);
  });

  it("ignores hostile lines instead of throwing", () => {
    const hostile = [
      "not json",
      "{",
      "null",
      "[1,2]",
      JSON.stringify({ reason: "compiler-message" }),
      JSON.stringify({ reason: "compiler-message", message: { level: "error", spans: "x" } }),
      JSON.stringify({
        reason: "compiler-message",
        message: { level: "error", message: 7, spans: [{ file_name: 3 }] },
      }),
      JSON.stringify(finished(true)),
    ].join("\r\n");
    const parsed = parseCargoBuild(built(hostile, "", 0));
    assert.equal(parsed.diagnostics.length, 0);
    assert.equal(parsed.ok, false, "an error-level message, even malformed, keeps the build red");
  });
});

describe("C++ compiler diagnostics", () => {
  it("reads clang/gcc file:line:col: error: lines and skips warnings and notes", () => {
    const stderr = [
      "[1/2] Building CXX object CMakeFiles/game.dir/src/main.cpp.o",
      "FAILED: CMakeFiles/game.dir/src/main.cpp.o",
      "\u001b[1m/g/src/main.cpp:142:17: \u001b[0m\u001b[0;1;31merror: \u001b[0m\u001b[1mno member named 'ripple' in 'Bobber'\u001b[0m",
      "  142 |     bobber.ripple = 0.0f;",
      "/g/src/main.cpp:88:9: warning: unused variable 'dt' [-Wunused-variable]",
      "/g/src/fish.h:12:1: note: declared here",
      "/g/src/fish.h:3:10: fatal error: 'wind.h' file not found",
      "C:\\g\\src\\main.cpp(40,5): error C2039: 'push': is not a member of 'Wind'",
      "1 error generated.",
    ].join("\n");
    const parsed = parseCppBuild(built("", stderr, 1));
    assert.equal(parsed.ok, false);
    assert.deepEqual(
      parsed.diagnostics.map((d) => [d.file, d.line, d.column, d.code]),
      [
        ["/g/src/main.cpp", 142, 17, null],
        ["/g/src/fish.h", 3, 10, null],
        ["C:\\g\\src\\main.cpp", 40, 5, "C2039"],
      ],
    );
    assert.equal(parsed.diagnostics[0]?.message, "no member named 'ripple' in 'Bobber'");
  });

  it("counts a linker failure as an unlocated error", () => {
    const stderr = [
      "Undefined symbols for architecture arm64:",
      '  "Wind::push(Vector3&)", referenced from:',
      "ld: symbol(s) not found for architecture arm64",
      "clang++: error: linker command failed with exit code 1 (use -v to see invocation)",
    ].join("\n");
    const parsed = parseCppBuild(built("", stderr, 1));
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.unlocatedErrors, 1);
  });

  it("is green on exit 0 with no error line", () => {
    assert.equal(parseCppBuild(built("[2/2] Linking CXX executable game", "", 0)).ok, true);
    assert.equal(parseCppBuild(built("", "", 2)).ok, false);
  });
});

describe("dry run with the stub provider", () => {
  it("records first-compile success and repair turns for both stacks from the fixture transcripts", async () => {
    const out = await tmpDir("authoring-trial-");
    const result = await runTrial({ mode: TrialMode.DryRun, out, env: unauthorizedEnv() });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { report } = result;
    const of = (stack: TrialStack) => report.attempts.filter((a) => a.stack === stack);
    assert.deepEqual(
      of(TrialStack.Rust).map((a) => [a.ask, a.firstCompileOk, a.repairTurns]),
      [
        ["second-species", false, 1],
        ["bite-ripple", true, 0],
        ["round-timer", false, 2],
        ["wind-cast", true, 0],
        ["better-rod", true, 0],
        ["catch-combo", false, null],
      ],
    );
    assert.deepEqual(
      of(TrialStack.Raylib).map((a) => [a.ask, a.firstCompileOk, a.repairTurns]),
      [
        ["second-species", true, 0],
        ["bite-ripple", false, 1],
        ["round-timer", true, 0],
        ["wind-cast", false, 1],
        ["better-rod", true, 0],
        ["catch-combo", true, 0],
      ],
    );
    const rust = report.summaries[TrialStack.Rust];
    const raylib = report.summaries[TrialStack.Raylib];
    assert.deepEqual([rust?.firstCompileOk, rust?.succeeded, rust?.attempts], [3, 5, 6]);
    assert.deepEqual([raylib?.firstCompileOk, raylib?.succeeded, raylib?.attempts], [4, 6, 6]);
    assert.equal(rust?.medianWarmRebuildMs, 4000);
    assert.equal(raylib?.medianWarmRebuildMs, 2000);
    assert.equal(report.identity.provider, "stub");
    assert.deepEqual(report.verdict.reasons, [KillReason.FirstCompileBelow, KillReason.SuccessBelow]);

    const written = JSON.parse(await readFile(path.join(out, "trial.json"), "utf8"));
    assert.deepEqual(written.summaries, JSON.parse(JSON.stringify(report.summaries)));
    const table = await readFile(path.join(out, "comparison.md"), "utf8");
    assert.equal(table.split("\n").filter((l) => l.startsWith("|")).length, 2 + report.comparison.length);
  });

  it("flags a warm rebuild over twice the C++ lane, and is clean when Rust matches the baseline", async () => {
    const asks = await loadAsks(DEFAULT_ASKS_FILE);
    const transcripts = await loadTranscripts(DEFAULT_TRANSCRIPTS_FILE);
    const rebuildMs = (stack: TrialStack) => (stack === TrialStack.Rust ? 4100 : 2000);
    const slowGreen = transcripts.map((t) => ({
      ...greenTranscript(t.stack, t.ask),
      warmRebuildMs: rebuildMs(t.stack),
    }));
    const slow = summarizeTrial(slowGreen.map((t) => scoreAttempt(t, asks.maxRepairTurns)));
    assert.deepEqual(slow.verdict.reasons, [KillReason.WarmRebuildOver2x]);
    const even = slowGreen.map((t) => ({ ...t, warmRebuildMs: 2000 }));
    const evenSummary = summarizeTrial(even.map((t) => scoreAttempt(t, asks.maxRepairTurns)));
    assert.deepEqual(evenSummary.verdict, { kill: false, reasons: [] });
  });

  it("the CLI dry run writes the comparison and exits 0", async () => {
    const out = await tmpDir("authoring-trial-cli-");
    const run = await runCli(["--dry-run", "--out", out], unauthorizedEnv());
    assert.equal(run.code, 0, run.stderr);
    assert.ok(existsSync(path.join(out, "comparison.md")));
    const written = JSON.parse(await readFile(path.join(out, "trial.json"), "utf8"));
    assert.equal(written.mode, TrialMode.DryRun);
    assert.equal(written.attempts.length, 12);
  });

  it("stays on the stub even when the authorization variable is set", async () => {
    const out = await tmpDir("authoring-trial-");
    const provider = recordingProvider(greenTranscript);
    const env = { ...unauthorizedEnv(), [TRIAL_AUTHORIZATION_VAR]: "6" };
    const result = await runTrial({ mode: TrialMode.DryRun, out, env }, { liveProvider: provider.factory });
    assert.equal(result.ok, true);
    assert.equal(provider.made.length, 0);
  });
});

describe("live runs need the owner's attempt cap", () => {
  const live = (out: string, env: NodeJS.ProcessEnv) => ({
    mode: TrialMode.Live,
    out,
    env,
    profile: "authoring-trial",
    model: "test-model",
    games: { [TrialStack.Rust]: FIXTURE_GAME, [TrialStack.Raylib]: FIXTURE_GAME },
  });

  it("refuses without the variable before any provider exists, and writes nothing", async () => {
    const out = path.join(await tmpDir("authoring-trial-"), "never");
    const provider = recordingProvider(greenTranscript);
    const result = await runTrial(live(out, unauthorizedEnv()), { liveProvider: provider.factory });
    assert.deepEqual(result.ok ? null : result.refusal.code, TrialRefusalCode.AuthorizationMissing);
    assert.equal(provider.made.length, 0);
    assert.equal(existsSync(out), false);
  });

  const hostile = ["", "0", "-3", "two", "2.5", "1e1", "25", " 3", "03", "6;rm -rf /", "Infinity"];
  for (const value of hostile) {
    it(`refuses the cap ${JSON.stringify(value)} with no side effect`, async () => {
      const out = path.join(await tmpDir("authoring-trial-"), "never");
      const provider = recordingProvider(greenTranscript);
      const env = { ...unauthorizedEnv(), [TRIAL_AUTHORIZATION_VAR]: value };
      const result = await runTrial(live(out, env), { liveProvider: provider.factory });
      assert.equal(result.ok, false);
      if (result.ok) return;
      const expected = value === "" ? TrialRefusalCode.AuthorizationMissing : TrialRefusalCode.AuthorizationInvalid;
      assert.equal(result.refusal.code, expected);
      assert.equal(provider.made.length, 0);
      assert.equal(existsSync(out), false);
    });
  }

  it("the CLI refuses --live without the variable with a typed line and exit 78", async () => {
    const out = path.join(await tmpDir("authoring-trial-cli-"), "never");
    const games = ["--rust-game", REPO, "--raylib-game", REPO];
    const run = await runCli(
      ["--live", "--profile", "authoring-trial", "--model", "m", ...games, "--out", out],
      unauthorizedEnv(),
    );
    assert.equal(run.code, REFUSAL_EXIT);
    const line = run.stderr.split("\n").find((l) => l.startsWith(REFUSAL_PREFIX));
    assert.ok(line, run.stderr);
    assert.equal(JSON.parse(line.slice(REFUSAL_PREFIX.length)).code, TrialRefusalCode.AuthorizationMissing);
    assert.equal(existsSync(out), false);
  });

  it("an authorized run asks the provider at most the cap per stack and records its identity", async () => {
    const out = await tmpDir("authoring-trial-");
    const provider = recordingProvider(greenTranscript);
    const env = { ...unauthorizedEnv(), [TRIAL_AUTHORIZATION_VAR]: "2" };
    const result = await runTrial(live(out, env), { liveProvider: provider.factory });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.refusal));
    assert.equal(provider.made.length, 1);
    assert.deepEqual(provider.attempts, [
      { stack: TrialStack.Rust, ask: "second-species" },
      { stack: TrialStack.Rust, ask: "bite-ripple" },
      { stack: TrialStack.Raylib, ask: "second-species" },
      { stack: TrialStack.Raylib, ask: "bite-ripple" },
    ]);
    if (!result.ok) return;
    assert.equal(result.report.attemptCap, 2);
    assert.deepEqual([result.report.identity.profile, result.report.identity.model], ["authoring-trial", "test-model"]);
    assert.deepEqual(result.report.verdict, { kill: false, reasons: [] });
  });

  it("refuses an authorized run with no owned profile, model or games before any provider exists", async () => {
    const out = path.join(await tmpDir("authoring-trial-"), "never");
    const provider = recordingProvider(greenTranscript);
    const env = { ...unauthorizedEnv(), [TRIAL_AUTHORIZATION_VAR]: "2" };
    const missing = path.join(out, "no-such-game");
    const broken = [
      { profile: undefined },
      { profile: "../normal" },
      { model: undefined },
      { games: {} },
      { games: { [TrialStack.Rust]: missing, [TrialStack.Raylib]: REPO } },
    ];
    for (const change of broken) {
      const result = await runTrial({ ...live(out, env), ...change }, { liveProvider: provider.factory });
      const code = result.ok ? null : result.refusal.code;
      assert.equal(code, TrialRefusalCode.LivePrerequisiteMissing, JSON.stringify(change));
    }
    assert.equal(provider.made.length, 0);
    assert.equal(existsSync(out), false);
  });
});

/** A tiny Rust game source: the pond's editable folder and its manifests. */
async function rustSource(): Promise<string> {
  const root = await tmpDir("authoring-scope-src-");
  await mkdir(path.join(root, "examples", "pond", "src"), { recursive: true });
  await writeFile(path.join(root, "Cargo.toml"), "[workspace]\n");
  await writeFile(path.join(root, "examples", "pond", "Cargo.toml"), '[package]\nname = "pond"\n');
  await writeFile(path.join(root, "examples", "pond", "src", "pond.rs"), "pub fn bite() {}\n");
  await writeFile(path.join(root, "README.md"), "pond\n");
  return root;
}

const RUST_EDITABLE = ["examples/pond/src/"];
const pondFile = (root: string, ...rest: string[]) => path.join(root, "examples", "pond", ...rest);

/** One out-of-scope edit and the refusal it must earn; nothing may be built after it. */
const SCOPE_HOSTILE: Array<{ name: string; code: TurnScopeCode; edit: (work: string) => Promise<void> }> = [
  {
    name: "a file outside the editable folder changes",
    code: TurnScopeCode.OutsideEditable,
    edit: (w) => writeFile(path.join(w, "README.md"), "x\n"),
  },
  {
    name: "a new file outside the editable folder appears",
    code: TurnScopeCode.OutsideEditable,
    edit: (w) => writeFile(pondFile(w, "assets.rs"), "x\n"),
  },
  {
    name: "a symbolic link appears in the editable folder",
    code: TurnScopeCode.Symlink,
    edit: (w) => symlink("/etc/hosts", pondFile(w, "src", "hosts.rs")),
  },
  {
    name: "a .cargo/config.toml appears at the root",
    code: TurnScopeCode.CargoConfig,
    edit: async (w) => {
      await mkdir(path.join(w, ".cargo"));
      await writeFile(path.join(w, ".cargo", "config.toml"), "[build]\nrustc-wrapper = '/tmp/w'\n");
    },
  },
  {
    name: "the pond's Cargo.toml gains a dependency",
    code: TurnScopeCode.Manifest,
    edit: (w) => writeFile(pondFile(w, "Cargo.toml"), '[dependencies]\nevil = { path = "/tmp" }\n'),
  },
  {
    name: "a Cargo.toml appears inside the editable folder",
    code: TurnScopeCode.Manifest,
    edit: (w) => writeFile(pondFile(w, "src", "Cargo.toml"), "[package]\n"),
  },
  {
    name: "a build script appears",
    code: TurnScopeCode.BuildScript,
    edit: (w) => writeFile(pondFile(w, "src", "build.rs"), "fn main() {}\n"),
  },
  {
    name: "an edited Rust file uses unsafe",
    code: TurnScopeCode.UnsafeCode,
    edit: (w) =>
      writeFile(pondFile(w, "src", "pond.rs"), "pub fn bite() { unsafe { std::hint::unreachable_unchecked() } }\n"),
  },
];

describe("the live trial keeps an agent turn to its scope before anything is built", () => {
  for (const row of SCOPE_HOSTILE) {
    it(`refuses ${row.code} when ${row.name}`, async () => {
      const source = await rustSource();
      const work = await tmpDir("authoring-scope-work-");
      await import("node:fs/promises").then((fs) => fs.cp(source, work, { recursive: true }));
      await row.edit(work);
      const refusal = await checkTurnScope(source, work, TrialStack.Rust, RUST_EDITABLE);
      assert.equal(refusal?.code, row.code, JSON.stringify(refusal));
    });
  }

  it("accepts an edit inside the editable folder", async () => {
    const source = await rustSource();
    const work = await tmpDir("authoring-scope-work-");
    await import("node:fs/promises").then((fs) => fs.cp(source, work, { recursive: true }));
    await writeFile(pondFile(work, "src", "pond.rs"), "pub fn bite() { let _ = 1; }\n");
    await writeFile(pondFile(work, "src", "shop.rs"), "pub fn buy() {}\n");
    assert.equal(await checkTurnScope(source, work, TrialStack.Rust, RUST_EDITABLE), null);
  });

  it("a refused turn ends the attempt before any configure, build or web command runs", async () => {
    const source = await rustSource();
    const out = await tmpDir("authoring-scope-out-");
    const ran: CommandSpec[] = [];
    const parts: LiveParts = {
      ctx: {
        out,
        asks: await loadAsks(DEFAULT_ASKS_FILE),
        profile: "trial",
        model: "m",
        games: { [TrialStack.Rust]: source },
        attemptCap: 1,
      },
      turn: async (cwd) => {
        await mkdir(path.join(cwd, ".cargo"));
        await writeFile(path.join(cwd, ".cargo", "config.toml"), "[target.x]\nrunner = '/tmp/r'\n");
      },
      run: async (spec) => {
        ran.push(spec);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      probeDeps: {
        probe: async () => ProbeOutcome.Pass,
        serve: async () => ({ url: "http://127.0.0.1:1/", close: async () => {} }),
      },
    };
    const asks = parts.ctx.asks.asks;
    const ask = asks[0];
    assert.ok(ask);
    const transcript = await liveAttempt(parts, TrialStack.Rust, ask);
    assert.deepEqual(ran, [], "nothing was built");
    assert.equal(transcript.scopeRefusal?.code, TurnScopeCode.CargoConfig);
    assert.equal(transcript.turns.length, 1);
    const scored = scoreAttempt(transcript, parts.ctx.asks.maxRepairTurns);
    assert.equal(scored.succeeded, false);
    assert.equal((await lstat(source)).isDirectory(), true, "the source copy is untouched");
  });
});

describe("the live trial's coding CLI environment", () => {
  it("drops every credential variable, the SSH agent and CLAUDE_CONFIG_DIR, and turns the updater off", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/operator",
      LANG: "en_US.UTF-8",
      GITHUB_TOKEN: "ghp_x",
      GH_TOKEN: "gho_x",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oa",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      CLAUDE_CONFIG_DIR: "/Users/operator/.claude-work",
      [TRIAL_AUTHORIZATION_VAR]: "6",
    };
    const env = trialChildEnv(parent, strippedEnv, null);
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "SSH_AUTH_SOCK",
      "CLAUDE_CONFIG_DIR",
      TRIAL_AUTHORIZATION_VAR,
    ]) {
      assert.equal(env[name], undefined, name);
    }
    assert.equal(env.PATH, parent.PATH);
    assert.equal(env.HOME, parent.HOME, "a retained live profile shares the operator's account");
    assert.equal(env.DISABLE_AUTOUPDATER, "1");
  });

  it("gives a fresh-machine profile its own HOME", () => {
    const env = trialChildEnv({ PATH: "/usr/bin", HOME: "/Users/operator" }, strippedEnv, "/tmp/genex-fresh/abc");
    assert.equal(env.HOME, "/tmp/genex-fresh/abc");
  });
});

describe("the live trial refuses before a paid turn it could not use", () => {
  it("a failed configure ends the attempt before any agent turn", async () => {
    const source = await rustSource();
    const out = await tmpDir("authoring-configure-out-");
    const turns: string[] = [];
    const ran: CommandSpec[] = [];
    const parts: LiveParts = {
      ctx: {
        out,
        asks: await loadAsks(DEFAULT_ASKS_FILE),
        profile: "trial",
        model: "m",
        games: { [TrialStack.Raylib]: source },
        attemptCap: 1,
      },
      turn: async (cwd) => {
        turns.push(cwd);
      },
      run: async (spec) => {
        ran.push(spec);
        return { stdout: "", stderr: "CMake Error: could not find the compiler\n", exitCode: 1 };
      },
      probeDeps: {
        probe: async () => ProbeOutcome.Pass,
        serve: async () => ({ url: "http://127.0.0.1:1/", close: async () => {} }),
      },
    };
    const configure = parts.ctx.asks.stacks[TrialStack.Raylib].configure;
    assert.ok(configure, "the baseline configures before it builds");
    const ask = parts.ctx.asks.asks[0];
    assert.ok(ask);
    await assert.rejects(liveAttempt(parts, TrialStack.Raylib, ask), /configure.*exit 1.*could not find the compiler/s);
    assert.deepEqual(turns, [], "no paid turn was spent on a build that cannot configure");
    assert.deepEqual(ran, [configure], "nothing but the configure ran");
  });

  it("the prober's lock is the evals home's when one is set, else the run's own (never a crash after a paid turn)", async () => {
    const out = await tmpDir("authoring-lock-out-");
    assert.equal(path.dirname(trialProbeLockPath({}, out)).startsWith(out), true);
    const home = await tmpDir("authoring-evals-home-");
    assert.equal(trialProbeLockPath({ GENEX_EVALS_HOME: home }, out), probeLockPath({ GENEX_EVALS_HOME: home }));
    assert.throws(() => trialProbeLockPath({ GENEX_EVALS_HOME: "relative/home" }, out));
  });

  it("an agent turn's CLI reads no stdin: the turn ends without waiting for input", async () => {
    const dir = await tmpDir("authoring-cli-");
    const cli = path.join(dir, "fake-claude");
    // A CLI that, like Claude Code with a piped stdin, reads it to the end before answering.
    await writeFile(cli, '#!/bin/sh\ncat > /dev/null\necho \'{"type":"result"}\'\n', { mode: 0o755 });
    const log = path.join(dir, "turn.jsonl");
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<"waited">((resolve) => {
      timer = setTimeout(() => resolve("waited"), STDIN_WAIT_LIMIT_MS);
    });
    const turn = agentTurn(cli, { PATH: "/usr/bin:/bin" }, "m", [dir, "ask", false, log]).then(() => "done" as const);
    const finished = await Promise.race([turn, waited]);
    clearTimeout(timer);
    assert.equal(finished, "done", "the CLI was left waiting on an open stdin");
    assert.match(await readFile(log, "utf8"), /"result"/);
  });
});
