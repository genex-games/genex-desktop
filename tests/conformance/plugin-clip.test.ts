/**
 * `observe` with a `clip` (API 3, additive): a few seconds of the bound game running from the start
 * of a moment one of its demos stages, recorded on a hidden window of its own. Every input a plugin
 * controls is checked before anything runs; the window is the clip's alone and is given back however
 * the clip ends, within one budget; Live is never touched. The recorder's host half (which take it
 * keeps, how the bytes come back, what it refuses) runs here on a scripted page.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { PluginClipMimeType, PluginStillProblemCode, type PluginBinding } from "../../src/shared/plugins.ts";
import { type ClipPage, clipBitrates, recordClip } from "../../src/main/preview-clip.ts";
import { clipMotion, type MotionFrame } from "../../src/substrate/clip-motion.ts";
import { sniffClipContainer } from "../../src/substrate/video-sniff.ts";
import {
  heldClock,
  lateAnswer,
  lateClip,
  lateLoad,
  observeHost,
  type PageScript,
  settle,
  TAKE,
  usedAfterRelease,
} from "../helpers/observe-windows.ts";
import { tmpDir } from "../helpers/tmp.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const CLIP = { demo: "hero-shot", width: 1280, height: 720 } as const;
const DEFAULTS = { seconds: 5, fps: 30, maxBytes: 8 * MIB } as const;

/** A refusal for its own reason, never a TypeError off a value nobody checked. */
const refused = (error: unknown) => error instanceof Error && !(error instanceof TypeError);

/** A game folder with a recording `observe` that writes down every look it is asked for. */
async function clipServices() {
  const root = await realpath(await tmpDir("studio-clip-observe-"));
  const game = path.join(root, "game");
  await mkdir(game);
  await writeFile(path.join(game, "index.html"), "<canvas></canvas>");
  const seen: unknown[][] = [];
  const services = new PluginServices(path.join(root, "data"), {}, async (...args: unknown[]) => {
    seen.push(args);
    return { observed: true };
  });
  const binding: PluginBinding = { project: "game", directory: game };
  const observe = (extra: Record<string, unknown>) =>
    services.call("example", "observe", { project: "game", root: game, files: [], ...extra }, binding);
  return { observe, seen, binding };
}

const NAMES: Array<[label: string, name: unknown]> = [
  ["empty", ""],
  ["65 characters", "x".repeat(65)],
  ["a parent step", "../x"],
  ["a slash", "a/b"],
  ["a quote", 'a"b'],
  ["a newline", "a\nb"],
  ["a NUL", "a\u0000b"],
  ["a leading hyphen", "-x"],
  ["a space", "hero shot"],
  ["a number", 42],
  ["null", null],
  ["missing", undefined],
  ["a list", ["hero-shot"]],
];
const NOT_NUMBERS: Array<[label: string, value: unknown]> = [
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["a string", "5"],
  ["null", null],
  ["a list", [5]],
];
function clipRows(): Array<[label: string, clip: unknown, extra?: Record<string, unknown>]> {
  return [
    ["a clip that is a string", "hero-shot"],
    ["a clip that is null", null],
    ["a clip that is a list", [CLIP]],
    ["a clip that names a camera", { ...CLIP, camera: "close" }],
    ["a clip that names only a camera", { camera: "close", width: 1280, height: 720 }],
    ["an unknown key", { ...CLIP, format: "webm" }],
    ["an own constructor key", { ...CLIP, constructor: "Object" }],
    ["an own __proto__ key", JSON.parse('{"demo":"hero-shot","width":1280,"height":720,"__proto__":{"seconds":99}}')],
    ...NAMES.map(([label, demo]): [string, unknown] => [`a demo name that is ${label}`, { ...CLIP, demo }]),
    ["a width below a window's least", { ...CLIP, width: 319 }],
    ["a width above a window's most", { ...CLIP, width: 1921 }],
    ["a height below a window's least", { ...CLIP, height: 239 }],
    ["a height above a window's most", { ...CLIP, height: 1201 }],
    ["a fractional width", { ...CLIP, width: 1280.5 }],
    ["a missing height", { demo: "hero-shot", width: 1280 }],
    ["seconds below 2", { ...CLIP, seconds: 1.99 }],
    ["seconds above 10", { ...CLIP, seconds: 10.01 }],
    ["zero seconds", { ...CLIP, seconds: 0 }],
    ["negative seconds", { ...CLIP, seconds: -5 }],
    ...NOT_NUMBERS.map(([label, seconds]): [string, unknown] => [`seconds that are ${label}`, { ...CLIP, seconds }]),
    ["14 frames a second", { ...CLIP, fps: 14 }],
    ["31 frames a second", { ...CLIP, fps: 31 }],
    ["a fractional frame rate", { ...CLIP, fps: 24.5 }],
    ...NOT_NUMBERS.map(([label, fps]): [string, unknown] => [`a frame rate that is ${label}`, { ...CLIP, fps }]),
    ["a byte limit below 256 KiB", { ...CLIP, maxBytes: 256 * KIB - 1 }],
    ["a byte limit above 8 MiB", { ...CLIP, maxBytes: 8 * MIB + 1 }],
    ["a fractional byte limit", { ...CLIP, maxBytes: MIB + 0.5 }],
    ...NOT_NUMBERS.map(([label, maxBytes]): [string, unknown] => [
      `a byte limit that is ${label}`,
      { ...CLIP, maxBytes },
    ]),
    ["files beside a clip", CLIP, { files: ["index.html"] }],
    ["a still beside a clip", CLIP, { still: { demo: "hero-shot", width: 1280, height: 720 } }],
  ];
}

