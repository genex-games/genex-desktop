/**
 * The desktop as a computer target: a fake driver records every call, so what the studio lets an
 * agent do on the person's computer is tested without touching it. Input lands only in an app the
 * person allowed; the studio itself, password managers and system settings are never driven;
 * nothing is typed into a password field; and the model's pixels are scaled to the screen's points.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InputRoute, TargetRuntime } from "../../src/shared/computer-target.ts";
import { desktopTarget, driverKey, engineAppRefusal } from "../../src/main/core/desktop-target.ts";
import type { DesktopApp, DesktopDriver, DesktopFocus } from "../../src/substrate/desktop-driver.ts";
import type { PreviewInputAction } from "../../src/substrate/preview-input.ts";

const EDITOR: DesktopApp = { name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 11 };
const STUDIO: DesktopApp = { name: "Genex", bundleId: "ai.genex.studio", pid: 22 };

/** A driver that records each call; a 2880×1800 picture of a 1440×900-point screen. */
function fakeDriver(options: { focus?: DesktopFocus; under?: DesktopApp | null } = {}) {
  const calls: string[] = [];
  const driver: DesktopDriver = {
    screenshot: async () => ({
      image: Buffer.from("png"),
      mime: "image/png",
      width: 2880,
      height: 1800,
      screen: { width: 1440, height: 900 },
    }),
    focus: async () => options.focus ?? { app: EDITOR, secure: false },
    ...(options.under !== undefined ? { appAt: async () => options.under ?? null } : {}),
    move: async (x, y) => {
      calls.push(`move ${x},${y}`);
    },
    click: async (x, y, o) => {
      calls.push(`click ${x},${y} ${o.button}×${o.count}${o.modifiers.length ? ` +${o.modifiers.join("+")}` : ""}`);
    },
    mouse: async (x, y, o) => {
      calls.push(`mouse ${o.down ? "down" : "up"} ${x},${y}`);
    },
    drag: async (from, to) => {
      calls.push(`drag ${from.x},${from.y}→${to.x},${to.y}`);
    },
    scroll: async (x, y, dx, dy) => {
      calls.push(`scroll ${x},${y} ${dx},${dy}`);
    },
    type: async (text) => {
      calls.push(`type ${text}`);
    },
    press: async (keys) => {
      calls.push(`press ${keys.join("+")}`);
    },
    accessibility: async () => ({ role: "AXWindow", title: "Untitled" }),
    close: async () => {},
  };
  return { driver, calls };
}

/** A target over the fake driver, the person allowing exactly `allowed`, the studio's own app known. */
async function targetOver(fake: ReturnType<typeof fakeDriver>, allowed: string[] = ["com.apple.TextEdit"]) {
  const asked: string[] = [];
  const target = desktopTarget({
    driver: fake.driver,
    allowApp: async (app) => {
      asked.push(app.name);
      return allowed.includes(app.bundleId ?? "");
    },
    ownApp: (app) => app.bundleId === STUDIO.bundleId,
  });
  await target.screenshot({ quality: 80, surface: "auto" as never });
  return { target, asked };
}

