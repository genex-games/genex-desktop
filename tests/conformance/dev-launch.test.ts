import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeChild, readVersion } from "../../scripts/studio-dev/files.mjs";
import { allocateProfile, validateProfile, assertStopped } from "../../scripts/studio-dev/ownership.mjs";
import { registerHooks } from "node:module";
import { DevError, DevErrorCode, DevMethod, NativeCaptureFrame, operationSchema } from "../../src/main/dev/protocol.ts";
import { parseStudioDevArgs } from "../../scripts/studio-dev/args.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import { computePixelStats } from "../../src/substrate/pixel-stats.ts";
import { NativeOp } from "../../src/shared/native-contract.ts";
test("build identity includes project licenses and refuses notice changes during publication", async (t) => {
  const { sourceIdentity, publishBuild, maintained } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-notices-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, ".studio-dev/builds/b-notices");
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) fs.writeFileSync(path.join(root, file), "{}");
  fs.writeFileSync(path.join(root, "node_modules/electron/package.json"), '{"version":"43.7.6"}');
  fs.writeFileSync(path.join(root, "LICENSE"), "Fixture project license");
  fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "Fixture source notices");
  const before = sourceIdentity(root);
  assert.ok(maintained(root).includes("LICENSE"));
  assert.ok(maintained(root).includes("THIRD-PARTY-NOTICES.md"));
  fs.writeFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "Changed attribution");
  assert.throws(() => publishBuild(root, output, "b-notices", before), /inputs changed/);
  assert.equal(fs.existsSync(path.join(output, "build.json")), false);
});
for (const input of ["native/angle/bundle-lock.json", "native/genex-frames/receiver.c", "build/icon.icns"]) {
  test(`build identity copies and detects changes to ${input}`, async (t) => {
    const { sourceIdentity, publishBuild, maintained } = await import("../../scripts/studio-dev/files.mjs");
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-inputs-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, ".studio-dev/builds/b-native");
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) fs.writeFileSync(path.join(root, file), "{}");
    fs.writeFileSync(path.join(root, "node_modules/electron/package.json"), '{"version":"43.7.6"}');
    fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
    fs.writeFileSync(path.join(root, input), "Fixture build input");
    assert.ok(maintained(root).includes(input), "disposable checkouts must copy this build input");
    const before = sourceIdentity(root);
    fs.writeFileSync(path.join(root, input), "Changed native resource");
    assert.notEqual(sourceIdentity(root).sourceDigest, before.sourceDigest);
    assert.throws(() => publishBuild(root, output, "b-native", before), /inputs changed/);
    assert.equal(fs.existsSync(path.join(output, "build.json")), false);
  });
}
test("owned profiles reject traversal, aliases, copied ownership, silent reuse and provider changes", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const rel of ["..", "../normal", "/tmp", "a/../b", "a//b"]) assert.throws(() => safeChild(root, rel));
  fs.symlinkSync(os.tmpdir(), path.join(root, "alias"));
  assert.throws(() => safeChild(root, "alias/games"), /symlink/);
  const a = allocateProfile(root, "a", "fixture", "app-basics");
  const b = allocateProfile(root, "b", "fixture", "app-basics");
  assert.notEqual(a.core, b.core);
  assert.notEqual(a.games, b.games);
  assert.throws(() => allocateProfile(root, "a", "fixture", "app-basics"), /reuse/);
  assert.throws(() => allocateProfile(root, "a", "live", null, true), /change provider/);
  fs.writeFileSync(
    path.join(a.root, "lease.json"),
    JSON.stringify({ version: 1, ownerId: a.ownerId, pid: process.pid }),
  );
  assert.throws(() => assertStopped(a), /running/);
  fs.writeFileSync(path.join(b.root, "owner.json"), JSON.stringify({ ...a, root: b.root, profileId: "b" }));
  assert.throws(() => validateProfile(root, "b"), /copied/);
  fs.writeFileSync(path.join(root, "unknown.json"), '{"version":2}');
  assert.throws(() => readVersion(path.join(root, "unknown.json")), /version/);
});
test("a profile folder deleted by hand frees its id; any other leftover owner record is refused before anything is made", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-orphan-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = allocateProfile(root, "gate", "live", null);
  fs.rmSync(first.root, { recursive: true });
  const again = allocateProfile(root, "gate", "live", null);
  assert.notEqual(again.ownerId, first.ownerId, "a new profile, not the deleted one reused");
  assert.equal(validateProfile(root, "gate").ownerId, again.ownerId, "the record and the folder agree");

  const record = (id: string) => path.join(root, ".studio-dev", "owners", `${id}.json`);
  const folder = (id: string) => path.join(root, ".studio-dev", "profiles", id);
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-orphan-other-")));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const hostile: Array<[string, string, (id: string) => void]> = [
    [
      "another checkout's record",
      "other-checkout",
      (id) => {
        fs.writeFileSync(
          record(id),
          JSON.stringify({ version: 1, profileId: id, root: folder(id), checkout: elsewhere }),
        );
      },
    ],
    [
      "a record naming another folder",
      "other-root",
      (id) => {
        fs.writeFileSync(record(id), JSON.stringify({ version: 1, profileId: id, root: elsewhere, checkout: root }));
      },
    ],
    [
      "a record of another profile id",
      "other-id",
      (id) => {
        fs.writeFileSync(
          record(id),
          JSON.stringify({ version: 1, profileId: "gate", root: folder(id), checkout: root }),
        );
      },
    ],
    ["an unreadable record", "garbled", (id) => fs.writeFileSync(record(id), "{")],
    [
      "a record of another version",
      "versioned",
      (id) => {
        fs.writeFileSync(record(id), JSON.stringify({ version: 2, profileId: id, root: folder(id), checkout: root }));
      },
    ],
    [
      "a record that is a link",
      "linked",
      (id) => {
        const target = path.join(elsewhere, `${id}.json`);
        fs.writeFileSync(target, JSON.stringify({ version: 1, profileId: id, root: folder(id), checkout: root }));
        fs.symlinkSync(target, record(id));
      },
    ],
  ];
  for (const [name, id, plant] of hostile) {
    plant(id);
    const before = fs.readFileSync(record(id), "utf8");
    assert.throws(() => allocateProfile(root, id, "live", null), Error, name);
    assert.equal(fs.existsSync(folder(id)), false, `${name}: no profile folder made`);
    assert.equal(fs.readFileSync(record(id), "utf8"), before, `${name}: the record is left as it was`);
  }
});