describe("observe refuses a clip a plugin may not ask for, before anything runs", () => {
  for (const [label, clip, extra] of clipRows()) {
    it(`refuses ${label}`, async () => {
      const { observe, seen } = await clipServices();
      await assert.rejects(observe({ clip, ...extra }), refused);
      assert.deepEqual(seen, [], "the host was never asked: no window leased, sized or loaded");
    });
  }

  it("hands the host a clip in its canonical shape, every default filled in", async () => {
    const { observe, seen, binding } = await clipServices();
    const accepted: Array<[asked: Record<string, unknown>, handed: Record<string, unknown>]> = [
      [{ ...CLIP }, { ...CLIP, ...DEFAULTS }],
      [
        { demo: "Boss_Fight:2", width: 320, height: 240, seconds: 2, fps: 15, maxBytes: 256 * KIB },
        { demo: "Boss_Fight:2", width: 320, height: 240, seconds: 2, fps: 15, maxBytes: 256 * KIB },
      ],
      [
        { demo: "a".repeat(64), width: 1920, height: 1200, seconds: 10, fps: 30, maxBytes: 8 * MIB },
        { demo: "a".repeat(64), width: 1920, height: 1200, seconds: 10, fps: 30, maxBytes: 8 * MIB },
      ],
      [
        { ...CLIP, seconds: 3.5, fps: undefined, maxBytes: undefined },
        { ...CLIP, seconds: 3.5, fps: 30, maxBytes: 8 * MIB },
      ],
    ];
    for (const [asked, handed] of accepted) {
      assert.deepEqual(await observe({ clip: asked }), { observed: true });
      assert.deepEqual(seen.at(-1), [binding, [], undefined, handed]);
    }
  });
});

/** The pooled window's whole life when a clip of the default size ends before its recording. */
const UNTIL_DEMO = ["acquire", "resize:1280x720", "load", "call:start", "call:demos"];

