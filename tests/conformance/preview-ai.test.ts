/**
 * Play-time models in a game's preview: a practice helper answers every preview with made-up
 * answers, and real models answer Live alone, only for the game and the cap the person approved by
 * pressing Start. The helpers here are small Node programs that print what `genex llm practice
 * --json` prints, so a stop is proven by the process being gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PreviewAiService, withPracticeKey } from "../../src/main/core/preview-ai.ts";
import type { PracticeLaunch } from "../../src/main/core/genex-cli.ts";
import { PreviewAiMode, type PreviewAiState, PreviewAiUnavailable } from "../../src/shared/preview-ai.ts";
import { withGenexSdkImport } from "../../src/shared/genex-page.ts";
import { codeCallsPlayTimeModels, gameCallsPlayTimeModels } from "../../src/substrate/project-shape.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = "live";
const TEMPLATE_PAGE = path.resolve(import.meta.dirname, "../../src/game-template/index.html");
const AGENT = "game-preview-facet-1";
const HEX = "0123456789abcdef0123456789abcdef";

/** What a helper of each kind prints first; later lines follow after `after` ms. */
interface Script {
  first: Record<string, unknown>;
  later?: Record<string, unknown>[];
}

/** A program printing `script` as JSON lines that runs until it is told to stop. */
const program = (script: Script) =>
  `const lines=${JSON.stringify([script.first, ...(script.later ?? [])].map((line) => JSON.stringify(line)))};` +
  `let i=0;const next=()=>{if(i<lines.length){process.stdout.write(lines[i++]+"\\n");setTimeout(next,20);}};next();` +
  `process.on("SIGTERM",()=>{process.stdout.write(JSON.stringify({event:"stopped"})+"\\n");process.exit(0);});setInterval(()=>{},1000);`;

const listening = (port: number, mode: "mock" | "live") => ({
  command: "llm practice",
  status: "listening",
  port,
  key: `genex_llm_practice=${port}.${HEX}`,
  mode,
});

/** A service whose helpers are scripted per kind, with what it launched, emitted and reloaded. */
async function service(
  options: { live?: Script; mock?: Script; allowed?: boolean; signedIn?: boolean; draft?: boolean } = {},
) {
  const scratch = await tmpDir("studio-preview-ai-");
  const launches: Array<{ project: string; live: { maxCredits: number } | null }> = [];
  const states: PreviewAiState[] = [];
  const reloads: string[] = [];
  const pids: number[] = [];
  const ai = new PreviewAiService(
    {
      launch: async (project, live) => {
        launches.push({ project, live });
        const script = live
          ? (options.live ?? { first: listening(41001, "live") })
          : (options.mock ?? { first: listening(41000, "mock") });
        return {
          command: program(script),
          cwd: scratch,
          env: {},
          label: "test",
          policy: { allowedDomains: [], allowWrite: [], denyWrite: [] },
          root: `${scratch}/run-${launches.length}`,
        } satisfies PracticeLaunch;
      },
      spawn: async (request) => {
        const child = spawn(process.execPath, ["-e", request.command], { stdio: ["pipe", "pipe", "pipe"] });
        if (child.pid) pids.push(child.pid);
        return { child, input: child.stdin };
      },
      signedIn: async () => options.signedIn ?? true,
      hasDraft: async () => options.draft ?? true,
      liveAllowed: () => options.allowed ?? true,
      emit: (state) => states.push(state),
      reloadLive: async (project) => {
        reloads.push(project);
      },
      stopGraceMs: 2000,
    },
    LIVE,
  );
  return { ai, launches, states, reloads, pids };
}