test("closed controller schema rejects privileged fields, eval, unbounded work and unsafe artifacts", () => {
  for (const value of [
    { method: "evaluate", params: { expression: "process.exit()" } },
    { method: "stop", params: { pid: 42 } },
    { method: "capture", params: { surface: "desktop", name: "../private" } },
    { method: "click", params: { selector: "button", webContentsId: 1 } },
    { method: "trace.start", params: { traceId: "trace", durationMs: 600000, categories: ["*"] } },
    {
      method: "game.input",
      params: {
        actions: [
          { type: "wait", ms: 8000 },
          { type: "wait", ms: 8000 },
        ],
      },
    },
  ])
    assert.equal(operationSchema.safeParse(value).success, false);
  assert.equal(operationSchema.safeParse({ method: "click", params: { selector: "button" } }).success, true);
});

test("game.input takes px on a click and a move, as the preview's action union does", () => {
  const actions = [
    { type: "move", x: 130, y: 236, px: true },
    { type: "click", x: 0.5, y: 0.5, px: true, button: "left" },
  ];
  const parsed = operationSchema.safeParse({ method: "game.input", params: { surface: "native", actions } });
  assert.equal(parsed.success, true, parsed.success ? "" : parsed.error.message);
  const notFlag = { type: "move", x: 1, y: 1, px: "yes" };
  assert.equal(operationSchema.safeParse({ method: "game.input", params: { actions: [notFlag] } }).success, false);
});
test("build publication refuses inputs changed during build and never publishes a ready manifest", async (t) => {
  const { sourceIdentity, publishBuild } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-build-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, ".studio-dev/builds/b-test");
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules/electron"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "node_modules/electron/package.json"), '{"version":"43.4.1"}');
  fs.writeFileSync(path.join(root, "src/a.ts"), "before");
  const before = sourceIdentity(root);
  fs.writeFileSync(path.join(root, "src/a.ts"), "after");
  assert.throws(() => publishBuild(root, output, "b-test", before), /changed during build/);
  assert.equal(fs.existsSync(path.join(output, "build.json")), false);
  publishBuild(root, output, "b-test", sourceIdentity(root));
  assert.equal(readVersion(path.join(output, "build.json")).flags.developer, true);
});
test("lost debugger ownership is explicit and does not silently reattach", async () => {
  const { DesktopControl } = await import("../../src/main/dev/control.ts");
  let attached = false,
    calls = 0;
  const wc = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true;
      },
      sendCommand: async () => {
        calls++;
        return {};
      },
    },
  };
  const control = new DesktopControl();
  await control.cdp(wc as any, "Profiler.enable");
  attached = false;
  await assert.rejects(control.cdp(wc as any, "Profiler.start"), /restart the owned session/);
  assert.equal(calls, 1);
});
test("interrupted controller response cannot be reported as a successful capture", async (t) => {
  const { createServer } = await import("node:net");
  const { request } = await import("../../scripts/studio-dev/client.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-test-"));
  // Node's local sockets are named pipes on Windows, which live in their own namespace.
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, "s");
  const server = createServer((client) => client.once("data", () => client.end('{"version":1')));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    request(
      { instanceId: "00000000-0000-4000-8000-000000000001", capability: "0".repeat(64), socket },
      { method: "capture", params: { surface: "desktop", name: "interrupted" } },
    ),
    /closed before response/,
  );
});

