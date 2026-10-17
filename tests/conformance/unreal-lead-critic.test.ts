/**
 * The Unreal lead's critic (loop/unreal/critic.ts): one fresh vision call on the lead's captures,
 * each read by realpath inside the project's Saved/Genex/captures folder, beside the game's
 * reference stills and ART.md. It answers defects with fixes, one bold move and its gate answers,
 * and changes nothing: a capture path that leads anywhere else is refused before any call.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { askCritic, CAPTURES_FOLDER } from "../../src/harness-seed/loop/unreal/critic.ts";
import { LEAD_PART } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { type Lead, newLeadJournal } from "../../src/harness-seed/loop/unreal/lead-journal.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN = {
  runId: "run-lead",
  goal: "A lighthouse keeper on a stormy coast under a thin grey light",
  project: "night-spire",
  engine: "claude-code",
  budgets: {},
} as unknown as Run;
const SEAT = {
  folder: "/games/night-spire",
  chatSession: false,
  sessionId: null,
  bookmarked: null,
  engine: undefined,
  model: null,
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ANSWER = {
  defects: [
    { defect: "The far walls are as dark as the near ones", fix: "Lift the fog's far colour" },
    { defect: "Nothing in the air", fix: "Add slow dust in the light shaft" },
  ],
  boldMove: "Drop the camera to the floor of the shaft",
  gates: ["Light: yes — one key light from above", "Atmosphere: no — no depth by value"],
};

/** A lead in a real game folder with one capture, ART.md and a reference still; the critic answers `answer`, then each of `later` in turn. */
async function criticOn(answer: unknown = ANSWER, later: unknown[] = []) {
  const answers = [answer, ...later];
  const dir = await tmpDir("lead-critic-");
  const outside = await tmpDir("lead-critic-outside-");
  const captures = path.join(dir, CAPTURES_FOLDER);
  await mkdir(captures, { recursive: true });
  await writeFile(path.join(captures, "vista.png"), PNG);
  await writeFile(path.join(captures, "notes.txt"), "not a picture");
  await writeFile(path.join(dir, "ART.md"), "Palette: wet stone, one cold key light, warm windows.");
  await writeFile(path.join(outside, "elsewhere.png"), PNG);
  await symlink(path.join(outside, "elsewhere.png"), path.join(captures, "out.png"));
  await symlink(path.join(dir, "ART.md"), path.join(captures, "art.png"));
  const rec = ctxRecorder({
    handlers: {
      "events.append": () => "e1",
      "artifact.write": () => 1,
      "game.references": () => ({ frames: [{ label: "ref-1", mimeType: "image/jpeg", data: "UkVG" }], skipped: [] }),
      "engine.complete": () => {
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next instanceof Error) throw next;
        return {
          message: { role: "assistant", content: typeof next === "string" ? next : JSON.stringify(next) },
        };
      },
      "run.artifact": (p) => `/runs/run-lead/${String(p.name)}`,
      "preview.crop": () => ({ path: "/runs/run-lead/crop.jpg", base64: "SlBFRw==", bytes: 4, width: 2, height: 2 }),
    },
  });
  const journal = newLeadJournal(RUN, SEAT);
  journal.savePoints.push({
    label: "Greybox",
    snapshotId: "snap-1",
    at: 0,
    summary: "the shaft in grey",
    thumbnails: [],
    milestoneId: LEAD_PART,
    round: 1,
    auto: false,
    logErrors: [],
  });
  const lead = {
    ctx: rec.ctx as unknown as HarnessCtx,
    run: RUN,
    threadId: "t1",
    clock: { now: () => 1_000, sleep: async () => {} },
    game: { dir, title: "Night Spire" },
    journal,
    started: 0,
  } as unknown as Lead;
  return { lead, rec, dir, outside, captures };
}

/** Every graph record the critic wrote. */
const records = (rec: CtxRecorder) =>
  rec
    .paramsOf("events.append")
    .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>);

