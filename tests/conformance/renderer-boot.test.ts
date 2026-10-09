/**
 * The renderer's boot state: before anything else it asks main where startup stands, shows the
 * sandbox setup screen while the protected workspace is missing, and starts the studio once it is
 * ready — at load, or after Retry. Driven through the typed `StudioApi` fake, with no DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BootPhase,
  SandboxProblemCode,
  SandboxSetupOutcome,
  SandboxTool,
  StudioPlatform,
  linuxInstallCommands,
  type BootState,
  type SandboxProblem,
  type SandboxSetupResult,
} from "../../src/shared/boot.ts";
import { BootView, bootView, canSetUp, createBoot } from "../../src/renderer/state/boot.ts";
import { windowControlColors } from "../../src/renderer/window-controls.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const PROBLEM: SandboxProblem = {
  code: SandboxProblemCode.MissingTools,
  platform: "linux",
  missingTools: [SandboxTool.Bubblewrap],
  installCommands: linuxInstallCommands([SandboxTool.Bubblewrap]),
  details: [],
};
const SETUP: BootState = { platform: "linux", phase: BootPhase.SandboxSetup, sandbox: PROBLEM };
const READY: BootState = { platform: "linux", phase: BootPhase.Ready, sandbox: null };

function boot(first: BootState | Error, retries: Array<BootState | Error> = []) {
  const fake = fakeStudioApi();
  fake.stub("bootState", async () => {
    if (first instanceof Error) throw first;
    return first;
  });
  fake.stub("retrySandboxSetup", async () => {
    const next = retries.shift() ?? READY;
    if (next instanceof Error) throw next;
    return next;
  });
  let started = 0;
  const controller = createBoot(fake.api, {
    onReady: () => {
      started++;
    },
  });
  return { fake, controller, started: () => started };
}

describe("renderer boot", () => {
  it("is loading until main answers", () => {
    const { controller } = boot(READY);
    assert.equal(bootView(controller.store.getState()), BootView.Loading);
  });

  it("a ready start starts the studio once and shows it", async () => {
    const { controller, started } = boot(READY);
    await controller.load();
    await controller.load();
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(controller.store.getState().platform, "linux");
    assert.equal(started(), 1);
  });

  it("an unavailable sandbox shows the setup screen and does not start the studio", async () => {
    const { controller, started } = boot(SETUP);
    await controller.load();
    assert.equal(bootView(controller.store.getState()), BootView.SandboxSetup);
    assert.deepEqual(controller.store.getState().problem, SETUP.sandbox);
    assert.equal(started(), 0);
  });

  it("Retry shows it is checking, then starts the studio when the sandbox is ready", async () => {
    const { controller, fake, started } = boot(SETUP);
    await controller.load();
    const retry = controller.retry();
    assert.equal(controller.store.getState().retrying, true);
    await retry;
    assert.equal(controller.store.getState().retrying, false);
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(started(), 1);
    assert.equal(fake.callsOf("retrySandboxSetup").length, 1);
  });

  it("a Retry that is still unavailable stays on the setup screen with the new problem", async () => {
    const fewer = { ...SETUP, sandbox: { ...PROBLEM, missingTools: [SandboxTool.Socat] } };
    const { controller, started } = boot(SETUP, [fewer]);
    await controller.load();
    await controller.retry();
    assert.equal(bootView(controller.store.getState()), BootView.SandboxSetup);
    assert.deepEqual(controller.store.getState().problem?.missingTools, [SandboxTool.Socat]);
    assert.equal(started(), 0);
  });

  it("a failed Retry says why and lets the person retry again", async () => {
    const { controller } = boot(SETUP, [new Error("event store is corrupt")]);
    await controller.load();
    await controller.retry();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.SandboxSetup);
    assert.equal(state.error, "event store is corrupt");
    assert.equal(state.retrying, false);
    await controller.retry();
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(controller.store.getState().error, null);
  });

  it("presses of Retry while one runs send one request", async () => {
    const { controller, fake } = boot(SETUP);
    await controller.load();
    await Promise.all([controller.retry(), controller.retry()]);
    assert.equal(fake.callsOf("retrySandboxSetup").length, 1);
  });

  it("a main that cannot answer does not strand the window: the studio starts", async () => {
    const { controller, started } = boot(new Error("No handler registered for 'studio:boot'"));
    await controller.load();
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(started(), 1);
  });
});

const NOT_PROVISIONED: SandboxProblem = {
  code: SandboxProblemCode.NotProvisioned,
  platform: StudioPlatform.Windows,
  missingTools: [],
  installCommands: [],
  details: [],
};
const WINDOWS_SETUP: BootState = {
  platform: StudioPlatform.Windows,
  phase: BootPhase.SandboxSetup,
  sandbox: NOT_PROVISIONED,
};
const WINDOWS_READY: BootState = { platform: StudioPlatform.Windows, phase: BootPhase.Ready, sandbox: null };

/** A Windows window on the setup screen whose Set up answers `results` in turn. */
function windowsBoot(results: Array<SandboxSetupResult | Error>, automaticSetup = false) {
  const fake = fakeStudioApi();
  fake.stub("bootState", async () => ({ ...WINDOWS_SETUP, automaticSetup }));
  fake.stub("retrySandboxSetup", async () => WINDOWS_READY);
  fake.stub("setUpSandbox", async () => {
    const next = results.shift() ?? { outcome: SandboxSetupOutcome.Installed, state: WINDOWS_READY };
    if (next instanceof Error) throw next;
    return next;
  });
  let started = 0;
  const controller = createBoot(fake.api, {
    onReady: () => {
      started++;
    },
  });
  return { fake, controller, started: () => started };
}

