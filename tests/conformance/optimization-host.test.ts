import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startRig } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";

it("host candidate authority routes direct and delegated writes away from live, and freezes both", async () => {
  const rig = await startRig();
  try {
    const api = rig.core.api() as unknown as Record<string, (p: any) => Promise<any>>;
    await api["game.scaffold"]!({ name: "candidate-game", title: "Candidate game", kind: "web" });
    const snapshot = await api["snapshot.create"]!({
      scope: "game",
      project: "candidate-game",
      reason: "verified B",
      healthy: true,
    });
    const candidate = await api["optimization.open"]!({
      project: "candidate-game",
      runId: "run_host",
      baselineSnapshotId: snapshot.snapshot_id,
    });
    const live = rig.core.games.dirFor("candidate-game");
    const baseline = await readFile(path.join(live, "src/main.js"), "utf8");
    await api["game.write"]!({
      project: "candidate-game",
      candidateId: candidate.candidateId,
      file: "src/main.js",
      contents: baseline + "\n// candidate only\n",
    });
    assert.equal(await readFile(path.join(live, "src/main.js"), "utf8"), baseline);
    await assert.rejects(
      api["game.write"]!({
        project: "candidate-game",
        candidateId: candidate.candidateId,
        file: "../escape.js",
        contents: "bad",
      }),
      /escapes/,
    );
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "candidate-engine",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        requests.push(request);
        return { ok: true, summary: "done", usage: {}, turns: 1, engine: "candidate-engine" };
      },
    });
    await api["engine.delegate"]!({
      engine: "candidate-engine",
      project: "candidate-game",
      candidateId: candidate.candidateId,
      cwd: live,
      prompt: "candidate",
      timeoutMs: 1000,
    });
    assert.equal(requests[0]!.cwd, candidate.root, "a supplied live cwd cannot override candidate authority");
    assert.ok(requests[0]!.optimization?.denyWrites.includes(live));
    assert.ok(requests[0]!.optimization?.denyWrites.includes(path.join(candidate.root, ".git")));
    assert.ok(requests[0]!.optimization?.denyWrites.includes(rig.core.layout.runs));
    await assert.rejects(
      api["engine.delegate"]!({
        engine: "candidate-engine",
        project: "candidate-game",
        candidateId: candidate.candidateId,
        coordinator: { runId: "run_host" },
        threadId: "t",
        prompt: "mixed authority",
      }),
      /coordinator cannot edit/,
    );
    assert.equal(requests.length, 1, "mixed coordinator/candidate authority never reaches the provider");
    await api["optimization.freeze"]!({ candidateId: candidate.candidateId });
    await assert.rejects(
      api["engine.delegate"]!({
        engine: "candidate-engine",
        project: "candidate-game",
        candidateId: candidate.candidateId,
        prompt: "late",
      }),
      /frozen/,
    );
    await assert.rejects(
      api["game.write"]!({
        project: "candidate-game",
        candidateId: candidate.candidateId,
        file: "late.js",
        contents: "bad",
      }),
      /frozen/,
    );
    await api["optimization.close"]!({ candidateId: candidate.candidateId });
    assert.equal(await readFile(path.join(live, "src/main.js"), "utf8"), baseline);
  } finally {
    await rig.stop();
  }
});
