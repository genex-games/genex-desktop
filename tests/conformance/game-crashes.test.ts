/**
 * Host crash intake (game-systems CRASH-5): a run's crash record is kept under the game's own
 * `.studio/crashes/` (by a name the host chose, never one from the record), deduplicated by
 * signature with a `repeat` count, pruned to `GAME_CRASHES_MAX`, announced once as `game_crashed`
 * and listed by `game.crashes`. A run the host killed for a call timeout gets a host-made `hang`
 * record; an abnormal exit that sent none gets `process-exit`. Hostile tables assert no side
 * effect. The games are in memory behind the real port; time is a fake clock.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import {
  CrashKind,
  CrashSource,
  type CrashRecordV1,
  GAME_CRASHES_MAX,
  type GameCrashedPayload,
  parseCrashRecord,
} from "../../src/shared/crash-record.ts";
import { chatActivity } from "../../src/shared/chat-activity.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_HEARTBEAT_MS,
  NATIVE_LINE_MAX_BYTES,
  NativeEvent,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import {
  crashIdOf,
  createGameCrashStore,
  crashWire,
  type GameCrashStore,
  hostCrashRecord,
  readGameCrashes,
} from "../../src/main/core/game-crashes.ts";
import type { CrashBuild } from "../../src/main/core/crash-symbolicate.ts";
import { refuseHostRecords } from "../../src/main/core/harness-events.ts";
import { NativeRuns } from "../../src/main/core/native-runs.ts";
import { gameCrashes } from "../../src/main/harness-rpc/game-crashes.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameExit, GameSpawnRequest } from "../../src/substrate/spawn.ts";
import { EntryKind, SystemTag, toEntries } from "../../src/renderer/chat-entries.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" ? "not run: the planted links are POSIX" : false;
const RUN_A = "0123456789ab";
const RUN_B = "abcdef012345";
const AT = Date.parse("2026-10-21T04:00:00.000Z");

/** A game's panic record on the wire, `line` placing it (a different line is a different signature). */
function panicWire(line = 42, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "genex-crash/1",
    kind: "panic",
    source: "game",
    fatal: true,
    handled: false,
    message: "index out of bounds: the len is 3 but the index is 7",
    location: { file: "src/enemy.rs", line, column: 17 },
    frames: [{ ip: "0x1045a3f20" }, { ip: "0x1045a3e00" }],
    anchor: { ip: "0x1045a0000" },
    context: { seed: 1, tick: 300, destination: "mac", flavour: "dev" },
    ...extra,
  };
}

function panic(line = 42, extra: Record<string, unknown> = {}): CrashRecordV1 {
  const record = parseCrashRecord(panicWire(line, extra));
  assert.ok(record, "the fixture is a valid record");
  return record;
}

/** Every entry under `dir` (links not followed): its kind, and a regular file's bytes. */
async function listing(dir: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const info = await lstat(path.join(dir, name));
    if (info.isFile()) entries.push(`${name} file ${(await readFile(path.join(dir, name))).toString("hex")}`);
    else if (info.isDirectory()) entries.push(`${name} dir`);
    else entries.push(`${name} ${info.isSymbolicLink() ? "link" : "other"}`);
  }
  return entries;
}

/** A game folder, a store over it, and what the store announced. */
async function storeRig(options: { now?: () => number } = {}) {
  const root = await tmpDir("game-crashes-");
  const game = path.join(root, "pong");
  await mkdir(game);
  const announced: GameCrashedPayload[] = [];
  const logged: string[] = [];
  let clock = AT;
  const store = createGameCrashStore({
    gameDir: async (project) => path.join(root, project),
    announce: async (payload) => {
      announced.push(payload);
    },
    now: options.now ?? (() => clock++),
    log: (line) => logged.push(line),
  });
  return { root, game, store, announced, logged, crashes: path.join(game, ".studio", "crashes") };
}