describe("desktop target", () => {
  it("is a desktop: absolute pointer, no clock, the accessibility tree, input by OS events", async () => {
    const fake = fakeDriver();
    const { target } = await targetOver(fake);
    assert.equal(target.caps.runtime, TargetRuntime.Desktop);
    assert.deepEqual(target.viewSize(), { width: 2880, height: 1800 });
    const done = await target.input([{ type: "click", x: 200, y: 100, px: true }]);
    assert.deepEqual(done, { applied: 1, route: InputRoute.OsForeground });
    assert.deepEqual(fake.calls, ["click 100,50 left×1"], "screenshot pixels are scaled to the screen's points");
    assert.deepEqual(await target.state?.(), { app: "TextEdit", tree: { role: "AXWindow", title: "Untitled" } });
  });

  it("carries out keys, chords, text, drags and scrolls in the driver's words", async () => {
    const fake = fakeDriver();
    const { target } = await targetOver(fake);
    await target.input([
      { type: "press", combo: "cmd+s" },
      { type: "type", text: "hello" },
      { type: "drag", fromX: 20, fromY: 20, x: 200, y: 200, px: true },
      { type: "scroll", x: 400, y: 400, dy: 3 },
      { type: "click", x: 10, y: 10, px: true, clicks: 2, modifiers: ["shift"] },
    ]);
    assert.deepEqual(fake.calls, [
      "press cmd+s",
      "type hello",
      "drag 10,10→100,100",
      "scroll 200,200 0,3",
      "click 5,5 left×2 +shift",
    ]);
    assert.equal(driverKey("KeyA"), "a");
    assert.equal(driverKey("Enter"), "return");
    assert.equal(driverKey("MetaLeft"), "cmd");
    // cua's "delete" is Backspace; forward delete and punctuation have their own names (keyboard.rs).
    assert.equal(driverKey("Delete"), "forward_delete");
    assert.equal(driverKey("BracketLeft"), "[");
    assert.equal(driverKey("ShiftRight"), "shift");
  });

  const hostile: Array<{
    name: string;
    focus?: DesktopFocus;
    under?: DesktopApp | null;
    actions: PreviewInputAction[];
    why: RegExp;
  }> = [
    {
      name: "a click on the studio's own window (an agent answering its own consent card)",
      under: STUDIO,
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "keys while the studio is in front",
      focus: { app: STUDIO, secure: false },
      actions: [{ type: "press", combo: "Return" }],
      why: /never driven/,
    },
    {
      name: "typing into a password manager",
      focus: { app: { name: "1Password", bundleId: "com.1password.1password", pid: 3 }, secure: false },
      actions: [{ type: "type", text: "x" }],
      why: /never driven/,
    },
    {
      name: "a click in System Settings",
      under: { name: "System Settings", bundleId: "com.apple.systempreferences", pid: 4 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "typing into a password manager on Windows",
      focus: { app: { name: "1Password", bundleId: "1password.exe", pid: 6 }, secure: false },
      actions: [{ type: "type", text: "x" }],
      why: /never driven/,
    },
    {
      // Settings and Windows Security are packaged apps: a frame of ApplicationFrameHost.exe.
      name: "a click in a Windows packaged app's frame, which may hold Settings",
      under: { name: "ApplicationFrameHost.exe", bundleId: "applicationframehost.exe", pid: 7 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      // Explorer is the desktop, the taskbar, Run and File Explorer's address bar: it starts programs.
      name: "a click in Windows Explorer, the shell",
      under: { name: "Windows Explorer", bundleId: "explorer.exe", pid: 9 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "a click that reaches the driver's own cursor overlay",
      under: { name: "Cua Driver", bundleId: "cua-driver.exe", pid: 10 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /never driven/,
    },
    {
      name: "keys into a Windows credential prompt",
      focus: { app: { name: "Windows Security", bundleId: "credentialuibroker.exe", pid: 8 }, secure: false },
      actions: [{ type: "press", combo: "Return" }],
      why: /never driven/,
    },
    {
      name: "a password typed into a secure field of an allowed app",
      focus: { app: EDITOR, secure: true },
      actions: [{ type: "type", text: "hunter2" }],
      why: /password field/,
    },
    {
      name: "a key pressed into a secure field",
      focus: { app: EDITOR, secure: true },
      actions: [{ type: "press", combo: "Return" }],
      why: /password field/,
    },
    {
      name: "a click in an app the person did not allow",
      under: { name: "Mail", bundleId: "com.apple.mail", pid: 5 },
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /did not allow Mail/,
    },
    {
      name: "a click where no app can be found",
      focus: { app: null, secure: false },
      under: null,
      actions: [{ type: "click", x: 10, y: 10, px: true }],
      why: /no app/,
    },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name}, and nothing reaches the screen`, async () => {
      const fake = fakeDriver({
        ...(row.focus ? { focus: row.focus } : {}),
        ...(row.under !== undefined ? { under: row.under } : {}),
      });
      const { target } = await targetOver(fake);
      const done = await target.input([...row.actions, { type: "click", x: 1, y: 1, px: true }]);
      assert.equal(done.applied, 0);
      assert.deepEqual(fake.calls, [], "no input reached the driver, and the plan stopped at the refusal");
      const refused = target.refusals?.() ?? [];
      assert.equal(refused.length, 1);
      assert.match(refused[0]!.message, row.why);
      assert.deepEqual(target.refusals?.(), [], "reading the refusals clears them");
    });
  }

  it("asks the person about each app the agent reaches, and a later refusal stops the rest of the plan", async () => {
    const fake = fakeDriver({ under: EDITOR });
    const { target, asked } = await targetOver(fake);
    const done = await target.input([
      { type: "click", x: 10, y: 10, px: true },
      { type: "type", text: "ok" },
    ]);
    assert.equal(done.applied, 2);
    assert.deepEqual(asked, ["TextEdit", "TextEdit"], "the host's allow-list answers; the target asks every time");
  });

  it("a click asks only which app is under it; keys ask which app is in front and whether its field is secret", async () => {
    const fake = fakeDriver({ under: EDITOR });
    let focused = 0;
    const counting = { ...fake.driver, focus: async () => (focused++, fake.driver.focus()) };
    const target = desktopTarget({ driver: counting, allowApp: async () => true });
    await target.screenshot({ quality: 80, surface: "auto" as never });
    await target.input([{ type: "click", x: 10, y: 10, px: true }]);
    assert.equal(focused, 0, "a click never waits on the keyboard's checks");
    await target.input([{ type: "type", text: "x" }]);
    assert.equal(focused, 1);
  });

  it("refuses a click over a point no window covers, never the app in front in its place", async () => {
    const fake = fakeDriver({ focus: { app: EDITOR, secure: false }, under: null });
    const { target, asked } = await targetOver(fake);
    const done = await target.input([{ type: "click", x: 10, y: 10, px: true }]);
    assert.equal(done.applied, 0);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(asked, [], "the front app is never put to the person for a point outside it");
    assert.match(target.refusals?.()[0]?.message ?? "", /no app's window is under that point/);
  });

  it("never reads the accessibility tree of an app the studio never drives", async () => {
    const fake = fakeDriver({ focus: { app: STUDIO, secure: false } });
    const { target } = await targetOver(fake);
    const state = (await target.state?.()) as Record<string, unknown>;
    assert.equal("tree" in state, false);
  });
});

/**
 * A drag lands in two apps: the one it starts in and the one it is dropped on. Both ends pass the
 * same checks a click does, and a refused end moves nothing at all.
 */
describe("a drag's drop point", () => {
  const MAIL: DesktopApp = { name: "Mail", bundleId: "com.apple.mail", pid: 5 };
  const SETTINGS: DesktopApp = { name: "System Settings", bundleId: "com.apple.systempreferences", pid: 4 };
  const MANAGER: DesktopApp = { name: "1Password", bundleId: "com.1password.1password", pid: 3 };
  const TOY_EDITOR: DesktopApp = { name: "Toy Editor", bundleId: "com.example.toy", pid: 31 };

  /** A screen whose left half (in points) is TextEdit and right half is `right`. */
  async function split(right: DesktopApp | null) {
    const fake = fakeDriver();
    const driver: DesktopDriver = { ...fake.driver, appAt: async (x) => (x < 720 ? EDITOR : right) };
    const asked: string[] = [];
    const target = desktopTarget({
      driver,
      allowApp: async (app) => {
        asked.push(app.name);
        return app.bundleId === EDITOR.bundleId;
      },
      ownApp: (app) => app.bundleId === STUDIO.bundleId,
      engineApps: (app) => engineAppRefusal(app, { declared: new Set(["com.example.toy"]), granted: null }),
    });
    await target.screenshot({ quality: 80, surface: "auto" as never });
    return { target, calls: fake.calls, asked };
  }

  const drop: PreviewInputAction = { type: "drag", fromX: 100, fromY: 100, x: 2000, y: 100, px: true };
  const rows: Array<[string, DesktopApp | null, RegExp]> = [
    ["an app the person did not allow", MAIL, /did not allow Mail/],
    ["System Settings", SETTINGS, /never driven/],
    ["a password manager", MANAGER, /never driven/],
    ["the studio itself", STUDIO, /never driven/],
    ["an engine's editor outside its assist", TOY_EDITOR, /game engine's editor/],
    ["a point no window covers", null, /no app's window is under that point/],
  ];
  for (const [label, right, why] of rows) {
    it(`refuses a drag from an allowed app onto ${label}, and nothing moves`, async () => {
      const { target, calls } = await split(right);
      const done = await target.input([drop]);
      assert.equal(done.applied, 0);
      assert.deepEqual(calls, [], "neither the press nor the drop reached the driver");
      assert.match(target.refusals?.()[0]?.message ?? "", why);
    });
  }

  it("refuses a drag that starts in a refused app, whatever it is dropped on", async () => {
    const { target, calls } = await split(SETTINGS);
    const done = await target.input([{ type: "drag", fromX: 2000, fromY: 100, x: 100, y: 100, px: true }]);
    assert.equal(done.applied, 0);
    assert.deepEqual(calls, []);
  });

  it("carries out a drag whose both ends are in an allowed app, asking about each end", async () => {
    const { target, calls, asked } = await split(EDITOR);
    const done = await target.input([drop]);
    assert.equal(done.applied, 1);
    assert.deepEqual(calls, ["drag 50,50→1000,50"]);
    assert.deepEqual(asked, ["TextEdit", "TextEdit"]);
  });
});

/**
 * The engine-app guard: computer use never builds or play-tests in an engine's editor. The apps an
 * enabled engine plugin declares (`engine.apps`) are refused outside that plugin's setup assist; in
 * an assist, only the apps it was granted are driven, and the apps the studio never drives stay
 * refused whatever the grant names.
 */
describe("the engine-app guard", () => {
  const TOY_EDITOR: DesktopApp = { name: "Toy Editor", bundleId: "com.example.toy", pid: 31 };
  const declared = new Set(["com.example.toy"]);

  /** A target whose guard reads the declared apps and the chat's live assist grant (null: none). */
  async function guarded(under: DesktopApp, granted: ReadonlySet<string> | null) {
    const fake = fakeDriver({ under });
    const asked: string[] = [];
    const target = desktopTarget({
      driver: fake.driver,
      allowApp: async (app) => {
        asked.push(app.name);
        return true;
      },
      ownApp: (app) => app.bundleId === STUDIO.bundleId,
      engineApps: (app) => engineAppRefusal(app, { declared, granted }),
    });
    await target.screenshot({ quality: 80, surface: "auto" as never });
    const done = await target.input([{ type: "click", x: 10, y: 10, px: true }]);
    return { done, calls: fake.calls, asked, refused: target.refusals?.() ?? [] };
  }

  it("refuses an engine's editor outside a setup assist, before the person is asked about it", async () => {
    const { done, calls, asked, refused } = await guarded(TOY_EDITOR, null);
    assert.equal(done.applied, 0);
    assert.deepEqual(calls, []);
    assert.deepEqual(asked, [], "a refused app is never put to the person");
    assert.match(refused[0]!.message, /Toy Editor is a game engine's editor/);
    assert.match(refused[0]!.message, /use the engine's own tools/);
  });

  it("drives an engine's editor inside an assist that was granted it", async () => {
    const { done, calls, asked } = await guarded(TOY_EDITOR, new Set(["com.example.toy"]));
    assert.equal(done.applied, 1);
    assert.deepEqual(calls, ["click 5,5 left×1"]);
    assert.deepEqual(asked, ["Toy Editor"], "the person's per-app card still asks");
  });

  it("refuses every app outside the grant while an assist runs", async () => {
    const { done, calls, refused } = await guarded(EDITOR, new Set(["com.example.toy"]));
    assert.equal(done.applied, 0);
    assert.deepEqual(calls, []);
    assert.match(refused[0]!.message, /TextEdit is not one of the apps this setup step may use/);
  });

  it("still never drives the studio or system settings, even when a grant names them", async () => {
    for (const app of [STUDIO, { name: "System Settings", bundleId: "com.apple.systempreferences", pid: 4 }]) {
      const { done, calls, refused } = await guarded(app, new Set([app.bundleId!, "com.example.toy"]));
      assert.equal(done.applied, 0, app.name);
      assert.deepEqual(calls, []);
      assert.match(refused[0]!.message, /never driven/);
    }
  });

  it("never drives the app an engine's games are played in, with or without an assist that names it", () => {
    const player: DesktopApp = { name: "Roblox", bundleId: "com.roblox.RobloxPlayer", pid: 41 };
    const players = new Set(["com.roblox.RobloxPlayer"]);
    for (const granted of [null, new Set(["com.roblox.RobloxPlayer", "com.example.toy"])]) {
      const refusal = engineAppRefusal(player, { declared, granted, players });
      assert.match(String(refusal), /Roblox is where an engine's games are played/, String(granted));
      assert.match(String(refusal), /never plays/);
    }
    assert.equal(engineAppRefusal(EDITOR, { declared, granted: null, players }), null);
  });

  it("leaves apps no engine declares alone outside an assist", async () => {
    assert.equal(engineAppRefusal(EDITOR, { declared, granted: null }), null);
    assert.equal(engineAppRefusal({ name: "Nameless", bundleId: null, pid: 1 }, { declared, granted: null }), null);
    assert.match(
      String(engineAppRefusal({ name: "Nameless", bundleId: null, pid: 1 }, { declared, granted: declared })),
      /not one of the apps/,
      "an app with no bundle id is never inside a grant",
    );
  });
});
