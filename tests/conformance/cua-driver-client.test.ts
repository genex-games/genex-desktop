/**
 * cua-driver as the studio's desktop driver: each studio call becomes the driver's own MCP tool,
 * aimed at the whole display in the foreground (background canvas clicks are rerouted, cua #4350).
 * A fake connection records the calls; nothing touches this Mac. The command lines are checked as
 * a hostile table: a VM address can never become an ssh option or a shell word.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  awaitGrants,
  type CuaAnswer,
  type CuaConnection,
  connectCuaDriver,
  cuaDriver,
  driverEnv,
  findCuaDriver,
  GrantHolder,
  GrantStage,
  vmDriverCommand,
} from "../../src/substrate/cua-driver-client.ts";
import { macApps, parseAppInfo, parseHitPid } from "../../src/substrate/mac-apps.ts";
import type { ProbedApp, WindowsProbe } from "../../src/substrate/windows-window-probe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const json = (value: unknown): CuaAnswer => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** A connection answering the driver's tools from a table, recording every call. */
function fakeConnection(overrides: Record<string, CuaAnswer> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const answers: Record<string, CuaAnswer> = {
    // The shapes cua-driver 0.34 answers with (get_desktop_state.rs, list_apps.rs, list_windows.rs).
    get_desktop_state: {
      content: [{ type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" }],
      structuredContent: { screenshot_width: 1366, screenshot_height: 854, screen_width: 1512, screen_height: 945 },
    },
    list_apps: json({
      apps: [
        { name: "Notes", bundle_id: "com.apple.Notes", pid: 7, active: true },
        { name: "Finder", bundle_id: "com.apple.finder", pid: 3, active: false },
        { name: "Cua Driver", bundle_id: "com.trycua.driver", pid: 99, active: false },
      ],
    }),
    list_windows: json({
      windows: [
        // The largest z_index is the frontmost window; above all, the driver's own cursor overlay.
        { pid: 3, window_id: 30, z_index: 0, bounds: { x: 0, y: 0, width: 1512, height: 945 } },
        { pid: 7, window_id: 70, z_index: 1, bounds: { x: 0, y: 0, width: 756, height: 945 } },
        {
          pid: 99,
          window_id: 990,
          app_name: "Cua Driver",
          z_index: 15,
          bounds: { x: 0, y: 0, width: 1512, height: 967 },
        },
      ],
    }),
    get_window_state: { content: [{ type: "text", text: "- AXWindow Notes\n  - AXTextArea body" }] },
    ...overrides,
  };
  const connection: CuaConnection = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      return answers[tool] ?? json({ ok: true });
    },
    close: async () => {},
  };
  return { connection, calls, actions: () => calls.filter((c) => !READS.has(c.tool)) };
}

/** The driver's read-only tools, apart from the actions a test looks for. */
const READS = new Set(["get_desktop_state", "list_apps", "list_windows", "get_window_state"]);

