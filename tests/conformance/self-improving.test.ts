/**
 * Self-improving background.
 *
 * One toggle, default off until explicitly enabled. Piggyback SkillOpt is covered by skillopt.test.ts; here: the settings
 * migration from the old auto-apply key, the durable ImprovementJournal, and the idle-time
 * architect — proposal, fork validation with a real second harness boot, snapshot-armored
 * apply, and every reason it must refuse to run.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { ImprovementJournal } from "../../src/substrate/improvement-journal.ts";
import { mineValidationTasks } from "../../src/harness-seed/loop/skillopt.ts";
import { customEvents, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import type { FakeReply } from "../helpers/fake-ollama.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("settings: the one self-improving switch", () => {
  it("defaults off, and preserves an existing explicit self-improvement choice", async () => {
    const fresh = await startRig();
    rigs.push(fresh);
    assert.equal(fresh.core.settings.selfImproving, false, "instruction edits need explicit opt-in");
    await fresh.core.updateSettings({ selfImproving: true });
    await fresh.core.stop();
    await fresh.core.init();
    assert.equal(fresh.core.settings.selfImproving, true, "an explicit opt-in survives restart");

    // An existing install that had auto-apply explicitly off keeps its caution.
    const rig = await startRig();
    rigs.push(rig);
    await writeFile(path.join(rig.userData, "settings.json"), JSON.stringify({ autoApplyImprovements: false }));
    await rig.core.stop();
    await rig.core.init();
    assert.equal(rig.core.settings.selfImproving, false, "auto-apply=off migrates to self-improving=off");
  });

  it("Maximum workers defaults to four, adds the lead's windows to the pool, and migrates old saved values", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const restart = async () => {
      await rig.core.stop();
      await rig.core.init();
    };
    assert.equal(rig.core.settings.buildersMax, 4);
    assert.equal(rig.core.settings.agentsMax, 6, "four workers plus the lead's two windows");
    const five = await rig.core.updateSettings({ buildersMax: 5 });
    assert.deepEqual([five.buildersMax, five.agentsMax], [5, 7]);
    const most = await rig.core.updateSettings({ buildersMax: 99 });
    assert.deepEqual([most.buildersMax, most.agentsMax], [12, 14], "never above the most offered");
    await rig.core.updateSettings({ buildersMax: 8 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 8, "eight chosen now stays eight, though it was the old default");

    await rig.core.updateSettings({ buildersMax: 12 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 12, "an explicit twelve is not replaced by the default");

    // Settings are saved whole on any change, so only a choice made from now on is told apart from a default.
    await rig.core.updateSettings({ buildersMax: 2 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 2, "two chosen now stays two");

    const settings = path.join(rig.userData, "settings.json");
    await writeFile(settings, JSON.stringify({ buildersMax: 8, agentsMax: 10, buildersDefault: 8 }));
    await restart();
    assert.deepEqual(
      [rig.core.settings.buildersMax, rig.core.settings.agentsMax],
      [4, 6],
      "the previous build's untouched default of eight becomes the new default of four",
    );
    await writeFile(settings, JSON.stringify({ buildersMax: 2, agentsMax: 4 }));
    await restart();
    assert.deepEqual(
      [rig.core.settings.buildersMax, rig.core.settings.agentsMax],
      [4, 6],
      "an older build's untouched default of two becomes the new default",
    );
    await writeFile(settings, JSON.stringify({ buildersMax: 6, agentsMax: 8 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 6, "any other number an older build saved was chosen and stays");
    await writeFile(settings, JSON.stringify({ buildersMax: 5, agentsMax: 7, buildersDefault: 5 }));
    await restart();
    assert.equal(
      rig.core.settings.buildersMax,
      4,
      "a count equal to the default its file recorded follows today's default",
    );

    await writeFile(settings, JSON.stringify({ agentsMax: 6 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 4, "the old untouched pool size becomes the new default");
    await writeFile(settings, JSON.stringify({ agentsMax: 8 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 6, "a pool someone chose keeps its builders");
  });

  it("Self-improvement off: nothing is learned, nothing is applied, and the choice persists", async () => {
    const rig = await startRig();
    rigs.push(rig);
    assert.equal(rig.core.settings.learning, true, "on by default");
    await rig.core.updateSettings({ learning: false });
    assert.equal(
      await rig.core.api()["learning.enabled"]!({} as never),
      false,
      "the harness is told before it learns anything",
    );

    // A waiting suggestion is not swept in, even when automatic apply is switched on.
    const file = path.join(rig.core.layout.harnessWs, "skills", "facet-decomposition.md");
    const before = await readFile(file, "utf8");
    await rig.core.store.writeArtifact(rig.core.mainThread, "skillopt_staged", [
      {
        skill: "facet-decomposition",
        file: "skills/facet-decomposition.md",
        currentText: before,
        proposedText: `${before}\n- Waiting.\n`,
        gate: {},
        rationale: "",
        at: "2026-09-23T00:00:00.000Z",
      },
    ]);
    await rig.core.updateSettings({ selfImproving: true });
    // A pass asked for anyway does nothing and writes nothing.
    await rig.core.host.dispatch({ type: "skillopt_start", threadId: rig.core.mainThread }, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const log = await rig.core.listAllEvents();
    assert.equal(customEvents(log, "skillopt_pass").length, 0, "no learning pass ran");
    assert.equal(customEvents(log, "skillopt_accepted").length, 0, "nothing was applied");
    assert.equal(await readFile(file, "utf8"), before);

    await rig.core.stop();
    await rig.core.init();
    assert.equal(rig.core.settings.learning, false, "the switch survives a relaunch");
    await rig.core.updateSettings({ learning: true });
    assert.equal(await rig.core.api()["learning.enabled"]!({} as never), true);
  });
});

describe("improvement journal", () => {
  it("is durable, and a job interrupted mid-validation goes back in the queue", async () => {
    const dir = path.join(await tmpDir("improve-"), "improvements");
    const journal = new ImprovementJournal(dir);
    const job = await journal.queue("test pass");
    await journal.update(job.id, { status: "validating" });

    // "The laptop closed": a fresh instance sweeps the stuck job back to queued.
    const reborn = new ImprovementJournal(dir);
    await reborn.sweep();
    const pending = await reborn.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, job.id);
    assert.equal(pending[0]!.note, "requeued after restart");

    await reborn.update(job.id, { status: "applied" });
    assert.equal((await reborn.pending()).length, 0);
    assert.ok(await reborn.newestFinishedAt(), "finished jobs anchor the scheduler's pacing");
  });
});

describe("skillopt mines autopilot evidence", () => {
  it("facet iterations and decision cards become validation tasks", () => {
    const events = [
      {
        data: {
          type: "custom",
          event_type: "facet_iteration",
          payload: {
            facetId: "terrain",
            facetTitle: "Terrain",
            iteration: 1,
            winner: "incumbent",
            biggest_gap: "no depth",
          },
        },
      },
      {
        data: {
          type: "custom",
          event_type: "autopilot_decision",
          payload: { decision: "chose sunset lighting" },
        },
      },
    ];
    const tasks = mineValidationTasks(events as never, 10);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.prompt, "Terrain: no depth");
    assert.equal(tasks[0]!.success, false);
    assert.match(tasks[1]!.prompt, /chose sunset lighting/);
    assert.deepEqual(tasks[1]!.skills, ["facet-decomposition"]);
  });
});

const NEW_SKILL = `---
name: Director
description: sharper rules
---
- Keep the camera 6-8 units behind the player.
`;

function architectResponder() {
  const counts = { pick: 0, rewrite: 0 };
  const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
    const text = request.messages.map((m) => m.content).join("\n");
    if (text.includes("FILES:")) {
      counts.pick++;
      return { text: JSON.stringify({ file: "skills/director.md", why: "sharper director rules" }) };
    }
    if (text.includes("FILE skills/director.md")) {
      counts.rewrite++;
      return { text: `REASON: sharper camera rules\n\`\`\`file\n${NEW_SKILL}\`\`\`` };
    }
    return { text: "ok" };
  };
  return { respond, counts };
}

describe("idle-time architect", () => {
  it("refuses while user work is in flight, then proposes, fork-validates, and applies with snapshots", async () => {
    const { respond, counts } = architectResponder();
    const rig = await startRig({ respond });
    rigs.push(rig);
    // The architect is off by default since the v2 loop; the user switches it on here.
    await rig.core.updateSettings({ architect: true, selfImproving: true });
    // Drive the scheduler by hand: instantly idle, no pacing gap, timer effectively off.
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };

    // Improvement work never queues ahead of a build (A9): with user work in flight, nothing runs.
    rig.core.budget.beginWork("user");
    await rig.core.runIdleCheckNow();
    assert.equal((await rig.core.improvements.all()).length, 0, "no job even queued during user work");
    rig.core.budget.endWork("user");

    // Idle for real: one architect pass runs end to end.
    await rig.core.runIdleCheckNow();
    const jobs = await rig.core.improvements.all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "applied", JSON.stringify(jobs[0]));
    assert.equal(counts.pick, 1);
    assert.equal(counts.rewrite, 1);
    assert.ok(jobs[0]!.snapshot_id && jobs[0]!.post_snapshot_id, "snapshots on both sides of the write");

    const live = await readFile(path.join(rig.core.layout.harnessWs, "skills", "director.md"), "utf8");
    assert.match(live, /6-8 units behind/);

    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "improvement_applied").length >= 1,
      15_000,
      "improvement_applied",
    );
    const card = customEvents(events, "improvement_applied")[0]!;
    assert.equal(card.file, "skills/director.md");
    assert.match(String(card.reason), /sharper camera rules/);
    // Both snapshot anchors on the card make the Rewind button honest.
    assert.ok(card.snapshot_id && card.post_snapshot_id);

    // Pacing: with the gap restored, a second idle check does not immediately re-run.
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 3_600_000 };
    await rig.core.runIdleCheckNow();
    assert.equal((await rig.core.improvements.all()).length, 1, "one look per quiet stretch, not a hot loop");
  });

  it("a proposal whose fork fails its boot healthcheck is discarded, live self untouched", async () => {
    const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
      const text = request.messages.map((m) => m.content).join("\n");
      if (text.includes("FILES:")) {
        return { text: JSON.stringify({ file: "loop/main.ts", why: "restructure dispatch" }) };
      }
      if (text.includes("FILE loop/main.ts")) {
        return { text: 'REASON: bold restructure\n```file\nthrow new Error("deliberately broken");\n```' };
      }
      return { text: "ok" };
    };
    const rig = await startRig({ respond });
    rigs.push(rig);
    await rig.core.updateSettings({ architect: true, selfImproving: true });
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };
    const before = await readFile(path.join(rig.core.layout.harnessWs, "loop", "main.ts"), "utf8");

    await rig.core.runIdleCheckNow();
    const jobs = await rig.core.improvements.all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "failed");
    assert.match(String(jobs[0]!.note), /healthcheck/);

    const after_ = await readFile(path.join(rig.core.layout.harnessWs, "loop", "main.ts"), "utf8");
    assert.equal(after_, before, "the live self never saw the broken change");
    assert.equal(rig.core.host.state, "ready", "the live harness kept running throughout");

    // The failure lands in the step buffer, so the dead idea stops coming back.
    const buffer = (await rig.core.store.readArtifact(rig.core.mainThread, "skillopt_step_buffer")) as Array<{
      architect?: boolean;
    }>;
    assert.ok(buffer.some((entry) => entry.architect));
  });

  it("a rewrite that boots but fails the loop self-test is discarded — booting is not the bar", async () => {
    // A loop that boots but scores wrong used to pass validation. The rewritten playtester below
    // type-checks and loads fine, and passes every play question that got any answer at all.
    const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
      const text = request.messages.map((m) => m.content).join("\n");
      if (text.includes("FILES:")) {
        return {
          text: JSON.stringify({ file: "loop/playtester.ts", why: "a playtester that answered has done its job" }),
        };
      }
      if (text.includes("FILE loop/playtester.ts")) {
        const original = /```\n([\s\S]*)\n```/.exec(text)?.[1] ?? "";
        const lenient = original.replace(
          "const pass = answer === expect;",
          "const pass = answer !== null && expect !== null;",
        );
        assert.notEqual(lenient, original, "the fixture found the line it changes");
        return { text: ["REASON: answered is passed", "```file", lenient, "```"].join("\n") };
      }
      return { text: "ok" };
    };
    const rig = await startRig({ respond });
    rigs.push(rig);
    await rig.core.updateSettings({ architect: true, selfImproving: true });
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };
    const before = await readFile(path.join(rig.core.layout.harnessWs, "loop", "playtester.ts"), "utf8");
    await rig.core.runIdleCheckNow();
    const jobs = await rig.core.improvements.all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, "failed", JSON.stringify(jobs[0]));
    assert.ok(
      rig.logs.some((line) => /failed the loop self-test/.test(line)),
      "the log names the self-test as the reason",
    );
    const after_ = await readFile(path.join(rig.core.layout.harnessWs, "loop", "playtester.ts"), "utf8");
    assert.equal(after_, before, "the live self never saw the change");
  });

  it("a rewrite that does not type-check is discarded before any copy of it boots", async () => {
    const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
      const text = request.messages.map((m) => m.content).join("\n");
      if (text.includes("FILES:")) return { text: JSON.stringify({ file: "loop/playtester.ts", why: "count passes" }) };
      if (text.includes("FILE loop/playtester.ts")) {
        const original = /```\n([\s\S]*)\n```/.exec(text)?.[1] ?? "";
        const broken = original.replace("const pass = answer === expect;", "const pass: number = answer === expect;");
        assert.notEqual(broken, original, "the fixture found the line it changes");
        return { text: ["REASON: count passes", "```file", broken, "```"].join("\n") };
      }
      return { text: "ok" };
    };
    const rig = await startRig({ respond });
    rigs.push(rig);
    await rig.core.updateSettings({ architect: true, selfImproving: true });
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };
    const before = await readFile(path.join(rig.core.layout.harnessWs, "loop", "playtester.ts"), "utf8");
    await rig.core.runIdleCheckNow();
    const jobs = await rig.core.improvements.all();
    assert.equal(jobs[0]!.status, "failed", JSON.stringify(jobs[0]));
    assert.match(
      String(jobs[0]!.note),
      /type check[\s\S]*loop\/playtester\.ts\(\d+,\d+\): error TS2322/,
      "the note carries the compiler's own words",
    );
    assert.ok(!rig.logs.some((line) => /failed the loop self-test/.test(line)), "nothing booted the broken copy");
    assert.equal(
      await readFile(path.join(rig.core.layout.harnessWs, "loop", "playtester.ts"), "utf8"),
      before,
      "the live self never saw the change",
    );
  });

  it("the architect stays parked while its switch is off (the v2 default)", async () => {
    const { respond, counts } = architectResponder();
    const rig = await startRig({ respond });
    rigs.push(rig);
    assert.equal(rig.core.settings.architect, false, "off by default");
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };
    await rig.core.runIdleCheckNow();
    assert.equal((await rig.core.improvements.all()).length, 0, "no job queued while the architect is off");
    assert.equal(counts.pick, 0);
  });

  it("the architect can never pick judge/ — it is not even on the menu", async () => {
    const offered: string[] = [];
    const respond = (request: { messages: Array<{ role: string; content: string }> }): FakeReply | null => {
      const text = request.messages.map((m) => m.content).join("\n");
      if (text.includes("FILES:")) {
        offered.push(text);
        // Try to name the frozen rubric anyway — the guard must reject it.
        return { text: JSON.stringify({ file: "judge/blind-compare.md", why: "bend the yardstick" }) };
      }
      return { text: "ok" };
    };
    const rig = await startRig({ respond });
    rigs.push(rig);
    await rig.core.updateSettings({ architect: true, selfImproving: true });
    rig.core.options.improvementIdle = { idleMs: 0, checkMs: 3_600_000, minGapMs: 0 };
    await rig.core.runIdleCheckNow();
    assert.ok(offered.length >= 1);
    const listedFiles = offered[0]!.split("\n").filter((line) => line.startsWith("- "));
    assert.ok(listedFiles.length > 0, "the architect was offered real files");
    assert.ok(
      listedFiles.every((line) => !line.includes("judge/")),
      "judge files never appear in the offered list",
    );
    const jobs = await rig.core.improvements.all();
    assert.equal(jobs[0]!.status, "rejected");
    assert.match(String(jobs[0]!.note), /outside its list/);
  });
});
