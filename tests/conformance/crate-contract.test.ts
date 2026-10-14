/**
 * The crate request contract (extension ladder level 4, `shared/crate-requests.ts` and
 * `crates.request` in `shared/harness-api.ts`): an agent's request names one crate at one exact
 * version, and its name and version are later joined into registry and overlay paths, so the
 * params check refuses every other shape before a handler runs. The refusal codes keep their wire
 * spellings.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CrateAuditSource,
  CrateAuditStatus,
  CrateCheckEngine,
  CrateDecision,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
  crateCheckReportOf,
} from "../../src/shared/crate-requests.ts";
import { HostMethod, harnessParamsProblem } from "../../src/shared/harness-api.ts";

const request = (fields: Record<string, unknown>) => ({
  project: "ferris",
  name: "rand_pcg",
  version: "0.3.1",
  ...fields,
});

describe("crates.request params (M3.0)", () => {
  it("accepts one crate at one exact version, with an optional reason", () => {
    for (const params of [
      request({}),
      request({ name: "serde-json", version: "1.0.140", reason: "parse the level files" }),
      request({ version: "0.10.0-beta.1" }),
      request({ version: "1.2.3+build.5", reason: null }),
      request({ name: `a${"b".repeat(63)}` }),
    ])
      assert.equal(harnessParamsProblem(HostMethod.CratesRequest, params), null, JSON.stringify(params));
  });

  it("refuses every other name, version, reason or game before a handler runs", () => {
    const rows: Array<[string, unknown, string]> = [
      ["a path for a name", request({ name: "../../etc" }), "name"],
      ["a name read as an option", request({ name: "-Zunstable" }), "name"],
      ["a name starting with a digit", request({ name: "7zip" }), "name"],
      ["a name with a space", request({ name: "rand pcg" }), "name"],
      ["a 65-character name", request({ name: `a${"b".repeat(64)}` }), "name"],
      ["a name that is not text", request({ name: ["rand"] }), "name"],
      ["a version range", request({ version: "^0.3" }), "version"],
      ["a wildcard version", request({ version: "*" }), "version"],
      ["a version with a leading zero", request({ version: "01.0.0" }), "version"],
      ["a version with a path", request({ version: "0.3.1/../../x" }), "version"],
      ["a version with a newline", request({ version: "0.3.1\n" }), "version"],
      ["an overlong version", request({ version: `1.0.0-${"a".repeat(60)}` }), "version"],
      ["an overlong reason", request({ reason: "r".repeat(501) }), "reason"],
      ["no game", { name: "rand_pcg", version: "0.3.1" }, "project"],
      ["no params", undefined, "params"],
    ];
    for (const [label, params, field] of rows) {
      const problem = harnessParamsProblem(HostMethod.CratesRequest, params);
      assert.ok(problem, label);
      assert.ok(
        problem.issues.some((issue) => issue.path === field),
        `${label}: ${JSON.stringify(problem.issues)} names ${field}`,
      );
    }
  });
});

describe("crate request vocabularies keep their wire spellings", () => {
  it("names every refusal the plan lists, and the person's two answers", () => {
    assert.deepEqual(Object.values(CrateRefusal), [
      "crate-declined",
      "crate-not-found",
      "crate-yanked",
      "crate-advisory",
      "crate-licence",
      "crate-unvetted",
      "crate-build-script",
      "crate-proc-macro",
      "crate-duplicate-version",
      "crate-overlay-tampered",
      "crate-engine-internal",
      "crate-banned",
      "crate-policy-tampered",
      "crate-checker-unavailable",
      "crate-check-failed",
    ]);
    assert.deepEqual(Object.values(CrateDecision), ["approve", "decline"]);
    assert.deepEqual(Object.values(CrateRequestState), ["pending", "approved", "vendored", "refused"]);
  });

  it("names the engines, the five trusted sources, their answers and the two notices", () => {
    assert.deepEqual(Object.values(CrateCheckEngine), ["cargo-deny", "cargo-vet", "builtin"]);
    assert.deepEqual(Object.values(CrateAuditSource), [
      "bytecode-alliance",
      "embark-studios",
      "google",
      "mozilla",
      "zcash",
    ]);
    assert.deepEqual(Object.values(CrateAuditStatus), ["audited", "not-audited", "unavailable"]);
    assert.deepEqual(Object.values(CrateNotice), ["crate-unaudited", "crate-no-audit-lists"]);
  });
});

describe("a check report read back from a ledger or an event", () => {
  const report = {
    engine: "cargo-deny",
    engineVersion: "0.20.2",
    auditEngine: null,
    auditEngineVersion: null,
    advisoryDb: "550efd3d587a29b2e2c2b21b17a440da4fede999",
    advisoryDbDate: "2026-10-08",
    advisories: ["RUSTSEC-2021-0003"],
    blocked: [{ refusal: "crate-advisory", name: "smallvec", version: "1.6.0", detail: "RUSTSEC-2021-0003" }],
    licenceAllowed: true,
    audits: [{ source: "mozilla", status: "unavailable" }],
    notice: null,
  };

  it("reads a report the host wrote", () => {
    assert.deepEqual(crateCheckReportOf(report), report);
    assert.deepEqual(crateCheckReportOf({ ...report, notice: "crate-unaudited", auditEngine: "cargo-vet" }), {
      ...report,
      notice: "crate-unaudited",
      auditEngine: "cargo-vet",
    });
  });

  it("reads an older ledger's report, with no snapshot day and no blocked crates, as unknown and none", () => {
    const { advisoryDbDate: _day, blocked: _blocked, ...older } = report;
    assert.deepEqual(crateCheckReportOf(older), { ...older, advisoryDbDate: null, blocked: [] });
  });

  it("refuses every field that is not the host's", () => {
    const rows: Array<[string, unknown]> = [
      ["nothing", null],
      ["a list", [report]],
      ["an unknown engine", { ...report, engine: "cargo-audit" }],
      ["an unknown audit engine", { ...report, auditEngine: "eyeballs" }],
      ["a numeric version", { ...report, engineVersion: 20 }],
      ["advisories that are not text", { ...report, advisories: [1] }],
      ["far too many advisories", { ...report, advisories: Array.from({ length: 65 }, (_, at) => `RUSTSEC-${at}`) }],
      ["a licence verdict that is not a boolean", { ...report, licenceAllowed: "yes" }],
      ["an audit row from an untrusted source", { ...report, audits: [{ source: "someone", status: "audited" }] }],
      ["an audit row with an unknown status", { ...report, audits: [{ source: "mozilla", status: "vibes" }] }],
      ["an unknown notice", { ...report, notice: "crate-fine" }],
      ["a snapshot day that is not text", { ...report, advisoryDbDate: 20261008 }],
      ["blocked crates that are not a list", { ...report, blocked: "smallvec" }],
      [
        "a block for a refusal no check gives",
        { ...report, blocked: [{ ...report.blocked[0], refusal: "crate-declined" }] },
      ],
      ["a block with no version", { ...report, blocked: [{ ...report.blocked[0], version: undefined }] }],
      ["far too many blocks", { ...report, blocked: Array.from({ length: 65 }, () => report.blocked[0]) }],
      ["no audits field", { ...report, audits: undefined }],
    ];
    for (const [label, value] of rows) assert.equal(crateCheckReportOf(value), null, label);
  });
});
