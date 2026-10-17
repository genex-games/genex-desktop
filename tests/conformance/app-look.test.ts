/**
 * Looking at an app window: the windows on screen, a window picked by id, title or app (never by a
 * pattern built from what an agent typed), one screenshot and one accessibility-tree read with the
 * window passed only as arguments, the tree's caps, which macOS access is missing and when Genex
 * asks, the password managers it never looks at, and other systems. Nothing here captures the screen
 * or reads accessibility: every command goes to a recording runner that answers canned output.
 */
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { AppLookAccessKind } from "../../src/shared/jobs.ts";
import { AX_TREE_SCRIPT, WINDOW_LIST_SCRIPT } from "../../src/substrate/app-look-scripts.ts";
import {
  APP_LOOK_MAX_DEPTH,
  APP_LOOK_MAX_NODES,
  APP_LOOK_TEXT_MAX_CHARS,
  APP_LOOK_TREE_MAX_CHARS,
  type AppLookAccessStatus,
  AppLookProblemCode,
  type AppLookRun,
  type AppWindow,
  AccessStep,
  accessStep,
  isAppLookProblem,
  macAppLook,
  parseAxTree,
  parseWindowList,
  pickWindow,
  refusedApp,
  ScreenAccessState,
  stubAppLook,
  unsupportedAppLook,
} from "../../src/substrate/app-look.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The bytes the fake screencapture writes: any bytes do, the port reads what is there. */
const PICTURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

/** One window as the window-list script prints it. */
const listed = (over: Record<string, unknown>) => ({
  id: 42,
  app: "Godot",
  bundleId: "org.godotengine.godot",
  pid: 4242,
  title: "Garden - Godot Engine",
  bounds: { x: 10, y: 20, width: 800, height: 600 },
  layer: 0,
  onScreen: true,
  ...over,
});

