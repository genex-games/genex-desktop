/**
 * The Player report inbox's host (`main/game-ai/report-inbox.ts`): what genex.games lists is read
 * as hostile input, each report's saved playtest is found only in the game's own `ai/tapes/`, and
 * Fix with agent writes one report's tape there, redacted and realpath-contained. Every hostile
 * bundle, id or folder shape writes nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createReportInbox, type ReportInboxSource } from "../../src/main/game-ai/report-inbox.ts";
import { AiDoor, AiOp, AiProvenance, AiSource, playGameKey } from "../../src/shared/game-ai.ts";
import {
  type AiReportBundle,
  AiReportFailure,
  type AiReportInboxItem,
  AiReportKind,
  AiReportReason,
  AiValidation,
  reportTapeName,
} from "../../src/shared/game-ai-report.ts";
import { AI_TAPE_MAX_LINES, AI_TAPES_DIR, readTape, type TapeLine } from "../../src/shared/game-ai-tape.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLAY_PROJECT = "p_lantern";
const ID = "report-0001";

const ITEM: AiReportInboxItem = {
  id: ID,
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  reason: AiReportReason.Harmful,
  note: "The innkeeper said odd things",
  calls: 2,
  invalid: 1,
  model: "claude-haiku-4-5",
  tape: null,
};

const LINE: TapeLine = {
  v: 1,
  key: "a".repeat(64),
  n: 0,
  site: "innkeeper.reply",
  op: AiOp.Say,
  value: "Write to me at mira@example.com",
  source: AiSource.Plan,
  model: "claude-haiku-4-5",
  latencyFrames: 30,
  usage: { inputTokens: 120, outputTokens: 12 },
};

const CALL = {
  site: "innkeeper.reply",
  op: AiOp.Say,
  system: null,
  systemSha256: null,
  prompt: "Answer as the innkeeper.",
  untrusted: {},
  schema: null,
  rawOutput: "Write to me at mira@example.com",
  value: "Write to me at mira@example.com",
  validation: AiValidation.Valid,
  code: null,
  model: "claude-haiku-4-5",
  door: AiDoor.Plan,
  provenance: AiProvenance.Unverified,
  usage: null,
  costMicros: 0,
  latencyMs: 900,
  frame: 10,
  tick: null,
};

const BUNDLE: AiReportBundle = {
  v: 1,
  id: ID,
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  game: { key: playGameKey(PLAY_PROJECT), title: "Lantern Run" },
  reason: AiReportReason.Harmful,
  note: "The innkeeper said odd things",
  calls: [CALL, { ...CALL, validation: AiValidation.Invalid }],
  replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [], tape: [LINE] },
  digests: [],
  aiState: null,
  consoleErrors: [],
  frame: null,
  modelCheck: null,
  playerText: true,
};

/** A source that answers what the test says and records what it was asked. */
function sourceOf(list: unknown, bundle: { ok: true; body: unknown } | { ok: false; failure: AiReportFailure }) {
  const asked: string[] = [];
  const source: ReportInboxSource = {
    list: async (playProject) => {
      asked.push(`list ${playProject}`);
      if (list instanceof Error) throw list;
      return list;
    },
    bundle: async (playProject, id) => {
      asked.push(`bundle ${playProject} ${id}`);
      return bundle;
    },
  };
  return { source, asked };
}

async function gameFolder(): Promise<string> {
  const root = path.join(await tmpDir("report-inbox-"), "Lantern Run");
  await mkdir(root);
  return root;
}

const inboxOn = (root: string, source: ReportInboxSource, playProject: string | null = PLAY_PROJECT) =>
  createReportInbox({ game: async () => ({ root, playProject }), source });

