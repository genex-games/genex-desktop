/**
 * A game's crash record, `genex-crash/1` (`shared/crash-record.ts`, PROF-0c), read as hostile
 * input: a well-formed record is copied with only its known fields; one over its size or depth, of
 * another format, or with a field outside its vocabulary or shape is refused (null) without
 * throwing; overlong text and frames are cut and named in `trimmed`. Also the `game_crashed`
 * event's reader and the kinds a game's own process may send. All rows are new behaviour.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CRASH_FRAMES_MAX,
  CRASH_MESSAGE_MAX_BYTES,
  CRASH_PATH_MAX_CHARS,
  CRASH_RECORD_FORMAT,
  CRASH_RECORD_MAX_BYTES,
  CrashFlavour,
  CrashKind,
  CrashSource,
  CrashTrimmed,
  GAME_CRASH_KINDS,
  GameCrashesUnavailableReason,
  GpuErrorClass,
  WasmTrap,
  gameCrashedOf,
  gameCrashesUnavailable,
  isGameMadeRecord,
  parseCrashRecord,
} from "../../src/shared/crash-record.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

/** A panic record as genex-crash writes one (design-PROFILE section 3.5). */
const panic = {
  format: CRASH_RECORD_FORMAT,
  kind: CrashKind.Panic,
  source: CrashSource.Game,
  fatal: true,
  handled: false,
  message: "index out of bounds: the len is 3 but the index is 7",
  location: { file: "src/enemy.rs", line: 42, column: 17 },
  thread: { name: "main", main: true },
  frames: [{ ip: "0x1045a3f20" }, { ip: "0x1045a3e00" }],
  anchor: { ip: "0x1045a0000" },
  images: [],
  gpu: null,
  wasm: null,
  context: {
    seed: 1,
    tick: 300,
    frame: 312,
    simulatedMs: 5000,
    running: true,
    destination: "mac",
    flavour: CrashFlavour.Dev,
    build: "b1",
    contract: 2,
    genex: "0.1.0",
  },
  replay: { seed: 1, fromTick: 0, toTick: 300, complete: true, track: "AAEC" },
  profile: null,
  hitches: [4411],
  symbols: null,
};

const nest = (depth: number): unknown => {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) value = { a: value };
  return value;
};

describe("parseCrashRecord copies a well-formed record", () => {
  it("keeps every field it knows, drops the rest, and never takes symbols from the game", () => {
    const parsed = parseCrashRecord({ ...panic, extra: "dropped", symbols: { forged: true } });
    assert.ok(parsed);
    assert.equal(Object.hasOwn(parsed, "extra"), false);
    assert.equal(parsed.symbols, null);
    assert.deepEqual(parsed.frames, panic.frames);
    assert.equal(parsed.anchor, "0x1045a0000");
    assert.deepEqual(parsed.context, panic.context);
    assert.deepEqual(parsed.replay, panic.replay);
    assert.deepEqual(parsed.trimmed, []);
  });

  it("reads every kind and source, a GPU record, a web trap and a platform record's image frames", () => {
    for (const kind of Object.values(CrashKind))
      for (const source of Object.values(CrashSource))
        assert.equal(parseCrashRecord({ ...panic, kind, source })?.kind, kind, `${kind} ${source}`);
    const gpu = parseCrashRecord({
      ...panic,
      kind: CrashKind.GpuValidation,
      gpu: { class: GpuErrorClass.Validation, description: "bind group", backend: "metal", adapter: "Apple M2" },
    });
    assert.deepEqual(gpu?.gpu, {
      class: GpuErrorClass.Validation,
      reason: null,
      description: "bind group",
      backend: "metal",
      adapter: "Apple M2",
    });
    const trap = parseCrashRecord({
      ...panic,
      kind: CrashKind.WasmTrap,
      source: CrashSource.Shell,
      wasm: { trap: WasmTrap.Unreachable, stack: [{ func: 12, offset: 4096 }] },
    });
    assert.deepEqual(trap?.wasm, { trap: WasmTrap.Unreachable, stack: [{ func: 12, offset: 4096 }] });
    const platform = parseCrashRecord({
      ...panic,
      kind: CrashKind.NativeFault,
      source: CrashSource.Platform,
      images: [{ name: "Game", id: "8F3C2A10-0000-4000-8000-00000000ABCD" }],
      frames: [{ image: 0, offset: "0x1f20" }],
    });
    assert.deepEqual(platform?.frames, [{ image: 0, offset: "0x1f20" }]);
  });

  it("a host- or shell-made record may leave out what it never knew", () => {
    const hang = parseCrashRecord({
      format: CRASH_RECORD_FORMAT,
      kind: CrashKind.Hang,
      source: CrashSource.Host,
      fatal: true,
      handled: false,
      message: "",
    });
    assert.ok(hang);
    assert.deepEqual([hang.frames, hang.context, hang.replay, hang.location], [[], {}, null, null]);
  });
});

