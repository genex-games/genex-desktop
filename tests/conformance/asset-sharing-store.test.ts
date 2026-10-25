/**
 * The Assets tab's Save and Share store (`renderer/state/sharing.ts`) over a fake `StudioApi` and a
 * clock the test moves: the library's word on a game's files, and each share's line from Send
 * through Check to ✓ On Play, a refusal, a failure, and a check genex.games finishes later.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShareLineKind, ShareStep, shareLineOf } from "../../src/renderer/asset-library-view.ts";
import {
  CHECK_REREAD_MS,
  CHECK_REREADS,
  createSharingStore,
  LIVE_SHOWN_MS,
  libraryOf,
  SEND_STEP_MS,
  STEPS_SHOWN_MS,
  sharesOf,
} from "../../src/renderer/state/sharing.ts";
import {
  type AssetLibraryState,
  type GameLibraryStates,
  ShareMiss,
  type ShareOutcome,
} from "../../src/shared/asset-library.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const HUT = { projectId: "p-hut", slug: "giant-mushroom-tree", live: true };

const state = (file: string, extra: Partial<AssetLibraryState> = {}): AssetLibraryState => ({
  file,
  generationId: `gen-${file}`,
  saved: false,
  shared: null,
  saveable: true,
  shareable: true,
  ...extra,
});

const states = (list: AssetLibraryState[], unread = false): GameLibraryStates => ({
  project: "g",
  states: list,
  unread,
});

/** A clock the test moves: timers run when it passes their time. */
function heldClock() {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  return {
    setTimeout(run: () => void, ms: number) {
      timers.push({ at: now + ms, run });
      return timers.length;
    },
    async advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
      // Let a read a timer started settle.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

/** A promise the test resolves. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Store = ReturnType<typeof createSharingStore>;

/** A share run to its answer: the clock passes the time its steps show. */
async function shareThrough(store: Store, clock: ReturnType<typeof heldClock>, items: Parameters<Store["share"]>[1]) {
  const done = store.share("g", items);
  await clock.advance(STEPS_SHOWN_MS);
  await done;
}

const lineOf = (store: Store, file: string) => {
  const progress = sharesOf(store.getState(), "g")[file];
  return progress ? shareLineOf(progress) : null;
};

describe("the library's word on a game", () => {
  it("keeps what a read answers, and reads an unreadable library as signed out", async () => {
    const fake = fakeStudioApi({ assetLibraryStates: async () => states([state("a", { saved: true })]) });
    const store = createSharingStore(fake.api, heldClock());
    assert.equal(libraryOf(store.getState(), "g"), null);
    await store.read("g");
    assert.equal(libraryOf(store.getState(), "g")?.states[0]?.saved, true);
    fake.stub("assetLibraryStates", async () => Promise.reject(new Error("offline")));
    await store.read("g");
    assert.deepEqual(libraryOf(store.getState(), "g"), { project: "g", states: [], unread: true });
  });

  it("keeps the states Save and Stop sharing answer", async () => {
    const fake = fakeStudioApi({
      assetSave: async () => states([state("a", { saved: true })]),
      assetUnshare: async () => states([state("a", { saved: true, shared: null })]),
    });
    const store = createSharingStore(fake.api, heldClock());
    await store.save("g", ["a"], true);
    assert.deepEqual(fake.callsOf("assetSave"), [["g", ["a"], true]]);
    assert.equal(libraryOf(store.getState(), "g")?.states[0]?.saved, true);
    await store.unshare("g", "a");
    assert.deepEqual(fake.callsOf("assetUnshare"), [["g", "a"]]);
    assert.equal(libraryOf(store.getState(), "g")?.states[0]?.shared, null);
  });
});

describe("a write and a read in flight", () => {
  it("keeps Save's answer over a read that started before it", async () => {
    const slow = deferred<ReturnType<typeof states>>();
    const fake = fakeStudioApi({
      assetLibraryStates: () => slow.promise,
      assetSave: async () => states([state("a", { saved: true })]),
    });
    const store = createSharingStore(fake.api, heldClock());
    const reading = store.read("g");
    await store.save("g", ["a"], true);
    slow.resolve(states([state("a", { saved: false })]));
    await reading;
    assert.equal(libraryOf(store.getState(), "g")?.states[0]?.saved, true);
  });

  it("saves more than one call carries in runs", async () => {
    const files = Array.from({ length: 120 }, (_, i) => `f${i}`);
    const fake = fakeStudioApi({ assetSave: async () => states([]) });
    const store = createSharingStore(fake.api, heldClock());
    await store.save("g", files, true);
    assert.deepEqual(
      fake.callsOf("assetSave").map((call) => (call[1] as string[]).length),
      [50, 50, 20],
    );
  });
});

describe("a share's line", () => {
  it("goes Send, then Check while it is out, then ✓ On Play with the Shared tag, then away", async () => {
    const answer = deferred<ShareOutcome[]>();
    const fake = fakeStudioApi({
      assetLibraryStates: async () => states([state("a")]),
      assetShare: () => answer.promise,
    });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await store.read("g");
    const shared = store.share("g", [{ file: "a", name: "Giant mushroom tree" }]);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Steps, current: ShareStep.Send, checking: false });
    await clock.advance(SEND_STEP_MS);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Steps, current: ShareStep.Check, checking: false });
    answer.resolve([{ file: "a", shared: HUT }]);
    await clock.advance(STEPS_SHOWN_MS - SEND_STEP_MS);
    await shared;
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Live });
    assert.deepEqual(libraryOf(store.getState(), "g")?.states[0]?.shared, HUT);
    assert.deepEqual(fake.callsOf("assetShare"), [["g", [{ file: "a", name: "Giant mushroom tree" }]]]);
    await clock.advance(LIVE_SHOWN_MS);
    assert.equal(lineOf(store, "a"), null);
  });

  it("holds a quick answer until its steps have been seen", async () => {
    const fake = fakeStudioApi({ assetShare: async () => [{ file: "a", shared: HUT }] });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    const shared = store.share("g", [{ file: "a", name: "Hut" }]);
    await clock.advance(SEND_STEP_MS);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Steps, current: ShareStep.Check, checking: false });
    await clock.advance(STEPS_SHOWN_MS - SEND_STEP_MS);
    await shared;
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Live });
  });

  it("says genex.games refused it and offers a report, then that the report went", async () => {
    const fake = fakeStudioApi({ assetShare: async () => [{ file: "a", miss: ShareMiss.Refused }] });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await shareThrough(store, clock, [{ file: "a", name: "Refuse me" }]);
    const line = lineOf(store, "a");
    assert.equal(line?.kind === ShareLineKind.Missed && line.action, "report");
    store.reported("g", "a");
    const after = lineOf(store, "a");
    assert.equal(after?.kind === ShareLineKind.Missed && after.action, "reported");
  });

  it("reads a call that failed as Couldn't share with Try again, which shares again under the same name", async () => {
    const fake = fakeStudioApi({ assetShare: async () => Promise.reject(new Error("offline")) });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await shareThrough(store, clock, [{ file: "a", name: "Hut" }]);
    const line = lineOf(store, "a");
    assert.deepEqual(line, { kind: ShareLineKind.Missed, miss: ShareMiss.Failed, action: "retry" });
    fake.stub("assetShare", async () => [{ file: "a", shared: HUT }]);
    await shareThrough(store, clock, [{ file: "a", name: sharesOf(store.getState(), "g").a?.name ?? "" }]);
    assert.deepEqual(fake.callsOf("assetShare")[1], ["g", [{ file: "a", name: "Hut" }]]);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Live });
  });

  it("stays at Checking while genex.games checks, and shows ✓ once a later read finds it live", async () => {
    let live = false;
    const fake = fakeStudioApi({
      assetShare: async () => [{ file: "a", miss: ShareMiss.Checking }],
      assetLibraryStates: async () => states([state("a", live ? { shared: HUT } : {})]),
    });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await shareThrough(store, clock, [{ file: "a", name: "Hut" }]);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Steps, current: ShareStep.Check, checking: true });
    await clock.advance(CHECK_REREAD_MS);
    assert.equal(fake.callsOf("assetLibraryStates").length, 1);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Steps, current: ShareStep.Check, checking: true });
    live = true;
    await clock.advance(CHECK_REREAD_MS);
    assert.deepEqual(lineOf(store, "a"), { kind: ShareLineKind.Live });
    await clock.advance(LIVE_SHOWN_MS);
    assert.equal(lineOf(store, "a"), null);
  });

  it("lets the Checking line go after its last read, the Shared tag coming with a later read", async () => {
    const fake = fakeStudioApi({
      assetShare: async () => [{ file: "a", miss: ShareMiss.Checking }],
      assetLibraryStates: async () => states([state("a")]),
    });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await shareThrough(store, clock, [{ file: "a", name: "Hut" }]);
    for (let i = 0; i < CHECK_REREADS; i++) await clock.advance(CHECK_REREAD_MS);
    assert.equal(fake.callsOf("assetLibraryStates").length, CHECK_REREADS);
    assert.equal(lineOf(store, "a"), null);
  });

  it("clears a file's line when it stops being shared", async () => {
    const fake = fakeStudioApi({
      assetShare: async () => [{ file: "a", miss: ShareMiss.Failed }],
      assetUnshare: async () => states([state("a")]),
    });
    const clock = heldClock();
    const store = createSharingStore(fake.api, clock);
    await shareThrough(store, clock, [{ file: "a", name: "Hut" }]);
    await store.unshare("g", "a");
    assert.equal(lineOf(store, "a"), null);
  });
});
