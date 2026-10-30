/**
 * A Loop ends only on a reviewer's yes: it reads the proof and the captures, did none of the work,
 * and three no's in a row stop the Loop. A fake `ctx` (`ctx-recorder`) answers the host's calls (the
 * engines, the observers, the jobs, the run's artifacts and records), and the host's finish check
 * (`fakeFinishReview`: the app's own rules over the test's reviewer sessions and records); the
 * lead's folder is a temporary one; the clock is the test's.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import {
  newTally,
  reviewerSeat,
  tallyOf,
} from "../../src/harness-seed/loop/finish-check.ts";
import {
  FINISH_CHECK_EVENT,
} from "../../src/harness-seed/loop/finish-contract.ts";
import {
  freshProofIn,
  MAX_PROOF_FILES,
  PROOF_FILE_MAX_BYTES,
  readProof,
  readProofFile,
} from "../../src/harness-seed/loop/finish-proof.ts";
import { MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import type { Run } from "../../src/harness-seed/types/harness.d.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fakeFinishReview } from "../helpers/reviewer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const CLAUDE = "claude-code";
const CODEX = "codex";
/** A run led on Codex whose Reviewers role sits on Claude Code. */
const RUN = {
  runId: "run_desk",
  project: "desk-game",
  goal: "a kite racing game with three laps and a lap timer",
  engine: CODEX,
  judgeEngine: CLAUDE,
  judgeModel: "opus",
  roles: { efforts: { judge: "high" } },
} as unknown as Run;
/** A PNG's signature and a little more, as a file and as base64. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** The engines the host describes: both session engines. */
const ENGINES = [
  { id: CLAUDE, label: CLAUDE, kind: "delegated", supportsSessions: true, models: [] },
  { id: CODEX, label: CODEX, kind: "delegated", supportsSessions: true, models: [] },
];

/** The reviewer's answer as its session summary. */
const verdict = (word: string, reasons: string[] = [], notDone: string[] = []) => ({
  ok: true,
  engine: CLAUDE,
  turns: 3,
  usage: {},
  summary: `I looked.\n\`\`\`json\n${JSON.stringify({ verdict: word, reasons, notDone })}\n\`\`\``,
});

/** A lead's folder with a test report and a picture it can name as proof. */
async function leadFolder(): Promise<string> {
  const dir = await tmpDir("finish-check-lead-");
  await mkdir(path.join(dir, "reports"), { recursive: true });
  await mkdir(path.join(dir, "shots"), { recursive: true });
  await writeFile(path.join(dir, "reports", "tests.txt"), "12 passed, 0 failed\nlap timer: ok\n");
  await writeFile(path.join(dir, "shots", "finish.png"), PNG);
  return dir;
}

type Answer = ReturnType<typeof verdict> | { ok: false; summary: string; errorText: string } | Error;

/** The reviewer sessions the host started for each recorder's checks, with the params it started them with. */
const SESSIONS = new WeakMap<CtxRecorder, Array<Record<string, unknown>>>();

type Handler = (params: Record<string, unknown>) => unknown;
/** Records as the fake host keeps them. */
type Kept = Array<{ event_type: string; payload: Record<string, unknown> }>;

/**
 * A host whose reviewer answers each session from `answers`, in order (a `handlers` entry for
 * `engine.delegate` is the reviewer's session instead): the finish check is the host's
 * (`fakeFinishReview`), its records kept beside what the harness appends, after any `seeded` ones.
 */
