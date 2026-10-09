/**
 * The host's half of a chat that runs builds: which sessions become the chat's bookmark, which a
 * run keeps to itself, when a run's wrap-up is asked, and how a lead's turn says it ended. Real
 * core, fake delegated engine, no harness.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { lastContractorSession } from "../../src/harness-seed/loop/chat-session.ts";
import { leadToolsNote, mainAgentReachNote } from "../../src/main/core/delegation-prompts.ts";
import { customRecord } from "../../src/shared/custom-events.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import type { ToolPermissionEvent } from "../../src/shared/permissions.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import {
  EngineError,
  type DelegateRequest,
  type DelegateResult,
  type PermissionAsk,
  type PermissionReply,
  type ScreenedCall,
} from "../../src/substrate/engines/types.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { makeFakePreview } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { gitFile } from "../helpers/git.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";

const ENGINE = "claude-code";
/** How long a mirrored record may take to land after its delegation answered. */
const MIRROR_WAIT_MS = 10_000;
const MIRROR_POLL_MS = 25;

type Api = Record<string, (params: unknown) => Promise<unknown>>;

/** How the fake session's turn ends: it answers, the user's Stop cuts it short, or it throws. */
type Ending = { answer: "ok" | "stopped" } | { throws: Error };
const ANSWERED: Ending = { answer: "ok" };

const lites: CoreLite[] = [];
after(async () => {
  for (const lite of lites) await lite.close();
});

/** A delegated engine that opens the session `next()` names and ends its turn the way it says. */
function sessionEngine(next: () => { sessionId: string; ending: Ending }, seen: DelegateRequest[] = []) {
  return {
    id: ENGINE,
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      const { sessionId, ending } = next();
      request.onEvent?.({ type: "system", payload: { subtype: "init", session_id: sessionId } });
      if ("throws" in ending) throw ending.throws;
      // A stop is an outcome, never a throw (`common.ts` `interruption`).
      const stopped = ending.answer === "stopped";
      return {
        ok: !stopped,
        engine: ENGINE,
        sessionId,
        turns: 1,
        usage: {},
        summary: "",
        ...(stopped ? { stopReason: "stopped", errorText: "stopped by you" } : {}),
      };
    },
  };
}

/** The session's mirrored init in the chat's log: it carries the delegation's scope. */
function initOf(events: readonly EventEnvelope[], sessionId: string): Record<string, unknown> | null {
  for (const event of events) {
    const custom = customRecord(event.data);
    const inner = custom?.payload.data as { session_id?: string } | undefined;
    if (custom?.event_type.startsWith("delegated.") && inner?.session_id === sessionId) return custom.payload;
  }
  return null;
}

/**
 * A worktree of `project` under the run's own folder in scratch, as a run's integration worktree
 * is — and, unless `recorded: false`, the run's start on the record of the game's own chat, as the
 * harness writes it when a run begins (`run_registered`).
 */
async function runWorktree(
  core: CoreLite["core"],
  project: { name: string; dir: string },
  runId: string,
  { name = "integration", recorded = true }: { name?: string; recorded?: boolean } = {},
) {
  const dir = path.join(core.layout.scratch, "autopilot", runId, name);
  await mkdir(path.dirname(dir), { recursive: true });
  core.snapshots.register({ name: project.name, dir: project.dir });
  await core.snapshots.worktreeAt(project.name, "HEAD", dir);
  if (recorded) await recordRun(core, project.name, runId);
  return dir;
}

/** A run's start on the record of `game`'s chat. */
async function recordRun(core: CoreLite["core"], game: string, runId: string) {
  const threadId = await core.threadForGame(game);
  await core.append(
    [{ type: "custom", event_type: "run_registered", payload: { runId, project: game, mode: "director" } }],
    threadId,
  );
}

/** A lead's delegation fields: read-only in the game folder, leading `root` of `runId`. */
function leadGrant(threadId: string, game: string, runId: string, root: string, chatSession = true) {
  return {
    readOnly: true,
    director: { runId, threadId, project: game, root, setup: null, tools: [], ...(chatSession ? { chatSession } : {}) },
  };
}

/** A game with its chat, and a delegation into it that returns once the session's init is logged. */
async function gameChat({ withPreview = false }: { withPreview?: boolean } = {}) {
  // The games root by its real path, as the rig does: on macOS the temp folder is reached through
  // the /var → /private/var link, and landing refuses a game whose path is not its real one.
  // Landing also shows the build in Live, so a test that lands brings a (fake) preview.
  const lite = await coreLite({
    gamesRoot: await realpath(await tmpDir("lead-sessions-games-")),
    ...(withPreview ? { preview: makeFakePreview() } : {}),
  });
  lites.push(lite);
  const { core } = lite;
  let next = { sessionId: "", ending: ANSWERED };
  const seen: DelegateRequest[] = [];
  core.engines.register(sessionEngine(() => next, seen) as never);
  const project = await core.games.scaffold("lead-sessions");
  const threadId = await core.threadForGame(project.name);
  const api = core.api() as unknown as Api;
  /** Delegate one turn; a turn meant to answer must, and a failing one hands back its error. */
  const delegate = async (sessionId: string, extra: Record<string, unknown>, ending: Ending = ANSWERED) => {
    next = { sessionId, ending };
    const failure = await api["engine.delegate"]!({
      engine: ENGINE,
      prompt: "go",
      project: project.name,
      threadId,
      ...extra,
    }).then(
      () => null,
      (err: unknown) => err,
    );
    if (failure && !("throws" in ending)) throw failure;
    const deadline = Date.now() + MIRROR_WAIT_MS;
    while (!initOf(await core.store.listEvents(threadId), sessionId)) {
      if (Date.now() > deadline) throw new Error(`the init of ${sessionId} never reached the chat`);
      await sleep(MIRROR_POLL_MS);
    }
    return failure;
  };
  const bookmark = async () =>
    ((await core.store.getRecord(threadId)).metadata as { contractor?: { sessionId?: string } } | undefined)?.contractor
      ?.sessionId;
  const harnessSession = async () =>
    lastContractorSession((await api["events.list"]!({ threadId })) as never, ENGINE)?.sessionId;
  return { core, api, project, threadId, delegate, bookmark, harnessSession, seen };
}

describe("a run's sessions never take the chat's bookmark", () => {
  it("records the chat's own sessions and none of a run's, in the record or in the harness's view", async () => {
    const { project, threadId, delegate, bookmark, harnessSession } = await gameChat();
    const game = project.name;
    const root = project.dir;

    await delegate("chat-1", {});
    assert.equal(await bookmark(), "chat-1", "a chat turn is the chat's session");
    // A chat build with eyes: a capture grant for the game folder, no run.
    await delegate("chat-2", { selfCapture: { project: game, root, label: game } });
    assert.equal(await bookmark(), "chat-2", "a chat build with a window is still the chat's session");
    assert.equal(await harnessSession(), "chat-2");

    const runSessions: Array<{ label: string; sessionId: string; extra: Record<string, unknown> }> = [
      {
        label: "the director",
        sessionId: "director-1",
        extra: { director: { runId: "run_x", threadId, project: game, root, setup: null, tools: [] } },
      },
      {
        label: "a run's builder",
        sessionId: "builder-1",
        extra: { selfCapture: { project: game, root, runId: "run_x", facetId: "prep", iteration: 0, label: "prep" } },
      },
      {
        label: "the scout",
        sessionId: "scout-1",
        extra: {
          playtest: {
            project: game,
            root,
            runId: "run_x",
            facetId: "scout",
            iteration: 0,
            role: "scout",
            label: "scout",
          },
          readOnly: true,
        },
      },
      {
        label: "the run's coordinator",
        sessionId: "coordinator-1",
        extra: { coordinator: { runId: "run_x" }, readOnly: true },
      },
    ];
    const seen: Array<{ label: string; bookmark: unknown; harness: unknown }> = [];
    for (const { label, sessionId, extra } of runSessions) {
      await delegate(sessionId, extra);
      seen.push({ label, bookmark: await bookmark(), harness: await harnessSession() });
    }
    assert.deepEqual(
      seen,
      runSessions.map(({ label }) => ({ label, bookmark: "chat-2", harness: "chat-2" })),
      "no run session overwrites the chat's bookmark, and none of their inits reads as the chat's session",
    );
  });
});

describe("a wrap-up asked after Resume is written again", () => {
  it("records one ask per session of the run, and none while it is paused", async () => {
    const { core, threadId } = await gameChat();
    const runId = "run_w";
    const record = (event_type: string, payload: Record<string, unknown>) =>
      core.append([{ type: "custom", event_type, payload }], threadId);
    const asks = async () =>
      (await core.store.listEvents(threadId)).filter((event) => {
        const custom = customRecord(event.data);
        return custom?.event_type === "run_control" && custom.payload.action === "finish";
      }).length;

    await record("run_started", { runId });
    await core.requestRunFinish(threadId, runId);
    await core.requestRunFinish(threadId, runId);
    assert.equal(await asks(), 1, "a running session is asked once");
    await record("run_finished", { runId, paused: true });
    await record("autopilot_paused", { runId });
    await assert.rejects(core.requestRunFinish(threadId, runId), "a paused run is never asked");
    await record("run_registered", { runId, resumed: true });
    await core.requestRunFinish(threadId, runId);
    assert.equal(await asks(), 2, "the resumed session never saw the first ask, so it is asked again");
    await core.requestRunFinish(threadId, runId);
    assert.equal(await asks(), 2, "and once");
  });
});

/** The phases one session's delegation reported, in order, with the scope of the last one. */
function activityOf(events: readonly EventEnvelope[], sessionId: string) {
  const delegationId = initOf(events, sessionId)?.delegationId;
  const reports = events.flatMap((event) => {
    const custom = customRecord(event.data);
    const mine = custom?.event_type === "session_activity" && custom.payload.delegationId === delegationId;
    return mine ? [custom.payload] : [];
  });
  const last = reports.at(-1);
  return {
    phases: reports.map((report) => report.phase),
    last: { phase: last?.phase, role: last?.role, runId: last?.runId },
  };
}

