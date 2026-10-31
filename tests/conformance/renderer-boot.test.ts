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
  StartStep,
  StudioPlatform,
  linuxInstallCommands,
  type BootState,
  type SandboxProblem,
  type SandboxSetupResult,
  WindowsSetupNeed,
} from "../../src/shared/boot.ts";
import { BootView, bootView, canSetUp, createBoot, SetupReport } from "../../src/renderer/state/boot.ts";
import { nativeViewsUp } from "../../src/renderer/play/play-model.ts";
import { gameOpened, initialPlay, type PlayState, viewerReported } from "../../src/renderer/state/play.ts";
import {
  homeUnderControls,
  setHomeUnderControls,
  syncWindowControls,
  windowControlColors,
} from "../../src/renderer/window-controls.ts";
import { PlayViewerPhase } from "../../src/shared/play.ts";
import { type ReadyUpdate, UpdateAction } from "../../src/shared/app-update.ts";
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
function windowsBoot(results: Array<SandboxSetupResult | Error>) {
  const fake = fakeStudioApi();
  fake.stub("bootState", async () => WINDOWS_SETUP);
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
  it("is offered only for a Windows sandbox that has not been set up", () => {
    const state = (boot: BootState) => ({ platform: boot.platform, problem: boot.sandbox });
    assert.equal(canSetUp(state(WINDOWS_SETUP)), true);
    assert.equal(canSetUp(state(SETUP)), false, "Linux installs its tools in a terminal");
    assert.equal(canSetUp(state(WINDOWS_READY)), false);
    assert.equal(canSetUp({ platform: StudioPlatform.Linux, problem: NOT_PROVISIONED }), false);
    const gitMissing = { ...NOT_PROVISIONED, code: SandboxProblemCode.GitMissing };
    assert.equal(canSetUp({ platform: StudioPlatform.Windows, problem: gitMissing }), false, "Git installs by hand");
  });

  it("starts Set up by itself on Windows, so the first screen is already waiting on the approval", async () => {
    const { controller, fake, started } = windowsBoot([]);
    const seen: string[] = [];
    controller.store.subscribe((state) => {
      seen.push(state.settingUp ? "setting up" : bootView(state));
    });
    await controller.start();
    assert.deepEqual(seen, [BootView.SandboxSetup, "setting up", BootView.Studio]);
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(started(), 1);
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
  });

  it("starts Set up by itself once a launch: a window that loads again after a decline waits for Set up", async () => {
    const { controller, fake } = windowsBoot([]);
    fake.stub("bootState", async () => ({ ...WINDOWS_SETUP, setupTried: true }));
    await controller.start();
    assert.equal(fake.callsOf("setUpSandbox").length, 0);
    assert.equal(bootView(controller.store.getState()), BootView.SandboxSetup);
  });

  it("waits for the press to update a sandbox another release set up: an update raises no prompt unasked", async () => {
    const { controller, fake } = windowsBoot([]);
    const reinstall = { ...NOT_PROVISIONED, windowsNeeds: [WindowsSetupNeed.Reinstall] };
    fake.stub("bootState", async () => ({ ...WINDOWS_SETUP, sandbox: reinstall }));
    await controller.start();
    assert.equal(fake.callsOf("setUpSandbox").length, 0);
    assert.equal(bootView(controller.store.getState()), BootView.SandboxSetup);
    await controller.setUp();
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
  });

  it("starts nothing by itself where Set up is not offered: a ready start, or Linux", async () => {
    for (const first of [READY, SETUP]) {
      const { controller, fake } = boot(first);
      await controller.start();
      assert.equal(fake.callsOf("setUpSandbox").length, 0);
    }
  });

  it("sends a failed Set up's error as a report once, and a new Set up starts a new report", async () => {
    const error = "WFP egress fence could not be verified: Access is denied. (0x80070005)";
    const { controller, fake } = windowsBoot([new Error(error), new Error(error)]);
    const reports: string[] = [];
    fake.stub("reportSandboxSetup", async (text) => {
      reports.push(text);
    });
    await controller.start();
    assert.equal(controller.store.getState().report, SetupReport.Idle);
    const sending = Promise.all([controller.report(), controller.report()]);
    assert.equal(controller.store.getState().report, SetupReport.Sending);
    await sending;
    assert.deepEqual(reports, [error], "two presses, one report");
    assert.equal(controller.store.getState().report, SetupReport.Sent);
    await controller.setUp();
    assert.equal(controller.store.getState().report, SetupReport.Idle);
  });

  it("a report that does not go through can be sent again", async () => {
    const { controller, fake } = windowsBoot([new Error("srt-win install failed")]);
    fake.stub("reportSandboxSetup", async () => {
      throw new Error("offline");
    });
    await controller.start();
    await controller.report();
    assert.equal(controller.store.getState().report, SetupReport.Failed);
  });

  it("a report still sending when a new Set up starts does not mark the new error sent", async () => {
    const { controller, fake } = windowsBoot([new Error("first"), new Error("second")]);
    let finish = () => {};
    fake.stub("reportSandboxSetup", () => new Promise<void>((done) => (finish = done)));
    await controller.start();
    const sending = controller.report();
    await controller.setUp();
    finish();
    await sending;
    const state = controller.store.getState();
    assert.equal(state.error, "second");
    assert.equal(state.report, SetupReport.Idle);
  });

  it("an install after which Windows still reports no sandbox is a failure with Windows' words", async () => {
    const still = { ...WINDOWS_SETUP, sandbox: { ...NOT_PROVISIONED, details: ["Sandbox user is not provisioned"] } };
    const { controller } = windowsBoot([{ outcome: SandboxSetupOutcome.Installed, state: still }]);
    await controller.start();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.SandboxSetup);
    assert.equal(state.error, "Sandbox user is not provisioned");
  });

  it("has nothing to report before a Set up has failed", async () => {
    const { controller, fake } = windowsBoot([]);
    await controller.load();
    await controller.report();
    assert.equal(fake.callsOf("reportSandboxSetup").length, 0);
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

/** A Windows window that opened while the core starts: main answers `answers` in turn, then the last one. */
function startingBoot(answers: BootState[], retries: BootState[] = []) {
  const fake = fakeStudioApi();
  const asked = [...answers];
  fake.stub("bootState", async () => (asked.length > 1 ? asked.shift() : asked[0]) as BootState);
  fake.stub("retrySandboxSetup", async () => retries.shift() ?? WINDOWS_READY);
  fake.stub("setUpSandbox", async () => ({ outcome: SandboxSetupOutcome.Installed, state: WINDOWS_READY }));
  let started = 0;
  const waits: number[] = [];
  const controller = createBoot(fake.api, {
    onReady: () => {
      started++;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { fake, controller, started: () => started, waits };
}

const starting = (step: StartStep): BootState => ({
  platform: StudioPlatform.Windows,
  phase: BootPhase.Starting,
  sandbox: null,
  step,
});
const FAILURE = "EPERM: operation not permitted, lstat 'C:\\Users\\USER\\AppData'";
const FAILED: BootState = {
  platform: StudioPlatform.Windows,
  phase: BootPhase.Failed,
  sandbox: null,
  failure: FAILURE,
};

describe("a window that opens while the studio starts", () => {
  it("says which step the core is on, and follows it", async () => {
    const { controller, waits } = startingBoot([
      starting(StartStep.Agents),
      starting(StartStep.Games),
      starting(StartStep.Workspace),
      starting(StartStep.Studio),
      WINDOWS_SETUP,
    ]);
    const steps: Array<StartStep | null> = [];
    controller.store.subscribe((state) => {
      if (bootView(state) === BootView.Starting) steps.push(state.step);
    });
    await controller.start();
    assert.deepEqual(steps, [StartStep.Agents, StartStep.Games, StartStep.Workspace, StartStep.Studio]);
    assert.equal(waits.length, 4, "one wait before each new question");
  });

  it("goes on to the setup screen a start ends on, and runs Set up there by itself", async () => {
    const { controller, fake } = startingBoot([starting(StartStep.Workspace), WINDOWS_SETUP]);
    await controller.start();
    assert.equal(fake.callsOf("setUpSandbox").length, 1);
  });

  it("does not start the studio when the core is ready: main opens it in its own window", async () => {
    const { controller, started } = startingBoot([starting(StartStep.Studio), WINDOWS_READY]);
    await controller.start();
    assert.equal(started(), 0);
    assert.equal(bootView(controller.store.getState()), BootView.Starting);
  });
});

describe("a studio that would not start", () => {
  it("shows why, in the window, and does not start the studio", async () => {
    const { controller, started } = startingBoot([FAILED]);
    await controller.start();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.Failed);
    assert.equal(state.error, FAILURE);
    assert.equal(started(), 0);
  });

  it("Try again starts the studio once main says it is ready", async () => {
    const { controller, started, fake } = startingBoot([FAILED]);
    await controller.start();
    await controller.retry();
    assert.equal(bootView(controller.store.getState()), BootView.Studio);
    assert.equal(started(), 1);
    assert.equal(fake.callsOf("retrySandboxSetup").length, 1);
  });

  it("a Try again that fails again shows the new words", async () => {
    const again: BootState = { ...FAILED, failure: "harness exited during boot" };
    const { controller } = startingBoot([FAILED], [again]);
    await controller.start();
    await controller.retry();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.Failed);
    assert.equal(state.error, "harness exited during boot");
  });

  it("sends its failure as a report", async () => {
    const { controller, fake } = startingBoot([FAILED]);
    const reports: string[] = [];
    fake.stub("reportSandboxSetup", async (text) => {
      reports.push(text);
    });
    await controller.start();
    await controller.report();
    assert.deepEqual(reports, [FAILURE]);
  });

  it("Quit asks main to quit", async () => {
    const { controller, fake } = startingBoot([FAILED]);
    await controller.start();
    await controller.quit();
    assert.equal(fake.callsOf("quitFromBoot").length, 1);
  });
});

describe("an update that arrives before the studio opens", () => {
  const NEXT: ReadyUpdate = { version: "0.1.14", action: UpdateAction.Restart };

  /** A boot whose main has nothing downloaded for the first `empty` questions, then `NEXT`. */
  function updatingBoot(first: BootState, empty: number) {
    const booted = startingBoot([first]);
    let asked = 0;
    booted.fake.stub("readyUpdate", async () => (asked++ < empty ? null : NEXT));
    return booted;
  }

  it("a start that failed shows the update downloaded meanwhile, and Relaunch installs it", async () => {
    const { controller, fake, waits } = updatingBoot(FAILED, 2);
    await controller.start();
    assert.equal(controller.store.getState().update, null);
    await controller.watchUpdate();
    assert.deepEqual(controller.store.getState().update, NEXT);
    assert.equal(fake.callsOf("readyUpdate").length, 3, "asks again until one is downloaded");
    assert.equal(waits.length, 2, "one wait between questions");
    await controller.restartToUpdate();
    assert.equal(fake.callsOf("restartToUpdate").length, 1);
  });

  it("the setup screen shows it too", async () => {
    const { controller } = updatingBoot(WINDOWS_SETUP, 0);
    await controller.load();
    await controller.watchUpdate();
    assert.deepEqual(controller.store.getState().update, NEXT);
  });

  it("stops asking once the studio is up: its sidebar offers the relaunch", async () => {
    const { controller, fake } = updatingBoot(WINDOWS_READY, 5);
    await controller.load();
    await controller.watchUpdate();
    assert.equal(fake.callsOf("readyUpdate").length, 0);
  });

  it("a main that cannot say keeps the screen as it is and asks again", async () => {
    const { controller, fake } = startingBoot([FAILED]);
    let asked = 0;
    fake.stub("readyUpdate", async () => {
      if (asked++ === 0) throw new Error("no handler");
      return NEXT;
    });
    await controller.start();
    await controller.watchUpdate();
    assert.deepEqual(controller.store.getState().update, NEXT);
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

  it("say whether Home's background lies under the controls, and send again only when that changes", () => {
    const fake = fakeStudioApi();
    const theme = style({ "--background": "#1d1d1f", "--foreground": "#dee0e2" });
    const stop = syncWindowControls(fake.api, StudioPlatform.Windows, () => theme);
    try {
      setHomeUnderControls(true);
      setHomeUnderControls(true);
      setHomeUnderControls(false);
    } finally {
      stop();
      setHomeUnderControls(false);
    }
    setHomeUnderControls(true);
    setHomeUnderControls(false);
    const colors = { color: "#1d1d1f", symbolColor: "#dee0e2" };
    assert.deepEqual(
      fake.callsOf("setWindowControls").map(([controls]) => controls),
      [
        { ...colors, seeThrough: false },
        { ...colors, seeThrough: true },
        { ...colors, seeThrough: false },
      ],
    );
  });

  it("count Home's background under them only at rest, with no room, remix or game viewer over it", () => {
    const home = { resting: true, covered: false, viewerUp: false };
    assert.equal(homeUnderControls(home), true);
    assert.equal(homeUnderControls({ ...home, resting: false }), false, "a game launching from Home");
    assert.equal(homeUnderControls({ ...home, covered: true }), false, "Play, Plugins or a remix over Home");
    assert.equal(homeUnderControls({ ...home, viewerUp: true }), false, "a game viewer over Home");
  });

  it("stop counting Home's background while a friend's game opens in the viewer over it, and count it again once it closes", () => {
    const atRest = (play: PlayState) =>
      homeUnderControls({ resting: true, covered: false, viewerUp: nativeViewsUp(play.viewer) });
    let play = initialPlay();
    assert.equal(atRest(play), true);
    play = gameOpened(play, { slug: "kart", title: "Kart", coverUrl: null });
    assert.equal(atRest(play), false, "the cover shows before main answers");
    play = viewerReported(play, { slug: "kart", openId: 1, phase: PlayViewerPhase.Playing });
    assert.equal(atRest(play), false);
    play = viewerReported(play, { slug: "kart", openId: 1, phase: PlayViewerPhase.Closed });
    assert.equal(atRest(play), true);
  });

  it("send nothing on macOS, which draws its own lights", () => {
    const fake = fakeStudioApi();
    const theme = style({ "--background": "#1d1d1f", "--foreground": "#dee0e2" });
    const stop = syncWindowControls(fake.api, StudioPlatform.Mac, () => theme);
    setHomeUnderControls(true);
    stop();
    setHomeUnderControls(false);
    assert.deepEqual(fake.callsOf("setWindowControls"), []);
  });
});

const MOVE_TO = "D:\\Genex";
const moving = (done: number, total: number): BootState => ({
  platform: StudioPlatform.Windows,
  phase: BootPhase.Moving,
  sandbox: null,
  move: { to: MOVE_TO, done, total },
});
const MISSING: BootState = {
  platform: StudioPlatform.Windows,
  phase: BootPhase.DataMissing,
  sandbox: null,
  dataFolder: MOVE_TO,
};

describe("a launch that moves Genex's files", () => {
  it("follows the move from counting to the last byte, and starts nothing: main starts Genex again", async () => {
    const { controller, started } = startingBoot([
      moving(0, 0),
      moving(0, 900),
      moving(450, 900),
      moving(900, 900),
      WINDOWS_READY,
    ]);
    const seen: Array<[number, number]> = [];
    controller.store.subscribe((state) => {
      if (bootView(state) === BootView.Moving && state.move) seen.push([state.move.done, state.move.total]);
    });
    await controller.start();
    assert.deepEqual(seen, [
      [0, 0],
      [0, 900],
      [450, 900],
      [900, 900],
    ]);
    assert.equal(controller.store.getState().move?.to, MOVE_TO);
    assert.equal(started(), 0);
  });
});

describe("a move that stopped part-way", () => {
  it("stops following the move and shows why, with Try again", async () => {
    const stopped: BootState = { ...moving(0, 0), failure: "A file was in use." };
    const { controller, waits, fake } = startingBoot([moving(10, 90), stopped]);
    await controller.start();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.Moving);
    assert.equal(state.error, "A file was in use.");
    assert.equal(waits.length, 1, "no more questions once it stopped");
    await controller.retry();
    assert.equal(fake.callsOf("retrySandboxSetup").length, 1);
  });
});

describe("a data folder that is not there", () => {
  it("names the folder and starts nothing", async () => {
    const { controller, started } = startingBoot([MISSING]);
    await controller.start();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.DataMissing);
    assert.equal(state.dataFolder, MOVE_TO);
    assert.equal(state.error, null);
    assert.equal(started(), 0);
  });

  it("a Try again while it is still missing says so and stays", async () => {
    const still: BootState = { ...MISSING, failure: `${MOVE_TO} is still not there.` };
    const { controller } = startingBoot([MISSING], [still]);
    await controller.start();
    await controller.retry();
    const state = controller.store.getState();
    assert.equal(bootView(state), BootView.DataMissing);
    assert.equal(state.error, `${MOVE_TO} is still not there.`);
  });
});
