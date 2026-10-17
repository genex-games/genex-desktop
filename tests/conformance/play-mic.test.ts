/**
 * Voice chat in Play. A game that asks for a microphone gets one the app controls; the person's own
 * microphone feeds it only while the header's mic switch is on, which every game starts off and
 * remembers per game. The switch's menu picks the microphone. Main lets the page open the person's
 * microphone only right after it asked the page to, and the page's word is checked before main
 * believes it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type PlayTicket, type PlayWorld, TicketStatus } from "../../src/main/play/gallery.ts";
import { playPermissionShown, playPermitted } from "../../src/main/play/game-permissions.ts";
import { MIC_OPEN_GRANT_MS, micGate, micGateFor } from "../../src/main/play/mic.ts";
import { openPlayMicStore } from "../../src/main/play/mic-store.ts";
import { type PlayMicDeps, type PlayViewerDeps, playViewer } from "../../src/main/play/viewer.ts";
import { installPlayMic } from "../../src/preload/play-mic-page.ts";
import {
  type PlayBarState,
  PlayControl,
  PlayNote,
  type PlayViewerEvent,
  readPlayPoint,
} from "../../src/shared/play.ts";
import {
  MIC_DEVICES_MAX,
  MIC_NAME_MAX,
  type PlayMicCommand,
  PlayMicProblem,
  type PlayMicReport,
  readMicReport,
} from "../../src/shared/play-mic.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const SLUG = "disco";
const WORLD: PlayWorld = {
  id: "cm2",
  slug: SLUG,
  title: "Disco",
  multiplayer: true,
  likes: 0,
  liked: false,
  remixable: false,
  cloneUrl: null,
  author: "Ada",
  authorId: null,
  plays: 10,
  online: 2,
};
const MINTED: PlayTicket = { status: TicketStatus.Minted, ticket: "T1" };

/** The page's word: in voice chat or not, its microphone live or not. */
const report = (over: Partial<PlayMicReport> = {}): PlayMicReport => ({
  asked: true,
  live: false,
  problem: null,
  devices: [],
  ...over,
});

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A viewer whose mic talks to recording fakes. */
function rig(options: { access?: boolean; on?: string[]; device?: string | null } = {}) {
  const events: PlayViewerEvent[] = [];
  const commands: PlayMicCommand[] = [];
  const log: string[] = [];
  const saved = { on: new Set(options.on ?? []), device: options.device ?? null };
  const menus: { devices: readonly string[]; chosen: string | null; at: unknown; choose(d: string | null): void }[] =
    [];
  const mic: PlayMicDeps = {
    access: async () => {
      log.push("access");
      return options.access ?? true;
    },
    command: (command) => commands.push(command),
    menu: (devices, chosen, at, choose) => menus.push({ devices, chosen, at, choose }),
    openSettings: () => log.push("settings"),
    store: {
      on: (slug) => saved.on.has(slug),
      setOn: (slug, on) => void (on ? saved.on.add(slug) : saved.on.delete(slug)),
      device: () => saved.device,
      setDevice: (device) => {
        saved.device = device;
      },
    },
  };
  const deps: PlayViewerDeps = {
    gallery: {
      world: async () => WORLD,
      ticket: async () => MINTED,
      setLiked: async (_id, liked) => ({ liked, likes: 0 }),
      inviteCode: async () => undefined,
    },
    gameUrl: (slug) => `game:${slug}`,
    window: { contentSize: () => ({ width: 1200, height: 800 }) },
    game: { open: () => {}, show: () => {}, hide: () => {}, focus: () => {}, close: () => {} },
    focusApp: () => {},
    clipboard: () => {},
    web: "https://genex.games",
    emit: (event) => events.push(event),
    clock: { setTimeout: () => 0, clearTimeout: () => {} },
    mic,
  };
  const viewer = playViewer(deps);
  const bar = (): PlayBarState | undefined => events.findLast((event) => event.bar)?.bar;
  return { viewer, bar, commands, log, saved, menus };
}

/** A viewer playing Disco, its page loaded. */
async function playing(options: Parameters<typeof rig>[0] = {}) {
  const r = rig(options);
  r.viewer.open(SLUG);
  await settle();
  r.viewer.loaded();
  return r;
}