/**
 * `--surface native` reaches a C++ game's own run (the open game's Play window, else its newest
 * agent run): its state, its input, a capture and its console. Everything else has no native
 * counterpart (no web contents to profile, snapshot, type into or scroll) and is refused
 * `UnsupportedSurface` before anything runs. The runtime module is loaded with Electron stood in.
 */
let electronStoodIn = false;
/** The runtime module, with Electron stood in (once per process: the hook stays registered). */
async function runtimeModule() {
  if (!electronStoodIn) {
    electronStoodIn = true;
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier !== "electron") return next(specifier, context);
        const stub = "export const app = {}; export const contentTracing = {}; export default {};";
        return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
      },
    });
  }
  return import("../../src/main/dev/runtime.ts");
}

test("--surface native refuses cpu profiles, heaps, keys and scrolls with UnsupportedSurface", async () => {
  const { asksNative, refuseNativeOperation } = await runtimeModule();
  const diagnostics = (method: string, params: Record<string, unknown>) => {
    const args = ["diagnostics", "--profile", "p", "--json", JSON.stringify({ method, params })];
    const { operation } = parseStudioDevArgs(args);
    assert.ok(operation, method);
    return operation;
  };
  const refused = [
    diagnostics("cpu.start", { surface: "native", profileId: "p1" }),
    diagnostics("cpu.stop", { surface: "native", profileId: "p1" }),
    diagnostics("heap", { surface: "native", name: "h1" }),
    diagnostics("key", { surface: "native", key: "a", code: "KeyA" }),
    diagnostics("scroll", { surface: "native", deltaX: 0, deltaY: 10 }),
  ];
  for (const operation of refused) {
    assert.equal(asksNative(operation), true, operation.method);
    assert.throws(
      () => refuseNativeOperation(operation),
      (error: unknown) => error instanceof DevError && error.code === DevErrorCode.UnsupportedSurface,
      operation.method,
    );
  }
  const capture = parseStudioDevArgs(["capture", "--profile", "p", "--surface", "native", "--name", "c1"]).operation;
  const logs = parseStudioDevArgs(["logs", "--profile", "p", "--surface", "native"]).operation;
  for (const operation of [capture, logs]) {
    assert.ok(operation);
    assert.equal(asksNative(operation), true, operation.method);
    assert.doesNotThrow(() => refuseNativeOperation(operation), operation.method);
  }
  const game = parseStudioDevArgs(["capture", "--profile", "p", "--surface", "game"]).operation;
  assert.ok(game);
  assert.equal(asksNative(game), false, "the game view is not the native surface");
});