describe("practice answers in every preview", () => {
  it("gives Live and an agent's window made-up answers, and adds the key to the page's address", async () => {
    const { ai, launches } = await service();
    try {
      const key = await ai.keyFor(LIVE, "inn");
      assert.equal(key, `genex_llm_practice=41000.${HEX}`);
      assert.equal(await ai.keyFor(AGENT, "inn"), key, "one helper per game serves both previews");
      assert.deepEqual(launches, [{ project: "inn", live: null }]);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Practice);
      assert.equal(withPracticeKey("index.html?genex_local_test=1", key), `index.html?genex_local_test=1&${key}`);
      assert.equal(withPracticeKey("index.html", null), "index.html");
    } finally {
      await ai.stopAll();
    }
  });

  it("stops a game's helper once no preview shows it, and leaves no process behind", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.keyFor(AGENT, "inn");
    await ai.release(AGENT);
    assert.equal(ai.runningPids().length, 1, "Live still shows the game");
    await ai.release(LIVE);
    assert.deepEqual(ai.runningPids(), []);
    for (const pid of pids) assert.equal(running(pid), false, `helper ${pid} is gone`);
  });

  it("stops the last game's helper when Live moves to another game", async () => {
    const { ai, pids } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      await ai.keyFor(LIVE, "tavern");
      assert.equal(running(pids[0] ?? 0), false, "the inn's helper stopped");
      assert.equal(ai.runningPids().length, 1);
    } finally {
      await ai.stopAll();
    }
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("stops every helper when the app quits", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.keyFor(AGENT, "tavern");
    await ai.stopAll();
    for (const pid of pids) assert.equal(running(pid), false);
    assert.equal(await ai.keyFor(LIVE, "inn"), null, "nothing starts once the app is quitting");
  });

  it("takes the bar away once Live's game calls no model any more", async () => {
    const { ai, pids } = await service();
    await ai.keyFor(LIVE, "inn");
    await ai.noModels(LIVE, "inn");
    assert.equal(ai.state("inn").mode, PreviewAiMode.None);
    assert.deepEqual(ai.runningPids(), []);
    for (const pid of pids) assert.equal(running(pid), false);
  });

  it("goes on without a key when the helper fails, and says so", async () => {
    const { ai } = await service({
      mock: { first: { command: "llm practice", status: "failed", error: "boom", code: "EACCES" } },
    });
    try {
      assert.equal(await ai.keyFor(LIVE, "inn"), null);
      assert.equal(ai.state("inn").reason, PreviewAiUnavailable.HelperFailed);
      assert.match(ai.state("inn").error ?? "", /EACCES: boom/);
    } finally {
      await ai.stopAll();
    }
  });
});