describe("the Unreal lead's critic", () => {
  it("shows a fresh vision call the captures, the references and ART.md, under a rubric where light and composition are structure", async () => {
    const { lead, rec } = await criticOn();
    const answer = await askCritic(lead, { shots: "vista.png", question: "Does the shaft read as huge?" });
    const [call] = rec.paramsOf("engine.complete");
    assert.ok(call);
    assert.equal(call.effort, "high");
    assert.equal(call.stream, false);
    assert.match(String(call.systemPrompt), /Light, atmosphere, materials and composition are the STRUCTURE/);
    const [message] = call.messages as Array<{ content: string; images: Array<{ mimeType: string; label: string }> }>;
    assert.deepEqual(
      message?.images.map((image) => [image.mimeType, image.label]),
      [
        ["image/png", "vista.png"],
        ["image/jpeg", "ref-1"],
      ],
    );
    assert.match(String(message?.content), /wet stone, one cold key light/);
    assert.match(String(message?.content), /Does the shaft read as huge\?/);
    assert.match(
      answer,
      /The critic looked at vista\.png beside 1 reference still and ART\.md\. It advises; you decide\./,
    );
    assert.match(answer, /1\. The far walls are as dark as the near ones — fix: Lift the fog's far colour/);
    assert.match(answer, /One bold move: Drop the camera to the floor of the shaft/);
    assert.match(answer, /- Atmosphere: no — no depth by value/);
  });

  it("records its advice on the latest save point's round as advice, never as a verdict", async () => {
    const { lead, rec } = await criticOn();
    await askCritic(lead, { shots: "vista.png" });
    assert.equal(lead.journal.critiques.length, 1);
    assert.deepEqual(lead.journal.critiques[0]?.round, 1);
    const [advice] = records(rec).filter((e) => e.event_type === "director_verdict");
    assert.equal(advice?.payload.advice, true);
    assert.equal(advice?.payload.facetId, "lead");
    assert.equal(advice?.payload.iteration, 1);
    for (const field of ["because", "decision", "pass"]) assert.ok(!(field in (advice?.payload ?? {})), `no ${field}`);
  });

  it("changes nothing in the game or the run", async () => {
    const { lead, rec } = await criticOn();
    const before = structuredClone({ ...lead.journal, critiques: [], savedAt: "", workedMs: 0 });
    await askCritic(lead, { shots: "vista.png" });
    const after = { ...lead.journal, critiques: [], savedAt: "", workedMs: 0 };
    assert.deepEqual(after, before, "only its advice is recorded");
    const allowed = new Set(["game.references", "engine.complete", "events.append", "artifact.write"]);
    assert.deepEqual(
      rec.calls.map((c) => c.method).filter((m) => !allowed.has(m)),
      [],
    );
  });

  it("keeps at most five defects", async () => {
    const many = {
      ...ANSWER,
      defects: Array.from({ length: 8 }, (_, i) => ({ defect: `defect ${i}`, fix: `fix ${i}` })),
    };
    const { lead } = await criticOn(many);
    await askCritic(lead, { shots: "vista.png" });
    assert.equal(lead.journal.critiques[0]?.defects.length, 5);
  });

  const FAR_WALLS = ANSWER.defects[0];
  const RAILING = { defect: "The stair has no railing", fix: "Add a rail along the drop" };
  const SECOND = { defects: [RAILING], boldMove: "Light the stair from below", gates: [], stillOpen: [1] };

  it("shows a later look its last look's open items, and makes those it still sees required", async () => {
    const { lead, rec } = await criticOn(ANSWER, [SECOND]);
    await askCritic(lead, { shots: "vista.png" });
    const first = rec.paramsOf("engine.complete")[0]?.messages as Array<{ content: string }>;
    assert.doesNotMatch(String(first[0]?.content), /LAST LOOK/, "a first look has nothing open yet");
    const answer = await askCritic(lead, { shots: "vista.png" });
    const second = rec.paramsOf("engine.complete")[1]?.messages as Array<{ content: string }>;
    assert.match(
      String(second[0]?.content),
      /LAST LOOK[^\n]*\n1\. The far walls are as dark as the near ones — fix: Lift the fog's far colour\n2\. Nothing in the air/,
    );
    assert.deepEqual(lead.journal.critiques[1]?.required, [FAR_WALLS]);
    assert.match(
      answer,
      /REQUIRED[^\n]*\n- The far walls are as dark as the near ones — fix: Lift the fog's far colour/,
    );
    assert.match(answer, /1\. The stair has no railing/);
  });

  it("keeps an item required while it still sees it, and lets it go when it doesn't", async () => {
    const stillSees = { defects: [], boldMove: "Hang cables in the shaft", gates: [], stillOpen: [1] };
    const gone = { defects: [], boldMove: "Hang cables in the shaft", gates: [], stillOpen: [] };
    const { lead } = await criticOn(ANSWER, [SECOND, stillSees, gone]);
    for (let i = 0; i < 4; i++) await askCritic(lead, { shots: "vista.png" });
    assert.deepEqual(lead.journal.critiques[2]?.required, [FAR_WALLS], "the required item is item 1 of the next look");
    assert.deepEqual(lead.journal.critiques[3]?.required, []);
  });

  it("takes only the numbers of its last look's open items as still open", async () => {
    const odd = { ...SECOND, stillOpen: [0, 3, 99, -1, 1.5, "1", null, 2, 2] };
    const { lead } = await criticOn(ANSWER, [odd]);
    await askCritic(lead, { shots: "vista.png" });
    await askCritic(lead, { shots: "vista.png" });
    assert.deepEqual(lead.journal.critiques[1]?.required, [ANSWER.defects[1]]);
  });

  const UNANSWERED: Array<[string, unknown, RegExp]> = [
    ["an answer it can't read", "Looks great to me!", /could not be read/],
    ["an answer with neither a defect nor a bold move", { gates: ["Light: yes"] }, /could not be read/],
    [
      "an engine that fails",
      new Error("the judge engine is not signed in"),
      /could not answer \(the judge engine is not signed in\)/,
    ],
  ];
  for (const [what, answer, said] of UNANSWERED) {
    it(`records nothing for ${what}`, async () => {
      const { lead, rec } = await criticOn(answer);
      assert.match(await askCritic(lead, { shots: "vista.png" }), said);
      assert.deepEqual(lead.journal.critiques, []);
      assert.deepEqual(records(rec), []);
    });
  }

  const HOSTILE: Array<[string, string]> = [
    ["a climb out of the captures folder", "../../../../ART.md"],
    ["an absolute path", "/etc/hosts"],
    ["a hidden file", ".vista.png"],
    ["a Windows path", "sub\\vista.png"],
    ["a link out of the game", "out.png"],
    ["a link to another file of the game", "art.png"],
    ["a file that is not a picture", "notes.txt"],
    ["a missing capture", "gone.png"],
  ];
  for (const [what, shot] of HOSTILE) {
    it(`refuses ${what} before any call`, async () => {
      const { lead, rec } = await criticOn();
      const answer = await askCritic(lead, { shots: shot });
      assert.match(answer, /^The critic could not look: /);
      assert.deepEqual(rec.paramsOf("engine.complete"), [], "no vision call");
      assert.deepEqual(lead.journal.critiques, []);
      assert.deepEqual(records(rec), []);
    });
  }

  it("looks at the captures it can read, and says which it left out", async () => {
    const { lead, rec } = await criticOn();
    const answer = await askCritic(lead, { shots: "out.png, vista.png" });
    const [call] = rec.paramsOf("engine.complete");
    const [message] = (call?.messages ?? []) as Array<{ images: unknown[] }>;
    assert.equal(message?.images.length, 2, "the capture and the reference");
    assert.match(answer, /Left out: out\.png is not in the project's Saved\/Genex\/captures folder\./);
  });

  it("refuses every capture when the captures folder itself leads out of the game", async () => {
    const dir = await tmpDir("lead-critic-linked-");
    const outside = await tmpDir("lead-critic-linked-out-");
    await writeFile(path.join(outside, "vista.png"), PNG);
    await mkdir(path.join(dir, "unreal/Saved/Genex"), { recursive: true });
    await symlink(outside, path.join(dir, CAPTURES_FOLDER));
    const { lead, rec } = await criticOn();
    lead.game.dir = dir;
    assert.match(await askCritic(lead, { shots: "vista.png" }), /^The critic could not look/);
    assert.deepEqual(rec.paramsOf("engine.complete"), []);
  });

  it("re-encodes a capture too large to send as it is", async () => {
    const { lead, rec, captures } = await criticOn();
    await writeFile(path.join(captures, "big.png"), Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]));
    await askCritic(lead, { shots: "big.png" });
    const [message] = (rec.paramsOf("engine.complete")[0]?.messages ?? []) as Array<{
      images: Array<{ mimeType: string; data: string }>;
    }>;
    assert.deepEqual([message?.images[0]?.mimeType, message?.images[0]?.data], ["image/jpeg", "SlBFRw=="]);
    assert.equal(rec.paramsOf("run.artifact").length, 1);
  });

  it("asks for the shots it should look at", async () => {
    const { lead, rec } = await criticOn();
    assert.match(await askCritic(lead, {}), /needs the capture file names/);
    assert.deepEqual(rec.calls, []);
  });
});
