/**
 * scripts/check-vocabulary.ts: every raw vocabulary spelling the readability pass removed is
 * refused outside its home — engine ids, custom event names, engine status codes, seed host
 * calls, harness RPC handler keys and inline sleeps — and nothing else is: comments, text inside
 * strings, templates and regular expressions, type aliases, and the homes themselves.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  checkVocabulary,
  findRawVocabulary,
  maskSource,
  VocabularyRule,
  vocabularyFiles,
} from "../../scripts/check-vocabulary.ts";

const checker = path.resolve(import.meta.dirname, "../../scripts/check-vocabulary.ts");
const APP = "src/main/core/example.ts";
const SEED = "src/harness-seed/loop/example.ts";
const RPC = "src/main/harness-rpc/example.ts";

const rulesIn = (file: string, source: string) => findRawVocabulary(file, source).map((f) => f.rule);

/** Each shape the check refuses, in a file it reads. */
const CAUGHT: Array<{ name: string; file: string; source: string; rule: VocabularyRule }> = [
  {
    name: "a custom event named in a record",
    file: APP,
    source: 'append({ type: "custom", event_type: "run_finished", payload });',
    rule: VocabularyRule.EventType,
  },
  {
    name: "a custom event named in a template with a literal head",
    file: APP,
    source: "const d = { event_type: `delegated.${id}` };",
    rule: VocabularyRule.EventType,
  },
  {
    name: "a custom event named with single quotes",
    file: SEED,
    source: "await appendRun(ctx, { event_type: 'director_verdict' });",
    rule: VocabularyRule.EventType,
  },
  {
    name: "an engine id compared",
    file: APP,
    source: 'if (engine === "codex") start();',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id compared from the left",
    file: APP,
    source: 'if ("claude-code" !== engine) return;',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id as a default",
    file: SEED,
    source: 'const engine = run.engine ?? "ollama";',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id as an || default",
    file: APP,
    source: 'const engine = picked || "bonsai";',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id as an argument",
    file: APP,
    source: 'const auth = useSubscriptionAuth(engines, refresh, "claude-code");',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id as a later argument",
    file: APP,
    source: 'path.join(layout.engineHomes, "codex")',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id in an array",
    file: APP,
    source: 'const both = ["claude-code", "codex"] as const;',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id indexing a record",
    file: "src/renderer/panel.tsx",
    source: 'const view = views["claude-code"];',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id as a case",
    file: APP,
    source: 'switch (id) { case "ollama": return 1; }',
    rule: VocabularyRule.EngineId,
  },
  { name: "an engine id assigned", file: APP, source: 'let engine = "bonsai";', rule: VocabularyRule.EngineId },
  {
    name: "an engine id as a JSX attribute",
    file: "src/renderer/panel.tsx",
    source: '<ConnectButton id="codex" view={view} />',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id returned",
    file: APP,
    source: 'function pick() { return "codex"; }',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id returned by an arrow",
    file: APP,
    source: 'const pick = () => "ollama";',
    rule: VocabularyRule.EngineId,
  },
  {
    name: "an engine id in a template of its own",
    file: APP,
    source: "if (engine === `codex`) start();",
    rule: VocabularyRule.EngineId,
  },
  {
    name: "a status code compared",
    file: "src/renderer/ready.ts",
    source: 'const ready = engine.status.code === "ready";',
    rule: VocabularyRule.StatusCode,
  },
  {
    name: "a status code compared through optional chaining",
    file: APP,
    source: 'if (engine?.status?.code !== "needs_login") return;',
    rule: VocabularyRule.StatusCode,
  },
  {
    name: "a status code compared from the left",
    file: APP,
    source: 'if ("not_installed" === descriptor.status.code) offer();',
    rule: VocabularyRule.StatusCode,
  },
  {
    name: "a status code compared on a status() answer",
    file: APP,
    source: 'if ((await engine.status())?.code !== "ready") return null;',
    rule: VocabularyRule.StatusCode,
  },
  {
    name: "a host method called by its wire name",
    file: SEED,
    source: 'await ctx.call("run.exec", { cmd });',
    rule: VocabularyRule.HostCall,
  },
  {
    name: "a host method called on another receiver",
    file: SEED,
    source: "await run.ctx.call('events.list', {});",
    rule: VocabularyRule.HostCall,
  },
  {
    name: "an RPC handler keyed by a string",
    file: RPC,
    source: 'return {\n  "engine.delegate": async (p) => run(p),\n};',
    rule: VocabularyRule.RpcKey,
  },
  {
    name: "an RPC handler keyed by a computed string",
    file: RPC,
    source: 'const table = { ["events.list"]: list };',
    rule: VocabularyRule.RpcKey,
  },
  {
    name: "an RPC handler as a method",
    file: RPC,
    source: 'const table = { "turn.begin"(p) { return p; } };',
    rule: VocabularyRule.RpcKey,
  },
  {
    name: "an inline sleep",
    file: APP,
    source: "await new Promise((resolve) => setTimeout(resolve, 250));",
    rule: VocabularyRule.Sleep,
  },
  {
    name: "an inline sleep with a bare parameter",
    file: "scripts/tool.ts",
    source: "const delay = (ms: number) => new Promise(r => setTimeout(r, ms));",
    rule: VocabularyRule.Sleep,
  },
  {
    name: "a typed inline sleep in a block",
    file: SEED,
    source: "await new Promise<void>((done) => { setTimeout(done, 10); });",
    rule: VocabularyRule.Sleep,
  },
];

