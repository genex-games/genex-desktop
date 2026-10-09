/**
 * A failed shared base must never erase the user's own work.
 *
 * The base builder edits the live game folder. When it fails, the run rolls the folder back so
 * facets fork from something that runs — and that rollback used to be a raw
 * `git reset --hard HEAD && git clean -fd`, which also deleted whatever the user had not committed
 * yet (an adopted repository with edits in progress). The rollback now returns to a snapshot taken
 * just before the base builder started, so pre-run edits and untracked files survive.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { gitFile } from "../helpers/git.ts";
import { newestFixtureBuild, type FakeReply } from "../helpers/fake-ollama.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

const PLAN = {
  facets: [
    {
      id: "terrain",
      title: "Terrain",
      intent: "rolling hills",
      owns: ["src/terrain.js"],
      identity: ["hills read as hills"],
    },
    {
      id: "lighting",
      title: "Lighting",
      intent: "dusk light",
      owns: ["src/lighting.js"],
      identity: ["dusk reads as dusk"],
    },
  ],
  integrationNotes: "terrain exports hills; lighting reads them",
};

function respond(request: { messages: Array<{ role: string; content: string }> }): FakeReply | null {
  const text = request.messages.map((m) => m.content).join("\n");
  if (text.includes("ENGINE HINT: maxParallel")) return { text: JSON.stringify(PLAN) };
  // The base builder fails outright: a routine outcome for a local model.
  if (text.includes("BASE BUILDER")) return { httpStatus: 400, body: "the base builder could not run" };
  if (text.includes("BUILD A") && text.includes("BUILD B")) {
    const aIsIncumbent = newestFixtureBuild(request) === "B";
    return {
      text: JSON.stringify({ pick: aIsIncumbent ? "B" : "A", satisfied: true, biggest_gap: "", reason: "scripted" }),
    };
  }
  return { text: "ok" };
}

describe("autopilot: a failed shared base", () => {
  it("rolls the game back without erasing the user's uncommitted and untracked work", async () => {
    const rig = await startRig({ respond });
    rigs.push(rig);
    const { name: project, dir } = await rig.core.games.scaffold("wip-game", { title: "Work in progress" });

    // The user's own history: a committed file, then edits they have not committed yet.
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "player.js"), "export const speed = 1;\n");
    await gitFile(["-C", dir, "add", "src/player.js"]);
    await gitFile([
      "-C",
      dir,
      "-c",
      "user.name=User",
      "-c",
      "user.email=user@example.com",
      "commit",
      "-q",
      "-m",
      "user: player",
    ]);
    await writeFile(path.join(dir, "src", "player.js"), "export const speed = 2; // tuned, not committed yet\n");
    await writeFile(path.join(dir, "src", "level2.js"), "export const level2 = 'draft';\n");

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a moody dusk exploration world",
      project,
      mode: "autopilot",
      classic: true,
      reference: { name: "quiet dusk wandering", shots: [], kind: "direction" },
      budgets: { wallClockMs: 300_000, maxIterations: 2 },
    });

    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "autopilot_base"),
      120_000,
      "autopilot_base",
    );
    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.ok, false, `the base failed as scripted: ${JSON.stringify(base)}`);

    assert.equal(
      await readFile(path.join(dir, "src", "player.js"), "utf8"),
      "export const speed = 2; // tuned, not committed yet\n",
      "the user's uncommitted edit survives the rollback",
    );
    assert.equal(
      await readFile(path.join(dir, "src", "level2.js"), "utf8"),
      "export const level2 = 'draft';\n",
      "the user's untracked file survives the rollback",
    );

    await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"),
      180_000,
      "run_finished",
    );
  });
});
