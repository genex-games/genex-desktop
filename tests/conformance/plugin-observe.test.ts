/**
 * The `observe` host service, and its `still` (API 3, additive): one named view of the bound game
 * (a demo run to its end, or a camera) photographed on a hidden window of its own, at the size the
 * plugin asks for. Every input a plugin controls is checked before anything runs; the window is the
 * still's alone and is given back however the still ends; Live, the person's own window, is never
 * touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { PluginStillProblemCode, type PluginBinding } from "../../src/shared/plugins.ts";
import { copyOfExample, pluginFixture } from "../helpers/plugins.ts";
import {
  FRAME,
  heldClock,
  lateAnswer,
  lateLoad,
  observeHost,
  type PageScript,
  settle,
  usedAfterRelease,
} from "../helpers/observe-windows.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MIB = 1024 * 1024;
const STILL = { demo: "hero-shot", width: 1920, height: 1080 } as const;
const DEFAULT_MAX_BYTES = 8 * MIB;

/**
 * A refusal for its own reason: a TypeError (a property read off a value nobody checked) never
 * passes for one, so each row fails until the host refuses that input on purpose.
 */
const refused = (error: unknown) => error instanceof Error && !(error instanceof TypeError);

/** A game folder, a folder outside it and a link from one to the other, with a recording `observe`. */
async function observeServices() {
  const root = await realpath(await tmpDir("studio-observe-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(game);
  await mkdir(outside);
  await writeFile(path.join(game, "index.html"), "<canvas></canvas>");
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(game, "linked"), "junction");
  const seen: unknown[][] = [];
  const services = new PluginServices(path.join(root, "data"), {}, async (...args: unknown[]) => {
    seen.push(args);
    return { observed: true };
  });
  const binding: PluginBinding = { project: "game", directory: game };
  return { game, outside, services, binding, seen };
}

/** Arguments the host refuses for today's `observe`, with or without a still. */
function worktreeRows(game: string, outside: string): Array<[label: string, args: unknown]> {
  const plain = { project: "game", root: game, files: [] as unknown[] };
  return [
    ["arguments that are not an object", "index.html"],
    ["arguments that are null", null],
    ["another project", { ...plain, project: "other" }],
    ["another root", { ...plain, root: outside }],
    ["a root that resolves out of the game", { ...plain, root: path.join(game, "..", "outside") }],
    ["a root that is not a string", { ...plain, root: 42 }],
    ["files that are not a list", { ...plain, files: "index.html" }],
    ["more than 1000 files", { ...plain, files: new Array(1001).fill("index.html") }],
    ["a file that climbs out of the game", { ...plain, files: ["../outside/secret.txt"] }],
    ["an absolute file", { ...plain, files: [path.join(outside, "secret.txt")] }],
    ["a file through a link out of the game", { ...plain, files: ["linked/secret.txt"] }],
    ["a file that is not there", { ...plain, files: ["missing.png"] }],
    ["a file that is not a string", { ...plain, files: [42] }],
  ];
}

/** Stills the host refuses, whatever else the call says. */
const NAMES: Array<[label: string, name: unknown]> = [
  ["empty", ""],
  ["65 characters", "x".repeat(65)],
  ["a parent step", "../x"],
  ["a slash", "a/b"],
  ["a quote", 'a"b'],
  ["a backslash", "a\\b"],
  ["a newline", "a\nb"],
  ["a NUL", "a\u0000b"],
  ["a line separator", "a b"],
  ["a leading hyphen", "-x"],
  ["a leading dot", ".x"],
  ["a space", "hero shot"],
  ["a number", 42],
  ["null", null],
  ["a list", ["hero-shot"]],
];
const SIDES: Array<[label: string, value: unknown]> = [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["a string", "1080"],
  ["null", null],
  ["missing", undefined],
];
const BYTES: Array<[label: string, value: unknown]> = [
  ["zero", 0],
  ["below 64 KiB", 64 * 1024 - 1],
  ["above 16 MiB", 16 * MIB + 1],
  ["fractional", MIB + 0.5],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["a string", String(DEFAULT_MAX_BYTES)],
  ["null", null],
];
function stillRows(): Array<[label: string, still: unknown, files?: unknown[]]> {
  return [
    ["a still that is a string", "hero-shot"],
    ["a still that is null", null],
    ["a still that is a number", 1920],
    ["a still that is a list", [STILL]],
    ["both a demo and a camera", { ...STILL, camera: "close" }],
    ["neither a demo nor a camera", { width: 1920, height: 1080 }],
    ["neither, spelled as undefined", { demo: undefined, camera: undefined, width: 1920, height: 1080 }],
    ...NAMES.map(([label, name]): [string, unknown] => [`a demo name that is ${label}`, { ...STILL, demo: name }]),
    ...NAMES.map(([label, name]): [string, unknown] => [
      `a camera name that is ${label}`,
      { camera: name, width: 1920, height: 1080 },
    ]),
    ...SIDES.map(([label, width]): [string, unknown] => [`a width that is ${label}`, { ...STILL, width }]),
    ...SIDES.map(([label, height]): [string, unknown] => [`a height that is ${label}`, { ...STILL, height }]),
    ["a width below a window's least", { ...STILL, width: 319 }],
    ["a width above a window's most", { ...STILL, width: 1921 }],
    ["a height below a window's least", { ...STILL, height: 239 }],
    ["a height above a window's most", { ...STILL, height: 1201 }],
    ...BYTES.map(([label, maxBytes]): [string, unknown] => [`a byte limit that is ${label}`, { ...STILL, maxBytes }]),
    ["an unknown key", { ...STILL, format: "png" }],
    ["an own constructor key", { ...STILL, constructor: "Object" }],
    ["files beside a still", STILL, ["index.html"]],
  ];
}

describe("observe refuses what a plugin may not ask, before anything runs", () => {
  it("refuses a call outside the bound worktree or its files", async () => {
    const { game, outside, services, binding, seen } = await observeServices();
    for (const [label, args] of worktreeRows(game, outside)) {
      await assert.rejects(services.call("example", "observe", args, binding), refused, label);
      const withStill = args !== null && typeof args === "object" ? { ...args, still: STILL } : args;
      await assert.rejects(services.call("example", "observe", withStill, binding), refused, `${label}, with a still`);
    }
    await assert.rejects(
      services.call("example", "observe", { project: "game", root: game, files: [] }),
      refused,
      "a call with no bound game",
    );
    assert.deepEqual(seen, [], "the host never looked");
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "secret");
  });

  for (const [label, still, files] of stillRows()) {
    it(`refuses ${label}`, async () => {
      const { game, services, binding, seen } = await observeServices();
      const args = { project: "game", root: game, files: files ?? [], still };
      await assert.rejects(services.call("example", "observe", args, binding), refused);
      assert.deepEqual(seen, [], "no window was leased, resized or loaded: the host was never asked");
    });
  }

  it("hands the host a still in its canonical shape, the byte limit filled in", async () => {
    const { game, services, binding, seen } = await observeServices();
    const accepted: Array<[asked: Record<string, unknown>, handed: Record<string, unknown>]> = [
      [{ ...STILL }, { ...STILL, maxBytes: DEFAULT_MAX_BYTES }],
      [
        { camera: "eye:down", width: 320, height: 240, maxBytes: 64 * 1024 },
        { camera: "eye:down", width: 320, height: 240, maxBytes: 64 * 1024 },
      ],
      [
        { demo: "a".repeat(64), camera: undefined, width: 1920, height: 1200, maxBytes: 16 * MIB },
        { demo: "a".repeat(64), width: 1920, height: 1200, maxBytes: 16 * MIB },
      ],
      [
        { demo: "Boss_Fight:2", width: 1280, height: 720, maxBytes: undefined },
        { demo: "Boss_Fight:2", width: 1280, height: 720, maxBytes: DEFAULT_MAX_BYTES },
      ],
    ];
    for (const [asked, handed] of accepted) {
      const answer = await services.call(
        "example",
        "observe",
        { project: "game", root: game, files: [], still: asked },
        binding,
      );
      assert.deepEqual(answer, { observed: true });
      assert.deepEqual(seen.at(-1), [binding, [], handed]);
    }
  });

  it("still observes delivered files the way it always has, with no still", async () => {
    const { game, services, binding, seen } = await observeServices();
    await services.call("example", "observe", { project: "game", root: game, files: ["index.html"] }, binding);
    assert.deepEqual(seen, [[binding, ["index.html"], undefined]]);
  });

  it("answers a plugin without the observe capability with a refusal, and never asks the host", async () => {
    const seen: unknown[] = [];
    const f = await pluginFixture({
      installed: "local",
      observe: async (...args: unknown[]) => {
        seen.push(args);
        return { still: null };
      },
    });
    try {
      const dir = await copyOfExample(f.root, "still-taker");
      await writeFile(
        path.join(dir, "backend.mjs"),
        `export async function activate(){return {tool(n,a,c){return c.host('observe',{project:c.project,root:c.directory,files:[],still:${JSON.stringify(STILL)}})}}}`,
      );
      await f.registry.installLocal(dir);
      await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /capability denied/);
      assert.deepEqual(seen, []);
      const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
      manifest.capabilities.push("observe");
      await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
      await f.registry.installLocal(dir, "local", manifest.capabilities);
      assert.deepEqual(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), { still: null });
      assert.deepEqual(seen, [[f.binding, [], { ...STILL, maxBytes: DEFAULT_MAX_BYTES }]]);
    } finally {
      await f.close();
    }
  });
});