describe("a director's turn says it ended", () => {
  it("closes each turn with completed, interrupted or failed, and says nothing about the run", async () => {
    const { core, project, threadId, delegate } = await gameChat();
    const director = {
      director: { runId: "run_x", threadId, project: project.name, root: project.dir, setup: null, tools: [] },
    };
    const turns: Array<{ label: string; sessionId: string; ending: Ending; phase: string }> = [
      { label: "an answered turn", sessionId: "lead-ok", ending: ANSWERED, phase: "completed" },
      { label: "a turn the user stopped", sessionId: "lead-stop", ending: { answer: "stopped" }, phase: "interrupted" },
      { label: "a turn that threw", sessionId: "lead-throw", ending: { throws: new Error("boom") }, phase: "failed" },
      {
        label: "a turn aborted before it answered",
        sessionId: "lead-abort",
        ending: { throws: new EngineError(EngineFailureKind.Aborted, ENGINE, "stopped before it answered") },
        phase: "interrupted",
      },
    ];
    const seen: Array<{ label: string; last: unknown }> = [];
    for (const { label, sessionId, ending } of turns) {
      await delegate(sessionId, director, ending);
      seen.push({ label, last: activityOf(await core.store.listEvents(threadId), sessionId).last });
    }
    assert.deepEqual(
      seen,
      turns.map(({ label, phase }) => ({ label, last: { phase, role: "planner", runId: "run_x" } })),
    );
    const closes = (await core.store.listEvents(threadId)).filter((event) =>
      ["run_finished", "autopilot_paused"].includes(customRecord(event.data)?.event_type ?? ""),
    );
    assert.deepEqual(closes, [], "a lead's turn ending is not the run ending");
  });

  it("leaves a chat turn and a run's builder to end the way they always have", async () => {
    const { core, project, threadId, delegate } = await gameChat();
    await delegate("chat-turn", {});
    await delegate("builder-turn", {
      selfCapture: { project: project.name, root: project.dir, runId: "run_x", facetId: "b", iteration: 0 },
    });
    const events = await core.store.listEvents(threadId);
    for (const sessionId of ["chat-turn", "builder-turn"]) {
      const settled = activityOf(events, sessionId).phases.filter((phase) =>
        ["completed", "failed", "interrupted"].includes(String(phase)),
      );
      assert.deepEqual(settled, [], `${sessionId}: its turn ends with turn_ended or its run, not here`);
    }
  });
});

/**
 * One session: a waking run's lead is its chat's own session. It sits in the game folder (no
 * `cwd`), reads the run's integration worktree it leads (the grant's `root`) and writes nothing;
 * when it says it is the chat's (`chatSession`), the session it answers with is the chat's bookmark.
 */
describe("a lead that is its chat's own session", () => {
  it("is honoured in the game folder for its run's worktree, and moves the chat's bookmark only when it is the chat's", async () => {
    const { core, project, threadId, delegate, bookmark, seen } = await gameChat();
    const game = project.name;
    await delegate("chat-1", {});
    const worktree = { path: await runWorktree(core, project, "run_one") };
    const real = await realpath(worktree.path);
    const lead = (sessionId: string, chatSession: boolean) =>
      delegate(sessionId, {
        chatTurn: { messageId: "run_one" },
        ...leadGrant(threadId, game, "run_one", worktree.path, chatSession),
      });

    await lead("chat-1", true);
    const honoured = seen.at(-1)!;
    assert.equal(honoured.director?.root, real, "the grant is honoured in the game folder, on the real path checked");
    assert.equal(path.resolve(honoured.cwd), path.resolve(project.dir), "where the session sits");
    assert.equal(honoured.readOnly, true, "and writes nothing");
    assert.ok(
      (honoured.liveTools ?? []).some((tool) => tool.name === "look"),
      "its window and its tools are on the build it leads",
    );
    assert.ok((honoured.extraReads ?? []).includes(real), "which it may read");
    const runFolder = await realpath(path.dirname(worktree.path));
    assert.deepEqual(
      (honoured.extraReads ?? []).filter((dir) => isInside(dir, runFolder)),
      [],
      "and nothing else of its run's folder in scratch: not the whole of it, nor another worktree in it",
    );
    assert.equal(await bookmark(), "chat-1", "the chat's own session, resumed, is still its bookmark");

    await lead("lead-fresh", true);
    assert.equal(await bookmark(), "lead-fresh", "a fresh session of the chat's lead becomes its bookmark");
    await lead("lead-other", false);
    assert.equal(await bookmark(), "lead-fresh", "a lead that is not the chat's leaves the bookmark alone");
  });

  it("hands the window, the capture and the reads the real worktree it checked, never the name it was sent", async () => {
    const { core, project, threadId, delegate, seen } = await gameChat();
    const worktree = await runWorktree(core, project, "run_one");
    // A name for the worktree under the run's own folder: a link the harness's processes could repoint.
    const alias = path.join(path.dirname(worktree), "alias");
    await symlink(worktree, alias);
    await delegate("lead-alias", leadGrant(threadId, project.name, "run_one", alias));
    const request = seen.at(-1)!;
    const real = await realpath(worktree);
    assert.equal(request.director?.root, real, "the grant the engine gets names the real worktree");
    assert.ok((request.extraReads ?? []).includes(real), "which is what it may read");
    assert.ok(!(request.extraReads ?? []).includes(alias), "never the link");
  });

  it("drops the grant for a root that is not this game's worktree of that run, and records no bookmark", async () => {
    const { core, project, threadId, delegate, bookmark, seen } = await gameChat();
    const game = project.name;
    await delegate("chat-1", {});
    const ours = { path: await runWorktree(core, project, "run_one") };
    const other = await core.games.scaffold("lead-sessions-other");
    const theirs = { path: await runWorktree(core, other, "run_two") };
    // A worktree of this game planted in the other game's run (`snapshot.worktree` names any run id).
    const planted = await runWorktree(core, project, "run_two", { name: "planted", recorded: false });
    // A run of this game whose folder is a link to another run's folder.
    const autopilot = path.join(core.layout.scratch, "autopilot");
    await symlink(path.join(autopilot, "run_one"), path.join(autopilot, "run_link"));
    await recordRun(core, game, "run_link");
    // Links under this game's own run folder to places that are not a worktree of that run.
    await symlink(theirs.path, path.join(autopilot, "run_one", "to-theirs"));
    await symlink(project.dir, path.join(autopilot, "run_one", "to-live"));
    // A worktree of this game under a run nobody started.
    const unrecorded = await runWorktree(core, project, "run_ghost", { recorded: false });
    const hostile: Array<{ label: string; runId: string; root: string; extra?: Record<string, unknown> }> = [
      { label: "the game folder of another game", runId: "run_one", root: other.dir },
      { label: "another game's worktree under a run", runId: "run_two", root: theirs.path },
      { label: "this game's worktree named under another run", runId: "run_other", root: ours.path },
      { label: "a run id that climbs out", runId: "../../..", root: ours.path },
      { label: "a lead that sits in a build worktree", runId: "run_one", root: project.dir, extra: { cwd: ours.path } },
      { label: "this game's worktree planted under another game's run", runId: "run_two", root: planted },
      {
        label: "a run folder that is a link to another run's",
        runId: "run_link",
        root: path.join(autopilot, "run_link", "integration"),
      },
      {
        label: "a link in the run's folder to another game's worktree",
        runId: "run_one",
        root: path.join(autopilot, "run_one", "to-theirs"),
      },
      {
        label: "a link in the run's folder to the game folder",
        runId: "run_one",
        root: path.join(autopilot, "run_one", "to-live"),
      },
      { label: "a run the record never started", runId: "run_ghost", root: unrecorded },
      { label: "a lead that may write", runId: "run_one", root: ours.path, extra: { readOnly: false } },
    ];
    const seenGrants: Array<{ label: string; director: unknown; look: boolean; reads: string[]; bookmark: unknown }> =
      [];
    for (const [n, { label, runId, root, extra }] of hostile.entries()) {
      await delegate(`hostile-${n}`, { ...leadGrant(threadId, game, runId, root), ...extra });
      const request = seen.at(-1)!;
      seenGrants.push({
        label,
        director: request.director ?? null,
        look: (request.liveTools ?? []).some((tool) => tool.name === "look"),
        reads: (request.extraReads ?? []).filter((dir) => isInside(core.layout.scratch, dir)),
        bookmark: await bookmark(),
      });
    }
    assert.deepEqual(
      seenGrants,
      hostile.map(({ label }) => ({ label, director: null, look: false, reads: [], bookmark: "chat-1" })),
      "no grant, no window on it, nothing of scratch to read, and the chat's bookmark untouched",
    );
  });

  it("holds no lock on the game folder: its lock is on the build it leads", async () => {
    const { core, project, threadId, api } = await gameChat();
    const worktree = await runWorktree(core, project, "run_lock");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const leading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    core.engines.register({
      ...sessionEngine(() => ({ sessionId: "lock", ending: ANSWERED })),
      id: "codex",
      delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
        if (request.director) {
          entered();
          await held;
        }
        return { ok: true, engine: "codex", sessionId: "lock", turns: 1, usage: {}, summary: "" };
      },
    } as never);
    const ask = (extra: Record<string, unknown>) =>
      api["engine.delegate"]!({ engine: "codex", prompt: "go", project: project.name, threadId, ...extra }).then(
        () => "answered",
        // A refusal says why by its typed code (`DelegationRefusal`), else by its message.
        (err: { code?: string; message?: string }) => err.code ?? String(err.message),
      );
    const lead = ask(leadGrant(threadId, project.name, "run_lock", worktree));
    await leading;
    const listed = (await api["engine.delegations"]!({})) as Array<{ cwd: string }>;
    const chat = await ask({});
    const second = await ask(leadGrant(threadId, project.name, "run_lock", worktree));
    release();
    assert.equal(await lead, "answered");
    assert.deepEqual(
      { listed: listed.map((d) => d.cwd), chat, second },
      { listed: [await realpath(worktree)], chat: "answered", second: "folder_busy" },
      "a chat turn in the game folder goes on while the lead's turn runs; a second lead of that build waits its turn",
    );
  });
});

/** A git read in `cwd`, trimmed. */
const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();

/**
 * A run of this game's chat that is over: its run's worktree holds one commit the game folder
 * does not have (what the run built), and the close on the chat's record names it, unlanded.
 */
async function closedLoopRun(core: CoreLite["core"], project: { name: string; dir: string }, runId: string) {
  const worktree = await runWorktree(core, project, runId);
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await writeFile(path.join(worktree, "src", "sky.js"), "export const sky = 'dusk';\n");
  await git(worktree, ["add", "-A"]);
  await git(worktree, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "the sky"]);
  const built = await git(worktree, ["rev-parse", "HEAD"]);
  const threadId = await core.threadForGame(project.name);
  await core.append(
    [
      {
        type: "custom",
        event_type: "run_finished",
        payload: { runId, project: project.name, integrationHead: built, landed: false },
      },
    ],
    threadId,
  );
  return built;
}

/**
 * The same agent after the build: once a lead's run is over, the chat's own session — in the game
 * folder, its hands back — keeps the run's controls (`runControls`), answered by the host as the
 * coordinator's tools are. Nothing else is given them, and a control never reaches another run.
 */