describe("cua-driver as the desktop driver", () => {
  it("takes the whole display's picture, at the size the driver drew it", async () => {
    const fake = fakeConnection();
    const shot = await cuaDriver(fake.connection).screenshot();
    assert.deepEqual([shot.width, shot.height], [1366, 854]);
    assert.deepEqual(
      shot.screen,
      { width: 1366, height: 854 },
      "actions use the picture's pixels; the driver maps them",
    );
    assert.equal(shot.mime, "image/png");
    assert.deepEqual(fake.calls[0], { tool: "get_desktop_state", args: { max_image_dimension: 1366 } });
  });

  it("sends every action to the whole display, in the foreground, in the driver's words", async () => {
    const fake = fakeConnection();
    const driver = cuaDriver(fake.connection);
    await driver.click(10, 20, { button: "left", count: 2, modifiers: ["cmd"] });
    await driver.type("hello");
    await driver.press(["cmd", "shift", "s"]);
    await driver.press(["return"]);
    await driver.scroll(5, 6, 0, -4);
    await driver.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, "left");
    await driver.move(7, 8);
    const desktop = { target: { kind: "desktop", display_id: "primary" }, delivery_mode: "foreground" };
    assert.deepEqual(fake.actions(), [
      { tool: "click", args: { ...desktop, x: 10, y: 20, button: "left", count: 2, modifier: ["cmd"] } },
      { tool: "type_text", args: { ...desktop, text: "hello" } },
      { tool: "press_key", args: { ...desktop, key: "s", modifiers: ["cmd", "shift"] } },
      { tool: "press_key", args: { ...desktop, key: "return" } },
      { tool: "scroll", args: { ...desktop, x: 5, y: 6, direction: "up", amount: 4 } },
      { tool: "drag", args: { ...desktop, from_x: 1, from_y: 2, to_x: 3, to_y: 4, button: "left" } },
      // move_cursor refuses a delivery mode and a legacy scope beside a target (move_cursor.rs, action_target.rs).
      { tool: "move_cursor", args: { target: desktop.target, x: 7, y: 8 } },
    ]);
  });

  it("knows the app in front, the app under a point, and a password field in front", async () => {
    const fake = fakeConnection();
    const driver = cuaDriver(fake.connection);
    await driver.screenshot();
    assert.deepEqual((await driver.focus()).app, { name: "Notes", bundleId: "com.apple.Notes", pid: 7 });
    assert.equal((await driver.focus()).secure, false);
    // The driver's full-screen cursor overlay is never the app under a point (it would refuse every click).
    assert.equal((await driver.appAt?.(100, 100))?.name, "Notes", "the front window holds the left half");
    assert.equal((await driver.appAt?.(1200, 100))?.name, "Finder", "the right half is Finder's window behind it");
    // cua prints a field's role, never its secure subrole: a field labelled as a password counts as one.
    const login = fakeConnection({
      get_window_state: { content: [{ type: "text", text: '- AXWindow Sign in\n  - [3] AXTextField "Password"' }] },
    });
    assert.equal((await cuaDriver(login.connection).focus()).secure, true);
    const russian = fakeConnection({
      get_window_state: { content: [{ type: "text", text: '- AXWindow Вход\n  - [3] AXTextField "Пароль"' }] },
    });
    assert.equal((await cuaDriver(russian.connection).focus()).secure, true);
    // On this Mac, macOS's own secure input says so even when the tree does not.
    const guarded = cuaDriver(fakeConnection().connection, { secureInput: async () => true });
    assert.equal((await guarded.focus()).secure, true);
  });

  it("on this Mac, guards each move in milliseconds: no slow app listing, no tree read", async () => {
    const fake = fakeConnection();
    const mac = macApps(async (args) => {
      if (args[0] === "front") return "ASN:0x0-0x5c05c:\n";
      const who = args.at(-1);
      if (who === "pid:3") return '"CFBundleIdentifier"="com.apple.finder"\n"LSDisplayName"="Finder"\n"pid"=3\n';
      return '"CFBundleIdentifier"="com.apple.Notes"\n"LSDisplayName"="Notes"\n"pid"=7\n';
    });
    const driver = cuaDriver(fake.connection, { secureInput: async () => false, mac });
    await driver.screenshot();
    assert.deepEqual(await driver.focus(), {
      app: { name: "Notes", bundleId: "com.apple.Notes", pid: 7 },
      secure: false,
    });
    assert.equal((await driver.appAt?.(1200, 100))?.name, "Finder");
    const slow = fake.calls.filter((call) => call.tool === "list_apps" || call.tool === "get_window_state");
    assert.deepEqual(slow, [], "list_apps walks every installed app (seconds); the tree is not needed to type");
  });

  it("reads an lsappinfo answer, and nothing from an empty one", () => {
    assert.deepEqual(
      parseAppInfo('"CFBundleIdentifier"="com.anthropic.claudefordesktop"\n"LSDisplayName"="Claude"\n"pid"=4049\n'),
      { name: "Claude", bundleId: "com.anthropic.claudefordesktop", pid: 4049 },
    );
    assert.equal(parseAppInfo(""), null);
    assert.equal(parseAppInfo('"LSDisplayName"="x"\n"pid"=abc'), null);
  });

  it("on this Mac, a point above every window (the menu bar, an open menu) is the app macOS's hit test names", async () => {
    // Studio's window covers the screen below its menu bar; the menu bar is above every listed window.
    const fake = fakeConnection({
      list_windows: json({
        windows: [{ pid: 7, window_id: 70, z_index: 1, bounds: { x: 0, y: 40, width: 1512, height: 860 } }],
      }),
    });
    const info: Record<string, string> = {
      "pid:7": '"Roblox Studio" ASN:0x0-0x7: \n    bundleID="com.Roblox.RobloxStudio"\n    pid = 7 type="Foreground"\n',
      "pid:646":
        '"MenuBarAgent" ASN:0x0-0x646: \n    bundleID="com.apple.MenuBarAgent"\n    pid = 646 type="UIElement"\n',
    };
    const hits: Array<[number, number]> = [];
    const mac = macApps(
      async (args) => info[String(args.at(-1))] ?? "",
      async (x, y) => {
        hits.push([x, y]);
        if (y >= 30) return null;
        return x < 1000 ? 7 : 646;
      },
    );
    const driver = cuaDriver(fake.connection, { secureInput: async () => false, mac });
    await driver.screenshot();
    assert.equal((await driver.appAt?.(100, 400))?.bundleId, "com.Roblox.RobloxStudio");
    assert.deepEqual(hits, [], "a listed window answers without asking macOS");
    assert.equal((await driver.appAt?.(100, 10))?.bundleId, "com.Roblox.RobloxStudio", "the front app's menu");
    assert.equal(
      (await driver.appAt?.(1300, 10))?.bundleId,
      "com.apple.MenuBarAgent",
      "a status item is its own app's",
    );
    assert.equal(await driver.appAt?.(700, 850), null, "a point macOS names no app for is no app");
  });

  it("brings an app forward by activating the process of its frontmost window", async () => {
    const fake = fakeConnection({
      list_windows: json({
        windows: [
          { pid: 65113, window_id: 4, z_index: 2, app_name: "Roblox Studio" },
          { pid: 65113, window_id: 9, z_index: 5, app_name: "Roblox Studio" },
        ],
      }),
    });
    const driver = cuaDriver(fake.connection);
    await driver.bringToFront?.("com.Roblox.RobloxStudio");
    assert.deepEqual(
      fake.calls.map(({ tool, args }) => [tool, args]),
      [
        ["list_windows", { app: "com.Roblox.RobloxStudio" }],
        ["bring_to_front", { pid: 65113 }],
      ],
    );
    const none = fakeConnection({ list_windows: json({ windows: [] }) });
    await cuaDriver(none.connection).bringToFront?.("com.Roblox.RobloxStudio");
    assert.deepEqual(
      none.calls.map(({ tool }) => tool),
      ["list_windows"],
      "an app with no window is left alone",
    );
  });

  it("raises by the frontmost window only when the driver can't raise its process, which owns several", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fake = fakeConnection({
      list_windows: json({ windows: [{ pid: 92718, window_id: 4, z_index: 2, title: "a.rbxlx" }] }),
    });
    const connection = {
      ...fake.connection,
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool !== "bring_to_front") return fake.connection.call(tool, args);
        calls.push(args);
        if (args.window_id === undefined) throw new Error("pid 92718 owns more than one eligible top-level window");
        return json({ ok: true });
      },
    };
    await cuaDriver(connection).bringToFront?.("com.Roblox.RobloxStudio");
    assert.deepEqual(calls, [{ pid: 92718 }, { pid: 92718, window_id: 4 }]);
  });

  it("lists an app's windows front first with their titles, and raises the process of the one asked for", async () => {
    // A Mac runs one Roblox Studio process per open place, under one bundle id.
    const fake = fakeConnection({
      list_windows: json({
        windows: [
          { pid: 92718, window_id: 4, z_index: 2, app_name: "Roblox Studio", title: "spinning-colored-block.rbxlx" },
          { pid: 94330, window_id: 9, z_index: 5, app_name: "Roblox Studio", title: "Jump on Platforms" },
          { window_id: 11, z_index: 1, app_name: "Roblox Studio" },
        ],
      }),
    });
    const driver = cuaDriver(fake.connection);
    const windows = await driver.appWindows?.("com.Roblox.RobloxStudio");
    assert.deepEqual(windows, [
      { pid: 94330, windowId: 9, title: "Jump on Platforms" },
      { pid: 92718, windowId: 4, title: "spinning-colored-block.rbxlx" },
    ]);
    // Studio's process owns a second, untitled window too: the driver raises only a window it is named.
    await driver.bringToFront?.("com.Roblox.RobloxStudio", windows?.[1]);
    assert.deepEqual(fake.actions(), [{ tool: "bring_to_front", args: { pid: 92718, window_id: 4 } }]);
  });

  it("names a running Mac app under its own bundle id, asked in any case or by its name", async () => {
    const driver = cuaDriver(fakeConnection().connection);
    assert.deepEqual(await driver.runningApp?.("com.APPLE.notes"), {
      name: "Notes",
      bundleId: "com.apple.Notes",
      pid: 7,
    });
    assert.equal((await driver.runningApp?.("Finder"))?.bundleId, "com.apple.finder", "by the name it shows");
    assert.equal(await driver.runningApp?.("com.google.Chrome"), null, "an app that is not running is none");
    // cua 0.35 lists installed apps too, with pid 0 when they are not running.
    const installed = fakeConnection({
      list_apps: json({
        apps: [
          { name: "Roblox Studio", bundle_id: "com.Roblox.RobloxStudio", pid: 0, running: false },
          { name: "Safari", bundle_id: "com.apple.Safari", running: false },
        ],
      }),
    });
    const offline = cuaDriver(installed.connection);
    assert.equal(await offline.runningApp?.("com.roblox.robloxstudio"), null, "installed is not running");
    assert.equal(await offline.runningApp?.("Safari"), null, "nor is one with no pid at all");
  });

  it("reads the hit test's pid, and nothing from an empty or failed answer", () => {
    assert.equal(parseHitPid("96960\n"), 96960);
    for (const text of ["", "\n", "-25211", "0", "pid", "12.5"]) assert.equal(parseHitPid(text), null, text);
  });

  it("reads macOS 27's lsappinfo, which ignores -only and answers in its readable form", () => {
    const studio = [
      '"Roblox Studio" ASN:0x0-0x1f69f68: ',
      '    bundleID="com.Roblox.RobloxStudio"',
      '    bundle path="/Applications/RobloxStudio.app"',
      '    executable path="/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio"',
      '    pid = 65113 token=[sess=100019 pid=65113 uid:501,501,501 g:20,20 pV:16826812] type="Foreground" flavor=3 Version="7441077" fileType="APPL" creator="????" Arch=ARM64 ',
      "    checkin time = 2026/10/22 23:18:24 ( 2 hours, 19 minutes, 28.4345 seconds ago )",
      "",
    ].join("\n");
    assert.deepEqual(parseAppInfo(studio), { name: "Roblox Studio", bundleId: "com.Roblox.RobloxStudio", pid: 65113 });
    const front = [
      '"Claude" ASN:0x0-0x1be2be1: (in front) ',
      '    bundleID="com.anthropic.claudefordesktop"',
      "    bundle path=[ NULL ] ",
      "    executable path=[ NULL ] ",
      "    pid = 33106 !cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]  Version=[ NULL ]  Arch=!!none ",
      "",
    ].join("\n");
    assert.deepEqual(parseAppInfo(front), { name: "Claude", bundleId: "com.anthropic.claudefordesktop", pid: 33106 });
    const unbundled = '"helper" ASN:0x0-0x2: \n    bundleID=[ NULL ] \n    pid = 41 type="BackgroundOnly"\n';
    assert.deepEqual(parseAppInfo(unbundled), { name: "helper", bundleId: null, pid: 41 });
  });

  it("takes a refusal the driver answers without an error flag for what it is", async () => {
    const fake = fakeConnection({
      browser_prepare: json({ prepared_pid: 4242 }),
      get_browser_state: json({ target_id: "bt-1", tabs: [{ active: true, tab_id: "tab-1" }] }),
      browser_click: json({
        effect: "refused",
        error: { code: "browser_input_trust_unavailable", hint: "use delivery_mode foreground" },
      }),
    });
    const driver = cuaDriver(fake.connection);
    await assert.rejects(driver.web!.click("p1:0", "button"), /browser_input_trust_unavailable/);
  });

  it("takes a browser call the driver refuses by status for a refusal, carrying the driver's code", async () => {
    const fake = fakeConnection({
      browser_prepare: json({
        status: "refused",
        refusal: { code: "browser_requires_setup", message: "no owned DevTools endpoint" },
      }),
    });
    const driver = cuaDriver(fake.connection);
    const failure = await driver.web!.browser().then(
      () => null,
      (error: unknown) => error as Error & { code?: unknown },
    );
    assert.match(String(failure?.message), /browser_requires_setup: no owned DevTools endpoint/);
    assert.equal(failure?.code, "browser_requires_setup");
  });

  it("says why a call failed, with the driver's own words", async () => {
    const fake = fakeConnection({
      click: { isError: true, content: [{ type: "text", text: "background_unavailable" }] },
    });
    await assert.rejects(
      cuaDriver(fake.connection).click(1, 1, { button: "left", count: 1, modifiers: [] }),
      /cua-driver click failed: background_unavailable/,
    );
  });

  it("runs the driver bundled with the app, and an installed one only where none is bundled", async () => {
    const windows = process.platform === "win32";
    const executable = windows ? "cua-driver.exe" : "cua-driver";
    const home = await tmpDir("cua-home-");
    const bundled = path.join(await tmpDir("cua-resources-"), "cua-driver", executable);
    assert.equal(await findCuaDriver({ bundled, home }).then((found) => found?.startsWith(home) ?? false), false);
    const wrapper = windows
      ? path.join(home, "AppData", "Local", "Programs", "Cua", "cua-driver", "bin", executable)
      : path.join(home, ".local", "bin", executable);
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "#!/bin/sh\n");
    await chmod(wrapper, 0o755);
    assert.equal(await findCuaDriver({ bundled, home }), wrapper, "a development build: the installed one");
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, "#!/bin/sh\n");
    // Windows has no POSIX executable mode: chmod cannot make this file unrunnable there.
    if (!windows)
      assert.equal(await findCuaDriver({ bundled, home }), wrapper, "a bundled file that cannot run is not the driver");
    await chmod(bundled, 0o755);
    assert.equal(await findCuaDriver({ bundled, home }), bundled, "the app's own, ahead of an installed one");
  });

  it("reaches a VM's driver over ssh, with the address as one plain word", () => {
    assert.deepEqual(vmDriverCommand("lume@192.168.64.5"), {
      command: "ssh",
      args: ["-T", "-o", "BatchMode=yes", "--", "lume@192.168.64.5", "/Users/lume/.local/bin/cua-driver", "mcp"],
    });
    const hostile = [
      "-oProxyCommand=sh -c 'id'",
      "lume@host -oProxyCommand=x",
      "lume@host;rm -rf ~",
      "lume@$(whoami)",
      "@host",
      "lume@",
      "Lume@host",
      "lume@host\nx",
      "",
    ];
    for (const address of hostile) assert.equal(vmDriverCommand(address), null, address);
  });
});