describe("Set up on Windows", () => {
  it("normal Windows first launch sets up automatically and starts once", async () => {
    const { controller, fake, started } = windowsBoot([], true);
    await controller.load();
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
    assert.equal(started(), 1);
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
  });

  for (const result of [{ outcome: SandboxSetupOutcome.Cancelled, state: WINDOWS_SETUP }, new Error("setup failed")]) {
    it(`automatic setup never repeats after cancellation or failure (${String(result)})`, async () => {
      const { controller, fake, started } = windowsBoot([result], true);
      await controller.load();
      await controller.load();
      assert.equal(fake.callsOf("setUpSandbox").length, 1);
      assert.equal(started(), 0);
      await controller.setUp();
      assert.equal(fake.callsOf("setUpSandbox").length, 2, "explicit retry remains available");
    });
  }

  it("fixture and developer launches do not request automatic setup", async () => {
    const { controller, fake } = windowsBoot([]);
    await controller.load();
    assert.equal(fake.callsOf("setUpSandbox").length, 0);
  });

  it("is offered only for a Windows sandbox that has not been set up", () => {
    const state = (boot: BootState) => ({ platform: boot.platform, problem: boot.sandbox });
    assert.equal(canSetUp(state(WINDOWS_SETUP)), true);
    assert.equal(canSetUp(state(SETUP)), false, "Linux installs its tools in a terminal");
    assert.equal(canSetUp(state(WINDOWS_READY)), false);
    assert.equal(canSetUp({ platform: StudioPlatform.Linux, problem: NOT_PROVISIONED }), false);
    const gitMissing = { ...NOT_PROVISIONED, code: SandboxProblemCode.GitMissing };
    assert.equal(
      canSetUp({ platform: StudioPlatform.Windows, problem: gitMissing }),
      true,
      "Genex installs private Git",
    );
  });

  it("shows it is waiting for approval, then starts the studio once installed", async () => {
    const { controller, fake, started } = windowsBoot([]);
    await controller.load();
    const setUp = controller.setUp();
    assert.equal(controller.store.getState().settingUp, true);
    await setUp;
    const state = controller.store.getState();
    assert.equal(state.settingUp, false);
    assert.equal(bootView(state), BootView.Studio);
    assert.equal(started(), 1);
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
  });

  it("a cancelled approval stays on the setup screen and says so, until the next Set up or Retry", async () => {
    const cancelled = { outcome: SandboxSetupOutcome.Cancelled, state: WINDOWS_SETUP };
    const { controller, started } = windowsBoot([cancelled, cancelled]);
    await controller.load();
    await controller.setUp();
    let state = controller.store.getState();
    assert.equal(bootView(state), BootView.SandboxSetup);
    assert.equal(state.setupCancelled, true);
    assert.equal(state.settingUp, false);
    assert.equal(started(), 0);
    await controller.setUp();
    assert.equal(controller.store.getState().setupCancelled, true, "cancelled again");
    await controller.retry();
    state = controller.store.getState();
    assert.equal(state.setupCancelled, false);
    assert.equal(bootView(state), BootView.Studio);
  });

  it("a failed install says why and lets the person set up again", async () => {
    const { controller } = windowsBoot([new Error("srt-win install: sandbox user provisioning failed")]);
    await controller.load();
    await controller.setUp();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.SandboxSetup);
    assert.equal(state.error, "srt-win install: sandbox user provisioning failed");
    assert.equal(state.settingUp, false);
    await controller.setUp();
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
  });

  it("presses of Set up while one runs send one request", async () => {
    const { controller, fake } = windowsBoot([]);
    await controller.load();
    await Promise.all([controller.setUp(), controller.setUp()]);
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
  });
});

describe("window control colours", () => {
  const style = (values: Record<string, string>) => ({ getPropertyValue: (name: string) => values[name] ?? "" });

  it("take the theme's canvas and ink", () => {
    assert.deepEqual(windowControlColors(style({ "--background": " #1d1d1f", "--foreground": "#dee0e2 " })), {
      color: "#1d1d1f",
      symbolColor: "#dee0e2",
    });
  });

  it("send nothing until both are plain hex colours", () => {
    const unusable: Array<Record<string, string>> = [
      {},
      { "--background": "#1d1d1f" },
      { "--background": "var(--x)", "--foreground": "#dee0e2" },
      { "--background": "#1d1d1f", "--foreground": "color-mix(in oklab, red, blue)" },
    ];
    for (const values of unusable) assert.equal(windowControlColors(style(values)), null, JSON.stringify(values));
  });
});
