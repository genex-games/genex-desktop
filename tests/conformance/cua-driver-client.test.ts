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
  type CuaAnswer,
  type CuaConnection,
  connectCuaDriver,
  cuaDriver,
  findCuaDriver,
  GrantHolder,
  vmDriverCommand,
} from "../../src/substrate/cua-driver-client.ts";
import { macApps, parseAppInfo } from "../../src/substrate/mac-apps.ts";
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
    const home = await tmpDir("cua-home-");
    const bundled = path.join(await tmpDir("cua-resources-"), "cua-driver", "cua-driver");
    assert.equal(await findCuaDriver({ bundled, home }).then((found) => found?.startsWith(home) ?? false), false);
    const wrapper = path.join(home, ".local", "bin", "cua-driver");
    await mkdir(path.dirname(wrapper), { recursive: true });
    await writeFile(wrapper, "#!/bin/sh\n");
    await chmod(wrapper, 0o755);
    assert.equal(await findCuaDriver({ bundled, home }), wrapper, "a development build: the installed one");
    await mkdir(path.dirname(bundled), { recursive: true });
    await writeFile(bundled, "#!/bin/sh\n");
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

  it("refuses to start without Accessibility or Screen Recording, and says whose grant to turn on", async () => {
    const denied = { command: process.execPath, args: [FAKE, "--denied"] };
    // A VM's standalone driver holds its own grants; this Mac's embedded driver uses Genex's.
    await assert.rejects(connectCuaDriver(denied, { local: false }), /cua-driver needs .*allow CuaDriver/);
    await assert.rejects(
      connectCuaDriver(denied, { local: false, holder: GrantHolder.Host }),
      /Genex needs Accessibility and Screen Recording .*turn Genex on/,
    );
  });
});
