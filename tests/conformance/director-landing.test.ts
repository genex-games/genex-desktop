/**
 * The director's commits on the way to a landing, through the real core and harness child:
 * a worker's title reaches its commit message as text (HQ-1), and the director's own
 * uncommitted edits either become a commit or stop the landing (HQ-2).
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
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));
const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

const planFor = (...ids: string[]): Record<string, unknown> => ({
  summary: "This run: hang a sign on the plaza.",
  workers: JSON.stringify(
    ids.map((id) => ({
      id,
      title: id,
      seam: `the ${id}`,
      owns: `src/${id}.js`,
      done: [`the ${id} is there to see`],
      minutes: 20,
    })),
  ),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
});

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
 * One director run: plan, one single-mode worker on `sign`, integrate, then `beforeFinish`, then
 * finish land=yes. `directorLoop: "turn"` runs a director with its own hands in its worktree; a
 * waking run's lead is its chat's own session and writes nothing (director/lead-session.ts).
 */
async function loopRun(
  name: string,
  options: { title: string; beforeFinish?: (cwd: string) => Promise<void>; directorLoop?: "turn" },
) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  const project = await rig.core.games.scaffold(name, { title: name });
  const results: Record<string, any> = {};
  let sessions = 0;
  fakeEngine(rig, async (request) => {
    if (request.director) {
      if (++sessions > 1)
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "director-wrap",
          summary: "nothing left to do",
        };
      const call = (tool: string, args: Record<string, unknown>) => request.onLiveTool!(tool, args);
      await call("plan", planFor("sign"));
      await call("worker_start", {
        id: "sign",
        title: options.title,
        brief: "hang a sign",
        mode: "single",
        minutes: "5",
        owns: "src/sign.js",
      });
      for (let i = 0; i < 30; i++) {
        const waited = json(await call("wait", { seconds: "5", worker: "sign" }));
        if (waited.status.workers[0]?.state !== "running") break;
      }
      results.integrated = json(await call("integrate", { worker: "sign" }));
      await options.beforeFinish?.(request.cwd!);
      results.finished = text(await call("finish", { summary: "the sign is up", land: "yes" }));
      return {
        ok: true,
        engine: "codex",
        turns: 6,
        usage: {},
        sessionId: `director-${name}`,
        summary: "hung the sign",
      };
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
    ...(options.directorLoop ? { directorLoop: options.directorLoop } : {}),
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

describe("the director's commits on the way to a landing", () => {
  it("commits a worker under its title as written: backticks and $(…) in it run nothing", async () => {
    const title = 'Sign `echo lit` $(echo twice) it\'s "open"';
    const { project, finished } = await loopRun("director-title", { title });
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    const subjects = (await git(project.dir, ["log", "--all", "--format=%s"])).split("\n");
    assert.ok(subjects.includes(`worker sign: ${title}`), subjects.join("\n"));
  });

  it("lands nothing when the director's own last edits cannot be committed, and says why", async () => {
    let unreadable = "";
    // Flipped (one session): a director with its own hands in its worktree is the long turn's now;
    // a waking lead sits in the game folder and writes nothing.
    const { project, results, finished } = await loopRun("director-final", {
      title: "Sign",
      directorLoop: "turn",
      beforeFinish: async (cwd) => {
        // The director's last edit, and a file git cannot read, so `git add -A` fails on it.
        await writeFile(path.join(cwd, "src", "haze.js"), "export const haze = 0.38;\n");
        unreadable = path.join(cwd, "src", "capture.bin");
        await writeFile(unreadable, "half-written\n");
        await chmod(unreadable, 0o000);
      },
    });
    await chmod(unreadable, 0o644).catch(() => {});
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.match(results.finished, /not landed: the director's last edits could not be committed/, results.finished);
    assert.equal(
      await exists(path.join(project.dir, "src", "sign.js")),
      false,
      "the integrated build was not landed without them",
    );
    assert.equal(await exists(path.join(project.dir, "src", "haze.js")), false);
  });
});
