/**
 * Live's net row (game-systems MP-7), through its pure derivation and its poll, with no DOM: a
 * game built with `[net]` shows its mode, status and reason; a game with no `__net`, or one outside
 * its shape, shows no row; the poll reads the Live page's state only while the page is this game's
 * and playing, every NET_POLL_MS on a fake clock, and stops when asked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { NET_STATE_KEY, NetMode, NetOffline, NetStatus, type NetView, netViewOf } from "../../src/shared/game-net.ts";
import type { NativeTimers } from "../../src/shared/native-contract.ts";
import { NET_POLL_MS, type NetRowApi, netRowView, startNetPoll } from "../../src/renderer/panels/stage/net-row.ts";
import { NET_WORDS } from "../../src/renderer/words.ts";

/** The facade vocabulary fixture's net block: genex-net's spellings, which tests/vocabulary.rs holds to the crate. */
const PINNED = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "fixtures", "rust-facade-vocabulary.json"), "utf8")) as {
    net: { modes: string[]; statuses: string[]; offline: string[] };
  }
).net;

/** A `__net` as the facade writes it (`net.rs` `runtime_key`). */
const NET = {
  mode: NetMode.Loopback,
  status: NetStatus.Joined,
  me: "p1",
  host: "p1",
  players: 2,
  connected: 2,
  objects: 1,
  journalTicks: 120,
  writesDropped: 0,
  scriptIgnored: 0,
};

/** A game state carrying `net` as its `__net`, beside the keys every game has. */
const stateWith = (net: unknown): Record<string, unknown> => ({
  version: 1,
  frame: 9,
  checksum: "abc",
  [NET_STATE_KEY]: net,
});

describe("net row: what a [net] game's row says", () => {
  it("shows the mode, status and players of a seat in Studio's local room", () => {
    const row = netRowView(netViewOf(stateWith(NET)));
    assert.deepEqual(row, {
      status: NetStatus.Joined,
      mode: NET_WORDS.mode[NetMode.Loopback],
      title: NET_WORDS.status[NetStatus.Joined],
      reason: null,
      players: NET_WORDS.players(2, 2),
    });
  });

  it("says why an offline seat is offline", () => {
    const offline = {
      ...NET,
      mode: NetMode.Relay,
      status: NetStatus.Offline,
      reason: NetOffline.NoSlug,
      players: 0,
      connected: 0,
    };
    const row = netRowView(netViewOf(stateWith(offline)));
    assert.equal(row?.mode, NET_WORDS.mode[NetMode.Relay]);
    assert.equal(row?.title, NET_WORDS.status[NetStatus.Offline]);
    assert.equal(row?.reason, NET_WORDS.reason[NetOffline.NoSlug]);
    assert.equal(row?.players, null);
  });

  it("names connected players apart when some dropped", () => {
    assert.equal(NET_WORDS.players(3, 2), "3 players · 2 connected");
    assert.equal(NET_WORDS.players(1, 1), "1 player");
  });

  it("has words for every mode, status and reason the facade writes", () => {
    for (const mode of Object.values(NetMode)) assert.ok(NET_WORDS.mode[mode], mode);
    for (const status of Object.values(NetStatus)) assert.ok(NET_WORDS.status[status], status);
    for (const reason of Object.values(NetOffline)) assert.ok(NET_WORDS.reason[reason], reason);
  });

  it("restates genex-net's mode, status and reason spellings in their order", () => {
    assert.deepEqual(Object.values(NetMode), PINNED.modes);
    assert.deepEqual(Object.values(NetStatus), PINNED.statuses);
    assert.deepEqual(Object.values(NetOffline), PINNED.offline);
  });
});