/** Code the check must leave alone: nothing here is a raw vocabulary spelling in use. */
const LEFT_ALONE: Array<{ name: string; file: string; source: string }> = [
  { name: "the vocabulary itself", file: APP, source: "if (engine === EngineId.Codex) start();" },
  { name: "a line comment", file: APP, source: '// engine === "codex" used to be written out' },
  { name: "a block comment", file: APP, source: '/* ctx.call("run.exec") and event_type: "x" */ const a = 1;' },
  { name: "text that mentions an id", file: APP, source: 'const hint = "run === \\"codex\\" here";' },
  {
    name: "page code held in a template",
    file: "src/main/smoke/run.ts",
    source: "await waitFor(`localStorage.getItem('roles')==='bonsai'`);",
  },
  { name: "a regular expression", file: APP, source: 'const re = /engine === "codex"/;' },
  { name: "a type alias", file: APP, source: 'export type CodingProvider = "codex" | "claude-code";' },
  { name: "an interface member", file: APP, source: 'interface Pick { provider: "codex" | "claude-code" }' },
  {
    name: "another vocabulary's value that shares a spelling",
    file: APP,
    source: 'childEnv(env, { base: "contractor", vendor: "codex" });',
  },
  {
    name: "a template built from the prefix",
    file: APP,
    source: "const d = { event_type: `${DELEGATED_PREFIX}${engineId}` };",
  },
  { name: "a longer id", file: APP, source: 'if (model === "codex-mini") pick();' },
  { name: "an error code", file: APP, source: 'if (err.code === "ENOENT") return null;' },
  { name: "a call with a variable method", file: SEED, source: "await ctx.call(HostMethod.RunExec, { cmd });" },
  { name: "Function.prototype.call", file: SEED, source: "fn.call(this, value);" },
  {
    name: "a handler keyed by the vocabulary",
    file: RPC,
    source: "return { [HostMethod.EngineDelegate]: async (p) => run(p) };",
  },
  { name: "a sleep from timers/promises", file: APP, source: "await sleep(250);" },
  { name: "a timeout that is not a sleep", file: APP, source: "const t = setTimeout(() => done(), 250);" },
  {
    name: "a division that is not a regular expression",
    file: APP,
    source: 'const half = total / 2; if (engine === EngineId.Codex) run("x" / 1);',
  },
];