describe("a plugin's clip of a moment a demo stages", () => {
  it("leases a window, sizes it, loads the game, stages the demo, lets the clock run, records it and gives the window back", async () => {
    const host = await observeHost();
    const answer = await host.clip(CLIP);
    assert.deepEqual(host.log, [
      ...UNTIL_DEMO,
      "call:demo:hero-shot",
      "hud:off",
      "call:start",
      "clip",
      "restore",
      "release",
    ]);
    assert.deepEqual(host.made[0]?.clips, [{ seconds: 5, fps: 30, maxBytes: 8 * MIB, posterMaxPx: 1280 }]);
    assert.deepEqual(answer, { clip: { ...TAKE, view: { demo: "hero-shot" } } });
    assert.deepEqual(host.live.log, [], "Live was never touched");
  });

  it("records the length, rate and byte limit the plugin asked for", async () => {
    const host = await observeHost();
    await host.clip({ ...CLIP, width: 640, height: 360, seconds: 2.5, fps: 15, maxBytes: MIB });
    assert.ok(host.log.includes("resize:640x360"));
    assert.deepEqual(host.made[0]?.clips, [{ seconds: 2.5, fps: 15, maxBytes: MIB, posterMaxPx: 1280 }]);
  });

  it("answers unavailable without touching Live when the build has no hidden window", async () => {
    const host = await observeHost({}, { hidden: false });
    assert.equal((await host.clip(CLIP)).clipProblem?.code, PluginStillProblemCode.Unavailable);
    assert.deepEqual(host.live.log, []);
  });

  it("answers unavailable on a window that cannot record, and gives it back", async () => {
    const host = await observeHost({ noClip: true });
    assert.equal((await host.clip(CLIP)).clipProblem?.code, PluginStillProblemCode.Unavailable);
    assert.deepEqual(host.log, ["acquire", "release"]);
  });

  it("names the demos the game has when it has none by that name, and records nothing", async () => {
    const host = await observeHost({ demos: ["intro", "boss", 7, "../x"] });
    const answer = await host.clip(CLIP);
    assert.deepEqual(answer, {
      clipProblem: { code: PluginStillProblemCode.ViewUnknown, available: ["intro", "boss"] },
    });
    assert.deepEqual(
      host.log,
      [...UNTIL_DEMO, "restore", "release"],
      "no demo ran, no clock started, nothing recorded",
    );
  });

  it("answers view_unknown for a page with no demo contract", async () => {
    const host = await observeHost({ demos: { __missing: true } });
    assert.deepEqual(await host.clip(CLIP), {
      clipProblem: { code: PluginStillProblemCode.ViewUnknown, available: [] },
    });
  });

  const FAILED: Array<[label: string, page: PageScript]> = [
    ["a demo that throws in the page", { demo: { __error: "TypeError: boom" } }],
    ["a demo that refuses with a reason", { demo: { ok: false, reason: "the hero is not loaded" } }],
  ];
  for (const [label, page] of FAILED) {
    it(`answers view_failed for ${label}, and records nothing`, async () => {
      const host = await observeHost(page);
      const answer = await host.clip(CLIP);
      assert.equal(answer.clipProblem?.code, PluginStillProblemCode.ViewFailed);
      assert.equal(typeof answer.clipProblem?.reason, "string");
      assert.deepEqual(host.log.slice(-2), ["restore", "release"]);
      assert.ok(!host.log.includes("clip"));
    });
  }

  it("answers load_failed for a game that does not load", async () => {
    const host = await observeHost({ loadError: "SyntaxError in src/main.js" });
    const answer = await host.clip(CLIP);
    assert.equal(answer.clipProblem?.code, PluginStillProblemCode.LoadFailed);
    assert.deepEqual(host.log, ["acquire", "resize:1280x720", "load", "restore", "release"]);
  });

  it("answers too_large when even the lowest bitrate is over the byte limit", async () => {
    const host = await observeHost({ clip: async () => ({ tooLarge: { smallestBytes: 9 * MIB } }) });
    const answer = await host.clip(CLIP);
    assert.equal(answer.clipProblem?.code, PluginStillProblemCode.TooLarge);
    assert.match(answer.clipProblem?.reason ?? "", /9437184/);
    assert.deepEqual(host.log.slice(-2), ["restore", "release"]);
  });

  it("answers capture_failed when the recording throws, and gives the window back", async () => {
    const host = await observeHost({
      clip: async () => {
        throw new Error("this page has no canvas to record");
      },
    });
    const answer = await host.clip(CLIP);
    assert.equal(answer.clipProblem?.code, PluginStillProblemCode.CaptureFailed);
    assert.match(answer.clipProblem?.reason ?? "", /no canvas/);
    assert.deepEqual(host.log.slice(-3), ["clip", "restore", "release"]);
  });
});