describe("keeping a crash record (CRASH-5)", () => {
  it("writes the record under the game's .studio/crashes by the host's own name and announces it once", async () => {
    const r = await storeRig();
    const kept = await r.store.keep({ project: "pong", runId: RUN_A }, panic());
    assert.ok(kept);
    assert.equal(kept.crashId, crashIdOf(RUN_A));
    assert.equal(kept.repeat, 1);
    assert.deepEqual(await readdir(r.crashes), [`${crashIdOf(RUN_A)}.json`]);
    assert.equal(r.announced.length, 1);
    assert.deepEqual(r.announced[0], {
      project: "pong",
      runId: RUN_A,
      crashId: crashIdOf(RUN_A),
      kind: CrashKind.Panic,
      source: CrashSource.Game,
      fatal: true,
      handled: false,
      tick: 300,
      seed: 1,
      destination: "mac",
      location: { file: "src/enemy.rs", line: 42, column: 17 },
      symbolicated: false,
      repeat: 1,
    });
    const listed = await readGameCrashes(r.game, {});
    assert.equal(listed.records.length, 1);
    assert.deepEqual(listed.records[0]?.record, panic());
  });

  it("the same signature twice keeps one file with repeat 2, and game_crashed lands once per crash", async () => {
    const r = await storeRig();
    await r.store.keep({ project: "pong", runId: RUN_A }, panic(42));
    // A later run of the same build: other addresses (ASLR), the same distance from the anchor.
    const moved = panic(42, {
      frames: [{ ip: "0x2045a3f20" }, { ip: "0x2045a3e00" }],
      anchor: { ip: "0x2045a0000" },
    });
    const second = await r.store.keep({ project: "pong", runId: RUN_B }, moved);
    assert.equal(second?.repeat, 2);
    assert.deepEqual(await readdir(r.crashes), [`${crashIdOf(RUN_B)}.json`]);
    assert.deepEqual(
      r.announced.map((payload) => [payload.crashId, payload.repeat]),
      [
        [crashIdOf(RUN_A), 1],
        [crashIdOf(RUN_B), 2],
      ],
    );
    const listed = await readGameCrashes(r.game, {});
    assert.deepEqual(
      listed.records.map((entry) => [entry.crashId, entry.runId, entry.repeat]),
      [[crashIdOf(RUN_B), RUN_B, 2]],
    );
  });

  it(`the ${GAME_CRASHES_MAX + 1}th record prunes the oldest`, async () => {
    const r = await storeRig();
    const runIds = Array.from({ length: GAME_CRASHES_MAX + 1 }, (_, n) => n.toString(16).padStart(12, "0"));
    for (const [n, runId] of runIds.entries()) await r.store.keep({ project: "pong", runId }, panic(100 + n));
    const names = (await readdir(r.crashes)).sort();
    assert.equal(names.length, GAME_CRASHES_MAX);
    assert.ok(!names.includes(`${crashIdOf(runIds[0] ?? "")}.json`), "the oldest went");
    assert.ok(names.includes(`${crashIdOf(runIds.at(-1) ?? "")}.json`), "the newest stays");
    const listed = await readGameCrashes(r.game, {});
    assert.equal(listed.records[0]?.runId, runIds.at(-1), "newest first");
  });

  it("hostile table: a link out of the game, or a run id that is a path, writes nothing and announces nothing", {
    skip: POSIX_ONLY,
  }, async () => {
    const cases: Array<[string, (rig: Awaited<ReturnType<typeof storeRig>>, outside: string) => Promise<void>]> = [
      ["`.studio` a link out of the game", (rig, outside) => symlink(outside, path.join(rig.game, ".studio"))],
      [
        "`.studio/crashes` a link out of the game",
        async (rig, outside) => {
          await mkdir(path.join(rig.game, ".studio"));
          await symlink(outside, rig.crashes);
        },
      ],
    ];
    for (const [label, plant] of cases) {
      const r = await storeRig();
      const outside = path.join(r.root, "outside");
      await mkdir(outside);
      await plant(r, outside);
      const before = await listing(r.root);
      assert.equal(await r.store.keep({ project: "pong", runId: RUN_A }, panic()), null, label);
      assert.deepEqual(await listing(r.root), before, `${label}: nothing written`);
      assert.deepEqual(await readdir(outside), [], `${label}: nothing outside`);
      assert.deepEqual(r.announced, [], `${label}: nothing announced`);
      assert.equal(r.logged.length, 1, `${label}: the refusal is logged`);
    }
    for (const runId of ["../../evil", "0123456789ab/../x", "", "ABCDEF012345"]) {
      const r = await storeRig();
      assert.equal(await r.store.keep({ project: "pong", runId }, panic()), null, runId);
      assert.deepEqual(await listing(r.game), [], `${runId}: nothing written`);
      assert.deepEqual(r.announced, []);
    }
  });

  it("hostile table: a record's location.file or build naming ../ never names a file", async () => {
    for (const file of ["../../../evil.json", "/etc/passwd", "..\\..\\x.json", "src/../../.studio/crashes/x.json"]) {
      const r = await storeRig();
      const record = panic(42, { location: { file, line: 1, column: 1 }, context: { build: "../../x" } });
      await r.store.keep({ project: "pong", runId: RUN_A }, record);
      assert.deepEqual(await readdir(r.crashes), [`${crashIdOf(RUN_A)}.json`], file);
      assert.deepEqual(await listing(r.root).then((rows) => rows.map((row) => row.split(" ")[0])), [
        "pong",
        path.join("pong", ".studio"),
        path.join("pong", ".studio", "crashes"),
        path.join("pong", ".studio", "crashes", `${crashIdOf(RUN_A)}.json`),
      ]);
    }
  });
});