describe("the chat's own session after a lead's run", () => {
  /** A delegated engine whose session calls `calls` while it holds its folder, and keeps each answer. */
  function controlsEngine(calls: Array<[string, Record<string, unknown>]>, seen: DelegateRequest[]) {
    const answers: Record<string, string> = {};
    const engine = {
      ...sessionEngine(() => ({ sessionId: "after", ending: ANSWERED })),
      id: "codex",
      delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
        seen.push(request);
        for (const [name, args] of calls) {
          if (!request.onLiveTool || !(request.liveTools ?? []).some((tool) => tool.name === name)) continue;
          answers[name] = await request.onLiveTool(name, args).then(
            (answer) => (typeof answer === "string" ? answer : answer.text),
            (err: Error) => `refused: ${err.message}`,
          );
        }
        return { ok: true, engine: "codex", sessionId: "after", turns: 1, usage: {}, summary: "" };
      },
    };
    return { engine, answers };
  }

  it("answers run_status, show_build and land_build for the session asking, whose own hold on the game folder is no contractor building there", async () => {
    const { core, api, project, threadId } = await gameChat({ withPreview: true });
    const built = await closedLoopRun(core, project, "run_after");
    const seen: DelegateRequest[] = [];
    const { engine, answers } = controlsEngine(
      [
        ["run_status", {}],
        ["land_build", {}],
      ],
      seen,
    );
    core.engines.register(engine as never);
    const ask = (extra: Record<string, unknown>) =>
      api["engine.delegate"]!({ engine: "codex", prompt: "go", project: project.name, threadId, ...extra });

    await ask({ runControls: { runId: "run_after", messageId: "m1" } });
    const names = (seen.at(-1)!.liveTools ?? []).map((tool) => tool.name);
    for (const tool of ["run_status", "show_build", "land_build"]) assert.ok(names.includes(tool), names.join(", "));
    for (const tool of ["steer_run", "finish_run", "resume_run", "continue_build"])
      assert.ok(!names.includes(tool), `${tool} is not a control it keeps live`);
    const status = JSON.parse(answers.run_status!) as { run: { state: string }; activeWorkers: unknown[] };
    assert.equal(status.run.state, "finished");
    assert.deepEqual(status.activeWorkers, [], "the session asking is not one of the run's workers");
    assert.match(answers.land_build!, /Landed [0-9a-f]{10} in the game folder \(merged\)/, answers.land_build);
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'dusk';\n");
    assert.equal(
      await git(project.dir, ["merge-base", "--is-ancestor", built, "HEAD"]).then(
        () => "in",
        () => "out",
      ),
      "in",
    );

    // A game folder with edits of its own is refused, as Make it live always refused it.
    const head = await git(project.dir, ["rev-parse", "HEAD"]);
    await writeFile(path.join(project.dir, "src", "sky.js"), "export const sky = 'pink';\n");
    await ask({ runControls: { runId: "run_after", messageId: "m2" } });
    assert.match(answers.land_build!, /^refused: .*uncommitted/, answers.land_build);
    assert.equal(await git(project.dir, ["rev-parse", "HEAD"]), head, "nothing merged over the edit");
    assert.equal(await readFile(path.join(project.dir, "src", "sky.js"), "utf8"), "export const sky = 'pink';\n");
  });

  it("gives them to nothing but the chat's own session, and a control never reaches another run", async () => {
    const { core, api, project, threadId } = await gameChat();
    const worktree = await runWorktree(core, project, "run_other");
    await closedLoopRun(core, project, "run_after");
    const head = await git(project.dir, ["rev-parse", "HEAD"]);
    const seen: DelegateRequest[] = [];
    const { engine, answers } = controlsEngine([["land_build", {}]], seen);
    core.engines.register(engine as never);
    const controls = { runControls: { runId: "run_after", messageId: "m1" } };
    const hostile: Array<{ label: string; extra: Record<string, unknown> }> = [
      { label: "a session in a build worktree", extra: { ...controls, cwd: worktree } },
      { label: "a read-only session", extra: { ...controls, readOnly: true } },
      {
        label: "a run's builder",
        extra: {
          ...controls,
          selfCapture: { project: project.name, root: project.dir, runId: "run_after", facetId: "sky", label: "sky" },
        },
      },
      { label: "a run's lead", extra: { ...controls, ...leadGrant(threadId, project.name, "run_other", worktree) } },
    ];
    const offered: Array<{ label: string; controls: string[] }> = [];
    for (const { label, extra } of hostile) {
      await api["engine.delegate"]!({ engine: "codex", prompt: "go", project: project.name, threadId, ...extra });
      const names = (seen.at(-1)!.liveTools ?? []).map((tool) => tool.name);
      offered.push({
        label,
        controls: names.filter((name) => ["run_status", "show_build", "land_build"].includes(name)),
      });
    }
    assert.deepEqual(
      offered,
      hostile.map(({ label }) => ({ label, controls: [] })),
      "no run control outside the chat's own session",
    );
    assert.equal(answers.land_build, undefined);

    // The chat's own session, naming a run that is not its chat's latest: refused, nothing landed.
    await api["engine.delegate"]!({
      engine: "codex",
      prompt: "go",
      project: project.name,
      threadId,
      runControls: { runId: "run_other", messageId: "m2" },
    });
    assert.match(answers.land_build!, /^refused: The run changed/, answers.land_build);
    assert.equal(await git(project.dir, ["rev-parse", "HEAD"]), head, "the game folder is where it was");
  });
});

/** What a build's lead or the run's coordinator reads when its chat was closed (archived). */
const CLOSED =
  "This chat was closed, so nobody can approve this and it was not allowed. Do not retry it; say in your reply what you needed.";

/**
 * A game chat whose engine asks (`permissionPrompts`), with a run of its run under way: its lead
 * leads the integration worktree from the game folder. The fake session asks the host once, when a
 * test gives it a question, and keeps the answer.
 */
async function leadChat({ leadAskTimeoutMs }: { leadAskTimeoutMs?: number } = {}) {
  /** What the host told the Studio UI, in order. */
  const uiEvents: Array<{ type: string }> = [];
  const lite = await coreLite({
    gamesRoot: await realpath(await tmpDir("lead-asks-games-")),
    ...(leadAskTimeoutMs ? { leadAskTimeoutMs } : {}),
    onUiEvent: (event) => uiEvents.push(event),
  });
  lites.push(lite);
  const { core } = lite;
  // No harness in a lite core: a dispatch reaches nothing, and a message is still the person's.
  core.host.dispatch = async () => undefined;
  const seen: DelegateRequest[] = [];
  let question: Omit<PermissionAsk, "toolUseId"> | null = null;
  let before: () => Promise<void> = async () => {};
  /** What each session does with its request once it runs, until a test says otherwise (`whileRunning`). */
  let during: (request: DelegateRequest) => Promise<void> = async () => {};
  let answer: PermissionReply | undefined;
  core.engines.register({
    ...sessionEngine(() => ({ sessionId: "lead", ending: ANSWERED })),
    permissionPrompts: true,
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      const asks = request.leadAsks ?? request.permissions;
      await before();
      await during(request);
      if (question && asks) answer = await asks.ask({ toolUseId: "tu", ...question }, new AbortController().signal);
      return { ok: true, engine: ENGINE, sessionId: "lead", turns: 1, usage: {}, summary: "" };
    },
  } as never);
  const project = await core.games.scaffold("lead-asks");
  const game = project.name;
  const threadId = await core.threadForGame(game);
  const api = core.api() as unknown as Api;
  const runId = "run_live";
  const worktree = await runWorktree(core, project, runId);
  const delegate = (extra: Record<string, unknown>, thread = threadId) =>
    api["engine.delegate"]!({ engine: ENGINE, prompt: "go", project: game, threadId: thread, ...extra });
  /** The run's lead answering its chat, as a waking lead is briefed. */
  const leadBrief = (thread = threadId, run = runId) => ({
    chatTurn: { messageId: run },
    ...leadGrant(thread, game, run, worktree),
  });
  const rows = async (): Promise<ToolPermissionEvent[]> =>
    (await core.store.listEvents(threadId)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === "tool_permission" ? [custom.payload as unknown as ToolPermissionEvent] : [];
    });
  /** A session briefed with `extra` asks `ask` once; `card` is the pending row it left, if any. */
  const asking = async (
    ask: Omit<PermissionAsk, "toolUseId" | "always"> & { always?: PermissionAsk["always"] },
    extra: Record<string, unknown> = leadBrief(),
    { waitForCard = false, first = async () => {} }: { waitForCard?: boolean; first?: () => Promise<void> } = {},
  ) => {
    const known = new Set((await rows()).map((row) => row.requestId));
    question = { always: [], ...ask };
    before = first;
    answer = undefined;
    const turn = delegate(extra).finally(() => {
      question = null;
      before = async () => {};
    });
    let card: ToolPermissionEvent | undefined;
    for (let waited = 0; waitForCard && !card && waited < 200; waited++) {
      card = (await rows()).find((row) => !known.has(row.requestId));
      if (!card) await sleep(MIRROR_POLL_MS);
    }
    const done = async () => {
      await turn;
      const added = (await rows()).filter((row) => !known.has(row.requestId));
      return { answer: answer!, rows: added };
    };
    return { card, done };
  };
  let sent = 0;
  /** The person sends a message in the chat, as the composer does. */
  const personSays = async (thread = threadId): Promise<string> => {
    const messageId = `msg-lead-${++sent}`;
    await core.sendUserMessage("Read what is on my Desktop", { thread, clientId: messageId, engine: ENGINE });
    return messageId;
  };
  /** The queue's records, as the harness writes them. */
  const queue = (messageId: string, event_type: string, extra: Record<string, unknown> = {}, thread = threadId) =>
    api["events.append"]!({
      threadId: thread,
      batch: [{ type: "custom", event_type, payload: { messageId, ...extra } }],
    });
  /** The person's message, handed to the run's lead (live chat): the queue's receipt. */
  const handToLead = async (messageId: string, into = runId) => {
    await queue(messageId, "coordinator_message_queued");
    await queue(messageId, "coordinator_message_delivered", { into, how: "lead" });
  };
  /** The lead heard it, once its turn returned (`run_steering_delivered`). */
  const heard = (messageId: string) =>
    api["events.append"]!({
      threadId,
      batch: [
        {
          type: "custom",
          event_type: "run_steering_delivered",
          payload: { runId, sourceMessageId: messageId, how: "lead" },
        },
      ],
    });
  return {
    core,
    api,
    project,
    game,
    threadId,
    runId,
    worktree,
    seen,
    delegate,
    leadBrief,
    asking,
    personSays,
    queue,
    handToLead,
    heard,
    uiEvents,
    rows,
    whileRunning: (does: typeof during) => {
      during = does;
    },
  };
}

/**
 * Whoever answers the person asks: while a build runs, the person's messages go to its lead (live
 * chat), and a lead or the run's coordinator answering them asks as the chat's own session would,
 * in the person's mode, whether or not the person is talking to it: a card nobody answers is
 * withdrawn after five minutes.
 */
