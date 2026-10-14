/**
 * The chat panel's decisions, as pure functions: when a send becomes a sign-in, which local model
 * can finish a turn, whether the chat itself is working and what its busy line says, and when a
 * plan waits for the user.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { ExecutionStatus, RunState, runExecution } from "../../src/shared/run-state.ts";
import { isWorkingStatus } from "../../src/renderer/state/threads.ts";
import type { PlanReviewRecord } from "../../src/shared/composer.ts";
import { busyLabel, chatWorkState, type ChatWorkInput } from "../../src/renderer/chat/chat-work-state.ts";
import type { ConversationEntry } from "../../src/renderer/chat/conversation-entries.ts";
import { ToolState } from "../../src/renderer/ui/tool-state.ts";
import { planAwaitsAnswer, planInProgress } from "../../src/renderer/chat/use-plan-review.ts";
import { localToolModel, signInRequested, subscriptionBlocksSend } from "../../src/renderer/chat/use-sign-in-gate.ts";
import { MODEL_KEY_SEPARATOR, modelKey, parseModelKey } from "../../src/renderer/model-key.ts";
import { EXPORT_WORDS, exportedWords } from "../../src/renderer/words.ts";
import {
  exportDestinationLabel,
  exportDestinationsFor,
  exportNotice,
} from "../../src/renderer/chat/use-chat-export.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { ExportWarningCode, WEB_BUDGET_MB_BYTES } from "../../src/shared/game-export-contract.ts";
import {
  BuildTarget,
  GameStack,
  type GameProject,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import { leadFrameOf } from "../../src/renderer/state/agent-screens.ts";
import { compactControl } from "../../src/renderer/chat/compact-control.ts";
import { ComposerCommand, commandMatches, commandQuery } from "../../src/renderer/chat/composer-commands.ts";
import type { AgentScreenFrame } from "../../src/shared/agent-screen.ts";

type Code = EngineDescriptor["status"]["code"];
type Model = EngineDescriptor["models"][number];

function lifecycle(eventType: string, runId = "run_a", payload = {}): EventEnvelope {
  return {
    id: `${runId}-${eventType}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-09-29T00:00:00.000Z",
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId, ...payload } },
  };
}

function workInput(events: EventEnvelope[], status = "run run_a"): ChatWorkInput {
  const run = runExecution(events);
  return {
    status,
    run,
    activeRunId: run?.state === RunState.Running ? run.runId : null,
    working: isWorkingStatus(status) || run?.state === RunState.Running,
    busy: false,
    sending: false,
    answering: false,
    planWorking: false,
    revisingPlan: false,
    stopping: false,
    questionsWaiting: false,
    readingEntries: [],
  };
}

describe("composer cancellation eligibility", () => {
  const start = lifecycle(CustomEvent.RunStarted);
  const pause = lifecycle(CustomEvent.AutopilotPaused);
  const settled = [start, pause];

  for (const status of [ExecutionStatus.Paused, ExecutionStatus.Completed, ExecutionStatus.Failed]) {
    it(`ignores the matching stale status of a ${status} run`, () => {
      const events = [start, lifecycle(CustomEvent.RunFinished, "run_a", { executionStatus: status })];
      assert.equal(chatWorkState(workInput(events)).stoppable, false);
      assert.equal(chatWorkState(workInput(events, "idle")).stoppable, false);
    });
  }

  it("keeps real work interruptible without treating revision or stop feedback as new work", () => {
    const base = workInput(settled);
    assert.equal(chatWorkState(workInput([start])).stoppable, true);
    for (const field of ["busy", "answering", "planWorking"] as const)
      assert.equal(chatWorkState({ ...base, [field]: true }).stoppable, true, field);
    for (const field of ["revisingPlan", "stopping", "sending", "questionsWaiting"] as const)
      assert.equal(chatWorkState({ ...base, [field]: true }).stoppable, false, field);
    assert.equal(chatWorkState(workInput(settled, "thinking")).stoppable, true);
    assert.equal(chatWorkState(workInput(settled, "Self-improving from run_a")).stoppable, true);
    assert.equal(chatWorkState(workInput([], "idle")).stoppable, false);
  });

  it("resumes and starts new runs without an old close hiding Stop", () => {
    assert.equal(chatWorkState(workInput([...settled, lifecycle(CustomEvent.AutopilotResumed)])).stoppable, true);
    const next = [...settled, lifecycle(CustomEvent.RunStarted, "run_b"), pause];
    assert.equal(chatWorkState(workInput(next, "run run_b")).stoppable, true);
  });

  it("converges for either arrival order of the idle status and terminal event", () => {
    assert.equal(chatWorkState(workInput([start], "idle")).stoppable, true);
    assert.equal(chatWorkState(workInput(settled)).stoppable, false);
    assert.equal(chatWorkState(workInput(settled, "idle")).stoppable, false);
  });
});

const model = (id: string, supportsTools: boolean): Model => ({
  id,
  label: id,
  contextWindow: 8000,
  supportsTools,
  supportsVision: false,
});

const engine = (id: string, kind: EngineDescriptor["kind"], code: Code, models: Model[] = []): EngineDescriptor => ({
  id,
  label: id,
  kind,
  status: { code, detail: "" },
  models,
  defaultModel: null,
});

const custom = (event_type: string): EventEnvelope =>
  ({ id: event_type, thread_id: "t", data: { type: "custom", event_type, payload: {} } }) as unknown as EventEnvelope;

describe("the sign-in gate", () => {
  const claude = engine("claude-code", "delegated", "needs_login");

  it("blocks a send on the selected subscription while it is signed out or not installed", () => {
    assert.equal(subscriptionBlocksSend(claude, claude), true);
    const missing = engine("claude-code", "delegated", "not_installed");
    assert.equal(subscriptionBlocksSend(missing, missing), true);
  });

  it("lets a send through on a ready subscription, a local model or another subscription's card", () => {
    const ready = engine("claude-code", "delegated", "ready");
    assert.equal(subscriptionBlocksSend(ready, ready), false);
    const local = engine("ollama", "direct", "needs_login");
    assert.equal(subscriptionBlocksSend(local, local), false);
    assert.equal(subscriptionBlocksSend(claude, engine("codex", "delegated", "needs_login")), false);
    assert.equal(subscriptionBlocksSend(undefined, claude), false);
    assert.equal(subscriptionBlocksSend(claude, undefined), false);
  });

  it("finishes a turn locally only on a ready direct engine, with its first model that calls tools", () => {
    const engines = [
      engine("claude-code", "delegated", "ready", [model("opus", true)]),
      engine("bonsai", "direct", "not_running", [model("b", true)]),
      engine("ollama", "direct", "ready", [model("chat", false), model("coder", true), model("coder2", true)]),
    ];
    const local = localToolModel(engines);
    assert.equal(local?.engine.id, "ollama");
    assert.equal(local?.model.id, "coder");
    assert.equal(localToolModel([engine("ollama", "direct", "ready", [model("chat", false)])]), null);
    // OpenRouter is direct too, but billed per token: a signed-out subscription never sends a
    // turn there on its own.
    assert.equal(localToolModel([engine("openrouter", "direct", "ready", [model("or", true)])]), null);
  });

  it("offers the local finish only after the harness asked for a sign-in", () => {
    assert.equal(signInRequested([custom("run_started")]), false);
    assert.equal(signInRequested([custom("run_started"), custom("needs_signin")]), true);
  });
});

describe("whether the chat itself is working", () => {
  const base: ChatWorkInput = {
    status: "",
    run: null,
    activeRunId: null,
    busy: false,
    sending: false,
    answering: false,
    working: false,
    planWorking: false,
    revisingPlan: false,
    stopping: false,
    questionsWaiting: false,
    readingEntries: [],
  };

  it("works on its own send, a message on its way or being answered, a plan, a revision or a stop", () => {
    assert.equal(chatWorkState(base).chatWorking, false);
    for (const field of ["busy", "sending", "answering", "planWorking", "revisingPlan", "stopping"] as const)
      assert.equal(chatWorkState({ ...base, [field]: true }).chatWorking, true, field);
  });

  it("works on the harness's turn, but not a running build, a learning pass or a settled run's status", () => {
    assert.equal(chatWorkState({ ...base, working: true }).chatWorking, true);
    assert.equal(chatWorkState({ ...base, working: true, activeRunId: "run_a" }).chatWorking, false);
    const learning = chatWorkState({ ...base, working: true, status: "Self-improving from run_a" });
    assert.equal(learning.chatWorking, false);
    assert.equal(learning.learning, true);
    const settled = chatWorkState({
      ...base,
      working: true,
      status: "run run_a · Merging the parts",
      run: { runId: "run_a", state: "finished" } as ChatWorkInput["run"],
    });
    assert.equal(settled.chatWorking, false);
  });

  it("offers Rewind over a running build and the questions it waits on, never while the chat answers", () => {
    assert.equal(chatWorkState(base).answering, false);
    assert.equal(chatWorkState({ ...base, working: true, activeRunId: "run_a" }).answering, false, "a build");
    assert.equal(
      chatWorkState({ ...base, questionsWaiting: true, activeRunId: "run_a" }).answering,
      false,
      "a build's question: the rewind's Stop withdraws it",
    );
    for (const field of ["busy", "sending", "answering", "planWorking", "revisingPlan", "stopping"] as const)
      assert.equal(chatWorkState({ ...base, [field]: true }).answering, true, field);
    assert.equal(chatWorkState({ ...base, working: true }).answering, true, "the chat's own turn");
    assert.equal(chatWorkState({ ...base, working: true, questionsWaiting: true }).answering, true);
  });

  it("waits on a question only while something runs", () => {
    assert.equal(chatWorkState({ ...base, questionsWaiting: true }).chatWorking, false);
    assert.equal(chatWorkState({ ...base, questionsWaiting: true, activeRunId: "run_a" }).chatWorking, true);
  });

  it("folds the trailing work group into the busy line unless one of its tools failed", () => {
    const work = (state: string): ConversationEntry =>
      ({
        kind: "work",
        id: "w",
        items: [{ kind: "tool", id: "x", tool: { key: "x", icon: "run", label: "Run", state } }],
      }) as ConversationEntry;
    assert.equal(chatWorkState({ ...base, busy: true, readingEntries: [work("running")] }).currentDetails?.id, "w");
    assert.equal(chatWorkState({ ...base, busy: true, readingEntries: [work("failed")] }).currentDetails, null);
    assert.equal(chatWorkState({ ...base, readingEntries: [work("running")] }).currentDetails, null);
  });

  it("leaves the work in the transcript once a reply streams after it, where the reply will land", () => {
    const work: ConversationEntry = {
      kind: "work",
      id: "w",
      items: [{ kind: "tool", id: "x", tool: { key: "x", icon: "run", label: "Run", state: ToolState.Succeeded } }],
    };
    const streaming = chatWorkState({ ...base, busy: true, streamingReply: true, readingEntries: [work] });
    assert.equal(streaming.currentDetails, null);
    assert.equal(streaming.chatWorking, true, "the busy line stays, without the work folded in");
  });

  it("says Stopping, then Sending, then the waiting question, then the plan change, then the work", () => {
    const state = {
      stopping: false,
      sending: false,
      questionsWaiting: false,
      revisingPlan: false,
      current: "Reading the code",
    };
    assert.equal(busyLabel(state), "Reading the code");
    assert.equal(busyLabel({ ...state, sending: true, questionsWaiting: true }), "Sending");
    assert.equal(busyLabel({ ...state, sending: true, stopping: true }), "Stopping");
    assert.equal(busyLabel({ ...state, revisingPlan: true }), "Describe the changes you’d like to make");
    assert.equal(busyLabel({ ...state, revisingPlan: true, questionsWaiting: true }), "Waiting for your answer");
    assert.equal(busyLabel({ ...state, questionsWaiting: true, stopping: true }), "Stopping");
  });
});

describe("the plan under review", () => {
  const review = (state: PlanReviewRecord["state"]): PlanReviewRecord => ({ id: "p", state, text: "Build it" });

  it("waits for the user when it is shown or failed, and works while it is written or starting", () => {
    assert.deepEqual(
      (["generating", "waiting", "starting", "approved", "cancelled", "failed"] as const).map((state) => [
        state,
        planAwaitsAnswer(review(state)),
        planInProgress(review(state)),
      ]),
      [
        ["generating", false, true],
        ["waiting", true, false],
        ["starting", false, true],
        ["approved", false, false],
        ["cancelled", false, false],
        ["failed", true, false],
      ],
    );
    assert.equal(planAwaitsAnswer(null), false);
    assert.equal(planInProgress(null), false);
  });
});

describe("model keys", () => {
  it("join and split an engine and a model", () => {
    assert.equal(modelKey("ollama", "coder:7b"), `ollama${MODEL_KEY_SEPARATOR}coder:7b`);
    assert.deepEqual(parseModelKey("ollama::coder:7b"), { engine: "ollama", model: "coder:7b" });
    assert.deepEqual(parseModelKey("codex"), { engine: "codex", model: "" });
    assert.deepEqual(parseModelKey(null), { engine: "", model: "" });
  });
});

describe("the export notice", () => {
  it("names at most twelve included files", () => {
    const included = Array.from({ length: 14 }, (_, i) => `f${i}`);
    assert.equal(
      exportedWords({ files: 14, included, excluded: ["a"] }),
      `Exported 14 public files. Included: ${included.slice(0, 12).join(", ")} and 2 more. Excluded from selected roots: 1.`,
    );
    assert.equal(
      exportedWords({ files: 1, included: ["index.html"], excluded: [] }),
      "Exported 1 public files. Included: index.html. Excluded from selected roots: 0.",
    );
  });
});

describe("the export menu and its notice, per destination", () => {
  const shape = (kind: ProjectShape["kind"]) => ({ kind }) as ProjectShape;
  const cpp = (targets: BuildTarget[]): Pick<GameProject, "shape" | "destinations"> => ({
    shape: shape(ProjectKind.RaylibCpp),
    destinations: { stack: GameStack.RaylibCpp, targets },
  });

  it("a three.js game keeps its one export item: no destination list", () => {
    const threeJs = { shape: shape(ProjectKind.StudioTemplate) };
    for (const host of [StudioPlatform.Mac, StudioPlatform.Linux, null])
      assert.equal(exportDestinationsFor(threeJs, host), null, String(host));
  });

  it("a C++ game lists the destinations this host exports, in the create dialog's order", () => {
    const { Web, Mac, Windows, Linux } = BuildTarget;
    const cases: Array<[BuildTarget[], StudioPlatform | null, BuildTarget[]]> = [
      [[Mac, Web], StudioPlatform.Mac, [Web, Mac]],
      [[Web, Mac], StudioPlatform.Linux, [Web]],
      // Flipped (wave 6): a Mac cross-builds Windows and Linux with pinned tools, so it exports them.
      [[Web, Windows, Linux], StudioPlatform.Mac, [Web, Windows, Linux]],
      [[Mac], StudioPlatform.Mac, [Mac]],
      [[Mac], StudioPlatform.Windows, []],
      [[Web, Mac], null, [Web]],
    ];
    for (const [targets, host, offered] of cases)
      assert.deepEqual(exportDestinationsFor(cpp(targets), host), offered, `${targets} on ${host}`);
  });

  it("a game made for all four: a Mac offers every one, in order; Windows, Linux and an unknown host the browser folder only", () => {
    const { Web, Mac, Windows, Linux } = BuildTarget;
    const everywhere = cpp([Linux, Windows, Mac, Web]);
    assert.deepEqual(exportDestinationsFor(everywhere, StudioPlatform.Mac), [Web, Mac, Windows, Linux]);
    // A Linux host's lane has no pinned linux-x64 CMake and Ninja, and a Windows host's lane is off.
    for (const host of [StudioPlatform.Linux, StudioPlatform.Windows, null])
      assert.deepEqual(exportDestinationsFor(everywhere, host), [Web], String(host));
    assert.deepEqual(exportDestinationsFor(cpp([Windows, Linux]), StudioPlatform.Linux), [], "nothing to export here");
  });

  it("each destination has its label", () => {
    assert.equal(exportDestinationLabel(BuildTarget.Web), EXPORT_WORDS.browser);
    assert.equal(exportDestinationLabel(BuildTarget.Mac), EXPORT_WORDS.mac);
    assert.equal(exportDestinationLabel(BuildTarget.Windows), EXPORT_WORDS.windows);
    assert.equal(exportDestinationLabel(BuildTarget.Linux), EXPORT_WORDS.linux);
    assert.equal(exportDestinationLabel(BuildTarget.Windows), "Windows (.zip)");
    assert.equal(exportDestinationLabel(BuildTarget.Linux), "Linux (.tar.gz)");
  });

  it("names the Windows or Linux archive it made, and that it never ran there", () => {
    const desktop = { files: 9, included: ["game.exe"], excluded: [] };
    const windows = {
      ...desktop,
      dir: "/x/exports/pong-cross.windows",
      destination: BuildTarget.Windows,
      artifact: "/x/exports/pong-cross.windows/Pong everywhere-windows-x64.zip",
    };
    assert.equal(exportNotice(windows), EXPORT_WORDS.exportedWindows("Pong everywhere-windows-x64.zip"));
    assert.equal(
      exportNotice(windows),
      "Exported Pong everywhere-windows-x64.zip. Genex built it on this Mac but hasn’t run it on Windows.",
    );
    const linux = {
      ...desktop,
      dir: "/x/exports/pong-cross.linux",
      destination: BuildTarget.Linux,
      artifact: "/x/exports/pong-cross.linux/pong-cross-linux-x64.tar.gz",
    };
    assert.equal(exportNotice(linux), EXPORT_WORDS.exportedLinux("pong-cross-linux-x64.tar.gz"));
    const backslashes = { ...windows, artifact: "C:\\exports\\pong.windows\\Pong-windows-x64.zip" };
    assert.equal(exportNotice(backslashes), EXPORT_WORDS.exportedWindows("Pong-windows-x64.zip"), "a Windows path");
    const noArtifact = { ...desktop, dir: linux.dir, destination: BuildTarget.Linux };
    assert.equal(exportNotice(noArtifact), exportedWords(noArtifact), "no archive named: the files, as before");
  });

  it("names the Mac app it made, and counts the browser folder's files as before", () => {
    const web = { dir: "/x/exports/pong", files: 1, included: ["index.html"], excluded: [] };
    assert.equal(exportNotice(web), exportedWords(web));
    assert.equal(exportNotice({ ...web, destination: BuildTarget.Web }), exportedWords(web));
    const mac = {
      dir: "/x/exports/pong-mac",
      files: 3,
      included: ["Pong & Co.app/Contents/MacOS/game"],
      excluded: [],
      destination: BuildTarget.Mac,
      artifact: "/x/exports/pong-mac/Pong & Co.app",
    };
    assert.equal(exportNotice(mac), EXPORT_WORDS.exportedMac("Pong & Co"));
  });

  // Owner decision 2026-10-11: a browser game's code past its budget is exported with a warning.
  it("adds the slower-first-load warning after a browser export whose code is past its game's budget", () => {
    const web = { dir: "/x/exports/pond", files: 4, included: ["index.html"], excluded: [] };
    const over = {
      ...web,
      warnings: [
        {
          code: ExportWarningCode.WasmOverTarget,
          gzipBytes: 5 * WEB_BUDGET_MB_BYTES,
          budgetBytes: 4 * WEB_BUDGET_MB_BYTES,
        },
      ],
    };
    assert.equal(exportNotice(over), `${exportedWords(web)} ${EXPORT_WORDS.wasmOverTarget("5.0", "4")}`);
    assert.match(EXPORT_WORDS.wasmOverTarget("5.0", "4"), /slower .*phones/);
    assert.equal(exportNotice({ ...web, warnings: [] }), exportedWords(web), "no warning: as before");
  });
});

describe("the running build's lead screen", () => {
  const frame = (handle: string, at: number, over: Partial<AgentScreenFrame> = {}): AgentScreenFrame =>
    ({
      handle,
      label: handle,
      project: "kart",
      runId: "run_a",
      facetId: null,
      role: "director",
      at,
      ...over,
    }) as AgentScreenFrame;

  it("is the newest frame of this game's run whose role is the director", () => {
    const frames = [
      frame("old", 1),
      frame("builder", 9, { role: "builder" }),
      frame("other-run", 9, { runId: "run_b" }),
      frame("other-game", 9, { project: "golf" }),
      frame("new", 5),
      frame("tie", 5),
    ];
    assert.equal(leadFrameOf({ frames, trails: {} }, "kart", "run_a")?.handle, "new");
    assert.equal(leadFrameOf({ frames, trails: {} }, "kart", "run_c"), undefined);
    assert.equal(leadFrameOf({ frames, trails: {} }, null, "run_a"), undefined);
  });
});

describe("Compact now in the context panel", () => {
  it("is offered for every engine with a session, and for a local Ollama chat", () => {
    const cases: Array<[engine: string | null, supportsSessions: boolean | undefined, shown: boolean]> = [
      ["claude-code", true, true],
      ["codex", true, true],
      ["bonsai", true, true],
      ["ollama", false, true],
      ["ollama", undefined, true],
      ["some-api", false, false],
      ["some-api", undefined, false],
      [null, undefined, false],
    ];
    for (const [engine, supportsSessions, shown] of cases)
      assert.equal(
        compactControl({ engine, supportsSessions, compacting: false, busy: false }).shown,
        shown,
        `${engine} sessions=${supportsSessions}`,
      );
  });

  it("is disabled while it runs, and while a turn or a build is under way", () => {
    const at = (compacting: boolean, busy: boolean) =>
      compactControl({ engine: "claude-code", supportsSessions: true, compacting, busy }).disabled;
    assert.equal(at(false, false), false);
    assert.equal(at(true, false), true);
    assert.equal(at(false, true), true);
  });
});

describe("the composer's / commands", () => {
  it("opens only for a message that is a command being typed, with the caret at its end", () => {
    const cases: Array<[text: string, caret: number | null, query: string | null]> = [
      ["/", 1, ""],
      ["/com", 4, "com"],
      ["/COMPACT", 8, "compact"],
      ["/compact", 3, null],
      ["/compact now", 12, null],
      ["hello /compact", 14, null],
      [" /compact", 9, null],
      ["//", 2, null],
      ["/com\npact", 9, null],
      ["", 0, null],
      ["/compact", null, null],
    ];
    for (const [text, caret, query] of cases) assert.equal(commandQuery(text, caret), query, JSON.stringify(text));
  });

  it("lists the commands this chat offers whose names start with what was typed", () => {
    assert.deepEqual(commandMatches("", [ComposerCommand.Compact]), [ComposerCommand.Compact]);
    assert.deepEqual(commandMatches("comp", [ComposerCommand.Compact]), [ComposerCommand.Compact]);
    assert.deepEqual(commandMatches("x", [ComposerCommand.Compact]), []);
    assert.deepEqual(commandMatches("", []), [], "a chat that cannot compact offers no /compact");
  });
});
