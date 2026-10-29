import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVER_MAKING_MS,
  type CoverAskMemory,
  CoverKind,
  coverMinutesLeft,
  readCoverAsks,
  rememberCoverAsk,
  settleCoverAsk,
  writeCoverAsks,
} from "../../src/renderer/panels/plugins/genex/cover-asks.ts";
import type { GenexCoverRecord } from "../../src/shared/genex.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { storageKeyFor, type KeyValueStorage } from "../../src/renderer/storage.ts";
import { GENEX_WORDS } from "../../src/renderer/words.ts";
import { CaptureSource, StillMimeType } from "../../src/shared/preview-contract.ts";

const AT = Date.parse("2026-10-20T19:00:00.000Z");
const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();

const shot = (sha256: string, takenAt: number) => ({
  sha256,
  width: 1920,
  height: 1080,
  mimeType: StillMimeType.Jpeg,
  bytes: 1024,
  source: CaptureSource.Page,
  stats: { lumaMean: 0.4, lumaStdDev: 0.2, nearBlackFraction: 0.1, litFraction: 0.9 },
  takenAt: iso(takenAt),
});
const clip = (sha256: string, takenAt: number) => ({
  sha256,
  mimeType: "video/webm",
  bytes: 1024,
  width: 960,
  height: 540,
  durationMs: 5000,
  motion: 0.5,
  takenAt: iso(takenAt),
});
const record = (over: Partial<GenexCoverRecord> = {}): GenexCoverRecord => ({
  shot: shot(OLD, AT - MINUTE_MS),
  last: null,
  sending: false,
  ...over,
});
const asked = (kind: CoverKind = CoverKind.Picture, took: CoverAskMemory["took"] = {}): CoverAskMemory => ({
  ask: { kind, from: OLD, at: AT },
  took,
});

test("a frame the agent took after the ask answers it: how long it took is kept for that kind", () => {
  const studioTake = record({ shot: shot(NEW, AT + 30 * SECOND_MS), agentTook: {} });
  const waiting = asked();
  assert.equal(settleCoverAsk(waiting, studioTake, AT + MINUTE_MS), waiting, "Studio's own new frame answers nothing");
  const earlier = record({ shot: shot(NEW, AT - SECOND_MS), agentTook: { shot: iso(AT - SECOND_MS) } });
  assert.equal(settleCoverAsk(waiting, earlier, AT + MINUTE_MS), waiting, "the agent's frame from before the ask");
  const agent = record({ shot: shot(NEW, AT + 200 * SECOND_MS), agentTook: { shot: iso(AT + 150 * SECOND_MS) } });
  assert.deepEqual(
    settleCoverAsk(waiting, agent, AT + 10 * MINUTE_MS),
    { ask: null, took: { [CoverKind.Picture]: 150 * SECOND_MS } },
    "timed by the agent's frame, though Studio took another after it",
  );
  const clipAsk = { ask: { kind: CoverKind.Clip, from: OLD, at: AT }, took: { [CoverKind.Picture]: 60 * SECOND_MS } };
  assert.equal(
    settleCoverAsk(clipAsk, record({ agentTook: { shot: iso(AT + 30 * SECOND_MS) } }), AT + MINUTE_MS),
    clipAsk,
    "the agent's new shot does not answer a clip",
  );
  assert.deepEqual(
    settleCoverAsk(clipAsk, record({ agentTook: { clip: iso(AT + 90 * SECOND_MS) } }), AT + 2 * MINUTE_MS),
    { ask: null, took: { [CoverKind.Picture]: 60 * SECOND_MS, [CoverKind.Clip]: 90 * SECOND_MS } },
    "a clip's time is its own",
  );
  assert.deepEqual(
    settleCoverAsk(waiting, record({ agentTook: { shot: iso(AT + COVER_MAKING_MS) } }), AT + COVER_MAKING_MS),
    { ask: null, took: {} },
    "an answer past the wait ends the ask untimed",
  );
});

test("a waiting ask stays until the agent's frame comes, and is dropped unmeasured after a while", () => {
  const waiting = asked(CoverKind.Picture, { [CoverKind.Picture]: 2 * MINUTE_MS });
  const nothingYet = record({ agentTook: {} });
  assert.equal(settleCoverAsk(waiting, nothingYet, AT + MINUTE_MS), waiting, "nothing changes");
  assert.deepEqual(
    settleCoverAsk(waiting, nothingYet, AT + COVER_MAKING_MS),
    { ask: null, took: { [CoverKind.Picture]: 2 * MINUTE_MS } },
    "given up: the last time stays",
  );
  const none = { ask: null, took: {} };
  assert.equal(settleCoverAsk(none, nothingYet, AT), none, "nothing asked");
});

