/**
 * The field row an opted-in user's finished build becomes (§9.4, M5.3): the builder copies only
 * the closed schema's fields, and the guard refuses anything that is not a code, a pattern or a
 * bounded number. The app keeps its own copy of the contribution route's constants (it never
 * imports `scripts/`); this suite holds the two equal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRIBUTION_MAX_BYTES,
  CONTRIBUTIONS_PATH,
  CONTRIBUTIONS_PAUSED_STATUS,
  ContributionKind,
  DEFAULT_RUNS_ORIGIN,
  FIELD_ROW_SCHEMA,
  FieldPlatform,
  type FieldRow,
  type FieldRunFacts,
  type FieldRowStamp,
  INSTALL_SECRET_HEADER,
  INSTALL_SECRET_PATTERN,
  RUN_SHARING_ASK,
  RUN_SHARING_CONSENT_VERSION,
  RUNS_ORIGIN_ENV,
  RunSharingAsk,
  buildFieldRow,
  checkFieldRow,
  contributionDeletePath,
  fieldPlatform,
} from "../../src/shared/run-sharing.ts";
import {
  CONTRIBUTION_MAX_BYTES as CONTRACT_MAX_BYTES,
  DEFAULT_RUNS_ORIGIN as CONTRACT_ORIGIN,
  DesktopEvalRoute,
  DesktopEvalStatus,
  INSTALL_SECRET_HEADER as CONTRACT_SECRET_HEADER,
  INSTALL_SECRET_PATTERN as CONTRACT_SECRET_PATTERN,
  RUNS_ORIGIN_ENV as CONTRACT_ORIGIN_ENV,
  contributionPath,
} from "../../scripts/evals/remote/contract.ts";
import { INSTANT_PATTERN, MODEL_ID_PATTERN, VERSION_PATTERN } from "../../scripts/evals/ledger/types.ts";
import { FIELD_INSTANT_PATTERN, FIELD_MODEL_PATTERN, FIELD_VERSION_PATTERN } from "../../src/shared/run-sharing.ts";
import { EndedHow, LaneModeServed, LaunchPath, TokenRole, ToolCategory } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { ExecutionStatus } from "../../src/shared/run-state.ts";

const INSTALL_ID = "0123456789abcdef0123456789abcdef";

function stamp(): FieldRowStamp {
  return {
    installId: INSTALL_ID,
    consentVersion: RUN_SHARING_CONSENT_VERSION,
    recordedAt: "2026-10-01T12:00:00.000Z",
    app: { version: "0.1.0-rc.1", platform: FieldPlatform.Mac },
  };
}

function usage(output: number) {
  return { uncachedInput: 10, cacheWrite: 2, cacheRead: 100, output, reasoning: 0 };
}

function facts(): FieldRunFacts {
  return {
    engine: EngineId.ClaudeCode,
    model: "claude-opus-5-5",
    modeServed: LaneModeServed.ChatOnly,
    launch: LaunchPath.None,
    permissionMode: PermissionMode.Auto,
    endedHow: EndedHow.AgentFinished,
    buildOk: true,
    time: { wallMs: 90_000, firstBootMs: 1_200, firstPreviewMs: 40_000, delegationP50Ms: 60_000, builds: 1 },
    tokens: usage(30),
    tokensByRole: { [TokenRole.Lead]: usage(10), [TokenRole.Workers]: usage(20) },
    context: { leadPeakPct: 42, compactions: 0 },
    calls: { modelCalls: 3, tools: { total: 4, byCategory: { [ToolCategory.Edit]: 2 } } },
    inApp: { victory: null, executionStatus: null, stopCode: null, livenessMax: null, scoreboard: null },
  };
}

function built(): FieldRow {
  const result = buildFieldRow(facts(), stamp());
  assert.ok(result.ok, "the sample facts build a row");
  return result.row;
}

/** A deep copy with one field replaced, by dotted path. */
function withField(row: FieldRow, dotted: string, value: unknown): unknown {
  const copy = structuredClone(row) as unknown as Record<string, unknown>;
  const keys = dotted.split(".");
  let at: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys.at(-1) as string] = value;
  return copy;
}

describe("the field row", () => {
  it("keeps the switch at Never and stamps the consent version and schema on every row", () => {
    assert.equal(RUN_SHARING_ASK, RunSharingAsk.Never);
    const row = built();
    assert.equal(row.schema, FIELD_ROW_SCHEMA);
    assert.equal(row.kind, ContributionKind.Field);
    assert.equal(row.consentVersion, RUN_SHARING_CONSENT_VERSION);
    assert.equal(row.installId, INSTALL_ID);
  });

  it("copies only the closed schema's fields, dropping anything else the facts carry", () => {
    const extra = {
      ...facts(),
      prompt: "make a platformer",
      time: { ...facts().time, projectDir: "/Users/studio/AI Games/demo" },
      inApp: { ...facts().inApp, summary: "the run went well" },
    } as FieldRunFacts;
    const result = buildFieldRow(extra, stamp());
    assert.ok(result.ok);
    const text = JSON.stringify(result.row);
    for (const leaked of ["platformer", "/Users/", "went well", "projectDir", "summary", "prompt"])
      assert.equal(text.includes(leaked), false, `${leaked} is not copied`);
  });

  it("is small enough for the contribution route", () => {
    assert.ok(new TextEncoder().encode(JSON.stringify(built())).length <= CONTRIBUTION_MAX_BYTES);
  });

  it("accepts a finished run's in-app signals", () => {
    const run = {
      ...facts(),
      launch: LaunchPath.StartAutopilot,
      modeServed: LaneModeServed.AutopilotTimed,
      inApp: {
        victory: true,
        executionStatus: ExecutionStatus.Completed,
        stopCode: "goal-met",
        livenessMax: 7,
        scoreboard: { passing: 5, total: 6, regressions: 0 },
      },
    };
    assert.equal(buildFieldRow(run, stamp()).ok, true);
  });

  it("names the platform only for the three it knows", () => {
    assert.equal(fieldPlatform("darwin"), FieldPlatform.Mac);
    assert.equal(fieldPlatform("win32"), FieldPlatform.Windows);
    assert.equal(fieldPlatform("linux"), FieldPlatform.Linux);
    assert.equal(fieldPlatform("freebsd"), null);
  });
});