/** A native run's port as far as the dev control reaches it, and the runtime parts around it. */
function nativeSurface(
  root: string,
  options: { project?: string | null; port?: boolean; console?: number; size?: number; live?: null } = {},
) {
  const asked: string[] = [];
  const bgra = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
  const port = {
    call: async (op: string, arg?: unknown) => {
      asked.push(`${op} ${JSON.stringify(arg)}`);
      return { preset: "high", frameBudgetMs: 4 };
    },
    studioState: async () => ({ tick: 7 }),
    input: async () => ({ ok: true, applied: 0, width: 2, height: 2 }),
    screenshotWithStats: async () => ({
      jpeg: Buffer.from("jpeg-bytes"),
      stats: { ...computePixelStats(bgra, 2, 2), canvas: true },
      surface: CaptureSurface.Canvas,
      provenance: { seq: 1, digest: null, camera: "default", runId: null, build: null, render: null, outputSize: null },
    }),
    screenshotAt: async (size: { width: number; height: number }) => {
      asked.push(`capture at ${size.width}x${size.height}`);
      return {
        jpeg: Buffer.from("sized-jpeg"),
        stats: { ...computePixelStats(bgra, 2, 2), width: size.width, height: size.height, canvas: true },
        surface: CaptureSurface.Canvas,
        provenance: {
          seq: 2,
          digest: null,
          camera: "default",
          runId: null,
          build: null,
          render: null,
          outputSize: size,
        },
      };
    },
    consoleEntries: () =>
      Array.from({ length: options.console ?? 5 }, (_, line) => ({
        at: line,
        level: "warning",
        message: `${"w".repeat(options.size ?? 0)}line ${line} secret`,
        source: "native",
      })),
  };
  const rt = {
    // The studio window's Native view as composited: what the person sees (null: not shown).
    liveNativeView: async () =>
      options.live === null ? null : { png: Buffer.from("live-png"), dimensions: { width: 4, height: 3 } },
    preview: { status: () => ({ project: options.project === undefined ? "pong" : options.project }) },
    core: {
      runPreviewIdentity: () => ({ project: null }),
      nativeRuns: {
        portOf: (project: string) => {
          asked.push(project);
          return options.port === false ? null : port;
        },
      },
    },
    diagnostics: { destination: async (name: string) => path.join(root, name) },
    sanitize: (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("secret", "[redacted]")),
  };
  return { rt, asked };
}

const devOperation = (args: string[]) => {
  const { operation } = parseStudioDevArgs(args);
  assert.ok(operation, args.join(" "));
  return operation;
};

test("--surface native captures the open game's run into the evidence folder, once per name, 0600", async (t) => {
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt, asked } = nativeSurface(root);
  const capture = devOperation(["capture", "--profile", "p", "--surface", "native", "--name", "c1"]);
  const shot = (await performNative(rt, capture)) as { file: string; surface: string; dimensions: unknown };
  assert.deepEqual(asked, ["pong"], "the open game's run");
  assert.equal(shot.file, path.join(root, "native-c1.jpg"));
  assert.equal(shot.surface, "native");
  assert.deepEqual(shot.dimensions, { width: 2, height: 2 });
  assert.equal(fs.readFileSync(shot.file, "utf8"), "jpeg-bytes");
  if (process.platform !== "win32") assert.equal(fs.statSync(shot.file).mode & 0o777, 0o600);
  fs.writeFileSync(shot.file, "first");
  await assert.rejects(performNative(rt, capture), /EEXIST/, "a capture never overwrites one already there");
  assert.equal(fs.readFileSync(shot.file, "utf8"), "first");
});