test("from a plugin that does not say who took a frame, any new frame of the kind answers", () => {
  const waiting = asked();
  assert.equal(settleCoverAsk(waiting, record(), AT + MINUTE_MS), waiting, "same frame: nothing changes");
  assert.equal(
    settleCoverAsk(waiting, record({ clip: clip(NEW, AT + 30 * SECOND_MS) }), AT + MINUTE_MS),
    waiting,
    "a new clip does not answer a picture",
  );
  assert.deepEqual(settleCoverAsk(waiting, record({ shot: shot(NEW, AT + 150 * SECOND_MS) }), AT + 10 * MINUTE_MS), {
    ask: null,
    took: { [CoverKind.Picture]: 150 * SECOND_MS },
  });
  const first = { ask: { kind: CoverKind.Picture, from: null, at: AT }, took: {} };
  assert.deepEqual(
    settleCoverAsk(first, record({ shot: shot(NEW, AT + 40 * SECOND_MS) }), AT + MINUTE_MS),
    { ask: null, took: { [CoverKind.Picture]: 40 * SECOND_MS } },
    "asked with no frame yet, the first one answers",
  );
  const cases = [
    { name: "taken before the ask", takenAt: iso(AT - SECOND_MS) },
    { name: "taken past the wait", takenAt: iso(AT + COVER_MAKING_MS) },
    { name: "no readable time", takenAt: "soon" },
  ];
  for (const { name, takenAt } of cases) {
    const arrived = record({ shot: { ...shot(NEW, AT), takenAt } });
    assert.deepEqual(settleCoverAsk(waiting, arrived, AT + MINUTE_MS), { ask: null, took: {} }, name);
  }
});

test("minutes left come from the last time only, rounded up, and none once it runs over", () => {
  const took = 150 * SECOND_MS;
  assert.equal(coverMinutesLeft(took, 0), 3);
  assert.equal(coverMinutesLeft(took, 30 * SECOND_MS), 2);
  assert.equal(coverMinutesLeft(took, 149 * SECOND_MS), 1);
  assert.equal(coverMinutesLeft(took, took), null, "ran over: no number");
  assert.equal(coverMinutesLeft(took, took + MINUTE_MS), null);
  assert.equal(coverMinutesLeft(undefined, 0), null, "never measured: no number");
  assert.equal(GENEX_WORDS.publish.coverLeft(2), "~2 min");
});

/** A storage over a map, holding what each key was last given. */
function memoryStorage(): KeyValueStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

test("a game's asks are kept under its own key and read back", () => {
  const storage = memoryStorage();
  const memory = asked(CoverKind.Clip, { [CoverKind.Picture]: 70 * SECOND_MS });
  writeCoverAsks("snow-game", memory, storage);
  assert.ok(storage.items.has(storageKeyFor.coverAsks("snow-game")));
  assert.deepEqual(readCoverAsks("snow-game", storage), memory);
  assert.deepEqual(readCoverAsks("other-game", storage), { ask: null, took: {} }, "another game asked nothing");
});

test("an ask is kept once the chat sent it, beside the times already kept", () => {
  const storage = memoryStorage();
  writeCoverAsks("snow-game", { ask: null, took: { [CoverKind.Clip]: 80 * SECOND_MS } }, storage);
  const ask = { kind: CoverKind.Picture, from: OLD, at: AT };
  assert.deepEqual(rememberCoverAsk("snow-game", ask, storage), { ask, took: { [CoverKind.Clip]: 80 * SECOND_MS } });
  assert.deepEqual(readCoverAsks("snow-game", storage), { ask, took: { [CoverKind.Clip]: 80 * SECOND_MS } });
});

test("a kept value that is not an ask reads as nothing asked, and keeps what is sound", () => {
  const key = storageKeyFor.coverAsks("snow-game");
  const sound = { kind: CoverKind.Picture, from: OLD, at: AT };
  const rows: Array<{ name: string; raw: string; want: CoverAskMemory }> = [
    { name: "not JSON", raw: "{", want: { ask: null, took: {} } },
    { name: "an array", raw: "[]", want: { ask: null, took: {} } },
    { name: "null", raw: "null", want: { ask: null, took: {} } },
    { name: "unknown kind", raw: JSON.stringify({ ask: { ...sound, kind: "movie" } }), want: { ask: null, took: {} } },
    { name: "time as text", raw: JSON.stringify({ ask: { ...sound, at: "now" } }), want: { ask: null, took: {} } },
    { name: "frame as a number", raw: JSON.stringify({ ask: { ...sound, from: 7 } }), want: { ask: null, took: {} } },
    {
      name: "bad times dropped, a sound one kept",
      raw: JSON.stringify({ ask: sound, took: { picture: -5, clip: 90_000, movie: 3 } }),
      want: { ask: sound, took: { [CoverKind.Clip]: 90_000 } },
    },
    {
      name: "a time past the wait",
      raw: JSON.stringify({ took: { picture: COVER_MAKING_MS, clip: Number.MAX_VALUE } }),
      want: { ask: null, took: {} },
    },
  ];
  for (const { name, raw, want } of rows) {
    const storage = memoryStorage();
    storage.items.set(key, raw);
    assert.deepEqual(readCoverAsks("snow-game", storage), want, name);
  }
  assert.deepEqual(readCoverAsks("snow-game", null), { ask: null, took: {} }, "no storage at all");
});