const WINDOWS = [
  listed({}),
  listed({ id: 43, title: "Garden (DEBUG)", bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
  listed({ id: 7, app: "Finder", bundleId: "com.apple.finder", pid: 300, title: "Downloads" }),
  listed({ id: 8, app: "Menu Bar", layer: 25, title: "Clock" }),
  { id: "not a number", app: 5 },
];

/** A node as the tree script prints it. */
const node = (d: number, role: string, title = "", value = "", description = "") => ({
  d,
  role,
  title,
  value,
  description,
});

/** A runner that records every command and answers what a Mac would, from canned output. */
function recordingRun(options: { list?: unknown; tree?: unknown; fail?: Record<string, string> } = {}) {
  const calls: Array<[string, string[]]> = [];
  const run: AppLookRun = async (file, args) => {
    calls.push([file, [...args]]);
    const failure = options.fail?.[path.basename(file)];
    if (failure) return { code: 1, stdout: "", stderr: failure };
    if (file.endsWith("screencapture")) await writeFile(args.at(-1) ?? "", PICTURE);
    if (file.endsWith("osascript") && args[3] === WINDOW_LIST_SCRIPT)
      return { code: 0, stdout: JSON.stringify(options.list ?? WINDOWS), stderr: "" };
    if (file.endsWith("osascript"))
      return {
        code: 0,
        stdout: JSON.stringify(options.tree ?? { nodes: [node(0, "AXWindow", "Garden")] }),
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

const GRANTED: AppLookAccessStatus = { screen: ScreenAccessState.Granted, accessibility: true };

it("lists the windows on screen and picks one by id, title or app, never by a pattern built from input", () => {
  const windows = parseWindowList(JSON.stringify(WINDOWS));
  assert.deepEqual(
    windows.map((window) => window.id),
    [42, 43, 7],
    "app windows only: the menu bar's layer and a malformed entry are left out",
  );
  assert.deepEqual(parseWindowList("not json"), []);
  assert.deepEqual(parseWindowList(JSON.stringify({ windows: [] })), []);
  const table: Array<[string, { app?: string; window?: string | number }, number | null]> = [
    ["an id from the list", { window: 42 }, 42],
    ["an id as a model sends it", { window: "43" }, 43],
    ["a title's words", { window: "debug" }, 43],
    ["the app by name: its largest window", { app: "godot" }, 43],
    ["the app by bundle id", { app: "COM.APPLE.FINDER" }, 7],
    ["an app and a title", { app: "Godot", window: "Engine" }, 42],
    ["an id of another app", { app: "Finder", window: 42 }, null],
    ["a pattern", { window: ".*" }, null],
    ["a broken pattern", { window: "[" }, null],
    ["a parenthesis, as plain text", { window: "(debug" }, 43],
    ["an app as a pattern", { app: "G.*" }, null],
    ["nothing asked", { window: "" }, null],
    ["an id not on screen", { window: 99 }, null],
  ];
  for (const [label, asked, id] of table) assert.equal(pickWindow(windows, asked)?.id ?? null, id, label);
});

it("looks with one screenshot and one tree read, passing the window only as arguments", async () => {
  const scratch = await tmpDir("app-look-scratch-");
  const hostile = ['"; do shell script "rm -rf ~" --', "it's", "two\nlines", "-e", "Garden - Godot Engine"];
  for (const title of hostile) {
    const { run, calls } = recordingRun({ list: [listed({ title })] });
    const port = macAppLook({ run, scratchDir: scratch, access: () => GRANTED });
    const windows = await port.windows();
    assert.ok(!isAppLookProblem(windows), "listed");
    const window = windows[0] as AppWindow;
    const result = await port.look(window);
    assert.ok(!isAppLookProblem(result), JSON.stringify(result));
    const tmp = calls[1]?.[1].at(-1) ?? "";
    assert.ok(tmp.startsWith(scratch), "the picture is made in Genex's scratch folder");
    assert.deepEqual(calls, [
      ["/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_LIST_SCRIPT]],
      ["/usr/sbin/screencapture", ["-x", "-o", "-t", "jpg", "-l", "42", tmp]],
      ["/usr/bin/sips", ["-Z", "1568", tmp]],
      ["/usr/bin/osascript", ["-l", "JavaScript", "-e", AX_TREE_SCRIPT, "4242", title, "10", "20", "800", "600"]],
    ]);
    assert.deepEqual(result.image, { mimeType: "image/jpeg", data: PICTURE.toString("base64") });
    assert.match(result.tree, /AXWindow "Garden"/);
    assert.deepEqual(await readdir(scratch), [], "the picture is gone after");
  }
});

it("caps the tree and clips each line", () => {
  const long = "x".repeat(500);
  const nodes = Array.from({ length: 2000 }, (_, i) => node(i % 15, "AXButton", `${i}${long}`, long, long));
  const { tree, truncated } = parseAxTree(JSON.stringify({ nodes }));
  const lines = tree.split("\n");
  assert.equal(truncated, true);
  assert.ok(lines.length <= APP_LOOK_MAX_NODES, `${lines.length} lines`);
  assert.ok(tree.length <= APP_LOOK_TREE_MAX_CHARS, `${tree.length} chars`);
  for (const line of lines) {
    const depth = (line.length - line.trimStart().length) / 2;
    assert.ok(depth <= APP_LOOK_MAX_DEPTH, `depth ${depth}`);
    for (const quoted of line.match(/"[^"]*"/g) ?? []) assert.ok(quoted.length <= APP_LOOK_TEXT_MAX_CHARS + 2);
  }
  assert.deepEqual(parseAxTree("not json"), { tree: "", truncated: false });
  const small = parseAxTree(
    JSON.stringify({ nodes: [node(0, "AXWindow", "Garden"), node(1, "AXButton", "Play", "", "")] }),
  );
  assert.deepEqual(small, { tree: 'AXWindow "Garden"\n  AXButton "Play"', truncated: false });
  const valued = parseAxTree(JSON.stringify({ nodes: [node(0, "AXTextField", "Name", "Ada\nLovelace")] }));
  assert.equal(valued.tree, 'AXTextField "Name" = Ada Lovelace', "a value on its own line stays one line");
});

it("says which access is missing and asks macOS only once", async () => {
  const table: Array<[AppLookAccessStatus, boolean, string, string[]]> = [
    [{ screen: ScreenAccessState.Granted, accessibility: true }, false, AccessStep.Look, []],
    [{ screen: ScreenAccessState.Granted, accessibility: true }, true, AccessStep.Look, []],
    [{ screen: ScreenAccessState.NotDetermined, accessibility: false }, false, AccessStep.Ask, []],
    [
      { screen: ScreenAccessState.NotDetermined, accessibility: false },
      true,
      AccessStep.Missing,
      [AppLookAccessKind.Screen, AppLookAccessKind.Accessibility],
    ],
    [{ screen: ScreenAccessState.Denied, accessibility: true }, false, AccessStep.Ask, []],
    [{ screen: ScreenAccessState.Denied, accessibility: true }, true, AccessStep.Missing, [AppLookAccessKind.Screen]],
    [
      { screen: ScreenAccessState.Granted, accessibility: false },
      true,
      AccessStep.Missing,
      [AppLookAccessKind.Accessibility],
    ],
  ];
  for (const [status, asked, step, missing] of table)
    assert.deepEqual(accessStep(status, asked), { step, missing }, `${JSON.stringify(status)} asked ${asked}`);

  const scratch = await tmpDir("app-look-denied-");
  const window = parseWindowList(JSON.stringify([listed({})]))[0] as AppWindow;
  const noPicture = recordingRun({ fail: { screencapture: "could not create image from window" } });
  const denied = macAppLook({
    run: noPicture.run,
    scratchDir: scratch,
    access: () => ({ screen: ScreenAccessState.Denied, accessibility: true }),
  });
  assert.deepEqual(await denied.look(window), { problem: AppLookProblemCode.NoScreenAccess });
  for (const code of ["-1719", "-25211"]) {
    const noTree = recordingRun({ fail: { osascript: `execution error: Error: An error occurred. (${code})` } });
    const port = macAppLook({ run: noTree.run, scratchDir: scratch, access: () => GRANTED });
    assert.deepEqual(await port.look(window), { problem: AppLookProblemCode.NoAxAccess }, code);
  }
  assert.deepEqual(await readdir(scratch), [], "nothing left behind");
});

it("refuses to look at a password manager", () => {
  const managers: Array<Partial<AppWindow>> = [
    { app: "Keychain Access", bundleId: "com.apple.keychainaccess" },
    { app: "Passwords", bundleId: "com.apple.Passwords" },
    { app: "1Password", bundleId: "com.1password.1password" },
    { app: "Bitwarden" },
    { app: "Something", bundleId: "com.lastpass.LastPass" },
    { app: "dashlane" },
  ];
  for (const app of managers) assert.equal(refusedApp({ ...listed({}), ...app } as AppWindow), true, app.app);
  assert.equal(refusedApp(parseWindowList(JSON.stringify([listed({})]))[0] as AppWindow), false, "a game");
});

it("answers macOS only on other systems", async () => {
  const port = unsupportedAppLook();
  assert.deepEqual(await port.windows(), { problem: AppLookProblemCode.Unsupported });
  assert.deepEqual(await port.look(listed({}) as unknown as AppWindow), { problem: AppLookProblemCode.Unsupported });
  const stub = stubAppLook();
  const windows = await stub.windows();
  assert.ok(!isAppLookProblem(windows));
  assert.deepEqual(
    windows.map((window) => [window.id, window.app, window.title]),
    [[1, "Fixture App", "Fixture Window"]],
    "a fixture profile sees one window, and nothing on the Mac",
  );
});