describe("the closed-schema guard (hostile input)", () => {
  const cases: ReadonlyArray<[string, string, unknown]> = [
    ["a path in the model", "model", "/Users/studio/models/opus"],
    ["an email in the model", "model", "someone@example.com"],
    ["free text in the model", "model", "Claude Opus, the big one"],
    ["an unknown engine", "engine", "gpt-cli"],
    ["an unknown ending", "endedHow", "timed out politely"],
    ["an unknown launch", "launch", "start_everything"],
    ["an unknown permission mode", "permissionMode", "yolo"],
    ["an unknown mode", "modeServed", "night"],
    ["a wrong schema", "schema", "genex-evals/field/2"],
    ["a wrong kind", "kind", ContributionKind.CommunityEval],
    ["a short install id", "installId", "abc"],
    ["an account id as install id", "installId", "user_2abcdefGHIJKLmnopqrstuvwxyz12"],
    ["a consent text instead of a version", "consentVersion", "I agree"],
    ["a local time", "recordedAt", "2026-10-01 12:00"],
    ["a release string as platform", "app.platform", "darwin-25.6.0"],
    ["a branch name as version", "app.version", "main"],
    ["a negative duration", "time.wallMs", -1],
    ["an infinite duration", "time.wallMs", Number.POSITIVE_INFINITY],
    ["a duration as text", "time.firstPreviewMs", "40s"],
    ["a fractional build count", "time.builds", 1.5],
    ["a negative token count", "tokens.output", -5],
    ["tokens as text", "tokens.cacheRead", "100"],
    ["an unknown token role", "tokensByRole", { lead: usage(1), narrator: usage(1) }],
    ["an extra token field", "tokens", { ...usage(1), costUsd: 3 }],
    ["a context over 100%", "context.leadPeakPct", 250],
    ["an unknown tool category", "calls.tools.byCategory", { edit: 1, "rm -rf": 1 }],
    ["a prompt in the stop code", "inApp.stopCode", "The user said: make it pink"],
    ["an unknown execution status", "inApp.executionStatus", "exploded"],
    ["a scoreboard with names", "inApp.scoreboard", { passing: 1, total: 2, regressions: ["jump"] }],
    ["a buildOk as text", "buildOk", "yes"],
    ["an added summary", "inApp", { ...facts().inApp, summary: "went well" }],
  ];
  for (const [name, field, value] of cases) {
    it(`refuses ${name}`, () => {
      const hostile = withField(built(), field, value);
      const result = checkFieldRow(hostile);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.field.startsWith(field.split(".")[0] as string), `${name}: ${result.field}`);
    });
  }

  it("refuses an extra top-level field, a non-object and an oversized row", () => {
    assert.equal(checkFieldRow({ ...built(), projectName: "Space Frogs" }).ok, false);
    assert.equal(checkFieldRow(null).ok, false);
    assert.equal(checkFieldRow("row").ok, false);
    assert.equal(checkFieldRow([built()]).ok, false);
    const many = Object.fromEntries(Object.values(ToolCategory).map((c) => [c, 1]));
    assert.equal(checkFieldRow(withField(built(), "calls.tools.byCategory", many)).ok, true);
  });

  it("refuses a row the builder would build from hostile facts, without throwing", () => {
    const hostile = { ...facts(), model: "../../etc/passwd" };
    assert.equal(buildFieldRow(hostile, stamp()).ok, false);
    assert.equal(buildFieldRow(facts(), { ...stamp(), installId: "not-an-id" }).ok, false);
  });
});

describe("the app's copy of the contribution contract", () => {
  it("matches scripts/evals/remote/contract.ts value for value", () => {
    assert.equal(CONTRIBUTIONS_PATH, DesktopEvalRoute.Contributions);
    assert.equal(contributionDeletePath(INSTALL_ID), contributionPath(INSTALL_ID));
    assert.equal(contributionDeletePath("a/b?c"), contributionPath("a/b?c"));
    assert.equal(CONTRIBUTIONS_PAUSED_STATUS, DesktopEvalStatus.Gone);
    assert.equal(INSTALL_SECRET_HEADER, CONTRACT_SECRET_HEADER);
    assert.equal(INSTALL_SECRET_PATTERN.source, CONTRACT_SECRET_PATTERN.source);
    assert.equal(CONTRIBUTION_MAX_BYTES, CONTRACT_MAX_BYTES);
    assert.equal(DEFAULT_RUNS_ORIGIN, CONTRACT_ORIGIN);
    assert.equal(RUNS_ORIGIN_ENV, CONTRACT_ORIGIN_ENV);
  });

  it("uses the ledger's model, version and instant patterns", () => {
    assert.equal(FIELD_MODEL_PATTERN.source, MODEL_ID_PATTERN.source);
    assert.equal(FIELD_VERSION_PATTERN.source, VERSION_PATTERN.source);
    assert.equal(FIELD_INSTANT_PATTERN.source, INSTANT_PATTERN.source);
  });
});
