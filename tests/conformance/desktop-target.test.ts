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
  async function guarded(under: DesktopApp, granted: ReadonlySet<string> | null, others = false) {
    const fake = fakeDriver({ under });
    const asked: string[] = [];
    const target = desktopTarget({
      driver: fake.driver,
      allowApp: async (app) => {
        asked.push(app.name);
        return true;
      },
      ownApp: (app) => app.bundleId === STUDIO.bundleId,
      engineApps: (app) => engineAppRefusal(app, { declared, granted, others }),
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

  it("leaves an app outside the grant to the person's card while an assist whose engine opens pages runs", async () => {
    const { done, calls, asked } = await guarded(EDITOR, new Set(["com.example.toy"]), true);
    assert.equal(done.applied, 1);
    assert.deepEqual(calls, ["click 5,5 left×1"]);
    assert.deepEqual(asked, ["TextEdit"], "the person is asked about it, as outside an assist");
    const strict = await guarded(EDITOR, new Set(["com.example.toy"]));
    assert.equal(strict.done.applied, 0, "an assist whose engine opens no pages refuses it");
    assert.match(strict.refused[0]?.message ?? "", /not one of the apps this setup step may use/);
  });

  it("refuses an engine's editor the assist was not granted, and an app it cannot name", async () => {
    const other: DesktopApp = { name: "Other Editor", bundleId: "com.example.other", pid: 12 };
    const rule = { declared: new Set([...declared, "com.example.other"]), granted: new Set(["com.example.toy"]) };
    assert.match(String(engineAppRefusal(other, rule)), /Other Editor is not one of the apps this setup step may use/);
    const unnamed: DesktopApp = { name: "Unknown", bundleId: null, pid: 13 };
    assert.match(String(engineAppRefusal(unnamed, rule)), /not one of the apps this setup step may use/);
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

/**
 * Bringing an app to the front by name: how the agent reaches the person's browser behind a
 * full-screen editor, since the taskbar is the shell and never driven. The app is held to a click's
 * rules: the apps the studio never drives and an engine's editor outside its assist are refused
 * before the person is asked, and an app they decline is never raised.
 */
describe("bringing an app to the front", () => {
  const EDGE: DesktopApp = { name: "Microsoft Edge", bundleId: "msedge.exe", pid: 51 };
  const ROBLOX_STUDIO = "robloxstudiobeta.exe";

  /** A driver whose raise puts a running app in front, and records it. */
  function raisingDriver(running: DesktopApp[]) {
    const fake = fakeDriver();
    let front: DesktopApp | null = EDITOR;
    fake.driver.focus = async () => ({ app: front, secure: false });
    fake.driver.bringToFront = async (id) => {
      fake.calls.push(`raise ${id}`);
      front = running.find((app) => app.bundleId === id) ?? front;
    };
    return fake;
  }

  /** A target over a raising driver, with the engine guard reading Roblox Studio as declared. */
  async function fronting(allowed: string[], granted: ReadonlySet<string> | null = null) {
    const fake = raisingDriver([EDGE]);
    const asked: string[] = [];
    const target = desktopTarget({
      driver: fake.driver,
      allowApp: async (app) => {
        asked.push(app.bundleId ?? app.name);
        return allowed.includes(app.bundleId ?? "");
      },
      ownApp: (app) => app.bundleId === STUDIO.bundleId,
      engineApps: (app) => engineAppRefusal(app, { declared: new Set([ROBLOX_STUDIO]), granted }),
      frontSettleMs: 0,
    });
    return { target, calls: fake.calls, asked };
  }

  it("brings an app the person allows in front of the others", async () => {
    const { target, calls, asked } = await fronting(["msedge.exe"]);
    assert.equal(await target.front?.("msedge.exe"), null);
    assert.deepEqual(calls, ["raise msedge.exe"]);
    assert.deepEqual(asked, ["msedge.exe"], "the person is asked about the app before it moves");
  });

  it("reads a Windows executable in any case, as Windows does", async () => {
    const { target, calls } = await fronting(["msedge.exe"]);
    assert.equal(await target.front?.("MSEdge.EXE"), null);
    assert.deepEqual(calls, ["raise msedge.exe"]);
  });

  it("says when the app did not come forward (it is not running), and opens nothing", async () => {
    const { target, calls } = await fronting(["chrome.exe"]);
    assert.match(String(await target.front?.("chrome.exe")), /chrome\.exe did not come to the front/);
    assert.deepEqual(calls, ["raise chrome.exe"]);
  });

  const refusedApps: Array<{ name: string; app: string; why: RegExp; asked?: string[] }> = [
    { name: "the shell (Explorer, the taskbar)", app: "explorer.exe", why: /never driven/ },
    { name: "the shell in capitals", app: "EXPLORER.EXE", why: /never driven/ },
    { name: "a password manager", app: "1password.exe", why: /never driven/ },
    { name: "the studio itself", app: STUDIO.bundleId ?? "", why: /never driven/ },
    { name: "system settings on a Mac", app: "com.apple.systempreferences", why: /never driven/ },
    { name: "an engine's editor outside its assist", app: ROBLOX_STUDIO, why: /game engine's editor/ },
    { name: "a path instead of an app", app: "C:\\Windows\\explorer.exe", why: /names no app/ },
    { name: "a relative path", app: "../../tools/evil.exe", why: /names no app/ },
    { name: "nothing at all", app: "  ", why: /names no app/ },
    { name: "an app the person declines", app: "msedge.exe", why: /did not allow/, asked: ["msedge.exe"] },
  ];
  for (const row of refusedApps) {
    it(`refuses ${row.name}, and nothing is raised`, async () => {
      const { target, calls, asked } = await fronting([]);
      assert.match(String(await target.front?.(row.app)), row.why);
      assert.deepEqual(calls, [], "the driver raised nothing");
      assert.deepEqual(asked, row.asked ?? [], "a refused app is never put to the person");
    });
  }

  describe("on a Mac, where bundle ids are read in any case", () => {
    const SAFARI: DesktopApp = { name: "Safari", bundleId: "com.apple.Safari", pid: 61 };
    const MAC_STUDIO: DesktopApp = { name: "Roblox Studio", bundleId: "com.Roblox.RobloxStudio", pid: 62 };
    const SETTINGS: DesktopApp = { name: "System Settings", bundleId: "com.apple.systempreferences", pid: 63 };
    const RUNNING = [SAFARI, MAC_STUDIO, SETTINGS];

    /** A Mac target: the driver names a running app by its own id, whatever case it was asked in. */
    function macFronting(allowed: string[], granted: ReadonlySet<string> | null = null) {
      const fake = raisingDriver(RUNNING);
      fake.driver.runningApp = async (name) =>
        RUNNING.find((app) => app.bundleId?.toLowerCase() === name.toLowerCase() || app.name === name) ?? null;
      const asked: string[] = [];
      const target = desktopTarget({
        driver: fake.driver,
        allowApp: async (app) => {
          asked.push(app.bundleId ?? app.name);
          return allowed.includes(app.bundleId ?? "");
        },
        ownApp: (app) => app.bundleId === STUDIO.bundleId,
        engineApps: (app) => engineAppRefusal(app, { declared: new Set([MAC_STUDIO.bundleId ?? ""]), granted }),
        frontSettleMs: 0,
      });
      return { target, calls: fake.calls, asked };
    }

    it("raises the running app under its own id, asked in another case", async () => {
      const studio = new Set([MAC_STUDIO.bundleId ?? ""]);
      const { target, calls } = macFronting([MAC_STUDIO.bundleId ?? ""], studio);
      assert.equal(await target.front?.("com.roblox.RobloxStudio"), null);
      assert.deepEqual(calls, ["raise com.Roblox.RobloxStudio"]);
    });

    it("asks the person about the app under its own id", async () => {
      const { target, asked } = macFronting(["com.apple.Safari"]);
      assert.equal(await target.front?.("com.apple.safari"), null);
      assert.deepEqual(asked, ["com.apple.Safari"]);
    });

    const macRefused: Array<{ name: string; app: string; why: RegExp }> = [
      { name: "system settings in another case", app: "com.apple.SystemPreferences", why: /never driven/ },
      {
        name: "an engine's editor in another case, outside its assist",
        app: "com.roblox.robloxstudio",
        why: /game engine's editor/,
      },
      { name: "an app that is not running", app: "com.google.Chrome", why: /is not running.*opens nothing/ },
    ];
    for (const row of macRefused) {
      it(`refuses ${row.name}, and nothing is raised`, async () => {
        const { target, calls, asked } = macFronting(["com.google.Chrome", "com.apple.systempreferences"]);
        assert.match(String(await target.front?.(row.app)), row.why);
        assert.deepEqual(calls, [], "the driver raised nothing");
        assert.deepEqual(asked, [], "a refused app is never put to the person");
      });
    }

    describe("picking one of an app's windows by its title", () => {
      const JUMP = { pid: 62, windowId: 620, title: "Jump on Platforms - Roblox Studio" };
      const BLOCK = { pid: 64, windowId: 640, title: "/Users/x/games/spinning-colored-block.rbxlx - Roblox Studio" };

      /** Two Studios, one per place as a Mac runs them, Jump on Platforms in front; a raise of a pid fronts it. */
      function twoStudios(raises = true, doubts = false) {
        const fake = raisingDriver(RUNNING);
        let front: DesktopApp = { ...MAC_STUDIO, pid: JUMP.pid };
        fake.driver.focus = async () => ({ app: front, secure: false });
        fake.driver.runningApp = async () => MAC_STUDIO;
        fake.driver.appWindows = async () => [JUMP, BLOCK];
        fake.driver.bringToFront = async (id, window) => {
          fake.calls.push(`raise ${id} ${window?.pid} ${window?.windowId}`);
          if (raises && window) front = { ...MAC_STUDIO, pid: window.pid };
          if (doubts) throw new Error("exact window was not verified as the frontmost process's focused window");
        };
        const target = desktopTarget({ driver: fake.driver, allowApp: async () => true, frontSettleMs: 0 });
        return { target, calls: fake.calls, fake };
      }

      it("raises the window whose title names the place, though another of the app's is in front", async () => {
        const { target, calls } = twoStudios();
        assert.equal(await target.front?.("com.Roblox.RobloxStudio", "Spinning-Colored-Block"), null);
        assert.deepEqual(calls, [`raise com.Roblox.RobloxStudio ${BLOCK.pid} ${BLOCK.windowId}`]);
      });

      it("names the app's windows when none has that title, and raises nothing", async () => {
        const { target, calls } = twoStudios();
        const why = String(await target.front?.("com.Roblox.RobloxStudio", "Sky Race"));
        assert.match(why, /Jump on Platforms - Roblox Studio/);
        assert.match(why, /spinning-colored-block\.rbxlx - Roblox Studio/);
        assert.deepEqual(calls, []);
      });

      it("goes by what is in front when the driver doubts a raise that worked", async () => {
        const { target, fake } = twoStudios(true, true);
        assert.equal(await target.front?.("com.Roblox.RobloxStudio", "spinning-colored-block"), null);
        assert.ok(fake.calls.length > 0);
      });

      it("says so when the app came forward on another of its windows", async () => {
        const { target } = twoStudios(false);
        assert.match(
          String(await target.front?.("com.Roblox.RobloxStudio", "spinning-colored-block")),
          /did not come to the front/,
        );
      });
    });

    it("never says Windows on a Mac when an app stays behind", async () => {
      const fake = raisingDriver([]);
      fake.driver.runningApp = async () => SAFARI;
      const target = desktopTarget({ driver: fake.driver, allowApp: async () => true, frontSettleMs: 0 });
      const why = String(await target.front?.("com.apple.Safari"));
      assert.match(why, /did not come to the front/);
      assert.doesNotMatch(why, /Windows/);
    });
  });

  it("brings an engine's editor forward inside an assist that was granted it", async () => {
    const { target, calls } = await fronting([ROBLOX_STUDIO], new Set([ROBLOX_STUDIO]));
    assert.match(String(await target.front?.(ROBLOX_STUDIO)), /did not come to the front/);
    assert.deepEqual(calls, [`raise ${ROBLOX_STUDIO}`], "the grant lets the raise through");
  });
});

describe("opening a page in the person's browser", () => {
  /** A target whose host opens what it is handed, and refuses what the test says. */
  function opening(refuse: (address: string) => string | null = () => null) {
    const fake = fakeDriver();
    const opened: string[] = [];
    const target = desktopTarget({
      driver: fake.driver,
      allowApp: async () => true,
      openPage: async (address) => {
        const why = refuse(address.href);
        if (!why) opened.push(address.href);
        return why;
      },
      frontSettleMs: 0,
    });
    return { target, opened, calls: fake.calls };
  }

  it("hands the host an https address to open, and clicks nothing itself", async () => {
    const { target, opened, calls } = opening();
    assert.equal(await target.openPage?.("https://create.example.com/dashboard/creations"), null);
    assert.deepEqual(opened, ["https://create.example.com/dashboard/creations"]);
    assert.deepEqual(calls, [], "no input reached the driver");
  });

  it("says why when the host refuses it", async () => {
    const { target, opened } = opening(() => "that page is not this task's");
    assert.equal(await target.openPage?.("https://elsewhere.example/"), "that page is not this task's");
    assert.deepEqual(opened, []);
  });

  const refusedAddresses: Array<[string, string]> = [
    ["plain http", "http://create.example.com/"],
    ["a file", "file:///etc/passwd"],
    ["a script", "javascript:alert(1)"],
    ["a custom scheme that opens an app", "roblox-studio:1+launchmode:edit"],
    ["credentials in the address", "https://user:pass@create.example.com/"],
    ["a port", "https://create.example.com:8443/"],
    ["an address that does not parse", "https://"],
    ["no address", "   "],
  ];
  for (const [name, address] of refusedAddresses) {
    it(`refuses ${name}, and nothing is opened`, async () => {
      const { target, opened } = opening();
      assert.match(String(await target.openPage?.(address)), /https:\/\//);
      assert.deepEqual(opened, []);
    });
  }
});