/** The pooled window's whole life when a still of the default size ends before the picture. */
const UNTIL_VIEW = ["acquire", "resize:1920x1080", "load", "call:start"];

describe("a plugin's still of one named view", () => {
  it("leases a window, sizes it, loads the game, plays it, runs the demo, photographs it and gives the window back", async () => {
    const host = await observeHost();
    const answer = await host.still(STILL);
    assert.deepEqual(host.log, [...UNTIL_VIEW, "call:demos", "call:demo:hero-shot", "still", "restore", "release"]);
    assert.deepEqual(host.made[0]?.asked, [
      { width: 1920, height: 1080, maxBytes: DEFAULT_MAX_BYTES, previewMaxPx: 1280 },
    ]);
    assert.deepEqual(answer, { still: { ...FRAME, view: { demo: "hero-shot" } } });
    assert.deepEqual(host.live.log, [], "Live was never touched");
  });

  it("places a camera instead of running a demo when the still names one", async () => {
    const host = await observeHost();
    const answer = await host.still({ camera: "eye:down", width: 1280, height: 720, maxBytes: MIB });
    assert.deepEqual(host.log, [
      "acquire",
      "resize:1280x720",
      "load",
      "call:start",
      "call:cameras",
      "call:eyes",
      "call:debugCamera:eye:down",
      "still",
      "restore",
      "release",
    ]);
    assert.deepEqual(host.made[0]?.asked, [{ width: 1280, height: 720, maxBytes: MIB, previewMaxPx: 1280 }]);
    assert.deepEqual(answer.still?.view, { camera: "eye:down" });
    assert.deepEqual(host.live.log, []);
  });

  it("answers unavailable without touching Live when the build has no hidden window", async () => {
    const host = await observeHost({}, { hidden: false });
    assert.equal((await host.still(STILL)).stillProblem?.code, PluginStillProblemCode.Unavailable);
    assert.deepEqual(host.live.log, [], "no load, no resize, no call: the person's window is theirs");
  });

  it("answers unavailable when there is no preview at all", async () => {
    const host = await observeHost({}, { hidden: false, preview: false });
    assert.equal((await host.still(STILL)).stillProblem?.code, PluginStillProblemCode.Unavailable);
  });

  it("answers unavailable on a window that cannot take a still, and gives it back", async () => {
    const host = await observeHost({ noStill: true });
    assert.equal((await host.still(STILL)).stillProblem?.code, PluginStillProblemCode.Unavailable);
    assert.deepEqual(host.log, ["acquire", "release"]);
  });
});