describe("parseCrashRecord refuses a hostile record whole, and never throws", () => {
  const rows: Array<[string, unknown]> = [
    ["65 KiB", { ...panic, message: "x".repeat(65 * 1024) }],
    ["depth 40", { ...panic, context: { ...panic.context, nested: nest(40) } }],
    ["an unknown kind", { ...panic, kind: "explosion" }],
    ["an unknown source", { ...panic, source: "player" }],
    ["a non-boolean fatal", { ...panic, fatal: "yes" }],
    ["a non-boolean handled", { ...panic, handled: 1 }],
    ["another format", { ...panic, format: "genex-crash/2" }],
    ["a non-hex ip", { ...panic, frames: [{ ip: "0xZZ" }] }],
    ["an ip as a number", { ...panic, frames: [{ ip: 4096 }] }],
    ["an over-long ip", { ...panic, frames: [{ ip: `0x${"f".repeat(17)}` }] }],
    ["an image frame naming no image", { ...panic, frames: [{ image: 0, offset: "0x10" }] }],
    ["a negative tick", { ...panic, context: { ...panic.context, tick: -1 } }],
    ["a fractional tick", { ...panic, context: { ...panic.context, tick: 1.5 } }],
    ["a seed past u32", { ...panic, context: { ...panic.context, seed: 2 ** 32 } }],
    ["an unknown flavour", { ...panic, context: { ...panic.context, flavour: "release" } }],
    ["a NaN simulated time", { ...panic, context: { ...panic.context, simulatedMs: Number.NaN } }],
    ["a message that is not text", { ...panic, message: 7 }],
    ["a location line that is not a count", { ...panic, location: { ...panic.location, line: "42" } }],
    ["a replay running backwards", { ...panic, replay: { ...panic.replay, fromTick: 400 } }],
    ["a replay track that is not base64", { ...panic, replay: { ...panic.replay, track: "<script>" } }],
    ["an unknown GPU class", { ...panic, gpu: { class: "fatal", description: "x" } }],
    ["an unknown trap", { ...panic, wasm: { trap: "kaboom", stack: [] } }],
    ["a hitch that is not a count", { ...panic, hitches: [-3] }],
    ["an array", [panic]],
    ["text", JSON.stringify(panic)],
  ];
  for (const [name, value] of rows)
    it(`refuses ${name}`, () => {
      assert.doesNotThrow(() => parseCrashRecord(value));
      assert.equal(parseCrashRecord(value), null);
    });

  it("refuses null, undefined, numbers and a cycle without throwing", () => {
    const cycle: Record<string, unknown> = { ...panic };
    cycle.context = cycle;
    for (const value of [null, undefined, 0, Number.NaN, true, cycle])
      assert.equal(parseCrashRecord(value), null, String(value));
  });

  it("a record of exactly the cap parses; one byte more does not", () => {
    const base = JSON.stringify({ ...panic, message: "" });
    const fill = CRASH_RECORD_MAX_BYTES - new TextEncoder().encode(base).byteLength;
    // The message is cut to 2 KiB; the size cap reads the record as sent, so pad a dropped field.
    const at = { ...panic, message: "", pad: "y".repeat(fill - '"pad":"",'.length) };
    assert.equal(new TextEncoder().encode(JSON.stringify(at)).byteLength, CRASH_RECORD_MAX_BYTES);
    assert.ok(parseCrashRecord(at));
    assert.equal(parseCrashRecord({ ...at, pad: `${at.pad}y` }), null);
  });
});