describe("net row: no row", () => {
  it("shows none for a game whose state has no __net", () => {
    assert.equal(netRowView(netViewOf({ version: 1, frame: 9, checksum: "abc" })), null);
    assert.equal(netRowView(netViewOf(null)), null);
  });

  // Untrusted state: anything outside the shape is no row, never a guess.
  const hostile: Array<[string, unknown]> = [
    ["an array", [NET]],
    ["a string", "joined"],
    ["an unknown mode", { ...NET, mode: "lan" }],
    ["an unknown status", { ...NET, status: "Joined" }],
    ["an unknown reason", { ...NET, reason: "net-banned" }],
    ["a reason that is not a string", { ...NET, reason: 1 }],
    ["negative players", { ...NET, players: -1 }],
    ["players past the relay's cap", { ...NET, players: 65 }],
    ["fractional players", { ...NET, players: 1.5 }],
    ["players as text", { ...NET, players: "2" }],
    ["no connected count", { ...NET, connected: undefined }],
    ["no mode", { ...NET, mode: undefined }],
  ];
  for (const [name, net] of hostile)
    it(`shows none for a __net with ${name}`, () => assert.equal(netViewOf(stateWith(net)), null));
});

function fakeTimers() {
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
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 5; round++) await tick();
  };
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      await settle();
      const first = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, advance, settle, pending: () => due.size };
}

type Live = Awaited<ReturnType<NetRowApi["previewLive"]>>;

const PAGE = { complete: true, resources: 3, state: null };
const live = (change: Partial<Live> = {}): Live => ({
  project: "arena",
  navigating: false,
  stopped: false,
  loadError: null,
  crashed: false,
  page: PAGE,
  ...change,
});

function fakeApi(page: () => Live, state: () => unknown = () => stateWith(NET)) {
  const calls = { live: 0, state: 0 };
  const api: NetRowApi = {
    previewLive: async () => {
      calls.live += 1;
      return page();
    },
    previewState: async () => {
      calls.state += 1;
      return state();
    },
  };
  return { api, calls };
}

describe("net row: the poll", () => {
  it("reads this game's page every NET_POLL_MS and stops when asked", async () => {
    const clock = fakeTimers();
    const { api, calls } = fakeApi(() => live());
    const views: Array<NetView | null> = [];
    const poll = startNetPoll(api, clock.timers, "arena", (view) => views.push(view));
    await clock.settle();
    assert.equal(calls.state, 1);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.status, NetStatus.Joined);
    await clock.advance(NET_POLL_MS - 1);
    assert.equal(calls.state, 1);
    await clock.advance(1);
    assert.equal(calls.state, 2);
    poll.stop();
    assert.equal(clock.pending(), 0);
    await clock.advance(NET_POLL_MS * 3);
    assert.equal(calls.state, 2);
  });

  const notThisPage: Array<[string, Partial<Live>]> = [
    ["another game's page", { project: "racer" }],
    ["a page still navigating", { navigating: true, page: null }],
    ["a stopped game", { stopped: true, page: null }],
    ["a page that did not answer", { page: null }],
  ];
  for (const [name, change] of notThisPage)
    it(`never reads the state of ${name}`, async () => {
      const clock = fakeTimers();
      const { api, calls } = fakeApi(() => live(change));
      const views: Array<NetView | null> = [];
      const poll = startNetPoll(api, clock.timers, "arena", (view) => views.push(view));
      await clock.settle();
      poll.stop();
      assert.equal(calls.state, 0);
      assert.deepEqual(views, [null]);
    });

  it("answers no row when a read fails, and keeps polling", async () => {
    const clock = fakeTimers();
    let fail = true;
    const { api } = fakeApi(
      () => live(),
      () => {
        if (fail) throw new Error("page gone");
        return stateWith(NET);
      },
    );
    const views: Array<NetView | null> = [];
    const poll = startNetPoll(api, clock.timers, "arena", (view) => views.push(view));
    await clock.settle();
    fail = false;
    await clock.advance(NET_POLL_MS);
    poll.stop();
    assert.equal(views[0], null);
    assert.equal(views[1]?.status, NetStatus.Joined);
  });

  it("drops an answer that arrives after stop", async () => {
    const clock = fakeTimers();
    const { api } = fakeApi(() => live());
    const views: Array<NetView | null> = [];
    const poll = startNetPoll(api, clock.timers, "arena", (view) => views.push(view));
    poll.stop();
    await clock.settle();
    assert.deepEqual(views, []);
    assert.equal(clock.pending(), 0);
  });
});
