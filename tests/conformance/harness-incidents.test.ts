
import { OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitFile } from "../helpers/git.ts";
/**
 * Incident tests for the loop. One `it` per incident from the
 * morrowind-2 and shooter postmortems, named after it, on the real rig (a real StudioCore,
 * real git, a fake delegated engine, a fake preview) or on the pure functions the fix lives
 * in. A change under `src/harness-seed/**` without a row here that would have failed on the
 * incident it fixes is not done; every future postmortem adds rows before its fixes land.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  customEvents,
  makeFakePreview,
  startRig,
  waitForLog,
  type FakePreview,
  type Rig,
} from "../helpers/studio-rig.ts";
import { EngineError, type CompleteRequest, type DelegateRequest } from "../../src/substrate/engines/types.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { isTransientProviderError, withProviderPatience } from "../../src/harness-seed/loop/outage.ts";
import { forgetProviderLosses, noteProviderLoss, providerLossFor } from "../../src/harness-seed/loop/provider-loss.ts";
import { createRunInbox, type RunInbox } from "../../src/harness-seed/loop/run-inbox.ts";
import { runWakeLoop, type DirectorTalk } from "../../src/harness-seed/loop/director/wake.ts";
import { landIntegration } from "../../src/harness-seed/loop/director/integrate.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { chatWaitsFor, leadDoor, passCtx, stopRunsOf } from "../../src/harness-seed/loop/live-chat.ts";
import { factsReadyPrompt } from "../../src/harness-seed/loop/project-prompts.ts";
import { steeredCall } from "../../src/harness-seed/loop/chat-steer.ts";
import { switchedTurnPrompt, } from "../../src/harness-seed/loop/steer-switch-prompts.ts";
import { steeredTurnPrompt } from "../../src/harness-seed/loop/chat-steer-prompts.ts";
import { leadLineOf, openLeadLine } from "../../src/harness-seed/loop/director/lead-line.ts";
import { handleUserMessage } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { setImmediate as nextTurn, setTimeout as setTimeoutPromise } from "node:timers/promises";
import { cancelThread } from "../../src/harness-seed/loop/main.ts";
import type { Studio } from "../../src/harness-seed/loop/studio-state.ts";
import type { Host } from "../../src/harness-seed/types/harness.d.ts";
import { folderLabelOf } from "../../src/harness-seed/loop/workers/identity.ts";

it("WIN-FOLDER-LABEL: a Windows game folder is named by its last two parts, never the whole C:\\Users path", () => {
  assert.equal(folderLabelOf("C:\\Users\\ana\\AI Games\\rift", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf("C:/Users/ana/AI Games/rift/", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf("/Users/ana/AI Games/rift", "rift"), "AI Games/rift");
  assert.equal(folderLabelOf(null, "rift"), "rift");
});

it("AUDIT-STOP-RACE: cancellation is visible before a delayed queue-pause write", async () => {
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const studio: Studio = {
    host: { call: async () => null, notify: () => {}, heartbeat: () => {}, workspace: "/fixture" } as Host,
    cancels: new Set(),
    stoppedMessages: new Set(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => {
      throw new Error("unused fixture scope");
    },
  };
  const stopping = cancelThread(studio, { current: () => "message", pause: () => paused }, "thread");
  try {
    assert.equal(studio.cancels.has("thread"), true);
    assert.equal(studio.stoppedMessages?.has("message"), true);
  } finally {
    release();
    await stopping;
  }
});
import { applySeed } from "../../src/substrate/seed-upgrade.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

it("AUDIT-SEED. preserved pre-wake budgets cannot break newly shipped completion policy", async () => {
  const root = await tmpDir("audit-seed-upgrade-");
  const workspace = path.join(root, "workspace");
  const seed = fileURLToPath(new URL("../../src/harness-seed", import.meta.url));
  const manifest = path.join(root, "manifest.json");
  await applySeed({ seedDir: seed, workspaceDir: workspace, manifestFile: manifest });
  const vintage = JSON.parse(
    await readFile(new URL("../fixtures/seed-exports-pre-wake.json", import.meta.url), "utf8"),
  );
  const names: string[] = vintage.modules["loop/director/budgets.ts"];
  const older = `${names.map((name) => `export const ${name} = () => null;`).join("\n")}\n// owned edit\n`;
  await writeFile(path.join(workspace, "loop/director/budgets.ts"), older);
  const report = await applySeed({ seedDir: seed, workspaceDir: workspace, manifestFile: manifest });
  assert.ok(report.kept.includes("loop/director/budgets.ts"));
  assert.equal(await readFile(path.join(workspace, "loop/director/budgets.ts"), "utf8"), older);
  const journal = await import(pathToFileURL(path.join(workspace, "loop/director/journal.ts")).href);
  assert.equal(typeof journal.restoreLoopRun, "function");
});
import { turnBriefing } from "../../src/harness-seed/loop/turn-prompts.ts";
import { LandingHow } from "../../src/harness-seed/loop/director/rules.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/harness-seed/loop/time.ts";
import { describeUnknownImage, sniffImage } from "../../src/substrate/image-sniff.ts";
import { ownershipHook } from "../../src/substrate/engines/claude-code.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { runTurn } from "../../src/harness-seed/loop/turn-loop.ts";
import { materializePrompt } from "../../src/harness-seed/loop/prompt.ts";
import { toPiMessages } from "../../src/substrate/engines/ollama.ts";
import { killTree } from "../../src/substrate/spawn.ts";
const rigs: Rig[] = [];
/** The core's RPC table, as the harness child sees it. */
const apiOf = (rig: Rig) => rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** A minimal AVIF: an ISO BMFF `ftyp` box with the avif brand — what a phone exports as ".jpg". */
const AVIF_BYTES = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from("ftypavif", "latin1"),
  Buffer.alloc(24, 0),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

type FakeEngineHooks = {
  complete: (text: string, request: CompleteRequest) => string | null | Promise<string | null>;
  delegate: (request: DelegateRequest) => Promise<Record<string, unknown> | null>;
};

/** A scripted contractor + judge on the rig; `complete` sees the flattened prompt, `delegate` the request. */
function registerFakeEngine(rig: Rig, hooks: FakeEngineHooks, id = "fake-delegate"): void {
  rig.core.engines.register({
    id,
    label: "Fake contractor",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async (request: CompleteRequest) => {
      const text = request.messages.map((m) => String(m.content)).join("\n") + "\n" + (request.systemPrompt ?? "");
      const reply = (await hooks.complete(text, request)) ?? defaultJudge(text, request);
      return {
        message: { role: "assistant", content: reply },
        usage: {},
        stopReason: "stop",
        model: "fake",
        engine: id,
      };
    },
    delegate: async (request: DelegateRequest) => {
      const extra = (await hooks.delegate(request)) ?? {};
      return { ok: true, summary: "ok", usage: {}, turns: 1, engine: id, ...extra };
    },
  });
}

/**
 * Answer a batched board of picture questions — one call per camera since M3.10, with one reply
 * keyed by check id. Every question the `no` pattern names is answered no; the rest, yes.
 */
function answerBatch(text: string, options: { no?: RegExp; note?: string } = {}): string {
  const answers: Record<string, unknown> = {};
  for (const [, id, ask] of text.matchAll(/^- (\S+) — IMAGE [^:]*: (.*)$/gm)) {
    answers[id!] = options.no?.test(`${id} ${ask}`)
      ? { answer: "no", confidence: 0.9, note: options.note ?? "still there" }
      : { answer: "yes", confidence: 0.9, note: "seen" };
  }
  return JSON.stringify({ answers });
}

/** The synthetic preview encodes its capture counter in pixels; scripted judges prefer the newer fixture image. */
function newestFixtureBuild(request: CompleteRequest): "A" | "B" {
  const latest = { A: 0, B: 0 };
  for (const image of request.messages.flatMap((message) => message.images ?? [])) {
    const side = image.label?.startsWith("BUILD A") ? "A" : image.label?.startsWith("BUILD B") ? "B" : null;
    if (!side) continue;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length >= 7) latest[side] = Math.max(latest[side], bytes.readUInt32BE(3));
  }
  return latest.A >= latest.B ? "A" : "B";
}

/** Judges that keep the loop moving: checks pass, the taste judge is never satisfied, panels prefer the reference. */
function defaultJudge(text: string, request: CompleteRequest): string {
  if (text.includes("QUESTIONS (")) return answerBatch(text);
  if (text.includes("QUESTION:")) return JSON.stringify({ answer: "yes", confidence: 0.9, note: "seen" });
  if (text.includes("DIFF:")) return JSON.stringify({ violations: [], summary: "clean" });
  if (text.includes("THE FACET UNDER JUDGEMENT")) {
    const pick = newestFixtureBuild(request);
    return JSON.stringify({
      pick,
      satisfied: false,
      regression: null,
      newCheck: null,
      defects: [],
      reason: "scripted",
    });
  }
  if (text.includes("BUILD A") && text.includes("BUILD B")) {
    const pick = newestFixtureBuild(request);
    return JSON.stringify({ pick, biggest_gap: "", reason: "scripted global" });
  }
  if (text.includes("REFERENCE:"))
    return JSON.stringify({
      looks: "reference",
      plays: "reference",
      better: "",
      biggest_gap: "flat",
      reason: "scripted panel",
    });
  return "ok";
}

/**
 * A ladder of `rungs` steps for a facet, none with a check of its own. Since Loop phase 4 no judge's
 * "not satisfied" keeps a facet going: a part whose checks hold is done unless its ladder has a rung
 * left, and a kept round climbs one. A row that needs a facet to run several rounds gives it one.
 */
function ladderOf(id: string, rungs: number) {
  return Array.from({ length: rungs }, (_, i) => ({ id: `${id}-step-${i + 1}`, what: `step ${i + 1} of the ${id}` }));
}

function twoFacetPlan(extra: { waterChecks?: unknown[]; skyChecks?: unknown[]; more?: unknown[] } = {}) {
  return {
    facets: [
      {
        id: "water",
        title: "Water",
        intent: "a dark mirror marsh",
        owns: ["src/water.js"],
        identity: ["marsh"],
        budgetShare: 0.5,
        checks: extra.waterChecks ?? [
          { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        ],
      },
      {
        id: "sky",
        title: "Sky",
        intent: "a sun in the sky",
        owns: ["src/sky.js"],
        identity: ["sun"],
        budgetShare: 0.5,
        checks: extra.skyChecks ?? [
          { id: "sky-lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        ],
      },
      ...(extra.more ?? []),
    ],
    mainOwner: "water",
    base: null,
    integrationNotes: "",
    assumptions: [],
  };
}

async function runAutopilot(
  rig: Rig,
  project: string,
  options: { budgets?: Record<string, unknown>; reference?: Record<string, unknown>; engine?: string } = {},
) {
  const runId = rig.core.newRunId();
  await rig.core.dispatchRun({
    runId,
    goal: "a marsh with a sun",
    project,
    mode: "autopilot",
    classic: true,
    engine: options.engine ?? "fake-delegate",
    reference: options.reference ?? { name: "quiet marsh", shots: [], kind: "direction" },
    budgets: { wallClockMs: 3_600_000, maxIterations: 10, review: true, ...(options.budgets ?? {}) },
  } as never);
  const events = await waitForLog(
    rig.core,
    (log) =>
      log.some(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === "run_finished" &&
          (e.data.payload as { runId?: string } | undefined)?.runId === runId,
      ),
    240_000,
    `${project} run_finished`,
  );
  return { runId, events };
}

describe("harness incidents", () => {
  it("1. D1 delete-after-merge: a manual integration merge is not this facet's edit, and nothing merged is deleted", async () => {
    const rig = await startRig();
    rigs.push(rig);
    // Both facets own the shared palette — a file only one facet owns is quarantined by the
    // reviewer (and blocked by the edit-time hook on a real contractor) before it can conflict.
    const plan = twoFacetPlan();
    (plan.facets[0] as { owns: string[] }).owns = ["src/water.js", "src/palette.js"];
    (plan.facets[1] as { owns: string[] }).owns = ["src/sky.js", "src/palette.js"];
    // Since Loop phase 4 a ladder, not a judge never satisfied, keeps both going past their first round.
    for (const facet of plan.facets as Array<{ id: string }>)
      Object.assign(facet, { milestones: ladderOf(facet.id, 3) });
    const builds: Record<string, number> = { water: 0, sky: 0 };
    const judged: string[] = [];
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        const git = async (...args: string[]) => (await gitFile(["-C", cwd, ...args])).stdout.trim();
        await mkdir(path.join(cwd, "src"), { recursive: true });
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          builds.water++;
          // Water edits the shared palette on its first build; sky's own palette edit will conflict.
          await writeFile(path.join(cwd, "src", "palette.js"), `export const palette = "water-${builds.water}";\n`);
          await writeFile(path.join(cwd, "src", "water.js"), `export const water = ${builds.water};\n`);
          return { sessionId: "ses_water" };
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          builds.sky++;
          if (builds.sky === 1) {
            // Sky forked with water's first palette; wait until water's SECOND palette is on the
            // integration branch, then overwrite the first — both sides modified, a real conflict.
            const until = Date.now() + 90_000;
            while (Date.now() < until) {
              const found = await git("log", "--all", "--grep=integrate water iteration 2", "--format=%H").catch(
                () => "",
              );
              if (found) break;
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            await writeFile(path.join(cwd, "src", "palette.js"), `export const palette = "sky";\n`);
          }
          if (/could not merge it automatically/.test(request.prompt)) {
            // The builder does what the note says: merge the integration head by hand, keeping theirs on the conflict.
            const head = /git merge ([0-9a-f]{40})/.exec(request.prompt)?.[1];
            assert.ok(head, "the note names the integration head");
            await git("-c", "user.name=fake", "-c", "user.email=fake@x", "merge", "-X", "theirs", "--no-edit", head!);
          }
          await writeFile(path.join(cwd, "src", "sky.js"), `export const sky = ${builds.sky};\n`);
          return { sessionId: "ses_sky" };
        }
        if (request.playtest)
          return { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) };
        judged.push("other");
        return null;
      },
    });
    const { events } = await runAutopilot(rig, "mergeworld");
    const skyIterations = customEvents(events, "facet_iteration").filter((i) => i.facetId === "sky");
    const manual = skyIterations.find((i) => (i.iteration as number) >= 2 && i.verdictSource !== "broken");
    assert.ok(
      manual,
      `sky had a judged iteration after the manual merge: ${JSON.stringify(skyIterations.map((i) => [i.iteration, i.verdictSource]))}`,
    );
    // Review never "reverted" water's module: no enforcement deleted it, and the merge note was needed.
    const enforced = customEvents(events, "facet_review_enforced").filter((e) => e.facetId === "sky");
    assert.ok(
      enforced.every((e) => !(e.reverted as string[]).includes("src/water.js")),
      `water.js was never reverted on sky: ${JSON.stringify(enforced)}`,
    );
    const merges = customEvents(events, "integration_merge").filter((m) => m.facetId === "sky" && m.conflict === true);
    const gameDirDebug = path.join(rig.core.layout.gamesRoot, "mergeworld");
    const debugLog = (
      await gitFile(["-C", gameDirDebug, "log", "--all", "--format=%h %s", "--", "src/palette.js"]).catch(() => ({
        stdout: "?",
      }))
    ).stdout;
    const debugPalette = (
      await gitFile(["-C", gameDirDebug, "show", "HEAD:src/palette.js"]).catch(() => ({ stdout: "?" }))
    ).stdout;
    assert.ok(
      merges.length >= 1,
      `sky's worktree merge conflicted on palette.js, as designed — merges: ${JSON.stringify(customEvents(events, "integration_merge").map((m) => [m.facetId, m.conflict, m.stage ?? "worktree", m.union ?? null]))}; sky: ${JSON.stringify(skyIterations.map((i) => [i.iteration, i.verdictSource, i.winner]))}; builds ${JSON.stringify(builds)}; palette log:\n${debugLog}\nHEAD palette: ${debugPalette}`,
    );
    const gameDir = path.join(rig.core.layout.gamesRoot, "mergeworld");
    const { stdout: branches } = await gitFile([
      "-C",
      gameDir,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]);
    // Every sky commit made after the manual merge still carries water.js.
    const skyHeads = branches.split("\n").filter((b) => /^attempt\/sky\//.test(b));
    for (const branch of skyHeads) {
      const { stdout: tree } = await gitFile(["-C", gameDir, "ls-tree", "--name-only", "-r", branch]);
      if (
        tree.includes("src/palette.js") &&
        /palette = "water/.test((await gitFile(["-C", gameDir, "show", `${branch}:src/palette.js`])).stdout)
      ) {
        assert.ok(tree.includes("src/water.js"), `${branch} kept water.js after taking water's palette`);
      }
    }
    const { stdout: landed } = await gitFile(["-C", gameDir, "ls-tree", "--name-only", "-r", "HEAD"]);
    assert.ok(
      landed.includes("src/water.js") && landed.includes("src/sky.js"),
      `the landed build has both modules: ${landed}`,
    );
  });

  it("2. D1 union merge: two facets appending to the wiring block merge without a builder turn", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const plan = twoFacetPlan();
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet)
          return request.playtest
            ? { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) }
            : null;
        await mkdir(path.join(cwd, "src"), { recursive: true });
        const main = path.join(cwd, "src", "main.js");
        const text = await readFile(main, "utf8");
        if (!text.includes(`init${facet}`)) {
          const marker = "// ── END FACET WIRING ──";
          assert.ok(text.includes(marker), "fixture has a wiring boundary");
          const wired = text.replace(
            marker,
            `import { init${facet} } from "./${facet}.js"; init${facet}();\n${marker}`,
          );
          await writeFile(main, wired);
        }
        await writeFile(
          path.join(cwd, "src", `${facet}.js`),
          `export function init${facet}() {}\nexport const stamp = ${Date.now()};\n`,
        );
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "wireworld");
    const merges = customEvents(events, "integration_merge");
    assert.ok(
      merges.some((m) => m.union === true && m.conflict === false),
      `a wiring-block conflict was union-merged: ${JSON.stringify(merges.map((m) => [m.facetId, m.conflict, m.union]))}`,
    );
    const gameDir = path.join(rig.core.layout.gamesRoot, "wireworld");
    const landed = await readFile(path.join(gameDir, "src", "main.js"), "utf8");
    assert.match(landed, /initwater\(\)/);
    assert.match(landed, /initsky\(\)/);
    assert.doesNotMatch(landed, /^(<{7}|={7}|>{7})/m);
    // No builder was ever asked to resolve a merge by hand.
    assert.ok(
      !customEvents(events, "integration_merge").some((m) => m.conflict === true && !m.stage),
      "no facet worktree merge was left to the builder",
    );
  });

  it("3. D1 circuit breaker: two unjudgeable builds with one cause stop the facet; there is no third build", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const plan = twoFacetPlan();
    const builds: Record<string, number> = { water: 0, sky: 0 };
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet) return null;
        builds[facet]!++;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `// build ${builds[facet]} — no installStudio\n`);
        // Every build of this run fails to load the same way.
        rig.preview.next = {
          ...rig.preview.next,
          __loadError: "ReferenceError: installStudio is not defined at main.js:12",
        };
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "brokenworld");
    const breaks = customEvents(events, "facet_circuit_break");
    assert.ok(
      breaks.some((b) => b.facetId === "water"),
      `water tripped the breaker: ${JSON.stringify(breaks)}`,
    );
    assert.ok(
      breaks.some((b) => b.facetId === "sky"),
      "sky tripped the breaker",
    );
    assert.equal(builds.water, 2, "no third water build");
    assert.equal(builds.sky, 2, "no third sky build");
    const broken = customEvents(events, "facet_iteration").filter((i) => i.verdictSource === "broken");
    assert.ok(broken.length >= 2);
    // The second brief carried the actual error, not "window.__studio is missing".
    const finished = customEvents(events, "run_finished")[0]!;
    assert.ok(
      /two unjudgeable builds with the same cause/.test(
        String((finished.facets as Record<string, { stoppedBecause: string }>).water?.stoppedBecause),
      ),
      "the stop reason names the cause",
    );
  });

  it("6. D3 stills: an AVIF named .jpg is refused at save with a log; sniffing names what it is", async () => {
    assert.equal(sniffImage(AVIF_BYTES), null);
    assert.equal(describeUnknownImage(AVIF_BYTES), "AVIF");
    assert.equal(sniffImage(JPEG_BYTES)?.mimeType, "image/jpeg");
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]))?.ext, ".png");
    const rig = await startRig();
    rigs.push(rig);
    await apiOf(rig)["game.scaffold"]!({ name: "stillworld", title: "Stills" });
    const saved = await rig.core.saveReferenceFrames("stillworld", [
      { label: "image-psd-102", mimeType: "image/jpeg", data: AVIF_BYTES.toString("base64") },
      { label: "dock", mimeType: "image/jpeg", data: JPEG_BYTES.toString("base64") },
    ]);
    assert.equal(saved.length, 1, "only the real JPEG was saved");
    assert.match(saved[0]!.file, /dock-[0-9a-f]{8}\.jpg$/);
    assert.ok(
      rig.logs.some((line) => /reference skipped: image-psd-102 is AVIF/.test(line)),
      `the log says why: ${rig.logs.filter((l) => /reference/.test(l)).join(" | ")}`,
    );
    // game.read refuses the renamed file rather than declaring it a JPEG.
    const refDir = path.join(rig.core.layout.gamesRoot, "stillworld", "references");
    await writeFile(path.join(refDir, "renamed.jpg"), AVIF_BYTES);
    await assert.rejects(apiOf(rig)["game.read"]!({ project: "stillworld", file: "references/renamed.jpg" }), /AVIF/);
    const listed = await rig.core.referenceStills("stillworld");
    assert.deepEqual(
      listed.frames.map((f) => f.label),
      ["dock-" + saved[0]!.file.slice(-12, -4)],
    );
    assert.equal(listed.skipped.length, 1);
    assert.match(listed.skipped[0]!.why, /AVIF/);
  });

  it("6b. D3 stills: a run with an empty board loads references/ from disk, and the first brief carries them as images", async () => {
    const rig = await startRig();
    rigs.push(rig);
    await apiOf(rig)["game.scaffold"]!({ name: "refworld", title: "Refs" });
    const refDir = path.join(rig.core.layout.gamesRoot, "refworld", "references");
    await mkdir(refDir, { recursive: true });
    await writeFile(path.join(refDir, "dock.jpg"), JPEG_BYTES);
    await writeFile(path.join(refDir, "strider.jpg"), JPEG_BYTES);
    await writeFile(path.join(refDir, "phone.jpg"), AVIF_BYTES);
    const plan = twoFacetPlan();
    const delegations: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        delegations.push(request);
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet)
          return request.playtest
            ? { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) }
            : null;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `export const ${facet} = ${Date.now()};\n`);
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "refworld", {
      reference: { name: "Morrowind", shots: [], kind: "reference" },
      budgets: { maxIterations: 4 },
    });
    const started = customEvents(events, "run_started")[0]!;
    assert.deepEqual(
      (started.reference as { frames: string[] }).frames,
      ["dock", "strider"],
      "both readable stills, the AVIF skipped",
    );
    const decisions = customEvents(events, "autopilot_decision").map((d) => String(d.decision));
    assert.ok(
      decisions.some((d) => /loaded 2 reference still/.test(d)),
      decisions.join(" | "),
    );
    assert.ok(
      decisions.some((d) => /reference skipped: phone.jpg is AVIF/.test(d)),
      "the skipped still is a decision card",
    );
    const first = delegations.find((d) => /YOUR FACET: Water/.test(d.prompt));
    assert.ok(first, "water's first brief");
    assert.equal(
      first!.images?.filter((i) => /REFERENCE STILL/.test(i.label)).length,
      2,
      "the first brief carries both stills as images",
    );
    assert.match(first!.prompt, /images are ATTACHED to this message/);
    assert.deepEqual(first!.ownership, { facetId: "water", owns: ["src/water.js"], ownsMain: true });
    // Every facet carries the harness's style metric now that stills exist.
    const finished = customEvents(events, "run_finished")[0]!;
    const waterSpec = (finished.facets as Record<string, { spec: { checks: Array<{ id: string; kind: string }> } }>)
      .water!.spec;
    assert.ok(
      waterSpec.checks.some((c) => c.kind === "metric" && /^style-distance-/.test(c.id)),
      JSON.stringify(waterSpec.checks.map((c) => c.id)),
    );
    assert.deepEqual(finished.referenceStills, ["dock", "strider"]);
    // Flipped (Loop phase 4): a panel judged the integrated build against the stills and decided the
    // victory; no panel runs now, and the classic pipeline claims none.
    assert.equal(finished.victory, false);
    assert.equal(finished.panel, undefined, "no panel judged the build");
  });

  it("10. shooter D1 (regression guard): nine declared demos are all measured on the integration facet", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const demos = Array.from({ length: 9 }, (_, i) => `demo-${i + 1}`);
    rig.preview.demoNames = demos;
    const plan = twoFacetPlan({
      waterChecks: [
        { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        ...demos.map((name) => ({ id: name, kind: "demo", name, weight: "identity" })),
      ],
    });
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet)
          return request.playtest
            ? { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) }
            : null;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `export const ${facet} = ${Date.now()};\n`);
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "demoworld", { budgets: { maxIterations: 4 } });
    const integration = customEvents(events, "facet_iteration").filter((i) => i.facetId === "integration");
    assert.ok(integration.length >= 1, "the integration facet ran");
    const board = integration.at(-1)!.scoreboard as { results: Array<{ id: string; pass: boolean | null }> };
    for (const name of demos) {
      const entry = board.results.find((r) => r.id === name);
      assert.ok(
        entry && entry.pass === true,
        `${name} measured and passing on the integrated build: ${JSON.stringify(entry)}`,
      );
    }
    const water = customEvents(events, "facet_iteration")
      .filter((i) => i.facetId === "water")
      .at(-1)!;
    assert.equal(
      (water.scoreboard as { unmeasured: number }).unmeasured,
      0,
      "every declared demo was run for the facet that requires them",
    );
  });

  // ── provider outages and judge failures ──

  it("V1. provider outage: a 529 on the build turn is waited out and the same iteration retried — no broken streak, no circuit breaker", async () => {
    assert.equal(
      isTransientProviderError(
        "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
      ),
      true,
    );
    assert.equal(isTransientProviderError("API Error: 500 Internal server error."), true);
    assert.equal(isTransientProviderError("You've hit your weekly limit · resets Sep 1 at 10am"), false);
    assert.equal(isTransientProviderError("SyntaxError: missing ) after argument list"), false);
    assert.equal(isTransientProviderError({ kind: "usage_limit", message: "503 service unavailable" }), false);
    let calls = 0;
    const value = await withProviderPatience(
      { cancelled: false } as never,
      (async () => {
        calls++;
        if (calls < 3) throw new Error("API Error: 529 Overloaded");
        return "ok";
      }) as never,
      { delays: [5, 5, 5] },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 3);
    await assert.rejects(
      withProviderPatience(
        { cancelled: false } as never,
        async () => {
          throw new Error("weekly limit reached");
        },
        { delays: [5] },
      ),
      /weekly limit/,
    );

    const rig = await startRig();
    rigs.push(rig);
    const plan = twoFacetPlan();
    const builds: Record<string, number> = { water: 0, sky: 0 };
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet)
          return request.playtest
            ? { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) }
            : null;
        builds[facet]!++;
        // The provider is down for water's first two turns.
        if (facet === "water" && builds.water <= 2)
          return {
            ok: false,
            errorText:
              "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.",
          };
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `export const ${facet} = ${builds[facet]};\n`);
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "weatherworld", {
      budgets: { maxIterations: 4, outageDelays: [150, 150, 150] },
    });
    const outages = customEvents(events, "facet_provider_outage").filter((o) => o.facetId === "water");
    assert.equal(outages.length, 2, `two waits were logged: ${JSON.stringify(outages)}`);
    assert.ok(
      customEvents(events, "facet_circuit_break").every((b) => b.facetId !== "water"),
      "water never tripped the breaker",
    );
    const water = customEvents(events, "facet_iteration").filter((i) => i.facetId === "water");
    assert.ok(
      water.length >= 1 && water[0]!.iteration === 1 && water[0]!.verdictSource !== "broken",
      `water's first judged iteration is still iteration 1: ${JSON.stringify(water.map((i) => [i.iteration, i.verdictSource]))}`,
    );
    assert.ok(builds.water >= 3, "the third turn built for real");
  });

  it("V4. playtester gate: a vision check that keeps failing does not keep the play check unmeasured", async () => {
    const rig = await startRig();
    rigs.push(rig);
    // Flipped (Loop phase 4): the failing vision check grew from a judge's defects; no judge runs in
    // a round now, so the planner asks it.
    const plan = twoFacetPlan({
      waterChecks: [
        { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
        { id: "wade", kind: "play", ask: "Could you wade into the marsh?", weight: "normal" },
        { id: "reeds", kind: "vision", camera: "default", ask: "Are the reeds textured, not boxes?", weight: "normal" },
      ],
    });
    const builds: Record<string, number> = { water: 0, sky: 0 };
    let played = 0;
    registerFakeEngine(rig, {
      complete: (text) => {
        if (text.includes("ENGINE HINT: maxParallel")) return JSON.stringify(plan);
        if (text.includes("QUESTION:") && /reeds/.test(text))
          return JSON.stringify({ answer: "no", confidence: 0.9, note: "boxes" });
        if (text.includes("QUESTIONS (")) return answerBatch(text, { no: /reeds/, note: "boxes" });
        return null;
      },
      delegate: async (request) => {
        if (request.playtest) {
          played++;
          return {
            summary: JSON.stringify({
              answers: { wade: { answer: "yes" }, "integration-play": { answer: "yes" } },
              report: "waded",
            }),
          };
        }
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt)
          ? "water"
          : /YOUR FACET: Sky|facet "Sky"/.test(request.prompt)
            ? "sky"
            : null;
        if (!facet) return null;
        builds[facet]!++;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `export const ${facet} = ${builds[facet]};\n`);
        return { sessionId: `ses_${facet}` };
      },
    });
    const { events } = await runAutopilot(rig, "playworld", { budgets: { maxIterations: 5 } });
    const water = customEvents(events, "facet_iteration").filter((i) => i.facetId === "water");
    const withFailingVision = water.filter((i) =>
      ((i.scoreboard as { results: Array<{ id: string; kind: string; pass: boolean | null }> })?.results ?? []).some(
        (r) => r.kind === "vision" && r.pass === false,
      ),
    );
    assert.ok(
      withFailingVision.length >= 1,
      `the vision check failed on some water iteration: ${JSON.stringify(water.map((i) => (i.scoreboard as { results: Array<{ id: string; pass: boolean | null }> })?.results?.map((r) => [r.id, r.pass])))}`,
    );
    const measuredPlay = withFailingVision.filter((i) =>
      (i.scoreboard as { results: Array<{ id: string; pass: boolean | null }> }).results.some(
        (r) => r.id === "wade" && (r.pass === true || r.pass === false),
      ),
    );
    assert.ok(
      measuredPlay.length >= 1,
      `the play check was measured despite the failing vision check: ${JSON.stringify(withFailingVision.map((i) => (i.scoreboard as { results: Array<{ id: string; pass: boolean | null }> }).results.map((r) => [r.id, r.pass])))}`,
    );
    assert.ok(played >= 1, "the playtester actually played");
  });
});

describe("the modeller in the loop (AG-930)", () => {

  it("T-Snapshot. a plugin disabled while a builder's tools are prepared leaves its tools and its guidance in agreement", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        requests.push(request);
        return { sessionId: "ses" };
      },
    });
    await rig.core.games.scaffold("snapshot-world");
    const threadId = await rig.core.createGameThread("snapshot-world");
    // The disable lands in the one await every builder's preparation makes: the connectors' tool lists.
    const mcp = rig.core.mcp;
    const toolsReport = mcp.toolsReport.bind(mcp);
    mcp.toolsReport = async (...args: Parameters<typeof toolsReport>) => {
      await rig.core.plugins.setEnabled("blender", false);
      return toolsReport(...args);
    };
    await apiOf(rig)["engine.delegate"]!({
      engine: "fake-delegate",
      project: "snapshot-world",
      threadId,
      prompt: "build",
    });
    const [request] = requests;
    assert.ok(request, "the builder was asked");
    const tools = request.liveTools?.some((t) => t.name === "blender__model") ?? false;
    const guidance = request.prompt.includes("[blender/local-modeling]");
    assert.equal(guidance, tools, "a brief never names a skill whose tools it lacks, nor tools it never explains");
    assert.equal(tools, true, "both come from the plugins as the session began");
  });

  it("T-Withdrawn. a resumed builder session is told first which plugins and skills were withdrawn since it last ran", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    const hooks: FakeEngineHooks = {
      complete: () => null,
      delegate: async (request) => {
        requests.push(request);
        return { sessionId: "ses" };
      },
    };
    registerFakeEngine(rig, hooks);
    registerFakeEngine(rig, hooks, "fake-other");
    await rig.core.games.scaffold("withdrawn-world");
    const threadId = await rig.core.createGameThread("withdrawn-world");
    const delegate = async (engine: string, resume?: string) => {
      await apiOf(rig)["engine.delegate"]!({
        engine,
        project: "withdrawn-world",
        threadId,
        prompt: "build",
        ...(resume ? { resume } : {}),
      });
      const request = requests.at(-1);
      assert.ok(request);
      return request.prompt;
    };
    const notice = (prompt: string) => (prompt.startsWith("build") ? null : (prompt.split("\n\n")[0] ?? ""));

    assert.equal(notice(await delegate("fake-delegate")), null, "a first session has nothing withdrawn");
    await rig.core.plugins.setEnabled("blender", false);
    assert.equal(notice(await delegate("fake-other", "ses")), null, "another engine never had Blender");

    const resumed = notice(await delegate("fake-delegate", "ses"));
    assert.ok(resumed, "the resumed session is told before its brief");
    assert.match(resumed, /\bblender\b/);
    assert.match(resumed, /blender\/local-modeling/);
    assert.match(resumed, /ignore/i);

    assert.equal(notice(await delegate("fake-delegate", "ses")), null, "the notice is given once");
  });

  it("T-Withdrawn-Failed. a resumed attempt that fails before the session answers keeps the notice for the next resume", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const prompts: string[] = [];
    let failNext = false;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        prompts.push(request.prompt);
        if (failNext) {
          failNext = false;
          throw new Error("rate limited before the turn ran");
        }
        return { sessionId: request.resume ?? "ses" };
      },
    });
    await rig.core.games.scaffold("withdrawn-retry");
    const threadId = await rig.core.createGameThread("withdrawn-retry");
    const delegate = (resume?: string) =>
      apiOf(rig)["engine.delegate"]!({
        engine: "fake-delegate",
        project: "withdrawn-retry",
        threadId,
        prompt: "build",
        ...(resume ? { resume } : {}),
      });
    const told = () => !(prompts.at(-1) ?? "build").startsWith("build");

    await delegate();
    await rig.core.plugins.setEnabled("blender", false);
    failNext = true;
    await assert.rejects(delegate("ses"));
    assert.equal(told(), true, "the failed attempt was sent the notice");
    await delegate("ses");
    assert.equal(told(), true, "the session never answered, so the next resume is told again");
    await delegate("ses");
    assert.equal(told(), false, "once a resume answered, the notice is not repeated");
  });

  it("T-Withdrawn-Interleaved. a fresh session on the same thread and engine does not hide what an older session was handed", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const prompts: string[] = [];
    let sessions = 0;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        prompts.push(request.prompt);
        sessions += request.resume ? 0 : 1;
        return { sessionId: request.resume ?? `ses${sessions}` };
      },
    });
    await rig.core.games.scaffold("withdrawn-interleaved");
    const threadId = await rig.core.createGameThread("withdrawn-interleaved");
    const delegate = (resume?: string) =>
      apiOf(rig)["engine.delegate"]!({
        engine: "fake-delegate",
        project: "withdrawn-interleaved",
        threadId,
        prompt: "build",
        ...(resume ? { resume } : {}),
      });
    const told = () => !(prompts.at(-1) ?? "build").startsWith("build");

    await delegate(); // ses1, handed Blender
    await rig.core.plugins.setEnabled("blender", false);
    await delegate(); // ses2, a fresh builder on the same thread and engine, never handed Blender
    assert.equal(told(), false, "a fresh session has nothing withdrawn");
    await delegate("ses1");
    assert.equal(told(), true, "ses1 is still told Blender is gone");
    assert.match(prompts.at(-1) ?? "", /\bblender\b/);
  });
});

describe("the loop dies in the middle of the run (M3.9)", () => {
  /** Poll until it holds, or say what was still true when the clock ran out. */
  async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * The 1 am incident: the harness child dies, the app restarts it in seconds, and five
   * contractors keep editing worktrees for another forty minutes with no loop left to judge,
   * commit or land a single round — while the chat still says the run is running, the Mac
   * stays awake and Cmd-Q still asks about a run nobody is running. Every clause below is one
   * of those forty minutes.
   */
  it("aborts every contractor, settles the run, and closes the run in its own thread as paused with a Resume", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    // The pause itself is what this row reads: the host's automatic resume has a row of its own.
    await rig.core.updateSettings({ autoResume: false });
    const project = await rig.core.games.scaffold("crash-run", { title: "Crash run" });
    const aborts = { lead: 0, builder: 0 };
    const letBuilderGo: Array<() => void> = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          // Registered before the first tool call: the kill below may land in the middle of one.
          const aborted = new Promise<void>((resolve) =>
            request.signal!.addEventListener("abort", () => {
              aborts.lead++;
              resolve();
            }),
          );
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args).catch(() => "");
          await call("plan", {
            summary: "This run: paint the plaza.",
            workers: JSON.stringify([
              {
                id: "plaza",
                title: "Plaza",
                seam: "the plaza",
                owns: "src/plaza.js",
                done: ["the plaza is red"],
                minutes: 20,
              },
            ]),
            base: "the integration branch as it stands",
            risks: "none",
          });
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "20",
            owns: "src/plaza.js",
          });
          // A lead that lets go when it is told to — the session ends on the abort.
          await aborted;
          return { sessionId: "director-1", summary: "the lead was aborted" };
        }
        // A builder — eyes on its own worktree — that shrugs off the first signal, which is the
        // one Stop must still reach. Anything else the run briefs answers at once, so the
        // scripted lead is what the run is waiting on when the loop dies.
        if (!request.selfCapture) return null;
        return new Promise<Record<string, unknown>>((resolve) => {
          request.signal!.addEventListener("abort", () => {
            aborts.builder++;
          });
          letBuilderGo.push(() => resolve({ sessionId: "worker-1", summary: "let go" }));
        });
      },
    });

    const runId = rig.core.newRunId();
    // Never awaited: the run is meant to be in flight when the loop under it dies.
    void rig.core
      .dispatchRun({
        runId,
        goal: "a red plaza",
        project: project.name,
        mode: "autopilot",
        engine: "fake-delegate",
        reference: { name: "plaza", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      } as never)
      .catch(() => {});
    const delegations = async () =>
      (await apiOf(rig)["engine.delegations"]!({})) as Array<{ project: string; cwd: string }>;
    await until(
      async () =>
        customEvents(await rig.core.listAllEvents(), "director_worker").some(
          (e) => e.runId === runId && e.state === "running",
        ) && (await delegations()).length >= 2,
      "the lead and one builder to be building",
      180_000,
    );

    // 1 am.
    const pid = rig.core.host.pid;
    assert.ok(pid, "the harness child has a pid to kill");
    killTree(pid);

    // Nothing that was in flight can be judged or committed by a loop that no longer exists.
    await until(
      () => aborts.lead >= 1 && aborts.builder >= 1,
      `every contractor to be aborted (lead ${aborts.lead}, builder ${aborts.builder})`,
      60_000,
    );
    // …and nothing may keep the Mac awake, the quit gate armed or the pill spinning for it.
    assert.ok(
      rig.events.some((e) => e.type === "run.settled" && (e.payload as { runId?: string }).runId === runId),
      "the run settled the moment its loop died",
    );

    // The reborn loop owes the run an ending where the user is looking.
    const threadId = await rig.core.threadForGame(project.name);
    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "autopilot_paused").some((e) => e.runId === runId),
      "the paused card in the game's own chat",
      120_000,
    );
    const inThread = await rig.core.store.listEvents(threadId);
    const finished = customEvents(inThread, "run_finished").find((e) => e.runId === runId);
    assert.ok(finished, "the run was closed");
    assert.equal(finished!.stoppedBecause, "the studio's loop crashed and restarted");
    assert.equal(finished!.victory, false);
    assert.equal(finished!.project, project.name);
    const main = await rig.core.store.listEvents(rig.core.mainThread);
    assert.equal(
      customEvents(main, "run_finished").filter((e) => e.runId === runId).length,
      0,
      "the ending is in the game's chat, not the studio's",
    );
    // Paused, not dead: what makes the card's Resume real is the journal it can pick up from.
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string } | null;
    assert.equal(journal?.phase, "paused", "the journal says the run can be picked up again");

    // A contractor that did not die on the signal is still the app's to reach: its entry stays
    // registered, which is what the next test's Stop depends on.
    assert.ok(
      (await delegations()).some((d) => d.project === project.name),
      "the builder the crash could not kill is still held by the app",
    );

    for (const go of letBuilderGo) go();
  });

  /**
   * The other half of the same run: the loop that started the run is gone, so `activeRuns`
   * knows nothing about it — but the contractors are the *app's*, not the loop's, and the run's
   * own start event still says which project they were hired for. Without the fallback, Stop
   * after a restart is a notification and nothing else.
   */
  it("a run this incarnation of the loop never started can still be stopped: the builders are reached by the project its start event names", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("stop-after-restart", { title: "Stop after restart" });
    const threadId = await rig.core.threadForGame(project.name);
    const runId = "run_orphaned";
    // The run as the previous incarnation left it, and as the reborn loop's own repair closed it.
    await rig.core.store.appendEvents(threadId, [
      {
        type: "custom",
        event_type: "run_registered",
        payload: { runId, project: project.name, goal: "a red plaza", mode: "autopilot" },
      },
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId, project: project.name, goal: "a red plaza", mode: "director" },
      },
      {
        type: "custom",
        event_type: "run_finished",
        payload: {
          runId,
          project: project.name,
          victory: false,
          stoppedBecause: "the studio's loop crashed and restarted",
        },
      },
    ]);
    let aborted = 0;
    const letGo: Array<() => void> = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) =>
        new Promise<Record<string, unknown>>((resolve) => {
          request.signal!.addEventListener("abort", () => {
            aborted++;
          });
          letGo.push(() => resolve({ sessionId: "worker-1", summary: "let go" }));
        }),
    });
    const api = apiOf(rig);
    void (api["engine.delegate"] as (p: unknown) => Promise<unknown>)({
      project: project.name,
      prompt: "keep painting",
      engine: "fake-delegate",
    }).catch(() => {});
    await until(
      async () => ((await api["engine.delegations"]!({})) as unknown[]).length === 1,
      "the contractor to be building",
    );

    // The notice the host sends a reborn loop: these runs were in flight when the last one died.
    await rig.core.host.dispatch({
      type: "boot_notice",
      notice: { reason: "crash_restart", detail: "exit code 1", openRuns: [runId] },
    });
    await rig.core.host.dispatch({ type: "run_stop", runId }, 30_000);
    await until(() => aborted >= 1, "Stop to reach the contractor the previous loop briefed", 30_000);

    for (const go of letGo) go();
  });
});

/**
 * The run after the 1 am incident: paused with a Resume, and Resume pressed. The resumed run
 * used to know only what its brief said — the names of the workers from before, "gone" — and
 * nothing of what they had built, what the judges had shelved or what had happened since the
 * lead last looked; and it got a whole fresh budget, as every Resume did. Everything a run
 * needs to go on is in its journal now — the time it has worked among it, so a Resume goes on with
 * what the budget has left — and the resumed lead's first message is read from it.
 */
describe("a run the loop died in, resumed (the full journal)", () => {
  async function until(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  const BUDGET_MS = 30 * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it("crash mid-build, then Resume: the first digest names the workers and the defects nobody owns from before, and the run goes on with the working time it had left", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    // The user's own Resume is what this row reads: the host's automatic resume has a row of its own.
    await rig.core.updateSettings({ autoResume: false });
    const project = await rig.core.games.scaffold("resume-run", { title: "Resume run" });
    const lead: DelegateRequest[] = [];
    let resumed = false;
    let resumedTurnAt = 0;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          lead.push(request);
          if (resumed && !resumedTurnAt) resumedTurnAt = Date.now();
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args).catch(() => "");
          if (resumed) {
            // The resumed run: its first turn is all this row reads, so it closes the run.
            await call("finish", { land: "no", summary: "picked up where it stood" });
            return { sessionId: "lead-1", summary: "finished" };
          }
          await call("plan", {
            summary: "This run: a dusk plaza.",
            workers: JSON.stringify([
              { id: "sky", title: "Dusk sky", seam: "the sky", owns: "src/sky.js", done: ["dusk"], minutes: 20 },
              { id: "props", title: "Props", seam: "the props", owns: "src/props.js", done: ["crates"], minutes: 20 },
            ]),
            base: "the integration branch as it stands",
            risks: "none",
          });
          await call("worker_start", {
            id: "sky",
            title: "Dusk sky",
            brief: "Build a dusk sky over the plaza",
            mode: "single",
            minutes: "20",
            owns: "src/sky.js",
          });
          // The lead ends its turn: the builder builds, and the lead rests.
          return { sessionId: "lead-1", summary: "the sky is building" };
        }
        if (!request.selfCapture) return null;
        // The builder builds until the loop under it dies.
        return new Promise<Record<string, unknown>>((resolve) =>
          request.signal!.addEventListener("abort", () => resolve({ ok: false, stopReason: "stopped", summary: "" })),
        );
      },
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a dusk plaza",
        project: project.name,
        mode: "autopilot",
        engine: "fake-delegate",
        reference: { name: "Dusk", shots: [] },
        budgets: { wallClockMs: BUDGET_MS },
      } as never)
      .catch(() => {});
    const threadId = await rig.core.threadForGame(project.name);
    const journal = async () =>
      ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`).catch(() => null)) ?? null) as Record<
        string,
        any
      > | null;
    // The lead rests: its turn is over, the builder builds, and the journal holds where the run stands.
    await until(
      async () => lead.length === 1 && Boolean((await journal())?.director?.wake),
      "the lead to rest with the sky building",
      180_000,
    );
    const before = (await journal())!.director;

    // 1 am: the loop dies mid-build. The app's repair pauses the run.
    resumed = true;
    const pid = rig.core.host.pid;
    assert.ok(pid, "the harness child has a pid to kill");
    killTree(pid);
    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "autopilot_paused").some((e) => e.runId === runId),
      "the paused card",
      120_000,
    );
    // A judge had shelved one defect nobody owns before the loop died. A judged round is out of
    // this rig's reach, so it goes on the journal as the run's save writes its ledger
    // (director-journal.test.ts K2 holds that write).
    const paused = (await journal())!;
    paused.director.ledger = [
      { text: "the crates float above the plaza", from: "sky", owner: "props", at: Date.now() },
    ];
    await rig.core.store.writeArtifact(threadId, `autopilot_${runId}`, paused);
    const worked = paused.director.clock?.workedMs;
    assert.equal(
      typeof worked,
      "number",
      `the journal counts the time the run worked: ${JSON.stringify(paused.director.clock)}`,
    );

    const resumeAsked = Date.now();
    void rig.core.resumeAutopilot(runId).catch(() => {});
    await until(() => lead.length >= 2, "the resumed run's first turn", 180_000);
    const first = String(lead[1]!.prompt);
    const standsAt = first.indexOf("WHERE THE RUN STANDS:");
    assert.ok(standsAt >= 0, `the resumed run's first message has no digest:\n${first.slice(-2_000)}`);
    const stands = first.slice(standsAt).split("\n\n")[0]!;
    assert.match(stands, /^- worker sky \(Dusk sky\): /m, stands);
    assert.match(stands, /defects nobody owns: the crates float above the plaza/, stands);
    assert.ok(before.clock?.softDeadline, `the first run's journal keeps its clock: ${JSON.stringify(before.clock)}`);

    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "run_finished").filter((e) => e.runId === runId)
          .length >= 2,
      "the resumed run to close",
      180_000,
    );
    const after = (await journal())!.director;
    // The resumed run's clock was set between the Resume and its lead's first turn, to the
    // working time the budget had left: never a fresh budget, and the pause did not count.
    const soft = Date.parse(after.clock.softDeadline);
    // Flipped: the hours are the working time, a grace after them (time-cap.ts), so no reserve comes off them.
    const workingLeft = BUDGET_MS - worked;
    assert.ok(soft >= resumeAsked + workingLeft, `${iso(soft)} is before ${iso(resumeAsked + workingLeft)}`);
    assert.ok(soft <= resumedTurnAt + workingLeft, `${iso(soft)} is after ${iso(resumedTurnAt + workingLeft)}`);
    assert.match(stands, new RegExp(`wrap-up at ${utc(soft)}`), "the wrap-up when the working time it had left ends");
    assert.ok(after.clock.workedMs >= worked, "the time it worked is never given back");
  });

  it("crash mid-build with Resume builds automatically on: the host resumes the paused run once, as soon as its loop is back", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    assert.equal(rig.core.settings.autoResume, true, "on by default");
    const project = await rig.core.games.scaffold("auto-resume-run", { title: "Auto resume run" });
    const lead: DelegateRequest[] = [];
    let crashed = false;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          lead.push(request);
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args).catch(() => "");
          if (crashed) {
            await call("finish", { land: "no", summary: "picked up on its own" });
            return { sessionId: "lead-1", summary: "finished" };
          }
          await call("plan", {
            summary: "This run: a dusk plaza.",
            workers: JSON.stringify([
              { id: "sky", title: "Dusk sky", seam: "the sky", owns: "src/sky.js", done: ["dusk"], minutes: 20 },
            ]),
            base: "the integration branch as it stands",
            risks: "none",
          });
          await call("worker_start", {
            id: "sky",
            title: "Dusk sky",
            brief: "Build a dusk sky over the plaza",
            mode: "single",
            minutes: "20",
            owns: "src/sky.js",
          });
          return { sessionId: "lead-1", summary: "the sky is building" };
        }
        if (!request.selfCapture) return null;
        return new Promise<Record<string, unknown>>((resolve) =>
          request.signal!.addEventListener("abort", () => resolve({ ok: false, stopReason: "stopped", summary: "" })),
        );
      },
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a dusk plaza",
        project: project.name,
        mode: "autopilot",
        engine: "fake-delegate",
        reference: { name: "Dusk", shots: [] },
        budgets: { wallClockMs: BUDGET_MS },
      } as never)
      .catch(() => {});
    const threadId = await rig.core.threadForGame(project.name);
    const journal = async () =>
      ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`).catch(() => null)) ?? null) as Record<
        string,
        any
      > | null;
    await until(
      async () => lead.length === 1 && Boolean((await journal())?.director?.wake),
      "the lead to rest with the sky building",
      180_000,
    );

    crashed = true;
    const pid = rig.core.host.pid;
    assert.ok(pid, "the harness child has a pid to kill");
    killTree(pid);
    // Nobody presses Resume: the reborn loop pauses the run and the host picks it back up.
    await until(() => lead.length >= 2, "the run resumed without a click", 180_000);
    await until(
      async () =>
        customEvents(await rig.core.store.listEvents(threadId), "run_finished").filter((e) => e.runId === runId)
          .length >= 2,
      "the resumed run to close",
      180_000,
    );
    const events = await rig.core.store.listEvents(threadId);
    const automatic = customEvents(events, "run_auto_resumed").filter((e) => e.runId === runId);
    assert.deepEqual(
      automatic.map((e) => [e.cause, e.attempt, e.project]),
      [["loop-restart", 1, project.name]],
      "resumed once, for the loop's crash, and recorded before it resumed",
    );
    const order = events
      .filter((e) => e.data.type === "custom" && (e.data.payload as { runId?: string })?.runId === runId)
      .map((e) => (e.data as { event_type: string }).event_type)
      .filter((type) => ["autopilot_paused", "run_auto_resumed", "run_registered"].includes(type));
    assert.deepEqual(order, ["run_registered", "autopilot_paused", "run_auto_resumed", "run_registered"]);
  });
});

/**
 * "Research how to build this and write a plan, don't build yet", sent with Loop on, reached a
 * write-less interviewer whose only way forward was start_autopilot — hours of build to deliver
 * two documents. The Loop chat is a contractor now: it may
 * launch a build, and does the rest itself.
 */
describe("a Loop chat asked for research (corner-guy)", () => {
  it("corner-guy. research and a plan in Loop: the chat writes the plan itself, starts no build and takes no preview pass", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        await mkdir(path.join(request.cwd, "docs"), { recursive: true });
        await writeFile(path.join(request.cwd, "docs/fight-plan.md"), "# Plan\n");
        return {
          ok: true,
          engine: "vendor",
          sessionId: "loop-plan",
          turns: 4,
          usage: {},
          summary: "The plan is in docs/fight-plan.md. Want me to build it?",
        };
      },
    });
    await rig.core.sendUserMessage("Research how to build this and write a plan. Don't build yet.", {
      engine: "vendor",
      autopilot: { hours: 1 },
    });
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(
      request?.interviewTools?.some((tool) => tool.name === "start_autopilot"),
      "Loop still lets it launch",
    );
    assert.match(String(request?.prompt), /A request for research or a plan is not a request to build/);
    assert.ok(request?.onCapture, "a Loop chat has the Auto chat's eyes on its build");
    const started = customEvents(events, "run_registered").length + customEvents(events, "run_started").length;
    assert.equal(started, 0, "no build was started");
    // A plan is nothing the preview can show: no "black canvas" warning for the empty scaffold
    // and no failed build in the learning log.
    assert.equal(customEvents(events, "build_observation").length, 0, "a docs-only turn takes no preview pass");
    const messages = await rig.core.store.listMessages(rig.core.mainThread);
    assert.ok(
      messages.some((m) => /docs\/fight-plan\.md/.test(m.content ?? "")),
      "the answer reaches the chat",
    );
    assert.ok(!messages.some((m) => /loads clean|black|console error/.test(m.content ?? "")), "no verdict on a plan");
  });
});

import { gameRepo, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";

/**
 * A build an earlier version paused with the classic pipeline's journal was resumed by the director
 * on a session engine: it kept none of its plan, got a fresh time budget and started the whole build
 * again from its old goal. Such a build is closed as it stood, its work kept, and the chat says why.
 */
describe("a paused build from an earlier version (old-pause)", () => {
  it("old-pause. Resume on a classic journal: the build closes as it stood, never starting over on the director", {
    timeout: 60_000,
  }, async () => {
    const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("old-pause-")));
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { runId: "run_old_pause", engine: "codex" },
    });
    host.artifacts.set("autopilot_run_old_pause", {
      runId: "run_old_pause",
      run: host.run,
      plan: { facets: [{ id: "museum", title: "Museum" }] },
      phase: "paused",
      facets: { museum: { stoppedBecause: "stopped by the user" } },
      finalization: { report: { runId: "run_old_pause" } },
    });
    await host.rec.ctx.call("events.append", {
      threadId: host.threadId,
      batch: [
        {
          type: "custom",
          event_type: "run_finished",
          payload: {
            runId: "run_old_pause",
            executionStatus: "paused",
            paused: true,
            integrationHead: "head-1",
            stoppedBecause: "stopped by the user",
          },
        },
      ],
    });
    await host.dispatch({ resume: true });
    assert.equal(host.leadCalls().length, 0, "no director led it");
    const closed = host.appended("run_finished").at(-1);
    assert.match(String(closed?.stoppedBecause), /earlier version of Genex/);
    assert.equal(closed?.executionStatus, "completed", "closed, not paused again");
    assert.equal(closed?.integrationHead, "head-1", "what it built is kept");
    assert.equal(host.appended("autopilot_paused").length, 0);
  });
});

/**
 * A build paused long ago is still the chat's latest run, so its coordinator answers the chat. Work
 * the person asks for that is not that build's — "update our multiplayer" after a paused visual
 * build — had one way through: resume_run, which restarted the old build with its old goal and hours.
 * A contained change after a paused build is made in the chat by one builder, and the build stays
 * paused.
 */
describe("a change after a paused build (stale-pause)", () => {
  it("stale-pause. a contained change after a paused build: one builder makes it in the chat, nothing resumes", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("paused-plaza");
    const thread = await rig.core.createGameThread("paused-plaza");
    const runId = "run_paused_plaza";
    await rig.core.append(
      [
        { type: "messages", messages: [{ role: "user", content: "Make the plaza photoreal" }] },
        {
          type: "custom",
          event_type: "run_started",
          payload: { runId, project: "paused-plaza", goal: "a photoreal plaza", mode: "autopilot", engine: "codex" },
        },
        {
          type: "custom",
          event_type: "run_finished",
          payload: { runId, project: "paused-plaza", victory: false, stoppedBecause: "stopped by the user" },
        },
        { type: "custom", event_type: "autopilot_paused", payload: { runId, project: "paused-plaza" } },
      ],
      thread,
    );
    const answers: string[] = [];
    let built = 0;
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        if (request.coordinator) {
          const text = "Update the multiplayer packages to their newest versions";
          answers.push(
            String(
              await request.onLiveTool!("continue_build", { text, build: false }).catch((err) => `refused: ${err}`),
            ),
          );
          return {
            ok: true,
            summary: "Updating the multiplayer here.",
            sessionId: "coordinator",
            turns: 1,
            usage: {},
            engine: "codex",
          };
        }
        await writeFile(path.join(request.cwd, "multiplayer.txt"), "0.17.1");
        built++;
        return {
          ok: true,
          summary: "Updated the multiplayer.",
          sessionId: "builder",
          turns: 1,
          usage: {},
          engine: "codex",
        };
      },
    });
    await rig.core.sendUserMessage("Update our in-game multiplayer", { thread, engine: "codex" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      30_000,
      "the message answered",
    );
    assert.doesNotMatch(answers.join("\n"), /refused/, "the change is taken, not refused for a paused run");
    assert.equal(built, 1, "one builder made the change in the chat");
    assert.equal(await readFile(path.join(rig.core.games.dirFor("paused-plaza"), "multiplayer.txt"), "utf8"), "0.17.1");
    const restarted = customEvents(events, "run_registered").length + customEvents(events, "run_started").length;
    assert.equal(restarted, 1, "the paused build did not start again");
  });

  it("stale-pause words. after a paused build, only going on with that build resumes it; other work is made in the chat", async () => {
    const { afterLoopRunNote } = await import("../../src/harness-seed/loop/after-loop-run-prompts.ts");
    const { coordinatorPrompt } = await import("../../src/harness-seed/loop/coordinator-prompts.ts");
    const { coordinatorTools } = await import("../../src/harness-seed/loop/run-inbox.ts");
    const paused = {
      runId: "run_paused",
      state: "paused",
      goal: "a photoreal plaza",
      stoppedBecause: "stopped by the user",
    };
    const note = afterLoopRunNote(paused as never, "claude-code");
    const coordinator = coordinatorPrompt({
      events: [],
      run: { runId: "run_paused", state: "paused" },
      text: "update our multiplayer",
      journal: null,
      savedPlan: null,
      history: "",
    });
    const resume = coordinatorTools.find((tool) => tool.name === "resume_run")?.description ?? "";
    for (const [label, words] of [
      ["the chat's own session", note],
      ["the run's coordinator", coordinator],
      ["resume_run", resume],
    ]) {
      assert.doesNotMatch(String(words), /new instruction after a stop is a request to continue/i, `${label}`);
      assert.doesNotMatch(String(words), /or with work for it/, `${label}`);
      assert.doesNotMatch(String(words), /requests further work, including a new instruction after Stop/, `${label}`);
    }
    assert.match(note, /stays paused/, "the session's own work leaves the build paused");
    assert.match(coordinator, /build: false[^\n]*stays paused/i, "the coordinator hands other work to one builder");
  });
});

/**
 * While a Loop prepared its start (its first look at the game), the chat's messages waited for its
 * lead to sit down: twenty minutes of silence, and "stop the workers" reached nobody. The chat had no
 * way to stop a build either, and told the person to use a button. A message sent while a Loop
 * starts is answered by the chat at once, and the chat stops (and restarts) the build itself.
 */
describe("the chat while a Loop starts (chat-stop)", () => {
  it("chat-stop. a message while the Loop prepares is answered at once, and the chat's stop_run stops the build", {
    timeout: 120_000,
  }, async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("starting-plaza");
    const thread = await rig.core.createGameThread("starting-plaza");
    // The page never answers a step while the start is looked at: the Loop stays preparing.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const studioCall = rig.preview.studioCall.bind(rig.preview);
    rig.preview.studioCall = async (method, arg) => {
      await held;
      return studioCall(method, arg);
    };
    const answers: string[] = [];
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request) => {
        if (!request.coordinator) return null;
        answers.push(String(await request.onLiveTool!("stop_run", {}).catch((err) => `refused: ${err}`)));
        return { summary: "Stopping the build.", sessionId: "coordinator" };
      },
    });
    const runId = rig.core.newRunId();
    // The start answers once the run is over: the row talks to the chat meanwhile.
    const running = rig.core.dispatchRun({
      runId,
      goal: "a plaza",
      project: "starting-plaza",
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "plaza", shots: [], kind: "direction" },
      budgets: { wallClockMs: 3_600_000 },
    } as never);
    void running.catch(() => {});
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "autopilot_started").some((e) => e.runId === runId),
      60_000,
      "the run started",
    );
    await rig.core.sendUserMessage("stop the workers", { thread, engine: "fake-delegate" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      30_000,
      "the chat answered while the Loop prepared",
    );
    assert.equal(
      customEvents(events, "run_finished").filter((e) => e.runId === runId).length,
      0,
      "answered before the build closed",
    );
    assert.doesNotMatch(answers.join("\n"), /refused/, "the chat's stop is taken");
    release();
    const closed = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      60_000,
      "the build closed",
    );
    const close = customEvents(closed, "run_finished").find((e) => e.runId === runId);
    assert.match(String(close?.stoppedBecause), /stop/i, JSON.stringify(close));
    await running;
  });

  it("chat-stop restart. stop_run with restart: the build stops, then goes on again with the chat's instruction", async () => {
    const { stopAfterReply } = await import("../../src/harness-seed/loop/chat-stop.ts");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let close = () => {};
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const build = { run: { runId: "run_restart", project: "plaza" }, threadId: "thread", settled: closed, closed };
    const studio = {
      host: {
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return null;
        },
        notify: () => {},
      },
      cancels: new Set<string>(),
      activeRuns: new Map([["run_restart", build]]),
      startingRuns: new Map(),
    };
    const stopping = stopAfterReply(
      studio as never,
      { threadId: "thread", runId: "run_restart", messageId: "m1" },
      { restart: true, text: "update the multiplayer first" },
    );
    await nextTurn();
    assert.equal((build as { stopped?: boolean }).stopped, true, "the build's own Stop");
    assert.equal(studio.cancels.has("thread"), true, "and the chat's");
    assert.ok(!calls.some((c) => c.method === HostMethod.CoordinatorTool), "nothing goes on before it has stopped");
    close();
    await stopping;
    const resume = calls.find((c) => c.method === HostMethod.CoordinatorTool);
    assert.deepEqual(resume?.params, {
      threadId: "thread",
      runId: "run_restart",
      messageId: "m1",
      name: "resume_run",
      args: { text: "update the multiplayer first" },
    });
  });
});

/**
 * Steering that reached a classic build after its last round was written to the game's NOTES.md
 * under "Steering backlog" and headed the next plan. NOTES.md is read in every later chat, so a
 * "stop the workers" said to one build stayed in the game for good, telling every later agent the
 * work was cancelled. Such steering stays with the build it was said to, and the studio's old
 * section no longer reaches a later chat.
 */
describe("steering said to a closed build (stale-backlog)", () => {
  const STALE = [
    "# plaza",
    "",
    "## Pitch",
    "",
    "A plaza to skate.",
    "",
    "## Steering backlog",
    "",
    '- The user explicitly cancelled the work: "ok kill the workers". Do not begin further implementation.',
    "",
    "## Current state",
    "",
    "Playable.",
    "",
  ].join("\n");

  it("stale-backlog. a chat after that build: the old section is gone from NOTES.md and from what the agent reads, the rest kept", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.games.scaffold("backlog-plaza");
    const thread = await rig.core.createGameThread("backlog-plaza");
    const notesFile = path.join(rig.core.games.dirFor("backlog-plaza"), "NOTES.md");
    await writeFile(notesFile, STALE);
    const read: string[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        read.push(String(request.prompt), await readFile(path.join(request.cwd, "NOTES.md"), "utf8"));
        return { ok: true, summary: "Updated.", sessionId: "chat", turns: 1, usage: {}, engine: "codex" };
      },
    });
    await rig.core.sendUserMessage("Update our in-game multiplayer", { thread, engine: "codex" });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "coordinator_message_handled").length === 1,
      30_000,
      "answered",
    );
    assert.doesNotMatch(read.join("\n"), /kill the workers/, "the agent never reads the old cancellation");
    const notes = await readFile(notesFile, "utf8");
    assert.doesNotMatch(notes, /Steering backlog|kill the workers/);
    assert.match(
      notes,
      /## Pitch\n\nA plaza to skate\.\n\n## Current state\n\nPlayable\.\n/,
      "the rest of the notes stays",
    );
  });
});

/**
 * "Can you start a 3h Loop…" sent with Mode on Auto (Loop off) reached a contractor with no launch
 * tool: it worked on in its own turn and said "The 3-hour loop starts now" while no run started and
 * the Builds bar stayed empty. Asked in words, an Auto chat starts the Loop itself, for the hours named.
 */
describe("a Loop asked for in words with Mode on Auto (auto-loop)", () => {
  /** A game chat on a delegated engine whose answer records `launch`; the run's own sessions end at once. */
  async function autoChat(launch: Record<string, unknown>) {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const project = "seyda-neen";
    await rig.core.games.scaffold(project);
    const thread = await rig.core.createGameThread(project);
    const chat: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        const inTheGame = request.cwd?.endsWith(`/games/${project}`) === true;
        const ran = { ok: true, engine: "vendor", turns: 1, usage: {} };
        if (request.director || !inTheGame || chat.length > 0)
          return { ...ran, sessionId: "run-session", summary: "Looked around." };
        chat.push(request);
        return {
          ...ran,
          sessionId: "auto-chat",
          summary: "Starting the Loop.",
          studioToolCalls: [{ name: "start_autopilot", args: launch }],
        };
      },
    });
    return { rig, thread, chat };
  }
  type Json = Record<string, any>;
  const ask = { goal: "The Morrowind start scene", direction: "AAA swamp town at dawn" };
  /** The thread's registered runs in `log`, by their payloads. */
  const runsIn = (log: Parameters<typeof customEvents>[0], thread: string): Json[] =>
    customEvents(
      log.filter((e) => e.thread_id === thread),
      "run_registered",
    );
  /** The run the chat registered, once it has. */
  async function registered(rig: Rig, thread: string): Promise<Json | undefined> {
    const events = await waitForLog(rig.core, (log) => runsIn(log, thread).length > 0, 30_000, "run_registered");
    await rig.core.stopThread(thread);
    return runsIn(events, thread)[0];
  }

  it('auto-loop. "start a 3h Loop" in Auto: the chat is handed the Loop\'s start and a 3-hour run starts', async () => {
    const { rig, thread, chat } = await autoChat({ ...ask, hours: 3 });
    await rig.core.sendUserMessage("Can you start a 3h Loop on my Morrowind scene?", { thread, engine: "vendor" });
    const run = await registered(rig, thread);

    const launch = chat[0]?.interviewTools?.find((tool) => tool.name === "start_autopilot");
    assert.ok(launch, "an Auto chat may start the Loop it is asked for");
    assert.ok((launch?.parameters as Json)?.properties?.hours, "with the hours the user named");
    assert.match(String(chat[0]?.prompt), /Never say a Loop started/);
    assert.equal(run?.goal, ask.goal);
    assert.equal(run?.budgets?.wallClockMs, 3 * HOUR_MS, "for the hours named");
    assert.notEqual(run?.budgets?.untilSatisfied, true);
  });

  it('auto-loop. hours sent as text ("2h", as engines that bridge every field as text send them) still cap the run', async () => {
    const { rig, thread, chat } = await autoChat({ ...ask, hours: "2h" });
    await rig.core.sendUserMessage("Start a 2h Loop", { thread, engine: "vendor" });
    const run = await registered(rig, thread);
    assert.equal(run?.budgets?.wallClockMs, 2 * HOUR_MS);
    const launch = chat[0]?.interviewTools?.find((tool) => tool.name === "start_autopilot");
    assert.equal(launch?.onlyWhenAsked, true, "called only when asked: messages still join the turn");
  });

  it("auto-loop. a direct engine's chat (its tool loop, Loop off) starts the Loop it is asked for, for the hours named; a run's own turn never does", async () => {
    const { tools } = await import("../../src/harness-seed/tools/game-tools.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const startAutopilot = tools.find((tool) => tool.name === "start_autopilot");
    assert.ok(startAutopilot);
    const call = async (args: Record<string, unknown>, extra: Record<string, unknown>) =>
      startAutopilot.execute({ goal: "g", direction: "d", ...args }, ctxRecorder({ extra }).ctx) as Promise<
        Record<string, any>
      >;
    const rows = [
      { label: "1h named", args: { hours: "1h" }, extra: { engine: "ollama" }, hours: 1 },
      { label: "30m named", args: { hours: "30m" }, extra: { engine: "ollama" }, hours: 0.5 },
      { label: "none named: until done", args: {}, extra: { engine: "ollama" }, hours: 24 },
      { label: "a run's own turn", args: { hours: 1 }, extra: { engine: "ollama", runId: "run_x" }, hours: null },
      { label: "a follow-up's turn", args: { hours: 1 }, extra: { engine: "ollama", followupOf: "m1" }, hours: null },
    ];
    const seen = [];
    for (const { label, args, extra } of rows) {
      const outcome = await call(args, extra);
      seen.push({ label, hours: outcome.ok ? outcome.details?.run?.hours : null });
    }
    assert.deepEqual(
      seen,
      rows.map(({ label, hours }) => ({ label, hours })),
    );
  });

  it('auto-loop. "30m" is half an hour, never 30 hours', async () => {
    const { rig, thread } = await autoChat({ ...ask, hours: "30m" });
    await rig.core.sendUserMessage("Start a 30 minute Loop", { thread, engine: "vendor" });
    const run = await registered(rig, thread);
    assert.equal(run?.budgets?.wallClockMs, HOUR_MS / 2);
  });

  it('auto-loop. a Loop "until it\'s done" in Auto: no hours named, the run goes until what was asked is verified', async () => {
    const { rig, thread } = await autoChat(ask);
    await rig.core.sendUserMessage("Start a Loop and don't stop until it's really AAA", { thread, engine: "vendor" });
    const run = await registered(rig, thread);
    assert.equal(run?.budgets?.untilSatisfied, true);
  });
});

/**
 * A resumed run read its inbox from the whole log as if it were new: a wrap-up the user asked
 * of the session before the Resume told it to skip every builder and integrate having built
 * nothing (the host only narrowed this by refusing a finish on a run that was not running), and
 * every steer an earlier session had handed over went out again. Reading hand-overs from the log
 * then overshot: a director that restarted in a fresh session after the Resume never heard an
 * instruction the earlier run's director had been told, since its `wait` asked only for steers
 * no session had handed over.
 */
describe("a resumed run inherited the session before it (resume-inbox)", () => {
  const custom = (event_type: string, payload: Record<string, unknown>) => ({
    type: "custom",
    event_type,
    payload: { runId: "r", ...payload },
  });
  /** A run's thread with one steer, read by a first run and then resumed. */
  function resumedLog() {
    const log: Array<{ id: string; data: Record<string, unknown> }> = [];
    const append = (...batch: Array<Record<string, unknown>>) => {
      for (const data of batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
    };
    const ctx = {
      call: async (method: string, p: { after?: string; batch?: Array<Record<string, unknown>> }) => {
        if (method === "events.append") return append(...(p.batch ?? []));
        return p.after ? log.slice(log.findIndex((e) => e.id === p.after) + 1) : [...log];
      },
    };
    append(custom("run_registered", {}), custom("run_steering", { text: "brighter sky" }));
    return { log, append, ctx };
  }

  it("resume-inbox. a Resume forgets the earlier wrap-up and hands nothing over twice", async () => {
    const { log, append, ctx } = resumedLog();
    const loopRun = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    await loopRun.steering(undefined);
    append(
      custom("run_control", { action: "finish" }),
      custom("autopilot_paused", {}),
      custom("run_registered", { resumed: true }),
    );
    const resumedAt = log.length;
    const resumed = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    assert.equal(await resumed.finishing(), false, "the resumed run was never asked to wrap up");
    await resumed.steering(undefined);
    assert.deepEqual(log.slice(resumedAt), [], "nothing the first session handed over goes out again");
  });

  it("resume-inbox-fresh. a fresh director after a Resume hears the earlier instruction once, handed over no second time", async () => {
    const { log, append, ctx } = resumedLog();
    const loopRun = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    assert.deepEqual(await loopRun.steering(undefined, true, { onlyNew: true }), ["brighter sky"]);
    append(custom("autopilot_paused", {}), custom("run_registered", { resumed: true }));
    const resumedAt = log.length;
    const resumed = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    assert.deepEqual(await resumed.steering(undefined, true, { onlyNew: true }), ["brighter sky"]);
    assert.deepEqual(await resumed.steering(undefined, true, { onlyNew: true }), [], "once per run");
    assert.deepEqual(log.slice(resumedAt), [], "the first run already handed it over");
  });
});

/**
 * The lead's later turns (the wake loop, loop/director/wake.ts). The limit wait and the fallback
 * to a fresh session used to cover only the first session: a limit on the wrap-up paused the
 * run, and a session the engine had forgotten by the wrap-up closed it unfinished. The lead now
 * takes many turns a run, so both hold on every one of them.
 */
describe("the lead's later turns (wake loop)", () => {
  const plan = {
    summary: "This run: paint the sky.",
    workers: JSON.stringify([
      { id: "sky", title: "Sky", seam: "the sky", owns: "src/sky.js", done: ["the sky is blue"], minutes: 20 },
    ]),
    base: "the integration branch as it stands",
    risks: "none",
  };
  const start = {
    id: "sky",
    title: "Sky",
    brief: "paint the sky blue",
    mode: "single",
    minutes: "5",
    owns: "src/sky.js",
  };

  /** A run whose lead is scripted turn by turn, and whose one builder paints the sky and stops. */
  async function lateTurnLoopRun(
    name: string,
    lead: (request: DelegateRequest, turn: number) => Promise<Record<string, unknown>>,
    budgets: Record<string, unknown> = {},
    complete: FakeEngineHooks["complete"] = () => null,
  ) {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold(name, { title: name });
    const turns: DelegateRequest[] = [];
    registerFakeEngine(rig, {
      complete,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          turns.push(request);
          return lead(request, turns.length);
        }
        if (!request.selfCapture) return null;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        return { sessionId: "worker-1", summary: "painted the sky" };
      },
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a blue sky",
      project: project.name,
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "sky", shots: [] },
      budgets: { wallClockMs: 15 * 60_000, ...budgets },
    } as never);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      `${name} run_finished`,
    );
    return { turns, events, finished: customEvents(events, "run_finished").find((e) => e.runId === runId)! };
  }

  it("I1. the lead's session limit on a later turn is waited out and the same session carries on", async () => {
    const { turns, finished } = await lateTurnLoopRun("late-limit", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("plan", plan);
        await call("worker_start", start);
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      // The engine's own session limit, on a wake: it resets in a second and a half.
      if (turn === 2) throw new EngineError("rate_limit", "fake-delegate", "You've hit your session limit", 1_500);
      await call("finish", { summary: "the sky is blue", land: "no" });
      return { sessionId: "lead-1", summary: "finished" };
    });
    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(turns[2]!.resume, turns[1]!.resume, "the same session carries on");
    assert.equal(turns[2]!.resume, "lead-1");
    assert.match(turns[2]!.prompt, /limit paused you/);
    assert.match(turns[2]!.prompt, /WHAT HAPPENED/, "with the news it had not heard");
    assert.equal(finished.stoppedBecause, "the director finished the run");
    assert.doesNotMatch(String(finished.stoppedBecause), /paused/);
  });

  it("I3. a provider outage on a later lead turn is waited out, and the same session carries on", async () => {
    const { turns, finished } = await lateTurnLoopRun(
      "late-outage",
      async (request, turn) => {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (turn === 1) {
          await call("plan", plan);
          await call("worker_start", start);
          return { sessionId: "lead-1", summary: "the sky worker is building" };
        }
        // One overloaded gateway on a wake: not a limit, not the lead's fault.
        if (turn === 2) throw new EngineError("unavailable", "fake-delegate", "529 overloaded_error");
        await call("finish", { summary: "the sky is blue", land: "no" });
        return { sessionId: "lead-1", summary: "finished" };
      },
      { outageDelays: [200] },
    );
    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(turns[2]!.resume, "lead-1", "the same session carries on");
    assert.equal(turns[2]!.prompt, turns[1]!.prompt, "the turn's own message is asked again");
    assert.equal(finished.stoppedBecause, "the director finished the run", "the run was not wrapped up for it");
  });

  it("I2. a session lost on a later turn is replaced by a fresh one with the brief, the lead's notes and the news", async () => {
    const { turns, finished } = await lateTurnLoopRun("late-lost", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("plan", plan);
        await call("note", { text: "the sky first; the plaza after it" });
        await call("worker_start", start);
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      // The engine no longer knows the lead's session when it is woken.
      if (request.resume) throw new Error(`No conversation found with session ID: ${request.resume}`);
      await call("finish", { summary: "the sky is blue", land: "no" });
      return { sessionId: "lead-2", summary: "finished" };
    });
    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(turns[1]!.resume, "lead-1");
    assert.equal(turns[2]!.resume, undefined, "a fresh session");
    assert.match(turns[2]!.prompt, /^YOUR EARLIER SESSION WAS LOST/);
    assert.match(turns[2]!.prompt, /You are the DIRECTOR of run/);
    assert.match(turns[2]!.prompt, /YOUR NOTES[\s\S]*the sky first; the plaza after it/);
    assert.match(turns[2]!.prompt, /WHAT HAPPENED/);
    assert.equal(finished.stoppedBecause, "the director finished the run");
  });

  it("D11. the lead's account disabled on a wake pauses the run: workers stopped, nothing landed, no wrap-up, the user told what to fix", async () => {
    const disabled =
      "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
    const { turns, finished } = await lateTurnLoopRun("late-access-lost", async (request, turn) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (turn === 1) {
        await call("plan", plan);
        await call("worker_start", { ...start, mode: "loop" });
        return { sessionId: "lead-1", summary: "the sky worker is building" };
      }
      throw new EngineError("auth", "fake-delegate", disabled);
    });
    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.equal(finished.executionStatus, "paused", String(finished.stoppedBecause));
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { why?: string }).why, "paused");
    assert.equal((finished.limit as { kind?: string }).kind, "auth");
    assert.match(String(finished.stoppedBecause), /lost its sign-in/);
    assert.match(String(finished.stoppedBecause), /disabled Claude subscription access/);
    assert.match(String(finished.stoppedBecause), /nothing was landed/);
  });
});

/**
 * The wake loop on a clock the row moves (loop/director/wake.ts `runWakeLoop`), with no rig: one
 * running worker, and the run's log, inbox and journal as plain objects. `ticks` run on every
 * sleep, so a row can make the run move while the lead rests.
 */
function clockNight(inbox: Record<string, unknown> = {}) {
  const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);
  const at = { now: T0 };
  const ticks: Array<(now: number) => void> = [];
  const log: Array<{ at: number; seq: number; text: string; kind?: string }> = [];
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const worker = {
    id: "sky",
    title: "Sky",
    state: "running",
    iterations: [],
    brief: "paint the sky",
    deadline: T0 + HOUR_MS,
    stopRequested: false,
  };
  const state = {
    monitor: {},
    finished: false,
    limit: null as Record<string, unknown> | null,
    planReviewUntil: null,
    planGo: false,
    planSaidFrom: 0,
    workerLimit: null,
    workers: new Map([["sky", worker]]),
    integrationHead: null,
    integrationHealthy: null,
    ledger: [],
    plan: null,
    fromScratch: false,
    log,
  };
  const loopRun = {
    state,
    ctx: { cancelled: false },
    report: {},
    waitSeq: 0,
    logSeq: 0,
    started: T0,
    softDeadline: T0 + 3 * HOUR_MS,
    finalDeadline: T0 + 3.5 * HOUR_MS,
    run: { runId: "run_w", project: "sky", goal: "a blue sky", reference: { kind: "direction" } },
    journal: { director: { workers: {}, notes: [] } },
    inbox: { steering: async () => [], finishing: async () => false, ...inbox },
    routeUserSteers: async () => {},
    runningWorkers: () => [...state.workers.values()].filter((w) => w.state === "running"),
    notesSince: (seq: number) => log.filter((entry) => entry.seq > seq),
    appendRun: async (type: string, payload: Record<string, any>) => {
      events.push({ type, payload });
    },
    decision: async () => {},
    saveJournal: async () => {},
    ledgerLines: () => [],
  };
  const note = (text: string, kind?: string) => {
    loopRun.logSeq += 1;
    log.push({ at: at.now, seq: loopRun.logSeq, text, ...(kind ? { kind } : {}) });
  };
  const clock = {
    now: () => at.now,
    sleep: async (ms: number) => {
      at.now += ms;
      for (const tick of ticks) tick(at.now);
    },
  };
  /** The lead's turns, each answered by `script`; `keep` holds the session a turn answered with, as directorTalk does. */
  function lead(script: (turn: number, at: number) => Record<string, unknown>) {
    const calls: Array<{ prompt: string; sid: string | null | undefined; at: number }> = [];
    const talk: DirectorTalk = {
      sessionId: "lead-1",
      keep: async (result) => {
        if (result?.sessionId) talk.sessionId = result.sessionId;
      },
      session: async (prompt, sid) => {
        calls.push({ prompt, sid, at: at.now });
        return script(calls.length, at.now);
      },
    };
    return { talk, calls };
  }
  const run = (talk: DirectorTalk) =>
    runWakeLoop(loopRun as never, talk, () => "You are the DIRECTOR of run run_w", clock);
  const wakes = () => events.filter((e) => e.type === "director_continued").map((e) => e.payload.reasons as string[]);
  return { T0, at, ticks, loopRun, state, worker, note, lead, run, wakes };
}

/**
 * The wake loop, reviewed before it shipped: holes where a lead would sleep through the rest of
 * its working time, be woken again and again with nothing to read, open a session that knows
 * nothing, or have its last looks cut off by a wrap-up that started early.
 */
describe("the wake loop, reviewed", () => {

  it("I4. a store that refuses the hand-over of the user's words still tells the lead them once, and does not wake it again and again", async () => {
    const said: string[] = [];
    // The host's events.append fails: taking a steer (which records its hand-over) throws; reading does not.
    const w = clockNight({
      steering: async (_facet?: string, consume = true) => {
        if (consume) throw new Error("events.append failed");
        return [...said];
      },
    });
    w.ticks.push((now) => {
      if (now >= w.T0 + MINUTE_MS && !said.length) said.push("make the sky red");
      if (now >= w.T0 + 10 * MINUTE_MS && said.length === 1) said.push("and the benches oak");
    });
    const { talk, calls } = w.lead((turn) => {
      // Each turn takes the lead twenty seconds; it finishes on the first wake past 25 minutes.
      w.at.now += 20_000;
      if (turn >= 8 || w.at.now > w.T0 + 25 * MINUTE_MS) w.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await w.run(talk);

    const heads = calls.map((c) => c.prompt.split("\n")[0]);
    assert.equal(calls.length, 4, heads.join(" | "));
    assert.match(calls[1]!.prompt, /THE USER SAYS[\s\S]*make the sky red/, "the words reach the lead");
    assert.match(calls[2]!.prompt, /THE USER SAYS[\s\S]*and the benches oak/, "and the next ones, when they come");
    assert.doesNotMatch(calls[2]!.prompt, /make the sky red/, "said once");
    assert.match(heads[3]!, /quiet minutes while workers run/, "then nothing until the heartbeat");
    assert.equal(w.wakes().filter((reasons) => reasons.includes("user_message")).length, 2);
  });

  it("I6. a wrap-up the user's finish started still gives a playtest the wrap-up's time", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("late-finish", { title: "late-finish" });
    const thread = await rig.core.threadForGame(project.name);
    const runId = rig.core.newRunId();
    const turns: DelegateRequest[] = [];
    const played: DelegateRequest[] = [];
    const results: Record<string, string> = {};
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.playtest) {
          played.push(request);
          return { summary: JSON.stringify({ answers: {}, report: "played it" }) };
        }
        if (!request.director) return null;
        turns.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        if (turns.length === 1) {
          // The user asks to finish early, during the lead's first turn.
          await rig.core.append(
            [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
            thread,
          );
          return { sessionId: "lead-1", summary: "looked around" };
        }
        const answer = await call("playtest", { target: "integration", ask: "Does the sky read as blue?" });
        results.played = typeof answer === "string" ? answer : answer.text;
        await call("finish", { summary: "the user asked to finish", land: "no" });
        return { sessionId: "lead-1", summary: "finished" };
      },
    });
    await rig.core.dispatchRun({
      runId,
      goal: "a blue sky",
      project: project.name,
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "sky", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    } as never);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "late-finish run_finished",
    );

    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 80)).join(" | "));
    assert.match(turns[1]!.prompt, /The user asked to finish, so the studio starts the wrap-up now/);
    assert.equal(played.length, 1, results.played);
    const timeoutMs = Number(played[0]!.timeoutMs);
    assert.ok(timeoutMs > 2 * MINUTE_MS, `the wrap-up's playtest had ${timeoutMs} ms, not the moved working deadline`);
  });
});

/** The chat's messages as the queue's view of the log keeps them. */
const messageQueueStateOf = (log: Array<{ id: string; data: Record<string, any> }>) =>
  messageQueueState(log as never).messages;

/** Poll, yielding to the event loop, until it holds or the turns run out; whether it held. */
async function settleOn(check: () => boolean, turns = 2_000): Promise<boolean> {
  for (let n = 0; n < turns; n++) {
    if (check()) return true;
    await nextTurn();
  }
  return check();
}

/** What a message to the lead says the user said: the lines under THE USER SAYS, or none. */
function userSaysIn(prompt: string): string[] {
  const from = prompt.indexOf("THE USER SAYS");
  if (from < 0) return [];
  return prompt
    .slice(from)
    .split("\n\n")[0]!
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

/**
 * Live chat during a build (loop/live-chat.ts, loop/director/lead-line.ts), with no rig: the chat's
 * real queue hands messages to a run's real line, the run's real inbox reads them from the same
 * log, and the lead's wake loop runs on a clock the row moves, as director.ts drives it — the line
 * released when the run ends. `run({ resume })` opens a run of the same run on the same log,
 * as a Resume does; `closeBuild` is the run's close, after which the chat answers what waits.
 */
let liveChats = 0;
function liveChat() {
  const T0 = Date.UTC(2026, 8, 26, 9, 0, 0);
  // Lines are kept by run: each row's run is a run of its own.
  const RUN = `run_live_${++liveChats}`;
  const THREAD = `t_${RUN}`;
  const at = { now: T0 };
  const ticks: Array<(now: number) => void> = [];
  const log: Array<{ id: string; data: Record<string, any> }> = [];
  const steers: Array<Record<string, any>> = [];
  const answered: string[] = [];
  /** The host's knobs: a gate on appends, a hook before each read, whether it cuts a lead short, and a hold on its answer to a steer. */
  const hooks: {
    gate?: Promise<void>;
    gated: number;
    beforeList?: () => Promise<void>;
    cuts: boolean;
    steerAnswer?: Promise<void>;
  } = {
    gated: 0,
    cuts: true,
  };
  const append = (batch: Array<Record<string, any>>) => {
    for (const data of batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
    return log.at(-1)?.id ?? null;
  };
  async function call(method: string, p: Record<string, any> = {}): Promise<any> {
    if (method === HostMethod.EventsAppend) {
      if (hooks.gate) {
        hooks.gated += 1;
        await hooks.gate;
      }
      return append(p.batch ?? []);
    }
    if (method === HostMethod.EventsList) {
      await hooks.beforeList?.();
      return p.after ? log.slice(log.findIndex((e) => e.id === p.after) + 1) : [...log];
    }
    if (method === HostMethod.EngineSteer) {
      steers.push(p);
      await hooks.steerAnswer;
      // The host cuts a lead that cannot read input mid-turn short — unless it is asked not to.
      const cut = hooks.cuts && p.interrupt !== false;
      return { how: cut ? "interrupt" : null, accepted: cut ? p.messages.map((m: { id: string }) => m.id) : [] };
    }
    return null;
  }
  const host = { call, notify: () => {}, heartbeat: () => {}, workspace: "/nowhere" };
  let close = () => {};
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  const build = { run: { runId: RUN, project: "plaza" }, threadId: THREAD, settled: closed, closed, done: false };
  const studio = {
    host,
    cancels: new Set<string>(),
    moodBoards: new Map(),
    activeRuns: new Map([[RUN, build]]),
    startingRuns: new Map(),
    orphanRuns: new Map(),
  };
  const queue = new MessageQueue(
    host as never,
    async (action) => {
      answered.push(String(action.text));
    },
    (threadId, next) => chatWaitsFor(studio as never, threadId, next),
    () => false,
    (threadId, action) => leadDoor(studio as never, threadId, action),
  );
  const say = (text: string, extra: Record<string, unknown> = {}) =>
    queue.enqueue({ type: "user_message", threadId: THREAD, text, ...extra });
  /** The id the queue saved a message under, by its words. */
  const idOf = (text: string): string =>
    log.find((e) => e.data.event_type === "coordinator_message_queued" && e.data.payload.action?.text === text)!.data
      .payload.messageId;
  /** The words of the messages that went back to the chat, in order. */
  const requeued = (): string[] =>
    log
      .filter((e) => e.data.event_type === "coordinator_message_requeued")
      .map((e) => log.find((q) => q.data.payload?.messageId === e.data.payload.messageId)!.data.payload.action.text);
  const clock = {
    now: () => at.now,
    sleep: async (ms: number) => {
      at.now += ms;
      for (const tick of ticks) tick(at.now);
      await nextTurn();
    },
  };
  /** Send `text` once the clock reaches `when`. */
  const sayAt = (when: number, text: string) => {
    let sent = false;
    ticks.push((now) => {
      if (sent || now < when) return;
      sent = true;
      void say(text);
    });
  };
  /** A run of the row's; `sessionId` is the session its lead resumes, null for a lead that opens a fresh one. */
  function loopRun({ resume = false, sessionId = "lead-1" as string | null } = {}) {
    const notes: Array<{ at: number; seq: number; text: string; kind?: string }> = [];
    const worker = { id: "sky", title: "Sky", state: "running", iterations: [], brief: "paint the sky" };
    const state = {
      monitor: {},
      finished: false,
      limit: null as Record<string, unknown> | null,
      planReviewUntil: null,
      planGo: false,
      planSaidFrom: 0,
      workerLimit: null,
      workers: new Map([["sky", { ...worker, deadline: T0 + 3 * HOUR_MS, stopRequested: false }]]),
      integrationHead: null,
      integrationHealthy: null,
      ledger: [],
      plan: null,
      fromScratch: false,
      log: notes,
    };
    const ctx = {
      threadId: THREAD,
      cancelled: false,
      workspace: "/nowhere",
      call,
      notify: () => {},
      setStatus: () => {},
    };
    const n: Record<string, any> = {
      state,
      ctx,
      report: {},
      waitSeq: 0,
      logSeq: 0,
      started: at.now,
      softDeadline: at.now + 3 * HOUR_MS,
      finalDeadline: at.now + 3.5 * HOUR_MS,
      threadId: THREAD,
      run: { runId: RUN, project: "plaza", goal: "a dusk plaza", reference: { kind: "direction" } },
      resume,
      priorJournal: resume ? { director: { workers: {}, notes: [] } } : null,
      journal: { director: { workers: {}, notes: [] } },
      inbox: createRunInbox(ctx as never, { threadId: THREAD, runId: RUN }),
      routeUserSteers: async () => {},
      runningWorkers: () => [...state.workers.values()].filter((w) => w.state === "running"),
      notesSince: (seq: number) => notes.filter((entry) => entry.seq > seq),
      appendRun: async () => {},
      decision: async () => {},
      saveJournal: async () => {},
      ledgerLines: () => [],
    };
    // As director.ts opens it: live while the run goes on, recording on the run's own log.
    const line = openLeadLine(RUN, THREAD, () => !state.finished && !ctx.cancelled && !n.report.failure, ctx as never);
    const calls: Array<{ prompt: string; at: number }> = [];
    /** The run, each of the lead's turns answered by `script`; its line released when it ends, as director.ts does. */
    const run = async (script: (turn: number) => unknown) => {
      const talk: DirectorTalk = {
        sessionId,
        keep: async (result) => {
          if (result?.sessionId) talk.sessionId = result.sessionId;
        },
        session: async (prompt) => {
          calls.push({ prompt, at: at.now });
          return (await script(calls.length)) as never;
        },
      };
      await runWakeLoop(n as never, talk, () => `You are the DIRECTOR of run ${RUN}`, clock, line);
      await line.release();
    };
    return { n, state, ctx, line, calls, run };
  }
  const closeBuild = () => {
    build.done = true;
    close();
  };
  return {
    T0,
    RUN,
    at,
    ticks,
    log,
    steers,
    answered,
    hooks,
    queue,
    say,
    sayAt,
    idOf,
    requeued,
    loopRun,
    closeBuild,
    append,
  };
}

/** The lead's turn that worked on its message: a session, and a turn taken. */
const worked = { ok: true, sessionId: "lead-1", turns: 1 };

/**
 * Live chat during a build, reviewed before it shipped: every chat message is now a steer of the
 * run, so a resumed run told the lead the whole run's chat again; a failed turn, a line
 * released under a message, and a message handed while the lead's inbox was read lost or doubled
 * what the user said; a lead that cannot read input mid-turn was cut short inside a tool call; and
 * the chat's own wakes used up the lead's hourly cap.
 */
/**
 * A provider that disables the account mid-run is no verdict on anybody's work: the run pauses
 * (nothing landed, no wrap-up, Resume carries on), no round is counted broken or auto-tied, and
 * nobody asks the provider again.
 */
describe("a provider lost mid-run", () => {
  const DISABLED =
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";

  it("D6. a limit that names its reset holds its engine until then and no longer; one that names none is retried as before", () => {
    const at = Date.UTC(2026, 9, 6, 11, 7, 0);
    try {
      const limit = { kind: "rate_limit", message: "session limit", retryAfterMs: 60_000 };
      noteProviderLoss("run_limit", "claude-code", limit, at);
      assert.equal(providerLossFor("run_limit", "claude-code", at + 59_000)?.kind, "rate_limit");
      assert.equal(providerLossFor("run_limit", "claude-code", at + 60_000), null, "reset: the circuit closes");
      assert.equal(providerLossFor("run_limit", "codex", at), null, "another engine is not lost");
      assert.equal(providerLossFor("run_other", "claude-code", at), null, "nor another run");
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "rate_limit", message: "429" }, at), null);
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "other", message: "boom" }, at), null);
      assert.equal(noteProviderLoss("run_limit", "claude-code", { kind: "unavailable", message: "529" }, at), null);
    } finally {
      forgetProviderLosses("run_limit");
    }
  });

  it("D7. a lead whose account is disabled on a wake pauses the run: no wrap-up turn, the loss kept for the close", async () => {
    const w = clockNight();
    try {
      const { talk, calls } = w.lead((turn) => {
        if (turn === 1) return { ok: true, sessionId: "lead-1" };
        throw new EngineError("auth", "claude-code", DISABLED);
      });
      const outcome = await w.run(talk);
      assert.equal(calls.length, 2, calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
      assert.equal(outcome.wrapCause, null, "no wrap-up started");
      assert.equal(w.state.limit?.kind, "auth");
      assert.match(String(w.state.limit?.message), /disabled Claude subscription access/);
    } finally {
      forgetProviderLosses("run_w");
    }
  });

  it("D8. a lead's first turn that meets a disabled account pauses the run instead of crashing it", async () => {
    const w = clockNight();
    try {
      const { talk, calls } = w.lead(() => {
        throw new EngineError("auth", "claude-code", DISABLED);
      });
      await w.run(talk);
      assert.equal(calls.length, 1);
      assert.equal(w.state.limit?.kind, "auth");
    } finally {
      forgetProviderLosses("run_w");
    }
  });

  it("D9. a lead turn the provider's outage ended is not a failed turn: the run pauses, it does not wrap up", async () => {
    const w = clockNight();
    const { talk, calls } = w.lead((turn) =>
      turn === 1
        ? { ok: true, sessionId: "lead-1" }
        : { ok: false, stopReason: "error", errorText: "API Error: 529 Overloaded", sessionId: "lead-1" },
    );
    const outcome = await w.run(talk);
    assert.equal(outcome.wrapCause, null, calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.ok(
      calls.slice(1).every((c) => c.prompt === calls[1]!.prompt),
      "only the same message, asked again",
    );
    assert.equal(w.state.limit?.kind, "unavailable");
    assert.equal(w.state.limit?.retryAfterMs, null);
  });

  // Live, 2026-10-15: a 2-hour Unreal Loop ended 6 minutes in when the Mac's network dropped, and
  // its closing words said the time ran out.
  it("D9b. a lead turn that couldn't reach the API (no network, no DNS) pauses the run like any outage", async () => {
    const unreachable = [
      "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
      "API Error: connect ENETUNREACH 160.79.104.10:443",
      "API Error: connect EHOSTUNREACH 160.79.104.10:443",
      "API Error: getaddrinfo ENOTFOUND api.anthropic.com",
      "API Error: ENETDOWN",
    ];
    for (const errorText of unreachable) {
      const w = clockNight();
      const { talk } = w.lead((turn) =>
        turn === 1
          ? { ok: true, sessionId: "lead-1" }
          : { ok: false, stopReason: "error", errorText, sessionId: "lead-1" },
      );
      const outcome = await w.run(talk);
      assert.equal(outcome.wrapCause, null, errorText);
      assert.equal(w.state.limit?.kind, "unavailable", errorText);
    }
  });
});

describe("live chat during a build, reviewed", () => {
  /**
   * Run one: the lead hears "is the sky dusk yet?" (woken by it) and "then light the lamps"
   * (woken by it), then, in the turn the lamps woke, the user adds "and add some fog". The run
   * then ends as `ending` says: Stop, the app quitting mid-turn, or the engine's usage limit.
   */
  async function loopRunOne(ending: "stop" | "restart" | "limit") {
    const chat = liveChat();
    // The host refuses the words mid-turn: they wait for the lead's next message.
    chat.hooks.cuts = false;
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    chat.sayAt(chat.T0 + 2 * MINUTE_MS, "then light the lamps");
    const one = chat.loopRun();
    const quit = one.run(async (turn) => {
      if (turn < 3) return worked;
      void chat.say("and add some fog");
      await settleOn(() => chat.steers.length === 1);
      if (ending === "restart") return new Promise(() => {});
      if (ending === "limit") {
        one.state.limit = { kind: "usage_limit", message: "out of usage", retryAfterMs: null, at: chat.at.now };
        return { ok: false, stopReason: "usage_limit", sessionId: "lead-1" };
      }
      one.ctx.cancelled = true;
      return worked;
    });
    if (ending === "restart") {
      // The app quits in the middle of the turn: nothing more of this run happens, nothing is given back.
      await settleOn(() => chat.steers.length === 1);
      chat.queue.stop();
    } else {
      await quit;
      chat.closeBuild();
    }
    assert.equal(one.calls.length, 3, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    return chat;
  }

  /** Run two of the same run, resumed: the first message it opens with. */
  async function resumedFirstPrompt(chat: ReturnType<typeof liveChat>): Promise<string> {
    const two = chat.loopRun({ resume: true });
    await two.run(() => {
      two.state.finished = true;
      return worked;
    });
    return two.calls[0]!.prompt;
  }

  it("LC1a. Stop, then Resume: the resumed lead is told only what the chat said since, never the run's chat again", async () => {
    const chat = await loopRunOne("stop");
    assert.deepEqual(chat.requeued(), ["and add some fog"], "Stop gave back only what the lead never heard");
    await settleOn(() => chat.answered.length === 1);
    assert.deepEqual(chat.answered, ["and add some fog"]);
    // The chat's answer resumed the run with a new instruction (resume_run records it as a steer).
    chat.append([
      {
        type: "custom",
        event_type: "run_steering",
        payload: { runId: chat.RUN, text: "then keep going", sourceMessageId: chat.idOf("and add some fog") },
      },
    ]);
    assert.deepEqual(userSaysIn(await resumedFirstPrompt(chat)), ["then keep going"]);
  });

  it("LC1b. the app quits mid-turn, then Resume: the lead is told what it never heard — and nothing it had", async () => {
    const chat = await loopRunOne("restart");
    assert.deepEqual(chat.requeued(), [], "a quit gives nothing back: the words stay with the run");
    assert.deepEqual(userSaysIn(await resumedFirstPrompt(chat)), ["then light the lamps", "and add some fog"]);
  });

  it("LC1c. the engine's limit pauses the run, then Resume: what went back to the chat is not told again, nor what the lead heard", async () => {
    const chat = await loopRunOne("limit");
    assert.deepEqual(chat.requeued(), ["then light the lamps", "and add some fog"]);
    assert.deepEqual(userSaysIn(await resumedFirstPrompt(chat)), []);
  });

  it("LC2. a lead in the middle of a tool call is never cut short for the chat; a cut turn is told so and asked to finish what it was doing", async () => {
    const chat = liveChat();
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    const one = chat.loopRun();
    const words = (steer: Record<string, any>): string => String(steer.messages[0]?.text ?? "");
    const oak = () => chat.steers.find((steer) => words(steer).includes("and the benches oak"));
    await one.run(async (turn) => {
      if (turn === 1) return worked;
      if (turn === 3) {
        one.state.finished = true;
        return worked;
      }
      // Turn 2 is inside a tool call (an integrate, say) when the user speaks.
      one.n.toolsInFlight = 1;
      void chat.say("make the sky red");
      await settleOn(() => chat.steers.length > 0);
      // The call returned; the user speaks again, and this time the turn may be cut.
      one.n.toolsInFlight = 0;
      void chat.say("and the benches oak");
      await settleOn(() => oak() !== undefined);
      return { ok: false, stopReason: "stopped", sessionId: "lead-1", turns: 1 };
    });
    const inCall = chat.steers.filter((steer) => steer !== oak());
    assert.ok(inCall.length > 0);
    assert.ok(
      inCall.every((steer) => steer.interrupt === false),
      "inside a tool call the words wait for the turn's end",
    );
    assert.equal(oak()?.interrupt, true, "the next words, outside it, cut the turn — the waiting ones with them");
    assert.match(words(oak()!), /make the sky red[\s\S]*and the benches oak/);
    assert.equal(one.calls.length, 3);
    const resumed = one.calls[2]!.prompt;
    assert.match(resumed, /cut short/i, "the resumed turn is told it was cut");
    assert.match(resumed, /finish what you were doing/i);
    assert.deepEqual(userSaysIn(resumed), ["make the sky red", "and the benches oak"]);
  });

  it("LC3. a turn that failed before it worked on its message owes the user's words to the next one, and they are never given back twice", async () => {
    const chat = liveChat();
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    const one = chat.loopRun();
    await one.run((turn) => {
      if (turn === 1) return worked;
      if (turn === 2) throw new Error("the provider broke");
      one.state.finished = true;
      return worked;
    });
    assert.equal(one.calls.length, 3, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    assert.deepEqual(userSaysIn(one.calls[1]!.prompt), ["is the sky dusk yet?"]);
    assert.deepEqual(userSaysIn(one.calls[2]!.prompt), ["is the sky dusk yet?"], "the wrap-up says them again");
    assert.deepEqual(chat.requeued(), [], "heard in the wrap-up: nothing goes back to the chat");
  });

  it("LC5. a message handed to a lead whose run ended under it comes back at once, and the chat answers it", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    let write = () => {};
    chat.hooks.gate = new Promise<void>((resolve) => {
      write = resolve;
    });
    // The lead takes it, and its receipt is being written…
    const sending = chat.say("is it done?");
    assert.ok(await settleOn(() => chat.hooks.gated === 1), "the receipt is being written");
    // …when the run ends and its line is released.
    one.state.finished = true;
    await one.line.release();
    chat.hooks.gate = undefined;
    write();
    await sending;
    assert.deepEqual(chat.requeued(), ["is it done?"], "given back at once, not left with a run that is over");
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1), "the chat answers it");
  });

  it("LC6. a message handed while the lead's message is being read from the inbox is heard with it, and never given back", async () => {
    const chat = liveChat();
    chat.sayAt(chat.T0 + MINUTE_MS, "is the sky dusk yet?");
    let seen = false;
    let armed = false;
    let fired = false;
    chat.hooks.beforeList = async () => {
      seen ||= chat.log.some((e) => e.data.event_type === "run_steering");
      if (!armed || fired) return;
      fired = true;
      await chat.say("and the benches oak");
    };
    const one = chat.loopRun();
    // The lead's poll has seen the question and the wake is decided (the schedule reads the log's
    // lines last): the next read of the inbox is the one that tells the lead.
    const lines = one.n.notesSince;
    one.n.notesSince = (seq: number) => {
      armed ||= seen;
      return lines(seq);
    };
    await one.run((turn) => {
      if (turn === 2) one.ctx.cancelled = true;
      return worked;
    });
    assert.ok(fired);
    assert.deepEqual(userSaysIn(one.calls[1]!.prompt), ["is the sky dusk yet?", "and the benches oak"]);
    assert.deepEqual(chat.requeued(), [], "the lead heard both: Stop gives neither back");
  });

  /** Where each of the chat's messages stands, by its words. */
  const standing = (chat: ReturnType<typeof liveChat>) =>
    Object.fromEntries(
      [...messageQueueStateOf(chat.log).values()].map((m) => [
        String(m.action?.text),
        `${m.state}${m.into ? ` ${m.into}` : ""}`,
      ]),
    );
  const picture = { stills: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] };

  it("LC7. a picture waits for the chat, and plain words sent after it still reach the lead, in order", async () => {
    const chat = liveChat();
    chat.loopRun();
    await chat.say("does it look like this?", picture);
    await chat.say("make the sky red");
    await chat.say("and the benches oak");
    const lead = `delivered ${chat.RUN}`;
    assert.deepEqual(standing(chat), {
      "does it look like this?": "queued",
      "make the sky red": lead,
      "and the benches oak": lead,
    });
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["does it look like this?"], "the chat answers the picture once the build closes");
  });

  it("LC8. what waited while the run prepared reaches the lead once its line opens — past a picture among it", async () => {
    const chat = liveChat();
    // The build is under way, but its lead has no line yet: everything waits.
    await chat.say("is it started?");
    await chat.say("does it look like this?", picture);
    await chat.say("and make the sky red");
    assert.ok(await settleOn(() => Object.values(standing(chat)).every((state) => state === "queued")));
    chat.loopRun();
    const lead = `delivered ${chat.RUN}`;
    assert.ok(await settleOn(() => standing(chat)["and make the sky red"] === lead), JSON.stringify(standing(chat)));
    assert.deepEqual(standing(chat), {
      "is it started?": lead,
      "does it look like this?": "queued",
      "and make the sky red": lead,
    });
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["does it look like this?"]);
  });

  it("LC11. a picture the chat saved in the game's references reaches the lead, its file named in the words the lead reads", async () => {
    const chat = liveChat();
    chat.loopRun();
    const saved = { ...picture, references: ["references/skydome-warning-1a2b3c4d.png"] };
    await chat.say("i got this msg", saved);
    await chat.say("does it look like this?", picture);
    assert.deepEqual(standing(chat), {
      "i got this msg": `delivered ${chat.RUN}`,
      "does it look like this?": "queued",
    });
    const heard = chat.log.find((e) => e.data.event_type === "run_steering")?.data.payload.text;
    assert.match(String(heard), /^i got this msg/);
    assert.match(String(heard), /references\/skydome-warning-1a2b3c4d\.png/, "the lead is told where to look");
  });

  it("LC9. a run that crashed before its lead's loop began gives every message it was handed back to the chat", async () => {
    const back: string[][] = [];
    const line = openLeadLine("run_crash", "t_crash", () => true);
    const giveBack = async (items: Array<{ text?: string }>) => {
      back.push(items.map((item) => String(item.text)));
    };
    line.hear({ threadId: "t_crash", messageId: "m1", text: "is it started?" }, giveBack);
    line.hear({ threadId: "t_crash", messageId: "m2", text: "and the sky?" }, giveBack);
    // What director.ts does when the run crashes before `runWakeLoop` ever took the line.
    await line.release({ heardNone: true });
    assert.deepEqual(back, [["is it started?", "and the sky?"]]);
  });

  it("LC10. a message after Stop does not undo it for the run's learning pass: the chat takes the message, the pass stays stopped", async () => {
    const cancels = new Set<string>();
    const host = {
      call: async (method: string) => {
        if (method === HostMethod.EventsList) return [];
        throw new Error(`${method}: not in this row`);
      },
      notify: () => {},
    };
    const threadCtx = (threadId: string) => ({
      threadId,
      call: host.call,
      notify: host.notify,
      setStatus: () => {},
      get cancelled() {
        return cancels.has(threadId);
      },
    });
    const closedRun = {
      run: { runId: "run_done", project: "plaza" },
      threadId: "t_pass",
      settled: new Promise(() => {}),
      done: true,
    };
    const studio = {
      host,
      cancels,
      moodBoards: new Map(),
      activeRuns: new Map([["run_done", closedRun]]),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: threadCtx,
    };
    // The run has closed; its learning pass works on.
    const pass = passCtx(threadCtx("t_pass") as never, closedRun as never);
    // Stop in its chat, as the loop's dispatch takes it.
    cancels.add("t_pass");
    stopRunsOf(studio as never, "t_pass");
    // A new message: the chat's own stop is over, and it answers.
    await handleUserMessage(studio as never, { threadId: "t_pass", text: "what did you finish?" }).catch(() => {});
    assert.equal(cancels.has("t_pass"), false, "the chat takes the message");
    assert.equal(pass.cancelled, true, "the learning pass Stop reached stays stopped");
  });

  /*
   * A Codex lead could not hear the chat for its whole first turn — up to an open Loop's 45 minutes:
   * "stop, just test computer use" was shown as delivered and read by nobody until the person pressed
   * Stop. A first turn with a session to resume is cut for the words like any other.
   */
  it("LC12. a lead's first turn with a session to resume is cut short for the user's words, told so, and asked to finish", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("stop building, just test computer use");
      await settleOn(() => chat.steers.length > 0);
      return { ok: false, stopReason: "stopped", sessionId: "lead-1", turns: 4 };
    });
    assert.equal(chat.steers[0]?.interrupt, true, "the first turn may be cut for the words");
    // Read mid-turn by an engine that can, the words say how a stop is done, never only "carry on".
    assert.match(String(chat.steers[0]?.messages[0]?.text), /stop or finish[^\n]*wrap_up/i);
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    const resumed = String(one.calls[1]?.prompt);
    assert.match(resumed, /cut short/i, "the resumed turn is told it was cut");
    assert.match(resumed, /stop or finish[^\n]*wrap_up/i, "a stop is wrap_up, not finishing what it was doing");
    assert.deepEqual(userSaysIn(resumed), ["stop building, just test computer use"]);
  });

  it("LC13. a first turn cut before its session began is asked its brief again with the words, never crashing the run", async () => {
    const chat = liveChat();
    // The host's answer to the cut reaches the loop only after the failure the cut caused.
    let answer = () => {};
    chat.hooks.steerAnswer = new Promise((resolve) => {
      answer = resolve;
    });
    const one = chat.loopRun();
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("stop building");
      await settleOn(() => chat.steers.length > 0);
      setImmediate(answer);
      // The host was still preparing the session's tools when the cut came.
      throw new EngineError("aborted", "codex", "stopped before the contractor started");
    });
    assert.equal(one.calls.length, 2, one.calls.map((c) => c.prompt.slice(0, 60)).join(" | "));
    const [brief = "", again = ""] = one.calls.map((c) => c.prompt);
    assert.ok(again.includes(brief), "the brief is asked again");
    assert.deepEqual(userSaysIn(again), ["stop building"]);
  });

  it("LC14. a first turn with no session to resume yet is left alone: the words open the next message", async () => {
    const chat = liveChat();
    const one = chat.loopRun({ sessionId: null });
    await one.run(async (turn) => {
      if (turn === 2) {
        one.state.finished = true;
        return worked;
      }
      void chat.say("is it started?");
      await settleOn(() => chat.steers.length > 0);
      return { ok: true, sessionId: "lead-9", turns: 2 };
    });
    assert.equal(chat.steers[0]?.interrupt, false, "a cut would leave nothing to resume");
    assert.deepEqual(userSaysIn(String(one.calls[1]?.prompt)), ["is it started?"]);
  });

  it("LC15. a picture sent before (its file the game's already) reaches the lead: the chat names the file it is saved as", async () => {
    const chat = liveChat();
    chat.loopRun();
    // Saved before, so this message added no file of its own: only `pictureFiles` names where it is.
    const again = { ...picture, pickedImages: 1, references: [], pictureFiles: ["references/sky-1a2b3c4d.png"] };
    await chat.say("this one again", again);
    assert.deepEqual(standing(chat), { "this one again": `delivered ${chat.RUN}` });
    const heard = chat.log.find((e) => e.data.event_type === "run_steering")?.data.payload.text;
    assert.match(String(heard), /references\/sky-1a2b3c4d\.png/);
  });

  it("LC16. a picture the person's words name by its path (no picture attached) reaches the lead with the words", async () => {
    const chat = liveChat();
    chat.loopRun();
    await chat.say("look at ~/Desktop/sky.png", { ...picture, pickedImages: 0 });
    assert.deepEqual(standing(chat), { "look at ~/Desktop/sky.png": `delivered ${chat.RUN}` });
  });

  it("LC17. in the wrap-up the lead still hears the person, and the chat answers what they said once the build closes", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    one.line.wrapUp();
    await chat.say("also add rain");
    // Told to the lead, with the wrap-up's words; never delivered to the run: the chat owes the answer.
    assert.deepEqual(standing(chat), { "also add rain": "queued" });
    const told = chat.log.filter((e) => e.data.event_type === "run_steering");
    assert.equal(told.length, 1);
    assert.match(String(told[0]?.data.payload.text), /^also add rain\n\n\(You are wrapping up this build/);
    assert.equal(told[0]?.data.payload.kept, true, "marked as only told: the chat shows it where the lead heard it");
    // Never handed again while it waits, however the queue looks.
    await chat.say("and fog");
    await settleOn(() => chat.log.filter((e) => e.data.event_type === "run_steering").length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chat.log.filter((e) => e.data.event_type === "run_steering").length, 2, "each told once");
    assert.deepEqual(chat.answered, [], "nothing answered while the build closes");
    await one.line.release();
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 2));
    assert.deepEqual(chat.answered, ["also add rain", "and fog"], "the chat answers both, in order, once it closed");
  });

  it("LC18. a lead in its wrap-up turn hears what the person sends at its next step, told the chat takes up new work", async () => {
    const chat = liveChat();
    const one = chat.loopRun();
    // Working time is over: the first turn is the wrap-up.
    one.n.softDeadline = chat.at.now - 1;
    await one.run(async (turn) => {
      if (turn === 1) {
        void chat.say("also add rain");
        await settleOn(() => chat.steers.length > 0);
      }
      one.state.finished = true;
      return worked;
    });
    assert.equal(chat.steers[0]?.interrupt, false, "the wrap-up is never cut short");
    assert.match(String(chat.steers[0]?.messages[0]?.text), /also add rain[\s\S]*You are wrapping up this build/);
    chat.closeBuild();
    assert.ok(await settleOn(() => chat.answered.length === 1));
    assert.deepEqual(chat.answered, ["also add rain"], "and the chat answers it once the build closed");
  });
});

/**
 * Messages without a queue: a message the person sent while the chat's answer ran 3 workers for 28
 * minutes had switched the Loop on, so it never joined the answer and sat in Queued for 21 minutes;
 * a Stop pressed to get it going handed over at once, and the next press stopped it. Now it reaches
 * the answer at its next step, which goes on with its settings, and a wait ends when the person writes.
 */
describe("messages without a queue", () => {
  const ok = (summary: string, sessionId: string) => ({
    ok: true,
    summary,
    sessionId,
    turns: 1,
    usage: {},
    engine: "x",
  });
  const cut = (sessionId: string) => ({
    ok: false,
    summary: "",
    stopReason: "stopped",
    sessionId,
    turns: 2,
    usage: {},
    engine: "x",
  });

  it("NQ1. the Loop switched on while the chat's answer works reaches that answer at its next step, which goes on in the Loop", async () => {
    const log: Array<{ id: string; data: Record<string, any> }> = [];
    let onCut = () => {};
    const host = {
      call: async (method: string, p: Record<string, any>) => {
        if (method === HostMethod.EventsAppend)
          for (const data of p.batch) log.push({ id: String(log.length + 1).padStart(6, "0"), data });
        if (method === HostMethod.EventsList) return log;
        if (method === HostMethod.EngineSteer) {
          onCut();
          return { how: "interrupt", accepted: p.messages.map((m: { id: string }) => m.id) };
        }
        return null;
      },
      notify: () => {},
    };
    const legs: Array<{ prompt: string; resume: string | null; loop: boolean }> = [];
    let running = () => {};
    const working = new Promise<void>((resolve) => {
      running = resolve;
    });
    const queue = new MessageQueue(host as never, async (action, steer) => {
      if (action.text !== "build the boss fight") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "BRIEF",
        call: async (prompt, resume) => {
          legs.push({ prompt, resume, loop: false });
          const cutNow = new Promise<void>((resolve) => {
            onCut = resolve;
          });
          running();
          await cutNow;
          return cut("s1") as never;
        },
        switches: {
          changes: (item) => Boolean(item.autopilot),
          takes: () => true,
          apply: async () => ({
            call: async (prompt, resume) => {
              legs.push({ prompt, resume, loop: true });
              return ok("Starting the Loop.", "s1") as never;
            },
            newSession: false,
            notes: ["The Loop is on."],
          }),
        },
      });
    });
    await queue.enqueue({
      type: "user_message",
      threadId: "chat",
      text: "build the boss fight",
      engine: "claude-code",
    });
    await working;
    await queue.enqueue({
      type: "user_message",
      threadId: "chat",
      text: "make it in the loop",
      engine: "claude-code",
      autopilot: {},
    });
    assert.ok(await settleOn(() => legs.length === 2));
    const states = () => [...messageQueueState(log as never).messages.values()].map((m) => [m.action?.text, m.state]);
    assert.deepEqual(legs[1], {
      prompt: switchedTurnPrompt(["The Loop is on."], steeredTurnPrompt(["make it in the loop"])),
      resume: "s1",
      loop: true,
    });
    assert.ok(
      await settleOn(
        () =>
          [...messageQueueState(log as never).messages.values()].find((m) => m.action?.text === "make it in the loop")
            ?.state === "delivered",
      ),
      JSON.stringify(states()),
    );
    queue.stop();
  });
});

/**
 * One session, reviewed: holes a lead would have fallen into — a conflict worker committing the
 * markers it left, changes no worker made stopping every merge for good, a first turn crashing the
 * run because the lead's lock was still held — and, once the lead was limited only by the chat's
 * permission mode, what its own commands leave in the game folder at the landing.
 */
describe("one session, reviewed", () => {
  /** A ctx whose `run.exec` runs the command here, in the folder it names — real git, no host. */
  const localCtx = () => ({
    workspace: "/nonexistent",
    cancelled: false,
    notify() {},
    call: async (method: string, p: { command: string; cwd: string }) => {
      if (method !== HostMethod.RunExec) return null;
      try {
        const { stdout, stderr } = await promisify(execFile)("sh", ["-c", p.command], {
          cwd: p.cwd,
          maxBuffer: 10_000_000,
        });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
  });

  it("OS3. a first turn the host refused because the lead's lock was held is asked again after a wait, and the run goes on", async () => {
    const w = clockNight();
    const busy = () => Object.assign(new Error('a contractor is already building in "sky"'), { code: "folder_busy" });
    const { talk, calls } = w.lead((turn) => {
      if (turn === 1) throw busy();
      w.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await w.run(talk);
    assert.equal(calls.length, 2, "asked once more");
    assert.equal(calls[1]!.prompt, calls[0]!.prompt, "the same first message");
    assert.ok(calls[1]!.at > calls[0]!.at, "after a wait on the loop's own clock");
  });

  it("OS4. a first turn the lead's lock stays busy for ends as a failed turn — the run closes on its own terms, not in a crash", async () => {
    const w = clockNight();
    const { talk } = w.lead(() => {
      throw Object.assign(new Error("busy"), { code: "folder_busy" });
    });
    const outcome = await w.run(talk);
    assert.equal(outcome.failed?.ok, false, "the loop says which turn failed");
  });

  /**
   * A lead run on the real rig: the lead plans and starts one builder that paints the sky, and on
   * its next turn integrates it, runs `beforeFinish` (its own commands, in either folder) and
   * finishes.
   */
  async function leadClose(name: string, beforeFinish: (request: DelegateRequest) => Promise<void>) {
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 2,
        createHeadlessPreview: async () => makeFakePreview(),
      },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold(name, { title: name });
    const results: Record<string, any> = {};
    let turns = 0;
    registerFakeEngine(rig, {
      complete: () => null,
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          const call = (tool: string, args: Record<string, unknown>) => request.onLiveTool!(tool, args);
          if (++turns === 1) {
            await call("plan", {
              summary: "This run: paint the sky.",
              workers: JSON.stringify([
                {
                  id: "sky",
                  title: "Sky",
                  seam: "the sky",
                  owns: "src/sky.js",
                  done: ["the sky is blue"],
                  minutes: 20,
                },
              ]),
              base: "the integration branch as it stands",
              risks: "none",
            });
            await call("worker_start", {
              id: "sky",
              title: "Sky",
              brief: "paint the sky blue",
              mode: "single",
              minutes: "5",
              owns: "src/sky.js",
            });
            return { sessionId: "lead-1" };
          }
          if (results.finished) return { sessionId: "lead-1" };
          results.integrated = await call("integrate", { worker: "sky" });
          await beforeFinish(request);
          results.finished = await call("finish", { summary: "the sky is blue", land: "yes" });
          return { sessionId: "lead-1" };
        }
        if (!request.selfCapture) return null;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        return { sessionId: "worker-1", summary: "painted the sky" };
      },
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a blue sky",
      project: project.name,
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "sky", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    } as never);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      `${name} run_finished`,
    );
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    return { project, runId, results, finished };
  }
  const gitIn = async (cwd: string, args: string[]) => (await gitFile(args, { cwd })).stdout.trim();

  it("OS5. the lead's own file in the game folder stops the landing: the close names it and blames nobody, never 'changes of your own'", async () => {
    const { project, runId, results, finished } = await leadClose("os5-lead-in-game", async (request) => {
      // The lead, whose cwd is the game folder, wrote the file its builder also adds.
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'what the lead tried';\n");
    });
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal((finished.landingResult as { why: string }).why, "uncommitted-changes");
    assert.doesNotMatch(results.finished, /of your own/, results.finished);
    assert.match(
      results.finished,
      /git would not land this build over what is uncommitted in the game folder — src\/sky\.js\. No worker did this/,
    );
    assert.match(results.finished, /leave it as it is/, "never an invitation to clear the folder");
    const close = (finished.verdicts as Array<{ pass: string; because: string }>).find((v) => v.pass === "close")!;
    assert.doesNotMatch(close.because, /of (?:your|its) own/, close.because);
    // The sentence is kept in the game's lessons and read by the next run's lead: no order in it.
    assert.match(close.because, /left beside it, waiting for Make it live\.$/);
    // Nothing forced: the file as the lead left it, and the build on its ref for Make it live.
    assert.equal(await gitIn(project.dir, ["status", "--porcelain"]), "?? src/sky.js");
    assert.equal(
      await readFile(path.join(project.dir, "src", "sky.js"), "utf8"),
      "export const sky = 'what the lead tried';\n",
    );
    assert.equal(
      await gitIn(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]),
      finished.integrationHead,
    );

    // What the lead's own test run leaves beside the build does not stop it, and the lead is told.
    const beside = await leadClose("os5-lead-beside", async (request) => {
      await mkdir(path.join(request.cwd, "test-results"), { recursive: true });
      await writeFile(path.join(request.cwd, "test-results", ".last-run.json"), '{"status":"passed"}\n');
    });
    assert.equal(beside.finished.landed, true, beside.results.finished);
    assert.match(
      beside.results.finished,
      /is live in the game folder \([^)]*\) — the game folder still has uncommitted changes the landing left as they were — test-results\/; they are not part of this build — tell the user, and leave them as they are/,
    );
    assert.equal(await gitIn(beside.project.dir, ["status", "--porcelain"]), "?? test-results/");
  });

  /**
   * A game folder at `base` and a build that adds src/sky.js, and the landing (`landIntegration`)
   * over a run of real git in them: the close's own look and head are not the question here.
   */
  async function landingOver(prepare: (git: (...a: string[]) => Promise<string>, dir: string) => Promise<void>) {
    const { tmpDir } = await import("../helpers/tmp.ts");
    const dir = await tmpDir("one-session-landing-");
    const git = async (...args: string[]) => (await gitFile(args, { cwd: dir })).stdout.trim();
    await git("init", "-q", "-b", "main");
    await git("config", "user.email", "t@t");
    await git("config", "user.name", "t");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "a game\n");
    await writeFile(path.join(dir, "src", "sign.js"), "export const sign = 'none';\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    const base = await git("rev-parse", "HEAD");
    await git("checkout", "-qb", "run");
    await writeFile(path.join(dir, "src", "sky.js"), "export const sky = 'blue';\n");
    await git("add", "-A");
    await git("commit", "-qm", "the run's build");
    const head = await git("rev-parse", "HEAD");
    await git("checkout", "-q", "main");
    const worktree = await tmpDir("one-session-landing-wt-");
    await git("worktree", "add", "-q", "--detach", worktree, head);
    await prepare(git, dir);
    const notes: string[] = [];
    const report: Record<string, unknown> = {};
    const exec = localCtx();
    const loopRun = {
      ctx: {
        ...exec,
        call: (method: string, p: Record<string, any>) => exec.call(method, { ...p, cwd: p.cwd ?? dir } as never),
      },
      run: { runId: "run_os6", project: "landing" },
      lead: { folder: dir },
      baseCommit: base,
      projectDir: dir,
      integrationWorktree: worktree,
      integrationRef: "refs/studio/runs/run_os6/integration",
      state: { integrationHead: head },
      report,
      note: (text: string) => notes.push(text),
      syncHead: async () => head,
      nestedGit: async () => "",
      landingClaim: () => ({ verified: false, how: "fresh-health-pass", line: "made live, not judged better" }),
    };
    const landed = await landIntegration(loopRun as never, true);
    return { landed, git, dir, head, notes, report };
  }

  it("OS6. the landing tells uncommitted changes in the game folder from commits that conflict or a hook that refuses, and never undoes a merge of the user's own under way", async () => {
    // Only a stray the build does not touch: it lands, and the stray is named, left as it was.
    const clean = await landingOver(async (_git, dir) => {
      await writeFile(path.join(dir, "notes.txt"), "mine\n");
    });
    assert.equal(clean.landed.ok, true, clean.landed.reason);
    assert.deepEqual(clean.landed.leftInGame, ["notes.txt"]);
    assert.equal(await clean.git("status", "--porcelain"), "?? notes.txt");
    assert.match(clean.notes.join("\n"), /still has uncommitted changes the landing left as they were — notes\.txt/);

    // A hook of the user's that refuses the merge, beside an unrelated stray: git's words, not the stray's blame.
    const hooked = await landingOver(async (git, dir) => {
      await git("config", "core.hooksPath", ".git/hooks");
      await writeFile(
        path.join(dir, ".git", "hooks", "pre-merge-commit"),
        "#!/bin/sh\necho 'no merges today' >&2\nexit 1\n",
        {
          mode: 0o755,
        },
      );
      await writeFile(path.join(dir, "notes.txt"), "mine\n");
    });
    assert.equal(hooked.landed.why, "could-not-land", hooked.landed.reason);
    assert.match(hooked.landed.reason, /no merges today/);
    assert.equal(await hooked.git("status", "--porcelain"), "?? notes.txt");

    // A commit in the folder that conflicts, beside an unrelated stray: a conflict, not the stray's doing.
    const conflict = await landingOver(async (git, dir) => {
      await writeFile(path.join(dir, "src", "sky.js"), "export const sky = 'red';\n");
      await git("add", "-A");
      await git("commit", "-qm", "mine: a red sky");
      await writeFile(path.join(dir, "notes.txt"), "mine\n");
    });
    assert.equal(conflict.landed.why, "could-not-land", conflict.landed.reason);
    assert.equal(await conflict.git("status", "--porcelain"), "?? notes.txt", "the merge was aborted, the stray kept");

    // A merge of the user's own under way, its conflict resolved and staged: never merged into, never aborted.
    const underWay = await landingOver(async (git, dir) => {
      await git("checkout", "-qb", "theirs");
      await writeFile(path.join(dir, "README.md"), "a game, theirs\n");
      await git("commit", "-qam", "theirs");
      await git("checkout", "-q", "main");
      await writeFile(path.join(dir, "README.md"), "a game, mine\n");
      await git("commit", "-qam", "mine");
      await git("merge", "-q", "theirs").catch(() => {});
      await writeFile(path.join(dir, "README.md"), "a game, ours\n");
      await git("add", "README.md");
    });
    assert.equal(underWay.landed.why, "uncommitted-changes", underWay.landed.reason);
    assert.match(underWay.landed.reason, /README\.md/);
    assert.doesNotMatch(underWay.landed.reason, /of your own/);
    assert.ok(await underWay.git("rev-parse", "-q", "--verify", "MERGE_HEAD"), "their merge is still under way");
    assert.equal(await underWay.git("diff", "--cached", "--name-only"), "README.md", "its resolution still staged");
    assert.equal(await readFile(path.join(underWay.dir, "README.md"), "utf8"), "a game, ours\n");

    // The same merge resolved to their own side: nothing for git status to show, and still under way.
    const ours = await landingOver(async (git, dir) => {
      await git("checkout", "-qb", "theirs");
      await writeFile(path.join(dir, "README.md"), "a game, theirs\n");
      await git("commit", "-qam", "theirs");
      await git("checkout", "-q", "main");
      await writeFile(path.join(dir, "README.md"), "a game, mine\n");
      await git("commit", "-qam", "mine");
      await git("merge", "-q", "theirs").catch(() => {});
      await git("checkout", "--ours", "README.md");
      await git("add", "README.md");
    });
    assert.equal(await ours.git("status", "--porcelain"), "", "nothing to show");
    assert.equal(ours.landed.why, "uncommitted-changes", ours.landed.reason);
    assert.match(ours.landed.reason, /a merge under way/);
    assert.ok(await ours.git("rev-parse", "-q", "--verify", "MERGE_HEAD"), "their merge is still under way");
  });
});

describe("the Loop's time limit", () => {
  /**
   * The composer's ∞ ("until satisfied") reached the log as a plain 24-hour budget, so every
   * surface that read the run back called it a 24 h build and the composer could not tell it from
   * a user who picked 24 h.
   */
  it("L1. ∞ Loop is recorded as until satisfied, not as a 24-hour cap", async () => {
    const { tools } = await import("../../src/harness-seed/tools/game-tools.ts");
    const { intakeBudgets } = await import("../../src/harness-seed/loop/chat-dispatch.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const startAutopilot = tools.find((tool) => tool.name === "start_autopilot");
    assert.ok(startAutopilot, "the seed ships start_autopilot");
    const launch = async (autopilot: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const ctx = ctxRecorder({ extra: { autopilot } }).ctx;
      const outcome = await startAutopilot.execute({ goal: "g", direction: "d" }, ctx);
      assert.ok(typeof outcome === "object" && outcome.details, "start_autopilot answers with the run");
      return outcome.details.run as Record<string, unknown>;
    };

    const unbounded = await launch({ frames: [] });
    assert.equal(unbounded.untilSatisfied, true);
    assert.equal(unbounded.hours, 24, "the 24-hour ceiling stays as the safety cap");
    const capped = await launch({ hours: 24, frames: [] });
    assert.equal("untilSatisfied" in capped, false, "a picked 24 h is a cap, not ∞");

    assert.deepEqual(intakeBudgets(unbounded), {
      wallClockMs: 86_400_000,
      untilSatisfied: true,
      completionPolicy: "goal",
    });
    assert.deepEqual(intakeBudgets({ hours: 0.5 }), { wallClockMs: 1_800_000, completionPolicy: "duration" });
  });
});

it("CAT-1. provider default must not inject a pinned planner", async () => {
  const { resolveRoles } = await import("../../src/harness-seed/loop/model-roles.ts");
  assert.deepEqual(resolveRoles("claude-code", undefined), {
    planner: undefined,
    builder: undefined,
    judge: undefined,
  });
});

describe("a run started again after a close of its own", () => {
  const threadId = "thread_again";
  const runId = "run_again";
  const run = {
    runId,
    project: "plaza",
    goal: "a dusk plaza",
    engine: "codex",
    mode: "autopilot",
    reference: { name: "plaza", shots: [] },
    budgets: { wallClockMs: HOUR_MS },
  };
  /** One record of the thread's log, as the host keeps it. */
  type Logged = { type: string; event_type?: string; message?: string; payload?: Record<string, unknown> };
  /** The log as the earlier session left it: the run registered, then closed. */
  const closedLog = (): Array<{ id: string; data: Logged }> => [
    { id: "e1", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: false } } },
    {
      id: "e2",
      data: {
        type: "custom",
        event_type: "run_finished",
        payload: { runId, project: "plaza", victory: false, executionStatus: "completed" },
      },
    },
  ];

  /**
   * Start the run again, as a resume, on a host that keeps `log` and lists it from a cursor as the
   * host does. The engine is session-capable, so the run is a director's; no game has its name,
   * so the run cannot ready its folder and throws. Answers the run's ctx and what the app was told.
   */
  async function startAgain(
    log: Array<{ id: string; data: Logged }>,
    extra: Record<string, unknown> = {},
    hostAnswers: Record<string, (params?: { artifactId?: string }) => unknown> = {},
  ) {
    const { handleRunStart } = await import("../../src/harness-seed/loop/run-dispatch.ts");
    /** What the run's host calls carry here: a batch to append, or a cursor to list from. */
    type Params = { batch?: Logged[]; after?: string };
    const answers: Record<string, (params?: Params) => unknown> = {
      [HostMethod.EventsList]: (params) =>
        params?.after ? log.slice(log.findIndex((entry) => entry.id === params.after) + 1) : [...log],
      [HostMethod.EngineDescribe]: () => [{ id: "codex", kind: "delegated" }],
      [HostMethod.GameList]: () => [],
      ...hostAnswers,
    };
    const failed: unknown[] = [];
    const host = {
      workspace: "/nonexistent",
      notify: (method: string, payload: unknown) => {
        if (method === "run.failed") failed.push(payload);
      },
      call: async (method: string, params?: Params): Promise<unknown> => {
        if (method === HostMethod.EventsAppend)
          for (const data of params?.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return answers[method]?.(params) ?? null;
      },
    };
    const ctx: { runInbox?: RunInbox } & Record<string, unknown> = {
      ...host,
      host,
      threadId,
      cancelled: false,
      setStatus: () => {},
    };
    const studio = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ctx,
    };
    await handleRunStart(studio as never, { type: "run_start", threadId, run: run as never, resume: true, ...extra });
    return { ctx, failed };
  }

  /**
   * A run registered again after an earlier session of it closed — a Resume of a paused run, or
   * a finished build its chat's own session reopens — that threw before it wrote its own close:
   * `closeFailedRun` took the earlier session's `run_finished` for this session's and wrote none,
   * so the log kept the new `run_registered` unmatched and the run read as running for good.
   */
  // Flipped: refused with words at the run's start and kept paused (Resume tries again), never failed for good.
  it("a resumed run whose journal cannot be read stays paused, instead of starting over with a full budget", async () => {
    const log = closedLog();
    await startAgain(
      log,
      {},
      {
        [HostMethod.ArtifactRead]: (params) => {
          if (params?.artifactId === `autopilot_${runId}`) throw new Error("journal read failed: EIO");
          return null;
        },
      },
    );
    const closes = log
      .map((entry) => entry.data)
      .filter((data) => data.event_type === "run_finished" && data.payload?.runId === runId);
    const own = closes.at(-1)?.payload;
    assert.equal(own?.stoppedBecause, OPEN_LOOP_REFUSAL.journalUnreadable, JSON.stringify(closes));
    assert.equal(own?.executionStatus, "paused", "the run stays paused for a Resume");
  });

  it("a resumed or reopened run that throws before its own close still closes: an earlier session's close is not this one's", async () => {
    const log = closedLog();
    const { failed } = await startAgain(log);

    const records = log.map((entry) => entry.data);
    const registered = records.findLastIndex(
      (data) => data.event_type === "run_registered" && data.payload?.runId === runId,
    );
    assert.ok(registered > 1, "the run was registered again after its earlier close");
    const errorAt = records.findIndex((data, i) => i > registered && data.type === "error");
    assert.ok(errorAt > registered, `the run threw: ${JSON.stringify(records.slice(registered))}`);
    const ownClose = records
      .slice(registered + 1)
      .filter((data) => data.event_type === "run_finished" && data.payload?.runId === runId);
    assert.equal(ownClose.length, 1, `this session closes the run: ${JSON.stringify(records.slice(registered))}`);
    assert.equal(ownClose[0]?.payload?.executionStatus, "failed");
    assert.equal(ownClose[0]?.payload?.victory, false);
    assert.equal(failed.length, 1, "the app is told the run failed");
  });

  /**
   * A finished build reopened hears the user from the ask the chat recorded for it
   * (loop/reopen-run.ts gives the cursor): a steer left on the run after its close and before that
   * ask — a Stop that came before a start — is not the reopened run's to hear.
   */
  it("a reopened run's inbox reads from the cursor its start carries: a steer left before the ask is not told", async () => {
    const log = closedLog();
    const steer = (text: string): Logged => ({ type: "custom", event_type: "run_steering", payload: { runId, text } });
    log.push({ id: "e3", data: steer("old note") }, { id: "e4", data: steer("add enemies") });
    const { ctx } = await startAgain(log, { reopen: { after: "e3" } });

    assert.deepEqual(await ctx.runInbox?.steering(undefined, false), ["add enemies"]);
  });

  /**
   * A finished build reopened from a message on other models went on building and judging on the
   * finished run's: the reopen (loop/reopen-run.ts `reopenedRun`) replaced only the planner, and the
   * run's start never resolves an applied run's roles again (model-roles.ts `withRoles`), so the
   * Loop's roles, the effort and the preferences the message was sent with were ignored.
   */
  it("RO4. a reopened run builds and judges on the reopening message's picks: only its planner is the session's model", async () => {
    const { reopenAfterReply } = await import("../../src/harness-seed/loop/reopen-run.ts");
    const finished = {
      ...run,
      roles: { planner: "gpt-5.6-sol", builder: "gpt-5.6-sol", judge: "gpt-5.6-sol" },
      rolesApplied: true,
      model: "gpt-5.6-sol",
      judgeEngine: "codex",
      judgeModel: "gpt-5.6-sol",
    };
    const log = closedLog();
    let journal: unknown = { phase: "done", run: finished, director: { lead: { chatSession: true } } };
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params: { batch?: Logged[]; value?: unknown }): Promise<unknown> => {
        if (method === HostMethod.EventsList) return [...log];
        if (method === HostMethod.ArtifactRead) return journal;
        if (method === HostMethod.ArtifactWrite) journal = params.value;
        if (method === HostMethod.EventsAppend)
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return null;
      },
    };
    const studio = { host, cancels: new Set<string>(), moodBoards: new Map(), activeRuns: new Map() };
    const loopRun = {
      runId,
      state: "finished",
      engine: "codex",
      model: "gpt-5.6-terra",
      messageId: "m9",
      reopenable: true,
    };
    const roles = {
      planner: "gpt-5.6-terra",
      builder: "opus",
      judge: "gpt-5.6-luna",
      engines: { builder: "claude-code" },
    };
    const ask = {
      hours: 2,
      text: "add enemies",
      words: "add enemies",
      models: { model: "gpt-5.6-terra", roles, effort: "medium" },
    };
    const started: Array<Record<string, unknown>> = [];
    const start = async (reopened: Record<string, unknown>) => void started.push(reopened);
    await reopenAfterReply(
      studio as never,
      { threadId, cancelled: false },
      loopRun as never,
      ask as never,
      start as never,
    );

    const [reopened] = started;
    assert.deepEqual(
      {
        runId: reopened?.runId,
        planner: (reopened?.roles as { planner?: string } | undefined)?.planner,
        model: reopened?.model,
        builderEngine: reopened?.builderEngine,
        judgeEngine: reopened?.judgeEngine,
        judgeModel: reopened?.judgeModel,
        effort: reopened?.effort,
      },
      {
        runId,
        planner: "gpt-5.6-terra",
        model: "opus",
        builderEngine: "claude-code",
        judgeEngine: "codex",
        judgeModel: "gpt-5.6-luna",
        effort: "medium",
      },
    );
  });

  /**
   * The loop died under a run started again after a close of its own — a Resume of a paused run,
   * or a finished build reopened — while the app lived on: the host restarted the loop and named the
   * run among the runs in flight (`BootNotice.openRuns`), but the reborn loop (boot-notice.ts
   * `runsIn`) took the earlier session's `run_finished` for this one's and closed nothing, so the chat
   * read the run as running until the next launch of the app.
   */
  it("RO3. a run started again after a close of its own, left open by a loop crash, is closed by the reborn loop: an earlier session's close is not this one's", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const log = [
      ...closedLog(),
      { id: "e3", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: true } } },
    ];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { threadId?: string; batch?: Logged[] }): Promise<unknown> => {
        if (method === HostMethod.ThreadList) return [{ id: threadId }];
        if (method === HostMethod.EventsInbox) return [];
        if (method === HostMethod.EventsList) return params?.threadId === threadId ? [...log] : [];
        if (method === HostMethod.EventsAppend && params?.threadId === threadId)
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return null;
      },
    };
    const studio = { host, orphanRuns: new Map<string, string>() };
    const messages = { restore: async () => {} };
    await handleBootNotice(studio as never, messages as never, { reason: "crash_restart", openRuns: [runId] } as never);

    const closes = log.slice(3).filter((entry) => entry.data.event_type === "run_finished");
    assert.equal(closes.length, 1, `the run is closed once: ${JSON.stringify(log.slice(3))}`);
    assert.equal(closes[0]?.data.payload?.runId, runId);
  });

  /**
   * The host names a run in flight at every later crash of the same app session, so a reborn loop can
   * be told of a run it has already started again itself — a Resume or a reopen taken the moment it
   * woke. Read as open again (RO3), it would be closed and paused under the run running it.
   */
  it("RO3b. a run the reborn loop is itself running again is never closed as one the crash left open", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const log = [
      ...closedLog(),
      { id: "e3", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: true } } },
    ];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { threadId?: string; batch?: Logged[] }): Promise<unknown> => {
        if (method === HostMethod.ThreadList) return [{ id: threadId }];
        if (method === HostMethod.EventsInbox) return [];
        if (method === HostMethod.EventsList) return params?.threadId === threadId ? [...log] : [];
        if (method === HostMethod.EventsAppend && params?.threadId === threadId)
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        return null;
      },
    };
    const studio = {
      host,
      orphanRuns: new Map<string, string>(),
      activeRuns: new Map([[runId, { threadId, run }]]),
      startingRuns: new Map(),
    };
    await handleBootNotice(
      studio as never,
      { restore: async () => {} } as never,
      {
        reason: "crash_restart",
        openRuns: [runId],
      } as never,
    );
    assert.deepEqual(
      log.slice(3).filter((entry) => entry.data.event_type === "run_finished"),
      [],
      "the run this loop runs is not closed under it",
    );
  });

  /**
   * A finished build its chat's own session reopened, the app gone before the chat's queue marked the
   * message answered: the queue answers it again after the restart (message-queue.ts `restore`), and
   * the reopen found the ask the first answer had recorded (loop/reopen-run.ts `askTheBuild`) and did
   * not record it twice — but started the run from the log's last record, past that ask, so the
   * reopened run never heard what it was reopened for. So did a message the finished run's lead
   * took and never heard: back with the chat, its own turn took the lead's record of its words for the
   * ask and recorded none.
   */
  it("RO2. a reopened run hears its ask: one recorded before a restart replayed the message, and one a lead's record of the same words gave back", async () => {
    const { reopenAfterReply } = await import("../../src/harness-seed/loop/reopen-run.ts");
    const record = (event_type: string, payload: Record<string, unknown>): Logged => ({
      type: "custom",
      event_type,
      payload,
    });
    /** Reopen as the chat does once the reply has ended, on a host that keeps `log` and the run's journal; answers the start's cursor. */
    async function reopenOn(log: Array<{ id: string; data: Logged }>, { started = true } = {}) {
      let journal: unknown = { phase: "done", run, director: { lead: { chatSession: true } } };
      type Params = { batch?: Logged[]; value?: unknown };
      const host = {
        workspace: "/nonexistent",
        notify: () => {},
        call: async (method: string, params: Params): Promise<unknown> => {
          if (method === HostMethod.EventsList) return [...log];
          if (method === HostMethod.ArtifactRead) return journal;
          if (method === HostMethod.ArtifactWrite) journal = params.value;
          if (method === HostMethod.EventsAppend)
            for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
          return null;
        },
      };
      const studio = { host, cancels: new Set<string>(), moodBoards: new Map(), activeRuns: new Map() };
      const loopRun = { runId, state: "finished", engine: "codex", model: null, messageId: "m9", reopenable: true };
      let cursor: unknown = null;
      // Not started: the app dies before the run is registered again.
      const start = async (_run: unknown, reopen: unknown) => {
        if (started) cursor = reopen;
      };
      const ask = { hours: 2, words: "add enemies", models: null };
      await reopenAfterReply(studio as never, { threadId, cancelled: false }, loopRun as never, ask, start);
      return cursor;
    }
    /** The chat's own asks for the message (a lead's records of its words are not). */
    const asks = (log: Array<{ id: string; data: Logged }>) =>
      log.filter(
        ({ data }) =>
          data.event_type === "run_steering" && !data.payload?.how && data.payload?.sourceMessageId === "m9",
      ).length;

    const log = [
      { id: "e1", data: record("run_registered", { ...run, resumed: false }) },
      { id: "e2", data: record("run_finished", { runId, project: "plaza", victory: true }) },
    ];
    await reopenOn(log, { started: false });
    // The restart: the queue answers the message again.
    log.push({ id: "e5", data: record("coordinator_message_requeued", { messageId: "m9", attempts: 1 }) });
    const replayed = await reopenOn(log);
    assert.equal(asks(log), 1, "the replayed message records its ask once");
    const { ctx } = await startAgain(log, { reopen: replayed });
    assert.deepEqual(await ctx.runInbox?.steering(undefined, false, { onlyNew: true }), ["add enemies"]);

    const givenBack = [
      { id: "e1", data: record("run_registered", { ...run, resumed: false }) },
      { id: "e2", data: record("coordinator_message_delivered", { messageId: "m9", into: runId, how: "lead" }) },
      { id: "e3", data: record("run_steering", { runId, text: "add enemies", sourceMessageId: "m9", how: "lead" }) },
      { id: "e4", data: record("run_steering", { runId, text: "a darker sky", sourceMessageId: "m8" }) },
      { id: "e5", data: record("run_finished", { runId, project: "plaza", victory: true }) },
      { id: "e6", data: record("coordinator_message_requeued", { messageId: "m9" }) },
    ];
    const again = await startAgain(givenBack, { reopen: await reopenOn(givenBack) });
    assert.equal(asks(givenBack), 1, "the lead's record of its words is not its ask: the chat records its own");
    assert.deepEqual(await again.ctx.runInbox?.steering(undefined, false, { onlyNew: true }), ["add enemies"]);
  });
});

/**
 * A Loop message after a finished build the run's coordinator answers for — its lead was a session
 * of its own (the chat's session on another model), or the message went to another engine. The
 * reopen was the chat's own session's alone (loop/reopen-run.ts `keepsCommission`), so the message
 * dropped its Loop without a word, the coordinator's continue_build ran one builder turn in the chat,
 * and Mode, which still showed Loop 2 h, promised a build that never came: the chat had no way left
 * to give the build more working time.
 */
describe("a Loop message after a finished build the run's coordinator answers for", () => {
  const RUN = "run_coord";
  const THREAD = "thread_coord";
  const run = {
    runId: RUN,
    project: "plaza",
    goal: "a dusk plaza",
    engine: "codex",
    mode: "autopilot",
    reference: { name: "plaza", shots: [] },
    roles: { planner: "gpt-5.6-sol", builder: "gpt-5.6-sol", judge: "gpt-5.6-sol" },
    rolesApplied: true,
    budgets: { wallClockMs: HOUR_MS },
  };
  type Json = Record<string, any>;
  /**
   * A chat whose build finished under a lead of its own, on a host that keeps the log and the journal.
   * The coordinator, when asked, continues the build as the host's continue_build records it; any
   * other session is a builder. Once the chat's turn has ended no game has the build's name, so a
   * run started again throws before it builds and closes — unless a `game` is given, which the
   * host lists throughout.
   */
  function coordinatedChat(
    continues: boolean,
    {
      chatSession = false,
      recorded = [],
      since = [],
      artifacts = {},
      game = null,
      contained = false,
    }: {
      chatSession?: boolean;
      recorded?: Json[];
      since?: Json[];
      artifacts?: Json;
      game?: Json | null;
      contained?: boolean;
    } = {},
  ) {
    const log: Array<{ id: string; data: Json }> = [
      { id: "e1", data: { type: "custom", event_type: "run_registered", payload: { ...run, resumed: false } } },
      {
        id: "e2",
        data: { type: "custom", event_type: "run_finished", payload: { runId: RUN, project: "plaza", landed: true } },
      },
      ...since.map((data, i) => ({ id: `e${i + 3}`, data })),
    ];
    const store: Json = {
      journal: { phase: "done", run, director: { lead: { chatSession }, sessionId: "lead-own", plan: {} } },
      turnOver: false,
    };
    const asked = { coordinator: [] as Json[], builders: [] as Json[], said: [] as string[] };
    const append = (data: Json) => log.push({ id: `e${log.length + 1}`, data });
    const answers: Record<string, (params: Json) => unknown> = {
      [HostMethod.EventsList]: (params) =>
        params?.after ? log.slice(log.findIndex((entry) => entry.id === params.after) + 1) : [...log],
      [HostMethod.EngineDescribe]: () => [{ id: "codex", kind: "delegated", label: "Codex" }],
      [HostMethod.ArtifactRead]: (params) =>
        params.artifactId === `autopilot_${RUN}` ? store.journal : (artifacts[params.artifactId] ?? null),
      [HostMethod.ArtifactWrite]: (params) => {
        if (params.artifactId === `autopilot_${RUN}`) store.journal = params.value;
      },
      [HostMethod.EventsAppend]: (params) => {
        for (const data of params.batch) append(data);
      },
      [HostMethod.TurnBegin]: () => ({ turnId: "turn-1" }),
      [HostMethod.TurnAppend]: (params) => {
        for (const data of params.batch) for (const m of data.messages ?? []) asked.said.push(String(m.content));
      },
      [HostMethod.TurnEnd]: () => {
        store.turnOver = true;
      },
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.GameList]: () => {
        if (game) return [game];
        return store.turnOver ? [] : [{ name: "plaza", title: "Plaza" }];
      },
      [HostMethod.EngineDelegate]: (params) => {
        if (!params.coordinator) {
          asked.builders.push(params);
          const result = { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "chat-1", summary: "built" };
          return { ...result, studioToolCalls: recorded };
        }
        asked.coordinator.push(params);
        if (continues) {
          const followup = {
            runId: RUN,
            sourceMessageId: params.coordinator.messageId,
            text: "add enemies to the plaza",
            ...(contained ? { build: false } : {}),
          };
          append({ type: "custom", event_type: "run_followup_requested", payload: followup });
        }
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "coord-1", summary: "The build goes on." };
      },
    };
    const notified: Array<{ event: string; payload: Json }> = [];
    const host = {
      workspace: "/nonexistent",
      notify: (event: string, payload: Json) => {
        notified.push({ event, payload });
      },
      call: async (method: string, params: Json): Promise<unknown> => answers[method]?.(params) ?? null,
    };
    const studio: Json = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
    };
    const ctx = {
      ...host,
      host,
      threadId: THREAD,
      setStatus: () => {},
      get cancelled() {
        return studio.cancels.has(THREAD);
      },
    };
    studio.scoped = () => ctx;
    /** The runs registered on the thread, once the ones under way have closed. */
    const registered = async () => {
      const of = () => log.filter((entry) => entry.data.event_type === "run_registered");
      for (let n = 0; n < 200 && of().length < 2; n++) await nextTurn();
      for (let n = 0; n < 400 && studio.activeRuns.size + studio.startingRuns.size > 0; n++) await nextTurn();
      return of().map((entry) => entry.data.payload);
    };
    return { studio, log, store, asked, registered, notified };
  }
  const message = {
    type: "user_message",
    threadId: THREAD,
    text: "add enemies",
    engine: "codex",
    model: "gpt-5.6-terra",
    project: "plaza",
    messageId: "m9",
  };

  it("RO5. a Loop message asking for more after a coordinator-led finished build dropped its Loop without a word and ran one builder turn: the coordinator's continue_build reopens the same run with the Loop's time", async () => {
    const chat = coordinatedChat(true);
    const loopOn = { ...message, autopilot: { hours: 2 } };
    await handleUserMessage(chat.studio as never, loopOn as never);

    assert.deepEqual(loopOn.autopilot, { hours: 2 }, "the message keeps its Loop");
    assert.equal(chat.asked.coordinator.length, 1);
    assert.match(String(chat.asked.coordinator[0]?.prompt), /Loop is on/);
    assert.match(String(chat.asked.coordinator[0]?.prompt), /up to 2 h/);
    assert.equal(chat.asked.builders.length, 0, "no builder turn: the build goes on instead");
    const runs = await chat.registered();
    assert.deepEqual(
      runs.map((payload) => ({ runId: payload.runId, resumed: payload.resumed })),
      [
        { runId: RUN, resumed: false },
        { runId: RUN, resumed: true },
      ],
      JSON.stringify(chat.log.map((entry) => entry.data.event_type ?? entry.data.type)),
    );
    assert.equal(runs[1]?.budgets?.wallClockMs, 2 * HOUR_MS);
    assert.deepEqual(runs[1]?.roles, run.roles, "the models it was built with, its own lead's included");
    const ask = chat.log.findIndex(
      (entry) => entry.data.event_type === "run_steering" && entry.data.payload?.text === "add enemies to the plaza",
    );
    const again = chat.log.findLastIndex((entry) => entry.data.event_type === "run_registered");
    assert.ok(ask > 1 && ask < again, "the ask is recorded before the start");
    assert.ok(chat.store.journal.director.reopened, "the run started from the reopened journal");
  });

  it("RO5b. with Loop off the coordinator's continue_build still hands the work to one builder turn, and nothing reopens", async () => {
    const chat = coordinatedChat(true);
    await handleUserMessage(chat.studio as never, { ...message } as never);
    assert.doesNotMatch(String(chat.asked.coordinator[0]?.prompt), /Loop is on/);
    assert.equal(chat.asked.builders.length, 1, "one builder turn");
    assert.equal((await chat.registered()).length, 1, "nothing reopened");
  });

  it("GB1b. a contained change with Loop on after a coordinator-led finished build: continue_build with build: false hands it to one builder turn, and nothing reopens", async () => {
    const chat = coordinatedChat(true, { contained: true });
    await handleUserMessage(
      chat.studio as never,
      { ...message, text: "fix it quickly", autopilot: { hours: 3 } } as never,
    );
    assert.match(String(chat.asked.coordinator[0]?.prompt), /Loop is on/);
    assert.equal(chat.asked.builders.length, 1, "one builder turn makes the change");
    assert.equal((await chat.registered()).length, 1, "nothing reopened");
  });

  it("RO5c. a question with Loop on is answered: nothing continues, nothing reopens, and nothing is said of the Loop", async () => {
    const chat = coordinatedChat(false);
    await handleUserMessage(chat.studio as never, { ...message, text: "why dusk?", autopilot: { hours: 2 } } as never);
    assert.equal(chat.asked.builders.length, 0);
    assert.equal((await chat.registered()).length, 1);
    assert.deepEqual(
      chat.asked.said.filter((words) => /Loop can't continue this build/.test(words)),
      [],
      "the Loop was offered, so nothing is said of it",
    );
  });

  it("RO5d. a Loop message after a finished build no run of the run can go on from — no lead was seated — is answered as with Loop off, and the chat says so once", async () => {
    const chat = coordinatedChat(true);
    chat.store.journal = { phase: "done", run, director: { plan: {} } };
    const first = { ...message, autopilot: { hours: 2 } };
    await handleUserMessage(chat.studio as never, first as never);
    assert.equal("autopilot" in first, false, "its Loop is dropped");
    assert.doesNotMatch(String(chat.asked.coordinator[0]?.prompt), /Loop is on/);
    assert.equal(chat.asked.builders.length, 1, "the work goes to one builder turn, as with Loop off");
    assert.equal(chat.asked.said.filter((words) => /Loop can't continue this build/.test(words)).length, 1);

    await handleUserMessage(chat.studio as never, { ...message, messageId: "m10", autopilot: { hours: 2 } } as never);
    assert.equal(
      chat.asked.said.filter((words) => /Loop can't continue this build/.test(words)).length,
      1,
      "said once for the build, not on every message",
    );
    assert.equal((await chat.registered()).length, 1, "nothing reopened");
  });

  /**
   * The chat reports how a command the person ran from a reply went, in words it writes itself
   * (`origin`). Sent while the chat's history was still loading, the renderer saw no build and gave it
   * the chat's Loop; queued before an upgrade, it replays with it. The harness kept that Loop for a
   * finished build (loop/reopen-run.ts `keepsCommission`), so a failing command's output — read as a
   * request for a fix — reopened the build for hours though nobody asked.
   */
  it("RO6. a command's result carrying the chat's Loop reopened a finished build on words nobody typed: what the chat writes itself never keeps a Loop once a run exists", async () => {
    const report = {
      ...message,
      text: "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.",
      origin: "command-result",
      autopilot: { hours: 2 },
    };
    const own = coordinatedChat(false, {
      chatSession: true,
      recorded: [{ name: "reopen_run", args: { text: "fix the failing test" } }],
    });
    const toOwnSession = { ...report, model: undefined };
    await handleUserMessage(own.studio as never, toOwnSession as never);
    assert.equal("autopilot" in toOwnSession, false, "its Loop is dropped");
    assert.equal(own.asked.builders[0]?.interviewTools, undefined, "the chat's own session is offered no reopen");
    assert.equal((await own.registered()).length, 1, "nothing reopened");

    const coordinated = coordinatedChat(true);
    const toCoordinator = { ...report };
    await handleUserMessage(coordinated.studio as never, toCoordinator as never);
    assert.doesNotMatch(String(coordinated.asked.coordinator[0]?.prompt), /Loop is on/);
    assert.equal((await coordinated.registered()).length, 1, "nothing reopened");
    assert.deepEqual(
      coordinated.asked.said.filter((words) => /Loop can't continue this build/.test(words)),
      [],
      "a Loop nobody chose is not spoken of",
    );
  });

  /**
   * The chat's own session asked after a finished build whether to go on (its question keeps the
   * Loop it was asked with), and the next message was a command's result on another engine: the
   * coordinator took it for more work, and its builder turn inherited the question's Loop — handed
   * the launch tool, it could start a new build nobody asked for.
   */
  it("RO6b. the builder turn a coordinator's continue_build hands work to never inherits a Loop from a question: it starts no build", async () => {
    const words = "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.";
    const chat = coordinatedChat(true, {
      recorded: [{ name: "start_autopilot", args: { goal: "a fixed plaza", direction: "dusk" } }],
      since: [
        {
          type: "custom",
          event_type: "interview_question",
          payload: { question: "Go on or start over?", intakeId: "interview_t0" },
        },
        { type: "messages", messages: [{ role: "user", content: words }] },
      ],
      artifacts: { interview_t0: { autopilot: { hours: 8 } } },
    });
    await handleUserMessage(chat.studio as never, { ...message, text: words, origin: "command-result" } as never);
    assert.equal(chat.asked.builders.length, 1, "the work goes to one builder turn");
    assert.equal(chat.asked.builders[0]?.interviewTools, undefined, "with no launch tool");
    assert.equal((await chat.registered()).length, 1, "no build started");
  });

  it("RO5f. a picture sent with the Loop message reaches the reopened build in the coordinator's words: it is told to say what it shows", async () => {
    const chat = coordinatedChat(true);
    const still = { data: Buffer.from("dusk").toString("base64"), mimeType: "image/png", label: "dusk" };
    await handleUserMessage(chat.studio as never, { ...message, stills: [still], autopilot: { hours: 2 } } as never);
    assert.match(String(chat.asked.coordinator[0]?.prompt), /attached 1 still\(s\)[\s\S]*continue_build's text/);

    const plain = coordinatedChat(true);
    await handleUserMessage(plain.studio as never, { ...message, messageId: "m10", autopilot: { hours: 2 } } as never);
    assert.doesNotMatch(String(plain.asked.coordinator[0]?.prompt), /attached \d+ still/);
  });

  it("RO5e. a coordinator on a model without sessions, which answers with tools in bounded rounds, is never handed a build's hours: the Loop is not used, and the chat says so", async () => {
    const chat = coordinatedChat(true);
    const local = { ...message, engine: "ollama", model: "qwen3", autopilot: { hours: 2 } };
    await handleUserMessage(chat.studio as never, local as never);
    assert.equal("autopilot" in local, false, "its Loop is dropped");
    assert.equal(chat.asked.said.filter((words) => /Loop can't continue this build/.test(words)).length, 1);
    assert.equal((await chat.registered()).length, 1, "nothing reopened");
  });

  /**
   * A game linked to Unreal whose finished run was an Unreal Loop, which seats no lead and keeps no
   * journal: a new ask with Mode on a Loop starts another Unreal Loop, never "Loop can't continue
   * this build here" and one builder turn from the coordinator's continue_build. The host lists the
   * game here linked to the project inside its folder.
   */
  const unrealGame = {
    name: "plaza",
    title: "Plaza",
    dir: "/games/plaza",
    engine: { kind: GameEngine.Unreal, project: "/games/plaza/unreal/Plaza.uproject" },
  };
  const dirtBike = { goal: "A dirt-bike track game.", direction: "Dirt track" };
  const loopUnusedSaid = (said: readonly string[]) =>
    said.filter((words) => /Loop can't continue this build/.test(words));

  it("a Loop message after the game's finished Unreal Loop was answered with Loop off: it starts a new Loop", async () => {
    const chat = coordinatedChat(true, { game: unrealGame, recorded: [{ name: "start_autopilot", args: dirtBike }] });
    chat.store.journal = null;
    const loopOn = {
      ...message,
      text: "Make it a dirt-bike track game.",
      autopilot: { hours: 1 },
    };
    await handleUserMessage(chat.studio as never, loopOn as never);

    assert.deepEqual(loopOn.autopilot, { hours: 1 }, "the message keeps its Loop");
    assert.deepEqual(loopUnusedSaid(chat.asked.said), [], "nothing is said of a Loop that cannot continue");
    assert.equal(chat.asked.coordinator.length, 0, "no coordinator turn hands the ask to one builder");
    assert.equal(chat.asked.builders.length, 1);
    assert.deepEqual(
      chat.asked.builders[0]?.interviewTools?.map((tool: Json) => tool.name),
      ["start_autopilot", "ask_user"],
      "the chat's own session is handed the Loop's launch",
    );
    assert.match(String(chat.asked.builders[0]?.prompt), /the lead builds the whole project itself in this folder/);
    const runs = await chat.registered();
    assert.equal(runs.length, 2, JSON.stringify(chat.log.map((entry) => entry.data.event_type ?? entry.data.type)));
    assert.notEqual(runs[1]?.runId, RUN, "a new run, never the finished one reopened");
    assert.equal(runs[1]?.resumed, false);
    assert.equal(runs[1]?.goal, dirtBike.goal, "the ask is its goal");
    assert.equal(runs[1]?.budgets?.wallClockMs, HOUR_MS, "with the Loop's hours");
    const finished = chat.notified.find((note) => note.event === "run.finished")?.payload;
    assert.equal(finished?.profile, "open", "conducted by the one Loop, in place");
  });

  it("with Loop off, a message after the game's finished Unreal Loop is still answered as a chat: one builder turn, no run", async () => {
    const chat = coordinatedChat(true, { game: unrealGame });
    chat.store.journal = null;
    await handleUserMessage(chat.studio as never, { ...message } as never);
    assert.equal(chat.asked.coordinator.length, 1);
    assert.equal(chat.asked.builders.length, 1, "one builder turn");
    assert.equal(chat.asked.builders[0]?.interviewTools, undefined, "with no launch tool");
    assert.deepEqual(loopUnusedSaid(chat.asked.said), []);
    assert.equal((await chat.registered()).length, 1, "no run started");
  });
});

/**
 * golden-boot-glory: after a finished 3 h Loop build, the user asked to "fix it very
 * quickly" — remove two HUD plates. The after-build note told the session that work "of any size — a
 * fix…" goes to the build, so it reopened the run with a fresh three hours that had to be spent: the
 * chat said "until about 9:48 PM", the lead made the fix in seventy seconds, and `finish` was then
 * refused for 159 working minutes.
 */
describe("a quick fix after a finished Loop build (golden-boot-glory)", () => {
  const grant = { hours: 3, frameCount: 2, project: "golden-boot-glory", launchTool: "start_autopilot" };
  const finished = { runId: "run_gb", state: "finished", goal: "a soccer game", landed: true, reopenable: true };

  it("GB1. Loop permits a build but never orders one: a contained change after a finished build is the session's own edit, and only more work reopens it", async () => {
    const { afterLoopRunNote } = await import("../../src/harness-seed/loop/after-loop-run-prompts.ts");
    const { coordinatorPrompt } = await import("../../src/harness-seed/loop/coordinator-prompts.ts");
    const note = afterLoopRunNote(finished as never, "claude-code", grant);
    const coordinator = coordinatorPrompt({
      events: [],
      run: { runId: "run_gb" },
      text: "fix it quickly",
      journal: null,
      savedPlan: null,
      history: "",
      reopen: { hours: 3 },
    });
    for (const [label, words] of [
      ["the chat's own session", note],
      ["the run's coordinator", coordinator],
    ]) {
      assert.doesNotMatch(String(words), /of any size/, `${label}: a fix is not a build`);
      assert.match(String(words), /contained change/i, `${label}: a contained change is named`);
    }
    assert.match(note, /contained change[^\n]*yourself/i, "the session makes a contained change itself");
    assert.match(note, /estimate/i, "an unclear size is asked with an estimate");
    assert.match(
      coordinator,
      /contained change[^\n]*build: false/i,
      "the coordinator hands a contained change to one builder turn",
    );
  });
});

/**
 * golden-boot-glory's reviewers and playtester: six defect checks stayed "failing" on
 * answers the judge gave at confidence 0.20–0.40; one playtest's "yes" was lost because its reply
 * came in a fenced block after another; and the playtester, five seconds a move, watched the match
 * clock run four minutes during one key press.
 */
describe("the reviewers and the playtester of a broadcast match (golden-boot-glory)", () => {

  it("GR2. playtest 2 answered yes in a fenced reply that closed one brace too many, and was recorded as no answer: the reply's JSON is read without its stray closing braces", async () => {
    const { readJudgeJson } = await import("../../src/harness-seed/loop/judge-provenance.ts");
    const answers = { "director-play": { answer: "yes", note: "Passing worked." } };
    const reply = `\`\`\`json\n${JSON.stringify({ answers })}}\n\`\`\``;
    assert.deepEqual(readJudgeJson(reply), { answers });
    assert.deepEqual(readJudgeJson(`Here it is:\n${JSON.stringify({ answers })}}}`), { answers });
    assert.equal(readJudgeJson("no verdict here"), null);
    assert.equal(readJudgeJson('{"answers": {"q": '), null, "a reply cut short is still unreadable");
  });
});

/**
 * ask-first: the write-less interviewer that commissioned a build used to ask what the game is and
 * how it should look before it launched (usually one question). The Loop chat that replaced it asked
 * only whether a build was wanted, so a bare pitch — "make me a game, quickly" — became a build in a
 * style nobody chose.
 */
describe("a pitch that says neither what the game is nor how it looks (ask-first)", () => {
  /** The rule every Loop briefing carries, whichever engine reads it. */
  const assertAsksFirst = (brief: string, label: string) => {
    assert.match(brief, /know what the game is/i, `${label}: what the game is`);
    assert.match(brief, /how it should look/i, `${label}: how it looks`);
    assert.match(brief, /even when the user asks for speed/i, `${label}: a hurry does not skip the question`);
    assert.match(
      brief,
      /a quick build is still a build/i,
      `${label}: a hurry does not turn a new game into a chat edit`,
    );
  };

  it("ask-first. a Loop chat given a pitch in a hurry is told to ask what the game is and how it looks before it builds", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        return { ok: true, engine: "vendor", sessionId: "loop-pitch", turns: 1, usage: {}, summary: "On it." };
      },
    });
    await rig.core.sendUserMessage("Make me a game, quickly.", { engine: "vendor", autopilot: { hours: 1 } });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");

    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(
      request?.interviewTools?.some((tool) => tool.name === "ask_user"),
      "the chat can ask in the answer panel",
    );
    assertAsksFirst(String(request?.prompt), "delegated Loop chat");
    // A local model reads the same rule in its own briefing.
    assertAsksFirst(String(turnBriefing({ autopilot: { hours: 1 } })), "direct Autopilot briefing");
    assertAsksFirst(String(turnBriefing({ loop: { hours: 2 } })), "direct Loop briefing");
  });
});

/**
 * Loop phase 4: the close asks no judge; a judge is a second opinion the lead asks for, and the
 * build lands on its own look. The rows below keep the hurried run and say what it does now.
 *
 * hurry: a build whose user asked for it fast — "just make it", or Finish pressed before the run
 * was done — landed on its lead's word that it loads. Judging was the lead's choice, and every
 * prompt of a hurried run (the wrap-up, the user's finish, the goal card) told it to call finish,
 * so the build went live with no judge having looked at it: "made live, not judged better".
 */
describe("the final judge when the user is in a hurry", () => {
  const plan = {
    summary: "This run: paint the sky, fast.",
    workers: JSON.stringify([
      { id: "sky", title: "Sky", seam: "the sky", owns: "src/sky.js", done: ["the sky is blue"], minutes: 20 },
    ]),
    base: "the integration branch as it stands",
    risks: "none",
  };
  const start = {
    id: "sky",
    title: "Sky",
    brief: "paint the sky blue",
    mode: "single",
    minutes: "5",
    owns: "src/sky.js",
  };
  const LIT = { width: 800, height: 600, sampled: 480_000, meanLuma: 42, litFraction: 0.6, canvas: true };
  const BLANK = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
  const leadText = (answer: unknown): string =>
    typeof answer === "string" ? answer : String((answer as { text?: string } | null)?.text ?? "");

  /**
   * One lead turn in a hurry: the lead has its one builder paint the sky, the user asks to finish
   * while it paints, and the lead integrates it and finishes with land=yes — never calling `judge`
   * itself. A run `fromScratch` starts on the empty scaffold (nothing drawn) until the builder paints.
   */
  async function hurriedLoopRun(
    name: string,
    {
      fromScratch = false,
      judge = () => null,
    }: {
      fromScratch?: boolean;
      /** The judge's own reply to a prompt (null: the scripted default), given the run it judges. */
      judge?: (text: string, runId: string, rig: Rig) => string | null | Promise<string | null>;
    } = {},
  ) {
    let painted = !fromScratch;
    const previews: FakePreview[] = [];
    const asScene = (preview: FakePreview): FakePreview => {
      previews.push(preview);
      preview.pixelStatsNext = painted ? LIT : BLANK;
      if (fromScratch)
        preview.evaluations.push(
          {
            match: "isScene",
            get value() {
              return !painted;
            },
          },
          { match: "matrixWorld", value: "[1,0,0,1]" },
        );
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asScene(makeFakePreview()) },
    );
    rigs.push(rig);
    asScene(rig.preview);
    const project = await rig.core.games.scaffold(name, { title: name });
    const thread = await rig.core.threadForGame(project.name);
    const runId = rig.core.newRunId();
    const asked: string[] = [];
    const results: Record<string, string> = {};
    registerFakeEngine(rig, {
      complete: (text) => {
        asked.push(text);
        return judge(text, runId, rig);
      },
      delegate: async (request: DelegateRequest) => {
        if (request.director) {
          const call = (tool: string, args: Record<string, unknown>) => request.onLiveTool!(tool, args);
          await call("plan", plan);
          results.started = leadText(await call("worker_start", start));
          // Flipped: the user asked to finish before the builder started; once they ask, no worker
          // starts, so they ask while it works.
          await rig.core.append(
            [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
            thread,
          );
          for (let i = 0; i < 30; i++) {
            const waited = JSON.parse(leadText(await call("wait", { seconds: "5", worker: "sky" })));
            if (waited.status.workers[0]?.state !== "running") break;
          }
          results.integrated = leadText(await call("integrate", { worker: "sky" }));
          results.finished = leadText(
            await call("finish", { summary: "painted the sky, as fast as asked", land: "yes" }),
          );
          return { sessionId: "lead-hurry", summary: "finished" };
        }
        if (path.basename(request.cwd) === "integration") {
          // The studio's starting point on an empty project: shared modules, still nothing drawn.
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = {};\n");
          return { sessionId: "base-1", summary: "the world's shape" };
        }
        if (!request.selfCapture) return null;
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        painted = true;
        for (const preview of previews) preview.pixelStatsNext = LIT;
        return { sessionId: "worker-1", summary: "painted the sky" };
      },
    });
    await rig.core.dispatchRun({
      runId,
      goal: "a blue sky over the plaza",
      project: project.name,
      mode: "autopilot",
      engine: "fake-delegate",
      reference: { name: "sky", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    } as never);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      `${name} run_finished`,
    );
    // The close's report and the verdicts, read as the app reads them: loose records.
    const finished: Record<string, any> = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    const verdicts: Array<Record<string, any>> = customEvents(events, "director_verdict");
    const judgedLanding = verdicts.filter(
      (verdict) => verdict.pass === "judge" && verdict.build?.head === finished.integrationHead,
    );
    return { asked, events, finished, judgedLanding, project, results };
  }

  it("hurry-1. a game the user had, finished in a hurry without the lead judging it: the close makes it live on its own look, asking no judge", async () => {
    const { asked, finished, judgedLanding, results } = await hurriedLoopRun("hurry-existing");

    assert.equal(finished.landed, true, `${finished.stoppedBecause} | ${results.finished}`);
    // Flipped (Loop phase 4): the close judged what it made live against the game the user had.
    assert.deepEqual(judgedLanding, [], "no judge looked at the build made live");
    assert.ok(
      !asked.some((text) => text.includes("BUILD A") && text.includes("BUILD B")),
      "no blind comparison with the game the user had",
    );
    assert.notEqual(finished.landingResult.how, LandingHow.JudgePick, JSON.stringify(finished.landingResult));
    assert.doesNotMatch(results.finished, /a judge preferred it/);
  });

  it("hurry-2. a new game finished in a hurry: the close asks no judge whether the build does what was asked, and the card claims no judge's answer", async () => {
    const { asked, finished, judgedLanding, results } = await hurriedLoopRun("hurry-scratch", { fromScratch: true });

    assert.equal(finished.landed, true, `${finished.stoppedBecause} | ${results.finished}`);
    // Flipped (Loop phase 4): the close asked a judge whether the build does what was asked.
    assert.deepEqual(judgedLanding, [], "no judge looked at the build made live");
    assert.ok(!asked.some((text) => /a blue sky over the plaza/.test(text) && text.includes("QUESTION:")));
    assert.notEqual(finished.landingResult.how, LandingHow.JudgeAnsweredYes, JSON.stringify(finished.landingResult));
    assert.doesNotMatch(String(finished.landingResult.line), /a judge found/);
    assert.doesNotMatch(results.finished, /a judge found/);
  });
});

describe("a reply cut off by its output limit", () => {
  it("runs none of its tool calls and asks again for a smaller, complete reply", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const requests: CompleteRequest[] = [];
    rig.core.engines.register({
      id: "fake-direct",
      label: "Fake direct",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async (request: CompleteRequest) => {
        requests.push(request);
        const cut = requests.length === 1;
        return {
          message: {
            role: "assistant",
            content: cut ? "Writing the whole file" : "Done in smaller steps.",
            ...(cut ? { tool_calls: [{ id: "cut-1", name: "list_games", arguments: {} }] } : {}),
          },
          usage: {},
          stopReason: cut ? "length" : "stop",
          model: "fake",
          engine: "fake-direct",
        };
      },
    });
    await rig.core.sendUserMessage("rewrite the game", { engine: "fake-direct" });
    const log = await waitForLog(rig.core, (l) => l.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const toolEvents = log.filter((e) => e.data.type === "tool_requested" || e.data.type === "tool_result");
    assert.deepEqual(toolEvents, [], "a call from a truncated reply is not an executable request");
    assert.equal(requests.length, 2, "the turn asked again instead of ending on the cut-off reply");
    const retry = JSON.stringify(requests[1]!.messages);
    assert.doesNotMatch(retry, /cut-1/, "the partial call is not replayed as if it had been made");
    assert.match(retry, /output limit/, "the model hears why its reply was dropped");
    const userSaid = log.flatMap((e) =>
      e.data.type === "messages" ? e.data.messages.filter((m) => m.role === "user").map((m) => m.content) : [],
    );
    assert.deepEqual(userSaid, ["rewrite the game"], "the note is Studio's, never put in the user's mouth");
  });
});

describe("a turn that has taken many pictures", () => {
  it("reserves room for the pictures it sends, not for every picture it has taken", async () => {
    // Only the latest few pictures ride the prompt; reserving for all of them made a turn with
    // many screenshots compact — then refuse — a conversation that fit.
    const still = { label: "shot", mimeType: "image/png", data: "iVBORw0KGgo=" };
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: {
        "engine.describe": () => [
          {
            id: "ollama",
            label: "Ollama",
            kind: "direct",
            status: { code: "ready" },
            models: [{ id: "m", label: "m", contextWindow: 160_000 }],
            defaultModel: "m",
          },
        ],
        "context.policy": () => ({ policy: { mode: "default" } }),
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
        "turn.append": () => ({}),
        "engine.complete": () => ({ message: { role: "assistant", content: "Looks right." }, usage: {} }),
      },
    });
    const outcome = await runTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn1",
      engine: "ollama",
      stills: Array.from({ length: 60 }, (_, i) => ({ ...still, label: `shot ${i}` })),
    });

    assert.equal((outcome as { stopped: string }).stopped, "done");
    const completions = recorder.paramsOf("engine.complete");
    assert.equal(completions.length, 1, "the turn answered without compacting a conversation that fit");
  });
});

describe("a turn's round limit", () => {
  it("asks the model at most maxRounds times", async () => {
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: {
        "engine.describe": () => [
          { id: "ollama", label: "Ollama", kind: "direct", status: { code: "ready" }, models: [], defaultModel: "m" },
        ],
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
        "turn.append": () => ({}),
        "engine.complete": () => ({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: `c${Math.random()}`, name: "list_games", arguments: {} }],
          },
          usage: {},
        }),
      },
    });
    const outcome = await runTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn1",
      engine: "ollama",
      maxRounds: 2,
    });

    assert.equal((outcome as { stopped: string }).stopped, "max_rounds");
    assert.equal(recorder.paramsOf("engine.complete").length, 2, "two rounds, not three");
  });
});

describe("a failed tool call on the local engine", () => {
  it("reaches the model marked as an error, not as a plain answer", async () => {
    const events = [
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "read it" }] } },
      {
        id: "01b",
        data: {
          type: "messages",
          messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", arguments: {} }] }],
        },
      },
      { id: "01c", data: { type: "tool_result", tool_call_id: "c1", result: { ok: false, content: "no such file" } } },
      {
        id: "01d",
        data: {
          type: "messages",
          messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c2", name: "list_games", arguments: {} }] }],
        },
      },
      { id: "01e", data: { type: "tool_result", tool_call_id: "c2", result: { ok: true, content: "none" } } },
    ];
    const ctx = { workspace: "/nowhere", call: async (method: string) => (method === "events.list" ? events : null) };
    const prompt = await materializePrompt(ctx as never, { threadId: "t1" } as never);
    const { piMessages } = toPiMessages(prompt.messages);
    const results = (piMessages as Array<{ role: string; toolCallId?: string; isError?: boolean }>).filter(
      (m) => m.role === "toolResult",
    );
    assert.deepEqual(
      results.map((m) => [m.toolCallId, m.isError]),
      [
        ["c1", true],
        ["c2", false],
      ],
    );
  });
});

describe("two starts of a run on one chat at once", () => {
  it("reserves the chat for the first; the second is refused, not started beside it", async () => {
    const { handleRunStart } = await import("../../src/harness-seed/loop/run-dispatch.ts");
    const appended: Array<Record<string, any>> = [];
    let gameLists = 0;
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (method: string, params?: { batch?: Array<Record<string, any>> }): Promise<unknown> => {
        if (method === HostMethod.EventsAppend) appended.push(...(params?.batch ?? []));
        if (method !== HostMethod.GameList) return null;
        gameLists++;
        // A folder no run can build on: each start that gets this far ends here, cleanly.
        return [{ name: "plaza", shape: { kind: "engine-export" } }];
      },
    };
    const studio = {
      host,
      cancels: new Set<string>(),
      moodBoards: new Map(),
      activeRuns: new Map(),
      startingRuns: new Map(),
      orphanRuns: new Map(),
      scoped: () => ({ ...host, host, cancelled: false, setStatus: () => {} }),
    };
    const start = (runId: string) =>
      handleRunStart(studio as never, {
        type: "run_start",
        threadId: "chat-1",
        run: { runId, project: "plaza", goal: "a plaza" } as never,
      });

    await Promise.all([start("run-a"), start("run-b")]);

    assert.equal(gameLists, 1, "only one run got past the reservation");
    const blocked = appended.filter((data) => data.event_type === "run_start_blocked").map((data) => data.payload);
    assert.ok(
      blocked.some((payload) => payload.requestedRunId === "run-b" && payload.runId === "run-a"),
      `the second start is refused because the first holds the chat: ${JSON.stringify(blocked)}`,
    );
  });
});

describe("the chat's own contractor session", () => {
  it("resumes the chat's bookmarked session, not a later session another role opened in the thread", async () => {
    const { lastContractorSession } = await import("../../src/harness-seed/loop/chat-session.ts");
    const custom = (event_type: string, payload: Record<string, unknown>) => ({
      data: { type: "custom", event_type, payload },
    });
    const events = [
      custom("contractor_session", { sessionId: "chat-ses", engine: "claude-code", project: "plaza" }),
      // A coordinator, worker or reviewer that ran in this thread afterwards: its mirrored init
      // and an incomplete delegation of its own name sessions that are not the chat's.
      custom("delegated.claude-code", {
        kind: "system",
        data: { subtype: "init", session_id: "reviewer-ses" },
        project: "plaza",
      }),
      custom("delegation_incomplete", { sessionId: "worker-ses", engine: "claude-code", project: "plaza" }),
    ];
    assert.equal(lastContractorSession(events, "claude-code")?.sessionId, "chat-ses");
  });

  it("still finds a session in a chat that predates the bookmark", async () => {
    const { lastContractorSession } = await import("../../src/harness-seed/loop/chat-session.ts");
    const events = [
      {
        data: {
          type: "custom",
          event_type: "delegated.claude-code",
          payload: { kind: "system", data: { subtype: "init", session_id: "old-ses" } },
        },
      },
    ];
    assert.equal(lastContractorSession(events, "claude-code")?.sessionId, "old-ses");
  });
});

describe("a tool call the turn stopped before running", () => {
  it("is answered in the prompt as not run, right after the calls that did run", async () => {
    const { eventsToMessages } = await import("../../src/harness-seed/loop/prompt.ts");
    const calls = [
      { id: "c1", name: "read_file", arguments: {} },
      { id: "c2", name: "write_file", arguments: {} },
    ];
    const messages = eventsToMessages([
      { id: "01a", data: { type: "messages", messages: [{ role: "user", content: "fix it" }] } },
      { id: "01b", data: { type: "messages", messages: [{ role: "assistant", content: "", tool_calls: calls }] } },
      { id: "01c", data: { type: "tool_requested", tool_call_id: "c1", request: { name: "read_file" } } },
      { id: "01d", data: { type: "tool_result", tool_call_id: "c1", result: { ok: true, content: "text" } } },
      // Stop pressed here: c2 never ran. The next message starts a new turn.
      { id: "01e", data: { type: "messages", messages: [{ role: "user", content: "go on" }] } },
    ] as never);
    assert.deepEqual(
      messages.map((m) => [m.role, m.tool_call_id ?? null, m.is_error ?? false]),
      [
        ["user", null, false],
        ["assistant", null, false],
        ["tool", "c1", false],
        ["tool", "c2", true],
        ["user", null, false],
      ],
    );
    assert.match(messages[3]!.content, /not run/i);
  });
});

describe("a steer read twice at once", () => {
  it("is handed to one reader, not both, while the hand-over is being recorded", async () => {
    const { createRunInbox } = await import("../../src/harness-seed/loop/run-inbox.ts");
    const log: Array<{ id: string; data: Record<string, unknown> }> = [
      {
        id: "e1",
        data: { type: "custom", event_type: "run_steering", payload: { runId: "r", text: "make it blue" } },
      },
    ];
    const ctx = {
      call: async (method: string, params: { batch?: Array<Record<string, unknown>>; after?: string }) => {
        if (method === HostMethod.EventsList)
          return params.after ? log.slice(log.findIndex((e) => e.id === params.after) + 1) : [...log];
        if (method === HostMethod.EventsAppend) {
          // A host that takes a moment to write: the second reader arrives meanwhile.
          await nextTurn();
          for (const data of params.batch ?? []) log.push({ id: `e${log.length + 1}`, data });
        }
        return null;
      },
    };
    const inbox = createRunInbox(ctx as never, { threadId: "t", runId: "r" });
    const [first, second] = await Promise.all([
      inbox.steering(undefined, true, { onlyNew: true }),
      inbox.steering(undefined, true, { onlyNew: true }),
    ]);
    assert.deepEqual([...first, ...second], ["make it blue"], "one delivery of one steer");
    const deliveries = log.filter((e) => e.data.event_type === "run_steering_delivered");
    assert.equal(deliveries.length, 1, "and one hand-over record");
  });
});

describe("an Autopilot run whose landing conflicts", () => {
  it("ends at the failed landing: the user's folder is neither judged as the run's build nor rolled back", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("landclash");
    const live = rig.core.games.dirFor(project.name);
    const plan = twoFacetPlan();
    let userCommitted = false;
    const USER_WATER = "export const water = 'the user\\'s own marsh';\n";
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        await mkdir(path.join(cwd, "src"), { recursive: true });
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          await writeFile(path.join(cwd, "src", "water.js"), "export const water = 'the run\\'s marsh';\n");
          if (!userCommitted) {
            // Meanwhile the user commits their own evening of work on the same file in the game folder.
            userCommitted = true;
            await writeFile(path.join(live, "src", "water.js"), USER_WATER);
            await gitFile(["-C", live, "add", "-A"]);
            await gitFile(["-C", live, "-c", "user.name=u", "-c", "user.email=u@x", "commit", "-qm", "my marsh"]);
          }
          return { sessionId: "ses_water" };
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          await writeFile(path.join(cwd, "src", "sky.js"), "export const sky = 1;\n");
          return { sessionId: "ses_sky" };
        }
        if (request.playtest)
          return { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) };
        return null;
      },
    });
    const { runId, events } = await runAutopilot(rig, project.name);
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.match(String(finished.landing ?? ""), /not landed/, JSON.stringify(finished.landing ?? null));
    assert.match(String(finished.stoppedBecause), /not landed/, String(finished.stoppedBecause));
    assert.equal(finished.globalVerdict ?? null, null, "the folder the run did not build was not judged as its build");
    assert.equal(finished.rolledBack ?? false, false);
    assert.equal(await readFile(path.join(live, "src", "water.js"), "utf8"), USER_WATER, "the user's work stands");
  });
});

describe("Stop on a one-facet Autopilot run", () => {
  it("pauses the run where it was: no finalization is journaled for Resume to skip ahead to", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("onefacetstop");
    const plan = { ...twoFacetPlan(), facets: [twoFacetPlan().facets[0]] };
    let stopped = false;
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        if (request.playtest) return null;
        if (!stopped) {
          stopped = true;
          // The user presses Stop while the first build works.
          await rig.core.stopThread(await rig.core.threadForGame(project.name));
          return { ok: false, stopReason: "stopped", errorText: "stopped by you", sessionId: "ses_one" };
        }
        return { sessionId: "ses_one" };
      },
    });
    const { runId } = await runAutopilot(rig, project.name);
    const threadId = await rig.core.threadForGame(project.name);
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as Record<
      string,
      unknown
    > | null;
    assert.ok(journal, "the run kept its journal");
    assert.equal(journal!.phase, "paused", "a Stop pauses the run");
    assert.equal(journal!.finalization ?? null, null, "Resume goes on with the building, not the finalization");
  });
});

describe("Stop during the integration facet", () => {
  it("pauses the run, instead of judging it and closing it as done", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const project = await rig.core.games.scaffold("integrationstop");
    const plan = twoFacetPlan();
    let stopped = false;
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        await mkdir(path.join(cwd, "src"), { recursive: true });
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          await writeFile(path.join(cwd, "src", "water.js"), "export const water = 1;\n");
          return { sessionId: "ses_water" };
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          await writeFile(path.join(cwd, "src", "sky.js"), "export const sky = 1;\n");
          return { sessionId: "ses_sky" };
        }
        if (request.playtest)
          return { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) };
        if (!stopped && /YOUR FACET: Integration/.test(request.prompt)) {
          stopped = true;
          // The user presses Stop while the integration facet builds.
          await rig.core.stopThread(await rig.core.threadForGame(project.name));
          return { ok: false, stopReason: "stopped", errorText: "stopped by you", sessionId: "ses_integration" };
        }
        return null;
      },
    });
    const { runId, events } = await runAutopilot(rig, project.name);
    assert.ok(stopped, "the integration facet was reached and stopped");
    const threadId = await rig.core.threadForGame(project.name);
    const journal = (await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as Record<
      string,
      unknown
    > | null;
    assert.equal(journal?.phase, "paused", "the run can be resumed");
    assert.ok(
      customEvents(events, "autopilot_paused").some((e) => e.runId === runId),
      "the paused card is posted",
    );
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.globalVerdict ?? null, null, "nothing judged the stopped run");
  });
});

describe("a run's close the log refuses once", () => {
  it("is written on a second try instead of being dropped", async () => {
    const { appendClose } = await import("../../src/harness-seed/loop/director/integrate.ts");
    let refusals = 1;
    const appended: unknown[] = [];
    const { ctx } = ctxRecorder({
      handlers: {
        "events.append": (params) => {
          if (refusals-- > 0) throw new Error("EBUSY: the log is being rotated");
          appended.push(...((params.batch as unknown[]) ?? []));
          return { latestEventId: "e1" };
        },
      },
    });
    const close = { type: "custom", event_type: "run_finished", payload: { runId: "r1" } };
    await appendClose(ctx as never, "t1", [close] as never);
    assert.deepEqual(appended, [close], "the run is closed, not left running");
  });
});

describe("the ownership hook against a climb", () => {
  it("refuses a write that climbs out of an owned folder into a file the facet does not own", async () => {
    const hook = ownershipHook({ facetId: "sky", owns: ["src/sky/"], ownsMain: false }, "/w/marsh");
    const call = (file: string) =>
      hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: file } });
    for (const file of ["src/sky/../../index.html", "/w/marsh/src/sky/../studio.js", "/w/marsh/src/sky/../../../x.js"])
      assert.equal((await call(file)).decision, "block", file);
    assert.equal((await call("/w/marsh/src/sky/stars.js")).decision, undefined, "its own files stay writable");
  });
});

describe("the inbox replayed at boot", () => {
  it("restores every conversation's queue even when one of them cannot be", async () => {
    const { handleBootNotice } = await import("../../src/harness-seed/loop/boot-notice.ts");
    const errors: Array<{ threadId?: string; message: string }> = [];
    const host = {
      workspace: "/nonexistent",
      notify: () => {},
      call: async (
        method: string,
        params?: { threadId?: string; batch?: Array<{ type: string; message?: string }> },
      ) => {
        for (const data of params?.batch ?? [])
          if (data.type === "error") errors.push({ threadId: params?.threadId, message: String(data.message) });
        if (method === HostMethod.EventsInbox)
          return [
            { threadId: "broken", events: [] },
            { threadId: "fine", events: [] },
          ];
        return method === HostMethod.ThreadList ? [] : null;
      },
    };
    const restored: string[] = [];
    const messages = {
      restore: async (threadId: string) => {
        if (threadId === "broken") throw new Error("EIO while requeueing");
        restored.push(threadId);
      },
    };
    await handleBootNotice(
      { host, orphanRuns: new Map() } as never,
      messages as never,
      {
        reason: "start",
        openRuns: [],
      } as never,
    );
    assert.deepEqual(restored, ["fine"], "the other conversation still gets its answers");
    assert.deepEqual(
      errors.map((e) => e.threadId),
      ["broken"],
      "the conversation that lost its line is told so, where it is read",
    );
  });
});

describe("how a chat message's turn ended", () => {
  it("a message whose answer failed is recorded as handled without an answer", async () => {
    const { MessageQueue } = await import("../../src/harness-seed/loop/message-queue.ts");
    const events: Array<{ id: string; thread_id: string; data: Record<string, any> }> = [];
    const host = {
      call: async (method: string, p: { threadId: string; batch?: Array<Record<string, any>> }) => {
        if (method === HostMethod.EventsAppend)
          for (const data of p.batch ?? [])
            events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
        if (method === HostMethod.EventsList) return events;
        return null;
      },
      notify: () => {},
    };
    const queue = new MessageQueue(host as never, async () => {
      throw new Error("the engine's process exited");
    });
    await queue.enqueue({ type: "user_message", threadId: "chat", text: "make the pond deeper" } as never);
    assert.ok(
      await settleOn(() => events.some((e) => e.data.event_type === "coordinator_message_handled")),
      "the message was settled",
    );
    const handled = events.find((e) => e.data.event_type === "coordinator_message_handled")!;
    assert.equal(handled.data.payload.failed, true, "nobody reading the log takes it for an answered message");
  });

  it("a chat turn that stopped short says how in its turn_ended", async () => {
    const rig = await startRig();
    rigs.push(rig);
    rig.core.engines.register({
      id: "fake-direct",
      label: "Fake direct",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async () => {
        throw new EngineError("rate_limit", "fake-direct", "slow down");
      },
    });
    await rig.core.sendUserMessage("make a pond", { engine: "fake-direct" });
    const log = await waitForLog(rig.core, (l) => l.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");
    const ended = log.find((e) => e.data.type === "turn_ended")!.data as { metadata?: { outcome?: string } };
    assert.equal(ended.metadata?.outcome, "engine_limited", "the turn's own record says it was cut short");
  });
});

describe("a lead's plan and worker starts called together", () => {
  it("are answered one at a time, never interleaved", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    let inside = 0;
    let most = 0;
    const order: string[] = [];
    const step = (name: string) => async () => {
      inside++;
      most = Math.max(most, inside);
      order.push(`${name}:start`);
      await nextTurn();
      await nextTurn();
      order.push(`${name}:end`);
      inside--;
      return `${name} done`;
    };
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      toolsInFlight: 0,
      run: { runId: "r1" },
      state: { integrationHead: null, finished: false },
      journal: null,
      saveJournal: async () => {},
      keepMemory: async () => {},
      syncHead: async () => {},
      setPlan: step("plan"),
      startWorker: step("worker_start"),
    };
    const answers = await Promise.all([
      handler(loopRun as never, "plan", {}),
      handler(loopRun as never, "worker_start", { id: "sky" }),
      handler(loopRun as never, "worker_start", { id: "water" }),
    ]);
    assert.deepEqual(answers, ["plan done", "worker_start done", "worker_start done"]);
    assert.equal(most, 1, `one change to the run at a time: ${order.join(" ")}`);
  });
});

describe("what remember keeps of a fact", () => {
  async function rememberWith(memory: Record<string, unknown>, key: string, value: string) {
    const { tools } = await import("../../src/harness-seed/tools/self-tools.ts");
    const remember = tools.find((t) => t.name === "remember")!;
    let stored: Record<string, unknown> = memory;
    const ctx = {
      call: async (method: string, params: { value?: Record<string, unknown> }) => {
        if (method === HostMethod.ArtifactRead) return structuredClone(stored);
        if (method === HostMethod.ArtifactWrite) stored = params.value ?? {};
        return null;
      },
    };
    const answer = await remember.execute({ key, value }, ctx as never);
    return { answer: typeof answer === "string" ? answer : String((answer as { content?: string }).content), stored };
  }

  it("says when a fact was cut, instead of saying it was remembered whole", async () => {
    const { answer, stored } = await rememberWith({}, "taste", "x".repeat(400));
    assert.equal(String(stored.taste).length <= 301, true);
    assert.match(answer, /first 300 characters/, answer);
  });

  it("says which facts a full memory let go, and keeps a fact just updated as the newest", async () => {
    const full = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fact${i}`, `value ${i}`]));
    const updated = await rememberWith(full, "fact0", "value 0, revised");
    assert.ok("fact0" in updated.stored, "an update is not the oldest fact");
    assert.equal(Object.keys(updated.stored).length, 40);
    assert.doesNotMatch(updated.answer, /dropped/, "nothing was let go for an update");
    const added = await rememberWith(full, "fact40", "a new one");
    assert.ok(!("fact0" in added.stored), "the oldest fact makes room");
    assert.match(added.answer, /fact0/, `the model hears what it lost: ${added.answer}`);
  });
});

describe("a tool called with arguments its schema refuses", () => {
  it("answers the model what is wrong and runs nothing", async () => {
    const { createToolRegistry } = await import("../../src/harness-seed/tools/index.ts");
    const recorder = ctxRecorder({
      workspace: path.resolve("src/harness-seed"),
      unknown: { value: null },
      handlers: { "plugins.tools": () => ({ tools: [] }), "mcp.tools": () => ({ tools: [] }) },
    });
    const tools = await createToolRegistry(recorder.ctx as never, { threadId: "t1" } as never);
    const clicked = await tools.execute(
      { name: "click", arguments: { x: "the left door", y: 0.5 } },
      recorder.ctx as never,
    );
    assert.equal(clicked.ok, false);
    assert.match(clicked.content, /x/);
    const remembered = await tools.execute({ name: "remember", arguments: { key: "taste" } }, recorder.ctx as never);
    assert.equal(remembered.ok, false);
    assert.match(remembered.content, /value/);
    assert.deepEqual(
      recorder.sequence((m) => m === "preview.input" || m === "artifact.write"),
      [],
      "nothing ran on arguments the schema refuses",
    );
    const ok = await tools.execute({ name: "click", arguments: { x: "0.25", y: 0.5 } }, recorder.ctx as never);
    assert.notEqual(ok.content.includes("refused"), true, "a number sent as its digits still reads as a number");
  });
});

describe("the coordinator's prompt for a small model", () => {
  it("fits the share of the model's window it is given, and says where it was cut", async () => {
    const { coordinatorPrompt } = await import("../../src/harness-seed/loop/coordinator-prompts.ts");
    const big = { workers: Array.from({ length: 400 }, (_, i) => ({ id: `w${i}`, done: "x".repeat(80) })) };
    const history = Array.from({ length: 200 }, (_, i) => `user: message ${i} ${"y".repeat(100)}`).join("\n");
    const inputs = {
      events: [],
      run: { runId: "r1" },
      text: "is the sky done?",
      journal: { phase: "facets", facets: big },
      savedPlan: big,
      history,
    };
    const unbounded = coordinatorPrompt(inputs as never);
    const small = coordinatorPrompt({ ...inputs, budgetChars: 12_000 } as never);
    assert.ok(small.length < unbounded.length / 2, `${small.length} of ${unbounded.length}`);
    assert.ok(small.length <= 12_000 + 6_000, `the sections fit the budget beside the rules: ${small.length}`);
    assert.match(small, /characters cut/, "the model is told the record is not whole");
    assert.match(small, /is the sky done\?/, "the message itself is never cut");
  });
});

describe("the chat's main agent asked to read the owner's Downloads", () => {
  // Flipped: every brief said "Stay inside this workspace. Do not list or read
  // sibling folders", and the chat's own session, in Auto, refused to read the owner's Downloads
  // without trying. Where the game's work goes is the brief's to say; what it may reach is its
  // permissions'.
  it("keeps the game's work in its folder without forbidding the rest of the Mac", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const folderLabel = "AI Games/blame";
    const messages = [
      { role: "user", content: "Make Blame!" },
      { role: "user", content: "What is in my Downloads?" },
    ];
    const briefs = {
      fresh: buildContractorBrief({ ask: "Make Blame!", folderLabel }),
      "a follow-up": buildContractorBrief({ ask: "What is in my Downloads?", messages, folderLabel }),
      resumed: buildContractorBrief({ ask: "What is in my Downloads?", messages, resume: true, folderLabel }),
    };
    for (const [label, brief] of Object.entries(briefs)) {
      assert.match(brief, /`AI Games\/blame`/, `${label}: names the game's folder`);
      assert.doesNotMatch(
        brief,
        /stay inside|do not (list|search|read|explore)[^.]*(folder|project)/i,
        `${label}: forbids no other folder`,
      );
    }
  });
});

describe("the chat's agent briefed like plain Claude Code (lean chat)", () => {
  // A one-line "make a tower defense game" reached the model as 25k characters: judge-era template
  // rules (window.__studio, no Math.random, NOTES.md upkeep, .studio/ helpers, video frames, sandbox
  // shell syntax for a session with no sandbox), and every follow-up, a question too, ended with
  // "Pick up exactly where you left off and finish the remaining work" — so a person asking what the
  // build was doing watched it keep building.
  it("answers a question to a resumed chat instead of telling it to finish the remaining work", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const facts = [{ id: "web-game", path: "index.html" }];
    for (const launch of [null, { toolName: "start_autopilot", hours: 1, frameCount: 0, project: "td" }]) {
      const resumed = buildContractorBrief({ ask: "How do I play it?", resume: true, facts, launch });
      assert.ok(resumed.startsWith("How do I play it?"), resumed);
      assert.doesNotMatch(resumed, /left off|remaining work/i, `told to keep going: ${resumed}`);
    }
  });

  it("gives a new web game none of the judge-era template rules", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    for (const facts of [[], [{ id: "web-game", path: "index.html" }]]) {
      const brief = buildContractorBrief({
        ask: "Make a 2D platformer where a cat collects fish.",
        facts,
        fresh: true,
      });
      for (const rule of [/__studio/, /Math\.random/, /NOTES\.md/, /\.studio\//, /TMPDIR/, /statically analyze/]) {
        assert.doesNotMatch(brief, rule, `${rule}: ${brief}`);
      }
    }
  });
});

describe("an engine's plugin turned on from the chat's card (mp-unity)", () => {
  // A chat asked for a Unity game while the Unity plugin was off; its card turned the plugin on and
  // the same session resumed with "Go on with what I asked". The resumed brief carried no kind rules,
  // so the lead never heard "When the request names Unity, call unity__new-game" and launched a Loop:
  // the Loop gave the kindless folder the web starter, and unity__new-game was refused under the run.
  it("tells a resumed session of a folder with no kind yet which tool makes each kind on offer", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const { toolCall } = await import("../../src/harness-seed/loop/model-roles.ts");
    const engine = "claude-code";
    const unity = { plugin: "unity", name: "Unity", tool: "unity__new-game", makes: ["unity-project"] };
    const ask = "I turned on the Unity plugin from your card. Go on with what I asked.";
    const launch = { toolName: "start_autopilot", hours: 0.5, frameCount: 0, project: "cube-arena" };
    const resumed = buildContractorBrief({ ask, resume: true, engine, facts: [], kinds: [unity], launch });
    assert.ok(resumed.includes(`When the request names Unity, call ${toolCall(engine, unity.tool)}`), resumed);
    const made = buildContractorBrief({
      ask,
      resume: true,
      engine,
      facts: [{ id: "unity-project", path: "unity" }],
      kinds: [unity],
      launch,
    });
    assert.ok(!made.includes(toolCall(engine, unity.tool)), "a folder that has its kind is not told again");
  });
});

describe("stuck ladders and small reviewers", () => {
  const rulesUrl = "../../src/harness-seed/loop/facet/rules.ts";
  const judgementUrl = "../../src/harness-seed/loop/facet/round-judgement.ts";
  const ladder = [
    { id: "rules", what: "Rules: throw-ins, corners and goal kicks restart play, and a goal is scored" },
    { id: "flow", what: "A 90-minute clock, half time and Golden Goal overtime" },
  ];
  /** The match worker's contract as the lead wrote it: its ladder, owned by the lead. */
  const matchSpec = (extra: Record<string, unknown> = {}) => ({
    id: "match",
    checks: [],
    milestones: ladder.map((m) => ({ ...m })),
    moveOwner: "director",
    ...extra,
  });

  it("GGR-2. a rung measured by its own check, passing on the accepted build, is climbed before the round picks its move", async () => {
    const { rungsMetOnBoard } = await import(judgementUrl);
    const measured = matchSpec({
      milestones: [{ ...ladder[0], check: { id: "milestone-rules", kind: "probe" } }, { ...ladder[1] }],
    });
    assert.deepEqual(rungsMetOnBoard(measured, { "milestone-rules": { pass: true } }, []), ["rules"]);
    assert.deepEqual(rungsMetOnBoard(measured, { "milestone-rules": { pass: false } }, []), []);
    assert.deepEqual(rungsMetOnBoard(measured, {}, []), [], "unmeasured is not met");
    assert.deepEqual(rungsMetOnBoard(measured, { "milestone-rules": { pass: true } }, ["rules"]), [], "climbed once");
  });

  it("GGR-3. a rung missed round after round is set aside and the ladder moves on, instead of losing every round to it", async () => {
    const { chooseMove } = await import(rulesUrl);
    const { countRungMiss, RUNG_MISSES } = await import(judgementUrl);
    assert.equal(countRungMiss({}, "rules").setAside, false, "one miss is not a pattern");
    let misses: Record<string, number> = {};
    let setAside = false;
    for (let i = 0; i < RUNG_MISSES; i++) ({ misses, setAside } = countRungMiss(misses, "rules"));
    assert.equal(setAside, true, `set aside after ${RUNG_MISSES} misses`);
    assert.equal(misses.rules, RUNG_MISSES);
    assert.equal(chooseMove({ spec: matchSpec(), setAside: ["rules"] }).milestone.id, "flow", "the ladder moves on");
  });

  it("GGR-4. worker_steer move= was answered 'its next round builds it' and queued behind the rung the worker was stuck on: the steered rung goes next", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const { chooseMove } = await import(rulesUrl);
    const worker = { id: "match", title: "Match", state: "running", mode: "loop", steering: [], spec: matchSpec() };
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      toolsInFlight: 0,
      run: { runId: "ggr" },
      state: { workers: new Map([["match", worker]]), integrationHead: null, finished: false },
      journal: null,
      saveJournal: async () => {},
      keepMemory: async () => {},
      syncHead: async () => {},
      appendRun: async () => {},
      interruptWorker: async () => false,
    };
    const teamPlay = "The AI plays as a team: roles, passing lanes and a back line that steps up";
    const answer = String(await handler(loopRun as never, "worker_steer", { id: "match", move: teamPlay }));
    assert.match(answer, /next round builds it/);
    const next = chooseMove({ spec: worker.spec as never });
    assert.equal(next.milestone.what, teamPlay, "the steered rung goes ahead of the one the worker was stuck on");
    assert.equal(
      chooseMove({ spec: worker.spec as never, milestonesDone: [next.milestone.id] }).milestone.id,
      "rules",
      "and once it is climbed the ladder carries on where it was",
    );
  });

  it("GGR-8. once the lead's ladder is climbed the worker builds the reviewer's big move, not a round of polish", async () => {
    const { chooseMove } = await import(rulesUrl);
    const bigMove = { what: "a broadcast package: camera cuts, a replay director and a lineup intro", why: "" };
    const climbed = chooseMove({ spec: matchSpec(), milestonesDone: ["rules", "flow"], lastBigMove: bigMove });
    assert.equal(climbed.source, "reviewer");
    assert.equal(climbed.bigMove, bigMove);
    assert.equal(climbed.mandatory, false, "a reviewer's proposal is guidance: missing it never undoes a build");
    assert.equal(
      chooseMove({ spec: matchSpec(), lastBigMove: bigMove }).source,
      "milestone",
      "the lead's ladder first",
    );
    assert.deepEqual(chooseMove({ spec: matchSpec(), milestonesDone: ["rules", "flow"] }), {
      source: "none",
      mandatory: false,
    });
  });
});

/**
 * Polish has a stage of its own. When every rung is mandatory, a polish streak escalates into an
 * invented move and the judge caps polish at three optional nits, a build that needs finishing
 * throws its finishing rounds away. So the build stage stops claiming escalations that will not
 * happen, and a FINISH
 * stage (`spec.stage = "finish"`) lets polish be the work and win on the blind pick, with the
 * regression ratchet unchanged.
 */
describe("the finish stage and the false ESCALATE", () => {
  const stageUrl = "../../src/harness-seed/loop/facet/stage.ts";
  const ladder = [
    { id: "rain", what: "rain slicks the street and the neon reflects in it" },
    { id: "traffic", what: "traffic weaves in both lanes" },
  ];

  it("FIN-0. the stage is typed: finish only when the spec says exactly that, and a typed stage is refused by name", async () => {
    const { FacetStage, stageOf, movesInStage, polishEscalates, finishDone, isZeroDiff, stageArg } = await import(
      stageUrl
    );
    assert.equal(stageOf({}), FacetStage.Build);
    assert.equal(stageOf(null), FacetStage.Build);
    assert.equal(stageOf({ stage: "finish" }), FacetStage.Finish);
    assert.equal(stageOf({ stage: "FINISH" }), FacetStage.Build, "an unknown value is not a stage");
    assert.equal(movesInStage({ stage: "finish" }), false);
    assert.equal(movesInStage({}), true);
    assert.equal(polishEscalates({}), true, "a worker nobody owns the ladder of escalates, as it always did");
    assert.equal(polishEscalates({ moveOwner: "director" }), false, "a director-owned worker never does");
    assert.equal(polishEscalates({ stage: "finish" }), false);
    // The finisher's exit: preferred, running, identity holding — strict `satisfied` not asked.
    assert.match(String(finishDone({ won: true, summary: { identityAllPass: true } })), /finish is in/);
    assert.equal(finishDone({ won: true, broken: true, summary: { identityAllPass: true } }), null);
    assert.equal(finishDone({ won: true, summary: { identityAllPass: false } }), null);
    assert.equal(finishDone({ won: false, summary: { identityAllPass: true } }), null);
    // The finish stage's invisible-diff gate: only a pixel-identical frame is "nothing changed".
    assert.equal(isZeroDiff({ default: { diffFraction: 0, compared: 900 } }), true);
    assert.equal(isZeroDiff({ default: { diffFraction: 0.001, compared: 900 } }), false, "fine polish is a change");
    assert.equal(isZeroDiff({}), false, "no witness is no proof");
    assert.equal(isZeroDiff({ default: { diffFraction: 0, compared: 0 } }), false);
    // What a director types.
    assert.deepEqual(stageArg(undefined), { stage: null });
    assert.deepEqual(stageArg("finish"), { stage: "finish" });
    assert.match(
      String((stageArg("polish") as { error: string }).error),
      /stage: "polish" is not a stage \(build, finish\)/,
    );
    assert.match(String((stageArg("finish", { move: "rain" }) as { error: string }).error), /contradict/);
    assert.match(
      String((stageArg("finish", { milestones: JSON.stringify(ladder) }) as { error: string }).error),
      /contradict/,
    );
    assert.deepEqual(stageArg("build", { move: "rain" }), { stage: "build" });
  });

  it("FIN-1. a finishing worker's polish round is kept with no judge asked, nothing escalates, and a regression still rolls back", async () => {
    // Every window reports the score the worker's own file decides: a build that writes
    // "regress" breaks a probe that passes on the accepted build.
    const scoreFrom = (preview: FakePreview): FakePreview => {
      const plain = preview.studioState.bind(preview);
      preview.studioState = async (options: unknown) => {
        const state = (await plain(options as never)) as Record<string, unknown>;
        const file = preview.loadRoot
          ? await readFile(path.join(preview.loadRoot, "src", "paint.js"), "utf8").catch(() => "")
          : "";
        return { ...state, score: file.includes("regress") ? -1 : 5 };
      };
      // Fine polish: every camera moves by less than the build stage's "no visible change" line.
      preview.diffNext = { diffFraction: 0.001, meanAbsDiff: 1, grid: new Array(9).fill(0.001), compared: 1000 };
      preview.evaluations.push({ match: "count('lamp')", value: { value: false } });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => scoreFrom(makeFakePreview()) },
    );
    rigs.push(rig);
    scoreFrom(rig.preview);
    const project = await rig.core.games.scaffold("finish-street", { title: "Finish street" });
    const results: Record<string, any> = {};
    const plannerAsks: string[] = [];
    const finishAsks: string[] = [];
    let builds = 0;
    const text = (result: unknown): string =>
      typeof result === "string" ? result : String((result as { text?: unknown }).text);
    registerFakeEngine(
      rig,
      {
        complete: (asked, request) => {
          if (asked.includes("Name the ONE structural move")) {
            plannerAsks.push(asked);
            return JSON.stringify({ what: "a police chase through the district", why: "nothing chases", check: null });
          }
          if (!asked.includes("THE FACET UNDER JUDGEMENT")) return null;
          if (asked.includes("STAGE: finish")) finishAsks.push(asked);
          return JSON.stringify({
            pick: newestFixtureBuild(request),
            satisfied: false,
            regression: null,
            newCheck: null,
            bigMove: null,
            defects: [],
            polish: Array.from({ length: 6 }, (_, i) => `polish ${i + 1}: the puddles read flat`),
            moveDelivered: /THE MOVE the builder of build [AB]/.test(asked) ? false : null,
            scale: "polish",
            reason: "scripted",
          });
        },
        delegate: async (request) => {
          if (request.director) {
            const call = (name: string, args: Record<string, unknown>) =>
              request.onLiveTool!(name, args) as Promise<unknown>;
            await call("plan", {
              summary: "Finish the street: make what is there read at midnight.",
              workers: JSON.stringify([
                { id: "paint", title: "Paint", seam: "the street's finish", owns: "src/paint.js", minutes: 10 },
              ]),
              base: "the integration branch as it stands",
              risks: "none",
            });
            results.started = text(
              await call("worker_start", {
                id: "paint",
                title: "Paint",
                brief: "finish the street: wet asphalt, neon, readable signs",
                minutes: "10",
                iterations: "4",
                owns: "src/paint.js",
                stage: "finish",
                // An identity check that never passes keeps the worker going round after round.
                done: JSON.stringify([
                  {
                    what: "nine lamps light the street",
                    check: { id: "lamps", kind: "scene", js: "count('lamp') >= 9" },
                  },
                ]),
                checks: JSON.stringify([{ id: "keeps-score", kind: "probe", expr: "state.score >= 0" }]),
              }),
            );
            for (let i = 0; i < 120; i++) {
              results.status = JSON.parse(text(await call("worker_status", { id: "paint" })));
              if (results.status.state !== "running" || results.status.iterations >= 3) break;
              await call("wait", { seconds: "2", worker: "paint" });
            }
            await call("worker_stop", { id: "paint", why: "three rounds are enough to see" });
            for (let i = 0; i < 60; i++) {
              const waited = JSON.parse(text(await call("wait", { seconds: "2", worker: "paint" })));
              if (waited.status.workers[0]?.state !== "running") break;
            }
            await call("finish", { summary: "the street is finished", land: "no" });
            return { sessionId: "finish-lead", summary: "finished" };
          }
          // A follow-up after a regression: the builder does not restore it, so the round is refused.
          if (String(request.prompt).includes("VERIFICATION of your build")) return { sessionId: "paint-1" };
          builds++;
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          const body = builds === 2 ? "export const paint = 'regress';\n" : `export const paint = ${builds};\n`;
          await writeFile(path.join(request.cwd, "src", "paint.js"), body);
          return { sessionId: "paint-1" };
        },
      },
      "codex",
    );
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a neon street at midnight",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "night racer", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    } as never);
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "the finish run to end",
    );
    assert.match(results.started, /"started":"paint"/, results.started);
    const rounds = customEvents(events, "facet_iteration").filter((i) => i.runId === runId && i.facetId === "paint");
    const debug = JSON.stringify(rounds.map((i) => [i.iteration, i.winner, i.verdictSource, i.reason]));
    assert.ok(rounds.length >= 3, `three rounds were judged: ${debug} — ${JSON.stringify(results.status)}`);
    // No move of any kind: no rung, no reviewer's move, no planner call.
    const moves = customEvents(events, "facet_move").filter((m) => m.runId === runId && m.facetId === "paint");
    assert.deepEqual(
      moves.filter((m) => m.what),
      [],
      `a finishing worker is handed no move: ${JSON.stringify(moves)}`,
    );
    assert.equal(plannerAsks.length, 0, "the planner is never asked for a structural move");
    assert.ok(
      rounds.every((i) => i.verdictSource !== "no-move" && i.verdictSource !== "invisible"),
      `no round lost to a move nobody asked for, or to polish too fine for the build stage's gate: ${debug}`,
    );
    // The regression still rolls back.
    const regressed = rounds.find((i) => i.iteration === 2)!;
    assert.equal(regressed.verdictSource, "checks", debug);
    assert.equal(regressed.winner, "incumbent", debug);
    // Flipped (Loop phase 4): the polish round after it won on the judge's blind preference; it is kept
    // because nothing regressed, and no judge is asked.
    const polished = rounds.find((i) => i.iteration === 3)!;
    assert.equal(polished.verdictSource, "no-regression", debug);
    assert.equal(polished.winner, "challenger", debug);
    assert.deepEqual(finishAsks, [], "no taste judge was asked");
    const decisions = customEvents(events, "autopilot_decision").map((d) => String(d.decision));
    assert.deepEqual(
      decisions.filter((d) => /polished for/.test(d)),
      [],
      "nothing says the move is now mandatory",
    );
    assert.equal(results.status.stage, "finish", "the lead reads the stage on the worker");
    assert.equal(results.status.loop?.polishStreak, undefined, "the polish streak stayed at zero");
  });
});

describe("what the lead is told about its workers", () => {
  it("GGR-11. the brief said '8 of 8 worker windows free' of a pool whose workers could use six: it says how many workers may run at once", async () => {
    const { directorBrief } = await import("../../src/harness-seed/loop/director/briefs.ts");
    const now = Date.now();
    const brief = directorBrief({
      run: {
        runId: "ggr",
        project: "golden-goal-rush",
        goal: "an 11v11 broadcast soccer match",
        engine: "claude-code",
      },
      capacity: { max: 8, free: 8, memory: { freeMb: 13091 } },
      softDeadline: now + 120 * MINUTE_MS,
      finalDeadline: now + 135 * MINUTE_MS,
      integrationWorktree: "/runs/ggr/integration",
      baseCommit: "a".repeat(40),
    } as never);
    assert.match(brief, /up to 6 workers at once/);
    assert.doesNotMatch(brief, /8 of 8 worker windows free/);
  });
});

/**
 * A game linked to an Unreal project is built in the user's Unreal Editor, so its chat builds are
 * never checked as a web page: no preview load of its notes folder, no "fix the black screen" over a
 * black canvas, and no failed `build_observation` for SkillOpt to learn from. A game linked to an
 * Unreal project takes no web health pass.
 */
describe("an Unreal game is never checked as a web page", () => {
  const GAME = "tower-game";

  /** A rig whose game is linked to a real `.uproject`, whose preview would show a black canvas, and whose contractor edits game sources. */
  async function unrealGameRig(
    reply: Record<string, unknown> = {},
  ): Promise<{ rig: Rig; prompts: string[]; requests: DelegateRequest[] }> {
    const { writeEngineBinding } = await import("../../src/substrate/game-engine-binding.ts");
    const { ENGINES, UNREAL_ENGINE } = await import("../helpers/engines.ts");
    const { tmpDir } = await import("../helpers/tmp.ts");
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await rig.core.games.scaffold(GAME, { title: "Tower Game" });
    const uproject = path.join(await tmpDir("unreal-project-"), "Tower.uproject");
    await writeFile(uproject, "{}\n");
    await writeEngineBinding(game.dir, uproject, UNREAL_ENGINE.id, ENGINES);
    rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0.4, litFraction: 0 };
    const prompts: string[] = [];
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        prompts.push(request.prompt);
        requests.push(request);
        await writeFile(path.join(request.cwd, "src/lighthouse.js"), "export const lighthouse = 1;\n");
        return {
          ok: true,
          engine: "vendor",
          sessionId: "session-1",
          turns: 2,
          usage: {},
          summary: "Added it.",
          ...reply,
        };
      },
    });
    return { rig, prompts, requests };
  }

  /** The turn's log once it ended, and every chat message's text. */
  async function afterTurn(rig: Rig) {
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");
    const messages = (await rig.core.store.listMessages(rig.core.mainThread)).map((m) => m.content ?? "");
    return { events, said: messages.join("\n") };
  }

  it("an Unreal game's chat build gets the Unreal brief and no web health pass: no black-screen line, no failed build_observation", async () => {
    const { rig, prompts } = await unrealGameRig();
    await rig.core.sendUserMessage("Add a lighthouse", { engine: "vendor", project: GAME });
    const { events, said } = await afterTurn(rig);
    assert.equal(prompts.length, 1);
    // The Unreal plugin is off in this rig: the build is briefed for an Unreal project without its tools.
    assert.match(prompts[0]!, /it holds an Unreal Engine project/, "the build is briefed for Unreal");
    assert.match(prompts[0]!, /no Unreal tools/, "with the plugin off, without its tools");
    assert.doesNotMatch(prompts[0]!, /window\.__studio/, "and not as a web page");
    assert.equal(customEvents(events, "build_observation").length, 0, "no web observation of an Unreal game");
    assert.doesNotMatch(said, /black screen|loads clean|console error/, "no web verdict in the chat");
    assert.match(said, /Added it\./, "the contractor's report still reaches the chat");
  });

  it("an Unreal game's builder is told no web-only plugin skills and is handed no web capture tool or checkpoint line", async () => {
    const { rig, requests } = await unrealGameRig();
    await rig.core.plugins.setEnabled("genex", true);
    await rig.core.sendUserMessage("Add a lighthouse", { engine: "vendor", project: GAME });
    await afterTurn(rig);
    const [request] = requests;
    assert.ok(request, "the build reached the builder");
    const web = rig.core.plugins.snapshot(GameEngine.Web).applied.skills;
    const told = rig.core.plugins.snapshot(GameEngine.Unreal).applied.skills;
    const webOnly = web.filter((skill) => !told.includes(skill));
    assert.ok(webOnly.includes("genex/genex-threejs-multiplayer"), "the web has skills an Unreal game does not");
    for (const skill of webOnly) assert.ok(!request.prompt.includes(`[${skill}]`), `${skill} stays out of its brief`);
    assert.equal(request.onCapture, undefined, "no capture of a folder that holds notes");
    assert.doesNotMatch(request.prompt, /lights the user's Reload/, "no web preview Reload to light");
  });

  it("a Loop question after an edit to an Unreal game takes no web health pass either", async () => {
    const { rig } = await unrealGameRig({
      studioToolCalls: [{ name: "ask_user", args: { question: "A second lighthouse?" } }],
    });
    await rig.core.sendUserMessage("Add a lighthouse", { engine: "vendor", project: GAME, autopilot: { hours: 1 } });
    const { events, said } = await afterTurn(rig);
    assert.equal(customEvents(events, "interview_question").length, 1, "the question is still asked");
    assert.equal(customEvents(events, "build_observation").length, 0);
    assert.doesNotMatch(said, /black screen|loads clean|console error/);
  });
});

import { LeadTool } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { runUnrealLead } from "../../src/harness-seed/loop/unreal/lead.ts";
import { UnrealLoopTool } from "../../src/harness-seed/loop/unreal/live-contract.ts";
import { PROJECT_FACTS_FILE } from "../../src/harness-seed/loop/unreal/project-facts.ts";
import { LoopTool, PartRunState } from "../../src/plugins/unreal/editor-queue.ts";
import { checkPython, PythonProblemCode } from "../../src/plugins/unreal/python-check.ts";
import { coreLite } from "../helpers/core-lite.ts";
import * as editorStandIn from "../helpers/unreal-editor-stand-in.ts";
import * as leadLoop from "../helpers/unreal-lead-host.ts";

/** One Unreal lead run on a fake host (`unreal-lead-host.ts`), on its clock, of `minutes` working minutes. */
function runLead(host: leadLoop.LeadHost, options: { minutes?: number; resume?: boolean } = {}) {
  const run = options.minutes
    ? { ...leadLoop.RUN, budgets: { ...leadLoop.RUN.budgets, wallClockMs: options.minutes * MINUTE_MS } }
    : leadLoop.RUN;
  return runUnrealLead(host.rec.ctx as never, {
    threadId: "t1",
    run: run as never,
    resume: options.resume === true,
    now: host.now,
    sleep: host.sleep,
  });
}

/** The lead's turns on a lead host, as they were delegated. */
const leadTurns = (host: leadLoop.LeadHost) => host.rec.paramsOf("engine.delegate");

/**
 * A Loop on a racing game from Epic's Vehicle template: the lead's brief carries the template's
 * input and pawn, each save point lands, builders and the chat never hold the runner-only tools, an
 * invented Python method fails the gate, the play test runs unthrottled, and the Builds graph calls
 * the parts that landed what they are. The part runner and the step machine after it are retired
 * for one lead (`loop/unreal/lead.ts`); these rows hold it to the same rules.
 */
describe("a Loop on a vehicle template", () => {
  it("UL7. nobody told the lead or the builders which pawn the template's game mode spawns: the lead's brief carries the template's facts from export_project's file, which the editor writes when the game has none yet", async () => {
    const host = leadLoop.leadHost();
    let exported = false;
    host.rec.handle("run.exec", (params) => {
      const command = String(params.command);
      if (command.includes(PROJECT_FACTS_FILE))
        return { code: 0, stdout: exported ? JSON.stringify(leadLoop.TEMPLATE) : "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    host.answers.set(UnrealLoopTool.ExportReference, () => {
      exported = true;
      return { engine: "5.8", nodes: 1, stored: true };
    });
    await runLead(host, { minutes: 20 });
    const facts = /THE TEMPLATE:[\s\S]*BP_ThirdPersonGameMode spawns BP_ThirdPersonCharacter[\s\S]*FollowCamera/;
    assert.match(host.prompts()[0] ?? "", facts, "the lead's brief knows the template");
    assert.match(host.prompts()[0] ?? "", /third-person character/, "and that template's own facts, no other's");
  });

  it("UL8. every part read 'Left out' and the result 'No new build': each save point is merged into the game and the run says it landed", async () => {
    const host = leadLoop.leadHost();
    const report = await runLead(host, { minutes: 40 });
    const saves = host.snapshotReasons().length;
    assert.ok(saves >= 2, `${saves} save points`);
    assert.equal(host.appended("integration_merge").length, saves, "each save point is an integration_merge");
    assert.equal(report.landed, true);
    assert.equal(host.appended("run_finished").at(-1)?.landed, true);
  });

  it("builders and the chat are never handed the runner-only Loop tools (run-part, rollback-part, ...): a chat's and a builder's Unreal tools leave out every harness-only one", async (t) => {
    const { core, close } = await coreLite();
    // The plugin's backend and its editor bridge stop here; a core that was only initialized stops nothing of its own.
    t.after(async () => {
      core.plugins.cancel();
      await core.mcp.close().catch(() => {});
      await close();
    });
    await core.plugins.setEnabled("unreal", true);
    const project = "racer";
    const game = await core.games.scaffold(project);
    // The builder's gate and lookups reach a game that holds an Unreal project.
    await writeFile(path.join(game.dir, "Racer.uproject"), "{}");
    const threadId = await core.createGameThread(project);
    const handed: string[][] = [];
    core.engines.register({
      id: EngineId.ClaudeCode,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        handed.push((request.liveTools ?? []).map((tool) => tool.name).filter((name) => name.startsWith("unreal__")));
        return { ok: true, engine: EngineId.ClaudeCode, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const api = core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const delegate = (extra: Record<string, unknown>) =>
      api["engine.delegate"]?.({ engine: EngineId.ClaudeCode, project, threadId, ...extra });
    await delegate({ prompt: "Make the bike first-person" });
    const worktree = path.join(core.layout.scratch, "worktrees", `${project}-RiderView-1`);
    await mkdir(worktree, { recursive: true });
    await delegate({ prompt: "Build the part RiderView", cwd: worktree });
    const runnerOnly = [
      UnrealLoopTool.RunPart,
      UnrealLoopTool.PartResult,
      UnrealLoopTool.RollbackPart,
      UnrealLoopTool.ReloadLevel,
      UnrealLoopTool.ExportReference,
    ];
    assert.equal(handed.length, 2);
    for (const [who, tools = []] of [
      ["the chat", handed[0]],
      ["a builder", handed[1]],
    ] as const) {
      for (const name of runnerOnly) assert.ok(!tools.includes(name), `${who} is not handed ${name}`);
      assert.ok(tools.includes(UnrealLoopTool.CheckPart), `${who} still has the builder's gate`);
      // The C++ module's tools are any Unreal project's agents' own: the one Loop's lead calls them.
      for (const name of [UnrealLoopTool.CppStatus, UnrealLoopTool.AddCppModule])
        assert.ok(tools.includes(name), `${who} is handed ${name}`);
    }
  });

  it("the play test ran with Unreal's background throttle on: the editor queue turns the throttle off before StartPIE and gives it back after stop_play", async () => {
    const editor = editorStandIn.standIn();
    const run = await editorStandIn.runLantern(editor.port);
    assert.equal(run.state, PartRunState.Done);
    assert.equal(editor.state.throttleAtPlay, false, "the test played unthrottled");
    assert.equal(editor.state.throttle, true, "the editor has its setting back");
    assert.deepEqual(editorStandIn.written(editor.calls), [false, true]);
    const tools = editorStandIn.sequence(editor.calls);
    assert.ok(tools.indexOf(LoopTool.SetProperties) < tools.indexOf(LoopTool.StartPlay), "lifted before play");
    assert.ok(tools.lastIndexOf(LoopTool.SetProperties) > tools.indexOf(LoopTool.StopPlay), "given back after it");
  });

  it("an apply.py called an invented method (set_generate_overlap_events) and passed the gate: the check names an unknown method on an object of a known class", async (t) => {
    const python = await promisify(execFile)("python3", ["-c", "import ast"]).then(
      () => "python3",
      () => "",
    );
    if (!python || process.platform === "win32") {
      t.skip("needs python3 (the product uses Unreal's own)");
      return;
    }
    const names = path.join(await tmpDir("python-names-"), "python-names.json");
    await writeFile(
      names,
      JSON.stringify({
        Actor: ["get_component_by_class"],
        StaticMeshComponent: ["set_editor_property"],
        PrimitiveComponent: ["generate_overlap_events", "set_editor_property"],
      }),
    );
    const source = [
      "import unreal",
      "box = actor.get_component_by_class(unreal.StaticMeshComponent)",
      "box.set_generate_overlap_events(True)",
    ].join("\n");
    const problems = await checkPython({ python, names }, source);
    assert.deepEqual(
      problems.map((p) => [p.code, p.line]),
      [[PythonProblemCode.UnknownName, 3]],
    );
    assert.match(problems[0]?.message ?? "", /set_generate_overlap_events \(a StaticMeshComponent\)/);
    assert.match(problems[0]?.message ?? "", /set_editor_property\("generate_overlap_events"/, "and what to call");
  });
});

/**
 * A step machine on an Unreal game threw work away: every try started in a fresh copy and lost the
 * one before it, and a crash or a refusal restored the last kept step, so whole steps of visible
 * work went. The lead builds in one session in the game folder; only its own rewind takes the game
 * back, to the save point it names.
 */
describe("an Unreal Loop that threw its work away", () => {
  it("UL0. every try started in a fresh copy and lost the work before it: the lead's turns go on in one session in the game folder, and only its own rewind takes the game back, to the save point it names", async () => {
    const rewinds: leadLoop.Turn = async ({ tool, host }) => {
      host.work("a bridge that reads badly");
      await tool(LeadTool.Rewind, { label: "Turn 2" });
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [leadLoop.buildsAndSaves, leadLoop.buildsAndSaves, rewinds] });
    await runLead(host, { minutes: 50 });
    assert.deepEqual(host.rec.paramsOf("snapshot.worktree"), [], "no copy of the game");
    const resumes = leadTurns(host).map((t) => t.resume ?? null);
    assert.deepEqual(resumes.slice(0, 4), [null, "session-1", "session-1", "session-1"], "one session throughout");
    assert.deepEqual(
      host.rec.paramsOf("snapshot.restore").map((p) => p.snapshotId),
      ["snap-2"],
      "back to the save point it named, not the run's start",
    );
  });
});

/** How the engine question opens in a brief, whatever words each kind's plugin offers it with. */
const ENGINE_QUESTION = "FIRST, THE ENGINE:";

/**
 * New game makes the game before the chat's first ask, as an empty folder with no kind; with the
 * Unreal plugin on, the delegated turn finds a project that already exists. A folder with no kind
 * yet (the host's facts) is asked with the question card, exactly as a game the turn makes itself,
 * and not again in the session that asked: the answer comes back to it, the card still at hand.
 */
describe("a game New game made is asked its engine on its chat's first ask", () => {
  it("with the Unreal plugin on, a game New game made is empty, its chat's first build asks web or Unreal with the question card, and its next does not", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    await rig.core.plugins.setEnabled("unreal", true);
    const requests: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        return { ok: true, engine: "vendor", sessionId: "session-1", turns: 1, usage: {}, summary: "Web or Unreal?" };
      },
    });
    const game = await rig.core.createGame("Arcade Racer");
    assert.deepEqual(
      (await rig.core.games.list()).find((listed) => listed.name === game.name)?.facts,
      [],
      "the made game has no kind yet",
    );
    const thread = await rig.core.threadForGame(game.name);
    const turnsEnded = (count: number) =>
      waitForLog(
        rig.core,
        (log) => log.filter((e) => e.thread_id === thread && e.data.type === "turn_ended").length >= count,
        30_000,
        `turn ${count}`,
      );
    await rig.core.sendUserMessage("Make me a small arcade racing game with a neon city track.", {
      engine: "vendor",
      thread,
    });
    await turnsEnded(1);
    await rig.core.sendUserMessage("Web, please", { engine: "vendor", thread });
    await turnsEnded(2);
    const [first, next] = requests;
    assert.ok(first && next, "both messages reached the builder");
    const asks = (prompt: string) => prompt.split("\n").some((line) => line.startsWith(ENGINE_QUESTION));
    assert.ok(asks(first.prompt), "the first build asks the engine first");
    assert.deepEqual(
      first.interviewTools?.map((tool) => tool.name),
      ["start_autopilot", "ask_user"],
      "with the question card bridged in beside Auto's Loop start (flipped: auto-loop)",
    );
    assert.ok(!asks(next.prompt), "a later message is never asked again");
    assert.deepEqual(
      next.interviewTools?.map((tool) => tool.name),
      ["start_autopilot", "ask_user"],
      "the session that asked keeps its card while the game has no kind (flipped: resumed card)",
    );
  });
});

/**
 * A game linked to Unreal during its turn (the user answered the engine question and the builder
 * made the game's Unreal project in that same turn): the turn's end reads the game's engine again,
 * so it never loads the web preview, judges a black canvas or records a failed `build_observation`.
 */
describe("a game linked to Unreal during its turn", () => {
  it("a game linked to Unreal during its turn got the web health pass and a black-screen line: no preview load, no build_observation, the builder's report alone", async () => {
    const { writeEngineBinding } = await import("../../src/substrate/game-engine-binding.ts");
    const { ENGINES, UNREAL_ENGINE } = await import("../helpers/engines.ts");
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const game = await rig.core.games.scaffold("city-circuit", { title: "City Circuit" });
    // The folder the web preview would load shows a black canvas.
    rig.preview.pixelStatsNext = { ...rig.preview.pixelStatsNext, meanLuma: 0, litFraction: 0 };
    const report = "Made the Unreal project from the vehicle template. Unreal is opening it for the first time.";
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        // What `unreal__new-game` did mid-turn: the project inside the game's folder, the game linked to it.
        const uproject = path.join(game.dir, "unreal", "CityCircuit.uproject");
        await mkdir(path.dirname(uproject), { recursive: true });
        await writeFile(uproject, "{}\n");
        await writeEngineBinding(game.dir, uproject, UNREAL_ENGINE.id, ENGINES);
        await writeFile(path.join(request.cwd, "NOTES.md"), "# City Circuit\n");
        return { ok: true, engine: "vendor", sessionId: "cc-1", turns: 9, usage: {}, summary: report };
      },
    });
    await rig.core.sendUserMessage("Unreal Engine", { engine: "vendor", project: game.name });
    const events = await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn");
    const said = (await rig.core.store.listMessages(rig.core.mainThread)).map((m) => m.content ?? "").join("\n");
    assert.equal((await rig.core.games.list()).find((g) => g.name === game.name)?.engine?.kind, GameEngine.Unreal);
    assert.deepEqual(rig.preview.loads, [], "the web preview never loads the Unreal game's folder");
    assert.equal(customEvents(events, "build_observation").length, 0, "no web observation for SkillOpt to learn from");
    assert.doesNotMatch(said, /black screen|loads clean|console error/, "no web verdict in the chat");
    assert.ok(said.includes(report), "the builder's report reaches the chat");
  });
});

/**
 * The single lead in a long Unreal run, and the harness's answers: a crash reopens the editor in
 * place instead of undoing a whole step; a turn's unsaved editor work is saved and snapshotted
 * between turns; the lead is steered to save after a stretch of unsaved work; the owner's words are
 * steered into the turn at once; the run's end gets a final save; and a Resume of a run the older
 * step machine made closes cleanly.
 */
describe("the Unreal lead's saves, crashes, owner words and end", () => {
  it("UL1. Unreal crashed mid-turn and the harness restored the last kept step, throwing away the work since: Unreal is reopened in place, nothing restored, and the lead told what may be lost", async () => {
    const crashes: leadLoop.Turn = async ({ host }) => {
      host.work("the second stair");
      host.editor.answering = false;
      await host.until(() => host.steered().some((said) => /crashed/.test(said)));
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [leadLoop.buildsAndSaves, crashes] });
    await runLead(host, { minutes: 40 });
    assert.ok(host.tools().includes(UnrealLoopTool.ReopenEditor), "reopened");
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing restored");
    const said = host.steered().find((text) => /crashed/.test(text)) ?? "";
    assert.match(said, /Unreal crashed at \d\d:\d\d and was reopened/);
    assert.match(said, /since save point 'Turn 1' may be lost: check the level and continue/);
  });

  it("UL12. a long script kept the editor's game thread busy, the crash watch missed its answers, and Unreal was ended mid-turn with its work unsaved: an editor whose process runs is busy, never crashed", async () => {
    const scripts: leadLoop.Turn = async ({ host }) => {
      host.work("the tower's ribs");
      // run_script holds the game thread: no answers for a while, the editor process runs on.
      host.editor.answering = false;
      host.editor.running = true;
      const since = host.clock.now;
      await host.until(() => host.clock.now - since >= 45 * SECOND_MS);
      host.editor.answering = true;
      host.editor.running = undefined;
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [scripts] });
    await runLead(host, { minutes: 20 });
    assert.ok(host.tools().filter((name) => name === UnrealLoopTool.EditorState).length >= 3, "the watch looked");
    assert.ok(!host.tools().includes("unreal__end-editor"), "never ended");
    assert.ok(!host.tools().includes(UnrealLoopTool.ReopenEditor), "never reopened");
    assert.doesNotMatch(host.steered().join("\n"), /crashed/);
    assert.equal(host.snapshotReasons()[0], "Autosave", "its work was saved once it answered again");
  });

  it("UL16. the person's Stop while Unreal opened for the run ended it paused, blaming the game's plugins: a Stop is always the person's stop", async () => {
    const host = leadLoop.leadHost();
    host.rec.handle("hooks.fire", (params) => {
      if (params.on !== "run.prepare") return { blocked: null, pending: null, notes: [], images: [], ran: [] };
      host.rec.cancel();
      throw new Error("Stopped.");
    });
    const report = await runLead(host, { minutes: 20 });
    // A Stop pauses every Loop for a Resume: it ends as the person's stop, never as the plugins' halt.
    assert.deepEqual([report.executionStatus, report.endReason], ["paused", "stopped"]);
    assert.doesNotMatch(String(report.stoppedBecause), /couldn't ask the game's plugins/);
  });

  it("UL17. a crash Genex held back for another holder rolled the game back to its last save point, losing the work since: nothing is restored, and the run halts saying why", async () => {
    const crashes: leadLoop.Turn = async ({ host }) => {
      host.work("the second stair");
      host.editor.answering = false;
      await host.until(() => host.rec.paramsOf("hooks.fire").some((p) => p.on === "crash"));
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [leadLoop.buildsAndSaves, crashes] });
    const passOn = host.rec.ctx.call;
    const busy = {
      plugin: "@genex",
      tool: "",
      reason: "Another holder is working in Unreal now.",
      hold: "busy",
      label: "Unreal",
    };
    host.rec.ctx.call = (method: string, params?: Record<string, unknown>) =>
      method === "hooks.fire" && params?.on === "crash"
        ? Promise.resolve({ blocked: busy, pending: null, notes: [], images: [], ran: [] })
        : passOn(method, params);
    const report = await runLead(host, { minutes: 40 });
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "the work since the save point stays");
    assert.equal(report.executionStatus, "paused");
  });

  it("UL2. an hour of editor work went by without a save point: after 15 minutes of unsaved work the lead is steered to look, then save", async () => {
    const works: leadLoop.Turn = async ({ host }) => {
      host.work("the shaft");
      host.clock.now += 6 * MINUTE_MS;
      await host.until(() => host.steered().some((said) => /save_point/.test(said)));
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [works] });
    await runLead(host, { minutes: 90 });
    const said = host.steered().find((text) => /save_point/.test(text)) ?? "";
    assert.match(said, /About 1[5-9] minutes of work since your last save point\. Look at it now/);
    assert.match(said, /mcp__studio__save_point/);
  });

  it("UL14. a lead that saved every few minutes ended three short turns in a row, and the run stopped as idle with a quarter of its time left: a turn that made a save point is never idle", async () => {
    const host = leadLoop.leadHost({ turns: [leadLoop.buildsAndSaves] });
    host.turnMs = 30_000;
    const report = await runLead(host, { minutes: 20 });
    assert.notEqual(report.endReason, "idle");
    assert.ok(host.appended("facet_iteration").length > 3, "it went on saving past the third short turn");
  });

  it("UL3. a turn ended with unsaved editor work and no snapshot: the harness saves and snapshots it between turns, and the lead hears so", async () => {
    const host = leadLoop.leadHost({ turns: [leadLoop.buildsOnly] });
    await runLead(host, { minutes: 40 });
    assert.equal(host.snapshotReasons()[0], "Autosave");
    const trail = host.trail();
    const first = trail.indexOf("engine.delegate");
    const saved = trail.indexOf("tool:unreal__save-all", first);
    const snapshot = trail.indexOf("snapshot.create", saved);
    const next = trail.indexOf("engine.delegate", first + 1);
    assert.ok(saved > first && snapshot > saved, "saved all, then snapshotted");
    assert.ok(snapshot < next, "between the turns");
    assert.match(host.prompts()[1] ?? "", /Your turn ended with unsaved work, so Genex saved it as 'Autosave'/);
  });

  it("UL4. a Resume of a run the older Unreal Loop made found no journal it could read: the run closes cleanly with a plain line, and its journal is done", async () => {
    const host = leadLoop.leadHost();
    const older = { kind: "unreal-live", phase: "paused", run: leadLoop.RUN, seat: {}, features: [], helpers: [] };
    host.artifacts.set(`autopilot_${leadLoop.RUN.runId}`, older);
    const report = await runLead(host, { resume: true });
    assert.match(String(report.stoppedBecause), /made by an older Unreal Loop[^\n]*start a new run/);
    assert.equal(report.executionStatus, "completed");
    assert.equal(leadTurns(host).length, 0, "no turn");
    assert.deepEqual(host.tools(), [], "Unreal is never asked anything");
    assert.equal((host.artifacts.get(`autopilot_${leadLoop.RUN.runId}`) as { phase?: string }).phase, "done");
    assert.equal(host.appended("run_finished").length, 1);
  });

  it("UL5. the owner's words are steered into the turn at once, to be acted on now, never parked for later", async () => {
    let handed = false;
    const hears: leadLoop.Turn = async ({ host }) => {
      handed = true;
      leadLineOf(leadLoop.RUN.runId)?.hear(
        { threadId: "t1", messageId: "m1", text: "use Blender for the stairs" },
        async () => {},
      );
      await host.until(() => host.steered().some((said) => /Blender/.test(said)));
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [hears] });
    let given = false;
    const steering = async () => {
      if (!handed || given) return [];
      given = true;
      return ["use Blender for the stairs"];
    };
    Object.assign(host.rec.ctx, { runInbox: { finishing: async () => false, steering } });
    await runLead(host, { minutes: 90 });
    const said = host.steered().find((text) => /Blender/.test(text)) ?? "";
    assert.match(
      said,
      /The owner says:\nuse Blender for the stairs\nAct on this now unless it conflicts with the edit you are in the middle of; then do it right after\./,
    );
    assert.doesNotMatch(said, /when it fits/);
  });

  it("UL6. the run's last minutes went by with no final save and no notes: near its end the lead is steered to wrap up and save 'Final'", async () => {
    const works: leadLoop.Turn = async ({ host }) => {
      host.work("the last landing");
      host.clock.now += 35 * MINUTE_MS;
      await host.until(() => host.steered().some((said) => /wrap up/.test(said)));
      return undefined;
    };
    const host = leadLoop.leadHost({ turns: [works] });
    await runLead(host, { minutes: 60 });
    const said = host.steered().find((text) => /wrap up/.test(text)) ?? "";
    assert.match(said, /About \d+ minutes are left: wrap up/);
    assert.match(said, /save_point with label "Final"[\s\S]*NOTES\.md[\s\S]*did not test/);
  });
});

describe("suggestions that reached the Harness page as plain text or not at all", () => {
  it("HP-1. a proposer reply with a code fence inside its JSON, or a skill echoed in a markdown fence first, read as no JSON and the suggestion vanished: the JSON is read", async () => {
    const { readJudgeJson } = await import("../../src/harness-seed/loop/judge-provenance.ts");
    const fenceInside = JSON.stringify({
      edits: [{ op: "append", text: "```js\nfoo()\n```" }],
      title: "Show the code",
    });
    assert.deepEqual(readJudgeJson(fenceInside), JSON.parse(fenceInside));
    const echoedFirst = 'The file:\n```markdown\n# Skill\n- rule\n```\n```json\n{"edits":[],"title":"t"}\n```';
    assert.deepEqual(readJudgeJson(echoedFirst), { edits: [], title: "t" });
    assert.deepEqual(readJudgeJson('```json\n{"pick":"B"}\n```'), { pick: "B" }, "a fenced answer reads as before");
  });
});

/**
 * A new game from home, first message "Hello": the game was named "Hello World
 * Adventure", and the reply was seven tool steps, one failed, and a report that the workspace was
 * still empty, its renderer and inspection hooks set up, with a question card about what to make.
 * The brief had said "Continue from the existing code in this workspace" and nothing about how to
 * answer small talk.
 */
describe("a Hello in a brand-new game", () => {
  it("HG-1. a greeting in a game the studio just made is briefed as a blank page, talking like a person first", async () => {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const prompts: string[] = [];
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "Hello" }],
        "events.list": () => [],
        "game.list": () => [{ name: "untitled-game", title: "Untitled game", dir: "/g/untitled-game" }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "run.exec": (params) => ({
          code: 0,
          stdout: String(params.command).includes("rev-list") ? "1\n" : "",
          stderr: "",
        }),
        "engine.delegate": (params) => {
          prompts.push(String(params.prompt));
          return { ok: true, engine: "claude-code", turns: 1, usage: {}, sessionId: "s1", summary: "Hi!" };
        },
      },
    });
    await runDelegatedTurn(recorder.ctx as never, {
      threadId: "t1",
      turnId: "turn-1",
      text: "Hello",
      engine: "claude-code",
      engineLabel: "Claude Code",
      project: "untitled-game",
    });
    const brief = prompts[0] ?? "";
    assert.doesNotMatch(brief, /Continue from the existing code/);
    assert.match(brief, /nothing has been built/i);
    const talk = brief.search(/greeting/i);
    const building = brief.search(/start_web_game|serves its index\.html|checkpoint/);
    assert.ok(talk >= 0 && talk < building, "how to answer a greeting comes before how to build");
  });
});

import { settleAgents, startAgent } from "../../src/harness-seed/loop/unreal/agents.ts";
import { askCritic, CAPTURES_FOLDER } from "../../src/harness-seed/loop/unreal/critic.ts";
import { type Lead as UnrealLead, newLeadJournal } from "../../src/harness-seed/loop/unreal/lead-journal.ts";

/**
 * The Unreal Loop's helpers: a model and a texture helper each finished their work in a copy of
 * the game, nothing landed it, and the run's close deleted both copies, the paid work with
 * them. They had been offered the user's editor connector, Genex publishing and the paid CLI, and
 * their Blender jobs carried no run, so no card reached the Builds graph. And a judge's verdict
 * undid visible progress the lead had made. Now a sub-agent's delivery lands when its turn ends and
 * is kept at the close; it is offered only its kind's tools, attributed to its own part; and the
 * critic advises without changing anything.
 */
describe("the Unreal lead's sub-agents and critic", () => {
  const MODEL = "assets/agents/blender_model-1/model.glb";
  const MANIFEST = "assets/agents/blender_model-1/manifest.json";

  /** The host's git and shell answers for a delivery of one model with its manifest. */
  function deliveryExec(params: Record<string, unknown>) {
    const command = String(params.command);
    const entries = [`100644 blob ${"1".repeat(40)} 2048\t${MODEL}`, `100644 blob ${"2".repeat(40)} 90\t${MANIFEST}`];
    if (command.includes("ls-tree")) return { code: 0, stdout: entries.map((e) => `${e}\0`).join(""), stderr: "" };
    if (command.startsWith("git show"))
      return { code: 0, stdout: JSON.stringify({ files: [{ path: MODEL, role: "mesh", meshes: 1 }] }), stderr: "" };
    if (command.includes("manifest.json")) return { code: 0, stdout: "yes\n", stderr: "" };
    return { code: 0, stdout: command.includes("rev-parse") ? "c0ffee12\n" : "", stderr: "" };
  }

  /** A lead on a fake host whose sub-agent turns deliver one model with its manifest (or hold until the close). */
  async function subAgentLead(turn: "delivers" | "holds" = "delivers") {
    const dir = await tmpDir("incident-agents-");
    const aborted = new Set<string>();
    const recorder = ctxRecorder({
      handlers: {
        "events.append": () => "e",
        "artifact.write": () => 1,
        "engine.abort": (params) => {
          aborted.add(String(params.cwd));
          return { aborted: 1 };
        },
        "engine.delegate": async (params) => {
          for (let i = 0; turn === "holds" && !aborted.has(String(params.cwd)) && i < 100; i++) await nextTurn();
          return { ok: turn === "delivers", engine: "claude-code", summary: "made it", usage: {}, turns: 1 };
        },
        "run.exec": deliveryExec,
      },
    });
    const run = { runId: "run-ul", goal: "g", project: "tower", engine: "claude-code", budgets: {} };
    const seat = { folder: dir, chatSession: false, sessionId: null, bookmarked: null, engine: undefined, model: null };
    const lead = {
      ctx: recorder.ctx,
      run,
      threadId: "t1",
      clock: { now: () => 1_000, sleep: async () => {} },
      game: { dir, title: "Tower" },
      journal: newLeadJournal(run as never, seat),
      started: 0,
      cpp: { available: false, why: "none" },
      offers: { blender: true, genex: true },
      addModule: false,
      agentRuns: new Map(),
    } as unknown as UnrealLead;
    return { lead, recorder, dir };
  }

  it("UL9. a helper's finished work was deleted unused at the close: a sub-agent's delivery lands in the game folder when its turn ends, and the close keeps every delivered file", async () => {
    const { lead, recorder } = await subAgentLead();
    await startAgent(lead, { kind: "blender_model", title: "Katana", brief: "A katana." });
    await Promise.all(lead.agentRuns.values());
    await settleAgents(lead);
    const landed = recorder
      .paramsOf("run.exec")
      .filter((p) => p.project && String(p.command).includes("checkout"))
      .map((p) => String(p.command));
    assert.equal(landed.length, 1, "landed once, when its turn ended");
    assert.match(landed[0] ?? "", /model\.glb/);
    const removed = recorder.paramsOf("run.exec").filter((p) => /\b(rm|clean|reset)\b/.test(String(p.command)));
    assert.deepEqual(removed, [], "nothing in the game folder is removed at the close");
    assert.deepEqual(lead.journal.agents[0]?.landed.sort(), [MANIFEST, MODEL].sort());
  });

  it("UL10. helpers were offered the user's editor, publishing and the paid CLI, and their cards reached no node: a sub-agent is offered only its kind's tools and attributed to its own part", async () => {
    const { lead, recorder } = await subAgentLead("holds");
    await startAgent(lead, { kind: "blender_model", title: "Katana", brief: "A katana." });
    for (let i = 0; i < 5; i++) await nextTurn();
    const [delegation] = recorder.paramsOf("engine.delegate");
    assert.deepEqual(delegation?.toolAllow, ["blender__"]);
    assert.deepEqual(delegation?.attribution, { runId: "run-ul", agentId: "agent-blender_model-1" });
    await settleAgents(lead);
  });

  it("UL11. a judge's verdict undid progress the lead could see: the critic's answer is advice on the round, and changes nothing", async () => {
    const { lead, recorder, dir } = await subAgentLead();
    await mkdir(path.join(dir, CAPTURES_FOLDER), { recursive: true });
    await writeFile(path.join(dir, CAPTURES_FOLDER, "vista.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    recorder.handle("game.references", () => ({ frames: [], skipped: [] }));
    recorder.handle("engine.complete", () => ({
      message: {
        content: JSON.stringify({ defects: [{ defect: "flat light", fix: "one key light" }], boldMove: "fog" }),
      },
    }));
    const answer = await askCritic(lead, { shots: "vista.png" });
    assert.match(answer, /It advises; you decide/);
    const changed = recorder.calls
      .map((c) => c.method)
      .filter((m) => /^(snapshot|game\.write|plugins\.invoke|engine\.delegate|run\.exec)/.test(m));
    assert.deepEqual(changed, [], "no snapshot, restore, write, tool or turn");
    const [advice] = recorder
      .paramsOf("events.append")
      .flatMap((p) => p.batch as Array<{ event_type: string; payload: Record<string, unknown> }>);
    assert.equal(advice?.payload.advice, true, "recorded as advice");
    assert.ok(!("decision" in (advice?.payload ?? {})), "never as a verdict");
  });

  it("UL13. a Meshy sub-agent ended its turn to wait for its jobs in the background and delivered nothing: a sub-agent whose turn ends with no manifest goes on in its own session until it delivers", async () => {
    const { lead, recorder } = await subAgentLead();
    const turns: Array<Record<string, unknown>> = [];
    recorder.handle("engine.delegate", (params) => {
      turns.push(params);
      return {
        ok: true,
        engine: "claude-code",
        summary: "waiting for the jobs",
        usage: {},
        turns: 1,
        sessionId: "s-cast",
      };
    });
    recorder.handle("run.exec", (params) => {
      const command = String(params.command);
      // The manifest is written only in the turn that went on.
      if (command.includes("manifest.json") && !command.startsWith("git"))
        return { code: 0, stdout: turns.length > 1 ? "yes\n" : "", stderr: "" };
      return deliveryExec(params);
    });
    await startAgent(lead, { kind: "blender_model", title: "Katana", brief: "A katana." });
    await Promise.all(lead.agentRuns.values());
    assert.equal(turns.length, 2, "one more turn, not a failure");
    assert.equal(turns[1]?.resume, "s-cast", "in the same session");
    assert.match(String(turns[1]?.prompt), /wait/i, "told to wait for its jobs inside the turn");
    assert.equal(lead.journal.agents[0]?.state, "done");
    await settleAgents(lead);
  });

  it("UL15. a sub-agent's part names its kind once, as the lead wrote the rest, never 'meshy: Goblin and Troll (Meshy)'", async () => {
    const { lead, recorder } = await subAgentLead();
    await startAgent(lead, { kind: "genex_cast", title: "Goblin and Troll (Meshy)", brief: "Two characters." });
    await Promise.all(lead.agentRuns.values());
    const titles = recorder
      .paramsOf("events.append")
      .flatMap((p) => p.batch as Array<{ event_type: string; payload: { title?: string } }>)
      .filter((e) => e.event_type === "director_worker")
      .map((e) => e.payload.title);
    assert.ok(titles.length > 0, "the part is on the graph");
    assert.deepEqual([...new Set(titles)], ["Meshy: Goblin and Troll"]);
    await settleAgents(lead);
  });
});

// ── the ownership reviewer against the mandatory merge ──

/** A real repository and the ways the loop runs git in it: argv, `run.exec` (`code`/`stdout`), and stdout-or-throw. */
async function mergeRepo(files: Record<string, string>) {
  const { tmpDir } = await import("../helpers/tmp.ts");
  const dir = await tmpDir("merge-ownership-");
  const git = async (...args: string[]) => (await gitFile(["-C", dir, ...args])).stdout.trim();
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@x");
  await git("config", "user.name", "t");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  await git("add", "-A");
  await git("commit", "-qm", "incumbent");
  const exec = async (command: string) => {
    try {
      const { stdout, stderr } = await promisify(execFile)("sh", ["-c", command], { cwd: dir, maxBuffer: 10_000_000 });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };
  const sh = async (command: string) => {
    const out = await exec(command);
    if (out.code !== 0) throw new Error(out.stderr || out.stdout);
    return out.stdout.trim();
  };
  const ctx = {
    workspace: "/nonexistent",
    cancelled: false,
    notify() {},
    call: async (method: string, p: { command: string }) => (method === "run.exec" ? exec(p.command) : null),
  };
  const read = (name: string) => readFile(path.join(dir, name), "utf8");
  return { dir, git, exec, sh, ctx, read };
}

type MergeRepo = Awaited<ReturnType<typeof mergeRepo>>;

/** Commit `files` on a new branch `name` from the current HEAD and come back: another part's integrated work. */
async function commitOnBranch(repo: MergeRepo, name: string, files: Record<string, string>): Promise<string> {
  const back = await repo.git("rev-parse", "HEAD");
  await repo.git("checkout", "-qb", name);
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(repo.dir, file), text);
  await repo.git("add", "-A");
  await repo.git("commit", "-qm", name);
  const head = await repo.git("rev-parse", "HEAD");
  await repo.git("checkout", "-q", back);
  return head;
}

describe("ownership after a merge", () => {

  it("MA-5. a conflict in a file only another part owns is settled by ownership: no builder is told to merge it by hand", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const plan = twoFacetPlan();
    (plan.facets[0] as { owns: string[] }).owns = ["src/water.js", "src/shared.js"];
    // Since Loop phase 4 a ladder, not a judge never satisfied, keeps both going past their first round.
    for (const facet of plan.facets as Array<{ id: string }>)
      Object.assign(facet, { milestones: ladderOf(facet.id, 3) });
    const builds: Record<string, number> = { water: 0, sky: 0 };
    const skyPrompts: string[] = [];
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        const git = async (...args: string[]) => (await gitFile(["-C", cwd, ...args])).stdout.trim();
        await mkdir(path.join(cwd, "src"), { recursive: true });
        const shared = path.join(cwd, "src", "shared.js");
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          builds.water++;
          await writeFile(shared, `export const shared = "water-${builds.water}";\n`);
          await writeFile(path.join(cwd, "src", "water.js"), `export const water = ${builds.water};\n`);
          return { sessionId: "ses_water" };
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          builds.sky++;
          const brief = await readFile(path.join(cwd, ".studio", "BRIEF.md"), "utf8").catch(() => "");
          skyPrompts.push(`${request.prompt}\n${brief}`);
          if (builds.sky === 1) {
            // Sky writes water's file only once water's version is integrated: both sides add it.
            const until = Date.now() + 90_000;
            while (Date.now() < until) {
              const found = await git("log", "--all", "--grep=integrate water iteration 1", "--format=%H").catch(
                () => "",
              );
              if (found) break;
              await setTimeoutPromise(200);
            }
          }
          // A builder without the edit-time hook (review off below): it overwrote a file it does not own.
          const current = await readFile(shared, "utf8").catch(() => "");
          if (!current.includes("water")) await writeFile(shared, `export const shared = "sky";\n`);
          await writeFile(path.join(cwd, "src", "sky.js"), `export const sky = ${builds.sky};\n`);
          return { sessionId: "ses_sky" };
        }
        if (request.playtest)
          return { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) };
        return null;
      },
    });
    // Review off: the reviewer would otherwise act on sky's stray edit before it could conflict.
    const { events } = await runAutopilot(rig, "ownershipworld", { budgets: { review: false } });
    const skyMerges = customEvents(events, "integration_merge").filter((m) => m.facetId === "sky" && !m.stage);
    assert.ok(
      !skyPrompts.some((prompt) => /could not merge it automatically/.test(prompt)),
      `sky was never told to merge water's file by hand: ${JSON.stringify(skyMerges)}`,
    );
    assert.ok(
      skyMerges.every((m) => m.conflict === false),
      `no merge into sky's worktree was left to its builder: ${JSON.stringify(skyMerges)}`,
    );
    assert.ok(
      skyMerges.some(
        (m) => m.conflict === false && ((m.theirs as string[] | undefined) ?? []).includes("src/shared.js"),
      ),
      `sky's worktree merge took water's side of src/shared.js: ${JSON.stringify(skyMerges)}`,
    );
    const gameDir = path.join(rig.core.layout.gamesRoot, "ownershipworld");
    assert.match(await readFile(path.join(gameDir, "src", "shared.js"), "utf8"), /water-\d+/);
  });

  it("MA-6. a builder's merge left uncommitted is concluded before review: nothing that arrived by it is reverted", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const plan = twoFacetPlan();
    (plan.facets[0] as { owns: string[] }).owns = ["src/water.js", "src/materials.js"];
    const builds: Record<string, number> = { water: 0, sky: 0 };
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const cwd = request.cwd;
        const git = async (...args: string[]) => (await gitFile(["-C", cwd, ...args])).stdout.trim();
        await mkdir(path.join(cwd, "src"), { recursive: true });
        if (/YOUR FACET: Water|facet "Water"/.test(request.prompt)) {
          builds.water++;
          // Water changes a file the game already had: one that exists at sky's incumbent.
          const materials = path.join(cwd, "src", "materials.js");
          const before = (await readFile(materials, "utf8")).replace(/^export const waterTint = .*\n/m, "");
          await writeFile(materials, `${before}export const waterTint = ${builds.water};\n`);
          await writeFile(path.join(cwd, "src", "water.js"), `export const water = ${builds.water};\n`);
          return { sessionId: "ses_water" };
        }
        if (/YOUR FACET: Sky|facet "Sky"/.test(request.prompt)) {
          builds.sky++;
          if (builds.sky === 1) {
            let head = "";
            const until = Date.now() + 90_000;
            while (Date.now() < until && !head) {
              head = await git("log", "--all", "--grep=integrate water iteration 1", "--format=%H").catch(() => "");
              if (!head) await setTimeoutPromise(200);
            }
            assert.ok(head, "water's first round was integrated");
            // The builder merges the integration head by hand and never commits the merge.
            await git("-c", "user.name=fake", "-c", "user.email=fake@x", "merge", "--no-commit", "--no-ff", head);
          }
          await writeFile(path.join(cwd, "src", "sky.js"), `export const sky = ${builds.sky};\n`);
          return { sessionId: "ses_sky" };
        }
        if (request.playtest)
          return { summary: JSON.stringify({ answers: { "integration-play": { answer: "yes" } }, report: "played" }) };
        return null;
      },
    });
    const { events } = await runAutopilot(rig, "handmergeworld");
    const first = customEvents(events, "facet_iteration").find((i) => i.facetId === "sky" && i.iteration === 1);
    assert.ok(first && first.verdictSource !== "broken", `the concluded merge was judged: ${JSON.stringify(first)}`);
    const enforced = customEvents(events, "facet_review_enforced").filter((e) => e.facetId === "sky");
    assert.ok(
      enforced.every((e) => !((e.reverted as string[] | undefined) ?? []).includes("src/materials.js")),
      `water's materials were never reverted on sky: ${JSON.stringify(enforced)}`,
    );
    const gameDir = path.join(rig.core.layout.gamesRoot, "handmergeworld");
    const concluded = await gitFile([
      "-C",
      gameDir,
      "log",
      "--all",
      "--format=%s",
      "--grep=conclude the builder's merge",
    ]);
    assert.match(concluded.stdout, /facet sky: conclude the builder's merge/, "the harness committed sky's open merge");
    const skyReviews = customEvents(events, "facet_review").filter((r) => r.facetId === "sky" && r.iteration === 1);
    assert.ok(
      skyReviews.every((r) => !JSON.stringify(r).includes("src/materials.js")),
      `sky's review judged only its own diff: ${JSON.stringify(skyReviews)}`,
    );
    assert.match(await readFile(path.join(gameDir, "src", "materials.js"), "utf8"), /waterTint = \d+/);
    assert.match(await readFile(path.join(gameDir, "src", "sky.js"), "utf8"), /sky = \d+/);
  });
});

/**
 * Facet rounds: a new worker's first round is one long build block before any blind judging, a
 * round that fixed owed defects is kept though it missed its move, an undone round's fixes are
 * carried over, and a lead's fix the builder merged is never read as the builder's own edit.
 */
describe("facet rounds: the build block, kept fixes and the lead's merged fixes", () => {
  const MIN = 60_000;
  const racingRun = { runId: "run_nfs", project: "nfs", goal: "an NFS-style night street race", model: "opus" };

  /**
   * The run's git history, small: car-feel's round 2 merged the lead's HDR fix in city-world's
   * post.js by hand (0259c9d) while integration moved on to 99a2f8c, and kept building.
   */
  async function leadFixRepo() {
    const repo = await mergeRepo({
      "src/main.js": "// main\n",
      "src/world/post.js": "export const post = 0;\n",
      "src/car/car.js": "export const car = 0;\n",
      "src/ui/screen.js": "export const screen = 0;\n",
    });
    const write = (file: string, text: string) => writeFile(path.join(repo.dir, file), text);
    const start = await repo.git("rev-parse", "HEAD");
    // car-feel's round 1, accepted (d47cdd1).
    await repo.git("checkout", "-qb", "car-feel");
    await write("src/car/car.js", "export const car = 1;\n");
    await repo.git("commit", "-qam", "facet car-feel iteration 1: accepted");
    const round1 = await repo.git("rev-parse", "HEAD");
    // Integration takes the screen (e2c8324); the loop merges it at the top of round 2 (fd973ef).
    await repo.git("checkout", "-qb", "integration", start);
    await write("src/ui/screen.js", "export const screen = 1;\n");
    await repo.git("commit", "-qam", "director: integrate screen");
    const screenIn = await repo.git("rev-parse", "HEAD");
    await repo.git("checkout", "-q", "car-feel");
    await repo.git("merge", "-q", "--no-ff", "--no-edit", screenIn);
    const incumbent = await repo.git("rev-parse", "HEAD");
    // The lead integrates round 1 (d2edc11) and fixes HDR in city-world's post.js itself (0259c9d).
    await repo.git("checkout", "-q", "integration");
    await repo.git("merge", "-q", "--no-ff", "--no-edit", round1);
    const carIn = await repo.git("rev-parse", "HEAD");
    await write("src/world/post.js", "export const post = 0;\nexport const safeHDR = true;\n");
    await repo.git("commit", "-qam", "integration fix: sanitize HDR before bloom");
    const leadFix = await repo.git("rev-parse", "HEAD");
    // Integration moves on while car-feel builds (5558808, 99a2f8c).
    await write("src/world/atmosphere.js", "export const fog = 1;\n");
    await repo.git("add", "-A");
    await repo.git("commit", "-qm", "integrate city-world by hand");
    await write("src/ui/screen.js", "export const screen = 2;\n");
    await repo.git("commit", "-qam", "director: integrate screen");
    const head = await repo.git("rev-parse", "HEAD");
    // The lead steers car-feel to merge its fix: the builder merges it by hand, commits, and builds.
    await repo.git("checkout", "-q", "car-feel");
    await repo.git("merge", "-q", "--no-ff", "--no-edit", leadFix);
    await write("src/car/car.js", "export const car = 2;\n");
    return { repo, write, incumbent, screenIn, carIn, leadFix, head };
  }

  type LeadFixRepo = Awaited<ReturnType<typeof leadFixRepo>>;

  /** car-feel's round-2 review, with the integration hook the loop had. */
  async function reviewRound(fixture: LeadFixRepo, integration: Record<string, unknown>) {
    const round: Record<string, any> = { iteration: 2, iterationId: "002", buildFailed: null };
    return round.review as { base: string; files?: string[]; violations: Array<{ file: string }> };
  }

  it("FR-1. a lead's fix the builder was told to merge is not its own edit: car-feel's review flagged city-world's post.js and the fix turn reverted the lead's HDR guard", async () => {
    const fixture = await leadFixRepo();
    // What the loop's integration hook answered while car-feel built: the head integration had moved on to.
    const review = await reviewRound(fixture, { head: async () => fixture.head });
    assert.deepEqual(
      review.violations.map((v) => v.file),
      [],
      `the lead's fix arrived by the merge car-feel was told to make: ${JSON.stringify(review.violations)}`,
    );
    assert.equal(review.base, fixture.leadFix, "the newest integration commit the worktree holds is the diff base");
    assert.deepEqual(review.files, ["src/car/car.js"], "only car-feel's own work is reviewed");
  });

  it("FR-3. the builder's own edit to another part's file is still its edit after the merge", async () => {
    const fixture = await leadFixRepo();
    await fixture.write("src/ui/screen.js", "export const screen = 9;\n");
    const review = await reviewRound(fixture, { head: async () => fixture.head });
    assert.deepEqual(
      review.violations.map((v) => v.file),
      ["src/ui/screen.js"],
      "an edit nobody merged in is reviewed as the builder's",
    );
  });

  /** A worker's loop at the top of a round, as the integration gate reads it, over a fresh repository. */
  async function gateRound(id: string, owns: string[]) {
    const repo = await mergeRepo({
      "src/main.js": "// main\n",
      "src/world/post.js": "export const post = 0;\n",
      "src/car/car.js": "export const car = 0;\n",
    });
    const start = await repo.git("rev-parse", "HEAD");
    const head = await commitOnBranch(repo, "integration", {
      "src/world/post.js": "export const post = 0;\nexport const safeHDR = true;\n",
    });
    const loop: Record<string, any> = {
      ctx: repo.ctx,
      git: repo.sh,
      gitWhere: repo.dir,
      gitOptions: { label: `facet:${id}:git`, timeoutMs: 30_000, trim: "both" },
      worktree: repo.dir,
      integration: { head: async () => head },
      mergedIntegration: null,
      incumbentCommit: start,
      integrationNote: null,
      appendRun: async () => {},
      facet: { id, title: id },
      run: racingRun,
      spec: { id, title: id, owns, checks: [] },
      ownShape: false,
      ownsMain: false,
      shape: null,
    };
    const round: Record<string, any> = { iteration: 3 };
    return { loop, round, head };
  }

  it("FR-4. a lead commit that touches a part's own file reaches its owner as the lead's change to keep", async () => {
    const owner = await gateRound("city-world", ["src/world/"]);
    assert.equal(owner.loop.mergedIntegration, owner.head, "the merge itself went through");
    assert.match(String(owner.loop.integrationNote), /src\/world\/post\.js/);
    assert.match(String(owner.loop.integrationNote), /keep/i);
    const other = await gateRound("car-feel", ["src/car/"]);
    assert.equal(other.loop.integrationNote, null, "a part whose files the lead left alone hears nothing");
  });

  // ── the build block: a long first round, kept on the checks ──

  /** A delegated build turn's loop on a fake clock: every turn the engine takes costs `turnMinutes`. */
  function blockLoop(turnMinutes: number, extra: Record<string, unknown> = {}) {
    const turns: Array<{ prompt: string; timeoutMs: number; resume?: string }> = [];
    let clock = 0;
    const ctx = {
      workspace: "/nonexistent",
      cancelled: false,
      notify() {},
      setStatus() {},
      call: async (method: string, params: Record<string, any>) => {
        if (method !== "engine.delegate") return null;
        turns.push({ prompt: String(params.prompt), timeoutMs: Number(params.timeoutMs), resume: params.resume });
        clock += turnMinutes * MIN;
        return { ok: true, sessionId: "ses_block", summary: "done" };
      },
    };
    const loop: Record<string, any> = {
      ctx,
      now: () => clock,
      deadline: Date.now() + 8 * 60 * MIN,
      budgetMs: 8 * 60 * MIN,
      delegated: true,
      buildBlock: true,
      legacy: false,
      startIteration: 1,
      extraReadRoots: [],
      spikeRoots: [],
      facet: { id: "car-feel", title: "Car" },
      spec: { id: "car-feel", title: "Car", owns: ["src/car/"], cameras: ["default"], checks: [], milestones: [] },
      run: racingRun,
      engineId: "fake-delegate",
      facetThreadId: "thread_car",
      worktree: "/nonexistent/car-feel",
      result: {},
      windDownMs: 3 * MIN,
      emaAfterMs: null,
      sessionId: null,
      ownShape: false,
      ownsMain: false,
      shape: null,
      facetSetup: null,
      handle: null,
      outageRetries: 0,
      iterationsThisRound: 1,
      board: {},
      moves: [],
      milestonesDone: new Set<string>(),
      milestonesSetAside: new Set<string>(),
      stoppedHere: async () => false,
      finishRequested: async () => false,
      steering: async () => [],
      appendRun: async () => {},
      ...extra,
    };
    return { loop, turns, elapsed: () => clock };
  }

  /** Round one of a new loop worker: its move chosen (which stamps the block), then its build turn. */
  async function firstRound(loop: Record<string, any>, iteration = 1) {
    const round: Record<string, any> = {
      iteration,
      prompt: "build the car",
      promptImages: [],
      acceptedShots: [],
      userSteering: [],
    };
    return round;
  }

  it("FR-8. a new loop worker's first round is a build block: the builder is kept on a screenshot-and-fix loop until the block's shortest end", async () => {
    const { loop, turns, elapsed } = blockLoop(20);
    const round = await firstRound(loop);
    assert.ok(
      elapsed() >= 60 * MIN,
      `the block ran at least an hour (${elapsed() / MIN} min in ${turns.length} turns)`,
    );
    assert.ok(turns.length >= 3, "the builder's early stops were answered with more building");
    assert.ok(turns[0]!.timeoutMs <= 90 * MIN, "no turn runs past the block's longest");
    assert.match(turns[1]!.prompt, /BUILD BLOCK/);
    assert.match(turns[1]!.prompt, /bench\/car-feel\.html/);
    assert.equal(turns[1]!.resume, "ses_block", "the same session carries on");
    assert.equal(round.buildFailed, null);
  });
});

describe("a racing build judged during its countdown", () => {
  it("MAP-1. a racing build judged during its countdown: the drive waits for flow.playing", async () => {
    const rig = await startRig();
    rigs.push(rig);
    await apiOf(rig)["game.scaffold"]!({ name: "apex", title: "Apex" });
    const plan = {
      ...twoFacetPlan({
        waterChecks: [
          { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
          { id: "lap", kind: "probe", expr: "race.lap >= 1", weight: "normal" },
        ],
      }),
      game: { kind: "racing" },
    };
    // The game's own front-end, the way the exported game had it: seed() puts it back on its
    // title, begin() starts a two-step countdown, and only then is the race on. Every input the
    // harness drives is filed under the phase it landed in.
    const preview = rig.preview;
    let phase = "menu";
    let countdown = 0;
    const landed: string[] = [];
    preview.next = { ...preview.next, race: { lap: 1 } };
    preview.studioMethods.begin = () => {
      phase = "countdown";
      countdown = 2;
      return { ok: true };
    };
    const call = preview.studioCall.bind(preview);
    preview.studioCall = async (method, arg) => {
      if (method === "seed") phase = "menu";
      const counting = method === "step" && phase === "countdown";
      if (counting) countdown -= 1;
      if (counting && countdown <= 0) phase = "playing";
      return call(method, arg);
    };
    const state = preview.studioState.bind(preview);
    preview.studioState = async (options) => ({
      ...((await state(options)) as Record<string, unknown>),
      flow: { phase, playing: phase === "playing" },
    });
    const input = preview.input.bind(preview);
    preview.input = async (actions) => {
      for (const action of (actions ?? []) as Array<{ type: string }>) if (action.type === "down") landed.push(phase);
      return input(actions);
    };
    registerFakeEngine(rig, {
      complete: (text) => (text.includes("ENGINE HINT: maxParallel") ? JSON.stringify(plan) : null),
      delegate: async (request) => {
        const facet = /YOUR FACET: Water|facet "Water"/.test(request.prompt) ? "water" : "sky";
        if (request.playtest) return { summary: JSON.stringify({ answers: {}, report: "played" }) };
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", `${facet}.js`), `export const ${facet} = ${Date.now()};\n`);
        return { sessionId: `ses_${facet}` };
      },
    });
    await runAutopilot(rig, "apex", { budgets: { maxIterations: 2 } });
    assert.ok(
      preview.calls.some((c) => c.method === "begin"),
      "every look takes the racer past its title before it drives",
    );
    assert.ok(landed.length > 0, "the harness drove the game's controls");
    assert.deepEqual(
      [...new Set(landed)],
      ["playing"],
      `the throttle never lands in the title or the countdown: ${landed.join(",")}`,
    );
    // The board's own probe path is asked to survive the studio's bound on every read.
    assert.ok(
      preview.stateOpts.some((options) => options?.keep?.includes("race.lap")),
      "the state the board reads is kept whole",
    );
  });
});

/**
 * A Loop chat may launch with a goal that paraphrases the user's ask and adds to it (police,
 * traffic and a pursuit meter in a street race); if that paraphrase is the only ask any agent
 * reads, the additions stick. The run carries the user's own words from the chat's log, and the
 * contractor's in-scope and cut lists beside them, through a Resume.
 */
describe("MAP-5. scope inflated without the user", () => {
  const ASK = "Create a hyper-realistic NFS-inspired racing game";

  it("MAP-5a. the contractor added police to an NFS-inspired ask: the run keeps the user's words verbatim and the cut list, and a Resume restores them", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    let calls = 0;
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        calls++;
        // Only the chat's launch matters here; the run's lead thinks until it is stopped.
        if (calls > 1)
          return new Promise((resolve) =>
            request.signal?.addEventListener("abort", () =>
              resolve({ ok: false, stopReason: "stopped", summary: "" } as never),
            ),
          );
        return {
          ok: true,
          engine: "vendor",
          summary: "Recap: a neon night race. Starting it now.",
          turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            {
              name: "start_autopilot",
              args: {
                goal: "A neon night street race with police pursuit, traffic and a pursuit meter",
                direction: "NFS",
                in_scope: ["one race", "one hero car"],
                cut: ["police pursuit", "open world"],
              },
            },
          ],
        };
      },
    });
    await rig.core.games.scaffold("apex", { title: "apex" });
    const thread = await rig.core.threadForGame("apex");
    type Log = Awaited<ReturnType<typeof rig.core.listAllEvents>>;
    const leading = (n: number) => (log: Log) => customEvents(log, "run_registered").length >= n && calls > n;
    const paused = (n: number) => (log: Log) =>
      customEvents(log, "autopilot_paused").length + customEvents(log, "run_finished").length >= n;

    await rig.core.sendUserMessage(ASK, { thread, engine: "vendor", autopilot: { hours: 1 } });
    const first = await waitForLog(rig.core, leading(1), 60_000, "the run's lead at work");
    const [launched] = customEvents(first, "run_registered") as Array<Record<string, any>>;
    assert.ok(launched);
    assert.deepEqual(launched.scope?.asked, [ASK], "the user's words, from the log, not the contractor's goal");
    assert.deepEqual(launched.scope?.inScope, ["one race", "one hero car"]);
    assert.deepEqual(launched.scope?.cut, ["police pursuit", "open world"]);
    assert.match(String(launched.goal), /police/, "the contractor's goal is kept as its brief, beside the ask");

    const runId = String(launched.runId);
    const journal = (await rig.core.store.readArtifact(thread, `autopilot_${runId}`)) as Record<string, any> | null;
    assert.deepEqual(journal?.run?.scope, launched.scope, "the journal keeps the scope a Resume reads");

    await rig.core.stopThread(thread).catch(() => {});
    await waitForLog(rig.core, paused(1), 60_000, "the run to pause");
    // The Resume is the user's click, sent as soon as the pause shows, while the paused run may still be
    // closing: it waits for that close, never refused. Not awaited: the resumed run goes on until it is
    // stopped, and its dispatch's own wait is not this test's.
    void rig.core.resumeAutopilot(runId).catch(() => {});
    const refused = (log: Log) => customEvents(log, "run_start_blocked").length > 0;
    const second = await waitForLog(
      rig.core,
      (log) => leading(2)(log) || refused(log),
      60_000,
      "the resumed run's lead at work",
    );
    // Flipped (was swallowed): a Resume while the paused run closes is never refused as a second run.
    assert.deepEqual(customEvents(second, "run_start_blocked"), [], "the Resume is not refused");
    const resumed = (customEvents(second, "run_registered") as Array<Record<string, any>>)[1];
    assert.equal(resumed?.resumed, true);
    assert.deepEqual(resumed?.scope, launched.scope, "a Resume restores the same scope");
    await rig.core.stopThread(thread).catch(() => {});
    await waitForLog(rig.core, paused(2), 60_000, "the resumed run to pause").catch(() => {});
  });

  it("MAP-5b. lists sent as text (Claude Code declares intake fields as strings) still launch, and the chat's own command report is not in the user's words", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    let calls = 0;
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        calls++;
        if (calls > 1)
          return new Promise((resolve) =>
            request.signal?.addEventListener("abort", () =>
              resolve({ ok: false, stopReason: "stopped", summary: "" } as never),
            ),
          );
        return {
          ok: true,
          engine: "vendor",
          summary: "Recap: one race. Starting it now.",
          turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [
            {
              name: "start_autopilot",
              args: {
                goal: "A neon night street race",
                direction: "NFS",
                in_scope: '["one race", "one hero car"]',
                cut: "police pursuit\nopen world",
              },
            },
          ],
        };
      },
    });
    await rig.core.games.scaffold("apex", { title: "apex" });
    const thread = await rig.core.threadForGame("apex");
    // A command the user ran from a reply: the chat queued its result as a message, settled.
    const report = "Command finished: npm test passed";
    await rig.core.store.appendEvents(thread, [
      { type: "messages", messages: [{ role: "user", content: report }] },
      {
        type: "custom",
        event_type: "coordinator_message_queued",
        payload: { messageId: "m_report", action: { text: report, threadId: thread, origin: "command-result" } },
      },
      { type: "custom", event_type: "coordinator_message_handled", payload: { messageId: "m_report" } },
    ] as never);

    await rig.core.sendUserMessage(ASK, { thread, engine: "vendor", autopilot: { hours: 1 } });
    const log = await waitForLog(
      rig.core,
      // Launched, or refused: a refused call answers the model that it "did not run".
      (events) => customEvents(events, "run_registered").length >= 1 || JSON.stringify(events).includes("did not run"),
      60_000,
      "the launch or its refusal",
    );
    try {
      const [launched] = customEvents(log, "run_registered") as Array<Record<string, any>>;
      assert.ok(launched, "the launch was not refused for lists sent as text");
      assert.deepEqual(launched.scope?.asked, [ASK], "the user's words only, without the chat's report");
      assert.deepEqual(launched.scope?.inScope, ["one race", "one hero car"]);
      assert.deepEqual(launched.scope?.cut, ["police pursuit", "open world"]);
    } finally {
      await rig.core.stopThread(thread).catch(() => {});
      await waitForLog(
        rig.core,
        (events) => customEvents(events, "autopilot_paused").length + customEvents(events, "run_finished").length >= 1,
        60_000,
        "the run to pause",
      ).catch(() => {});
    }
  });
});

/**
 * A Resume pressed as soon as the pause shows reaches the harness while the paused run still writes
 * its close (its report, its tear-down): it waits for that close and then starts, and is never
 * refused as a second run of the same chat. The paused run's report is held until the harness has
 * read the Resume's journal and answered one more message, so the Resume has met the closing run.
 */
describe("a Resume pressed as the pause shows", () => {
  it("the web director's Resume waits for the paused run's close, then starts: never refused as a second run", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    let calls = 0;
    rig.core.engines.register({
      id: "vendor",
      label: "Vendor",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "signed in" }),
      models: async () => [],
      defaultModel: async () => "vendor-model",
      delegate: async (request: DelegateRequest) => {
        calls++;
        // Only the chat's launch matters here; each run's lead thinks until it is stopped.
        if (calls > 1)
          return new Promise((resolve) =>
            request.signal?.addEventListener("abort", () =>
              resolve({ ok: false, stopReason: "stopped", summary: "" } as never),
            ),
          );
        return {
          ok: true,
          engine: "vendor",
          summary: "Starting the garden now.",
          turns: 1,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_usd: 0 },
          studioToolCalls: [{ name: "start_autopilot", args: { goal: "A small walled garden to explore" } }],
        };
      },
    });
    await rig.core.games.scaffold("garden", { title: "garden" });
    const thread = await rig.core.threadForGame("garden");
    type Log = Awaited<ReturnType<typeof rig.core.listAllEvents>>;
    const leading = (n: number) => (log: Log) => customEvents(log, "run_registered").length >= n && calls > n;
    const paused = (n: number) => (log: Log) =>
      customEvents(log, "autopilot_paused").length + customEvents(log, "run_finished").length >= n;

    await rig.core.sendUserMessage("Make a small walled garden to explore", {
      thread,
      engine: "vendor",
      autopilot: { hours: 1 },
    });
    const first = await waitForLog(rig.core, leading(1), 60_000, "the run's lead at work");
    const runId = String((customEvents(first, "run_registered")[0] as Record<string, unknown>).runId);

    // The host calls the harness makes, as the host serves them: the paused run's report is held.
    type Serve = (params: Record<string, unknown>) => Promise<unknown>;
    const api = rig.core.host.options.api as unknown as Record<string, Serve>;
    const serve = {
      report: api[HostMethod.RunArtifact]!,
      read: api[HostMethod.ArtifactRead]!,
      list: api[HostMethod.GameList]!,
    };
    let reportHeld = () => {};
    const held = new Promise<void>((resolve) => {
      reportHeld = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resumeRead = () => {};
    const read = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    let resumeSent = false;
    let listsWhileHeld = 0;
    api[HostMethod.RunArtifact] = async (params) => {
      if (params.runId === runId && params.name === "report.json") {
        reportHeld();
        await released;
      }
      return serve.report(params);
    };
    api[HostMethod.ArtifactRead] = async (params) => {
      const value = await serve.read(params);
      // Answered first; the next turn is after the answer went to the harness.
      if (resumeSent && params.artifactId === `autopilot_${runId}`) setImmediate(resumeRead);
      return value;
    };
    api[HostMethod.GameList] = async (params) => {
      if (resumeSent) listsWhileHeld += 1;
      return serve.list(params);
    };

    await rig.core.stopThread(thread).catch(() => {});
    await held;
    assert.equal(customEvents(await rig.core.listAllEvents(), "autopilot_paused").length, 1, "the pause shows");
    resumeSent = true;
    void rig.core.resumeAutopilot(runId).catch(() => {});
    await read;
    // The harness answers in order: once it answers this, it has run the Resume's start past the
    // journal it read, up to where that start waits (or would be refused, or would begin).
    assert.equal(await rig.core.host.healthcheck(), true);
    const startsWhileHeld = listsWhileHeld;
    release();

    const second = await waitForLog(
      rig.core,
      (log) => leading(2)(log) || customEvents(log, "run_start_blocked").length > 0,
      60_000,
      "the resumed run's lead at work",
    );
    assert.deepEqual(customEvents(second, "run_start_blocked"), [], "the Resume is not refused");
    assert.equal(startsWhileHeld, 0, "while the paused run closed, the Resume only waited: it read no game list");
    const resumed = (customEvents(second, "run_registered") as Array<Record<string, unknown>>)[1];
    assert.equal(resumed?.resumed, true, "the Resume started once the paused run had closed");
    await rig.core.stopThread(thread).catch(() => {});
    await waitForLog(rig.core, paused(2), 60_000, "the resumed run to pause").catch(() => {});
  });
});

/**
 * Issue #47: a game run with a model per job. Local runs played their playtest on the workers'
 * model even when the reviewers had picked a model that sees, and a run whose reviewers sat on
 * another engine handed that engine's model id to whichever engine actually played.
 */
describe("the playtester of a run with a model per job (issue #47)", () => {
  const described = [
    {
      id: "ollama",
      label: "Ollama",
      kind: "direct",
      status: { code: "ready", detail: "" },
      defaultModel: "coder",
      models: [
        { id: "coder", label: "coder", contextWindow: 32_000, supportsTools: true, supportsVision: false },
        { id: "vl", label: "vl", contextWindow: 32_000, supportsTools: true, supportsVision: true },
        { id: "seer", label: "seer", contextWindow: 32_000, supportsTools: false, supportsVision: true },
      ],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "delegated",
      supportsSessions: true,
      status: { code: "ready", detail: "" },
      defaultModel: null,
      models: [{ id: "opus", label: "Opus", contextWindow: 200_000, supportsTools: true, supportsVision: true }],
    },
  ];
  const answer = JSON.stringify({ answers: { wade: { answer: "yes" } }, report: "waded" });
  /** Where a playtest of `run` plays: the engine and the model each completion or session asks for. */
  async function played(
    run: Record<string, unknown>,
  ): Promise<Array<{ via: string; engine: unknown; model: unknown }>> {
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const recorder = ctxRecorder({
      handlers: {
        "engine.describe": () => described,
        "engine.complete": () => ({ message: { role: "assistant", content: answer } }),
        "engine.delegate": () => ({ summary: answer, turns: 2 }),
        "preview.load": () => ({ ok: true }),
        "preview.call": () => null,
      },
    });
    return recorder.calls
      .filter((call) => call.method === "engine.complete" || call.method === "engine.delegate")
      .map((call) => ({ via: call.method, engine: call.params.engine, model: call.params.model }));
  }

  it("LR1. plays on the reviewers' model when it calls tools and sees, and never sends one engine's model to another", async () => {
    const local = { engine: "ollama", model: "coder", judgeEngine: "ollama", judgeModel: "vl" };
    assert.deepEqual(
      await played(local),
      [{ via: "engine.complete", engine: "ollama", model: "vl" }],
      "an all-local run plays on the reviewers' model",
    );
    assert.deepEqual(
      await played({ ...local, judgeModel: "seer" }),
      [{ via: "engine.complete", engine: "ollama", model: "coder" }],
      "a reviewer that cannot call tools leaves play to the workers' model, as before",
    );
    const subscription = { engine: "claude-code", model: "opus", judgeEngine: "ollama", judgeModel: "vl" };
    assert.deepEqual(
      await played(subscription),
      [{ via: "engine.complete", engine: "ollama", model: "vl" }],
      "local reviewers under a subscription play on their own engine",
    );
    assert.deepEqual(
      await played({ ...subscription, judgeModel: "seer" }),
      [{ via: "engine.delegate", engine: "claude-code", model: "opus" }],
      "the run's own engine plays with its own model, never the local reviewer's id",
    );
    assert.deepEqual(
      await played({
        engine: "ollama",
        model: "opus",
        builderEngine: "claude-code",
        judgeEngine: "ollama",
        judgeModel: "seer",
        roles: { planner: "coder", builder: "opus", judge: "seer" },
      }),
      [{ via: "engine.complete", engine: "ollama", model: "coder" }],
      "a local main agent with subscription workers plays on its own model, never the workers' id",
    );
  });
});

/**
 * Issue #47: a coding model that cannot see images, picked as the workers' or the main agent's
 * model on a local engine. A screenshot a tool took, or a frame the person attached, went to it as
 * pixels, Ollama refused the request as unavailable, and the turn died or fell back to another
 * engine. A model that cannot see is told the pictures exist instead.
 */
describe("a local model that cannot see images (issue #47)", () => {
  const describedWith = (supportsVision: boolean) => [
    {
      id: "ollama",
      label: "Ollama",
      kind: "direct",
      status: { code: "ready", detail: "" },
      defaultModel: "coder",
      models: [{ id: "coder", label: "coder", contextWindow: 32_000, supportsTools: true, supportsVision }],
    },
  ];
  /** The messages a direct turn's one completion carries, for a model that sees or not. */
  async function sent(supportsVision: boolean): Promise<Array<{ role: string; content: string; images: number }>> {
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "engine.describe": () => describedWith(supportsVision),
        "engine.complete": () => ({ message: { role: "assistant", content: "done" } }),
        "plugins.tools": () => ({ tools: [] }),
        "mcp.tools": () => ({ tools: [] }),
      },
    });
    await runTurn(
      recorder.ctx as never,
      {
        turnId: "t1",
        threadId: "th",
        engine: "ollama",
        model: "coder",
        input: [],
        stills: [{ label: "plaza", mimeType: "image/jpeg", data: "AAAA" }],
      } as never,
    );
    const [complete] = recorder.paramsOf("engine.complete") as Array<{
      messages: Array<{ role: string; content: unknown; images?: unknown[] }>;
    }>;
    return (complete?.messages ?? []).map((m) => ({
      role: m.role,
      content: String(m.content),
      images: m.images?.length ?? 0,
    }));
  }

  it("LR2. a turn on a model that cannot see sends no pixels and says the pictures exist; one that sees gets them", async () => {
    const blind = await sent(false);
    assert.ok(blind.length > 0, "the turn asked its model");
    assert.equal(
      blind.reduce((n, m) => n + m.images, 0),
      0,
      "no pixels reach a model that cannot see them",
    );
    assert.match(blind.at(-1)?.content ?? "", /plaza/, "the model hears which pictures it was not shown");
    const seeing = await sent(true);
    assert.equal(seeing.at(-1)?.images, 1, "a model that sees gets the picture, as before");
  });
});

/**
 * Computer use, the judge that plays. A playtester's or a picture judge's "yes" was the model's
 * word: nothing checked it reached what it said it saw, a screenshot question nobody could answer
 * stayed unanswered, and a regression a picture cannot show (the key that no longer opens the menu)
 * reached the user. A judge now plays blind on the computer tool, the studio checks its goal in the
 * game's own state, and a route it played to a verified goal is replayed on every later build.
 */
describe("computer use: the judge that plays, escalation and routes", () => {
  const question = { id: "gate", kind: "play", ask: "Could you open the gate?", expect: "yes", weight: "normal" };

  it("CU6. a kept older playtester.ts without playResults still loads the judge that plays, which reads answers itself", async () => {
    const root = await tmpDir("cu-kept-");
    const seed = fileURLToPath(new URL("../../src/harness-seed", import.meta.url));
    await cp(seed, root, { recursive: true });
    await writeFile(
      path.join(root, "loop", "playtester.ts"),
      "export async function runPlaytest() { return null; }\nexport function playBrief() { return ''; }\nexport const SERVES_LOCAL_ROLES = true;\n// the agent's own playtester\n",
    );
    const kept = await import(pathToFileURL(path.join(root, "loop", "hands-on-judge.ts")).href);
    const results = kept.handsOnResults([question], { answers: { gate: { answer: "no", note: "locked" } } });
    assert.deepEqual(
      results.map((r: { id: string; pass: boolean | null }) => [r.id, r.pass]),
      [["gate", false]],
    );
    const evidence = await import(pathToFileURL(path.join(root, "loop", "evidence.ts")).href);
    assert.equal(typeof evidence.gatherEvidence, "function", "the evidence pass still loads beside it");
  });
});
describe("a Loop chat whose turn made the game's project (an Unreal game)", () => {
  it("LL1. the session that goes on is told to launch the build with its launch tool, never to build the game itself", () => {
    const unreal = [{ id: "unreal-project", path: "unreal" }];
    const loopOn = factsReadyPrompt(unreal, "mcp__studio__start_autopilot");
    assert.match(loopOn, /mcp__studio__start_autopilot/);
    assert.match(loopOn, /do not build it yourself/);
    assert.doesNotMatch(loopOn, /Go on with what you said you would build first/);
    assert.match(
      factsReadyPrompt(unreal),
      /Go on with what you said you would build first/,
      "without Loop it builds on",
    );
  });
});

describe("a chat whose saved session is gone (another account, or never saved)", () => {
  it("LS1. the engine's answer that it has no such session starts a fresh one, never 'the build stopped early'", async () => {
    const calls: Array<string | null> = [];
    const result = await steeredCall({ cancelled: false }, undefined, {
      prompt: "PROMPT",
      resume: "aa932c8a-f6c0-463c-8fa0-87a9ae52895c",
      fresh: () => "FRESH",
      call: async (_prompt, resume) => {
        calls.push(resume);
        if (resume)
          return {
            ok: false,
            summary: "",
            turns: 0,
            usage: {},
            engine: "claude-code",
            errorText: `No conversation found with session ID: ${resume}`,
          };
        return { ok: true, summary: "built", turns: 1, usage: {}, engine: "claude-code", sessionId: "fresh-1" };
      },
    });
    assert.deepEqual(calls, ["aa932c8a-f6c0-463c-8fa0-87a9ae52895c", null]);
    assert.equal(result.ok, true);
  });
});

/** The smallest PNG: one transparent pixel. */
const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("a lead hears what its workers found", () => {
  /** A reader's written report, its finding far past its first sentence. */
  const REPORT = [
    "Reviewed the scene from four cameras.",
    "",
    "1. The roofs and the dock read well from the overview camera.",
    "2. The fog is a little thin at the far shore; raise its density.",
    "3. The hero's left arm sticks out about 40 degrees from the body in idle, and a strip of cloth stretches to the floor in the walk.",
  ].join("\n");
  const FINDING = /left arm sticks out about 40 degrees/;

  it("LH1. a reader's written report never reached the lead: worker_status names it in full, and a reopened pool still does", async () => {
    const { chatPool, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Fresh eyes", task: "Review the scene.", isolation: "read" });
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: REPORT });
    assert.match(await pool.call(WorkerTool.Status, { id }), FINDING);
    assert.match(await pool.call(WorkerTool.Wait, { id }), FINDING);
    await pool.close();
    const reopened = await chatPool(host, repo);
    assert.match(await reopened.call(WorkerTool.Status, { id }), FINDING, "the report outlives the turn");
  });

  it("LH2. a lead waiting on any worker reads the report of the one that ended, while the list of all stays one line each", async () => {
    const { chatPool, gameRepo, poolHost, settle, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Fresh eyes", task: "Review the scene.", isolation: "read" });
    const waited = pool.call(WorkerTool.Wait, { seconds: 60 });
    await settle();
    host.sessionOf(id).end({ ok: true, sessionId: "s1", summary: REPORT });
    assert.match(await waited, FINDING);
    const all = await pool.call(WorkerTool.Status, {});
    assert.match(all, /Reviewed the scene from four cameras\./, "the list names it by its first sentence");
    assert.doesNotMatch(all, FINDING);
  });

  it("LH4. a worker ended its turn to wait on a long job in the background, and its later calls were refused: its brief says its turn is its whole job", async () => {
    const { workerBrief } = await import("../../src/harness-seed/loop/workers/prompts.ts");
    const brief = workerBrief({
      identity: { folderLabel: "AI Games/garden", facts: [{ id: "web-game", path: "." }] },
      task: "Make the three townsfolk with Genex.",
      isolation: "copy",
      research: false,
      typeDescription: null,
      inputs: [],
    } as never);
    assert.match(brief, /Your turn is your whole job/);
    assert.match(brief, /never wait with sleep or a background command/i);
    assert.match(brief, /call its wait again with the same id/);
  });

  it("LH5. save points were kept on wide shots that never showed the change: a save point names the picture that shows it, and that picture leads its round on the graph", async () => {
    const { gameRepo, loopHost } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir("save-shows-");
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await writeFile(path.join(dir, "shots/hero-closeup.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await gameRepo(dir);
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          const shows = "shots/hero-closeup.png";
          answers.push(await tool("save_point", { label: "Hero", summary: "the hero's arms at his sides", shows }));
          await writeFile(path.join(dir, "b.txt"), "b");
          answers.push(await tool("save_point", { label: "Dock", summary: "the dock" }));
          await writeFile(path.join(dir, "c.txt"), "c");
          answers.push(await tool("save_point", { label: "Boat", summary: "the boat", shows: "../outside.png" }));
          await tool("finish", { summary: "Built.", proof: "a.txt" });
          return undefined;
        },
      ],
    });
    await host.start();
    const [hero, dock, boat] = host.appended("facet_iteration");
    assert.match(String((hero?.shown as { path?: string } | undefined)?.path), /save-1\/shows/);
    assert.equal(dock?.shown, undefined);
    assert.equal(boat?.shown, undefined, "a path outside the folder is never read");
    assert.doesNotMatch(String(answers[0]), /name the picture/);
    assert.match(String(answers[1]), /name the picture that shows what changed/);
    assert.match(String(answers[2]), /not a picture in the project's folder/);
  });

  it("a save point's picture is read only from inside the folder, as a plain PNG or JPEG", async () => {
    const { shownPicture } = await import("../../src/harness-seed/loop/director/open/shown-picture.ts");
    const { symlink } = await import("node:fs/promises");
    const root = await tmpDir("save-shows-hostile-");
    const dir = path.join(root, "game");
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await mkdir(path.join(dir, ".hidden"), { recursive: true });
    const picture = Buffer.from(ONE_PIXEL_PNG, "base64");
    await writeFile(path.join(root, "outside.png"), picture);
    await writeFile(path.join(dir, ".hidden/a.png"), picture);
    await writeFile(path.join(dir, "shots/notes.txt"), "not a picture\n");
    await writeFile(path.join(dir, "shots/huge.png"), Buffer.concat([picture, Buffer.alloc(9 * 1024 * 1024)]));
    await writeFile(path.join(dir, "shots/ok.png"), picture);
    await symlink(path.join(root, "outside.png"), path.join(dir, "shots/link.png"));
    await promisify(execFile)("mkfifo", [path.join(dir, "shots/pipe.png")]);
    const hostile = [
      "../outside.png",
      path.join(root, "outside.png"),
      "shots/link.png",
      ".hidden/a.png",
      "shots/pipe.png",
      "shots/huge.png",
      "shots/notes.txt",
      "shots/missing.png",
      "shots/../../outside.png",
    ];
    for (const rel of hostile) {
      const shown = await shownPicture(dir, rel);
      assert.ok("problem" in shown, `${rel} is refused`);
    }
    const ok = await shownPicture(dir, "shots/ok.png");
    assert.ok("image" in ok && ok.image.data === picture.toString("base64"));
  });

  it("LH6. a worker's work was marked used seconds after it ended, before anyone looked: the merge hands back the pictures it made, to look at", async () => {
    const { chatPool, delegation, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Model the annex", task: "Model the annex.", isolation: "copy" });
    const copy = String(delegation(host, id).cwd);
    await mkdir(path.join(copy, "assets/annex"), { recursive: true });
    await writeFile(path.join(copy, "assets/annex/annex.glb"), "glb");
    await writeFile(path.join(copy, "assets/annex/render.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Modelled the annex." });
    const merged = await pool.call(WorkerTool.Mark, { id, verdict: "used" });
    assert.match(merged, /Merged w1/);
    assert.match(merged, /Look at[^.]*assets\/annex\/render\.png/);
    assert.doesNotMatch(merged, /annex\.glb/, "only its pictures");
  });

  it("LH3. a copy worker's status names the files its work changes", async () => {
    const { chatPool, delegation, finish, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Add a boat", task: "Add boat.js.", isolation: "copy" });
    const copy = String(delegation(host, id).cwd);
    await mkdir(path.join(copy, "src"), { recursive: true });
    await writeFile(path.join(copy, "src/boat.js"), "export const boat = 1;\n");
    await writeFile(path.join(copy, "a.txt"), "changed\n");
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Added the boat." });
    const status = await pool.call(WorkerTool.Status, { id });
    assert.match(status, /a\.txt/);
    assert.match(status, /src\/boat\.js/);
  });
});

describe("a finish claim with known gaps", () => {
  /** A game folder with one commit, for a Loop in place. */
  const folder = async (prefix: string) => {
    const { gameRepo } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir(prefix);
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    return gameRepo(dir);
  };
  const GAPS = "the player has no walk animation\nthe hero's left arm sticks out from the body";

  it("LF1. the lead's closing line of known gaps was cut off with its claim at its length limit: what remains is a field of its own, read first and whole", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const dir = await folder("finish-remaining-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 15 * MINUTE_MS, completionPolicy: "goal" } },
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          await tool("save_point", { label: "Scene", summary: "the scene" });
          await tool("finish", {
            review: "yes",
            summary: `${"The scene holds the town. ".repeat(160)}`,
            remaining: GAPS,
            proof: "a.txt",
          });
          return undefined;
        },
      ],
    });
    await host.start();
    const prompt = String(host.reviewed()[0]?.prompt ?? "");
    assert.match(prompt, /the hero's left arm sticks out from the body/);
    assert.ok(
      prompt.indexOf("the player has no walk animation") < prompt.indexOf("## The lead's claim"),
      "what remains comes before the claim",
    );
  });

  it("LF2. a reviewer's yes ended a three-hour Loop early while the lead named gaps: a claim naming gaps with time left reaches no reviewer, and the lead works on them first", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const dir = await folder("finish-gaps-early-");
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 3 * HOUR_MS, completionPolicy: "timed" } },
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          await tool("save_point", { label: "Scene", summary: "the scene" });
          answers.push(
            await tool("finish", { review: "yes", summary: "The scene is built.", remaining: GAPS, proof: "a.txt" }),
          );
          return undefined;
        },
        async ({ tool }) => {
          await writeFile(path.join(dir, "b.txt"), "b");
          await tool("save_point", { label: "Walk", summary: "the walk and the arms" });
          answers.push(
            await tool("finish", {
              review: "yes",
              summary: "The scene is built and the gaps are closed.",
              proof: "b.txt",
            }),
          );
          return undefined;
        },
      ],
    });
    await host.start();
    assert.match(String(answers[0]), /^Not checked: .*work on it first/);
    assert.match(String(answers[0]), /walk animation/);
    assert.equal(host.reviewed().length, 1, "only the claim with nothing remaining reached a reviewer");
    assert.match(String(answers[1]), /^Accepted/);
  });

  it("LF3. with gaps named but the Loop's time nearly spent, a reviewer's yes still closes it", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const dir = await folder("finish-gaps-late-");
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 15 * MINUTE_MS, completionPolicy: "timed" } },
      turns: [
        async ({ tool }) => {
          await writeFile(path.join(dir, "a.txt"), "a");
          await tool("save_point", { label: "Scene", summary: "the scene" });
          answers.push(
            await tool("finish", { review: "yes", summary: "The scene is built.", remaining: GAPS, proof: "a.txt" }),
          );
          return undefined;
        },
      ],
    });
    await host.start();
    assert.match(String(answers[0]), /^Accepted/);
  });
});

describe("the most workers at once", () => {
  it("LW1. a lead was told 'up to eight at once' while the person's Settings allowed four, and the fifth was answered 'Started' before the host refused it: the pool says the live cap and refuses at once", async () => {
    const { chatPool, gameRepo, poolHost, start } = await import("../helpers/worker-pool-host.ts");
    const { WorkerTool } = await import("../../src/shared/workers.ts");
    const { workerTools } = await import("../../src/harness-seed/loop/workers/specs.ts");
    const repo = await gameRepo();
    const host = poolHost(repo, { workersAllowed: 4 });
    const pool = await chatPool(host, repo);
    for (const n of [1, 2, 3, 4]) await start(pool, { title: `Read ${n}`, task: "Look around.", isolation: "read" });
    const fifth = await pool.call(WorkerTool.Start, { title: "Read 5", task: "Look around.", isolation: "read" });
    assert.match(fifth, /^Not started: 4 workers are running, and at most 4 run at once/);
    assert.equal(host.sessions.length, 4, "nothing was asked of the host for the fifth");
    const start5 = workerTools([], pool.state.allowed).find((tool) => tool.name === WorkerTool.Start);
    assert.match(String(start5?.description), /Up to 4 at once/);
  });
});

describe("a worker wait inside the lead's capped turn", () => {
  it("LT1. the turn's cap cut a four-minute worker_wait short and the turn's continuation re-sent its guidance: a wait ends before the turn must, saying so", async () => {
    const { turnRoomNote, waitWithinTurn } = await import("../../src/harness-seed/loop/director/open/turn-room.ts");
    const { noteTurnEnds } = await import("../../src/harness-seed/loop/director/turn-ends.ts");
    const state = {};
    const now = 1_000_000;
    noteTurnEnds(state, now + 4 * MINUTE_MS);
    const near = waitWithinTurn({ state } as never, { seconds: "240" }, now);
    assert.equal(near.args.seconds, 150, "the wait returns 90 s before the turn must end");
    assert.equal(near.endsBy, now + 4 * MINUTE_MS);
    // Told as the wait returns, not as it began.
    assert.match(turnRoomNote(Number(near.endsBy), now + 150 * SECOND_MS), /turn ends in about 2 minutes/);
    const far = waitWithinTurn({ state } as never, { seconds: "60" }, now);
    assert.deepEqual(far, { args: { seconds: "60" }, endsBy: null }, "a wait that fits is left alone");
    // The pool lets no wait run past 240 s: a longer ask that fits once capped is left alone too.
    noteTurnEnds(state, now + 10 * MINUTE_MS);
    assert.equal(waitWithinTurn({ state } as never, { seconds: "600" }, now).endsBy, null);
    const none = waitWithinTurn({ state: {} } as never, { seconds: "240" }, now);
    assert.equal(none.endsBy, null, "a turn with no end noted waits as asked");
  });
});

describe("the user's ask to finish a running build (director/wrap-up.ts)", () => {

  it("FA4. the wrap-up after the user's ask never invites a claim: their finish closes the run with no reviewer, so no win is claimed", async () => {
    const { wrapUpPrompt } = await import("../../src/harness-seed/loop/director/briefs.ts");
    const now = Date.now();
    const brief = {
      run: { runId: "run_f", project: "racer", goal: "a racer" },
      finalDeadline: now + 30 * 60_000,
      integrationHead: "a".repeat(40),
      integrationHealthy: true,
      workers: [],
    };
    const asked = wrapUpPrompt({ ...brief, userAsked: true } as never);
    assert.doesNotMatch(asked, /victory=yes/, asked);
    assert.match(asked, /claims nothing/);
    assert.match(wrapUpPrompt(brief as never), /victory=yes/, "the clock's wrap-up still may claim the goal");

    // The open Loop: a finish after the person's ask closes at once, with no reviewer.
    const { openClosing } = await import("../../src/harness-seed/loop/director/open/prompts.ts");
    const open = (wrapCause: string) =>
      openClosing({ wrapping: true, wrapCause, idleAsk: false, minutesLeft: 20 } as never);
    assert.doesNotMatch(open("finish"), /reviewer needs/, open("finish"));
    assert.match(open("finish"), /no reviewer/);
    assert.match(open("deadline"), /a reviewer needs that long to check your claim/);
  });

  it("FA6. an open Loop starts no worker once anybody asked it to finish — the app's own Finish too, not only the lead's wrap_up", async () => {
    const { openHandler } = await import("../../src/harness-seed/loop/director/open/tools.ts");
    const { WRAP_UP_WORDS } = await import("../../src/harness-seed/loop/director/wrap-up-prompts.ts");
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      open: { halted: false },
      state: { finished: false, finish: null, finishAsk: null },
      inbox: { finishing: async () => true },
    };
    const answer = await openHandler(loopRun as never)("worker_start", { title: "Lights", task: "Add street lights" });
    assert.equal(answer, WRAP_UP_WORDS.openNoWorkers);
  });
});

describe("a run whose every role was set to think at max effort", () => {
  it("EF1. its workers and reviewers think at most hard, its lead as set; a lower setting is every role's, fixed efforts too", async () => {
    const { roleEffort } = await import("../../src/harness-seed/loop/model-roles.ts");
    const { boundedEffort } = await import("../../src/harness-seed/loop/effort-cap.ts");
    const set = (effort: string) => ({ roles: { efforts: { planner: effort, builder: effort, judge: effort } } });
    const each = (run: object) => ["planner", "builder", "judge"].map((role) => roleEffort(run, role));
    assert.deepEqual(each(set("max")), ["max", "high", "high"], "a worker's and a reviewer's thinking is held to high");
    assert.deepEqual(each(set("medium")), ["medium", "medium", "medium"]);
    assert.deepEqual(each({ effort: "max" }), ["max", undefined, undefined], "the composer's dial is the lead's");
    assert.equal(boundedEffort("high", roleEffort(set("low"), "judge")), "low", "a critic's own effort gives way");
    assert.equal(boundedEffort("high", roleEffort(set("max"), "judge")), "high");
    assert.equal(boundedEffort("high", undefined), "high");
  });

  it("EF2. the Unreal lead thinks as the user set the main agent when it runs the main agent's model; on another model, at the workers' level", async () => {
    const { leadEngine } = await import("../../src/harness-seed/loop/unreal/lead-turn.ts");
    // What the composer sends for a slider at max: the lead's as set, the workers' held to high.
    const efforts = { planner: "max", builder: "high", judge: "high" };
    const one = { engine: "claude-code", model: "claude-opus-5-5", roles: { planner: "claude-opus-5-5", efforts } };
    assert.equal(leadEngine({ run: one } as never).effort, "max", "the lead's own effort, never a worker's ceiling");
    const split = { ...one, builderEngine: "codex", model: "gpt-6.1-sol" };
    assert.equal(leadEngine({ run: split } as never).effort, "high", "a level one model takes may not be another's");
    const lower = { ...one, roles: { ...one.roles, efforts: { planner: "low", builder: "low", judge: "low" } } };
    assert.equal(leadEngine({ run: lower } as never).effort, "low");
    assert.equal(leadEngine({ run: { engine: "claude-code" } } as never).effort, "high", "none chosen: high");
    const buildersOnly = { engine: "claude-code", roles: { efforts: { builder: "medium" } } };
    assert.equal(leadEngine({ run: buildersOnly } as never).effort, "medium", "no main agent's choice: the builders'");
  });
});

describe("a chat in a game linked to an engine other than Unreal", () => {
  it("EG1. its brief never gives web-page rules, the preview's Reload or the web Loop, whether or not the host lists facts", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const { launchRules } = await import("../../src/harness-seed/loop/launch-prompts.ts");
    const launch = { toolName: "start_build", hours: 2 };
    const toy = { ask: "make the garden", gameEngine: "toy-engine", engineProject: "/g/garden/Garden.toyproj", launch };
    const webWords = [/window\.__studio/, /Reload/, /holds a web game/, /builders working in parallel/];
    for (const [name, brief] of [
      ["with facts", buildContractorBrief({ ...toy, facts: [{ id: "toy-project", path: "." }] })],
      ["an older caller that names only the engine", buildContractorBrief(toy)],
    ] as const)
      for (const words of webWords) assert.doesNotMatch(brief, words, `${name}: ${words}`);
    const unnamedLoop = launchRules("claude-code", launch, "toy-engine").join("\n");
    assert.doesNotMatch(
      unnamedLoop,
      /builders working in parallel/,
      "with no Loop named, another engine's is the one Loop",
    );
    // Flipped (Loop phase 4): a reviewer checked its finish; the lead finishes it.
    assert.match(unnamedLoop, /finishes it when the goal is reached/);
    assert.match(launchRules("claude-code", launch, "unreal").join("\n"), /the Unreal Loop/, "Unreal's stays Unreal's");
  });
});

describe("a game its engine plugin plays in its editor, with judges", () => {
  const TOY_FACTS = [{ id: "toy-project", path: "." }];
  const UNREAL_FACTS = [{ id: "unreal-project", path: "." }];
  const JUDGES = [
    { id: "crowd", label: "Crowd" },
    { id: "plain", label: "Plain" },
  ];

  /** A Loop's host on a copy of the toy project, listed as the host lists a game it plays in its editor. */
  async function toyLoop(
    turns: Array<import("../helpers/loop-host.ts").LoopTurn>,
    game: { editorPlay?: boolean; judges?: typeof JUDGES } = { editorPlay: true, judges: JUDGES },
    facts: Array<{ id: string; path: string }> = TOY_FACTS,
  ) {
    const { gameRepo, loopHost } = await import("../helpers/loop-host.ts");
    const { copyProject, Project } = await import("../helpers/project-fixtures.ts");
    const project = facts === UNREAL_FACTS ? Project.UnrealGame : Project.ToyProject;
    const dir = await gameRepo(await copyProject(project, await tmpDir("judged-loop-")));
    const host = loopHost({ dir, facts, turns, run: { runId: `run-judged-${path.basename(dir)}` } });
    Object.assign(host.game, game);
    return host;
  }

  /** A turn that keeps one save point, "One". */
  const savesOne = async ({ tool }: { tool: (name: string, args?: Record<string, string>) => Promise<unknown> }) => {
    await tool("save_point", { label: "One", summary: "the first room" });
    return undefined;
  };
  /** A turn that claims the goal, naming a file of the folder as proof. */
  const finishing =
    (proof: string) =>
    async ({ tool }: { tool: (name: string, args?: Record<string, string>) => Promise<unknown> }) => {
      await tool("finish", { summary: "The room is built.", proof });
      return undefined;
    };
  const finishes = finishing("Garden.toyproj");

  /** The lead's `judge_play` on its first turn, as its engine was handed it; undefined when not offered. */
  const leadJudgeTool = (host: import("../helpers/loop-host.ts").LoopHost) =>
    ((host.leadCalls()[0]?.director as { tools?: Array<Record<string, unknown>> } | undefined)?.tools ?? []).find(
      (tool) => tool.name === "judge_play",
    ) as { parameters: { properties: Record<string, { description?: string }> } } | undefined;

  /** The judges each judge session played as, in order. */
  const judgesPlayed = (host: import("../helpers/loop-host.ts").LoopHost) =>
    host.judged().map((params) => (params.playtest as { judge?: string; role?: string }).judge ?? "plain judge");

  it("EJ1. a game the host says it plays in an editor, whatever its engine: the lead is offered judge_play with the game's judges by id, not only on the Unreal fact", async () => {
    const { playedInEditor } = await import("../../src/harness-seed/loop/folder-facts.ts");
    assert.equal(playedInEditor({ editorPlay: true, facts: TOY_FACTS }), true, "the host's word");
    assert.equal(playedInEditor({ facts: UNREAL_FACTS }), true, "an older host that never says: the Unreal fact");
    assert.equal(playedInEditor(UNREAL_FACTS), true, "a kept older caller that hands facts alone");
    assert.equal(playedInEditor({ facts: TOY_FACTS }), false);
    const host = await toyLoop([finishes]);
    await host.start();
    const tool = leadJudgeTool(host);
    assert.ok(tool, "judge_play offered on a toy-engine game played in its editor");
    assert.match(String(tool.parameters.properties.judge?.description), /crowd \(Crowd\), plain \(Plain\)/);
    assert.match(host.prompts()[0] ?? "", /judge_play: a blind judge plays the game/);
    const plain = await toyLoop([finishes], {});
    await plain.start();
    assert.equal(leadJudgeTool(plain), undefined, "a game no plugin plays in its editor offers none");
  });

  it("EJ2. after a turn keeps a save point no judge plays it: the game's judges play only when the lead asks", async () => {
    const host = await toyLoop([savesOne, finishes]);
    await host.start();
    // Flipped (Loop phase 4): every judge played each save point in turn, unasked.
    assert.deepEqual(judgesPlayed(host), [], "nobody played");
    assert.equal(host.prompts().length, 2, "the Loop went on to its second turn");
    assert.doesNotMatch(host.prompts()[1] ?? "", /judge played save point/);
    assert.match(host.prompts()[0] ?? "", /None plays unless you ask one with judge_play/);
  });

  it("EJ4. no judges, no rounds: a toy game whose plugin declares none, and an Unreal game", async () => {
    const none = await toyLoop([savesOne, finishes], { editorPlay: true });
    await none.start();
    assert.deepEqual(none.judged(), []);
    assert.equal(none.prompts().length, 2, "the Loop went on to its second turn");
    const unreal = await toyLoop([savesOne, finishing("Lantern.uproject")], {}, UNREAL_FACTS);
    await unreal.start();
    assert.deepEqual(unreal.judged(), []);
    assert.ok(leadJudgeTool(unreal), "the Unreal lead keeps judge_play, as before");
  });
});

describe("the close's sentence of an open Loop", () => {
  it('SP1. a save point the lead gave no summary closes as its label alone, never with an empty "()" or ":"', async () => {
    const { openCloseOf } = await import("../../src/harness-seed/loop/director/open/graph.ts");
    const { newOpenJournal } = await import("../../src/harness-seed/loop/director/open/contract.ts");
    const point = (label: string, summary: string) => ({
      label,
      summary,
      snapshotId: "s",
      auto: false,
      at: 0,
      notes: [],
    });
    const journal = (...savePoints: ReturnType<typeof point>[]) => ({ ...newOpenJournal(), savePoints });
    assert.equal(openCloseOf(journal(point("Ship flies", "")), false).summary, "One save point: Ship flies.");
    assert.equal(
      openCloseOf(journal(point("Ship flies", ""), point("Rocks fall", "  ")), false).summary,
      "2 save points; the last, Rocks fall.",
    );
    assert.equal(
      openCloseOf(journal(point("Ship flies", "It turns and thrusts.")), false).summary,
      "One save point: Ship flies (It turns and thrusts).",
      "a summary's own full stop is not doubled",
    );
  });
});

describe("a plugin's web build and the chat's turn", () => {
  it("WB1. a turn whose only change is a plugin's web build (Godot's export in web/) leaves the game's kind as it was: no new-kind continuation", async () => {
    const { kindKey } = await import("../../src/harness-seed/loop/web-build.ts");
    const before = [{ id: "godot-project", path: "godot" }];
    const exported = [
      ...before,
      { id: "web-game", path: "web" },
      { id: "godot-web-export", path: "web", source: "plugin:godot" },
    ];
    assert.equal(kindKey(exported), kindKey(before), "the build is no new kind");
    const site = [...before, { id: "web-game", path: "site" }];
    assert.notEqual(kindKey(site), kindKey(before), "a web game no plugin claims is one");
  });
});

describe("a Loop whose lead lost what its goal needs (claude-code-and-chatgpt)", () => {
  const WHY =
    "Unity's editor tools are gone from this session, so nothing I change reaches the game. Open the project in Unity, then press Resume.";

  it("MK1. a Unity lead whose editor tools vanished spent hours on work that never reached the game, with no way to tell the person: it pauses the Loop with its words, and nothing runs after", async () => {
    const { gameRepo, loopHost } = await import("../helpers/loop-host.ts");
    const { OPEN_WORDS } = await import("../../src/harness-seed/loop/director/open/prompts.ts");
    const dir = await tmpDir("lead-pauses-");
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await gameRepo(dir);
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          answers.push(await tool("pause", {}));
          answers.push(await tool("pause", { why: WHY }));
          answers.push(await tool("save_point", { label: "Late", summary: "after the pause" }));
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.match(String(answers[0]), /pause needs/, "a pause says what only the person can do");
    assert.match(String(answers[1]), /end your turn/i);
    assert.equal(answers[2], OPEN_WORDS.paused, "nothing is kept once it pauses");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /Open the project in Unity, then press Resume/);
    assert.equal(host.leadCalls().length, 1, "no turn after the pause");
    assert.equal(host.appended("autopilot_paused").length, 1);
    assert.equal(host.reviewed().length, 0, "nothing was claimed");
  });
});

describe("a tool the user asked for that can't run here (claude-code-and-chatgpt)", () => {
  it("MK2. the contractor saw Blender was too old to run, said Unity was ready and queued a 24-hour build that never used Blender: its brief says to tell the user with the fix first", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const brief = buildContractorBrief({ ask: "Make a Unity fighting game. Use blender." });
    assert.match(brief, /never carry on without it in silence/);
    assert.match(brief, /__install/);
  });
});

describe("the reviewer's no's in a Loop that still has time", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;
  const MET = "The hands, the boss and the full run were already accepted and still hold.";
  const NOT_DONE = "The enemy in the game shows none of the armour its model has.";
  const CLAIM = { review: "yes", summary: "The enemy wears its armour in the game.", proof: "shots/enemy.png" };

  /** A web game with a close picture the lead names as proof, made before the Loop. */
  async function gameWithProof(prefix: string): Promise<string> {
    const { gameRepo } = await import("../helpers/loop-host.ts");
    const dir = await tmpDir(prefix);
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
    await writeFile(path.join(dir, "shots/enemy.png"), Buffer.from(ONE_PIXEL_PNG, "base64"));
    await gameRepo(dir);
    return dir;
  }

  it("FC1. a timed Loop with most of its time left closed on the reviewer's third no about one fixable point: it keeps working, and its next claim needs new work since that no", async () => {
    const { utimes } = await import("node:fs/promises");
    const { loopHost } = await import("../helpers/loop-host.ts");
    const { reviewerAnswer } = await import("../helpers/reviewer.ts");
    const { MAX_FINISH_REJECTIONS } = await import("../../src/harness-seed/loop/finish-contract.ts");
    const dir = await gameWithProof("nos-time-left-");
    const answers: unknown[] = [];
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      run: { budgets: { wallClockMs: 5 * HOUR, completionPolicy: "duration" } },
      turns: [
        async ({ tool }) => {
          for (let n = 0; n <= MAX_FINISH_REJECTIONS; n++) answers.push(await tool("finish", CLAIM));
          // A fresh picture alone is no new work: it needs a save point too.
          const now = new Date(host.now() + MINUTE);
          await utimes(path.join(dir, "shots/enemy.png"), now, now);
          answers.push(await tool("finish", CLAIM));
          await writeFile(path.join(dir, "enemy.txt"), "armour plates on the limbs\n");
          answers.push(await tool("save_point", { label: "Armour", summary: "the enemy wears its plates" }));
          answers.push(await tool("finish", CLAIM));
          return undefined;
        },
      ],
    });
    for (let n = 0; n < MAX_FINISH_REJECTIONS; n++)
      host.reviews.push(reviewerAnswer("no", [MET], "claude-code", [NOT_DONE]));
    const report = await host.start();
    // Flipped (Loop phase 4): a no is a second opinion, whatever the time left: it decides nothing.
    assert.match(String(answers[MAX_FINISH_REJECTIONS - 1]), /decides nothing/, "the third no keeps it going");
    assert.match(
      String(answers[MAX_FINISH_REJECTIONS]),
      /new work since the last no/,
      "the same proof again is turned back",
    );
    assert.match(
      String(answers[MAX_FINISH_REJECTIONS + 1]),
      /new work since the last no/,
      "a touched file is not enough",
    );
    assert.equal(host.reviewed().length, MAX_FINISH_REJECTIONS + 1, "the stale claims asked no reviewer");
    assert.equal(report.victory, true, "the claim after a save point and a fresh picture was checked and accepted");
    const nos = host.appended("finish_check").filter((check) => check.step === "rejected");
    assert.deepEqual(
      nos.map((check) => [check.stopped === true, check.timeLeft === true]),
      Array.from({ length: MAX_FINISH_REJECTIONS }, () => [false, true]),
    );
  });

  it("FC2. a Loop the reviewer's no's stopped listed what the reviewer had accepted under not done: only what isn't done is", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const { reviewerAnswer } = await import("../helpers/reviewer.ts");
    const { MAX_FINISH_REJECTIONS } = await import("../../src/harness-seed/loop/finish-contract.ts");
    const dir = await gameWithProof("nos-not-done-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          for (let n = 0; n < MAX_FINISH_REJECTIONS; n++) await tool("finish", CLAIM);
          return undefined;
        },
      ],
    });
    for (let n = 0; n < MAX_FINISH_REJECTIONS; n++)
      host.reviews.push(reviewerAnswer("no", [MET], "claude-code", [NOT_DONE]));
    const report = await host.start();
    assert.equal(report.victory, false);
    assert.deepEqual(report.notDone, [NOT_DONE]);
    assert.ok(String(report.summary).includes(NOT_DONE));
    assert.ok(!String(report.summary).includes(MET), "what the reviewer accepted is not listed as not done");
    const stopped = host.appended("finish_check").at(-1);
    assert.equal(stopped?.stopped, true);
    assert.deepEqual([stopped?.reasons, stopped?.notDone], [[MET], [NOT_DONE]]);
  });

  it("FC3. the chat rebuilt a stopped Loop's Almost there card from records a reopened page could lose: the close carries the list, why it stopped and its hours", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const { reviewerAnswer } = await import("../helpers/reviewer.ts");
    const { MAX_FINISH_REJECTIONS, StopWhy } = await import("../../src/harness-seed/loop/finish-contract.ts");
    const dir = await gameWithProof("nos-card-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ tool }) => {
          for (let n = 0; n < MAX_FINISH_REJECTIONS; n++) await tool("finish", CLAIM);
          return undefined;
        },
      ],
    });
    for (let n = 0; n < MAX_FINISH_REJECTIONS; n++)
      host.reviews.push(reviewerAnswer("no", [MET], "claude-code", [NOT_DONE], ["Laps run"]));
    const report = await host.start();
    // Flipped (Loop phase 4): the no's stopped the Loop (`stuck`); they decide nothing, and it ended another way.
    assert.deepEqual(report.stillToFix, { done: ["Laps run"], notDone: [NOT_DONE], why: StopWhy.Ended, hours: null });
  });

  it("FC4. a Loop the person stopped after a no paused, and its card offered Keep building beside Resume: a pause carries no list", async () => {
    const { loopHost } = await import("../helpers/loop-host.ts");
    const { reviewerAnswer } = await import("../helpers/reviewer.ts");
    const dir = await gameWithProof("stop-after-no-");
    const host = loopHost({
      dir,
      facts: [{ id: "web-game", path: "." }],
      turns: [
        async ({ host, tool }) => {
          await tool("finish", CLAIM);
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    host.reviews.push(reviewerAnswer("no", [MET], "claude-code", [NOT_DONE]));
    const report = await host.start();
    assert.equal(report.executionStatus, "paused", "a Stop pauses the Loop for a Resume");
    assert.equal(report.stillToFix, undefined);
  });
});

/**
 * A request that names an engine none of the engine question's options covers is never asked that
 * question: it goes through `plugins_find`, as the question's own words say before they ask.
 */
describe("a request naming an engine the engine question doesn't offer", () => {
  it("with only Unity on, a request for a Godot game is sent to plugins_find before the question is asked, never offered Web or Unity", async () => {
    const { engineChoiceRule } = await import("../../src/harness-seed/loop/unreal-prompts.ts");
    const { toolCall } = await import("../../src/harness-seed/loop/model-roles.ts");
    const unity = { plugin: "unity", name: "Unity", tool: "unity__new-game", makes: ["unity-project"] };
    for (const engine of ["claude-code", "codex", undefined]) {
      const rule = engineChoiceRule(engine, null, [unity]);
      const find = rule.indexOf(toolCall(engine, "plugins_find"));
      const ask = rule.indexOf(toolCall(engine, "ask_user"));
      assert.ok(find >= 0, `${engine}: another engine goes through plugins_find`);
      assert.ok(find < ask, `${engine}: before the question is asked`);
    }
  });
});

/**
 * A resumed chat session whose game still has no kind keeps the question card its first brief named:
 * a session that remembers the engine question would otherwise call a tool it no longer has.
 */
describe("a resumed chat session on a game with no kind yet", () => {
  it("a resumed session was told to ask with ask_user on its first turn and lost the card on the next: it keeps the card while the game has no kind", async () => {
    const { runDelegatedTurn } = await import("../../src/harness-seed/loop/delegated-turn.ts");
    const { ctxRecorder } = await import("../helpers/ctx-recorder.ts");
    const unity = { plugin: "unity", name: "Unity", tool: "unity__new-game", makes: ["unity-project"] };
    const made = { name: "dodger", title: "Dodger", dir: "/games/dodger", shape: null, built: false, facts: [] };
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "make a game in godot" }],
        "game.contentStamp": () => ({ all: null, source: null }),
        "game.list": () => [made],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [unity] }),
        "engine.describe": () => [],
        "preview.ready": () => ({ ready: false }),
        "engine.delegate": () => ({
          ok: true,
          engine: "claude-code",
          turns: 1,
          usage: {},
          sessionId: "s",
          summary: "ok",
        }),
      },
    });
    const turn = { threadId: "t", turnId: "turn-2", text: "Godot is on now", engine: "claude-code", project: "dodger" };
    await runDelegatedTurn(
      recorder.ctx as never,
      { ...turn, engineLabel: "Claude Code", resume: "session-1" } as never,
    );
    const [delegated] = recorder.paramsOf("engine.delegate");
    const bridged = (delegated?.interviewTools as Array<{ name: string }> | undefined)?.map((tool) => tool.name) ?? [];
    assert.ok(bridged.includes("ask_user"), "the card is still there to call");
  });
});

describe("the language of Genex's own turns", () => {
  it("AL1. a resume or continue is Genex's own English words, and the agent answered a Russian chat in English: the brief names the app's language as the fallback", async () => {
    const { buildContractorBrief } = await import("../../src/harness-seed/loop/chat-session.ts");
    const russian = { tag: "ru", name: "Русский" };
    for (const resume of [false, true])
      assert.match(
        buildContractorBrief({ ask: "Continue", resume, appLanguage: russian }),
        /Genex's own rather than the user's[\s\S]*Русский \(ru\)/,
        resume ? "a resumed session" : "a new session",
      );
  });
});

describe("a new Loop a plugin held back before its first turn", () => {
  it("HS1. the Loop's start was held back (Unreal wouldn't reopen) and nobody acted until the person asked the chat to reopen it: the close says startHeld and the chat's agent is told once", async () => {
    const { heldStartAsk } = await import("../../src/main/core/held-start.ts");
    const { MessageOrigin } = await import("../../src/shared/protocol.ts");
    const record = (id: string, event_type: string, payload: Record<string, unknown>) => ({
      id,
      thread_id: "t1",
      turn_id: null,
      session_id: null,
      created_at: "2026-10-27T18:58:00.000Z",
      data: { type: "custom" as const, event_type, payload },
    });
    const person = { type: "user_message", threadId: "t1", text: "make it photoreal", engine: "claude-code" };
    const because = "The Loop didn't start: a plugin of this project held it back: Unreal couldn't be reopened.";
    const events = [
      record("1", "coordinator_message_queued", { messageId: "m1", action: person }),
      record("2", "run_finished", { runId: "r1", stoppedBecause: because, startHeld: true }),
    ];
    const ask = heldStartAsk("t1", events, "r1");
    assert.equal(ask?.options.origin, MessageOrigin.LoopHeld);
    assert.equal(ask?.options.engine, "claude-code");
    assert.ok(ask?.text.includes(because));
    const asked = { ...person, origin: MessageOrigin.LoopHeld };
    const again = [
      ...events,
      record("3", "coordinator_message_queued", { messageId: "m2", action: asked }),
      record("4", "run_finished", { runId: "r2", stoppedBecause: because, startHeld: true }),
    ];
    assert.equal(heldStartAsk("t1", again, "r2"), null, "held again: it waits for the person");
  });
});

describe("the lead and its workers are free agents (Loop phase 3)", () => {

  it("FL2. Blender went to one worker only, and a worker on an engine's project was told the editor was the lead's alone: a worker has every tool its lead has, its type only the kind of work", async () => {
    const { workerBrief } = await import("../../src/harness-seed/loop/workers/prompts.ts");
    const { workerTools } = await import("../../src/harness-seed/loop/workers/specs.ts");
    const { CoreFact } = await import("../../src/harness-seed/loop/folder-facts.ts");
    const blender = { pluginId: "blender", id: "blender_model", description: "Models one prop.", tools: ["blender__"] };
    const start = workerTools([{ ...blender, isolation: "copy" }] as never).find(
      (tool) => tool.name === "worker_start",
    );
    assert.match(String(start?.description), /with every plugin tool and connector you have/);
    const type = start?.parameters.properties.type;
    assert.doesNotMatch(String(type?.description), /brings that kind's tools/);
    const onUnreal = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [{ id: CoreFact.UnrealProject, path: "." }] as never },
      task: "restart the editor and play the gate",
      isolation: "copy" as never,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.doesNotMatch(onUnreal, /none of its tools|lead's alone/, "the editor's tools are a worker's too");
    assert.match(onUnreal, /use the editor's tools for what only it can do \(start or restart it/);
  });

  it("FL6. only Claude Code and Codex could lead in place or run workers: every engine that keeps a session (a local model's too) orchestrates alike; one with no session of its own does not", async () => {
    const { leadsInPlace } = await import("../../src/harness-seed/loop/engine-seat.ts");
    const { hasSessionRoles } = await import("../../src/harness-seed/loop/model-roles.ts");
    const rows: Array<[string, Record<string, unknown>, boolean]> = [
      ["a delegated agent", { kind: "delegated", supportsSessions: true }, true],
      ["a delegated agent that says nothing", { kind: "delegated" }, true],
      [
        "a local model's session (Bonsai, OpenRouter, a local server)",
        { kind: "direct", supportsSessions: true },
        true,
      ],
      ["a tool loop with no session (Ollama)", { kind: "direct" }, false],
      ["an agent that keeps no session", { kind: "delegated", supportsSessions: false }, false],
    ];
    for (const [label, descriptor, leads] of rows) assert.equal(leadsInPlace(descriptor), leads, label);
    // The chat's own session is handed the worker tools on each engine that keeps a session.
    for (const engine of ["claude-code", "codex", "bonsai", "openrouter", "local-server", "opencode"])
      assert.equal(hasSessionRoles(engine), true, engine);
    assert.equal(hasSessionRoles("ollama"), false);
  });
});