describe("a build's lead and the run's coordinator ask the person they answer", () => {
  it("hands a way to ask only to the lead answering its chat and the coordinator of its run", async () => {
    const { core, api, game, threadId, worktree, runId, seen, delegate, leadBrief, personSays } = await leadChat();
    const said = await personSays();
    const other = await core.games.scaffold("lead-asks-other");
    const otherChat = await core.threadForGame(other.name);
    const secondChat = await core.store.createThread({
      title: "Second chat",
      metadata: { kind: "game", project: game },
    });
    const forged = String(await api["thread.create"]!({ title: "x" }));
    const cases: Array<{ label: string; extra: Record<string, unknown>; thread?: string; asks: boolean }> = [
      { label: "the lead answering its chat", extra: leadBrief(), asks: true },
      {
        label: "the run's coordinator answering a message",
        extra: { coordinator: { runId, messageId: said }, readOnly: true, timeoutMs: 300_000 },
        asks: true,
      },
      {
        label: "a coordinator answering a message the person never sent",
        extra: { coordinator: { runId, messageId: "m" }, readOnly: true, timeoutMs: 300_000 },
        asks: false,
      },
      { label: "a lead not answering its chat", extra: leadGrant(threadId, game, runId, worktree), asks: false },
      {
        label: "a director with its own hands",
        extra: { cwd: worktree, director: { runId, threadId, project: game, root: worktree, setup: null, tools: [] } },
        asks: false,
      },
      {
        label: "a run's builder",
        extra: {
          cwd: worktree,
          selfCapture: { project: game, root: worktree, runId, facetId: "sky", label: "sky" },
          timeoutMs: 60_000,
        },
        asks: false,
      },
      {
        label: "a worker",
        extra: { cwd: worktree, ownership: { facetId: "sky", owns: ["src/sky"], ownsMain: false }, timeoutMs: 60_000 },
        asks: false,
      },
      {
        label: "a playtester",
        extra: {
          playtest: {
            project: game,
            root: worktree,
            runId,
            facetId: "p",
            iteration: 0,
            role: "playtester",
            label: "p",
          },
          cwd: worktree,
          readOnly: true,
        },
        asks: false,
      },
      {
        label: "a coordinator of a run this chat never started",
        extra: { coordinator: { runId: "run_elsewhere", messageId: "m" }, readOnly: true },
        asks: false,
      },
      { label: "the lead in another chat of its game", extra: leadBrief(secondChat), thread: secondChat, asks: false },
      { label: "the lead in a thread the harness made", extra: leadBrief(forged), thread: forged, asks: false },
      { label: "the lead in another game's chat", extra: leadBrief(otherChat), thread: otherChat, asks: false },
    ];
    const handed: Array<{ label: string; asks: boolean; permissions: boolean; reachesMac: boolean }> = [];
    for (const { label, extra, thread } of cases) {
      await delegate(extra, thread);
      const request = seen.at(-1)!;
      handed.push({
        label,
        asks: Boolean(request.leadAsks),
        permissions: Boolean(request.permissions),
        // The chat's main agent: told it reaches the person's whole Mac, as the chat's own session is.
        reachesMac: request.prompt.includes(mainAgentReachNote()),
      });
    }
    assert.deepEqual(
      handed,
      cases.map(({ label, asks }) => ({ label, asks, permissions: false, reachesMac: asks })),
    );
    await core.store.updateThread(threadId, { metadata: { archived: true } });
    await delegate(leadBrief());
    assert.equal(seen.at(-1)!.leadAsks, undefined, "an archived chat asks nobody");
  });

  // Flipped: a lead nobody talked to was denied at once, with no card, so a
  // run's lead could not even run `ls`. The chat's mode alone decides now, as for the chat's own
  // session: Manual cards (withdrawn after five minutes), Bypass allows.
  it("asks in the person's mode whether or not they are talking to it", async () => {
    const { asking, personSays, handToLead, heard, core, threadId } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    const read = { tool: "Read", input: { file_path: "/Users/me/Desktop/notes.txt" } };
    const carded = async (label: string) => {
      const { card, done } = await asking(read, undefined, { waitForCard: true });
      assert.ok(card, `${label}: a card`);
      assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), true);
      assert.deepEqual((await done()).answer, { decision: "allow" }, label);
    };
    await carded("a run nobody talks to");
    const said = await personSays();
    await handToLead(said);
    await heard(said);
    await carded("after the lead heard the person");
    // Started in Manual, and the chat moved to Bypass since: allowed at once.
    const bypass = () => core.setPermissionMode(threadId, "bypassPermissions").then(() => {});
    assert.deepEqual(
      await (await asking(read, undefined, { first: bypass })).done(),
      { answer: { decision: "allow" }, rows: [] },
      "Bypass",
    );
  });

  it("answers for the person's mode: Bypass, Accept edits, Plan, Manual and Auto", async () => {
    const { core, project, threadId, asking, personSays, handToLead } = await leadChat();
    await handToLead(await personSays());
    const inGame = { tool: "Edit", input: { file_path: path.join(project.dir, "src", "main.js") } };
    const command = { tool: "Bash", input: { command: "ls ~/Downloads" } };
    const settled = async (ask: typeof command, answer: { decision: "allow" } | { decision: "deny" }) => {
      const { card, done } = await asking(ask, undefined, { waitForCard: true });
      assert.ok(card, `${ask.tool}: a card`);
      assert.equal(core.answerPermission(card.requestId, answer), true);
      return done();
    };

    // Flipped: a Bypass chat's lead ran in Manual and the host allowed every
    // question. It runs in Bypass now, as the chat's own session, so a question that still reaches
    // the host is one of Claude Code's checks no mode skips (a dangerous `rm`): a card, as the
    // chat's own session's. A lead started in another mode whose chat moved to Bypass is allowed.
    await core.setPermissionMode(threadId, "bypassPermissions");
    const bypassed = await settled({ tool: "Bash", input: { command: "rm -rf ~" } }, { decision: "deny" });
    assert.deepEqual(bypassed.answer, { decision: "deny" }, "Bypass: the person's answer");
    await core.setPermissionMode(threadId, "default");
    const moved = () => core.setPermissionMode(threadId, "bypassPermissions").then(() => {});
    assert.deepEqual(
      await (await asking(command, undefined, { first: moved })).done(),
      { answer: { decision: "allow" }, rows: [] },
      "moved to Bypass: allowed",
    );

    // Flipped: the lead's edit in the game folder was refused
    // in every mode. What Claude Code asks about it is the person's to answer now, like any call.
    await core.setPermissionMode(threadId, "acceptEdits");
    const edited = await settled(inGame as never, { decision: "allow" });
    assert.deepEqual(edited.answer, { decision: "allow" }, "an edit in the game asks like any other");
    const outside = await settled({ tool: "Write", input: { file_path: "/Users/me/Desktop/notes.txt" } } as never, {
      decision: "allow",
    });
    assert.deepEqual(outside.answer, { decision: "allow" }, "an edit outside the game asks");
    const accepted = await settled(command, { decision: "allow" });
    assert.deepEqual(accepted.answer, { decision: "allow" }, "a command asks in Accept edits");
    assert.deepEqual(
      accepted.rows.map((row) => [row.state, row.by]),
      [
        ["pending", undefined],
        ["allowed", "user"],
      ],
    );

    await core.setPermissionMode(threadId, "plan");
    const planned = await (await asking(command)).done();
    assert.equal(planned.answer.decision, "deny");
    assert.match((planned.answer as { message: string }).message, /Plan mode/);
    assert.deepEqual(planned.rows, []);

    for (const mode of ["default", "auto"] as const) {
      await core.setPermissionMode(threadId, mode);
      const { answer } = await settled(command, { decision: "deny" });
      assert.deepEqual(answer, { decision: "deny" }, `${mode}: the person's deny`);
    }
  });

  // This fake session never hands over a live control, so the picker cannot switch it: what a lead
  // whose switch fails does (the picker switches one that can: "the picker switches a lead's running session").
  it("starts in the chat's Auto or Accept edits, and asks first once the chat leaves it where it cannot be switched", async () => {
    const { core, project, threadId, seen, delegate, leadBrief } = await leadChat();
    const command = { tool: "Bash", input: { command: "ls ~/Downloads" } };
    await core.setPermissionMode(threadId, "default");
    await delegate(leadBrief());
    const manual = seen.at(-1)!.leadAsks!;
    assert.equal(manual.mode, "default", "Manual: the host answers each question");
    await core.setPermissionMode(threadId, "auto");
    assert.equal(await manual.screen(command), null, "a session started in Manual keeps asking");
    for (const [mode, started] of [
      ["plan", "default"],
      ["bypassPermissions", "bypassPermissions"],
    ] as const) {
      await core.setPermissionMode(threadId, mode);
      await delegate(leadBrief());
      assert.equal(seen.at(-1)!.leadAsks!.mode, started, `${mode}: from Manual, the host answering for the mode`);
    }

    await core.setPermissionMode(threadId, "acceptEdits");
    await delegate(leadBrief());
    const accepting = seen.at(-1)!.leadAsks!;
    assert.equal(accepting.mode, "acceptEdits", "Accept edits: its edits go on without asking, as the chat's own");
    assert.equal(await accepting.screen(command), null, "while the chat stays in Accept edits");
    // Accept edits to Auto: its edits go on, and what it asks is carded; asking first would card
    // its edits too.
    await core.setPermissionMode(threadId, "auto");
    assert.equal(await accepting.screen(command), null, "moved to Auto: no question first");
    await core.setPermissionMode(threadId, "default");
    assert.deepEqual(await accepting.screen(command), {
      askFirst: true,
      reason: "The chat switched from Accept edits to Manual.",
    });

    await core.setPermissionMode(threadId, "auto");
    await delegate(leadBrief());
    const auto = seen.at(-1)!.leadAsks!;
    assert.equal(auto.mode, "auto", "Auto: Claude Code's classifier decides");
    assert.equal(await auto.screen(command), null, "while the chat stays in Auto");
    for (const [mode, label] of [
      ["default", "Manual"],
      ["acceptEdits", "Accept edits"],
      ["plan", "Plan"],
      ["bypassPermissions", "Bypass permissions"],
    ] as const) {
      await core.setPermissionMode(threadId, mode);
      assert.deepEqual(
        await auto.screen(command),
        { askFirst: true, reason: `The chat switched from Auto to ${label}.` },
        `${mode}: asked first, so the chat's mode now answers`,
      );
    }
    await core.setPermissionMode(threadId, "auto");
    // Flipped: an edit in the game folder was refused here.
    const game = { tool: "Edit", input: { file_path: path.join(project.dir, "src", "main.js") } };
    assert.equal(await auto.screen(game), null, "an edit in the game is the classifier's, as any call");
  });

  it("keeps what 'always' grants for the game and the chat, never a mode", async () => {
    const { core, threadId, asking, personSays, handToLead, seen, delegate, leadBrief, game } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    await handToLead(await personSays());
    const always: PermissionAsk["always"] = [
      { kind: "rule", rule: "Bash(ls *)", scope: "game" },
      { kind: "directory", path: "/Users/me/Desktop" },
      { kind: "mode", mode: "bypassPermissions" },
    ];
    const { card, done } = await asking({ tool: "Bash", input: { command: "ls ~/Desktop" }, always }, undefined, {
      waitForCard: true,
    });
    assert.deepEqual(card?.always, always.slice(0, 2), "a lead's card never offers a mode");
    assert.equal(core.answerPermission(card!.requestId, { decision: "always" }), true);
    assert.deepEqual((await done()).answer, { decision: "always" });
    assert.equal((await core.store.getRecord(threadId)).metadata?.permissionMode, "default", "the mode stands");
    await delegate(leadBrief());
    const next = seen.at(-1)!.leadAsks!;
    assert.deepEqual(next.allow, ["Bash(ls *)"], "the game's rule stands for its next turn");
    assert.deepEqual(next.directories, ["/Users/me/Desktop"], "and the chat's folder");
    assert.deepEqual((await core.permissionSettings()).rules.find((r) => r.project === game)?.rules, ["Bash(ls *)"]);
  });

  it("withdraws a card nobody answered in time, in its own words", async () => {
    const { core, threadId, asking, personSays, handToLead } = await leadChat({ leadAskTimeoutMs: 50 });
    await core.setPermissionMode(threadId, "default");
    await handToLead(await personSays());
    const { answer, rows } = await (await asking({ tool: "Bash", input: { command: "ls ~/Downloads" } })).done();
    assert.deepEqual(answer, {
      decision: "deny",
      withdrawn: true,
      message:
        "Nobody answered within 5 minutes, so this was not allowed. Do not retry it; say in your reply what you needed.",
    });
    assert.deepEqual(
      rows.map((row) => [row.state, row.by]),
      [
        ["pending", undefined],
        ["denied", "timeout"],
      ],
    );
  });

  it("the coordinator asks in the chat's mode, while it answers the person's message and after", async () => {
    const { core, threadId, runId, asking, personSays, queue, delegate, seen } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    const message = await personSays();
    await queue(message, "coordinator_message_queued");
    await queue(message, "coordinator_message_processing");
    const coordinator = {
      coordinator: { runId, messageId: message },
      readOnly: true,
      timeoutMs: 300_000,
      chatTurn: { messageId: message },
    };
    const command = { tool: "Bash", input: { command: "ls ~/Desktop" } };
    const { card, done } = await asking(command, coordinator, { waitForCard: true });
    assert.ok(card, "a card in the chat");
    core.answerPermission(card.requestId, { decision: "allow" });
    assert.deepEqual((await done()).answer, { decision: "allow" });
    // Flipped: once its message was handled, its question was denied at once,
    // with no card. The chat's mode decides it now, for as long as the session runs.
    const handled = () => queue(message, "coordinator_message_handled").then(() => {});
    const after = await asking(command, coordinator, { waitForCard: true, first: handled });
    assert.ok(after.card, "still a card: the chat's mode decides");
    core.answerPermission(after.card.requestId, { decision: "allow" });
    assert.deepEqual((await after.done()).answer, { decision: "allow" });
    // Its seat is a message the host noted as the person's and not yet answered, as the chat's own
    // session's: a coordinator started for one already handled runs unattended.
    await delegate(coordinator);
    assert.equal(seen.at(-1)!.leadAsks, undefined, "no seat without the person's message");
  });

  it("a message handed to the lead never makes the chat's own session ask, heard or not", async () => {
    const { seen, delegate, personSays, handToLead, heard } = await leadChat();
    const own = await personSays();
    await delegate({ chatTurn: { messageId: own } });
    assert.ok(seen.at(-1)!.permissions, "the chat's own session answering the person asks");
    const handed = await personSays();
    await handToLead(handed);
    await delegate({ chatTurn: { messageId: handed } });
    assert.equal(seen.at(-1)!.permissions, undefined, "the lead's message is the lead's");
    await heard(handed);
    await delegate({ chatTurn: { messageId: handed } });
    assert.equal(seen.at(-1)!.permissions, undefined, "and once heard it is nobody's");
  });

  it("an archived chat's lead asks nobody, even mid-turn", async () => {
    const { core, threadId, asking, personSays, handToLead } = await leadChat();
    await core.setPermissionMode(threadId, "bypassPermissions");
    await handToLead(await personSays());
    const archive = () => core.store.updateThread(threadId, { metadata: { archived: true } }).then(() => {});
    const { answer, rows } = await (
      await asking({ tool: "Bash", input: { command: "ls" } }, undefined, { first: archive })
    ).done();
    assert.deepEqual({ answer, rows }, { answer: { decision: "deny", withdrawn: true, message: CLOSED }, rows: [] });
  });
});