describe("Play mic: the page's word", () => {
  it("accepts a report and keeps only clean microphone names", () => {
    const long = "m".repeat(MIC_NAME_MAX + 1);
    const many = Array.from({ length: MIC_DEVICES_MAX + 5 }, (_, i) => `Mic ${i}`);
    assert.deepEqual(
      readMicReport({ asked: true, live: false, problem: "lost", devices: [" AirPods ", "AirPods", long, 7] }),
      {
        asked: true,
        live: false,
        problem: PlayMicProblem.Lost,
        devices: ["AirPods"],
      },
    );
    assert.equal(readMicReport({ asked: true, live: true, devices: many })?.devices.length, MIC_DEVICES_MAX);
  });

  it("refuses anything that is not a report, and an unknown problem says nothing", () => {
    for (const raw of [null, undefined, "asked", 1, [], { asked: "yes", live: false }, { asked: true }]) {
      assert.equal(readMicReport(raw), null, JSON.stringify(raw));
    }
    assert.equal(readMicReport({ asked: false, live: false, problem: "hacked" })?.problem, null);
  });

  it("reads a menu's point only as two finite numbers on the window", () => {
    assert.deepEqual(readPlayPoint({ x: 10.4, y: 48 }), { x: 10, y: 48 });
    for (const raw of [null, {}, { x: "1", y: 2 }, { x: -1, y: 2 }, { x: Number.NaN, y: 2 }, { x: 1e9, y: 2 }]) {
      assert.equal(readPlayPoint(raw), undefined, JSON.stringify(raw));
    }
  });
});

describe("Play mic: the header's switch", () => {
  it("has no mic until the game asks for one; then it is off, and the game waits", async () => {
    const { viewer, bar, commands } = await playing();
    assert.equal(bar()?.mic, null);
    viewer.mic(report());
    assert.deepEqual(bar()?.mic, { on: false, live: false, waiting: true });
    assert.deepEqual(commands, [], "the person's microphone stays shut");
  });

  it("turns on: asks the system, opens the chosen microphone, and remembers it for this game", async () => {
    const { viewer, bar, commands, log, saved } = await playing({ device: "AirPods" });
    viewer.mic(report());
    viewer.control(PlayControl.Mic);
    await settle();
    assert.deepEqual(log, ["access"]);
    assert.deepEqual(commands, [{ open: true, device: "AirPods" }]);
    assert.deepEqual(bar()?.mic, { on: true, live: false, waiting: false });
    assert.ok(saved.on.has(SLUG));
    viewer.mic(report({ live: true }));
    assert.deepEqual(bar()?.mic, { on: true, live: true, waiting: false });
  });

  it("turns off: closes the microphone and remembers that", async () => {
    const { viewer, bar, commands, saved } = await playing({ on: [SLUG] });
    viewer.mic(report());
    await settle();
    viewer.control(PlayControl.Mic);
    await settle();
    assert.deepEqual(commands, [
      { open: true, device: null },
      { open: false, device: null },
    ]);
    assert.equal(bar()?.mic?.on, false);
    assert.equal(saved.on.has(SLUG), false);
  });

  it("a game whose switch was left on opens the microphone as soon as it asks", async () => {
    const { viewer, commands, log } = await playing({ on: [SLUG] });
    viewer.mic(report({ asked: false }));
    await settle();
    assert.deepEqual(commands, [], "not before the game is in voice chat");
    viewer.mic(report());
    await settle();
    assert.deepEqual(log, ["access"]);
    assert.deepEqual(commands, [{ open: true, device: null }]);
  });

  it("refused by the system: says where to allow it, opens those settings, and stays off", async () => {
    const { viewer, bar, commands, log, saved } = await playing({ access: false });
    viewer.mic(report());
    viewer.control(PlayControl.Mic);
    await settle();
    assert.deepEqual(log, ["access", "settings"]);
    assert.deepEqual(commands, []);
    assert.equal(bar()?.note, PlayNote.MicBlocked);
    assert.equal(bar()?.mic?.on, false);
    assert.equal(saved.on.has(SLUG), false);
  });

  it("does nothing for a switch the header does not show", async () => {
    const { viewer, commands, log } = await playing();
    viewer.control(PlayControl.Mic);
    viewer.control(PlayControl.MicDevices);
    await settle();
    assert.deepEqual([commands, log], [[], []]);
  });

  it("a game that leaves voice chat closes nothing more, and opens again when it comes back", async () => {
    const { viewer, commands } = await playing({ on: [SLUG] });
    viewer.mic(report());
    await settle();
    viewer.mic(report({ asked: false, live: false }));
    viewer.mic(report());
    await settle();
    assert.deepEqual(commands, [
      { open: true, device: null },
      { open: true, device: null },
    ]);
  });

  it("the menu lists the microphones with the chosen one; a pick is remembered and reopens with it", async () => {
    const { viewer, commands, menus, saved } = await playing({ on: [SLUG] });
    viewer.mic(report({ devices: ["MacBook Pro Microphone", "AirPods"] }));
    await settle();
    viewer.control(PlayControl.MicDevices, { x: 300, y: 44 });
    assert.equal(menus.length, 1);
    assert.deepEqual(menus[0]?.devices, ["MacBook Pro Microphone", "AirPods"]);
    assert.equal(menus[0]?.chosen, null);
    assert.deepEqual(menus[0]?.at, { x: 300, y: 44 });
    menus[0]?.choose("AirPods");
    await settle();
    assert.equal(saved.device, "AirPods");
    assert.deepEqual(commands.at(-1), { open: true, device: "AirPods" });
  });

  it("no microphone: says so and turns the switch off without forgetting the game's choice", async () => {
    const { viewer, bar } = await playing({ on: [SLUG] });
    viewer.mic(report());
    await settle();
    viewer.mic(report({ problem: PlayMicProblem.Missing }));
    assert.equal(bar()?.note, PlayNote.MicMissing);
    assert.equal(bar()?.mic?.on, false);
  });

  it("a microphone that goes away is opened again once, then the switch turns off", async () => {
    const { viewer, bar, commands } = await playing({ on: [SLUG] });
    viewer.mic(report());
    await settle();
    viewer.mic(report({ problem: PlayMicProblem.Lost }));
    await settle();
    assert.deepEqual(commands, [
      { open: true, device: null },
      { open: true, device: null },
    ]);
    viewer.mic(report({ problem: PlayMicProblem.Lost }));
    await settle();
    assert.equal(commands.length, 2);
    assert.equal(bar()?.mic?.on, false);
    assert.equal(bar()?.note, PlayNote.MicMissing);
  });
});