test("--surface native --frame live captures what Live shows; the run's own capture says it is the pinned profile", async (t) => {
  // Pass-1 gate round 3: the run's capture op draws the pinned capture profile (the person's preset
  // ignored by design), so a gate that switched presets read the same picture at every preset.
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt } = nativeSurface(root);
  const pinned = (await performNative(
    rt,
    devOperation(["capture", "--profile", "p", "--surface", "native", "--name", "p1"]),
  )) as { file: string; frame: string };
  assert.equal(pinned.frame, NativeCaptureFrame.Pinned);
  const live = (await performNative(
    rt,
    devOperation(["capture", "--profile", "p", "--surface", "native", "--name", "l1", "--frame", "live"]),
  )) as { file: string; frame: string; dimensions: unknown };
  assert.equal(live.frame, NativeCaptureFrame.Live);
  assert.equal(live.file, path.join(root, "native-l1.png"));
  assert.deepEqual(live.dimensions, { width: 4, height: 3 });
  assert.equal(fs.readFileSync(live.file, "utf8"), "live-png");
  const hidden = nativeSurface(root, { live: null }).rt;
  await assert.rejects(
    performNative(
      hidden,
      devOperation(["capture", "--profile", "p", "--surface", "native", "--name", "l2", "--frame", "live"]),
    ),
    (error: unknown) => error instanceof DevError && error.code === DevErrorCode.MissingPrerequisite,
  );
  assert.throws(() => devOperation(["capture", "--profile", "p", "--surface", "native", "--frame", "drawn"]));
});

// Renderer pass 2, P2-0.9 step B (the 4K/1440p capture plan): `capture --size WxH` asks the run's
// pinned capture at that size. Live's view is the window's own size, so `--frame live` with a size
// is refused before anything is captured, as is a size outside whole pixels in 64..4096.
test("--surface native --size WxH asks the run's pinned capture at that size", async (t) => {
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt, asked } = nativeSurface(root);
  const args = ["capture", "--profile", "p", "--surface", "native", "--name", "k4", "--size", "3840x2160"];
  const operation = devOperation(args);
  assert.deepEqual(operation.method === DevMethod.Capture && operation.params.size, { width: 3840, height: 2160 });
  const shot = (await performNative(rt, operation)) as { file: string; frame: string; dimensions: unknown };
  assert.deepEqual(asked, ["pong", "capture at 3840x2160"]);
  assert.equal(shot.frame, NativeCaptureFrame.Pinned);
  assert.deepEqual(shot.dimensions, { width: 3840, height: 2160 });
  assert.equal(fs.readFileSync(shot.file, "utf8"), "sized-jpeg");
  const live = devOperation([...args.slice(0, 6), "l4", "--frame", "live", "--size", "3840x2160"]);
  await assert.rejects(
    performNative(rt, live),
    (error: unknown) => error instanceof DevError && error.code === DevErrorCode.InvalidRequest,
  );
  assert.ok(!fs.existsSync(path.join(root, "native-l4.png")), "nothing captured");
  for (const size of [
    "3840",
    "3840x",
    "x2160",
    "0x2160",
    "63x64",
    // Native captures reach 8K (the native cap is 8192 a side): one past it is refused.
    "8193x64",
    "2560.5x1440",
    "-2560x1440",
    "2560x1440x2",
    "big",
  ]) {
    assert.throws(() => devOperation([...args.slice(0, 8), size]), size);
  }
});

test("game.renderSettings reaches the open game's native run: a read, and a frame budget set for this session", async (t) => {
  // Pass-1 gate round 3: Live never showed dynamic resolution react on a fast Mac; a gate holds a
  // short frame budget through the verb and reads the scale step down.
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt, asked } = nativeSurface(root);
  const request = (params: unknown) => operationSchema.parse({ method: DevMethod.GameRenderSettings, params });
  const answer = await performNative(rt, request({ surface: "native", set: { frameBudgetMs: 4, preset: "ultra" } }));
  assert.deepEqual(answer, { preset: "high", frameBudgetMs: 4 });
  await performNative(rt, request({ surface: "native" }));
  assert.deepEqual(
    asked.filter((entry) => entry.startsWith(NativeOp.RenderSettings)),
    [`renderSettings ${JSON.stringify({ set: { preset: "ultra", frameBudgetMs: 4 } })}`, "renderSettings {}"],
  );
  for (const set of [{ frameBudgetMs: "4" }, { preset: "insane" }, { warp: true }, "low"])
    assert.throws(() => request({ surface: "native", set }), JSON.stringify(set));
});