/**
 * A running session's live control, as the engine hands it over (`onControl`): it records each mode
 * it is switched to, refuses while `refusing` says so, holds a switch to a mode `holding` names until
 * it is let go, and holds its session open until `end()`.
 */
function heldSession() {
  const modes: string[] = [];
  /** Every switch asked for, as the CLI hears it, before it lands. */
  const asked: string[] = [];
  let refuse: ((mode: string) => string | null) | null = null;
  const held = new Map<string, Promise<void>>();
  let ready!: () => void;
  let end!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const control = {
    setMode: async (mode: string) => {
      asked.push(mode);
      await held.get(mode);
      const code = refuse?.(mode);
      if (code) throw Object.assign(new Error("refused"), { code });
      modes.push(mode);
    },
  };
  /** Hand the session's control to the host, and hold the session until `end()`. */
  const run = async (request: DelegateRequest) => {
    (request.leadAsks ?? request.permissions)!.onControl!(control as never);
    ready();
    await ended;
  };
  return {
    modes,
    asked,
    started,
    run,
    end,
    refusing: (codeFor: typeof refuse) => {
      refuse = codeFor;
    },
    /** A switch to `mode` waits until the answer is called: a CLI slow to switch. */
    holding: (mode: string): (() => void) => {
      let letGo!: () => void;
      held.set(
        mode,
        new Promise<void>((resolve) => {
          letGo = resolve;
        }),
      );
      return letGo;
    },
  };
}

/**
 * The composer's picker reached only the chat's own session. A lead or the run's coordinator took the
 * chat's mode when its session started: started in Manual it went on carding once the chat moved to
 * Auto or Accept edits, and started in another mode its screen asked first for every call once the
 * chat left it, until its next session. The picker switches a running lead now, as the chat's own
 * session, beside it on the same chat; only a lead whose switch fails asks first.
 */
describe("the picker switches a lead's running session", () => {
  const command = { tool: "Bash", input: { command: "ls ~/Downloads" } };

  it("switches the lead, the coordinator and the chat's own session on one chat, each to its mode for the chat's", async () => {
    const { core, threadId, runId, delegate, leadBrief, personSays, queue, whileRunning, seen } = await leadChat();
    // Started in Auto, a lead that was not switched would ask first while the chat is elsewhere.
    await core.setPermissionMode(threadId, "auto");
    const lead = heldSession();
    const coordinator = heldSession();
    const chat = heldSession();
    whileRunning(async (request) => {
      const held = request.coordinator ? coordinator : request.leadAsks ? lead : chat;
      await held.run(request);
    });
    const turns = [delegate(leadBrief())];
    await lead.started;
    const asked = await personSays();
    await queue(asked, "coordinator_message_queued");
    await queue(asked, "coordinator_message_processing");
    turns.push(
      delegate({
        coordinator: { runId, messageId: asked },
        readOnly: true,
        timeoutMs: 300_000,
        chatTurn: { messageId: asked },
      }),
    );
    await coordinator.started;
    turns.push(delegate({ chatTurn: { messageId: await personSays() } }));
    await chat.started;
    const leadAsks = seen.find((request) => request.leadAsks && !request.coordinator)!.leadAsks!;
    const coordinatorAsks = seen.find((request) => request.coordinator)!.leadAsks!;
    assert.ok(
      seen.some((request) => request.permissions),
      "the chat's own session runs beside them",
    );
    assert.deepEqual([leadAsks.mode, coordinatorAsks.mode], ["auto", "auto"]);

    for (const mode of ["acceptEdits", "plan", "default", "bypassPermissions", "auto"] as const) {
      await core.setPermissionMode(threadId, mode);
      for (const [label, asks] of [
        ["lead", leadAsks],
        ["coordinator", coordinatorAsks],
      ] as const)
        assert.equal(await asks.screen(command), null, `${mode}: the ${label} runs in it, so nothing asks first`);
    }
    assert.deepEqual(chat.modes, ["acceptEdits", "plan", "default", "bypassPermissions", "auto"]);
    // Plan is Manual for a lead, the host denying for the chat's mode (a build is approved work); a
    // session already in the mode it needs is left alone.
    const leadModes = ["acceptEdits", "default", "bypassPermissions", "auto"];
    assert.deepEqual(lead.modes, leadModes, "the lead follows the picker");
    assert.deepEqual(coordinator.modes, leadModes, "and so does the coordinator");

    // The chat's own session that will not switch is still the picker's to show, lead or no lead.
    chat.refusing(() => "unreachable");
    await assert.rejects(core.setPermissionMode(threadId, "acceptEdits"), /next message/);
    assert.equal(lead.modes.at(-1), "acceptEdits", "the lead switched all the same");
    chat.refusing(null);

    // The chat's own turn ends while the build goes on: the lead is still the picker's.
    chat.end();
    await turns[2];
    await core.setPermissionMode(threadId, "default");
    assert.equal(lead.modes.at(-1), "default", "the lead outlives the chat's own session in the picker's reach");
    assert.equal(coordinator.modes.at(-1), "default");
    assert.equal(chat.modes.at(-1), "auto", "a session that ended is not switched");

    lead.end();
    await turns[0];
    await core.setPermissionMode(threadId, "acceptEdits");
    assert.equal(lead.modes.at(-1), "default", "nor is a lead whose session ended");
    assert.equal(coordinator.modes.at(-1), "acceptEdits", "the session still running is");
    coordinator.end();
    await Promise.all(turns);
  });

  it("switches a lead one pick after another, asking first while a switch is on its way", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning, seen } = await leadChat();
    await core.setPermissionMode(threadId, "auto");
    const lead = heldSession();
    whileRunning(lead.run);
    const turn = delegate(leadBrief());
    await lead.started;
    const asks = seen.at(-1)!.leadAsks!;
    const until = async (done: () => Promise<boolean> | boolean) => {
      for (let waited = 0; !(await done()) && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
    };
    // The person picks Accept edits, and Manual before the CLI has switched to the first.
    const letGo = lead.holding("acceptEdits");
    const first = core.setPermissionMode(threadId, "acceptEdits");
    await until(() => lead.asked.includes("acceptEdits"));
    const second = core.setPermissionMode(threadId, "default");
    // The second pick is saved, and has reached the lead's switch, before the first lands.
    await until(async () => (await core.permissionSettings()).defaultMode === "default");
    await sleep(MIRROR_POLL_MS);
    assert.deepEqual(lead.asked, ["acceptEdits"], "the second switch waits for the first");
    assert.deepEqual(
      await asks.screen(command),
      { askFirst: true, reason: "The chat switched from Auto to Manual." },
      "still in Auto: the chat's mode answers until the switch lands",
    );
    // And a third pick before either lands: a switch still waiting goes where the chat is by then.
    const third = core.setPermissionMode(threadId, "acceptEdits");
    await until(async () => (await core.permissionSettings()).defaultMode === "acceptEdits");
    await sleep(MIRROR_POLL_MS);
    letGo();
    await Promise.all([first, second, third]);
    assert.deepEqual(lead.modes, ["acceptEdits"], "Manual, picked and left before its turn, is never switched to");
    assert.equal(await asks.screen(command), null, "it ends where the last pick left it");
    lead.end();
    await turn;
  });

  it("leaves a lead that will not switch where it runs, asking first while the chat is elsewhere", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning, seen } = await leadChat();
    await core.setPermissionMode(threadId, "auto");
    const lead = heldSession();
    whileRunning(lead.run);
    const turn = delegate({ ...leadBrief(), model: "claude-lead" });
    await lead.started;
    const asks = seen.at(-1)!.leadAsks!;
    lead.refusing((mode) => (mode === "auto" ? "auto_unavailable" : "unreachable"));
    // The chat's mode stands, and the lead's calls follow it through its screen: its failure is
    // never the picker's to show.
    await core.setPermissionMode(threadId, "default");
    assert.deepEqual(await asks.screen(command), { askFirst: true, reason: "The chat switched from Auto to Manual." });

    lead.refusing((mode) => (mode === "auto" ? "auto_unavailable" : null));
    await core.setPermissionMode(threadId, "acceptEdits");
    assert.deepEqual(lead.modes, ["acceptEdits"]);
    assert.equal(await asks.screen(command), null, "switched: Accept edits decides");
    const view = await core.setPermissionMode(threadId, "auto");
    assert.ok(view.autoUnavailable.includes("claude-lead"), "Auto refused for the lead's model is shown");
    assert.deepEqual(lead.modes, ["acceptEdits"], "it stays in Accept edits");
    assert.equal(await asks.screen(command), null, "Accept edits to Auto: its edits go on, what it asks is carded");
    lead.end();
    await turn;
  });

  // An answer on the chat's own card moved the chat's mode (a plan approved, "always" with a mode)
  // and the lead's session stayed in the mode it ran in.
  it("follows a mode the chat takes from its own session's card: a plan approved, 'always' with a mode", async () => {
    const { core, game, project, threadId, delegate, leadBrief, whileRunning, rows } = await leadChat();
    await core.setPermissionMode(threadId, "plan");
    const lead = heldSession();
    whileRunning(lead.run);
    const turn = delegate(leadBrief());
    await lead.started;
    /** The chat's own session asks, and the person answers the card with `answer`. */
    const answered = async (ask: Omit<PermissionAsk, "toolUseId">, answer: Record<string, unknown>) => {
      const known = new Set((await rows()).map((row) => row.requestId));
      const asking = core.askToolPermission(game, threadId, { toolUseId: "tu", ...ask });
      let card: ToolPermissionEvent | undefined;
      for (let waited = 0; !card && waited < 200; waited++) {
        card = (await rows()).find((row) => !known.has(row.requestId));
        if (!card) await sleep(MIRROR_POLL_MS);
      }
      assert.equal(core.answerPermission(card!.requestId, answer), true);
      await asking;
    };
    const switched = async (count: number) => {
      for (let waited = 0; lead.modes.length < count && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
      return [...lead.modes];
    };
    await answered(
      { tool: "ExitPlanMode", input: { plan: "1. Jump" }, always: [] },
      { decision: "approve_plan", mode: "auto" },
    );
    assert.deepEqual(await switched(1), ["auto"], "the plan approved into Auto");
    const edit = { tool: "Edit", input: { file_path: path.join(project.dir, "src", "main.js") } };
    await answered({ ...edit, always: [{ kind: "mode", mode: "acceptEdits" }] }, { decision: "always" });
    assert.deepEqual(await switched(2), ["auto", "acceptEdits"], "'always' allowing all edits");
    lead.end();
    await turn;
  });

  // A call screened while the switch to Bypass was on its way was asked about first, and the CLI's
  // question for it, once the session ran in Bypass, read as Claude Code's own check: carded.
  it("answers for Bypass a call it asked first while its switch to Bypass landed", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning, seen } = await leadChat();
    await core.setPermissionMode(threadId, "auto");
    const lead = heldSession();
    whileRunning(lead.run);
    const turn = delegate(leadBrief());
    await lead.started;
    const asks = seen.at(-1)!.leadAsks!;
    const letGo = lead.holding("bypassPermissions");
    const picked = core.setPermissionMode(threadId, "bypassPermissions");
    for (let waited = 0; !lead.asked.includes("bypassPermissions") && waited < 200; waited++)
      await sleep(MIRROR_POLL_MS);
    assert.deepEqual(await asks.screen({ ...command, toolUseId: "tu_first" }), {
      askFirst: true,
      reason: "The chat switched from Auto to Bypass permissions.",
    });
    letGo();
    await picked;
    const answer = await Promise.race([
      asks.ask({ toolUseId: "tu_first", ...command, always: [] }, new AbortController().signal),
      sleep(MIRROR_WAIT_MS).then(() => "carded"),
    ]);
    assert.deepEqual(answer, { decision: "allow" }, "the host's own question, answered for the chat's Bypass");
    lead.end();
    await turn;
  });

  it("tells the picker when the switch a lead's start owes finds Auto unavailable", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning, uiEvents } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    const lead = heldSession();
    lead.refusing((mode) => (mode === "auto" ? "auto_unavailable" : null));
    let picked = 0;
    whileRunning(async (request) => {
      await core.setPermissionMode(threadId, "auto");
      picked = uiEvents.length;
      await lead.run(request);
    });
    const turn = delegate({ ...leadBrief(), model: "claude-lead" });
    await lead.started;
    const told = () => uiEvents.slice(picked).some((event) => event.type === "permissions.changed");
    for (let waited = 0; !told() && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
    assert.ok(told(), "the picker hears it");
    assert.ok((await core.permissionSettings()).autoUnavailable.includes("claude-lead"));
    lead.end();
    await turn;
  });

  it("applies a pick made while the lead's session starts once its control arrives", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning, seen } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    const lead = heldSession();
    whileRunning(async (request) => {
      await core.setPermissionMode(threadId, "acceptEdits");
      await lead.run(request);
    });
    const turn = delegate(leadBrief());
    await lead.started;
    const asks = seen.at(-1)!.leadAsks!;
    assert.equal(asks.mode, "default", "it started in Manual");
    for (let waited = 0; !lead.modes.length && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
    assert.deepEqual(lead.modes, ["acceptEdits"]);
    assert.equal(await asks.screen(command), null);
    lead.end();
    await turn;
  });
});