describe("real models in Live, approved once with a cap", () => {
  it("never starts real models without the person's Start for that game and cap", async () => {
    const { ai, launches } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      await ai.keyFor(AGENT, "inn");
      assert.ok(
        launches.every((launch) => launch.live === null),
        "no approval, no real models",
      );
      await assert.rejects(ai.startRealModels("inn", 50), /not a cap/);
      await assert.rejects(ai.startRealModels("inn", Number.NaN), /not a cap/);
      assert.ok(
        launches.every((launch) => launch.live === null),
        "a cap Live does not offer starts nothing",
      );
    } finally {
      await ai.stopAll();
    }
  });

  it("starts real models in Live for the approved cap, and an agent's window keeps made-up answers", async () => {
    const { ai, launches, reloads } = await service();
    try {
      await ai.keyFor(LIVE, "inn");
      const started = await ai.startRealModels("inn", 300);
      assert.equal(started.mode, PreviewAiMode.Starting);
      assert.deepEqual(reloads, ["inn"], "Live is loaded again to take the new key");
      const key = await ai.keyFor(LIVE, "inn");
      assert.equal(key, `genex_llm_practice=41001.${HEX}`);
      assert.deepEqual(launches.at(-1), { project: "inn", live: { maxCredits: 300 } });
      assert.equal(ai.state("inn").mode, PreviewAiMode.Live);
      assert.equal(await ai.keyFor(AGENT, "inn"), `genex_llm_practice=41000.${HEX}`, "never the paid key");
      assert.equal(launches.filter((launch) => launch.live !== null).length, 1);
      await ai.keyFor(AGENT, "tavern");
      assert.ok(
        launches.filter((launch) => launch.project === "tavern").every((launch) => launch.live === null),
        "an approval is for its own game only",
      );
    } finally {
      await ai.stopAll();
    }
  });

  it("answers the unavailable state, with its reason, where it cannot spend", async () => {
    const cases = [
      { options: { allowed: false }, reason: PreviewAiUnavailable.NotHere },
      { options: { signedIn: false }, reason: PreviewAiUnavailable.SignedOut },
      { options: { draft: false }, reason: PreviewAiUnavailable.NoDraft },
    ];
    for (const { options, reason } of cases) {
      const { ai, launches, reloads } = await service(options);
      try {
        const state = await ai.startRealModels("inn", 100);
        assert.equal(state.mode, PreviewAiMode.Unavailable);
        assert.equal(state.reason, reason);
        await ai.keyFor(LIVE, "inn");
        assert.ok(
          launches.every((launch) => launch.live === null),
          `${reason}: nothing spends`,
        );
        assert.deepEqual(reloads, []);
      } finally {
        await ai.stopAll();
      }
    }
  });

  it("falls back to practice with the reason when the lane is off", async () => {
    const { ai } = await service({ live: { first: { command: "llm practice", status: "off", error: null } } });
    try {
      await ai.startRealModels("inn", 100);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Unavailable);
      assert.equal(ai.state("inn").reason, PreviewAiUnavailable.LaneOff);
      assert.equal(ai.runningPids().length, 1, "only the practice helper runs");
    } finally {
      await ai.stopAll();
    }
  });

  it("shows what the run spent, and when its cap is used up", async () => {
    const later = [
      {
        event: "live",
        kind: "generate",
        callCredits: 4,
        ceilingCredits: 4,
        chargedCredits: 4,
        heldCredits: 0,
        capCredits: 100,
      },
      { event: "call", kind: "generate", status: "refused", error: "grant_limit_reached", via: "live" },
    ];
    const { ai } = await service({ live: { first: listening(41001, "live"), later } });
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      await sleep(300);
      assert.equal(ai.state("inn").chargedCredits, 4);
      assert.equal(ai.state("inn").mode, PreviewAiMode.CapReached);
    } finally {
      await ai.stopAll();
    }
  });

  it("goes back to practice on the person's Stop, and stops the paid run", async () => {
    const { ai, pids } = await service();
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      const paid = pids.at(-1) ?? 0;
      const state = await ai.backToPractice("inn");
      assert.equal(state.mode, PreviewAiMode.Practice);
      assert.equal(running(paid), false);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`);
    } finally {
      await ai.stopAll();
    }
  });

  it("keeps the choice for the game while Live is away, and stops the paid run meanwhile", async () => {
    const { ai, pids, launches } = await service();
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      const paid = pids.at(-1) ?? 0;
      await ai.release(LIVE);
      assert.equal(running(paid), false, "Live's Stop ends the paid run");
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "Play starts it again");
      assert.deepEqual(launches.at(-1)?.live, { maxCredits: 100 });
    } finally {
      await ai.stopAll();
    }
  });

  it("holds every run of a game to the one cap the person approved: a later run gets what is left", async () => {
    const spent = { event: "live", kind: "generate", chargedCredits: 55, heldCredits: 5, capCredits: 100 };
    const { ai, launches } = await service({ live: { first: listening(41001, "live"), later: [spent] } });
    const paid = () => launches.filter((launch) => launch.live !== null).map((launch) => launch.live?.maxCredits);
    try {
      await ai.startRealModels("inn", 100);
      await ai.keyFor(LIVE, "inn");
      await sleep(300);
      await ai.release(LIVE);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41001.${HEX}`, "Play goes on with real models");
      assert.deepEqual(paid(), [100, 40], "the second run may spend only what the first left");
      await sleep(300);
      assert.equal(
        ai.state("inn").chargedCredits,
        115,
        "the bar counts both runs, a held bill of an ended one as spent",
      );
      await ai.release(LIVE);
      assert.equal(await ai.keyFor(LIVE, "inn"), `genex_llm_practice=41000.${HEX}`, "nothing left: made-up answers");
      assert.deepEqual(paid(), [100, 40], "no third paid run without a new Start");
      assert.equal(ai.state("inn").mode, PreviewAiMode.CapReached);
      await ai.startRealModels("inn", 300);
      await ai.keyFor(LIVE, "inn");
      assert.deepEqual(paid(), [100, 40, 300], "a new Start is a new cap, counted from nothing");
    } finally {
      await ai.stopAll();
    }
  });
});