describe("check-vocabulary", () => {
  for (const entry of CAUGHT) {
    it(`refuses ${entry.name}`, () => {
      assert.deepEqual(rulesIn(entry.file, entry.source), [entry.rule]);
    });
  }

  for (const entry of LEFT_ALONE) {
    it(`leaves ${entry.name} alone`, () => {
      assert.deepEqual(findRawVocabulary(entry.file, entry.source), []);
    });
  }

  it("lets each vocabulary's home spell it", () => {
    const homes: Array<[string, string]> = [
      ["src/shared/providers.ts", 'export const EngineId = { Codex: "codex" } as const; const d = x ?? "ollama";'],
      ["src/shared/provider-usage.ts", 'const CODEX_MAIN_LIMIT = "codex";'],
      ["src/harness-seed/loop/model-roles.ts", 'const engine = run.engine ?? "ollama";'],
      ["src/shared/custom-events.ts", 'const record = { event_type: "run_finished" };'],
      ["src/harness-seed/loop/run-events.ts", 'const record = { event_type: "run_started" };'],
      ["src/shared/engine-descriptor.ts", 'const ready = (e) => e.status.code === "ready";'],
      ["src/harness-seed/loop/host-methods.ts", 'ctx.call("events.list");'],
      ["src/harness-seed/loop/time.ts", "return new Promise((resolve) => setTimeout(resolve, ms));"],
    ];
    for (const [file, source] of homes) assert.deepEqual(findRawVocabulary(file, source), [], file);
  });

  it("reads the seed-only and RPC-only shapes only where they apply", () => {
    assert.deepEqual(findRawVocabulary("src/substrate/plugins/registry.ts", 'probe.call("ping", "", {});'), []);
    assert.deepEqual(findRawVocabulary(APP, 'const table = { "engine.delegate": run };'), []);
  });

  it("names the line of each finding and one finding per rule and line", () => {
    const source =
      'const a = 1;\nif (engine === "codex" || other === "ollama") go();\n\nsleep();\nctx.call("run.exec");';
    const findings = findRawVocabulary(SEED, source);
    assert.deepEqual(
      findings.map((f) => [f.line, f.rule, f.text]),
      [
        [2, VocabularyRule.EngineId, 'if (engine === "codex" || other === "ollama") go();'],
        [5, VocabularyRule.HostCall, 'ctx.call("run.exec");'],
      ],
    );
  });

  it("masks comments and quoted text without moving a line", () => {
    const source = 'a("x") // "codex"\n/* two\nlines */ b(`t ${c("y")} "z"`, /"q"/);';
    const masked = maskSource(source);
    assert.equal(masked.length, source.length);
    assert.equal(masked.split("\n").length, source.split("\n").length);
    assert.doesNotMatch(masked, /codex|two|lines/);
    assert.match(masked, /a\("x"\)/);
    assert.match(masked, /c\("y"\)/);
    assert.doesNotMatch(masked, /"z"|"q"/);
  });

  it("walks src and scripts, not tests, build output, declaration files or the game template", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocabulary-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const offender = 'if (engine === "codex") go();\n';
    const files: Record<string, string> = {
      "src/main/a.ts": offender,
      "src/renderer/b.tsx": "export const B = () => null;\n",
      "scripts/c.mjs": "await new Promise((r) => setTimeout(r, 5));\n",
      "src/game-template/src/main.js": offender,
      "src/harness-seed/types/host-api.d.ts": offender,
      "src/renderer/dist/bundle.js": offender,
      "tests/conformance/d.test.ts": offender,
      "src/shared/notes.md": offender,
    };
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    assert.deepEqual(vocabularyFiles(root), ["scripts/c.mjs", "src/main/a.ts", "src/renderer/b.tsx"]);
    const report = checkVocabulary(root);
    assert.equal(report.length, 2);
    assert.match(report[0] ?? "", /^scripts\/c\.mjs:1: raw sleep literal/);
    assert.match(report[1] ?? "", /^src\/main\/a\.ts:1: raw engine-id literal — write EngineId\./);

    const failing = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(failing.status, 1);
    assert.match(failing.stderr, /2 raw literal\(s\)/);

    fs.writeFileSync(path.join(root, "src/main/a.ts"), "if (engine === EngineId.Codex) go();\n");
    fs.writeFileSync(path.join(root, "scripts/c.mjs"), "await sleep(5);\n");
    const passing = spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /no raw literals in 3 files/);
  });
});