function host(answers: Answer[], handlers: Record<string, Handler> = {}, seeded: Kept = []) {
  const records: Kept = [...seeded];
  const { [HostMethod.EngineDelegate]: session, ...rest } = handlers;
  const scripted = () => {
    const answer = answers.shift();
    if (!answer) throw new Error("no reviewer answer scripted");
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const appended: Handler = (p) => {
    for (const item of p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>)
      records.push({ event_type: item.event_type, payload: item.payload });
    return "e1";
  };
  const append = rest[HostMethod.EventsAppend] ?? appended;
  const checks = () => records.filter((record) => record.event_type === FINISH_CHECK_EVENT).map((one) => one.payload);
  const review = fakeFinishReview({
    delegate: session ?? scripted,
    append: (payload) => append({ batch: [{ event_type: FINISH_CHECK_EVENT, payload }] }),
    records: checks,
  });
  const r = ctxRecorder({
    threadId: "chat-1",
    handlers: {
      [HostMethod.EngineDescribe]: () => ENGINES,
      [HostMethod.ObserversCapture]: () => [],
      [HostMethod.JobsList]: () => ({ jobs: [], seq: 0 }),
      [HostMethod.RunArtifact]: (p) => `/runs/run_desk/${String(p.name)}`,
      [HostMethod.EventsAppend]: appended,
      ...review.handlers,
      ...rest,
    },
  });
  SESSIONS.set(r, review.asked);
  return { r, records, checks };
}

describe("the finish check", () => {

  it("the reviewer is the Reviewers role's engine when it holds sessions, else the run's own, else none", async () => {
    const seat = (engines: unknown[]) =>
      reviewerSeat(host([], { [HostMethod.EngineDescribe]: () => engines }).r.ctx as never, RUN);
    const looking = { looks: true, sees: true, contextWindow: null };
    assert.deepEqual(await seat(ENGINES), { engine: CLAUDE, model: "opus", effort: "high", ...looking });
    const onlyOwn = ENGINES.filter((engine) => engine.id === CODEX);
    assert.deepEqual(await seat(onlyOwn), { engine: CODEX, model: undefined, effort: "high", ...looking });
    const local = [{ id: "ollama", label: "ollama", kind: "direct", supportsSessions: false, models: [] }];
    assert.equal(await seat(local), null);
  });

  it("only a proof file inside the lead's folder counts as fresh proof", async () => {
    const folder = await leadFolder();
    const outside = await tmpDir("finish-check-outside-");
    await writeFile(path.join(outside, "new.png"), PNG);
    await symlink(path.join(outside, "new.png"), path.join(folder, "shots", "link.png"));
    const since = Date.now() - MINUTE_MS;
    const rows: Array<[string, string]> = [
      ["a path outside", path.join(outside, "new.png")],
      ["a way up and out", "../new.png"],
      ["a link that leads out", "shots/link.png"],
      ["nothing there", "shots/missing.png"],
      ["not text", 7 as unknown as string],
    ];
    for (const [label, name] of rows) assert.equal(await freshProofIn(folder, [name], since), false, label);
    assert.equal(await freshProofIn(folder, ["shots/finish.png"], since), true, "a file written since counts");
  });

  it("reads only proof inside the lead's folder", async () => {
    const folder = await leadFolder();
    const outside = await tmpDir("finish-check-outside-");
    const sentinel = path.join(outside, "secret.txt");
    await writeFile(sentinel, "SENTINEL outside the lead's folder");
    await symlink(sentinel, path.join(folder, "link-out.txt"));
    await mkdir(path.join(folder, "a-folder"));
    await writeFile(path.join(folder, "big.log"), Buffer.alloc(PROOF_FILE_MAX_BYTES + 1, 0x61));
    await writeFile(path.join(folder, "nul.txt"), Buffer.from("text\0more"));
    await writeFile(path.join(folder, "bad\nname.txt"), "a name with a line break");
    const kinds = ["../x", "/etc/hosts", "~/x", "link-out.txt", "a-folder", "big.log", "nul.txt", "bad\nname.txt"];
    // Every name up to the cap is a hostile one: the climbs past the kinds fill it.
    const climbs = Array.from({ length: MAX_PROOF_FILES - kinds.length }, (_, i) => `../climb-${i}`);
    const hostile = [...kinds, ...climbs];
    assert.equal(hostile.length, MAX_PROOF_FILES);
    const { r } = host([]);
    const proof = await readProof(r.ctx as never, RUN, folder, [...hostile, "reports/tests.txt"]);
    assert.deepEqual(proof.images, [], "no picture");
    assert.deepEqual(proof.texts, [], "no text: the name after the cap is past it");
    assert.equal(proof.refused.length, hostile.length + 1, `a line each, and one for the rest: ${proof.refused}`);
    for (const line of proof.refused) assert.ok(!line.includes("\n"), `one line: ${JSON.stringify(line)}`);
    assert.deepEqual(
      proof.refused.slice(0, hostile.length).map((line) => line.slice(0, line.indexOf(": not a file in your folder"))),
      hostile.map((name) => name.replace("\n", " ")),
      "each name refused in its own line, in order",
    );
    assert.ok(!JSON.stringify(proof).includes("SENTINEL"), "nothing outside read");
    assert.deepEqual(r.paramsOf(HostMethod.RunArtifact), [], "no artifact saved");
    await rm(sentinel);
  });

  it("reads proof the lead names by its full path inside its folder, and refuses one outside", async () => {
    const folder = await leadFolder();
    const outside = await tmpDir("finish-check-abs-outside-");
    await writeFile(path.join(outside, "report.txt"), "SENTINEL outside");
    const { r } = host([]);
    const names = [
      path.join(folder, "reports", "tests.txt"),
      path.join(await realpath(folder), "shots", "finish.png"),
      path.join(outside, "report.txt"),
      path.join(folder, ".git", "config"),
    ];
    const proof = await readProof(r.ctx as never, RUN, folder, names);
    assert.deepEqual(
      proof.texts.map((text) => text.text.split("\n")[0]),
      ["12 passed, 0 failed"],
      "the report by its full path",
    );
    assert.equal(proof.images.length, 1, "the picture by its real full path");
    assert.equal(proof.refused.length, 2, proof.refused.join("\n"));
    assert.ok(!JSON.stringify(proof).includes("SENTINEL"), "nothing outside read");
    assert.match(String(proof.refused[1]), /hidden/, "a hidden folder stays refused by its full path too");
  });

  it("a proof file swapped after its check is never read through: a link, a FIFO, or a folder on the way", {
    skip: process.platform === "win32" ? "links and FIFOs are POSIX here" : false,
    timeout: 10_000,
  }, async () => {
    const outside = await tmpDir("finish-check-swap-outside-");
    await writeFile(path.join(outside, "tests.txt"), "SENTINEL outside");
    const rows: Array<[string, (folder: string) => Promise<void>]> = [
      [
        "a link at the file's own name",
        async (folder) => {
          await rm(path.join(folder, "reports", "tests.txt"));
          await symlink(path.join(outside, "tests.txt"), path.join(folder, "reports", "tests.txt"));
        },
      ],
      [
        "a FIFO at the file's own name",
        async (folder) => {
          await rm(path.join(folder, "reports", "tests.txt"));
          execFileSync("mkfifo", [path.join(folder, "reports", "tests.txt")]);
        },
      ],
      [
        "its folder swapped for a link out",
        async (folder) => {
          await rename(path.join(folder, "reports"), path.join(folder, "reports-old"));
          await symlink(outside, path.join(folder, "reports"));
        },
      ],
    ];
    for (const [what, swap] of rows) {
      const folder = await leadFolder();
      const read = await readProofFile(folder, "reports/tests.txt", () => swap(folder));
      assert.ok("problem" in read, `${what}: refused`);
      assert.ok(!JSON.stringify(read).includes("SENTINEL"), `${what}: nothing outside read`);
    }
    const plain = await readProofFile(await leadFolder(), "reports/tests.txt");
    assert.ok("bytes" in plain && plain.bytes.toString().startsWith("12 passed"), "a plain file is read");
  });

  it("a tally kept in a journal reads back, and anything unreadable is a new one", () => {
    const kept = { round: 2, rejections: 1, checking: true, reasons: ["no timer"], notDone: ["a lap timer"], noAt: 7 };
    assert.deepEqual(tallyOf(JSON.parse(JSON.stringify(kept))), { ...kept, checking: false });
    const older = { round: 2, rejections: 1, checking: false, reasons: ["no timer"] };
    assert.deepEqual(tallyOf(older), { ...older, notDone: [] }, "an older journal's tally names nothing not done");
    for (const saved of [
      null,
      "x",
      { round: -1 },
      { round: 1, rejections: "2" },
      { round: 1, rejections: 0, reasons: [3] },
    ])
      assert.deepEqual(tallyOf(saved), newTally(), JSON.stringify(saved));
  });
});

describe("a chat turn", () => {
  it("a chat turn has no finish and asks no reviewer", async () => {
    const r = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "add a lap timer" }],
        "game.contentStamp": () => ({ all: "a", source: "a" }),
        "game.list": () => [
          {
            name: RUN.project,
            title: RUN.project,
            dir: `/games/${RUN.project}`,
            shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
            built: true,
            facts: [{ id: "web-game", path: ".", source: "core" }],
          },
        ],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
        [HostMethod.EngineDescribe]: () => ENGINES,
        "preview.ready": () => ({ ready: true, ms: 1 }),
        [HostMethod.EngineDelegate]: () => ({
          ok: true,
          engine: CLAUDE,
          turns: 1,
          usage: {},
          sessionId: "s",
          summary: "Done.",
        }),
      },
    });
    const turn = {
      threadId: "chat-1",
      turnId: "turn-1",
      text: "add a lap timer",
      engine: CLAUDE,
      engineLabel: "Claude Code",
    };
    await runDelegatedTurn(r.ctx as never, { ...turn, project: RUN.project } as never);
    const asked = r.paramsOf(HostMethod.EngineDelegate);
    assert.ok(asked.length > 0, "the turn ran");
    for (const params of asked) {
      assert.equal(params.reviewer, undefined, "no reviewer");
      assert.equal(params.director, undefined, "no lead's tools");
      const offered = [
        ...((params.interviewTools as Array<{ name: string }> | undefined) ?? []),
        ...((params.liveTools as Array<{ name: string }> | undefined) ?? []),
      ].map((tool) => tool.name);
      assert.ok(!offered.includes("finish"), `no finish among ${offered.join(", ")}`);
    }
    assert.deepEqual(r.paramsOf(HostMethod.ObserversCapture), [], "nothing captured for a check");
    assert.deepEqual(r.paramsOf(HostMethod.FinishReview), [], "no review asked");
  });
});