describe("cua-driver on Windows", () => {
  /**
   * A connection answering as the Windows driver does (windows by executable, its overlay above all),
   * and a window probe answering as Windows does: which app is in front, which a point reaches.
   */
  function windowsDriver(probed: {
    front?: () => ProbedApp | null;
    at?: (x: number, y: number) => ProbedApp | null;
    process?: (pid: number) => ProbedApp | null;
    raise?: (exe: string) => ProbedApp | null;
    running?: (exe: string) => ProbedApp | null;
    tree?: CuaAnswer;
  }) {
    const windows = [
      { pid: 40, window_id: 400, app_name: "Notepad.exe", z_index: 1, bounds: { x: 0, y: 0, width: 756, height: 945 } },
      {
        pid: 99,
        window_id: 990,
        app_name: "cua-driver.exe",
        z_index: 15,
        bounds: { x: 0, y: 0, width: 1512, height: 945 },
      },
    ];
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const connection: CuaConnection = {
      call: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "get_desktop_state")
          return {
            content: [{ type: "image", data: PIXEL.toString("base64"), mimeType: "image/png" }],
            structuredContent: {
              screenshot_width: 1366,
              screenshot_height: 854,
              screen_width: 2732,
              screen_height: 1708,
            },
          };
        if (tool === "list_windows")
          return json({ windows: windows.filter((w) => args.pid === undefined || w.pid === args.pid) });
        if (tool === "get_window_state")
          return probed.tree ?? { content: [{ type: "text", text: '- [1] Window "Notepad"' }] };
        return json({ ok: true });
      },
      close: async () => {},
    };
    const asked: string[] = [];
    let closed = false;
    const probe: WindowsProbe = {
      front: async () => {
        asked.push("front");
        return probed.front?.() ?? null;
      },
      at: async (x, y, screen) => {
        asked.push(`at ${x} ${y} of ${screen.width}x${screen.height}`);
        return probed.at?.(x, y) ?? null;
      },
      process: async (pid) => probed.process?.(pid) ?? null,
      running: async (exe) => probed.running?.(exe) ?? null,
      raise: async (exe) => {
        asked.push(`raise ${exe}`);
        return probed.raise?.(exe) ?? null;
      },
      close: async () => {
        closed = true;
      },
    };
    return { driver: cuaDriver(connection, { windows: probe }), calls, asked, closed: () => closed };
  }
  const NOTEPAD: ProbedApp = { pid: 40, exe: "Notepad.exe", name: "Notepad", secure: false, window: 4001 };
  const PASSWORDS: ProbedApp = { pid: 41, exe: "1Password.exe", name: "1Password", secure: null, window: 4101 };

  it("asks Windows which app is in front and which app a click reaches, named by executable", async () => {
    const { driver, calls, asked } = windowsDriver({
      front: () => NOTEPAD,
      at: (x) => (x < 1366 ? { ...NOTEPAD, secure: null } : PASSWORDS),
    });
    await driver.screenshot();
    assert.deepEqual(await driver.focus(), {
      app: { name: "Notepad", bundleId: "notepad.exe", pid: 40 },
      secure: false,
    });
    assert.deepEqual(await driver.appAt?.(100, 100), { name: "Notepad", bundleId: "notepad.exe", pid: 40 });
    assert.deepEqual(await driver.appAt?.(1000, 100), { name: "1Password", bundleId: "1password.exe", pid: 41 });
    // Picture pixels become the screen's physical pixels, as the driver's own click maps them; the
    // probe scales those to its own points from the screen's size.
    assert.deepEqual(asked.slice(1), ["at 200 200 of 2732x1708", "at 2000 200 of 2732x1708"]);
    const slow = calls.filter((call) => call.tool === "list_apps" || call.tool === "get_window_state");
    assert.deepEqual(slow, [], "no installed-app scan and no tree read while UI Automation answers");
  });

  it("asks Windows again for every action: the app in front is never an earlier answer", async () => {
    let front: ProbedApp = NOTEPAD;
    const { driver } = windowsDriver({ front: () => front });
    assert.equal((await driver.focus()).app?.bundleId, "notepad.exe");
    // A key opened a credential prompt: the next action sees it at once.
    front = { pid: 52, exe: "CredentialUIBroker.exe", name: "Credential Dialog Xaml Host", secure: true, window: 5201 };
    assert.deepEqual(await driver.focus(), {
      app: { name: "Credential Dialog Xaml Host", bundleId: "credentialuibroker.exe", pid: 52 },
      secure: true,
    });
  });

  it("names an app Windows gives no description for by its executable, and no app where it reads none", async () => {
    const { driver } = windowsDriver({
      front: () => ({ pid: 7, exe: "Game.exe", name: "", secure: false, window: null }),
      at: () => null,
    });
    await driver.screenshot();
    assert.deepEqual((await driver.focus()).app, { name: "Game.exe", bundleId: "game.exe", pid: 7 });
    assert.equal(await driver.appAt?.(5, 5), null, "a point no readable app's window reaches is refused");
    assert.equal((await windowsDriver({}).driver.focus()).app, null, "an app in front Windows cannot read is no app");
  });

  it("reads a password field from the front window's tree, by its handle, only when UI Automation could not say", async () => {
    const unknown = { ...NOTEPAD, secure: null };
    const secure = async (tree: CuaAnswer, front: ProbedApp = unknown) =>
      (await windowsDriver({ front: () => front, tree }).driver.focus()).secure;
    const fake = windowsDriver({ front: () => unknown });
    await fake.driver.focus();
    assert.deepEqual(
      fake.calls.map((call) => [call.tool, call.args.window_id]),
      [["get_window_state", 4001]],
      "the window the probe named, without cua's slow window list",
    );
    const rows = (text: string): CuaAnswer => ({ content: [{ type: "text", text }] });
    assert.equal(await secure(rows('- [1] Window "Sign in"\n  - [3] Edit "Password"')), true);
    assert.equal(await secure(rows('- [1] Window "Вход"\n  - [3] Edit "Пароль" [id=passwordBox]')), true);
    assert.equal(await secure(rows('- [1] Window "Vault"\n  - [5] Button "Edit password"')), false, "a button");
    assert.equal(await secure(rows('- [1] Window "Notes"\n  - [3] Edit "Title"')), false);
    assert.equal(await secure(json({ elements: [{ element_index: 3, role: "Edit", label: "Password" }] })), true);
    assert.equal(
      await secure(rows('- [1] Window "Notes"'), { ...NOTEPAD, secure: true }),
      true,
      "UI Automation's own flag wins over a tree that shows none",
    );
  });

  it("never presses the Windows key, nor a key name cua would press as its first letter", async () => {
    const fake = windowsDriver({});
    for (const keys of [["cmd", "r"], ["win"], ["meta", "s"], ["ctrl", "volumeup"], ["numpad5"], ["printscreen"]])
      await assert.rejects(fake.driver.press(keys), /Windows key|not a key/, keys.join("+"));
    await assert.rejects(
      fake.driver.click(5, 5, { button: "left", count: 1, modifiers: ["cmd"] }),
      /Windows key/,
      "nor holds it under a click",
    );
    assert.deepEqual(
      fake.calls.filter((c) => c.tool === "press_key" || c.tool === "click"),
      [],
      "nothing reached the driver",
    );
    for (const keys of [["ctrl", "s"], ["alt", "f4"], ["shift", "tab"], ["escape"], ["a"], ["F5"]])
      await fake.driver.press(keys);
  });

  it("brings an app forward through Windows itself, by its executable, never through the driver", async () => {
    const studio: ProbedApp = {
      pid: 50,
      exe: "RobloxStudioBeta.exe",
      name: "Roblox Studio",
      secure: null,
      window: 5001,
    };
    const fake = windowsDriver({ raise: (exe) => (exe === "robloxstudiobeta.exe" ? studio : null) });
    assert.ok(fake.driver.bringToFront, "a PC's driver can bring an app forward");
    await fake.driver.bringToFront("robloxstudiobeta.exe");
    assert.deepEqual(fake.asked, ["raise robloxstudiobeta.exe"]);
    assert.deepEqual(fake.calls, [], "the driver's own list and bring_to_front are not used");
  });

  it("says which named app runs, by its executable: a name no process has is no app", async () => {
    const studio: ProbedApp = {
      pid: 50,
      exe: "RobloxStudioBeta.exe",
      name: "Roblox Studio",
      secure: null,
      window: null,
    };
    const fake = windowsDriver({ running: (exe) => (exe === "robloxstudiobeta.exe" ? studio : null) });
    assert.ok(fake.driver.runningApp, "a PC's driver checks a name against what runs");
    assert.deepEqual(await fake.driver.runningApp("RobloxStudioBeta.exe"), {
      name: "Roblox Studio",
      bundleId: "robloxstudiobeta.exe",
      pid: 50,
    });
    assert.equal(await fake.driver.runningApp("robloxstudio.exe"), null, "a guessed name runs nothing");
  });

  it("presses forward delete by Windows' name for it, leaves every other key as it is, and closes its probe", async () => {
    const fake = windowsDriver({});
    await fake.driver.press(["ctrl", "forward_delete"]);
    await fake.driver.click(5, 5, { button: "left", count: 1, modifiers: ["shift"] });
    const pressed = fake.calls.filter((c) => c.tool === "press_key" || c.tool === "click").map((c) => c.args);
    assert.deepEqual(pressed[0], {
      target: { kind: "desktop", display_id: "primary" },
      delivery_mode: "foreground",
      key: "delete",
      modifiers: ["ctrl"],
    });
    assert.deepEqual(pressed[1]?.modifier, ["shift"]);
    await fake.driver.close();
    assert.equal(fake.closed(), true, "the probe ends with the connection");
    // On a Mac, `delete` is Backspace: forward delete keeps its own name.
    const mac = fakeConnection();
    await cuaDriver(mac.connection).press(["forward_delete"]);
    assert.equal(mac.actions()[0]?.args.key, "forward_delete");
  });

  it("runs an installed driver from cua's Windows install folder where none is bundled", async () => {
    const home = await tmpDir("cua-home-");
    const bundled = path.join(await tmpDir("cua-resources-"), "cua-driver", "cua-driver.exe");
    assert.equal(await findCuaDriver({ bundled, home, platform: "win32" }), null);
    const installed = path.join(home, "AppData", "Local", "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
    await mkdir(path.dirname(installed), { recursive: true });
    await writeFile(installed, "MZ");
    await chmod(installed, 0o755);
    assert.equal(await findCuaDriver({ bundled, home, platform: "win32" }), installed);
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, "MZ");
    await chmod(bundled, 0o755);
    assert.equal(
      await findCuaDriver({ bundled, home, platform: "win32" }),
      bundled,
      "the app's own, ahead of an installed one",
    );
  });

  it("hands the driver Windows' own folders and the person's profile, and nothing of the studio's", () => {
    const env = {
      PATH: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local",
      USERPROFILE: "C:\\Users\\p",
      ANTHROPIC_API_KEY: "a key",
      GENEX_SECRET: "a secret",
    };
    assert.deepEqual(driverEnv(env, "win32"), {
      PATH: env.PATH,
      SystemRoot: env.SystemRoot,
      LOCALAPPDATA: env.LOCALAPPDATA,
      USERPROFILE: env.USERPROFILE,
    });
    assert.deepEqual(driverEnv({ PATH: "/usr/bin", HOME: "/Users/p", ANTHROPIC_API_KEY: "a key" }, "darwin"), {
      PATH: "/usr/bin",
      HOME: "/Users/p",
    });
  });
});

