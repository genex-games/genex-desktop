import assert from "node:assert/strict";
import { it } from "node:test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { InferenceQueue } from "../../src/substrate/engines/bonsai.ts";
import type { CompleteRequest, CompleteResponse } from "../../src/substrate/engines/types.ts";
import { startRig, makeFakePreview, waitForLog, customEvents } from "../helpers/studio-rig.ts";
const model = "bonsai-2:27b-pq2_0";
it("a local director uses real persisted local workers, integrates their work and finishes through the harness", {
  timeout: 120000,
}, async () => {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
  );
  const queue = new InferenceQueue();
  let n = 0;
  const results: string[] = [];
  try {
    const project = await rig.core.games.scaffold("bonsai-director", { title: "Local director" });
    const complete = async (r: CompleteRequest): Promise<CompleteResponse> => {
      const release = await queue.acquire(r.signal ?? new AbortController().signal);
      try {
        const call = (name: string, args: unknown): CompleteResponse => ({
          engine: "bonsai",
          model,
          usage: {},
          stopReason: "tool_calls",
          message: { role: "assistant", content: "", tool_calls: [{ id: `c${++n}`, name, arguments: args }] },
        });
        const done = (content: string): CompleteResponse => ({
          engine: "bonsai",
          model,
          usage: {},
          stopReason: "stop",
          message: { role: "assistant", content },
        });
        // Flipped: the director's claim is checked by a reviewer first (a local session here), which says yes.
        if (JSON.stringify(r.messages).includes("You are the reviewer of a Loop"))
          return done('```json\n{"verdict":"yes","reasons":["Both parts are in."],"notDone":[]}\n```');
        if (!r.tools?.length) return done('{"answer":"yes","pass":true}');
        const last = r.messages.at(-1);
        const prior = r.messages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.tool_calls ?? [])
          .map((c) => c.name);
        if (r.tools.some((t) => t.name === "worker_start")) {
          if (last?.role === "tool") results.push(last.content);
          if (!prior.includes("plan"))
            return call("plan", {
              summary: "Two local parts",
              workers: JSON.stringify(
                ["plaza", "sign"].map((id) => ({
                  id,
                  title: id,
                  seam: `the ${id}`,
                  owns: `src/${id}.js`,
                  done: [`${id} exists`],
                  minutes: 5,
                })),
              ),
              base: "current integration",
              risks: "sequential model inference",
            });
          const starts = r.messages.filter((m) => m.role === "tool" && m.content.startsWith('{"started":')).length;
          // A waking lead has no wait: it ends its turn, and the studio wakes it when a builder ends.
          if (last?.role === "tool" && last.content.includes("no worker window free"))
            return done("Waiting for the builders");
          if (starts < 2) {
            const id = starts ? "sign" : "plaza";
            return call("worker_start", {
              id,
              title: id,
              brief: `Write src/${id}.js exporting ${id}`,
              owns: `src/${id}.js`,
              mode: "single",
              minutes: "5",
            });
          }
          if (
            last?.role === "tool" &&
            (last.content.startsWith('{"started":') || last.content.includes('"state":"running"'))
          )
            return done("Waiting for the builders");
          // Woken with a digest: look at the builders before deciding.
          if (last?.role === "user") return call("worker_status", {});
          const merges = prior.filter((c) => c === "integrate").length;
          if (merges < 2) return call("integrate", { worker: merges ? "sign" : "plaza" });
          if (!prior.includes("judge"))
            return call("judge", { target: "integration", against: "none", question: "Does it work?" });
          if (!prior.includes("finish"))
            return call("finish", { summary: "Both local parts integrated", land: "yes", victory: "yes" });
          return done("Finished");
        }
        if (!prior.includes("write_file")) {
          const prompt = r.messages.find((m) => m.role === "user")?.content ?? "";
          const id = prompt.includes("src/sign.js") ? "sign" : "plaza";
          return call("write_file", { path: `src/${id}.js`, content: `export const ${id} = true;\n` });
        }
        assert.ok(!last?.content.includes("Tool failed"), last?.content);
        return done("Part built");
      } finally {
        release();
      }
    };
    const sessions = new LocalSessions({
      root: path.join(rig.userData, "local-sessions"),
      scratchRoot: path.join(rig.userData, "local-scratch"),
      protectedPaths: [],
      contextWindow: 100000,
      complete,
    });
    rig.core.engines.register({
      id: "bonsai",
      label: "Bonsai fixture",
      kind: "direct",
      supportsSessions: true,
      status: async () => ({ code: "ready", detail: "scripted completion only" }),
      models: async () => [
        {
          id: model,
          label: model,
          contextWindow: 100000,
          maxTokens: 4096,
          supportsTools: true,
          supportsVision: true,
          supportsThinking: true,
        },
      ],
      complete,
      delegate: (r) => sessions.run(r, r.model ?? model),
      defaultModel: async () => model,
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "Two local parts",
      project: project.name,
      mode: "autopilot",
      engine: "bonsai",
      model,
      reference: { name: "parts", shots: [] },
      budgets: { wallClockMs: 15 * 60000 },
    });
    const log = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      110000,
      "local director finish",
    );
    const finished = customEvents(log, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, JSON.stringify({ finished, results }));
    for (const id of ["plaza", "sign"])
      assert.match(
        await readFile(path.join(project.dir, `src/${id}.js`), "utf8").catch(() => JSON.stringify(results)),
        /export const/,
      );
    assert.ok(customEvents(log, "autopilot_started").some((e) => e.director === true));
  } finally {
    await rig.stop();
  }
});