/** A plugin tool and a connector tool, as their registries hand them to a session. */
const PLUGIN_TOOL = {
  name: "fixture__deliver",
  description: "Deliver an asset",
  parameters: { type: "object", properties: {} },
};
const CONNECTOR_TOOL = {
  name: "notes__lookup",
  description: "Look up a note",
  parameters: { type: "object", properties: {} },
  inputSchema: { type: "object", properties: {} },
};
const PLUGIN_GUIDANCE = "[PLUGINS] fixture__deliver delivers an asset into the game.";
const CONNECTOR_GUIDANCE = "[CONNECTORS] notes__* looks up the person's notes.";

/** One call a plugin or connector tool answered, with the binding the host gave it. */
interface HostToolCall {
  tool: string;
  binding: { project?: string; directory?: string; threadId?: string };
}

/**
 * The plugin and connector registries, stood in for at their boundary: each offers one tool, and a
 * call records the binding it carried, then answers as `answers` says (by default at once).
 */
function standInHostTools(core: CoreLite["core"]) {
  const calls: HostToolCall[] = [];
  const answers = {
    plugin: async (_binding: HostToolCall["binding"], _signal?: AbortSignal): Promise<unknown> => "delivered",
    connector: async (_signal: AbortSignal): Promise<unknown> => "found",
    connectorAllowed: true,
  };
  core.plugins.snapshot = (() => ({
    tools: [PLUGIN_TOOL],
    guidance: PLUGIN_GUIDANCE,
    applied: { plugins: ["fixture"], skills: [] },
  })) as never;
  core.plugins.tool = (async (tool: string, _args: unknown, binding: HostToolCall["binding"], signal?: AbortSignal) => {
    calls.push({ tool, binding: { ...binding } });
    return answers.plugin(binding, signal);
  }) as never;
  core.mcp.toolsFor = (async () => [CONNECTOR_TOOL]) as never;
  core.mcp.owns = ((name: string) => name === CONNECTOR_TOOL.name) as never;
  core.mcp.guidance = ((tools?: Array<{ name: string }>) => (tools?.length ? CONNECTOR_GUIDANCE : "")) as never;
  core.mcp.tool = (async (tool: string, _args: unknown, binding: HostToolCall["binding"], signal: AbortSignal) => {
    calls.push({ tool, binding: { ...binding } });
    return answers.connector(signal);
  }) as never;
  // The person saved "always allow" for the connector's tool, so it runs without a card of its own.
  core.mcp.toolAutoApproved = (async () => answers.connectorAllowed) as never;
  return { calls, answers };
}

/** The host tools a session was offered, by name. */
const offered = (request: DelegateRequest) =>
  (request.liveTools ?? [])
    .map((tool) => tool.name)
    .filter((name) => name === PLUGIN_TOOL.name || name === CONNECTOR_TOOL.name);

/**
 * A lead's brief is `readOnly`: the harness's mark of a director seated in its game's folder
 * (`#leadRoot`), from when a lead wrote nothing. Host tools went only to a session that was not
 * read-only, so the lead, the chat's own session resumed to lead its build, lost the plugins,
 * connectors and cover the chat's own session has, with their guidance still in its transcript.
 * The host's own finding of the seat decides now, and the lead's plugins act on the build it leads,
 * where a director's do: what they deliver reaches the game when the run lands.
 */