describe("Play mic: main's gate", () => {
  it("lets the page open a microphone only right after main asked it to, once", () => {
    const gate = micGate();
    const audio = { mediaTypes: ["audio"], isMainFrame: true };
    assert.equal(gate.take(audio, 0), false, "nothing asked");
    assert.equal(gate.names("audio", true), false, "no names before the person turned the mic on here");
    gate.allow(1000);
    assert.equal(gate.take({ ...audio, mediaTypes: ["audio", "video"] }, 1001), false, "a camera, never");
    assert.equal(gate.take({ ...audio, mediaTypes: ["video"] }, 1001), false);
    assert.equal(gate.take({ ...audio, mediaTypes: [] }, 1001), false);
    assert.equal(gate.take({ ...audio, isMainFrame: false }, 1001), false, "a frame inside the game, never");
    assert.equal(gate.take(audio, 1002), true);
    assert.equal(gate.take(audio, 1003), false, "spent");
    assert.equal(gate.names("audio", true), true);
    assert.equal(gate.names("video", true), false);
    assert.equal(gate.names("audio", false), false);
    gate.allow(2000);
    assert.equal(gate.take(audio, 2000 + MIC_OPEN_GRANT_MS + 1), false, "too late");
  });

  it("grants a game's page only Play's few permissions, from its top frame, and the microphone only through its gate", () => {
    const top = { mediaTypes: [], isMainFrame: true };
    for (const permission of ["pointerLock", "fullscreen", "clipboard-sanitized-write"]) {
      assert.equal(playPermitted(permission, top, undefined, 0), true, permission);
      assert.equal(
        playPermitted(permission, { ...top, isMainFrame: false }, undefined, 0),
        false,
        `${permission} in a frame`,
      );
      assert.equal(playPermissionShown(permission, { mediaType: undefined, isMainFrame: true }, undefined), true);
    }
    const refused = [
      "geolocation",
      "notifications",
      "midi",
      "midiSysex",
      "hid",
      "serial",
      "usb",
      "openExternal",
      "unknown",
    ];
    for (const permission of refused) assert.equal(playPermitted(permission, top, undefined, 0), false, permission);
    const gate = micGate();
    const audio = { mediaTypes: ["audio"], isMainFrame: true };
    assert.equal(playPermitted("media", audio, gate, 1), false, "the microphone waits for main's word");
    assert.equal(playPermitted("media", audio, undefined, 1), false, "and a view with no gate never gets it");
    gate.allow(0);
    assert.equal(
      playPermitted("media", { mediaTypes: ["video"], isMainFrame: true }, gate, 1),
      false,
      "a camera, never",
    );
    assert.equal(playPermitted("media", audio, gate, 1), true);
    assert.equal(playPermissionShown("media", { mediaType: "audio", isMainFrame: true }, gate), true);
    assert.equal(playPermissionShown("media", { mediaType: "video", isMainFrame: true }, gate), false);
  });

  it("starts each page of the game afresh, and never opens for a page anywhere else", () => {
    const home = "https://neon-rush.genex.technology/?genex_r=1#genex_ticket=t";
    const audio = { mediaTypes: ["audio"], isMainFrame: true };
    const fresh = micGateFor("https://neon-rush.genex.technology/level-2", home);
    assert.equal(fresh.names("audio", true), false, "a new page of the game starts untrusted");
    fresh.allow(0);
    assert.equal(fresh.take(audio, 1), true, "and opens once main asks it to");
    const elsewhere: Array<[string, string]> = [
      ["another game", "https://other-game.genex.technology/"],
      ["Genex's sign-in hop", "https://genex.games/play/authorize?guest=ok"],
      ["the game over plain http", "http://neon-rush.genex.technology/"],
      ["an address that isn't one", "not a url"],
    ];
    for (const [name, page] of elsewhere) {
      const gate = micGateFor(page, home);
      gate.allow(0);
      assert.equal(gate.take(audio, 1), false, name);
      assert.equal(gate.names("audio", true), false, `${name}: no microphone names either`);
    }
  });
});

