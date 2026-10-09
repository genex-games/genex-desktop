/**
 * The sandbox setup boot state in main: the window asks where startup stands, and Retry re-runs
 * core startup. Driven through the real typed `handle()` with the gate's attempt and the window's
 * title-bar controls as recorders.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBootGate } from "../../src/main/boot-gate.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerBootIpc } from "../../src/main/ipc/boot.ts";
import {
  BootPhase,
  SandboxProblemCode,
  SandboxSetupOutcome,
  SandboxTool,
  StudioPlatform,
  linuxInstallCommands,
  type SandboxProblem,
} from "../../src/shared/boot.ts";
import type { WindowControlColors } from "../../src/shared/studio-api.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";

const PROBLEM: SandboxProblem = {
  code: SandboxProblemCode.MissingTools,
  platform: "linux",
  missingTools: [SandboxTool.Bubblewrap],
  installCommands: linuxInstallCommands([SandboxTool.Bubblewrap]),
  details: ["bubblewrap (bwrap) not installed"],
};

/** Windows before the one-time setup: the sandbox user and its network filter are missing. */
const NOT_PROVISIONED: SandboxProblem = {
  code: SandboxProblemCode.NotProvisioned,
  platform: StudioPlatform.Windows,
  missingTools: [],
  installCommands: [],
  details: ["sandbox user not provisioned"],
};

/** A Windows gate held on the setup screen, with its installs and startup attempts counted. */
function windowsGate(install: () => Promise<{ cancelled: boolean }>) {
  const counts = { installs: 0, attempts: 0 };
  const gate = createBootGate(StudioPlatform.Windows, {
    installSandbox: () => {
      counts.installs++;
      return install();
    },
  });
  gate.hold(NOT_PROVISIONED, async () => {
    counts.attempts++;
  });
  return { gate, counts };
}

