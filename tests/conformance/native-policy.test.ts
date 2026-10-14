import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNativeActionAllowed,
  classifyChannel,
  FIXTURE_BLOCKED_CHANNELS,
  FIXTURE_SAFE_CHANNELS,
} from "../../src/main/dev/native-policy.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerEngineIpc } from "../../src/main/ipc/engine.ts";
import type { EngineEjectService } from "../../src/main/rust-eject.ts";
import type { EngineTrustService } from "../../src/main/rust-trust.ts";
import { ExtensionRefusal } from "../../src/shared/game-conformance.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";

// main/index.ts registers every channel through createIpcHandle, whose channel parameter is a key
// of the channel map (shared/ipc-channels.ts), every one of which the policy table classifies:
// `npm run typecheck` fails on an unknown channel. Handlers answer with their channel's result.
type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
function recorder() {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    ipc: {
      handle(channel: string, listener: Listener) {
        assert.ok(!listeners.has(channel), `${channel} registered twice`);
        listeners.set(channel, listener);
      },
    },
  };
}
const studio = { sender: "studio-webcontents", senderFrame: "studio-main-frame" };
const isStudioUi = (event: IpcSender) => event.sender === studio.sender && event.senderFrame === studio.senderFrame;

test("an unclassified channel does not typecheck as a registration", () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  handle("studio:threads", () => []);
  // @ts-expect-error classify it in src/main/dev/native-policy.ts first
  handle("studio:brand-new.native", () => 1);
  assert.deepEqual([...listeners.keys()], ["studio:threads", "studio:brand-new.native"]);
});
test("a fixture profile runs fixture-safe channels, refuses native and unclassified ones, and wraps results", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  const ran: string[] = [];
  handle("studio:send", (payload: { text: string }) => {
    ran.push(payload.text);
    return true;
  });
  handle("studio:open-url", () => {
    ran.push("opened");
    return true;
  });
  handle("studio:game.create", () => {
    throw new Error("title taken");
  });
  // @ts-expect-error an unclassified channel, registered anyway to prove the runtime refusal
  handle("studio:brand-new.native", () => {
    ran.push("new");
  });
  assert.deepEqual(await listeners.get("studio:send")!(studio, { text: "hi" }), { ok: true, value: true });
  assert.deepEqual(await listeners.get("studio:open-url")!(studio, {}), {
    ok: false,
    error: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
  });
  assert.deepEqual(await listeners.get("studio:game.create")!(studio, {}), { ok: false, error: "title taken" });
  assert.deepEqual(await listeners.get("studio:brand-new.native")!(studio, {}), {
    ok: false,
    error: "unsupported-in-fixture: studio:brand-new.native is not classified in src/main/dev/native-policy.ts",
  });
  assert.deepEqual(ran, ["hi"]);
});
test("a live profile runs native channels", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: false, isStudioUi });
  handle("studio:open-url", () => true);
  assert.deepEqual(await listeners.get("studio:open-url")!(studio, {}), { ok: true, value: true });
});
test("plugin, connector, terminal, job and Privacy settings channels answer only Studio's main frame", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: false, isStudioUi });
  let ran = 0;
  handle("studio:plugins.list", () => {
    ran++;
    return [];
  });
  handle("studio:mcp.list", () => {
    ran++;
    return [];
  });
  handle("studio:terminal.list", () => {
    ran++;
    return [];
  });
  handle("studio:games", () => {
    ran++;
    return [];
  });
  handle("studio:jobs.stop", () => {
    ran++;
    return null;
  });
  handle("studio:app-look.open-settings", () => {
    ran++;
    return true;
  });
  const subframe = { sender: studio.sender, senderFrame: "plugin-panel-frame" },
    other = { sender: "game-webcontents", senderFrame: "game-frame" };
  for (const channel of [
    "studio:plugins.list",
    "studio:mcp.list",
    "studio:terminal.list",
    "studio:jobs.stop",
    "studio:app-look.open-settings",
  ]) {
    for (const event of [subframe, other])
      assert.deepEqual(
        await listeners.get(channel)!(event, {}),
        { ok: false, error: "This action is restricted to Studio UI" },
        channel,
      );
    assert.equal((await listeners.get(channel)!(studio, {})).ok, true, channel);
  }
  assert.deepEqual(await listeners.get("studio:games")!(other, {}), { ok: true, value: [] });
  assert.equal(ran, 6);
});
test("a channel is never both fixture-safe and native", () => {
  assert.deepEqual(
    [...FIXTURE_SAFE_CHANNELS].filter((channel) => FIXTURE_BLOCKED_CHANNELS.has(channel)),
    [],
  );
});
test("native accounts, terminals, plugin installs, external opens and Genex are refused in fixtures only", () => {
  for (const channel of [
    "studio:terminal.open",
    "studio:plugins.install",
    "studio:plugins.install-github",
    "studio:plugins.lookup-github",
    "studio:plugins.github-versions",
    "studio:plugins.update",
    // A panel's Choose file opens Studio's native file picker.
    "studio:plugins.choose-file",
    "studio:plugins.approval",
    // A plugin action that starts, quits or opens an app or the browser, or writes outside its storage.
    "studio:plugins.native-action",
    "studio:plugins.host-cli",
    "studio:plugins.host-package",
    "studio:open-url",
    "studio:reveal-project",
    "studio:project.pick",
    // Create game's location is chosen in the native folder picker.
    "studio:game.location.pick",
    "studio:export",
    "studio:packages.install",
    "studio:mcp.trust",
    "studio:mcp.authorize",
    "studio:notify",
    "studio:game-file.reveal",
    // A file the chat names opens in another app or the file manager, outside the profile.
    "studio:chat-file.open",
    "studio:subscription.signin",
    "studio:claude-login.browser",
    "studio:codex-login.browser",
    "studio:genex.connect",
    "studio:genex.disconnect",
    "studio:genex.enable",
    "studio:genex.allowance",
    "studio:genex.approve",
    // Set up creates a Windows user account and network filters, behind an administrator prompt.
    "studio:boot.setup",
    // The toolchain install downloads CMake, Ninja, Emscripten and the rest.
    "studio:toolchain.install",
    // The Command Line Tools install opens Apple's installer dialog.
    "studio:toolchain.installClt",
    // Play on Mac opens the game in its own window on the desktop; Bring to front raises it.
    "studio:native.run",
    "studio:native.front",
    // Open Privacy settings opens macOS System Settings.
    "studio:app-look.open-settings",
  ]) {
    assert.equal(classifyChannel(channel), "native", channel);
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/, channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel), channel);
  }
});
test("fixture-safe channels run in fixtures and an unclassified one is refused there but not live", () => {
  for (const channel of [
    // The sandbox setup screen: its state, Retry, and the window controls' colours.
    "studio:boot",
    "studio:boot.retry",
    "studio:window.controls",
    "studio:bootstrap",
    "studio:send",
    "studio:terminal.list",
    "studio:plugins.index",
    "studio:mcp.save",
    "studio:project.adopt",
    "studio:game-file.read",
    // Asking which names are files only looks.
    "studio:chat-files.resolve",
    "studio:message-images",
    "studio:provider-usage",
    "studio:badge",
    // The toolchain store's state, cancelling the running install, and removing unreferenced versions.
    "studio:toolchain.status",
    "studio:toolchain.cancel",
    "studio:toolchain.prune",
    // A game window's state and stopping it: the profile's own runs, no window opened or raised.
    "studio:native.stop",
    "studio:native.state",
    // Embedded play opens no desktop window: a headless game drawing into Live's own canvas.
    "studio:native.embed",
    "studio:native.unembed",
    "studio:native.input",
    "studio:native.resize",
    // The person's Stop on a job this profile's own agent started.
    "studio:jobs.stop",
  ]) {
    assert.equal(classifyChannel(channel), "fixture-safe", channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(true, channel), channel);
  }
  assert.equal(classifyChannel("studio:brand-new.native"), "unclassified");
  assert.throws(
    () => assertNativeActionAllowed(true, "studio:brand-new.native"),
    /unsupported-in-fixture: studio:brand-new\.native is not classified/,
  );
  assert.doesNotThrow(() => assertNativeActionAllowed(false, "studio:brand-new.native"));
});
test("the Rust host channels: a device launch and a crate decision are the person's native acts; the re-take and the crate list run in fixtures (M3.0)", () => {
  // Launching on a Simulator, emulator or phone runs the game outside ProcessSandbox, so it is the
  // person's alone and never runs in a fixture; deciding a crate request lets new code into the
  // profile's vendored set. Re-taking a seed copy rewrites only the profile's own harness
  // workspace, and listing crate requests only reads.
  for (const channel of ["studio:native.launchDevice", "studio:crates.decide"]) {
    assert.equal(classifyChannel(channel), "native", channel);
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/, channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel), channel);
  }
  for (const channel of ["studio:seed.retake", "studio:crates.list"]) {
    assert.equal(classifyChannel(channel), "fixture-safe", channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(true, channel), channel);
  }
});
test("a fixture profile refuses a device launch before its handler runs", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  let launched = 0;
  handle("studio:native.launchDevice", () => {
    launched++;
    throw new Error("unreachable");
  });
  const answer = await listeners.get("studio:native.launchDevice")!(studio, {
    project: "pong",
    request: { target: "ios", device: "simulator" },
  });
  assert.deepEqual(answer, {
    ok: false,
    error: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
  });
  assert.equal(launched, 0);
});
test("the mobile setup and signing channels are the person's native acts (M5.0)", () => {
  // Installing the phones' tools downloads them; accepting the Android SDK licence is the person's
  // own agreement, never an agent's or a fixture's; picking a keystore or a provisioning profile
  // opens the native file dialog.
  for (const channel of [
    "studio:toolchain.installMobile",
    "studio:toolchain.acceptAndroidLicence",
    "studio:export.signingReference",
  ]) {
    assert.equal(classifyChannel(channel), "native", channel);
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/, channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel), channel);
  }
});
test("a fixture profile refuses the Android licence before its handler runs", async () => {
  const { ipc, listeners } = recorder();
  const handle = createIpcHandle(ipc, { fixture: true, isStudioUi });
  let accepted = 0;
  handle("studio:toolchain.acceptAndroidLicence", () => {
    accepted++;
    throw new Error("unreachable");
  });
  const answer = await listeners.get("studio:toolchain.acceptAndroidLicence")!(studio, {
    licence: "android-sdk-license",
  });
  assert.deepEqual(answer, {
    ok: false,
    error: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
  });
  assert.equal(accepted, 0);
});
test("the engine channels (eject, un-eject, trust) are the person's native acts, refused in fixtures and unreachable from the harness (M7.0)", async () => {
  const channels = ["studio:engine.eject", "studio:engine.uneject", "studio:engine.setTrust"] as const;
  for (const channel of channels) {
    assert.equal(classifyChannel(channel), "native", channel);
    assert.throws(() => assertNativeActionAllowed(true, channel), /unsupported-in-fixture/, channel);
    assert.doesNotThrow(() => assertNativeActionAllowed(false, channel), channel);
  }
  // No harness method names an engine action: an agent can only suggest one in chat.
  const methods: readonly string[] = Object.values(HostMethod);
  for (const method of methods) assert.doesNotMatch(method, /eject|trust/i, method);
  let reached = 0;
  const unreached = async () => assert.fail("no engine service runs in a fixture");
  const deps = {
    eject: (): EngineEjectService => {
      reached++;
      return { eject: unreached, uneject: unreached };
    },
    trust: (): EngineTrustService => {
      reached++;
      return { setTrust: unreached };
    },
    state: async (project: string) => ({ project, ejectedFrom: null, trusted: false }),
  };
  const fixture = recorder();
  registerEngineIpc(createIpcHandle(fixture.ipc, { fixture: true, isStudioUi }), deps);
  for (const channel of channels) {
    const answer = await fixture.listeners.get(channel)!(studio, { project: "pond", trusted: true });
    assert.deepEqual(answer, {
      ok: false,
      error: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
    });
  }
  assert.equal(reached, 0, "no engine service ran in a fixture");
  // The read of a game's engine and trust flag changes nothing: a fixture answers it (M7.3).
  assert.equal(classifyChannel("studio:engine.state"), "fixture-safe");
  assert.deepEqual(await fixture.listeners.get("studio:engine.state")!(studio, { project: "pond" }), {
    ok: true,
    value: { project: "pond", ejectedFrom: null, trusted: false },
  });
  assert.equal((await fixture.listeners.get("studio:engine.state")!(studio, { project: 7 })).ok, false);
});
test("a live profile's engine channels pass only a checked project and flag to the person's services", async () => {
  const live = recorder();
  const asked: string[] = [];
  const ejectService: EngineEjectService = {
    eject: async (project) => {
      asked.push(`eject ${project}`);
      return { project, ok: false, refusal: ExtensionRefusal.EjectNeedsMac, ejectedFrom: null };
    },
    uneject: async (project) => {
      asked.push(`uneject ${project}`);
      return { project, ok: true, refusal: null, ejectedFrom: null };
    },
  };
  const trustService: EngineTrustService = {
    setTrust: async (project, trusted) => {
      asked.push(`trust ${project} ${trusted}`);
      return { project, ok: true, refusal: null, trusted };
    },
  };
  registerEngineIpc(createIpcHandle(live.ipc, { fixture: false, isStudioUi }), {
    eject: () => ejectService,
    trust: () => trustService,
    state: async (project) => ({ project, ejectedFrom: null, trusted: false }),
  });
  const call = (channel: string, payload: unknown) => live.listeners.get(channel)!(studio, payload);
  assert.deepEqual(await call("studio:engine.eject", { project: "pond" }), {
    ok: true,
    value: { project: "pond", ok: false, refusal: ExtensionRefusal.EjectNeedsMac, ejectedFrom: null },
  });
  assert.deepEqual(await call("studio:engine.setTrust", { project: "pond", trusted: true }), {
    ok: true,
    value: { project: "pond", ok: true, refusal: null, trusted: true },
  });
  assert.deepEqual(asked, ["eject pond", "trust pond true"]);
  const hostile: Array<[string, unknown]> = [
    ["studio:engine.eject", {}],
    ["studio:engine.eject", { project: "" }],
    ["studio:engine.uneject", { project: 7 }],
    ["studio:engine.eject", { project: "x".repeat(201) }],
    ["studio:engine.setTrust", { project: "pond" }],
    ["studio:engine.setTrust", { project: "pond", trusted: "yes" }],
    ["studio:engine.setTrust", null],
  ];
  for (const [channel, payload] of hostile) {
    const answer = await call(channel, payload);
    assert.equal(answer.ok, false, `${channel} ${JSON.stringify(payload)}`);
  }
  assert.equal(asked.length, 2, "no hostile payload reached a service");
});