/** A fake browser: one microphone track per opening, recorded. */
function fakePage(devices: { deviceId: string; label: string }[] = []) {
  const opened: { constraints: unknown; stopped: boolean }[] = [];
  const passedThrough: unknown[] = [];
  let failWith: string | null = null;
  class FakeTrack extends EventTarget {
    kind = "audio";
    enabled = true;
    stopped = false;
    stop() {
      this.stopped = true;
    }
    clone() {
      return new FakeTrack();
    }
  }
  class FakeStream {
    tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks;
    }
  }
  class FakeMediaDevices extends EventTarget {
    async getUserMedia(constraints: { audio?: unknown; video?: unknown }) {
      if (constraints.video) {
        passedThrough.push(constraints);
        throw Object.assign(new Error("no camera"), { name: "NotAllowedError" });
      }
      if (failWith) throw Object.assign(new Error(failWith), { name: failWith });
      const record = { constraints, stopped: false };
      opened.push(record);
      const track = new FakeTrack();
      track.stop = () => {
        record.stopped = true;
      };
      return new FakeStream([track]);
    }
    async enumerateDevices() {
      return [
        { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone" },
        ...devices.map((d) => ({ kind: "audioinput", ...d })),
        { kind: "videoinput", deviceId: "cam", label: "FaceTime HD Camera" },
      ];
    }
  }
  const sources: { stream: unknown; connected: boolean }[] = [];
  class FakeAudioContext {
    state = "running";
    resume() {
      return Promise.resolve();
    }
    createMediaStreamDestination() {
      return { channelCount: 2, stream: new FakeStream([new FakeTrack()]) };
    }
    createMediaStreamSource(stream: unknown) {
      const node = {
        stream,
        connected: false,
        connect: () => void (node.connected = true),
        disconnect: () => void (node.connected = false),
      };
      sources.push(node);
      return node;
    }
  }
  const mediaDevices = new FakeMediaDevices();
  const scope = {
    navigator: { mediaDevices },
    MediaDevices: FakeMediaDevices,
    MediaStream: FakeStream,
    AudioContext: FakeAudioContext,
  };
  return {
    scope,
    mediaDevices,
    opened,
    passedThrough,
    sources,
    fail: (name: string | null) => {
      failWith = name;
    },
  };
}