describe("a lead has the chat's own session's plugins and connectors, on the build it leads", () => {
  it("offers them with their guidance, its plugins bound to the worktree it leads, whether or not it asks", async () => {
    const { core, threadId, game, runId, worktree, delegate, leadBrief, whileRunning, seen } = await leadChat();
    const { calls } = standInHostTools(core);
    const heard: unknown[] = [];
    whileRunning(async (request) => {
      if (!request.onLiveTool || !offered(request).length) return;
      heard.push(await request.onLiveTool(PLUGIN_TOOL.name, {}), await request.onLiveTool(CONNECTOR_TOOL.name, {}));
    });
    const built = await realpath(worktree);
    for (const [label, brief, asks] of [
      ["the lead answering its chat", leadBrief(), true],
      ["a lead nobody answers through", leadGrant(threadId, game, runId, worktree), false],
    ] as const) {
      calls.length = 0;
      heard.length = 0;
      await delegate(brief);
      const request = seen.at(-1)!;
      assert.equal(Boolean(request.leadAsks), asks, `${label}: asks as before`);
      assert.deepEqual(offered(request), [PLUGIN_TOOL.name, CONNECTOR_TOOL.name], `${label}: offered`);
      assert.ok(request.prompt.includes(PLUGIN_GUIDANCE), `${label}: the plugins' guidance`);
      assert.ok(request.prompt.includes(CONNECTOR_GUIDANCE), `${label}: the connectors' guidance`);
      // It sits in the game folder: told its plugins work on the build, whose path its brief never names.
      assert.ok(request.prompt.includes(leadToolsNote()), `${label}: told where its plugins work`);
      assert.equal(request.prompt.includes(built), false, `${label}: never the build's path`);
      assert.deepEqual(heard, ["delivered", "found"], `${label}: answered`);
      const [plugin, connector] = calls;
      assert.deepEqual(
        [plugin?.tool, plugin?.binding.project, plugin?.binding.directory, plugin?.binding.threadId],
        [PLUGIN_TOOL.name, game, built, threadId],
        `${label}: its plugin acts on the build it leads, never the live game folder it sits in`,
      );
      // A connector answers for the game (a root it shares is the game's, as for every session).
      assert.deepEqual(
        [connector?.tool, connector?.binding.project, connector?.binding.threadId],
        [CONNECTOR_TOOL.name, game, threadId],
        `${label}: its connector answers for its game and chat`,
      );
    }
    // Its line in the chat and the build card read as the build's between parts, however long the
    // connectors take to list, never "Connecting tools" on each wake.
    const phases = (await core.store.listEvents(threadId)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === "session_activity" && custom.payload.runId === runId ? [custom.payload.phase] : [];
    });
    assert.ok(phases.length, "its turns say what they do");
    assert.equal(phases.includes("connecting"), false, "and none says it is connecting tools");
  });

  it("still gives none to a read-only session that leads nothing, the playtester or the coordinator", async () => {
    const { core, threadId, game, runId, worktree, delegate, personSays, seen } = await leadChat();
    standInHostTools(core);
    const said = await personSays();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["a read-only session in the game folder", { readOnly: true }],
      [
        "a playtester",
        {
          playtest: {
            project: game,
            root: worktree,
            runId,
            facetId: "p",
            iteration: 0,
            role: "playtester",
            label: "p",
          },
          cwd: worktree,
          readOnly: true,
        },
      ],
      ["the run's coordinator", { coordinator: { runId, messageId: said }, readOnly: true, timeoutMs: 300_000 }],
      [
        "a lead's grant for a worktree that is not this game's run's",
        leadGrant(threadId, game, runId, await tmpDir("lead-not-a-worktree-")),
      ],
    ];
    for (const [label, brief] of cases) {
      await delegate(brief);
      assert.deepEqual(offered(seen.at(-1)!), [], label);
    }
  });

  it("keeps its consent card and connector call through the chat's other turns; Stop still ends them", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning } = await leadChat();
    const { calls, answers } = standInHostTools(core);
    // The plugin's tool is one the person confirms, as the registry asks before it runs one.
    answers.plugin = async (binding, signal) => {
      const confirmed = { name: "deliver", description: "Deliver an asset", confirmation: "Deliver the asset?" };
      const { approved, by } = await core.requestConsent("fixture", confirmed as never, {}, binding as never, signal);
      return approved ? "delivered" : `declined by ${by}`;
    };
    let finish = () => {};
    answers.connector = (signal) =>
      new Promise((resolve, reject) => {
        finish = () => resolve("found");
        if (signal.aborted) reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    // Both calls wait at once: the card for the person, the connector for its service.
    let heard: Record<string, unknown> = {};
    whileRunning(async (request) => {
      const call = (name: string) =>
        request.onLiveTool!(name, {}).then(
          (answer) => {
            heard[name] = answer;
          },
          (err: Error) => {
            heard[name] = err.message;
          },
        );
      await Promise.all([call(PLUGIN_TOOL.name), call(CONNECTOR_TOOL.name)]);
    });
    /** A turn that must end once its card and call are settled, however that goes wrong. */
    const settled = (turn: Promise<unknown>) =>
      Promise.race([turn.then(() => heard), sleep(MIRROR_WAIT_MS).then(() => "still waiting")]);
    const consents = async (state: string) =>
      (await core.store.listEvents(threadId)).flatMap((event) => {
        const custom = customRecord(event.data);
        const consent = custom?.payload as { consentId?: string; state?: string } | undefined;
        return custom?.event_type === "plugin_consent" && consent?.state === state ? [consent.consentId!] : [];
      });
    const until = async (done: () => Promise<boolean> | boolean) => {
      for (let waited = 0; !(await done()) && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
    };
    /** Another turn of the chat ends, as a turn the chat's own session answered would. */
    const anotherTurnEnds = () => core.append([{ type: "turn_ended", status: "ok" }], threadId);

    /** The card a lead's turn asks with, once it is in the chat: one the chat did not have before. */
    const newCard = async (known: string[]) => {
      let card: string | undefined;
      await until(async () => {
        card = (await consents("pending")).find((id) => !known.includes(id));
        return card !== undefined;
      });
      return card!;
    };

    const turn = delegate(leadBrief());
    const card = await newCard([]);
    await until(() => calls.length === 2);
    await anotherTurnEnds();
    assert.equal(core.resolveConsent(card, true), true, "the card still waits for the person");
    finish();
    assert.deepEqual(
      await settled(turn),
      { [PLUGIN_TOOL.name]: "delivered", [CONNECTOR_TOOL.name]: "found" },
      "neither was cut short by the other turn",
    );

    heard = {};
    calls.length = 0;
    const stopped = delegate(leadBrief());
    await newCard([card]);
    await until(() => calls.length === 2);
    await core.stopThread(threadId);
    assert.deepEqual(
      await settled(stopped),
      { [PLUGIN_TOOL.name]: "declined by stop", [CONNECTOR_TOOL.name]: "aborted" },
      "Stop ends both while they wait, as every card and call of the chat",
    );
  });

  // A connector action nobody saved "always allow" for asks the person first; a lead's card for it
  // outlives the chat's other turns as its call does, and ends with a Stop.
  it("keeps the card its connector action asks with through the chat's other turns", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning } = await leadChat();
    const { calls, answers } = standInHostTools(core);
    answers.connectorAllowed = false;
    let heard: unknown = "still waiting";
    whileRunning(async (request) => {
      heard = await request.onLiveTool!(CONNECTOR_TOOL.name, {}).catch((err: Error) => err.message);
    });
    const pending = async () =>
      (await core.store.listEvents(threadId)).flatMap((event) => {
        const custom = customRecord(event.data);
        const consent = custom?.payload as { consentId?: string; state?: string; tool?: string } | undefined;
        const asked = custom?.event_type === "plugin_consent" && consent?.state === "pending";
        return asked && consent?.tool === CONNECTOR_TOOL.name ? [consent.consentId!] : [];
      });
    const turn = delegate(leadBrief());
    let card: string | undefined;
    for (let waited = 0; !card && waited < 200; waited++) {
      card = (await pending())[0];
      if (!card) await sleep(MIRROR_POLL_MS);
    }
    assert.ok(card, "the connector action asks the person first");
    await core.append([{ type: "turn_ended", status: "ok" }], threadId);
    assert.equal(core.resolveConsent(card, true), true, "the card still waits for the person");
    await Promise.race([turn, sleep(MIRROR_WAIT_MS)]);
    assert.equal(heard, "found");
    assert.deepEqual(
      calls.map((call) => call.tool),
      [CONNECTOR_TOOL.name],
    );
  });

  // A run's session declined once is declined again without a card until the run is resumed
  // (`priorConsentDecline`): the lead, the chat's main agent, is asked each time, as the chat's own.
  it("asks the person again for a tool declined earlier in its run", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning } = await leadChat();
    const { answers } = standInHostTools(core);
    answers.plugin = async (binding, signal) => {
      const confirmed = { name: "deliver", description: "Deliver an asset", confirmation: "Deliver the asset?" };
      const { approved, by } = await core.requestConsent("fixture", confirmed as never, {}, binding as never, signal);
      return approved ? "delivered" : `declined by ${by}`;
    };
    const heard: unknown[] = [];
    whileRunning(async (request) => {
      heard.push(await request.onLiveTool!(PLUGIN_TOOL.name, {}));
    });
    const pending = async () =>
      (await core.store.listEvents(threadId)).flatMap((event) => {
        const custom = customRecord(event.data);
        const consent = custom?.payload as { consentId?: string; state?: string } | undefined;
        return custom?.event_type === "plugin_consent" && consent?.state === "pending" ? [consent.consentId!] : [];
      });
    const newCard = async (known: string[]) => {
      for (let waited = 0; waited < 200; waited++) {
        const card = (await pending()).find((id) => !known.includes(id));
        if (card) return card;
        if (heard.length > known.length) return null;
        await sleep(MIRROR_POLL_MS);
      }
      return null;
    };
    const first = delegate(leadBrief());
    const declined = await newCard([]);
    assert.ok(declined, "a card");
    core.resolveConsent(declined, false);
    await first;
    const again = delegate(leadBrief());
    const asked = await newCard([declined]);
    assert.ok(asked, "asked again, with a card of its own");
    core.resolveConsent(asked, true);
    await again;
    assert.deepEqual(heard, ["declined by user", "delivered"]);
  });

  // No turn of the chat's ending withdraws them, so the end of the lead's own session must: a card
  // left waiting after it would run the tool for a session that is gone, once approved.
  it("withdraws its card and ends its call when its own session ends first", async () => {
    const { core, threadId, delegate, leadBrief, whileRunning } = await leadChat();
    const { calls, answers } = standInHostTools(core);
    answers.plugin = async (binding, signal) => {
      const confirmed = { name: "deliver", description: "Deliver an asset", confirmation: "Deliver the asset?" };
      const { approved, by } = await core.requestConsent("fixture", confirmed as never, {}, binding as never, signal);
      return approved ? "delivered" : `declined by ${by}`;
    };
    answers.connector = (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const left: Array<Promise<unknown>> = [];
    whileRunning(async (request) => {
      // The session ends (its deadline, a crash) while the card and the call still wait.
      for (const name of [PLUGIN_TOOL.name, CONNECTOR_TOOL.name]) {
        left.push(request.onLiveTool!(name, {}).catch((err: Error) => err.message));
        for (let waited = 0; calls.length < left.length && waited < 200; waited++) await sleep(MIRROR_POLL_MS);
      }
    });
    await delegate(leadBrief());
    const settled = await Promise.race([
      Promise.all(left),
      sleep(MIRROR_WAIT_MS).then(() => "still waiting after the session ended"),
    ]);
    assert.deepEqual(settled, ["declined by stop", "aborted"]);
    const states = (await core.store.listEvents(threadId)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === "plugin_consent" ? [(custom.payload as { state?: string }).state] : [];
    });
    assert.deepEqual(states, ["pending", "declined"], "the card says it was withdrawn");
  });
});

/** A PreToolUse hook as the Agent SDK calls it. */
type ToolHook = (
  input: Record<string, unknown>,
  toolUseId: string,
  options: { signal: AbortSignal },
) => Promise<unknown>;

/**
 * A run's lead is the chat's main agent: only the chat's permission mode and the rules the person
 * saved limit it, as for the chat's own session. Flipped: the
 * host screened each of its calls in a hook and refused everything but a read while nobody talked
 * to it, whatever rules stood. The hook stays, to ask first once the chat leaves the mode the
 * session started in, and leaves every other call to the session's rules.
 */