describe("cua-driver over a real MCP connection (a stand-in driver process)", () => {
  const FAKE = fileURLToPath(new URL("../fixtures/fake-cua-driver.mjs", import.meta.url));

  it("connects, checks its grants, and carries a screenshot and a click across stdio", async () => {
    const log = path.join(await tmpDir("cua-real-"), "calls.jsonl");
    const driver = await connectCuaDriver({ command: process.execPath, args: [FAKE, "--log", log] }, { local: false });
    try {
      const shot = await driver.screenshot();
      assert.deepEqual([shot.width, shot.height], [1366, 854]);
      assert.equal(shot.image.subarray(1, 4).toString(), "PNG");
      assert.deepEqual((await driver.focus()).app?.bundleId, "com.apple.Notes");
      await driver.click(12, 34, { button: "left", count: 1, modifiers: [] });
    } finally {
      await driver.close();
    }
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
    assert.equal(calls[0]?.name, "check_permissions", "the grants are checked before anything else");
    const click = calls.find((call) => call.name === "click");
    assert.deepEqual(click?.args, {
      target: { kind: "desktop", display_id: "primary" },
      delivery_mode: "foreground",
      x: 12,
      y: 34,
      button: "left",
      count: 1,
    });
  });

  it("asks for the grants without a driver prompt: the studio asks macOS itself, and a VM's daemon refuses one", async () => {
    const log = path.join(await tmpDir("cua-real-"), "calls.jsonl");
    const driver = await connectCuaDriver({ command: process.execPath, args: [FAKE, "--log", log] }, { local: false });
    await driver.close();
    const [first] = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(first, { name: "check_permissions", args: { prompt: false } });
  });

  it("restarts a daemon that started before the person granted access, once, then connects", async () => {
    const marker = path.join(await tmpDir("cua-pending-"), "restarted");
    let restarts = 0;
    const driver = await connectCuaDriver(
      { command: process.execPath, args: [FAKE, "--pending", marker] },
      {
        local: false,
        restart: async () => {
          restarts += 1;
          await writeFile(marker, "");
        },
      },
    );
    await driver.close();
    assert.equal(restarts, 1);
    // Without a way to restart it, a pending grant is said as missing, with how to fix it.
    await assert.rejects(
      connectCuaDriver({ command: process.execPath, args: [FAKE, "--pending", `${marker}-never`] }, { local: false }),
      /needs Accessibility and Screen Recording/,
    );
  });

  it("says the driver's own reason when it cannot start", async () => {
    await assert.rejects(
      connectCuaDriver({ command: process.execPath, args: [FAKE, "--fail-start"] }, { local: false }),
      /daemon did not appear/,
    );
  });

  it("on Windows, asks no grant (Windows has none to give) and starts the window probe first", async () => {
    const log = path.join(await tmpDir("cua-real-"), "calls.jsonl");
    const denied = { command: process.execPath, args: [FAKE, "--denied", "--log", log] };
    let probed = "not started";
    const probe = () => ({
      ready: async () => {
        probed = "ready";
      },
      front: async () => null,
      at: async () => null,
      process: async () => null,
      raise: async () => null,
      running: async () => null,
      close: async () => {
        probed = "closed";
      },
    });
    const driver = await connectCuaDriver(denied, { local: true, platform: "win32", probe });
    assert.equal(probed, "ready");
    try {
      assert.deepEqual([(await driver.screenshot()).width], [1366]);
    } finally {
      await driver.close();
    }
    assert.equal(probed, "closed", "the probe ends with the driver");
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { name: string }).name);
    assert.deepEqual(calls, ["get_desktop_state"], "no check_permissions: Windows' driver takes no prompt");
  });

  it("on Windows, refuses to start when the window probe cannot, and leaves no probe behind", async () => {
    let closed = false;
    const probe = () => ({
      ready: async () => {
        throw new Error("the Windows window probe did not start: PowerShell is blocked here");
      },
      front: async () => null,
      at: async () => null,
      process: async () => null,
      raise: async () => null,
      running: async () => null,
      close: async () => {
        closed = true;
      },
    });
    await assert.rejects(
      connectCuaDriver({ command: process.execPath, args: [FAKE] }, { local: true, platform: "win32", probe }),
      /PowerShell is blocked here/,
    );
    assert.equal(closed, true);
  });

  it("refuses to start without Accessibility or Screen Recording, and says whose grant to turn on", async () => {
    const denied = { command: process.execPath, args: [FAKE, "--denied"] };
    // A VM's standalone driver holds its own grants; this Mac's embedded driver uses Genex's.
    await assert.rejects(connectCuaDriver(denied, { local: false }), /cua-driver needs .*allow CuaDriver/);
    await assert.rejects(
      connectCuaDriver(denied, { local: false, holder: GrantHolder.Host }),
      /Genex needs Accessibility and Screen Recording .*turn Genex on/,
    );
    // A development build runs as Electron, and macOS lists its grants under that name.
    await assert.rejects(
      connectCuaDriver(denied, { local: false, holder: GrantHolder.Host, hostApp: "Electron" }),
      /Electron needs Accessibility and Screen Recording .*turn Electron on/,
    );
  });
});

