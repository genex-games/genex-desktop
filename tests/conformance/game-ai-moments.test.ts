/**
 * The model check's moments (`main/game-ai/moments.ts`, D10): the AI moments of the creator's own
 * playtests in Create Live, saved with their requests so the check can replay them on other
 * models. Only a fitting answer from a model, in the creator's own game, played by a person, is a
 * moment; the newest replace an older one of the same call; the store is bounded and read back as
 * hostile input. It lives in play-time AI's own folder, keyed by a hash of the game's name.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { AiDoor, AiErrorCode } from "../../src/shared/game-ai.ts";
import { AiValidation } from "../../src/shared/game-ai-report.ts";
import { MOMENTS_DIR, MOMENTS_MAX_PER_GAME, createMomentStore, momentsFile } from "../../src/main/game-ai/moments.ts";
import { CREATE_GAME, PLAY_GAME, callerFor, heldClock, requestOf, traceOf } from "../helpers/game-ai-traces.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "Lantern Run";

async function store() {
  const dir = await tmpDir("studio-moments-");
  const clock = heldClock();
  return { dir, clock, moments: createMomentStore({ dir, clock }) };
}

describe("model-check moments", () => {
  it("keeps a fitting answer of the creator's own playtest, request and answer", async () => {
    const fx = await store();
    const trace = traceOf();
    await fx.moments.remember(callerFor(CREATE_GAME), trace);
    const [moment] = await fx.moments.list(PROJECT);
    assert.deepEqual(moment?.request, trace.request);
    assert.deepEqual(moment?.value, trace.value);
    assert.deepEqual(moment?.model, trace.model);
    assert.equal(await fx.moments.count(PROJECT), 1);
  });

  const never: Array<[string, Parameters<ReturnType<typeof createMomentStore>["remember"]>]> = [
    ["a published game", [callerFor(PLAY_GAME), traceOf()]],
    ["a harness run", [callerFor(CREATE_GAME, { context: AiContext.HarnessRun }), traceOf()]],
    ["a replayed playtest", [callerFor(CREATE_GAME, { replaying: true }), traceOf()]],
    ["a tape's answer", [callerFor(CREATE_GAME), traceOf({ door: AiDoor.Tape })]],
    ["a fixture's answer", [callerFor(CREATE_GAME), traceOf({ door: AiDoor.Fixture })]],
    [
      "an answer that did not fit",
      [callerFor(CREATE_GAME), traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput })],
    ],
    ["a call with no answer", [callerFor(CREATE_GAME), traceOf({ validation: AiValidation.NoReply, value: null })]],
  ];
  for (const [name, [caller, trace]] of never)
    it(`never keeps ${name}`, async () => {
      const fx = await store();
      await fx.moments.remember(caller, trace);
      assert.equal(await fx.moments.count(PROJECT), 0);
    });

  it("keeps the newest answer to the same call once, and the newest moments only", async () => {
    const fx = await store();
    const create = callerFor(CREATE_GAME);
    await fx.moments.remember(create, traceOf({ value: { line: "old" } }));
    await fx.moments.remember(create, traceOf({ value: { line: "new" } }));
    assert.deepEqual(
      (await fx.moments.list(PROJECT)).map((moment) => moment.value),
      [{ line: "new" }],
    );
    for (let i = 0; i < MOMENTS_MAX_PER_GAME + 3; i += 1)
      await fx.moments.remember(create, traceOf({ request: requestOf({ prompt: `turn ${i}` }) }));
    const kept = await fx.moments.list(PROJECT);
    assert.equal(kept.length, MOMENTS_MAX_PER_GAME);
    assert.equal(kept.at(-1)?.request.prompt, `turn ${MOMENTS_MAX_PER_GAME + 2}`);
  });

  it("keeps each game apart, in play-time AI's own folder, never under the game's name", async () => {
    const fx = await store();
    await fx.moments.remember(callerFor(CREATE_GAME), traceOf());
    assert.equal(await fx.moments.count("Other Game"), 0);
    const files = await readdir(path.join(fx.dir, MOMENTS_DIR));
    assert.deepEqual(files, [path.basename(momentsFile(fx.dir, PROJECT))]);
    assert.match(files[0] ?? "", /^[0-9a-f]{64}\.json$/);
  });

  const hostile: Array<[string, string]> = [
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, moments: [] })],
    ["moments that are not a list", JSON.stringify({ v: 1, moments: {} })],
  ];
  for (const [name, text] of hostile)
    it(`reads a saved file that is ${name} as no moments`, async () => {
      const fx = await store();
      await fx.moments.remember(callerFor(CREATE_GAME), traceOf());
      await writeFile(momentsFile(fx.dir, PROJECT), text);
      assert.deepEqual(await fx.moments.list(PROJECT), []);
    });

  it("drops a saved moment whose request or answer is not one, and keeps the rest", async () => {
    const fx = await store();
    const good = traceOf();
    await fx.moments.remember(callerFor(CREATE_GAME), good);
    const file = momentsFile(fx.dir, PROJECT);
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.moments.push({ ...saved.moments[0], request: { ...saved.moments[0].request, prompt: "" } });
    saved.moments.push({ ...saved.moments[0], value: Number.NaN });
    saved.moments.push({ ...saved.moments[0], model: { door: "genex-credits", engine: 7, model: "x" } });
    await writeFile(file, JSON.stringify(saved));
    assert.equal((await fx.moments.list(PROJECT)).length, 1);
  });
});