describe("listing a game's crash records (game.crashes)", () => {
  it("answers no records for a game that never crashed, newest first otherwise, filtered by since and id", async () => {
    const r = await storeRig();
    assert.deepEqual(await readGameCrashes(r.game, {}), { records: [] });
    await r.store.keep({ project: "pong", runId: RUN_A }, panic(1));
    await r.store.keep({ project: "pong", runId: RUN_B }, panic(2));
    const all = await readGameCrashes(r.game, {});
    assert.deepEqual(
      all.records.map((entry) => entry.runId),
      [RUN_B, RUN_A],
    );
    const since = all.records[1]?.at ?? "";
    assert.deepEqual(
      (await readGameCrashes(r.game, { since })).records.map((entry) => entry.runId),
      [RUN_B],
    );
    assert.deepEqual(
      (await readGameCrashes(r.game, { id: crashIdOf(RUN_A) })).records.map((entry) => entry.runId),
      [RUN_A],
    );
    assert.deepEqual(await readGameCrashes(r.game, { id: "../x" }), { records: [] });
  });

  it("hostile table: a file that is not an entry, a link, or a folder of links is never read as a record", {
    skip: POSIX_ONLY,
  }, async () => {
    const r = await storeRig();
    await r.store.keep({ project: "pong", runId: RUN_A }, panic());
    const outside = path.join(r.root, "outside.json");
    const entry = await readFile(path.join(r.crashes, `${crashIdOf(RUN_A)}.json`), "utf8");
    await writeFile(outside, entry);
    await symlink(outside, path.join(r.crashes, `${crashIdOf(RUN_B)}.json`));
    await writeFile(path.join(r.crashes, "ffffffffffff-1.json"), "{not json");
    await writeFile(path.join(r.crashes, "eeeeeeeeeeee-1.json"), JSON.stringify({ crashId: "x", record: {} }));
    // An entry copied under another name: its crash id is not its file's.
    await writeFile(path.join(r.crashes, "dddddddddddd-1.json"), entry);
    assert.deepEqual(
      (await readGameCrashes(r.game, {})).records.map((item) => item.crashId),
      [crashIdOf(RUN_A)],
    );
    const linked = await storeRig();
    await mkdir(path.join(linked.game, ".studio"));
    await symlink(r.crashes, linked.crashes);
    assert.deepEqual(await readGameCrashes(linked.game, {}), { records: [] }, "a linked folder is read as empty");
  });
});