describe("parseCrashRecord cuts what is only too long, and says so", () => {
  it("cuts a 5 KiB location.file to its cap", () => {
    const parsed = parseCrashRecord({ ...panic, location: { ...panic.location, file: "a/".repeat(2560) } });
    assert.equal(parsed?.location?.file.length, CRASH_PATH_MAX_CHARS);
    assert.deepEqual(parsed?.trimmed, [CrashTrimmed.LocationFile]);
  });

  it("keeps the top 128 of 129 frames", () => {
    const frames = Array.from({ length: CRASH_FRAMES_MAX + 1 }, (_, i) => ({ ip: `0x${(i + 1).toString(16)}` }));
    const parsed = parseCrashRecord({ ...panic, frames });
    assert.equal(parsed?.frames.length, CRASH_FRAMES_MAX);
    assert.deepEqual(parsed?.frames[0], { ip: "0x1" });
    assert.deepEqual(parsed?.trimmed, [CrashTrimmed.Frames]);
  });

  it("cuts a message to 2 KiB of UTF-8 on a character boundary", () => {
    const parsed = parseCrashRecord({ ...panic, message: "é".repeat(CRASH_MESSAGE_MAX_BYTES) });
    const bytes = new TextEncoder().encode(parsed?.message ?? "").byteLength;
    assert.ok(bytes <= CRASH_MESSAGE_MAX_BYTES && bytes >= CRASH_MESSAGE_MAX_BYTES - 1, String(bytes));
    assert.equal(parsed?.message.includes("�"), false);
    assert.deepEqual(parsed?.trimmed, [CrashTrimmed.Message]);
  });

  it("drops a replay track over 24 KiB as incomplete, and a profile outside its shape, but keeps the record", () => {
    const track = "A".repeat(33_000);
    const parsed = parseCrashRecord({ ...panic, replay: { ...panic.replay, track }, profile: { v: 9 } });
    assert.deepEqual(parsed?.replay, { ...panic.replay, complete: false, track: "" });
    assert.equal(parsed?.profile, null);
    assert.deepEqual(parsed?.trimmed, [CrashTrimmed.Profile, CrashTrimmed.ReplayTrack]);
  });

  it("keeps what the writer said it trimmed, and drops trim names it does not know", () => {
    const parsed = parseCrashRecord({ ...panic, trimmed: [CrashTrimmed.Profile, "everything"] });
    assert.deepEqual(parsed?.trimmed, [CrashTrimmed.Profile]);
  });
});

describe("who may send what", () => {
  it("a game's own process sends only its panic hook's kinds, as the game", () => {
    assert.deepEqual(GAME_CRASH_KINDS, [CrashKind.Panic, CrashKind.GpuValidation, CrashKind.DeviceLost]);
    for (const kind of Object.values(CrashKind))
      for (const source of Object.values(CrashSource)) {
        const parsed = parseCrashRecord({ ...panic, kind, source });
        assert.ok(parsed);
        const expected: boolean = source === CrashSource.Game && GAME_CRASH_KINDS.some((member) => member === kind);
        assert.equal(isGameMadeRecord(parsed), expected, `${kind} ${source}`);
      }
  });

  it("names the wire's vocabularies", () => {
    assert.deepEqual(Object.values(CrashKind), [
      "panic",
      "gpu-validation",
      "device-lost",
      "wasm-trap",
      "native-fault",
      "out-of-memory",
      "hang",
      "process-exit",
    ]);
    assert.deepEqual(Object.values(CrashSource), ["game", "shell", "platform", "host"]);
    assert.equal(CRASH_RECORD_FORMAT, "genex-crash/1");
    assert.deepEqual(gameCrashesUnavailable(), {
      state: "unavailable",
      reason: GameCrashesUnavailableReason.NotServed,
    });
  });
});

describe("the game_crashed event", () => {
  const envelope = (eventType: string, payload: Record<string, unknown> | undefined): EventEnvelope => ({
    id: "e1",
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-10-20T00:00:00.000Z",
    data: { type: "custom", event_type: eventType, payload },
  });

  it("reads its payload, and nothing from another event", () => {
    const payload = { project: "p", crashId: "c1", kind: CrashKind.Panic, fatal: true, tick: 300, repeat: 2 };
    assert.deepEqual(gameCrashedOf(envelope(CustomEvent.GameCrashed, payload)), payload);
    assert.equal(gameCrashedOf(envelope(CustomEvent.DeviceLaunch, payload)), null);
  });

  it("reads an old or partial payload, a kind it does not know as absent", () => {
    assert.deepEqual(gameCrashedOf(envelope(CustomEvent.GameCrashed, undefined)), {});
    assert.deepEqual(gameCrashedOf(envelope(CustomEvent.GameCrashed, { crashId: "c", kind: "meteor" })), {
      crashId: "c",
    });
  });
});