// UIS-17: dev-control reaches a game's saves and its UI's session settings, classified native.
test("game.saves and game.uiSettings reach the open game's native run with what the game reads", async (t) => {
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt, asked } = nativeSurface(root);
  const json = (method: string, params: unknown) =>
    devOperation(["ui", "--profile", "p", "--json", JSON.stringify({ method, params })]);
  await performNative(rt, json("game.saves", { surface: "native", op: "list" }));
  await performNative(rt, json("game.saves", { surface: "native", op: "save", slot: "chapter-2", label: "Bridge" }));
  await performNative(rt, json("game.uiSettings", { surface: "native", locale: "xx-pseudo", scale: 1.5 }));
  await performNative(rt, json("game.uiSettings", { surface: "native" }));
  assert.deepEqual(
    asked.filter((entry) => entry.startsWith(NativeOp.Saves) || entry.startsWith(NativeOp.UiSettings)),
    [
      `saves ${JSON.stringify({ op: "list" })}`,
      `saves ${JSON.stringify({ op: "save", slot: "chapter-2", label: "Bridge" })}`,
      `uiSettings ${JSON.stringify({ locale: "xx-pseudo", scale: 1.5 })}`,
      "uiSettings {}",
    ],
  );
});

test("a hostile game.saves or game.uiSettings request is refused before any game is asked", () => {
  const request = (method: string, params: unknown) => operationSchema.safeParse({ method, params }).success;
  for (const params of [
    { op: "load", slot: "../world" },
    { op: "save", slot: "Slot" },
    { op: "write", slot: "s", envelope: { blob: "x".repeat(2 * 1024 * 1024) } },
    { op: "format" },
    { op: "load" },
    { op: "list", warp: true },
  ])
    assert.equal(request(DevMethod.GameSaves, params), false, JSON.stringify(params).slice(0, 60));
  for (const params of [{ scale: Number.NaN }, { scale: 9 }, { safeArea: [0, 0] }, { locale: "en US" }, { warp: 1 }])
    assert.equal(request(DevMethod.GameUiSettings, params), false, JSON.stringify(params));
  assert.equal(request(DevMethod.GameSaves, { op: "read", slot: "autosave-0" }), true);
  assert.equal(request(DevMethod.GameUiSettings, { locale: null, textSize: 1.25 }), true);
});

test("game.saves and game.uiSettings are native steps: a fixture profile refuses them, a live one runs them", async () => {
  const { DEV_NATIVE_STEPS, refuseFixtureStep } = await runtimeModule();
  const { classifyChannel, ChannelClass } = await import("../../src/main/dev/native-policy.ts");
  assert.deepEqual(Object.keys(DEV_NATIVE_STEPS).sort(), [DevMethod.GameSaves, DevMethod.GameUiSettings].sort());
  for (const [method, step] of Object.entries(DEV_NATIVE_STEPS)) {
    assert.equal(classifyChannel(step ?? ""), ChannelClass.Native, `${method} is classified native`);
    assert.throws(() => refuseFixtureStep(true, method as DevMethod), /^Error: unsupported-in-fixture/, method);
    assert.doesNotThrow(() => refuseFixtureStep(false, method as DevMethod), method);
  }
  for (const method of [DevMethod.GameState, DevMethod.GameRenderSettings, DevMethod.GameInput])
    assert.doesNotThrow(() => refuseFixtureStep(true, method), method);
});

test("--surface native logs page the run's console, redacted and within the log budget", async (t) => {
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt } = nativeSurface(root);
  const page = (await performNative(
    rt,
    devOperation(["logs", "--profile", "p", "--surface", "native", "--cursor", "1", "--limit", "2"]),
  )) as { surface: string; entries: Array<{ message: string }>; nextCursor: number; truncated: boolean };
  assert.equal(page.surface, "native");
  assert.deepEqual(
    page.entries.map((entry) => entry.message),
    ["line 1 [redacted]", "line 2 [redacted]"],
  );
  assert.equal(page.nextCursor, 3);
  assert.equal(page.truncated, true, "more lines follow");
  const flood = nativeSurface(root, { console: 200, size: 2000 }).rt;
  const big = (await performNative(
    flood,
    devOperation(["logs", "--profile", "p", "--surface", "native", "--limit", "200"]),
  )) as { entries: Array<{ omitted?: boolean }>; truncated: boolean };
  const sent = big.entries.filter((entry) => !entry.omitted);
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) <= 64 * 1024, "the answer stays within the log budget");
  assert.ok(
    big.entries.some((entry) => entry.omitted),
    "what did not fit is named, not sent",
  );
  assert.equal(big.truncated, true);
});