describe("the harness's game.crashes", () => {
  it("reads a listed game's records, refuses a game outside the library, and never opens a path from its params", async () => {
    const r = await storeRig();
    await r.store.keep({ project: "pong", runId: RUN_A }, panic());
    const allowed: string[] = [];
    const core = {
      games: { dirFor: (project: string) => path.join(r.root, project) },
      assertProjectAllowed: async (dir: string) => {
        allowed.push(dir);
      },
    } as unknown as Parameters<typeof gameCrashes>[0];
    const x = {
      assertHarnessRoot: async (project: string) => {
        if (project !== "pong") throw new Error(`"${project}" is not in the library`);
        return null;
      },
    };
    const answer = await gameCrashes(core, x, { project: "pong" });
    assert.deepEqual(
      answer.records.map((entry) => entry.crashId),
      [crashIdOf(RUN_A)],
    );
    assert.deepEqual(allowed, [r.game], "the game's folder is checked against the allowed root");
    for (const id of ["../../outside", `${crashIdOf(RUN_A)}/../x`, "/etc/passwd"])
      assert.deepEqual(await gameCrashes(core, x, { project: "pong", id }), { records: [] }, id);
    await assert.rejects(gameCrashes(core, x, { project: "other" }), /not in the library/);
  });
});

describe("records the host makes", () => {
  it("a run killed for a call timeout is a hang; an abnormal exit is a process-exit naming its signal", () => {
    const hang = hostCrashRecord(
      { state: NativeRunState.Killed, refusal: NativeRefusal.Unresponsive, exit: { code: null, signal: "SIGKILL" } },
      { destination: BuildTarget.Mac, tick: 812 },
    );
    assert.equal(hang?.kind, CrashKind.Hang);
    assert.equal(hang?.source, CrashSource.Host);
    assert.equal(hang?.context.tick, 812);
    const gpu = hostCrashRecord(
      { state: NativeRunState.Killed, refusal: NativeRefusal.GpuHang, exit: null },
      { destination: BuildTarget.Mac },
    );
    assert.equal(gpu?.kind, CrashKind.Hang);
    const abort = hostCrashRecord(
      { state: NativeRunState.Crashed, refusal: null, exit: { code: 134, signal: null } },
      { destination: BuildTarget.Mac },
    );
    assert.equal(abort?.kind, CrashKind.ProcessExit);
    assert.match(abort?.message ?? "", /SIGABRT/);
    assert.match(abort?.message ?? "", /134/);
    const segv = hostCrashRecord(
      { state: NativeRunState.Crashed, refusal: null, exit: { code: null, signal: "SIGSEGV" } },
      { destination: BuildTarget.Linux },
    );
    assert.match(segv?.message ?? "", /SIGSEGV/);
    for (const record of [hang, gpu, abort, segv])
      assert.deepEqual(parseCrashRecord(crashWire(record as CrashRecordV1)), record, "a host record is a valid record");
  });

  it("a stop, a clean exit or a protocol kill makes no record", () => {
    for (const ending of [
      { state: NativeRunState.Stopped, refusal: null, exit: { code: 0, signal: null } },
      { state: NativeRunState.Killed, refusal: null, exit: { code: null, signal: "SIGKILL" } },
      { state: NativeRunState.Killed, refusal: NativeRefusal.ReplyInvalid, exit: null },
      { state: NativeRunState.Killed, refusal: NativeRefusal.ReplyTooLarge, exit: null },
      { state: NativeRunState.Refused, refusal: NativeRefusal.BuildFailed, exit: null },
    ])
      assert.equal(hostCrashRecord(ending, { destination: BuildTarget.Mac }), null, JSON.stringify(ending));
  });
});

