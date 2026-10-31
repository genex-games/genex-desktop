/**
 * The lead's commits on the way to a landing, through the real core and harness child: a worker's
 * title reaches its commit message as text (HQ-1), and the lead's own uncommitted edits either
 * become a commit or stop the landing (HQ-2).
 */
import assert from "node:assert/strict";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type {
  CompleteRequest,
  CompleteResponse,
  DelegateRequest,
  DelegateResult,
  LiveToolResult,
} from "../../src/substrate/engines/types.ts";
import { gitFile } from "../helpers/git.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();
const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

/** `complete` is the run's judge; "{}" is a tie. */
function fakeEngine(rig: Rig, delegate: (request: DelegateRequest) => Promise<DelegateResult>): void {
  const complete = async (_request: CompleteRequest): Promise<CompleteResponse> => ({
    message: { role: "assistant", content: "{}" },
    usage: {},
    model: "fixture",
    engine: "codex",
    stopReason: "stop",
  });
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete,
    delegate,
  } as never);
}

/**
 * One Loop: the lead starts one worker in its own copy, merges it once it is done (worker_mark
 * used), runs `beforeFinish` in the integration worktree it builds in, then finishes land=yes.
 */
async function loopRun(name: string, options: { title: string; beforeFinish?: (root: string) => Promise<void> }) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  const project = await rig.core.games.scaffold(name, { title: name });
  const results: Record<string, any> = {};
  let sessions = 0;
  const leadTurn = (summary: string) => ({
    ok: true,
    engine: "codex",
    turns: 1,
    usage: {},
    sessionId: "lead",
    summary,
  });
  fakeEngine(rig, async (request) => {
    if (request.director) {
      if (++sessions > 1) return leadTurn("nothing left to do");
      const call = async (tool: string, args: Record<string, unknown>) => text(await request.onLiveTool!(tool, args));
      await call("worker_start", { title: options.title, task: "hang a sign", isolation: "copy" });
      await call("worker_wait", { id: "w1", seconds: "120" });
      results.integrated = await call("worker_mark", { id: "w1", verdict: "used" });
      await options.beforeFinish?.(request.director.root);
      results.finished = await call("finish", { summary: "the sign is up", land: "yes" });
      return leadTurn("hung the sign");
    }
    await mkdir(path.join(request.cwd, "src"), { recursive: true });
    await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
    return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: `worker-${name}`, summary: "hung the sign" };
  });
  const runId = rig.core.newRunId();
  await rig.core.dispatchRun({
    runId,
    goal: "a lit plaza",
    project: project.name,
    mode: "autopilot",
    engine: "codex",
    reference: { name: "plaza", shots: [] },
    budgets: { wallClockMs: 15 * 60_000 },
  });
  const events = await waitForLog(
    rig.core,
    (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
    120_000,
    `${name} run_finished`,
  );
  const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
  return { project, results, finished, runId };
}

describe("the lead's commits on the way to a landing", () => {
  it("commits a worker under its title as written: backticks and $(…) in it run nothing", async () => {
    const title = 'Sign `echo lit` $(echo twice) it\'s "open"';
    const { project, finished } = await loopRun("director-title", { title });
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    const subjects = (await git(project.dir, ["log", "--all", "--format=%s"])).split("\n");
    // Flipped (Loop phase 5): a worker is named by its pool id (w1), not an id the lead chose.
    assert.ok(subjects.includes(`worker w1: ${title}`), subjects.join("\n"));
  });

  it("lands nothing when the lead's own last edits cannot be committed, and says why", async () => {
    let unreadable = "";
    // Flipped (Loop phase 5): the lead of a waking run builds in the integration worktree with its
    // own hands (no long turn of a director of its own), and the words name the lead.
    const { project, results, finished } = await loopRun("director-final", {
      title: "Sign",
      beforeFinish: async (root) => {
        // The lead's last edit, and a file git cannot read, so `git add -A` fails on it.
        await writeFile(path.join(root, "src", "haze.js"), "export const haze = 0.38;\n");
        unreadable = path.join(root, "src", "capture.bin");
        await writeFile(unreadable, "half-written\n");
        await chmod(unreadable, 0o000);
      },
    });
    await chmod(unreadable, 0o644).catch(() => {});
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.match(results.finished, /not landed: the lead's last edits could not be committed/, results.finished);
    assert.equal(
      await exists(path.join(project.dir, "src", "sign.js")),
      false,
      "the integrated build was not landed without them",
    );
    assert.equal(await exists(path.join(project.dir, "src", "haze.js")), false);
  });
});