/** Every file under `dir`, relative, sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("the report inbox", () => {
  it("lists what genex.games holds, newest first, each without a playtest until Fix made one", async () => {
    const root = await gameFolder();
    const older = { ...ITEM, id: "report-0000", createdAt: "2026-10-19T08:00:00.000Z", tape: "made-up" };
    const { source, asked } = sourceOf([older, ITEM], { ok: false, failure: AiReportFailure.Refused });
    const listed = await inboxOn(root, source).inbox("Lantern Run");
    assert.deepEqual(asked, [`list ${PLAY_PROJECT}`]);
    assert.deepEqual(
      listed.map((item) => [item.id, item.tape]),
      [
        [ID, null],
        ["report-0000", null],
      ],
      "genex.games never names a playtest of this Mac",
    );
  });

  it("names the playtest Fix with agent saved, only when it is a file in the game's own ai/tapes", async () => {
    const root = await gameFolder();
    const { source } = sourceOf([ITEM], { ok: true, body: BUNDLE });
    const inbox = inboxOn(root, source);
    const fixed = await inbox.inboxFix("Lantern Run", ID);
    assert.deepEqual(fixed, { ok: true, tape: reportTapeName(ID) });
    assert.equal((await inbox.inbox("Lantern Run"))[0]?.tape, reportTapeName(ID));
  });

  it("is empty for a game that was never published, and asks nobody", async () => {
    const root = await gameFolder();
    const { source, asked } = sourceOf([ITEM], { ok: true, body: BUNDLE });
    assert.deepEqual(await inboxOn(root, source, null).inbox("Lantern Run"), []);
    assert.deepEqual(asked, []);
  });

  it("refuses a list it cannot read whole, and a list it could not fetch", async () => {
    const root = await gameFolder();
    for (const list of [{ items: [ITEM] }, [ITEM, { ...ITEM, kind: "robot" }], [ITEM, ITEM], "[]", null]) {
      const { source } = sourceOf(list, { ok: true, body: BUNDLE });
      await assert.rejects(inboxOn(root, source).inbox("Lantern Run"), /can't be read/, JSON.stringify(list));
    }
    const { source } = sourceOf(new Error("ECONNRESET"), { ok: true, body: BUNDLE });
    await assert.rejects(inboxOn(root, source).inbox("Lantern Run"), /ECONNRESET/);
    assert.deepEqual(await filesUnder(root), []);
  });
});

describe("Fix with agent", () => {
  it("writes the report's tape, redacted, as a playtest the harness reads", async () => {
    const root = await gameFolder();
    const { source, asked } = sourceOf([ITEM], { ok: true, body: structuredClone(BUNDLE) });
    const fixed = await inboxOn(root, source).inboxFix("Lantern Run", ID);
    assert.deepEqual(asked, [`bundle ${PLAY_PROJECT} ${ID}`]);
    assert.deepEqual(fixed, { ok: true, tape: reportTapeName(ID) });
    assert.deepEqual(await filesUnder(root), [path.join(AI_TAPES_DIR, `${reportTapeName(ID)}.jsonl`)]);
    const text = await readFile(path.join(root, AI_TAPES_DIR, `${reportTapeName(ID)}.jsonl`), "utf8");
    const read = readTape(text);
    assert.equal(read.rejected, 0);
    assert.equal(read.lines.length, 1);
    assert.doesNotMatch(text, /mira@example\.com/, "an email in a reply is redacted before it is saved");
    assert.equal(read.lines[0]?.key, LINE.key, "the slot it answers is kept");
  });

  it("passes on why genex.games would not hand the report over, writing nothing", async () => {
    const root = await gameFolder();
    for (const failure of Object.values(AiReportFailure)) {
      const { source } = sourceOf([ITEM], { ok: false, failure });
      assert.deepEqual(await inboxOn(root, source).inboxFix("Lantern Run", ID), { ok: false, failure });
    }
    assert.deepEqual(await filesUnder(root), []);
  });

  const hostile: Array<[string, unknown]> = [
    ["nothing", null],
    ["a bundle of another report", { ...BUNDLE, id: "report-9999" }],
    ["a bundle of another game", { ...BUNDLE, game: { key: playGameKey("p_other"), title: "Other" } }],
    ["a bundle of a library game", { ...BUNDLE, game: { key: "create:Lantern Run", title: "Lantern Run" } }],
    ["a bundle with an extra key", { ...BUNDLE, account: "u_1" }],
    ["a bundle of a later wire version", { ...BUNDLE, v: 2 }],
    [
      "a tape line that is not one",
      { ...BUNDLE, replay: { ...BUNDLE.replay, tape: [{ ...LINE, key: "../../etc/passwd" }] } },
    ],
  ];
  for (const [what, body] of hostile) {
    it(`refuses ${what}, writing nothing`, async () => {
      const root = await gameFolder();
      const { source } = sourceOf([ITEM], { ok: true, body });
      assert.deepEqual(await inboxOn(root, source).inboxFix("Lantern Run", ID), {
        ok: false,
        failure: AiReportFailure.Refused,
      });
      assert.deepEqual(await filesUnder(root), []);
    });
  }

  it("refuses a game that was never published, asking nobody", async () => {
    const root = await gameFolder();
    const { source, asked } = sourceOf([ITEM], { ok: true, body: BUNDLE });
    assert.deepEqual(await inboxOn(root, source, null).inboxFix("Lantern Run", ID), {
      ok: false,
      failure: AiReportFailure.Refused,
    });
    assert.deepEqual(asked, []);
  });

  it("refuses a tape too large for a playtest, writing nothing", async () => {
    const root = await gameFolder();
    const tape = Array.from({ length: AI_TAPE_MAX_LINES + 1 }, (_, n) => ({ ...LINE, n }));
    const body = { ...BUNDLE, replay: { ...BUNDLE.replay, tape } };
    const { source } = sourceOf([ITEM], { ok: true, body });
    assert.deepEqual(await inboxOn(root, source).inboxFix("Lantern Run", ID), {
      ok: false,
      failure: AiReportFailure.TooLarge,
    });
    assert.deepEqual(await filesUnder(root), []);
  });

  it("never writes through ai or ai/tapes linked out of the game", async () => {
    for (const linked of [["ai"], ["ai", "tapes"]]) {
      const root = await gameFolder();
      const outside = await tmpDir("report-inbox-outside-");
      if (linked.length === 2) await mkdir(path.join(root, "ai"));
      await symlink(outside, path.join(root, ...linked));
      const { source } = sourceOf([ITEM], { ok: true, body: BUNDLE });
      await assert.rejects(inboxOn(root, source).inboxFix("Lantern Run", ID), /ELOOP|not a folder/i);
      assert.deepEqual(await readdir(outside), [], `nothing written through ${linked.join("/")}`);
    }
  });

  it("never writes through a link planted at the playtest's name", async () => {
    const root = await gameFolder();
    const outside = path.join(await tmpDir("report-inbox-outside-"), "victim.txt");
    await writeFile(outside, "keep me");
    await mkdir(path.join(root, AI_TAPES_DIR), { recursive: true });
    await symlink(outside, path.join(root, AI_TAPES_DIR, `${reportTapeName(ID)}.jsonl`));
    const { source } = sourceOf([ITEM], { ok: true, body: BUNDLE });
    await assert.rejects(inboxOn(root, source).inboxFix("Lantern Run", ID));
    assert.equal(await readFile(outside, "utf8"), "keep me");
    const placed = await lstat(path.join(root, AI_TAPES_DIR, `${reportTapeName(ID)}.jsonl`));
    assert.ok(placed.isSymbolicLink(), "the planted link is left as it was");
  });

  it("does not take a linked playtest for one Fix with agent saved", async () => {
    const root = await gameFolder();
    const outside = path.join(await tmpDir("report-inbox-outside-"), "tape.jsonl");
    await writeFile(outside, `${JSON.stringify(LINE)}\n`);
    await mkdir(path.join(root, AI_TAPES_DIR), { recursive: true });
    await symlink(outside, path.join(root, AI_TAPES_DIR, `${reportTapeName(ID)}.jsonl`));
    const { source } = sourceOf([ITEM], { ok: true, body: BUNDLE });
    assert.equal((await inboxOn(root, source).inbox("Lantern Run"))[0]?.tape, null);
  });
});