test("game.state and game.input reach the native run with --surface native, and the game view by default", async (t) => {
  const { asksNative, performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { rt, asked } = nativeSurface(root);
  const json = (method: string, params: Record<string, unknown>) =>
    devOperation(["ui", "--profile", "p", "--json", JSON.stringify({ method, params })]);
  const actions = [{ type: "tap", keys: ["KeyO"] }];
  const state = json("game.state", { surface: "native" });
  const input = json("game.input", { surface: "native", actions });
  assert.equal(asksNative(state), true);
  assert.equal(asksNative(input), true);
  assert.deepEqual(await performNative(rt, state), { tick: 7 });
  assert.deepEqual(await performNative(rt, input), { ok: true, applied: 0, width: 2, height: 2 });
  assert.deepEqual(asked, ["pong", "pong"], "the open game's run, each time");
  for (const operation of [
    json("game.state", {}),
    json("game.input", { actions }),
    json("game.state", { surface: "game" }),
  ])
    assert.equal(asksNative(operation), false, `${operation.method} defaults to the game view`);
  assert.throws(() => json("game.input", { surface: "desktop", actions }), "only the game view or the native run");
});

test("--surface native with no open game, or a game with no run, is a missing prerequisite", async (t) => {
  const { performNative } = await runtimeModule();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-native-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const capture = devOperation(["capture", "--profile", "p", "--surface", "native", "--name", "c2"]);
  for (const options of [{ project: null }, { port: false }]) {
    await assert.rejects(
      performNative(nativeSurface(root, options).rt, capture),
      (error: unknown) => error instanceof DevError && error.code === DevErrorCode.MissingPrerequisite,
      JSON.stringify(options),
    );
  }
  assert.deepEqual(fs.readdirSync(root), [], "nothing was written");
});

test("an input whose target is still opening is tried again until reachable; any other refusal is final", async (t) => {
  const { createServer } = await import("node:net");
  const { requestWhenReachable } = await import("../../scripts/studio-dev/client.ts");
  const { tmpDir } = await import("../helpers/tmp.ts");
  const refused = (code: string) => ({ ok: false, error: { code, message: code } });
  const reached = { ok: true, value: { dispatched: true } };
  let answers: object[] = [];
  let requests = 0;
  const dir = await tmpDir("ipc-reach-");
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, "s");
  const server = createServer((client) =>
    client.once("data", (line) => {
      const { requestId } = JSON.parse(line.toString());
      const answer = answers[Math.min(requests++, answers.length - 1)];
      client.end(`${JSON.stringify({ version: 1, requestId, ...answer })}\n`);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const descriptor = { instanceId: "00000000-0000-4000-8000-000000000001", capability: "0".repeat(64), socket };
  const click = { method: "click", params: { selector: '[data-chat-action="export"]' } } as const;
  const cases = [
    // A modal dialog or menu that has just opened takes pointer input one render later.
    { answers: [refused(DevErrorCode.TargetNotVisible), reached], timeoutMs: 5000, requests: 2 },
    {
      answers: [refused(DevErrorCode.AmbiguousSelector), reached],
      timeoutMs: 5000,
      requests: 1,
      refusal: DevErrorCode.AmbiguousSelector,
    },
    {
      answers: [refused(DevErrorCode.TargetNotVisible), reached],
      timeoutMs: 0,
      requests: 1,
      refusal: DevErrorCode.TargetNotVisible,
    },
  ];
  for (const [n, row] of cases.entries()) {
    answers = row.answers;
    requests = 0;
    const sent = requestWhenReachable(descriptor, click, row.timeoutMs);
    if (row.refusal) await assert.rejects(sent, (e: { code?: string }) => e.code === row.refusal, `case ${n}`);
    else assert.deepEqual(await sent, reached.value, `case ${n}`);
    assert.equal(requests, row.requests, `case ${n}`);
  }
});
test("source fingerprints re-read only files whose size or modification time changed", async (t) => {
  const { fingerprints } = await import("../../scripts/studio-dev/files.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dev-prints-")));
  t.after(() => {
    fs.chmodSync(path.join(root, "kept.ts"), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const kept = path.join(root, "kept.ts");
  const edited = path.join(root, "edited.ts");
  fs.writeFileSync(kept, "export const a = 1;\n");
  fs.writeFileSync(edited, "export const b = 1;\n");
  const before = fingerprints(root, ["kept.ts", "edited.ts"]);
  // An unchanged file is answered from what was read before: unreadable now, it still prints.
  fs.chmodSync(kept, 0);
  const sameSize = "export const b = 2;\n";
  fs.writeFileSync(edited, sameSize);
  const later = new Date(fs.statSync(edited).mtimeMs + 2000);
  fs.utimesSync(edited, later, later);
  const after = fingerprints(root, ["kept.ts", "edited.ts"]);
  assert.equal(after["kept.ts"], before["kept.ts"]);
  assert.notEqual(after["edited.ts"], before["edited.ts"]);
  fs.writeFileSync(edited, "export const b = 1;\n");
  assert.equal(fingerprints(root, ["edited.ts"])["edited.ts"], before["edited.ts"]);
});

// Pass 2 (TS-F2): `capture --surface native --frame live` cropped the window to the Native view's
// canvas in every phase and when the view was hidden, answering a Starting card or another stage
// view as the game's frame. The page script answers a box only for a playing, shown canvas, and
// nothing is captured otherwise.
test("a live native capture is taken only of a playing, shown Native view", async () => {
  const { liveNativeViewOf } = await runtimeModule();
  const { runInNewContext } = await import("node:vm");
  /** A studio window whose page holds a Native view in `phase`, its canvas `shown` or not. */
  const windowWith = (phase: string | null, shown: boolean) => {
    const captured: unknown[] = [];
    const canvas = {
      checkVisibility: () => shown,
      getBoundingClientRect: () => ({ x: 10.2, y: 20.6, width: 320, height: 180 }),
    };
    const marks = new Set<string>();
    const host = {
      getAttribute: (name: string) => (name === "data-stage-native-canvas" ? phase : null),
      setAttribute: (name: string) => marks.add(name),
      removeAttribute: (name: string) => marks.delete(name),
      querySelector: (selector: string) => (selector === "canvas" ? canvas : null),
    };
    const document = { querySelector: () => (phase === null ? null : host) };
    const requestAnimationFrame = (run: () => void) => setImmediate(run);
    const image = {
      isEmpty: () => false,
      toPNG: () => Buffer.from("png"),
      getSize: () => ({ width: 320, height: 180 }),
    };
    const win = {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (source: string) => runInNewContext(source, { document, requestAnimationFrame }),
        capturePage: async (rect: unknown) => {
          captured.push(rect);
          hiddenWhileCaptured.push(marks.has("data-stage-native-capturing"));
          return image;
        },
      },
    };
    const hiddenWhileCaptured: boolean[] = [];
    return { win: win as unknown as Parameters<typeof liveNativeViewOf>[0], captured, hiddenWhileCaptured, marks };
  };
  const playing = windowWith("playing", true);
  assert.deepEqual(await liveNativeViewOf(playing.win), {
    png: Buffer.from("png"),
    dimensions: { width: 320, height: 180 },
  });
  assert.deepEqual(playing.captured, [{ x: 10, y: 21, width: 320, height: 180 }]);
  // GA round 2: the capture held Studio's Click to play pill drawn over the game. Studio's overlays
  // are hidden while the window is captured, and shown again after.
  assert.deepEqual(playing.hiddenWhileCaptured, [true], "Studio's overlays are hidden for the capture");
  assert.deepEqual([...playing.marks], [], "and shown again after it");
  for (const [phase, shown] of [
    ["starting", true],
    ["refused", true],
    ["cant-draw", true],
    ["playing", false],
    [null, true],
  ] as const) {
    const { win, captured, marks } = windowWith(phase, shown);
    assert.equal(await liveNativeViewOf(win), null, `${phase} ${shown}`);
    assert.deepEqual(captured, [], `${phase} ${shown}: nothing was captured`);
    assert.deepEqual([...marks], [], `${phase} ${shown}: the overlays were left alone`);
  }
});
