import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supplementRunEvidence } from "../../src/main/run-evidence.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

test("historical playtest stays incomplete with unknown revision; escaping report links are ignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-evidence-"));
  try {
    const dir = path.join(root, "run_test", "director", "play_1");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "playtest.json"),
      JSON.stringify({ answers: { "director-play": { pass: null, note: "" } } }),
    );
    const summary = summarizeRun([], "game", "run_test");
    await supplementRunEvidence(summary, root);
    assert.equal(summary.evidence.length, 1);
    assert.equal(summary.evidence[0]?.head, null);
    assert.equal(summary.evidence[0]?.status, "incomplete");
    assert.equal(summary.evidence[0]?.source, "independent-playtester");
    await supplementRunEvidence(summary, root);
    assert.equal(summary.evidence.length, 1, "supplement does not duplicate durable or existing interaction evidence");
    const escapeDir = path.join(root, "run_test", "director", "play_2");
    await mkdir(escapeDir);
    const outside = path.join(root, "unrelated.json");
    await writeFile(outside, JSON.stringify({ answers: { secret: { pass: true, note: "not this run" } } }));
    await symlink(outside, path.join(escapeDir, "playtest.json"));
    const judgeDir = path.join(root, "run_test", "director", "judge_1");
    await mkdir(judgeDir);
    await writeFile(
      path.join(judgeDir, "verdict.json"),
      JSON.stringify({ head: "same", answer: { question: "Can I see the sign?", yes: false, note: "Older failure" } }),
    );
    summary.evidence.push({
      id: "later",
      head: "same",
      category: "visual",
      label: "Can I see the sign?",
      status: "passed",
      note: "Later confirmed",
      source: "run_visual_evidence",
    });
    await supplementRunEvidence(summary, root);
    assert.equal(
      summary.evidence.find((e) => e.id === "later")?.note,
      "Later confirmed",
      "an earlier report cannot overwrite a later opposite answer",
    );
    const fresh = summarizeRun([], "game", "run_test");
    await supplementRunEvidence(fresh, root);
    assert.equal(fresh.evidence.length, 1);
    assert.equal(
      fresh.evidence.some((e) => e.note === "not this run"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("director base and final captures survive without workers or a visual question and never use another revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-captures-"));
  try {
    const dir = path.join(root, "run_test", "director");
    const save = async (folder: string, head: string, target = "integration") => {
      const location = path.join(dir, folder);
      await mkdir(location, { recursive: true });
      const image = path.join(location, "default.jpg");
      await writeFile(image, "fixture");
      await writeFile(
        path.join(location, "verdict.json"),
        JSON.stringify({ head, commit: head, target, shots: [{ camera: "default", path: image }] }),
      );
      return realpath(image);
    };
    const base = await save("base", "built-base");
    await save("judge_1", "older");
    const current = await save("judge_2", "current");
    await save("judge_3", "other", "worker");
    const summary = summarizeRun([], "game", "run_test");
    summary.base = "empty-scaffold";
    summary.deliveredSourceHead = "current";
    await supplementRunEvidence(summary, root);
    assert.deepEqual(summary.captures, { base, current });
    summary.deliveredSourceHead = "not-captured";
    summary.captures = undefined;
    await supplementRunEvidence(summary, root);
    assert.deepEqual(summary.captures, { base });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing games retain their starting view and a final health capture without a visual judge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-health-captures-"));
  try {
    const run = path.join(root, "run_test"),
      dir = path.join(run, "director");
    const start = path.join(run, "iter_000/screenshots/default.jpg"),
      final = path.join(dir, "close_abcdef12/screenshots/default.jpg");
    await mkdir(path.dirname(start), { recursive: true });
    await writeFile(start, "starting image");
    await mkdir(path.dirname(final), { recursive: true });
    await writeFile(final, "final image");
    await mkdir(path.join(dir, "start"), { recursive: true });
    await writeFile(path.join(dir, "start/verdict.json"), JSON.stringify({ commit: "base", shots: [{ path: start }] }));
    await writeFile(path.join(dir, "close_abcdef12/verdict.json"), JSON.stringify({ head: "abcdef123456", ok: true }));
    const summary = summarizeRun([], "game", "run_test");
    summary.deliveredSourceHead = "abcdef123456";
    await supplementRunEvidence(summary, root);
    assert.deepEqual(summary.captures, { base: await realpath(start), current: await realpath(final) });
    summary.deliveredSourceHead = "other";
    summary.captures = undefined;
    await supplementRunEvidence(summary, root);
    assert.deepEqual(summary.captures, { base: await realpath(start) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a judge that agrees with a recorded visual answer lends it its note and the frame it answered from", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-evidence-"));
  try {
    const judgeDir = path.join(root, "run_agree", "director", "judge_1");
    await mkdir(path.join(judgeDir, "screenshots"), { recursive: true });
    const frame = path.join(judgeDir, "screenshots", "top.jpg");
    await writeFile(frame, "jpeg");
    await writeFile(
      path.join(judgeDir, "verdict.json"),
      JSON.stringify({
        head: "abc",
        target: "worker",
        shots: [
          { camera: "default", path: path.join(judgeDir, "screenshots", "missing.jpg") },
          { camera: "top", path: frame },
        ],
        answer: { question: "Is the sign lit?", yes: true, note: "Lit from the top", camera: "top" },
      }),
    );
    const summary = summarizeRun([], "game", "run_agree");
    summary.evidence.push({
      id: "sign",
      head: "abc",
      category: "visual",
      label: "Is the sign lit?",
      status: "passed",
      note: null,
      source: "run_visual_evidence",
    });
    await supplementRunEvidence(summary, root);
    const sign = summary.evidence.find((e) => e.id === "sign");
    assert.equal(sign?.note, "Lit from the top");
    assert.equal(sign?.capture, await realpath(frame));
    assert.equal(summary.captures?.current, undefined, "a worker's judge never becomes the delivered capture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed Loop led in its folder shows the page its finish photographed as its build; nothing else does", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "run-open-finish-"));
  try {
    const dir = path.join(root, "run_open", "director");
    await mkdir(dir, { recursive: true });
    const picture = path.join(dir, "finish.jpg");
    await writeFile(picture, "jpeg");
    const record = (eventType: string, payload: Record<string, unknown>, at = new Date(0)): EventEnvelope =>
      ({
        id: eventType,
        thread_id: "t1",
        session_id: null,
        turn_id: null,
        created_at: at.toISOString(),
        data: { type: "custom", event_type: eventType, payload: { runId: "run_open", ...payload } },
      }) as EventEnvelope;
    const close = (victory: boolean) => record("run_finished", { victory });
    const closed = () => {
      const summary = summarizeRun([], "game", "run_open");
      summary.profile = "open";
      summary.execution = "completed";
      summary.graphEvents = [close(true)];
      return summary;
    };
    const summary = closed();
    await supplementRunEvidence(summary, root);
    assert.equal(summary.captures?.current, await realpath(picture));
    const cases: Array<[string, (s: ReturnType<typeof closed>) => void]> = [
      ["still running", (s) => (s.execution = "running")],
      ["stopped by the person", (s) => (s.execution = "cancelled")],
      ["not led in its folder", (s) => delete s.profile],
      ["already has its build's capture", (s) => (s.captures = { current: "/elsewhere/judge.jpg" })],
      ["closed some other way, its claim refused before", (s) => (s.graphEvents = [close(false)])],
      ["no close on record", (s) => (s.graphEvents = [])],
      [
        "older than the newest save point: left by a refused claim when the accepted one could not look",
        (s) => (s.graphEvents = [record("facet_iteration", {}, new Date(Date.now() + 60_000)), close(true)]),
      ],
    ];
    for (const [why, change] of cases) {
      const other = closed();
      change(other);
      const before = other.captures?.current;
      await supplementRunEvidence(other, root);
      assert.equal(other.captures?.current, before, why);
    }
    await rm(picture);
    const outside = path.join(root, "outside.jpg");
    await writeFile(outside, "jpeg");
    await symlink(outside, picture);
    const linked = closed();
    await supplementRunEvidence(linked, root);
    assert.equal(linked.captures?.current, undefined, "a link out of the run's folder is never the build's picture");
    // A director folder that is another run's: its picture is that run's, never this one's.
    await rm(picture);
    const other = path.join(root, "run_other", "director");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "finish.jpg"), "jpeg");
    await rm(dir, { recursive: true });
    await symlink(other, dir);
    const borrowed = closed();
    await supplementRunEvidence(borrowed, root);
    assert.equal(borrowed.captures?.current, undefined, "another run's director folder is never this run's build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