describe("a plugin's still of a view the game cannot put on screen", () => {
  it("names the demos the game has when it has none by that name, at most 32 and only names a still could ask for", async () => {
    const extras = Array.from({ length: 40 }, (_, i) => `extra-${i}`);
    const host = await observeHost({ demos: ["intro", "boss", 7, "../x", "a b", "boss", ...extras] });
    const answer = await host.still(STILL);
    assert.equal(answer.stillProblem?.code, PluginStillProblemCode.ViewUnknown);
    assert.deepEqual(answer.stillProblem?.available, ["intro", "boss", ...extras.slice(0, 30)]);
    assert.deepEqual(
      host.log,
      [...UNTIL_VIEW, "call:demos", "restore", "release"],
      "no demo ran and no picture was taken",
    );
  });

  it("answers view_unknown for a page with no demo contract", async () => {
    const host = await observeHost({ demos: { __missing: true } });
    const answer = await host.still(STILL);
    assert.deepEqual(answer, { stillProblem: { code: PluginStillProblemCode.ViewUnknown, available: [] } });
  });

  it("names the cameras the game has when it has none by that name, and never asks the page to place it", async () => {
    // A page that would place anything it is asked to: the template looks a name up on a plain
    // object, so an inherited `constructor` or `toString` would "place" a camera it never declared.
    const page = { cameras: ["default", "close", "close", 7], eyes: ["eye:down"], debugCamera: { ok: true } };
    for (const name of ["wide", "constructor", "toString", "hasOwnProperty"]) {
      const host = await observeHost(page);
      const answer = await host.still({ camera: name, width: 1920, height: 1080 });
      assert.equal(answer.stillProblem?.code, PluginStillProblemCode.ViewUnknown, name);
      assert.deepEqual(answer.stillProblem?.available, ["default", "close", "eye:down"], name);
      assert.deepEqual(
        host.log,
        [...UNTIL_VIEW, "call:cameras", "call:eyes", "restore", "release"],
        `${name}: no camera was placed and no picture taken`,
      );
    }
  });

  it("places the game's own view by `default` even when the game names its cameras otherwise", async () => {
    const host = await observeHost({ cameras: ["close"], eyes: [] });
    const answer = await host.still({ camera: "default", width: 1920, height: 1080 });
    assert.deepEqual(answer.still?.view, { camera: "default" });
    assert.ok(host.log.includes("call:debugCamera:default"));
  });

  it("answers view_unknown for a camera on a page with no camera contract", async () => {
    const host = await observeHost({ cameras: { __missing: true }, eyes: { __missing: true } });
    const answer = await host.still({ camera: "close", width: 1920, height: 1080 });
    assert.deepEqual(answer, { stillProblem: { code: PluginStillProblemCode.ViewUnknown, available: [] } });
    assert.ok(!host.log.some((entry) => entry.startsWith("call:debugCamera")));
  });

  const FAILED_VIEWS: Array<[label: string, page: PageScript, still: Record<string, unknown>]> = [
    ["a demo that throws in the page", { demo: { __error: "TypeError: boom" } }, STILL],
    ["a demo that refuses with a reason", { demo: { ok: false, reason: "the hero is not loaded" } }, STILL],
    [
      "a camera the game cannot place",
      { debugCamera: { ok: false, reason: "pass `camera` and `player()` to installStudio" } },
      { camera: "eye:down", width: 1920, height: 1080 },
    ],
  ];
  for (const [label, page, still] of FAILED_VIEWS) {
    it(`answers view_failed for ${label}, and gives the window back`, async () => {
      const host = await observeHost(page);
      const answer = await host.still(still);
      assert.equal(answer.stillProblem?.code, PluginStillProblemCode.ViewFailed);
      assert.equal(typeof answer.stillProblem?.reason, "string");
      assert.deepEqual(host.log.slice(-2), ["restore", "release"]);
      assert.ok(!host.log.includes("still"));
    });
  }
});

