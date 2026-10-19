/**
 * The packaged first start's verdict (tests/e2e/sandbox-start-report.mjs): the start steps read
 * from the app's stderr, its report, and the budget from launch to the first sandboxed command.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  START_FAILED,
  sandboxStartReport,
  sandboxStartSummary,
  sandboxStartVerdict,
  sandboxStep,
} from "../e2e/sandbox-start-report.mjs";

const BUDGET_MS = 60_000;

describe("packaged first start report", () => {
  it("reads each start step the app logs, srt-win's own and a failed start among them", () => {
    const lines: Array<[string, unknown]> = [
      ["[harness] [sandbox] srt-win acl stamp: 9951 ms", { step: "srt-win acl stamp", ms: 9951 }],
      ["[harness] [sandbox] initialize: 38153 ms\r", { step: "initialize", ms: 38153 }],
      ["[harness] [sandbox] started in the background in 43402 ms", { step: "started in the background", ms: 43402 }],
      [
        "[harness] [sandbox] background start failed: srt-win acl stamp timed out after 60000ms",
        { step: START_FAILED, error: "srt-win acl stamp timed out after 60000ms" },
      ],
      ["[harness] [core] seed upgrade baseline: 12 ms", null],
      ["[smoke] PASS the harness reaches ready in this build: state=ready", null],
    ];
    for (const [line, step] of lines) assert.deepEqual(sandboxStep(line), step, line);
  });

  it("finds the report between its markers, and none when the app printed none", () => {
    const report = { ok: true, firstCommandMs: 1200, commandMs: 900, code: 0, sandboxed: true };
    assert.deepEqual(sandboxStartReport(`noise\n__SANDBOX_START_JSON__${JSON.stringify(report)}__END__\n`), report);
    assert.equal(sandboxStartReport("[main] startup failed\n"), null);
  });

  it("passes a sandboxed command within the budget and fails every other ending, naming why", () => {
    const passed = { ok: true, firstCommandMs: 41_000, commandMs: 39_000, code: 0, sandboxed: true };
    const cases: Array<[string, unknown, boolean, RegExp]> = [
      ["within the budget", passed, true, /41000 ms after launch, within the 60000 ms budget/],
      ["exactly the budget", { ...passed, firstCommandMs: BUDGET_MS }, true, /within/],
      [
        "over the budget",
        { ...passed, firstCommandMs: 61_000 },
        false,
        /61000 ms after launch, over the 60000 ms budget/,
      ],
      [
        "a start that failed",
        {
          ok: false,
          firstCommandMs: 64_000,
          commandMs: 63_000,
          code: null,
          sandboxed: false,
          error: "acl stamp timed out",
        },
        false,
        /failed 64000 ms after launch: acl stamp timed out/,
      ],
      ["no report", null, false, /never ended/],
    ];
    for (const [name, report, ok, reason] of cases) {
      const verdict = sandboxStartVerdict(report, BUDGET_MS);
      assert.equal(verdict.ok, ok, name);
      assert.match(verdict.reason, reason, name);
    }
  });

  it("summarizes the steps as one table row each, keeping an error on its own row", () => {
    const summary = sandboxStartSummary({ ok: false, reason: "over | the\nbudget" }, [
      { at: 3_000, step: "srt-win wfp verify", ms: 64 },
      { at: 64_000, step: START_FAILED, error: "timed out\nafter 60000ms | srt-win" },
    ]);
    const rows = summary.split("\n").filter((line) => line.startsWith("| ") && line.endsWith(" |"));
    assert.equal(rows.length, 3);
    assert.match(summary, /❌ over \\\| the budget/);
    assert.match(summary, /\| 64000 ms \| background start failed \| timed out after 60000ms \\\| srt-win \|/);
    assert.match(sandboxStartSummary({ ok: true, reason: "fine" }, []), /No start steps logged\./);
  });
});