describe("a plugin's clip and its budget", () => {
  it("has one budget of its seconds and a load allowance", async () => {
    for (const [seconds, budget] of [
      [undefined, 65_000],
      [2, 62_000],
      [10, 70_000],
    ] as const) {
      const clock = heldClock();
      const page = lateLoad();
      const host = await observeHost(page.script, { wait: clock.wait });
      const answer = host.clip({ ...CLIP, ...(seconds ? { seconds } : {}) });
      await page.started;
      assert.deepEqual(clock.asked(), [budget]);
      clock.fire();
      assert.equal((await answer).clipProblem?.code, PluginStillProblemCode.Timeout);
      assert.deepEqual(host.log, ["acquire", "resize:1280x720", "load", "restore", "release"]);
    }
  });

  it("never touches its window again once its budget gave up during the recording", async () => {
    const clock = heldClock();
    const page = lateClip();
    const host = await observeHost(page.script, { wait: clock.wait });
    const answer = host.clip(CLIP);
    await page.started;
    clock.fire();
    assert.equal((await answer).clipProblem?.code, PluginStillProblemCode.Timeout);
    page.arrive();
    await settle();
    assert.deepEqual(usedAfterRelease(host.made), []);
    assert.deepEqual(host.log, [
      ...UNTIL_DEMO,
      "call:demo:hero-shot",
      "hud:off",
      "call:start",
      "clip",
      "restore",
      "release",
    ]);
    assert.deepEqual(host.live.log, []);
  });

  for (const method of ["demo", "start"]) {
    it(`never touches its window again once its budget gave up during __studio.${method}()`, async () => {
      const clock = heldClock();
      const page = lateAnswer(method);
      const host = await observeHost(page.script, { wait: clock.wait });
      const answer = host.clip(CLIP);
      await page.started;
      clock.fire();
      assert.equal((await answer).clipProblem?.code, PluginStillProblemCode.Timeout);
      page.arrive();
      await settle();
      assert.deepEqual(usedAfterRelease(host.made), [], "the page's late answer led to no call on the closed window");
      assert.ok(!host.log.includes("clip"), "nothing was recorded after release");
      assert.deepEqual(host.log.slice(-2), ["restore", "release"]);
    });
  }

  it("refuses a malformed clip through the real host before any window is opened", async () => {
    const host = await observeHost();
    await assert.rejects(host.clip({ ...CLIP, seconds: 11 }), refused);
    await assert.rejects(host.clip({ ...CLIP, demo: "../escape" }), refused);
    assert.deepEqual(host.log, []);
  });
});

