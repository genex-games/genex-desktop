/**
 * What a user can attach to a bug report: the rotating `logs/studio.log` main writes, the
 * Settings → "Copy diagnostics" text, and the renderer's "Copy error" text. Each is redacted
 * before anyone reads it: no credential, no home folder, no email address.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openStudioLog, scrubForLog } from "../../src/main/logs.ts";
import { diagnosticsText, gatherDiagnostics, type DiagnosticsSources } from "../../src/main/diagnostics.ts";
import { registerSettingsIpc } from "../../src/main/ipc/settings.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { errorReport } from "../../src/renderer/error-report.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOME = "/Users/someone";
const KEY = "sk-ant-abcdefghijklmnop";
const at = () => new Date("2026-09-24T10:00:00.000Z");

describe("the studio log", () => {
  it("writes timestamped lines by source, with credentials, the home folder and emails removed", async () => {
    const dir = path.join(await tmpDir(), "logs");
    const log = openStudioLog(dir, { home: HOME, now: at });
    log.write("harness", `spawn failed in ${HOME}/AI Games/pong with Bearer ${KEY}`);
    log.write("main", "signed in as someone@example.com");
    log.close();
    const text = readFileSync(path.join(dir, "studio.log"), "utf8");
    assert.equal(
      text,
      "2026-09-24T10:00:00.000Z [harness] spawn failed in ~/AI Games/pong with Bearer [redacted]\n" +
        "2026-09-24T10:00:00.000Z [main] signed in as [email]\n",
    );
    // Windows reports no POSIX mode bits; the log sits in the user's own profile there.
    if (process.platform !== "win32")
      assert.equal(statSync(path.join(dir, "studio.log")).mode & 0o777, 0o600, "only the user can read it");
  });

  it("rotates by size and keeps a bounded number of files", async () => {
    const dir = path.join(await tmpDir(), "logs");
    const log = openStudioLog(dir, { home: HOME, now: at, maxBytes: 200, files: 3 });
    for (let i = 0; i < 40; i++) log.write("main", `line ${String(i).padStart(2, "0")} ${"x".repeat(20)}`);
    log.close();
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["studio.log", "studio.log.1", "studio.log.2"]);
    for (const file of files) assert.ok(statSync(path.join(dir, file)).size <= 200, `${file} stays under the limit`);
    assert.match(readFileSync(path.join(dir, "studio.log"), "utf8"), /line 39/);
  });

  it("carries on appending to the file an earlier launch left", async () => {
    const dir = path.join(await tmpDir(), "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "studio.log"), "earlier launch\n");
    const log = openStudioLog(dir, { home: HOME, now: at });
    log.write("main", "this launch");
    log.close();
    assert.match(readFileSync(path.join(dir, "studio.log"), "utf8"), /^earlier launch\n.*this launch\n$/);
  });

  it("tails the newest lines, reaching into the rotated file when the current one is short", async () => {
    const dir = path.join(await tmpDir(), "logs");
    const log = openStudioLog(dir, { home: HOME, now: at, maxBytes: 200, files: 3 });
    for (let i = 0; i < 12; i++) log.write("main", `line ${String(i).padStart(2, "0")} ${"x".repeat(20)}`);
    const tail = log.tail(6);
    assert.equal(tail.length, 6);
    assert.match(tail.at(-1)!, /line 11/);
    assert.match(tail[0]!, /line 06/);
    log.close();
  });

  it("never throws when the folder cannot be written", async () => {
    const root = await tmpDir();
    writeFileSync(path.join(root, "logs"), "a file where the folder should be");
    const log = openStudioLog(path.join(root, "logs"), { home: HOME, now: at });
    assert.doesNotThrow(() => log.write("main", "lost"));
    assert.deepEqual(log.tail(10), []);
    log.close();
  });

  it("scrubs a home folder only as a whole path segment", () => {
    assert.equal(scrubForLog(`${HOME}/a and ${HOME}else`, HOME), `~/a and ${HOME}else`);
  });
});

function sources(overrides: Partial<DiagnosticsSources> = {}): DiagnosticsSources {
  return {
    app: { name: "AI Game Studio", version: "0.9.0", packaged: true },
    versions: { electron: "43.4.1", chrome: "140.0", node: "24.18.0" },
    os: { platform: "darwin", arch: "arm64", release: "25.6.0" },
    paths: {
      userData: `${HOME}/Library/Application Support/AI Game Studio`,
      gamesRoot: `${HOME}/AI Games`,
      log: `${HOME}/Library/Application Support/AI Game Studio/logs/studio.log`,
    },
    home: HOME,
    engines: async () => [
      {
        id: "claude-code",
        label: "Claude Code",
        status: { code: "ready", detail: `Signed in as someone@example.com, key ${KEY}` },
        account: { source: "isolated", afterSignOut: "terminal", cli: { state: "ready", version: "2.1.0" } },
      },
      { id: "ollama", label: "Ollama", status: { code: "not_running", detail: "Start Ollama" } },
    ],
    logTail: () => [`2026-09-24T10:00:00.000Z [harness] failed in ${HOME}/AI Games/pong`],
    ...overrides,
  };
}

describe("Copy diagnostics", () => {
  it("names versions, platform, paths, each provider's status and the recent log", async () => {
    const text = diagnosticsText(await gatherDiagnostics(sources()));
    for (const expected of [
      "AI Game Studio 0.9.0 (packaged)",
      "Electron 43.4.1, Chrome 140.0, Node 24.18.0",
      "darwin 25.6.0 arm64",
      "Data: ~/Library/Application Support/AI Game Studio",
      "Games: ~/AI Games",
      "Claude Code: ready",
      "CLI ready 2.1.0",
      "login isolated",
      "Ollama: not_running (Start Ollama)",
      "[harness] failed in ~/AI Games/pong",
    ])
      assert.ok(text.includes(expected), `missing ${JSON.stringify(expected)} in\n${text}`);
  });

  it("names the harness calls the host is still servicing, oldest first (B4)", async () => {
    const text = diagnosticsText(
      await gatherDiagnostics(
        sources({
          harnessCalls: [
            { method: "preview.state", ageMs: 125_000 },
            { method: "engine.delegate", ageMs: 4_000 },
          ],
        }),
      ),
    );
    assert.match(text, /Harness calls in flight\n {2}preview\.state for 125 s\n {2}engine\.delegate for 4 s/);
    const idle = diagnosticsText(await gatherDiagnostics(sources({ harnessCalls: [] })));
    assert.match(idle, /Harness calls in flight\n {2}none/);
  });

  it("holds no credential, home folder or email address", async () => {
    const text = diagnosticsText(await gatherDiagnostics(sources()));
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes(HOME));
    assert.ok(!text.includes("someone@example.com"));
  });

  it("still answers when the provider check fails or hangs", async () => {
    const failed = diagnosticsText(
      await gatherDiagnostics(
        sources({
          engines: async () => {
            throw new Error("boom");
          },
        }),
      ),
    );
    assert.match(failed, /Providers\n {2}unavailable/);
    const hung = diagnosticsText(
      await gatherDiagnostics(sources({ engines: () => new Promise(() => {}) }), { timeoutMs: 5 }),
    );
    assert.match(hung, /Providers\n {2}unavailable/);
  });

  it("is what the studio:diagnostics channel answers", async () => {
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const handle = createIpcHandle(
      {
        handle: (channel, listener) => {
          listeners.set(channel, listener);
        },
      },
      { fixture: true, isStudioUi: () => true },
    );
    const settings = {
      learning: true,
      selfImproving: false,
      architect: false,
      buildersMax: 3,
      agentsMax: 5,
      blender: true,
      autoResume: true,
    };
    const sent: unknown[] = [];
    registerSettingsIpc(handle, {
      core: { settings, updateSettings: async () => settings },
      diagnostics: async () => "the report",
      feedback: async (payload) => {
        sent.push(payload);
      },
      licenses: async () => ({ license: "MIT License", bundled: null, notices: "# Notices" }),
    });
    const result = await listeners.get("studio:diagnostics")!({ sender: "studio", senderFrame: "main" }, undefined);
    assert.deepEqual(result, { ok: true, value: "the report" }, "fixture-safe, and answers the text");
    const feedback = await listeners.get("studio:feedback.send")!(
      { sender: "studio", senderFrame: "main" },
      { text: "Crash", screen: "home", appLogs: false, chatId: null },
    );
    assert.equal(feedback.ok, false, "a fixture profile never posts feedback");
    assert.deepEqual(sent, []);
    const licenses = await listeners.get("studio:licenses")!({ sender: "studio", senderFrame: "main" }, undefined);
    assert.deepEqual(
      licenses,
      { ok: true, value: { license: "MIT License", bundled: null, notices: "# Notices" } },
      "Settings → Licenses is fixture-safe and answers the shipped texts",
    );
  });
});

describe("the renderer's Copy error", () => {
  it("carries the message, the stack and the component stack, with credentials removed", () => {
    const error = new Error(`bad payload with api_key=${KEY}`);
    const text = errorReport(error, "\n    at ChatPanel\n    at App");
    assert.match(text, /^Error: bad payload with api_key=\[redacted\]/);
    assert.match(text, /Components:\n {4}at ChatPanel\n {4}at App/);
    assert.ok(!text.includes(KEY));
  });

  it("describes a thrown non-Error value", () => {
    assert.equal(errorReport("just a string", null), "just a string");
  });
});