describe("a plugin's still that ends before its picture", () => {
  it("answers load_failed for a game that does not load, and photographs nothing", async () => {
    const host = await observeHost({ loadError: "SyntaxError in src/main.js" });
    const answer = await host.still(STILL);
    assert.equal(answer.stillProblem?.code, PluginStillProblemCode.LoadFailed);
    assert.match(answer.stillProblem?.reason ?? "", /SyntaxError/);
    assert.deepEqual(host.log, ["acquire", "resize:1920x1080", "load", "restore", "release"]);
  });

  it("answers too_large when no encoding fits the byte limit", async () => {
    const host = await observeHost({ still: async () => ({ tooLarge: { smallestBytes: 9 * MIB } }) });
    const answer = await host.still(STILL);
    assert.equal(answer.stillProblem?.code, PluginStillProblemCode.TooLarge);
    assert.deepEqual(host.log.slice(-2), ["restore", "release"]);
  });

  it("gives the window back when the picture throws, and says the capture failed", async () => {
    const host = await observeHost({
      still: async () => {
        throw new Error("the page produced no frame to photograph");
      },
    });
    const answer = await host.still(STILL);
    assert.equal(answer.stillProblem?.code, PluginStillProblemCode.CaptureFailed);
    assert.match(answer.stillProblem?.reason ?? "", /no frame/);
    assert.deepEqual(host.log.slice(-3), ["still", "restore", "release"]);
    assert.deepEqual(host.live.log, []);
  });

  it("answers timeout when its minute runs out, and gives the window back without waiting for the page", async () => {
    const clock = heldClock();
    const page = lateLoad();
    const host = await observeHost(page.script, { wait: clock.wait });
    const answer = host.still(STILL);
    await page.started;
    assert.deepEqual(clock.asked(), [60_000], "the whole still has one minute");
    clock.fire();
    assert.equal((await answer).stillProblem?.code, PluginStillProblemCode.Timeout);
    assert.deepEqual(host.log, ["acquire", "resize:1920x1080", "load", "restore", "release"]);
    assert.deepEqual(host.live.log, []);
  });

  it("never touches its window again once its budget gave up: a page that arrives late is not even asked if it is ready", async () => {
    const clock = heldClock();
    const page = lateLoad();
    const host = await observeHost(page.script, { wait: clock.wait });
    const answer = host.still(STILL);
    await page.started;
    clock.fire();
    assert.equal((await answer).stillProblem?.code, PluginStillProblemCode.Timeout);
    page.arrive();
    await settle();
    assert.deepEqual(
      usedAfterRelease(host.made),
      [],
      "no ready probe, no status, nothing after the window was given back",
    );
    assert.deepEqual(
      host.log,
      ["acquire", "resize:1920x1080", "load", "restore", "release"],
      "nothing was played, placed or photographed in the window after it was given back",
    );
  });

  const SLOW_ANSWERS: Array<[method: string, still: Record<string, unknown>, until: string[]]> = [
    ["start", STILL, UNTIL_VIEW],
    ["demos", STILL, [...UNTIL_VIEW, "call:demos"]],
    ["demo", STILL, [...UNTIL_VIEW, "call:demos", "call:demo:hero-shot"]],
  ];
  for (const [method, still, until] of SLOW_ANSWERS) {
    it(`never touches its window again once its budget gave up during __studio.${method}()`, async () => {
      const clock = heldClock();
      const page = lateAnswer(method);
      const host = await observeHost(page.script, { wait: clock.wait });
      const answer = host.still(still);
      await page.started;
      clock.fire();
      assert.equal((await answer).stillProblem?.code, PluginStillProblemCode.Timeout);
      page.arrive();
      await settle();
      assert.deepEqual(usedAfterRelease(host.made), [], "the page's late answer led to no call on the closed window");
      assert.deepEqual(
        host.log,
        [...until, "restore", "release"],
        "nothing ran, was placed or photographed after release",
      );
    });
  }

  it("refuses a malformed still through the real host before any window is opened", async () => {
    const host = await observeHost();
    await assert.rejects(host.still({ ...STILL, width: 1921 }), refused);
    await assert.rejects(host.still({ ...STILL, demo: "../escape" }), refused);
    assert.deepEqual(host.log, [], "no window was leased");
    assert.deepEqual(host.live.log, []);
  });
});