describe("which games call play-time models", () => {
  const SDK = 'import { requestSpendGrant, generateStream } from "@genex-ai/embed-sdk";';
  const table: Array<{ name: string; code: string; calls: boolean }> = [
    { name: "a budget asked for", code: `${SDK}\nawait requestSpendGrant({ models: [] });`, calls: true },
    { name: "a streamed answer", code: `${SDK}\nawait generateStream({ grantId });`, calls: true },
    {
      name: "the model list",
      code: 'import { getGenerationModels } from "@genex-ai/embed-sdk";\ngetGenerationModels();',
      calls: true,
    },
    {
      name: "a judge's question",
      code: 'import { judge } from "@genex-ai/embed-sdk";\nawait judge({ grantId, state, questions });',
      calls: true,
    },
    {
      name: "generate from the SDK",
      code: 'import { generate } from "@genex-ai/embed-sdk";\nawait generate({ prompt });',
      calls: true,
    },
    {
      name: "generate from Studio's copy",
      code: 'import { generate } from "/vendor/genex/embed-sdk.js";\ngenerate({ prompt });',
      calls: true,
    },
    { name: "a generate() of the game's own", code: "function generate() {}\ngenerate();", calls: false },
    { name: "a line comment", code: "// later: requestSpendGrant() for the innkeeper", calls: false },
    { name: "a block comment", code: "/* generateStream({ grantId }) */ const x = 1;", calls: false },
    { name: "a string", code: 'const hint = "call requestSpendGrant() first";', calls: false },
    { name: "a template string", code: "const hint = `judge(x) first`;", calls: false },
    { name: "a longer name", code: "const requestSpendGrantLater = 1; myjudge(1);", calls: false },
    { name: "a URL before a call", code: `${SDK}\nconst u = "http://x"; await requestSpendGrant({});`, calls: true },
    { name: "an unterminated comment", code: "/* requestSpendGrant(", calls: false },
    { name: "an unterminated string", code: '"requestSpendGrant(', calls: false },
    { name: "nothing", code: "", calls: false },
    { name: "a huge file", code: `${"x".repeat(2_000_000)} requestSpendGrant()`, calls: false },
  ];
  for (const { name, code, calls } of table)
    it(`${calls ? "calls" : "does not call"}: ${name}`, () => {
      assert.equal(codeCallsPlayTimeModels(code), calls);
    });

  it("reads a game's own sources, only once its page or package loads the SDK", async () => {
    const dir = await tmpDir("studio-models-game-");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    const page = withGenexSdkImport(await readFile(TEMPLATE_PAGE, "utf8")) ?? "";
    await writeFile(path.join(dir, "index.html"), page);
    await writeFile(path.join(dir, "src", "main.js"), "console.log(1);");
    await writeFile(path.join(dir, "node_modules", "x", "index.js"), `${SDK} requestSpendGrant();`);
    assert.equal(await gameCallsPlayTimeModels(dir), false, "a dependency's code is not the game's");
    await writeFile(path.join(dir, "src", "npc.js"), `${SDK}\nawait requestSpendGrant({});`);
    assert.equal(await gameCallsPlayTimeModels(dir), true);
    await writeFile(path.join(dir, "index.html"), "<!doctype html><script src=src/main.js></script>");
    assert.equal(await gameCallsPlayTimeModels(dir), false, "no SDK on the page, no calls");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "0.37.0" } }),
    );
    assert.equal(await gameCallsPlayTimeModels(dir), true, "a built game names the SDK in its package");
    assert.equal(await gameCallsPlayTimeModels(path.join(dir, "missing")), false);
  });

  it("does not follow a link out of the game", async () => {
    const dir = await tmpDir("studio-models-link-");
    const outside = await tmpDir("studio-models-outside-");
    await writeFile(path.join(outside, "npc.js"), 'import { judge } from "@genex-ai/embed-sdk"; judge({});');
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@genex-ai/embed-sdk": "0.37.0" } }),
    );
    await writeFile(path.join(dir, "index.html"), "<!doctype html>");
    await symlink(outside, path.join(dir, "src"));
    assert.equal(await gameCallsPlayTimeModels(dir), false);
  });
});