describe("Play mic: the game's page", () => {
  it("hands the game a microphone without opening the person's, and says it is in voice chat", async () => {
    const page = fakePage();
    const reports: PlayMicReport[] = [];
    installPlayMic((r: PlayMicReport) => reports.push(r), page.scope);
    const stream = await page.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    await settle();
    assert.equal(stream.getAudioTracks().length, 1);
    assert.deepEqual(page.opened, []);
    assert.deepEqual(reports.at(-1), { asked: true, live: false, problem: null, devices: [] });
  });

  it("opens the named microphone on main's word, keeping the game's own settings, and closes it again", async () => {
    const page = fakePage([{ deviceId: "id-airpods", label: "AirPods" }]);
    const reports: PlayMicReport[] = [];
    const mic = installPlayMic((r: PlayMicReport) => reports.push(r), page.scope);
    await page.mediaDevices.getUserMedia({ audio: { echoCancellation: true, deviceId: "theirs" } });
    mic?.command({ open: true, device: "AirPods" });
    await settle();
    await settle();
    assert.deepEqual(page.opened[0]?.constraints, {
      audio: { echoCancellation: true, deviceId: { exact: "id-airpods" } },
    });
    assert.equal(page.sources[0]?.connected, true);
    assert.deepEqual(reports.at(-1), { asked: true, live: true, problem: null, devices: ["AirPods"] });
    mic?.command({ open: false, device: null });
    await settle();
    assert.equal(page.opened[0]?.stopped, true);
    assert.equal(page.sources[0]?.connected, false);
    assert.equal(reports.at(-1)?.live, false);
  });

  it("a microphone it cannot find by name falls back to the system's", async () => {
    const page = fakePage();
    const mic = installPlayMic(() => {}, page.scope);
    await page.mediaDevices.getUserMedia({ audio: true });
    mic?.command({ open: true, device: "Gone USB Mic" });
    await settle();
    await settle();
    assert.deepEqual(page.opened[0]?.constraints, { audio: true });
  });

  it("leaves a camera request to the browser, which refuses it", async () => {
    const page = fakePage();
    installPlayMic(() => {}, page.scope);
    await assert.rejects(page.mediaDevices.getUserMedia({ audio: true, video: true }));
    assert.equal(page.passedThrough.length, 1);
  });

  it("the game stopping its microphone closes the person's and says it left voice chat", async () => {
    const page = fakePage();
    const reports: PlayMicReport[] = [];
    const mic = installPlayMic((r: PlayMicReport) => reports.push(r), page.scope);
    const stream = await page.mediaDevices.getUserMedia({ audio: true });
    mic?.command({ open: true, device: null });
    await settle();
    await settle();
    for (const track of stream.getTracks()) track.stop();
    await settle();
    assert.equal(page.opened[0]?.stopped, true);
    assert.deepEqual(reports.at(-1), { asked: false, live: false, problem: null, devices: [] });
  });

  it("says why an opening failed", async () => {
    const cases = [
      ["NotAllowedError", PlayMicProblem.Denied],
      ["NotFoundError", PlayMicProblem.Missing],
      ["NotReadableError", PlayMicProblem.Failed],
    ] as const;
    for (const [error, problem] of cases) {
      const page = fakePage();
      const reports: PlayMicReport[] = [];
      const mic = installPlayMic((r: PlayMicReport) => reports.push(r), page.scope);
      // The page has read its microphones long before a game joins voice chat.
      await settle();
      await page.mediaDevices.getUserMedia({ audio: true });
      page.fail(error);
      mic?.command({ open: true, device: null });
      await settle();
      await settle();
      assert.equal(reports.at(-1)?.problem, problem, error);
      assert.equal(reports.at(-1)?.live, false);
    }
  });
});

describe("Play mic: what is remembered", () => {
  it("keeps the games whose mic is on and the chosen microphone, across launches", async () => {
    const dir = await tmpDir("play-mic-");
    try {
      const file = path.join(dir, "play-mic.json");
      const store = await openPlayMicStore(file);
      assert.equal(store.on(SLUG), false);
      assert.equal(store.device(), null);
      store.setOn(SLUG, true);
      store.setDevice("AirPods");
      await store.flush();
      const again = await openPlayMicStore(file);
      assert.equal(again.on(SLUG), true);
      assert.equal(again.device(), "AirPods");
      again.setOn(SLUG, false);
      await again.flush();
      assert.equal((await openPlayMicStore(file)).on(SLUG), false);
    } finally {
      await removeTree(dir);
    }
  });

  it("reads a damaged or hostile file as nothing remembered", async () => {
    const dir = await tmpDir("play-mic-");
    try {
      const file = path.join(dir, "play-mic.json");
      for (const content of [
        "{",
        "[]",
        JSON.stringify({ games: "disco", device: 5 }),
        JSON.stringify({ games: ["../x", 3] }),
      ]) {
        await writeFile(file, content);
        const store = await openPlayMicStore(file);
        assert.equal(store.on("disco"), false, content);
        assert.equal(store.on("../x"), false, content);
        assert.equal(store.device(), null, content);
      }
      const store = await openPlayMicStore(file);
      store.setOn("not a slug!", true);
      store.setOn("disco", true);
      await store.flush();
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).games, ["disco"]);
    } finally {
      await removeTree(dir);
    }
  });
});
