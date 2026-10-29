/**
 * `character.verify` (Track A): the agent hands Studio the engine's character-check report, and
 * Studio answers with the next step while it keeps the character's ledger itself (repair calls made,
 * credits those jobs were quoted at, a rig already re-imported), so the caps hold however the agent
 * behaves. A passing report passes; a report that cannot be read, or lies outside the game, is refused.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { verifyCharacter } from "../../src/plugins/genex/character-verify.ts";
import {
  CharacterCheckCause,
  CharacterCheckCode,
  type CharacterCheckDiagnostic,
  type CharacterCheckReport,
  ClipRole,
} from "../../src/shared/character-check.ts";
import { LoopStatus, LoopStop } from "../../src/shared/character-loop.ts";
import type { GenexJob } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROLES = Object.fromEntries(Object.values(ClipRole).map((role) => [role, role])) as Record<
  ClipRole,
  string | null
>;

const missingReload: CharacterCheckReport = {
  file: "assets/hero.glb",
  profile: "meshy",
  mapped: {},
  missingBones: [],
  roles: { ...ROLES, reload: null },
  diagnostics: [
    {
      code: CharacterCheckCode.ClipRoleMissing,
      cause: CharacterCheckCause.BadRig,
      clip: "",
      role: ClipRole.Reload,
      time: 0,
      bone: null,
      value: null,
      limit: 0,
    },
  ],
  pass: false,
};
const passing: CharacterCheckReport = { ...missingReload, roles: ROLES, diagnostics: [], pass: true };

async function setup() {
  const root = await tmpDir("character-verify-root-");
  const workspace = await tmpDir("character-verify-ws-");
  await mkdir(path.join(root, "report"), { recursive: true });
  const put = async (name: string, value: unknown) => {
    await writeFile(path.join(root, "report", name), typeof value === "string" ? value : JSON.stringify(value));
    return `report/${name}`;
  };
  let clock = Date.parse("2026-10-30T00:00:00Z");
  const now = () => new Date((clock += 1000));
  const ask = (report: string, jobs: GenexJob[] = [], options: Record<string, string> = {}) =>
    verifyCharacter({
      workspace,
      root,
      jobs,
      now,
      request: {
        operation: "character.verify",
        id: "gen-1",
        prompt: report,
        options: { "character-prompt": "a soldier", ...options },
      },
    });
  const spent = (credits: number, operation = "character.animate"): GenexJob => ({
    id: `job-${clock}-${credits}`,
    project: "p",
    operation,
    status: "downloaded",
    files: [],
    creditsQuoted: credits,
    createdAt: new Date((clock += 1000)).toISOString(),
  });
  return { put, ask, spent };
}

describe("character.verify", () => {
  it("passes a passing report and spends nothing", async () => {
    const { put, ask } = await setup();
    const answer = await ask(await put("ok.json", passing));
    assert.equal(answer.status, LoopStatus.Pass);
    assert.deepEqual(answer.ledger, { attempts: 0, credits: 0 });
  });

  it("names the repairing call for a missing role and counts it as an attempt", async () => {
    const { put, ask } = await setup();
    const answer = await ask(await put("r.json", missingReload));
    assert.equal(answer.status, LoopStatus.Act);
    assert.equal(answer.call?.operation, "character.animate");
    assert.equal(answer.call?.id, "gen-1");
    assert.equal(answer.ledger.attempts, 1);
  });

  it("stops after the attempt cap, however often it is asked, and says what still fails", async () => {
    const { put, ask } = await setup();
    const file = await put("r.json", missingReload);
    await ask(file);
    await ask(file);
    await ask(file);
    const fourth = await ask(file);
    assert.equal(fourth.status, LoopStatus.Stop);
    assert.equal(fourth.reason, LoopStop.Attempts);
    assert.match(fourth.summary ?? "", /clip-role-missing/);
    assert.equal(fourth.ledger.attempts, 3, "a stop is not an attempt");
  });

  it("counts the credits the repair jobs were quoted at and stops at the credit cap", async () => {
    const { put, ask, spent } = await setup();
    const file = await put("r.json", missingReload);
    await ask(file);
    const first = spent(60);
    const second = await ask(file, [first]);
    assert.equal(second.status, LoopStatus.Act);
    assert.equal(second.ledger.credits, 60);
    const next = spent(55);
    const third = await ask(file, [first, next]);
    assert.equal(third.status, LoopStatus.Stop);
    assert.equal(third.reason, LoopStop.Credits);
    assert.equal(third.ledger.credits, 115);
  });

  it("does not count a job that is not a repair call", async () => {
    const { put, ask, spent } = await setup();
    const file = await put("r.json", missingReload);
    await ask(file);
    const answer = await ask(file, [spent(500, "image")]);
    assert.equal(answer.ledger.credits, 0);
  });

  it("re-imports a bad rig once, then regenerates", async () => {
    const { put, ask } = await setup();
    const bad: CharacterCheckReport = {
      ...missingReload,
      diagnostics: [
        {
          ...(missingReload.diagnostics[0] as CharacterCheckDiagnostic),
          code: CharacterCheckCode.BoneMissing,
          role: null,
          bone: "LeftHand",
        },
      ],
    };
    const file = await put("bad.json", bad);
    const first = await ask(file, [], { model: "assets/hero.glb" });
    assert.equal(first.call?.operation, "character.import");
    const second = await ask(file, [], { model: "assets/hero.glb" });
    assert.equal(second.call?.operation, "character");
    assert.deepEqual(second.call?.options, { "direct-text": true, pose: "a-pose" });
  });

  it("refuses a report that is not JSON, not a report, or outside the game", async () => {
    const { put, ask } = await setup();
    await assert.rejects(ask(await put("text.json", "not json")), /report/i);
    await assert.rejects(ask(await put("shape.json", { pass: "yes" })), /report/i);
    await assert.rejects(ask("../../etc/passwd"), /game|report/i);
  });
});