describe("waiting for this Mac's grants before computer control starts", () => {
  /** A driver whose grants the test gives over time: each connection reads them as they are then. */
  function grantedLater(steps: Array<{ accessibility: boolean; screen: boolean; capture?: string }>) {
    const calls: Array<Record<string, unknown>> = [];
    let opened = 0;
    let restarts = 0;
    const open = async (): Promise<CuaConnection> => {
      const now = steps[Math.min(opened, steps.length - 1)]!;
      opened += 1;
      return {
        call: async (_tool, args) => {
          calls.push(args);
          if (args.prompt !== true) return json({ accessibility: now.accessibility, screen_recording: now.screen });
          return json({ direct_capture_status: now.capture ?? "ready" });
        },
        close: async () => {},
      };
    };
    return { open, calls, restart: async () => void (restarts += 1), restarts: () => restarts };
  }
  const clock = () => {
    let at = 0;
    return { now: () => at, sleep: async (ms: number) => void (at += ms) };
  };

  it("asks macOS for each missing grant once, then goes on by itself once the person gives it", async () => {
    const driver = grantedLater([
      { accessibility: false, screen: false },
      { accessibility: false, screen: false },
      { accessibility: true, screen: false },
      { accessibility: true, screen: true, capture: "timed_out" },
      { accessibility: true, screen: true, capture: "ready" },
    ]);
    const asked: GrantStage[] = [];
    const ready = await awaitGrants(driver.open, {
      ask: async (stage) => void asked.push(stage),
      restart: driver.restart,
      ...clock(),
    });
    assert.equal(ready, true);
    assert.deepEqual(asked, [GrantStage.Accessibility, GrantStage.ScreenRecording]);
    assert.equal(driver.restarts(), 3, "a fresh daemon reads each grant given since");
    assert.deepEqual(
      driver.calls.filter((args) => args.prompt === true),
      [
        { prompt: true, probe_direct_capture: true },
        { prompt: true, probe_direct_capture: true },
      ],
      "macOS's screen-capture consent is asked only once both grants hold, until it is given",
    );
  });

  it("starts at once where the grants are held, and asks nothing", async () => {
    const driver = grantedLater([{ accessibility: true, screen: true }]);
    const asked: GrantStage[] = [];
    const ready = await awaitGrants(driver.open, { ask: async (stage) => void asked.push(stage), ...clock() });
    assert.equal(ready, true);
    assert.deepEqual(asked, []);
    assert.equal(driver.restarts(), 0);
  });

  it("gives up when the person doesn't allow it in time, or the wait is stopped", async () => {
    const never = grantedLater([{ accessibility: false, screen: false }]);
    const time = clock();
    assert.equal(await awaitGrants(never.open, { ask: async () => {}, waitMs: 10_000, pollMs: 1_000, ...time }), false);
    assert.ok(time.now() >= 10_000 && time.now() < 12_000, "it waited its whole time, and no longer");
    const stop = new AbortController();
    stop.abort();
    const stopped = grantedLater([{ accessibility: false, screen: false }]);
    assert.equal(await awaitGrants(stopped.open, { ask: async () => {}, signal: stop.signal, ...clock() }), false);
  });
});