/** A pending attempt the test settles by hand. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("boot gate", () => {
  it("starts ready, on the platform it was given", () => {
    assert.deepEqual(createBootGate("win32").state(), { platform: "win32", phase: BootPhase.Ready, sandbox: null });
  });

  it("holds on the setup screen with the problem, and a retry that succeeds opens the studio", async () => {
    const gate = createBootGate("linux");
    let attempts = 0;
    gate.hold(PROBLEM, async () => {
      attempts++;
    });
    assert.deepEqual(gate.state(), { platform: "linux", phase: BootPhase.SandboxSetup, sandbox: PROBLEM });
    assert.deepEqual(await gate.retry(), { platform: "linux", phase: BootPhase.Ready, sandbox: null });
    assert.equal(attempts, 1);
    assert.equal((await gate.retry()).phase, BootPhase.Ready, "a retry once ready changes nothing");
    assert.equal(attempts, 1);
  });

  it("a retry that finds the sandbox still unavailable shows the new problem and can retry again", async () => {
    const gate = createBootGate("linux");
    const fewer = { ...PROBLEM, missingTools: [SandboxTool.Socat] };
    let attempts = 0;
    gate.hold(PROBLEM, async () => {
      attempts++;
      if (attempts === 1) throw new SandboxUnavailableError(fewer);
    });
    assert.deepEqual((await gate.retry()).sandbox, fewer);
    assert.equal(gate.state().phase, BootPhase.SandboxSetup);
    assert.equal((await gate.retry()).phase, BootPhase.Ready);
  });

  it("another startup failure rejects the retry and leaves the setup state as it was", async () => {
    const gate = createBootGate("linux");
    gate.hold(PROBLEM, async () => {
      throw new Error("event store is corrupt");
    });
    await assert.rejects(gate.retry(), /event store is corrupt/);
    assert.deepEqual(gate.state().sandbox, PROBLEM);
  });

  it("presses of Retry while one attempt runs share it", async () => {
    const gate = createBootGate("linux");
    const attempt = deferred();
    let attempts = 0;
    gate.hold(PROBLEM, () => {
      attempts++;
      return attempt.promise;
    });
    const first = gate.retry();
    const second = gate.retry();
    attempt.resolve();
    assert.deepEqual(await first, await second);
    assert.equal(attempts, 1);
  });
});

describe("Set up (Windows)", () => {
  it("opens before replacement renderer creation so it cannot repeat provisioning", async () => {
    const gate = createBootGate(StudioPlatform.Windows, { automaticSetup: true });
    gate.hold(NOT_PROVISIONED, async () => {
      gate.open();
      assert.equal(gate.state().phase, BootPhase.Ready);
      assert.equal(gate.state().sandbox, null);
    });
    assert.equal(gate.state().automaticSetup, true);
    await gate.retry();
    assert.equal(gate.state().phase, BootPhase.Ready);
  });

  it("missing Git uses the same built-in prerequisite setup", async () => {
    const { gate, counts } = windowsGate(async () => ({ cancelled: false }));
    gate.hold({ ...NOT_PROVISIONED, code: SandboxProblemCode.GitMissing }, async () => {
      counts.attempts++;
    });
    assert.equal((await gate.setUp()).state.phase, BootPhase.Ready);
    assert.deepEqual(counts, { installs: 1, attempts: 1 });
  });

  it("installs the sandbox, then re-runs startup and opens the studio", async () => {
    const { gate, counts } = windowsGate(async () => ({ cancelled: false }));
    assert.deepEqual(await gate.setUp(), {
      outcome: SandboxSetupOutcome.Installed,
      state: { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null },
    });
    assert.deepEqual(counts, { installs: 1, attempts: 1 });
  });

  it("a cancelled approval prompt stays on the setup screen and starts nothing", async () => {
    const { gate, counts } = windowsGate(async () => ({ cancelled: true }));
    assert.deepEqual(await gate.setUp(), {
      outcome: SandboxSetupOutcome.Cancelled,
      state: { platform: StudioPlatform.Windows, phase: BootPhase.SandboxSetup, sandbox: NOT_PROVISIONED },
    });
    assert.deepEqual(counts, { installs: 1, attempts: 0 });
  });

  it("a failed install rejects and leaves the setup screen as it was", async () => {
    const { gate, counts } = windowsGate(async () => {
      throw new Error("srt-win install: WFP filter install failed");
    });
    await assert.rejects(gate.setUp(), /WFP filter install failed/);
    assert.deepEqual(gate.state().sandbox, NOT_PROVISIONED);
    assert.equal(counts.attempts, 0);
  });

  it("presses of Set up while one install runs share it", async () => {
    const install = deferred();
    const { gate, counts } = windowsGate(() => install.promise.then(() => ({ cancelled: false })));
    const first = gate.setUp();
    const second = gate.setUp();
    install.resolve();
    assert.deepEqual(await first, await second);
    assert.deepEqual(counts, { installs: 1, attempts: 1 });
  });

  it("refuses when there is nothing to install: a ready start, a Linux problem, or no installer", async () => {
    let installs = 0;
    const installSandbox = async () => {
      installs++;
      return { cancelled: false };
    };
    const ready = createBootGate(StudioPlatform.Windows, { installSandbox });
    await assert.rejects(ready.setUp(), /nothing to set up/);
    const linux = createBootGate(StudioPlatform.Linux, { installSandbox });
    linux.hold(PROBLEM, async () => {});
    await assert.rejects(linux.setUp(), /nothing to set up/);
    const noInstaller = createBootGate(StudioPlatform.Windows);
    noInstaller.hold(NOT_PROVISIONED, async () => {});
    await assert.rejects(noInstaller.setUp(), /nothing to set up/);
    assert.equal(installs, 0);
  });
});

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;

function bootIpc(fixture: boolean, platform: string = StudioPlatform.Linux) {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture, isStudioUi: () => true },
  );
  const installs: string[] = [];
  const gate = createBootGate(platform, {
    installSandbox: async () => {
      installs.push("install");
      return { cancelled: false };
    },
  });
  const painted: WindowControlColors[] = [];
  registerBootIpc(handle, { gate, setWindowControls: (colors) => void painted.push(colors) });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main" }, payload);
  };
  return { gate, painted, invoke, installs };
}

describe("boot IPC", () => {
  it("answers the state and runs Retry, in a fixture profile too", async () => {
    const { gate, invoke } = bootIpc(true);
    gate.hold(PROBLEM, async () => {});
    assert.deepEqual(await invoke("studio:boot"), { ok: true, value: gate.state() });
    assert.deepEqual(await invoke("studio:boot.retry"), {
      ok: true,
      value: { platform: "linux", phase: BootPhase.Ready, sandbox: null },
    });
  });

  it("runs Set up on Windows, and refuses it in a fixture profile without installing anything", async () => {
    const live = bootIpc(false, StudioPlatform.Windows);
    live.gate.hold(NOT_PROVISIONED, async () => {});
    assert.deepEqual(await live.invoke("studio:boot.setup"), {
      ok: true,
      value: {
        outcome: SandboxSetupOutcome.Installed,
        state: { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null },
      },
    });
    assert.deepEqual(live.installs, ["install"]);
    const fixture = bootIpc(true, StudioPlatform.Windows);
    fixture.gate.hold(NOT_PROVISIONED, async () => {});
    assert.equal((await fixture.invoke("studio:boot.setup")).ok, false);
    assert.deepEqual(fixture.installs, []);
    assert.equal(fixture.gate.state().phase, BootPhase.SandboxSetup);
  });

  it("paints the window controls with two hex colours", async () => {
    const { painted, invoke } = bootIpc(true);
    assert.deepEqual(await invoke("studio:window.controls", { color: "#1d1d1f", symbolColor: "#F5F5F7" }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(painted, [{ color: "#1d1d1f", symbolColor: "#F5F5F7" }]);
  });

  it("refuses anything but two #rrggbb colours, and paints nothing", async () => {
    const { painted, invoke } = bootIpc(false);
    for (const payload of [
      undefined,
      null,
      "#000000",
      {},
      { color: "#000000" },
      { color: "#000000", symbolColor: 0xffffff },
      { color: "red", symbolColor: "#ffffff" },
      { color: "#fff", symbolColor: "#ffffff" },
      { color: "#000000; background: url(x)", symbolColor: "#ffffff" },
      { color: "#00000000", symbolColor: "#ffffff" },
    ]) {
      const result = await invoke("studio:window.controls", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(painted, []);
  });
});