describe("a lead's calls follow the chat's mode and the rules that stand, whoever talks to it", () => {
  it("lets a saved rule and the game's own settings stand while the person is away, with no card", async () => {
    const { core, project, threadId, delegate, leadBrief, asking, personSays, handToLead, heard } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    // The person once said "always" to the lead's `ls`: a rule saved for the game.
    const earlier = await personSays();
    await handToLead(earlier);
    const always: PermissionAsk["always"] = [{ kind: "rule", rule: "Bash(ls *)", scope: "game" }];
    const saved = await asking({ tool: "Bash", input: { command: "ls" }, always }, undefined, { waitForCard: true });
    core.answerPermission(saved.card!.requestId, { decision: "always" });
    await saved.done();
    await heard(earlier);
    await mkdir(path.join(project.dir, ".claude"), { recursive: true });
    await writeFile(
      path.join(project.dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash", "Edit", "WebFetch"] } }),
    );
    // The real engine, over a fake SDK query that calls the session's hooks as the CLI would.
    const calls: Array<[string, Record<string, unknown>]> = [];
    const answers: unknown[] = [];
    const options: Array<Record<string, unknown>> = [];
    const home = await tmpDir("lead-screen-home-");
    const queryFn = ((params: { options: Record<string, unknown> }) => {
      options.push(params.options);
      return {
        async *[Symbol.asyncIterator]() {
          const matchers = (params.options.hooks as { PreToolUse: Array<{ hooks: ToolHook[] }> }).PreToolUse;
          for (const [tool, input] of calls) {
            const input_ = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "tu" };
            for (const { hooks } of matchers)
              for (const hook of hooks)
                answers.push(await hook(input_, "tu", { signal: new AbortController().signal }));
          }
          yield { type: "system", subtype: "init", session_id: "lead", permissionMode: "default", tools: [] };
          yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, usage: {} };
        },
      };
    }) as never;
    core.engines.register(
      new ClaudeCodeEngine({
        resolveCli: fixtureCodingCli,
        engineHome: home,
        systemHome: path.join(home, "none"),
        queryFn,
      }),
    );
    const turn = async (asked: Array<[string, Record<string, unknown>]>) => {
      calls.splice(0, calls.length, ...asked);
      answers.length = 0;
      await delegate(leadBrief());
      return [...answers];
    };
    const ls: [string, Record<string, unknown>] = ["Bash", { command: "ls ~/Downloads" }];
    const read: [string, Record<string, unknown>] = ["Read", { file_path: path.join(project.dir, "index.html") }];
    const fetch: [string, Record<string, unknown>] = ["WebFetch", { url: "https://example.com" }];
    const edit: [string, Record<string, unknown>] = ["Edit", { file_path: path.join(project.dir, "src", "main.js") }];

    const rowsBefore = (await core.store.listEvents(threadId)).length;
    assert.deepEqual(await turn([ls, read, fetch, edit]), [{}, {}, {}, {}], "nobody in the chat: its rules stand");
    const session = options.at(-1)!;
    assert.deepEqual((session.settings as { permissions: { allow: string[] } }).permissions.allow, ["Bash(ls *)"]);
    assert.deepEqual(session.settingSources, [], "the game's settings require an explicit folder trust grant");
    const cards = (await core.store.listEvents(threadId))
      .slice(rowsBefore)
      .filter((event) => customRecord(event.data)?.event_type === "tool_permission");
    assert.deepEqual(cards, [], "and no card was asked for");

    const said = await personSays();
    await handToLead(said);
    assert.deepEqual(await turn([ls, read, fetch]), [{}, {}, {}], "the person talking to it changes nothing");
  });
});

/**
 * The lead sits in the game folder the person plays, while its builders change the game in their
 * own worktrees and the run lands their work there. Flipped:
 * its own edit tools were refused that folder in every mode. The chat's mode decides them now, as
 * every other call, and the lead's prompt still leaves the game's changes to its builders.
 */
describe("a lead's edit in the game folder is the chat's mode's to decide", () => {
  it("leaves an edit there to the mode it started in, however the path is spelt", async () => {
    const { core, project, worktree, threadId, delegate, leadBrief, seen } = await leadChat();
    const game = project.dir;
    const outside = await tmpDir("lead-outside-");
    await symlink(game, path.join(outside, "into-game"));
    const calls: ScreenedCall[] = [
      { tool: "Edit", input: { file_path: path.join(game, "src", "main.js") } },
      { tool: "Write", input: { file_path: "src/relative.js" } },
      { tool: "Edit", input: { file_path: path.join(outside, "into-game", "src", "main.js") } },
      { tool: "Write", input: { file_path: path.join(game, ".git", "hooks", "pre-commit") } },
      { tool: "Write", input: { file_path: path.join(worktree, "src", "sky.js") } },
      { tool: "Bash", input: { command: "rm -rf dist" } },
    ];
    for (const mode of ["auto", "acceptEdits", "bypassPermissions", "default", "plan"] as const) {
      await core.setPermissionMode(threadId, mode);
      await delegate(leadBrief());
      const lead = seen.at(-1)!.leadAsks!;
      for (const call of calls) assert.equal(await lead.screen(call), null, `${mode}: ${JSON.stringify(call.input)}`);
    }
  });

  it("leaves the coordinator's edit in the game folder to the mode too", async () => {
    const { core, project, runId, threadId, delegate, seen, personSays, queue } = await leadChat();
    await core.setPermissionMode(threadId, "bypassPermissions");
    const message = await personSays();
    await queue(message, "coordinator_message_queued");
    await queue(message, "coordinator_message_processing");
    await delegate({ coordinator: { runId, messageId: message }, readOnly: true, chatTurn: { messageId: message } });
    const coordinator = seen.at(-1)!.leadAsks!;
    const edit = { tool: "Write", input: { file_path: path.join(project.dir, "src", "main.js") } };
    assert.equal(await coordinator.screen(edit), null);
    assert.equal(await coordinator.screen({ tool: "Bash", input: { command: "ls ~/Desktop" } }), null);
  });

  it("reaches what the chat's own session reaches: no deny list for the person's other games", async () => {
    const { core, worktree, runId, game, delegate, leadBrief, seen } = await leadChat();
    const other = await core.games.scaffold("lead-asks-sibling");
    await delegate(leadBrief());
    assert.ok(seen.at(-1)!.leadAsks, "the lead asks");
    assert.equal(
      (seen.at(-1)!.denyReads ?? []).some((dir) => dir === other.dir),
      false,
      "another of the person's games is the mode's to decide",
    );
    await delegate({
      cwd: worktree,
      selfCapture: { project: game, root: worktree, runId, facetId: "sky", label: "sky" },
      timeoutMs: 60_000,
    });
    assert.equal(seen.at(-1)!.leadAsks, undefined, "a builder is unattended");
    assert.ok(seen.at(-1)!.denyReads?.includes(other.dir), "and still never reads another game");
  });

  // The harness names `extraReads` freely, and a folder read is a folder Accept edits (and Auto,
  // inside its working folders) writes without asking: a lead or coordinator reads the folders the
  // host derived itself and those the chat recorded, as the chat's own session, never the brief's.
  it("reads the folders the host derived and the chat recorded, never a folder the brief names", async () => {
    const { core, project, worktree, runId, threadId, delegate, leadBrief, seen, personSays } = await leadChat();
    await core.setPermissionMode(threadId, "acceptEdits");
    const recorded = await tmpDir("lead-recorded-");
    await core.store.updateThread(threadId, { metadata: { extraReads: [recorded] } });
    const hostile = [os.homedir(), path.join(os.homedir(), "Library", "LaunchAgents"), "/"];
    const reads = async (extra: Record<string, unknown>) => {
      await delegate({ ...extra, extraReads: [...hostile, recorded] });
      const request = seen.at(-1)!;
      assert.ok(request.leadAsks, "a seat that asks");
      return (request.extraReads ?? []).map((dir) => path.resolve(dir));
    };
    const lead = await reads(leadBrief());
    for (const dir of hostile) assert.equal(lead.includes(path.resolve(dir)), false, `the lead never reads ${dir}`);
    assert.ok(lead.includes(path.resolve(recorded)), "the chat's recorded folder");
    assert.ok(lead.includes(await realpath(worktree)), "the worktree it leads, by the real path its seat checked");
    const said = await personSays();
    const coordinator = await reads({ coordinator: { runId, messageId: said }, readOnly: true, timeoutMs: 300_000 });
    for (const dir of hostile)
      assert.equal(coordinator.includes(path.resolve(dir)), false, `the coordinator never reads ${dir}`);
    assert.ok(coordinator.includes(path.resolve(project.dir)), "the coordinator reads its game");
  });
});

/**
 * A lead's card lasted only as long as the chat's current turn: a picture or a slash command the
 * person sent took a turn of its own, and its end withdrew the lead's question (review L5). A lead
 * or coordinator is not that turn; its card ends with its own session, a Stop, an answer, or the
 * five minutes.
 */
describe("a lead's card outlives the chat's other turns", () => {
  it("stays open when another turn ends, and the person's answer still reaches the lead", async () => {
    const { core, threadId, asking, personSays, handToLead } = await leadChat();
    await core.setPermissionMode(threadId, "default");
    await handToLead(await personSays());
    const { card, done } = await asking({ tool: "Bash", input: { command: "ls ~/Downloads" } }, undefined, {
      waitForCard: true,
    });
    assert.ok(card, "a card in the chat");
    await core.append([{ type: "turn_ended", status: "ok" }], threadId);
    assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), true, "still waiting for the person");
    const { answer, rows } = await done();
    assert.deepEqual(answer, { decision: "allow" });
    assert.deepEqual(
      rows.map((row) => [row.state, row.by]),
      [
        ["pending", undefined],
        ["allowed", "user"],
      ],
    );
  });
});

/**
 * The lead is the chat's main agent: it builds with its own hands where its build is, as a
 * director with its own hands did. The studio's fence on its own data (an Edit deny, which holds
 * even in Bypass) used to cover the whole of scratch, so the lead could not edit the integration
 * worktree it leads in any mode. That worktree is opened; the rest of its run's folder, other runs
 * and the studio's own files stay fenced.
 */
describe("a lead builds with its own hands in the build it leads", () => {
  it("may edit the integration worktree it leads, and nothing else of scratch or the studio's data", async () => {
    const { core, project, runId, worktree, seen, delegate, leadBrief } = await leadChat();
    const worker = await runWorktree(core, project, runId, { name: "worker-a", recorded: false });
    const otherRun = path.join(core.layout.scratch, "autopilot", "run_other", "integration");
    const evidence = path.join(core.options.paths.userData, "runs", runId);
    await mkdir(otherRun, { recursive: true });
    await mkdir(evidence, { recursive: true });
    await delegate(leadBrief());
    const asks = seen.at(-1)?.leadAsks;
    assert.ok(asks, "the lead asks in its chat's mode");
    const fenced = (dir: string) => asks.protectWrites.some((fence) => isInside(fence, dir));
    const cases = [
      { label: "the integration worktree it leads", dir: worktree },
      { label: "a file in it", dir: path.join(worktree, "src", "main.js") },
      { label: "a worker's worktree of the same run", dir: worker },
      { label: "another run's worktree", dir: otherRun },
      { label: "its run's evidence in the studio's data", dir: evidence },
    ];
    assert.deepEqual(
      cases.map(({ label, dir }) => ({ label, fenced: fenced(dir) })),
      [
        { label: "the integration worktree it leads", fenced: false },
        { label: "a file in it", fenced: false },
        { label: "a worker's worktree of the same run", fenced: true },
        { label: "another run's worktree", fenced: true },
        { label: "its run's evidence in the studio's data", fenced: true },
      ],
    );
  });

  it("gets no opening for a worktree of a run its chat never started", async () => {
    const { core, project, threadId, game, seen, delegate, personSays } = await leadChat();
    // A worktree of this game under scratch, but of a run the game's chat never started.
    const stranger = await runWorktree(core, project, "run_stranger", { recorded: false });
    await personSays();
    await delegate({ chatTurn: { messageId: "run_stranger" }, ...leadGrant(threadId, game, "run_stranger", stranger) });
    const asks = seen.at(-1)?.leadAsks;
    const opened = asks ? !asks.protectWrites.some((fence) => isInside(fence, stranger)) : false;
    assert.equal(opened, false, "a worktree of a run this chat did not start stays fenced, or the lead is not seated");
  });
});
