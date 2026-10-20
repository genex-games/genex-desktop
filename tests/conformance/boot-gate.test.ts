/**
 * The sandbox setup boot state in main: the window asks where startup stands, and Retry re-runs
 * core startup. Driven through the real typed `handle()` with the gate's attempt and the window's
 * title-bar controls as recorders.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BootGate, createBootGate, startStepAfter } from "../../src/main/boot-gate.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerBootIpc } from "../../src/main/ipc/boot.ts";
import {
  BootPhase,
  SandboxProblemCode,
  SandboxSetupOutcome,
  SandboxTool,
  StartStep,
  StudioPlatform,
  linuxInstallCommands,
  type SandboxProblem,
} from "../../src/shared/boot.ts";
import { FEEDBACK_TEXT_MAX_CHARS, type FeedbackDraft, FeedbackScreen } from "../../src/shared/feedback.ts";
import type { WindowControls } from "../../src/shared/studio-api.ts";
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

describe("starting and a studio that would not start", () => {
  it("moves the starting window on at the core's games and sandbox marks", () => {
    assert.equal(startStepAfter("core:settings"), null);
    assert.equal(startStepAfter("core:games"), StartStep.Workspace);
    assert.equal(startStepAfter("core:sandbox"), StartStep.Studio);
  });

  it("says which step a starting core is on, and only while it is starting", () => {
    const gate = createBootGate(StudioPlatform.Windows);
    gate.progress(StartStep.Workspace);
    assert.equal(gate.state().phase, BootPhase.Ready, "a launch with no starting window stays ready");
    gate.starting(StartStep.Games);
    assert.deepEqual(gate.state(), {
      platform: StudioPlatform.Windows,
      phase: BootPhase.Starting,
      sandbox: null,
      step: StartStep.Games,
    });
    gate.progress(StartStep.Workspace);
    assert.equal(gate.state().step, StartStep.Workspace);
    gate.ready();
    assert.deepEqual(gate.state(), { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null });
    gate.progress(StartStep.Studio);
    assert.equal(gate.state().phase, BootPhase.Ready);
  });

  it("holds on the failure with its words, and Try again that works opens the studio", async () => {
    const gate = createBootGate(StudioPlatform.Mac);
    let attempts = 0;
    gate.fail("harness exited during boot", async () => {
      attempts++;
    });
    assert.deepEqual(gate.state(), {
      platform: StudioPlatform.Mac,
      phase: BootPhase.Failed,
      sandbox: null,
      failure: "harness exited during boot",
    });
    assert.deepEqual(await gate.retry(), { platform: StudioPlatform.Mac, phase: BootPhase.Ready, sandbox: null });
    assert.equal(attempts, 1);
  });

  it("a Try again that fails again shows the new failure instead of rejecting", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    gate.fail("first", async () => {
      throw new Error("EPERM: lstat AppData");
    });
    const after = await gate.retry();
    assert.equal(after.phase, BootPhase.Failed);
    assert.equal(after.failure, "EPERM: lstat AppData");
  });

  it("keeps the open studio when its agents would not start, and Try again that works clears the failure", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    let attempts = 0;
    gate.agentsFailed("srt-win acl stamp timed out after 60000ms", async () => {
      attempts++;
    });
    assert.deepEqual(gate.state(), {
      platform: StudioPlatform.Windows,
      phase: BootPhase.Ready,
      sandbox: null,
      failure: "srt-win acl stamp timed out after 60000ms",
    });
    assert.deepEqual(await gate.retry(), { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null });
    assert.equal(attempts, 1);
  });

  it("a Try again for the agents that fails again keeps the studio, with the new failure", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    gate.agentsFailed("first", async () => {
      throw new Error("EPERM: lstat AppData");
    });
    const after = await gate.retry();
    assert.equal(after.phase, BootPhase.Ready);
    assert.equal(after.failure, "EPERM: lstat AppData");
  });

  it("a start still running at its limit shows as failed, and Try again runs the restart it was given", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    let restarts = 0;
    const restart = async () => {
      restarts++;
    };
    gate.starting(StartStep.Workspace);
    assert.equal(gate.overdue("still starting after 3 minutes", restart), true);
    assert.equal(gate.state().phase, BootPhase.Failed);
    assert.equal(gate.state().failure, "still starting after 3 minutes");
    await gate.retry();
    assert.equal(restarts, 1);
  });

  it("a start that ended before its limit is left as it ended", () => {
    const ended = [
      (gate: BootGate) => gate.ready(),
      (gate: BootGate) => gate.hold(NOT_PROVISIONED, async () => {}),
      (gate: BootGate) => gate.fail("harness exited during boot", async () => {}),
    ];
    for (const end of ended) {
      const gate = createBootGate(StudioPlatform.Windows);
      gate.starting(StartStep.Games);
      end(gate);
      const before = gate.state();
      assert.equal(
        gate.overdue("still starting", async () => {}),
        false,
      );
      assert.deepEqual(gate.state(), before);
    }
  });

  it("a startup attempt that ends on a new hold keeps it, rather than opening the studio", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    gate.hold(NOT_PROVISIONED, async () => {
      gate.fail("harness exited during boot", async () => {});
    });
    const after = await gate.retry();
    assert.equal(after.phase, BootPhase.Failed);
    assert.equal(after.failure, "harness exited during boot");
  });
});

describe("Set up (Windows)", () => {
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

  it("tells the log why a Set up failed, the install or the startup after it, and nothing for a cancel", async () => {
    const failures: string[] = [];
    const setUpFailed = (error: unknown) => void failures.push(String(error));
    let install = async () => ({ cancelled: true });
    const gate = createBootGate(StudioPlatform.Windows, { installSandbox: () => install(), setUpFailed });
    gate.hold(NOT_PROVISIONED, async () => {
      throw new Error("WFP egress fence could not be verified");
    });
    await gate.setUp();
    install = async () => {
      throw new Error("srt-win install: WFP filter install failed");
    };
    await assert.rejects(gate.setUp());
    install = async () => ({ cancelled: false });
    await assert.rejects(gate.setUp());
    assert.deepEqual(failures, [
      "Error: srt-win install: WFP filter install failed",
      "Error: WFP egress fence could not be verified",
    ]);
  });

  it("after an install that went through, a Set up whose startup failed only starts again", async () => {
    let attempts = 0;
    const counts = { installs: 0 };
    const gate = createBootGate(StudioPlatform.Windows, {
      installSandbox: async () => {
        counts.installs++;
        return { cancelled: false };
      },
    });
    gate.hold(NOT_PROVISIONED, async () => {
      attempts++;
      if (attempts === 1) throw new Error("event store is corrupt");
    });
    await assert.rejects(gate.setUp(), /event store is corrupt/);
    assert.deepEqual(await gate.setUp(), {
      outcome: SandboxSetupOutcome.Installed,
      state: { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null },
    });
    assert.deepEqual({ ...counts, attempts }, { installs: 1, attempts: 2 }, "one administrator prompt");
  });

  it("a sandbox still waiting on its install after one is installed again by the next Set up", async () => {
    let installs = 0;
    const gate = createBootGate(StudioPlatform.Windows, {
      installSandbox: async () => {
        installs++;
        return { cancelled: false };
      },
    });
    gate.hold(NOT_PROVISIONED, async () => {
      throw new SandboxUnavailableError(NOT_PROVISIONED);
    });
    await gate.setUp();
    await gate.setUp();
    assert.equal(installs, 2);
  });

  it("hands the install the problem it is held on, so Set up does what that problem needs", async () => {
    const handed: SandboxProblem[] = [];
    const gate = createBootGate(StudioPlatform.Windows, {
      installSandbox: async (problem) => {
        handed.push(problem);
        return { cancelled: true };
      },
    });
    gate.hold(NOT_PROVISIONED, async () => {});
    await gate.setUp();
    assert.deepEqual(handed, [NOT_PROVISIONED]);
  });

  it("says a Set up has run this launch, so a window that loads again does not run it by itself", async () => {
    const { gate } = windowsGate(async () => ({ cancelled: true }));
    assert.equal(gate.state().setupTried, undefined);
    await gate.setUp();
    assert.equal(gate.state().setupTried, true);
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
  const painted: WindowControls[] = [];
  const reports: FeedbackDraft[] = [];
  const quits: string[] = [];
  registerBootIpc(handle, {
    gate,
    report: async (draft) => void reports.push(draft),
    setWindowControls: (colors) => void painted.push(colors),
    quit: () => void quits.push("quit"),
  });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener({ sender: "studio", senderFrame: "main" }, payload);
  };
  return { gate, painted, reports, invoke, installs, quits };
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

  it("sends a failed Set up's report with the app's log, and refuses it in a fixture profile", async () => {
    const live = bootIpc(false, StudioPlatform.Windows);
    assert.deepEqual(await live.invoke("studio:boot.report", { error: " Access is denied. (0x80070005) " }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(live.reports, [
      {
        text: "Windows setup didn't finish (sent from the setup screen).\n\nAccess is denied. (0x80070005)",
        screen: FeedbackScreen.Home,
        appLogs: true,
        chatId: null,
      },
    ]);
    const fixture = bootIpc(true, StudioPlatform.Windows);
    assert.equal((await fixture.invoke("studio:boot.report", { error: "Access is denied." })).ok, false);
    assert.deepEqual(fixture.reports, []);
  });

  it("clips a long error to what a report holds, and sends nothing without one", async () => {
    const { reports, invoke } = bootIpc(false, StudioPlatform.Windows);
    await invoke("studio:boot.report", { error: "x".repeat(FEEDBACK_TEXT_MAX_CHARS * 2) });
    assert.equal(reports[0]?.text.length, FEEDBACK_TEXT_MAX_CHARS);
    for (const payload of [undefined, null, "Access is denied.", {}, { error: "" }, { error: "   " }, { error: 5 }]) {
      const result = await invoke("studio:boot.report", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
    }
    assert.equal(reports.length, 1);
  });

  it("quits on Quit, which a start that failed offers", async () => {
    const { invoke, quits } = bootIpc(true);
    assert.deepEqual(await invoke("studio:boot.quit"), { ok: true, value: undefined });
    assert.equal(quits.length, 1);
  });

  it("names a studio that would not start in its report, not a setup", async () => {
    const { gate, invoke, reports } = bootIpc(false);
    gate.fail("harness exited during boot", async () => {});
    await invoke("studio:boot.report", { error: "harness exited during boot" });
    assert.match(reports[0]?.text ?? "", /^Genex couldn't start/);
  });

  it("names agents that would not start in an open studio in its report", async () => {
    const { gate, invoke, reports } = bootIpc(false);
    gate.agentsFailed("srt-win acl stamp timed out", async () => {});
    await invoke("studio:boot.report", { error: "srt-win acl stamp timed out" });
    assert.match(reports[0]?.text ?? "", /^Genex's agents didn't start/);
  });

  it("paints the window controls with two hex colours, see-through or not", async () => {
    const { painted, invoke } = bootIpc(true);
    const controls = { color: "#1d1d1f", symbolColor: "#F5F5F7", seeThrough: true };
    assert.deepEqual(await invoke("studio:window.controls", controls), { ok: true, value: undefined });
    assert.deepEqual(painted, [controls]);
  });

  it("refuses anything but two #rrggbb colours and a see-through flag, and paints nothing", async () => {
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
      { color: "#000000", symbolColor: "#ffffff" },
      { color: "#000000", symbolColor: "#ffffff", seeThrough: "true" },
      { color: "#000000", symbolColor: "#ffffff", seeThrough: 1 },
      { color: "#00000000", symbolColor: "#ffffff", seeThrough: true },
    ]) {
      const result = await invoke("studio:window.controls", payload);
      assert.equal(result.ok, false, JSON.stringify(payload));
    }
    assert.deepEqual(painted, []);
  });
});