// ── the registry: a run's record handed to the store as it ends ─────────────────────────────

function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      due.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
  };
  const settle = async () => {
    for (let round = 0; round < 8; round++) await tick();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = next[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, advance, settle };
}

/** A game in memory: ready with the spawn's nonce, `state` answered unless `silent`. */
function memoryGame(request: GameSpawnRequest, silent: boolean) {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  let reap: (exit: GameExit) => void = () => {};
  const exited = new Promise<GameExit>((done) => {
    reap = done;
  });
  const send = (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`);
  let buffered = "";
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const { id, op } = JSON.parse(buffered.slice(0, end)) as { id: number; op: string };
      buffered = buffered.slice(end + 1);
      if (op === "state" && !silent) send({ id, ok: true, op, result: { tick: 640 } });
    }
  });
  const child: GameChild = {
    pid: 7000,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited,
    kill: (signal) => {
      if (signal === "SIGKILL") setImmediate(() => reap({ code: null, signal }));
    },
  };
  setImmediate(() =>
    send({
      event: NativeEvent.Ready,
      nonce: request.nonce,
      protocol: 1,
      contractVersion: 1,
      build: "test",
      backend: { api: "metal-angle", device: "Apple M4" },
      size: { width: 64, height: 64 },
      seed: 0,
    }),
  );
  return { child, send, raw: (text: string) => fromGame.write(text), reap };
}

/** A registry over one game, its records kept by a real store in a temp game folder. */
async function runsRig(options: { silent?: boolean; store?: boolean; crashBuild?: CrashBuild } = {}) {
  const r = await storeRig();
  const clock = fakeClock();
  const games: Array<ReturnType<typeof memoryGame>> = [];
  const statuses: NativeRunStatus[] = [];
  const kept: Array<Promise<unknown>> = [];
  const keptRuns: Array<Parameters<GameCrashStore["keep"]>[0]> = [];
  const store: GameCrashStore = {
    keep: (run, record) => {
      keptRuns.push(run);
      const keeping = r.store.keep(run, record);
      kept.push(keeping);
      return keeping;
    },
  };
  const runs = new NativeRuns({
    root: await tmpDir("game-crashes-runs-"),
    timers: clock.timers,
    prepare: async (request) => {
      const runDir = path.join(r.root, "runs", request.runId);
      await mkdir(path.join(runDir, "state"), { recursive: true });
      return {
        runId: request.runId,
        runDir,
        exe: "game",
        bundle: runDir,
        state: path.join(runDir, "state"),
        bundleId: null,
        ...(options.crashBuild ? { crashBuild: options.crashBuild } : {}),
      };
    },
    spawn: async (request) => {
      const game = memoryGame(request, options.silent === true);
      games.push(game);
      return game.child;
    },
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async () => Buffer.alloc(0) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
    },
    sampleFootprint: async () => 1024,
    descendants: async () => [],
    startedAt: async () => null,
    signal: () => {},
    crashes: options.store === false ? null : store,
  });
  /** Starts one more run of the game and answers its game once it is ready. */
  const startRun = async () => {
    await runs.start({ project: "pong", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    await clock.settle();
    const started = games.at(-1);
    assert.ok(started);
    return started;
  };
  const proc = await startRun();
  const ended = async () => {
    await clock.settle();
    await Promise.all(kept);
    return statuses.at(-1);
  };
  return { ...r, runs, clock, proc, statuses, kept, keptRuns, ended, startRun };
}

describe("a run's crash as it ends (native-runs and the port)", () => {
  it("a game's crash record then its exit: the status names the record and the store keeps it", async () => {
    const r = await runsRig();
    r.proc.send({ event: "crash", record: panicWire() });
    await r.clock.settle();
    r.proc.reap({ code: 101, signal: null });
    const last = await r.ended();
    assert.equal(last?.state, NativeRunState.Crashed);
    const runId = last?.runId ?? "";
    assert.deepEqual(last?.crash, { crashId: crashIdOf(runId), kind: CrashKind.Panic });
    assert.deepEqual(await readdir(r.crashes), [`${crashIdOf(runId)}.json`]);
    assert.equal(r.announced.length, 1, "game_crashed lands once");
    assert.equal((await readGameCrashes(r.game, {})).records[0]?.record.kind, CrashKind.Panic);
  });

  it("a crashed run hands the store the build it prepared, so the record is named from that build (CRASH-7b)", async () => {
    const crashBuild = { output: "/builds/pong/mac-1.out", exe: "game", digest: "c".repeat(64) };
    const r = await runsRig({ crashBuild });
    r.proc.send({ event: "crash", record: panicWire() });
    await r.clock.settle();
    r.proc.reap({ code: 101, signal: null });
    const last = await r.ended();
    assert.deepEqual(r.keptRuns, [{ project: "pong", runId: last?.runId, build: crashBuild }]);
    const bare = await runsRig();
    bare.proc.reap({ code: 134, signal: null });
    await bare.ended();
    assert.equal(bare.keptRuns[0]?.build, null, "a run whose prepare named no build hands none");
  });

  it("a run killed for a call timeout gets one hang record", async () => {
    const r = await runsRig({ silent: true });
    await r.clock.advance(NATIVE_HEARTBEAT_MS * 2);
    const last = await r.ended();
    assert.equal(last?.refusal, NativeRefusal.Unresponsive);
    assert.equal(last?.crash?.kind, CrashKind.Hang);
    const records = (await readGameCrashes(r.game, {})).records;
    assert.equal(records.length, 1, "one hang record");
    assert.equal(records[0]?.record.source, CrashSource.Host);
    assert.equal(r.announced.length, 1);
  });

  it("an exit 134 with no record gets a process-exit record naming SIGABRT", async () => {
    const r = await runsRig();
    r.proc.reap({ code: 134, signal: null });
    const last = await r.ended();
    assert.equal(last?.crash?.kind, CrashKind.ProcessExit);
    const record = (await readGameCrashes(r.game, {})).records[0]?.record;
    assert.equal(record?.kind, CrashKind.ProcessExit);
    assert.match(record?.message ?? "", /SIGABRT/);
  });

  it("a clean exit keeps nothing, and a registry with no store names no record", async () => {
    const clean = await runsRig();
    clean.proc.reap({ code: 0, signal: null });
    const stopped = await clean.ended();
    assert.equal(stopped?.crash, undefined);
    assert.deepEqual(clean.announced, []);
    const bare = await runsRig({ store: false });
    bare.proc.send({ event: "crash", record: panicWire() });
    await bare.clock.settle();
    bare.proc.reap({ code: 101, signal: null });
    const crashed = await bare.ended();
    assert.equal(crashed?.state, NativeRunState.Crashed);
    assert.equal(crashed?.crash, undefined);
  });

  it("hostile table: a crash line over the line cap, or a record the game may not write, is refused before it is kept", async () => {
    const huge = await runsRig();
    // 2 MiB in one line: the port's line cap ends the game before the line is ever parsed.
    const message = "x".repeat(2 * NATIVE_LINE_MAX_BYTES);
    huge.proc.raw(`{"event":"crash","record":{"format":"genex-crash/1","message":"${message}"}}\n`);
    const tooLarge = await huge.ended();
    assert.equal(tooLarge?.refusal, NativeRefusal.ReplyTooLarge);
    assert.equal(tooLarge?.crash, undefined);
    assert.deepEqual(await listing(huge.game), []);
    assert.deepEqual(huge.announced, []);
    for (const forged of [
      panicWire(42, { source: "host" }),
      panicWire(42, { kind: "hang", source: "game" }),
      panicWire(42, { kind: "process-exit" }),
    ]) {
      const r = await runsRig();
      r.proc.send({ event: "crash", record: forged });
      const last = await r.ended();
      assert.equal(last?.refusal, NativeRefusal.ReplyInvalid, JSON.stringify(forged));
      assert.equal(last?.crash, undefined);
      assert.deepEqual(await listing(r.game), []);
    }
  });

  it("the same panic in two runs: game_crashed lands once per run, the second with repeat 2", async () => {
    const r = await runsRig();
    for (const proc of [r.proc, null]) {
      const run = proc ?? (await r.startRun());
      run.send({ event: "crash", record: panicWire() });
      await r.clock.settle();
      run.reap({ code: 101, signal: null });
      await r.ended();
    }
    assert.deepEqual(
      r.announced.map((payload) => payload.repeat),
      [1, 2],
    );
    const records = (await readGameCrashes(r.game, {})).records;
    assert.deepEqual(
      records.map((entry) => entry.repeat),
      [2],
    );
  });
});

// ── what the chat shows ─────────────────────────────────────────────────────────────────────

/** A `game_crashed` record on the studio's main thread. */
function crashedEvent(n: number, payload: GameCrashedPayload): EventEnvelope {
  return {
    id: String(n).padStart(5, "0"),
    thread_id: "studio",
    session_id: null,
    turn_id: null,
    created_at: new Date(AT + n * 1000).toISOString(),
    data: customEventData(CustomEvent.GameCrashed, { ...payload }),
  };
}

describe("the chat's crash line (chat-entries, chat-activity)", () => {
  const payload: GameCrashedPayload = {
    project: "pong",
    runId: RUN_A,
    crashId: crashIdOf(RUN_A),
    kind: CrashKind.Panic,
    source: CrashSource.Game,
    fatal: true,
    handled: false,
    tick: 300,
    seed: 1,
    destination: "macos",
    location: { file: "src/enemy.rs", line: 42, column: 17 },
    symbolicated: false,
    repeat: 1,
  };

  it("one compact line per game_crashed, naming the game, the kind, the place and the tick, kept as trouble", () => {
    const entries = toEntries([crashedEvent(1, payload)]);
    assert.equal(entries.length, 1);
    const [line] = entries;
    assert.equal(line?.kind, EntryKind.System);
    if (line?.kind !== EntryKind.System) return;
    assert.equal(line.tag, SystemTag.Crash);
    assert.equal(line.attention, true);
    assert.match(line.text, /pong/);
    assert.match(line.text, /src\/enemy\.rs:42/);
    assert.match(line.text, /tick 300/);
  });

  it("a repeat says how many runs crashed the same way; a handled device loss is not trouble; an unknown kind still reads", () => {
    const [again] = toEntries([crashedEvent(1, { ...payload, repeat: 3 })]);
    assert.ok(again?.kind === EntryKind.System && /3 runs/.test(again.text), JSON.stringify(again));
    const [lost] = toEntries([
      crashedEvent(2, { project: "pong", kind: CrashKind.DeviceLost, fatal: false, handled: true, repeat: 1 }),
    ]);
    assert.ok(lost?.kind === EntryKind.System && lost.attention === false, JSON.stringify(lost));
    const [unknown] = toEntries([
      {
        ...crashedEvent(3, payload),
        data: { type: "custom", event_type: "game_crashed", payload: { kind: "meltdown" } },
      },
    ]);
    assert.equal(unknown?.kind, EntryKind.System);
  });

  it("a game_crashed the harness writes is refused: only the host that kept the record announces it", () => {
    assert.throws(() => refuseHostRecords([customEventData(CustomEvent.GameCrashed, { ...payload })]), /studio only/);
  });

  it("a crash record never moves the chat's activity line", () => {
    for (const active of [false, true]) {
      const before = chatActivity([], active);
      assert.deepEqual(chatActivity([crashedEvent(1, payload)], active), before);
    }
  });
});