/** A WebM's first bytes: the EBML magic and a DocType of `webm`. */
const WEBM_HEAD = Buffer.from([
  0x1a,
  0x45,
  0xdf,
  0xa3,
  0x9f,
  0x42,
  0x86,
  0x81,
  0x01,
  0x42,
  0x82,
  0x84,
  ...Buffer.from("webm"),
]);
/** An MP4's first box: `ftyp` with an `isom` brand. */
const MP4_HEAD = Buffer.from([0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftypisom")]);

/** A small flat BGRA frame of one grey. */
const flat = (grey: number, width = 16, height = 9): MotionFrame => ({
  bgra: Buffer.alloc(width * height * 4, grey),
  width,
  height,
});

/** A page whose recorder the test scripts: what it was asked, in order, and what it answers. */
function scriptedPage(
  options: {
    mimeType?: string;
    takes?: number[];
    videos?: Buffer[];
    poster?: string | null;
    started?: unknown;
    samples?: Array<string | null>;
    read?: (take: number, offset: number, length: number) => unknown;
  } = {},
) {
  const calls: string[] = [];
  const given = options.videos ?? [Buffer.concat([MP4_HEAD, Buffer.alloc(1200, 7)])];
  // The recorder always runs two takes; one scripted video stands for both.
  const videos = given.length === 1 ? [given[0] ?? Buffer.alloc(0), given[0] ?? Buffer.alloc(0)] : given;
  const takes = options.takes ?? videos.map((video) => video.length);
  let sampled = 0;
  const page: ClipPage = {
    async install() {
      calls.push("install");
      return true;
    },
    async start(request) {
      calls.push(`start:${request.fps}:${request.bitrates.length}`);
      if ("started" in options) return options.started;
      return {
        ok: true,
        token: "t1",
        mimeType: options.mimeType ?? "video/mp4;codecs=avc1",
        width: 1280,
        height: 720,
      };
    },
    async sample() {
      calls.push("sample");
      const scripted = options.samples?.[sampled++];
      return scripted === undefined ? `data:image/png;base64,${sampled}` : scripted;
    },
    async stop() {
      calls.push("stop");
      return { takes, poster: options.poster === undefined ? "data:image/jpeg;base64,cG9zdGVy" : options.poster };
    },
    async read(_token, take, offset, length) {
      calls.push(`read:${take}:${offset}:${length}`);
      if (options.read) return options.read(take, offset, length);
      return (videos[take] ?? Buffer.alloc(0)).subarray(offset, offset + length).toString("base64");
    },
    async discard() {
      calls.push("discard");
      return true;
    },
  };
  return { page, calls };
}

/** The recorder's clock and decoders, all the test's: sleeping only moves the clock. */
function recorderDeps(frames: MotionFrame[] = []) {
  let now = 1_000;
  let decoded = 0;
  const slept: number[] = [];
  return {
    slept,
    deps: {
      sleep: async (ms: number) => {
        slept.push(ms);
        now += ms;
      },
      now: () => now,
      bitmap: (url: string) => (url.startsWith("data:image/") ? (frames[decoded++] ?? null) : null),
      jpeg: (url: string, maxPx: number) => (url.startsWith("data:image/") ? Buffer.from(`jpeg<=${maxPx}`) : null),
    },
  };
}

const REQUEST = { seconds: 5, fps: 30, maxBytes: 8 * MIB, posterMaxPx: 1280 };

describe("the recorder's host half", () => {
  it("records for the asked seconds, samples motion, reads the video back in bounded chunks and lets the page forget it", async () => {
    const video = Buffer.concat([MP4_HEAD, Buffer.alloc(1_300_000, 3)]);
    const { page, calls } = scriptedPage({ videos: [video, Buffer.alloc(10)], takes: [video.length, 10] });
    const { deps, slept } = recorderDeps([flat(10), flat(200), flat(10), flat(10)]);
    const answer = await recordClip({ page, ...deps }, REQUEST);
    assert.ok("clip" in answer);
    assert.equal(Buffer.compare(Buffer.from(answer.clip.video), video), 0);
    assert.equal(answer.clip.mimeType, PluginClipMimeType.Mp4);
    assert.deepEqual([answer.clip.width, answer.clip.height, answer.clip.durationMs], [1280, 720, 5000]);
    assert.equal(answer.clip.poster.toString(), "jpeg<=1280");
    assert.ok(Math.abs(answer.clip.motion - 2 / 3) < 1e-9, "two of three sampled pairs differ");
    assert.equal(
      slept.reduce((a, b) => a + b, 0),
      5000,
      "the game ran for exactly the asked seconds",
    );
    const reads = calls.filter((call) => call.startsWith("read:"));
    assert.deepEqual(reads, ["read:0:0:524288", "read:0:524288:524288", `read:0:1048576:${video.length - 1048576}`]);
    assert.deepEqual(calls.slice(0, 2), ["install", "start:30:2"]);
    assert.equal(calls.at(-1), "discard");
  });

  it("keeps the best take that fits, and answers too_large with the smallest when none does", async () => {
    const big = Buffer.concat([MP4_HEAD, Buffer.alloc(3 * MIB)]);
    const small = Buffer.concat([MP4_HEAD, Buffer.alloc(MIB)]);
    const fits = scriptedPage({ videos: [big, small] });
    const kept = await recordClip({ page: fits.page, ...recorderDeps().deps }, { ...REQUEST, maxBytes: 2 * MIB });
    assert.ok("clip" in kept);
    assert.equal(kept.clip.video.length, small.length);
    assert.ok(
      fits.calls.every((call) => !call.startsWith("read:0:")),
      "the take over the limit is never read",
    );
    const none = scriptedPage({ takes: [5 * MIB, 3 * MIB] });
    const over = await recordClip({ page: none.page, ...recorderDeps().deps }, { ...REQUEST, maxBytes: 2 * MIB });
    assert.deepEqual(over, { tooLarge: { smallestBytes: 3 * MIB } });
    assert.equal(none.calls.at(-1), "discard");
  });

  const BROKEN: Array<[label: string, options: Parameters<typeof scriptedPage>[0], pattern: RegExp]> = [
    ["a page that cannot record", { started: { ok: false, reason: "this page has no canvas to record" } }, /no canvas/],
    ["a start that answers nothing", { started: null }, /recorder/],
    ["a container the page names that no clip has", { mimeType: "video/x-matroska" }, /container/],
    [
      "a canvas of no size",
      { started: { ok: true, token: "t1", mimeType: "video/webm", width: 0, height: 0 } },
      /size/,
    ],
    ["a recording that holds no frame", { takes: [0, 0] }, /no frame/],
    ["a recording with no poster", { poster: null }, /no frame/],
    ["WebM bytes from a recorder that said MP4", { videos: [Buffer.concat([WEBM_HEAD, Buffer.alloc(64)])] }, /not the/],
    ["bytes of no container at all", { videos: [Buffer.from("not a video at all")] }, /not the/],
    ["a chunk that is not text", { read: () => 42 }, /chunk/],
    ["a chunk shorter than asked", { read: () => MP4_HEAD.subarray(0, 4).toString("base64") }, /chunk/],
    ["more takes than were started", { takes: [100, 100, 100] }, /takes/],
    ["a take of a fractional size", { takes: [100.5, 10] }, /takes/],
  ];
  for (const [label, options, pattern] of BROKEN) {
    it(`refuses ${label}, and lets the page forget the recording`, async () => {
      const { page, calls } = scriptedPage(options);
      await assert.rejects(recordClip({ page, ...recorderDeps().deps }, REQUEST), pattern);
      if (!("started" in (options ?? {}))) assert.equal(calls.at(-1), "discard");
    });
  }

  it("asks for bitrates that fit the byte limit with room to spare, the second lower", () => {
    for (const [seconds, maxBytes] of [
      [2, 256 * KIB],
      [5, 8 * MIB],
      [10, 8 * MIB],
      [10, 256 * KIB],
    ] as const) {
      const rates = clipBitrates(seconds, maxBytes);
      assert.equal(rates.length, 2);
      const [first = 0, second = 0] = rates;
      assert.ok(first * seconds <= maxBytes * 8 * 0.85, `${seconds}s in ${maxBytes} bytes`);
      assert.ok(second < first);
      assert.ok(rates.every((rate) => Number.isInteger(rate) && rate > 0));
    }
  });
});

describe("a clip's motion and container", () => {
  it("scores a frozen recording 0 and one that keeps moving 1, ignoring noise", () => {
    assert.equal(clipMotion([flat(40), flat(40), flat(40), flat(40)]), 0);
    assert.equal(
      clipMotion([flat(40), flat(43), flat(40), flat(44)]),
      0,
      "a few levels of encoder noise is not motion",
    );
    assert.equal(clipMotion([flat(40), flat(120), flat(40), flat(120)]), 1);
    assert.equal(clipMotion([flat(40)]), 0);
    assert.equal(clipMotion([]), 0);
    assert.equal(clipMotion([flat(40), flat(200, 8, 8), flat(40)]), 0, "frames of different sizes are never compared");
  });

  it("names a WebM or an MP4 by its bytes, and nothing else", () => {
    assert.equal(sniffClipContainer(WEBM_HEAD), PluginClipMimeType.Webm);
    assert.equal(sniffClipContainer(MP4_HEAD), PluginClipMimeType.Mp4);
    const matroska = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...Buffer.from("matroska")]);
    for (const bytes of [Buffer.alloc(0), Buffer.from("ftyp"), Buffer.from("GIF89a....."), matroska])
      assert.equal(sniffClipContainer(bytes), null);
  });
});
