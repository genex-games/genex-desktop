/**
 * The practice helper named to the Unreal editor (`practice-handoff.ts`): `<game>/.studio/
 * llm-practice.json` holds exactly `{"key":"<port>.<32 hex>"}` while Live shows the game's Unreal
 * card and a helper runs, names the helper that answers now after the person changes it in Live's
 * bar, and is gone once Live leaves the game, Live stops or the app quits. The helpers are the
 * scripted programs of `practice-helper.ts`, so a stop is proven by the process being gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { PracticeLaunch } from "../../src/main/core/genex-cli.ts";
import { EditorPractice, handoffKey, namePractice, unnamePractice } from "../../src/main/core/practice-handoff.ts";
import { PreviewAiService } from "../../src/main/core/preview-ai.ts";
import { serial } from "../../src/main/core/serial.ts";
import { GenexHosting } from "../../src/shared/genex.ts";
import { PreviewAiMode, type PreviewAiPlan } from "../../src/shared/preview-ai.ts";
import { HEX, HOST_PORT, hostProgram, listening, program } from "../helpers/practice-helper.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = "live";
const HANDOFF = path.join(".studio", "llm-practice.json");
const MOCK_KEY = `41000.${HEX}`;
const LIVE_KEY = `41001.${HEX}`;
const PLAN_KEY = `${HOST_PORT}.${HEX}`;
/** The person's own plan in these tests. */
const PLAN: PreviewAiPlan = { engine: "codex", label: "Codex" };

/** A game folder as Genex keeps one: its `studio.json`, and nothing else. */
async function gameFolder(): Promise<string> {
  const dir = await tmpDir("studio-practice-handoff-");
  await writeFile(path.join(dir, "studio.json"), "{}");
  return dir;
}

/** The handoff's text, or null when the game has none. */
const handoff = (dir: string) => readFile(path.join(dir, HANDOFF), "utf8").catch(() => null);

describe("the handoff's key", () => {
  it("is the service's key without its parameter name", () => {
    assert.equal(handoffKey(`genex_llm_practice=${MOCK_KEY}`), MOCK_KEY);
  });

  const refused: unknown[] = [
    null,
    undefined,
    41000,
    "",
    MOCK_KEY,
    `genex_llm_practice=041000.${HEX}`,
    `genex_llm_practice=01024.${HEX}`,
    `genex_llm_practice=1023.${HEX}`,
    `genex_llm_practice=65536.${HEX}`,
    `genex_llm_practice=41000.${HEX.toUpperCase()}`,
    `genex_llm_practice=41000.${HEX.slice(1)}`,
    `genex_llm_practice=41000.${HEX}0`,
    `genex_llm_practice=41000.${HEX}\n`,
    `genex_llm_practice=41000.${HEX}","url":"http://evil.test`,
    `other=41000.${HEX}`,
  ];
  for (const value of refused)
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.equal(handoffKey(value), null);
    });
});

describe("naming a helper in a game's folder", () => {
  it("writes exactly the key, replaces it with a new one, and removes it", async () => {
    const dir = await gameFolder();
    await namePractice(dir, MOCK_KEY);
    assert.equal(await handoff(dir), `{"key":"${MOCK_KEY}"}`, "the whole file, as the Unreal plugin parses it");
    await namePractice(dir, LIVE_KEY);
    assert.equal(await handoff(dir), `{"key":"${LIVE_KEY}"}`);
    await unnamePractice(dir, MOCK_KEY);
    assert.equal(await handoff(dir), `{"key":"${LIVE_KEY}"}`, "a helper that is not named there removes nothing");
    await unnamePractice(dir, LIVE_KEY);
    assert.equal(await handoff(dir), null);
    await unnamePractice(dir, LIVE_KEY);
  });

  it("writes nothing for what is not a key", async () => {
    const bad = [
      "",
      `genex_llm_practice=${MOCK_KEY}`,
      `041000.${HEX}`,
      `80.${HEX}`,
      `41000.${HEX.toUpperCase()}`,
      `41000.${HEX}","x":"`,
      `../${MOCK_KEY}`,
    ];
    for (const key of bad) {
      const dir = await gameFolder();
      await assert.rejects(namePractice(dir, key), `${JSON.stringify(key)} is refused`);
      assert.deepEqual(await readdir(dir), ["studio.json"], `${JSON.stringify(key)}: nothing is made`);
    }
  });

  it("writes nothing in a folder that holds no studio.json of its own", async () => {
    const outside = await gameFolder();
    const cases: Array<[string, (dir: string) => Promise<void>]> = [
      ["no studio.json", async () => {}],
      ["studio.json is a folder", (dir) => mkdir(path.join(dir, "studio.json"))],
      ["studio.json is a link", (dir) => symlink(path.join(outside, "studio.json"), path.join(dir, "studio.json"))],
    ];
    for (const [name, arrange] of cases) {
      const dir = await tmpDir("studio-practice-nogame-");
      await arrange(dir);
      const before = await readdir(dir);
      await assert.rejects(namePractice(dir, MOCK_KEY), name);
      assert.deepEqual(await readdir(dir), before, `${name}: nothing is made`);
    }
  });

  it("never writes or removes through a link, and leaves what the link reaches alone", async () => {
    const cases: Array<[string, (dir: string, outside: string) => Promise<void>]> = [
      ["the .studio folder is a link", (dir, outside) => symlink(outside, path.join(dir, ".studio"))],
      [
        "llm-practice.json is a link",
        async (dir, outside) => {
          await mkdir(path.join(dir, ".studio"));
          await symlink(path.join(outside, "llm-practice.json"), path.join(dir, HANDOFF));
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const dir = await gameFolder();
      const outside = await tmpDir("studio-practice-outside-");
      const theirs = `{"key":"${MOCK_KEY}"}`;
      await writeFile(path.join(outside, "llm-practice.json"), theirs);
      await arrange(dir, outside);
      await assert.rejects(namePractice(dir, LIVE_KEY), name);
      await unnamePractice(dir, MOCK_KEY);
      assert.deepEqual(await readdir(outside), ["llm-practice.json"], `${name}: nothing new outside`);
      assert.equal(await readFile(path.join(outside, "llm-practice.json"), "utf8"), theirs, `${name}: untouched`);
    }
  });
});

/** Live's own page, as the editor's practice sees it: the game it runs with a key, and its Stop. */
function livePage() {
  const page = {
    game: null as string | null,
    stops: 0,
    keyed: () => page.game,
    stop: async () => {
      page.stops += 1;
      page.game = null;
    },
  };
  return page;
}

/**
 * The service on scripted helpers and the editor's practice on it, composed as the core composes
 * them: a change of helper reloads Live's page (recorded) and renames the editor's.
 */
async function studio(options: { calls?: (dir: string) => boolean; mockExitsAfterMs?: number } = {}) {
  const scratch = await tmpDir("studio-practice-run-");
  const games = new Map<string, string>();
  const page = livePage();
  const logs: string[] = [];
  const pids: number[] = [];
  const reloads: string[] = [];
  const queue = new Map<string, Promise<unknown>>();
  let launches = 0;
  const mock = program({ first: listening(41000, "mock") });
  const dying = `${mock}setTimeout(()=>process.exit(3),${options.mockExitsAfterMs ?? 0});`;
  const ai = new PreviewAiService(
    {
      launch: async (_project, live, host) => {
        launches += 1;
        // Only the first practice helper dies on its own: the one started in its place stays.
        const first = options.mockExitsAfterMs !== undefined && launches === 1;
        const practice = first ? dying : mock;
        const paid = live ? program({ first: listening(41001, "live") }) : practice;
        return {
          command: host ? hostProgram([]) : paid,
          cwd: scratch,
          env: {},
          label: "test",
          policy: { allowedDomains: [], allowWrite: [], denyWrite: [] },
          root: `${scratch}/run-${launches}`,
        } satisfies PracticeLaunch;
      },
      spawn: async (request) => {
        const child = spawn(process.execPath, ["-e", request.command], { stdio: ["pipe", "pipe", "pipe"] });
        if (child.pid) pids.push(child.pid);
        return { child, input: child.stdin };
      },
      plans: async () => [PLAN],
      planModels: async () => [{ id: "codex/gpt", label: "GPT", vendor: "openai" }],
      answer: async (_engine, ask) => ({ id: ask.id, text: "said on the person's plan" }),
      signedIn: async () => true,
      hasDraft: async () => true,
      host: async () => GenexHosting.Hosted,
      liveAllowed: () => true,
      emit: (state) => editor.heard(state),
      reloadLive: async (project) => {
        reloads.push(project);
        await editor.rekey(project);
      },
      stopGraceMs: 2000,
    },
    LIVE,
  );
  const editor: EditorPractice = new EditorPractice({
    ai: {
      keyFor: (project) => ai.keyFor(LIVE, project),
      noModels: (project) => ai.noModels(LIVE, project),
      release: () => ai.release(LIVE),
    },
    gameDir: (project) => games.get(project) ?? path.join(scratch, "missing", project),
    callsModels: async (dir) => options.calls?.(dir) ?? true,
    page,
    serial: (op) => serial(queue, LIVE, op),
    log: (line) => logs.push(line),
  });
  const add = async (project: string) => {
    const dir = await gameFolder();
    games.set(project, dir);
    return dir;
  };
  return { ai, editor, page, logs, pids, reloads, add };
}

describe("Live's helper named to the Unreal editor", () => {
  it("names the practice helper while Live shows the game's Unreal card, and removes it when Live leaves", async () => {
    const { ai, editor, pids, add } = await studio();
    try {
      const inn = await add("inn");
      await editor.show("inn");
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Practice, "Live's bar speaks for the editor's play");
      assert.equal(ai.runningPids().length, 1);
      await editor.show("inn");
      assert.equal(ai.runningPids().length, 1, "shown again, the same helper");
      await editor.leave("inn");
      assert.equal(await handoff(inn), null);
      assert.deepEqual(ai.runningPids(), []);
      for (const pid of pids) assert.equal(running(pid), false, `helper ${pid} is gone`);
    } finally {
      await ai.stopAll();
    }
  });

  it("names the helper that answers now after the person changes it in Live's bar", async () => {
    const { ai, editor, reloads, add } = await studio();
    try {
      const inn = await add("inn");
      await editor.show("inn");
      await ai.startRealModels("inn", 100);
      assert.equal(await handoff(inn), `{"key":"${LIVE_KEY}"}`, "real models, for the cap the person approved");
      assert.equal(ai.state("inn").mode, PreviewAiMode.Live);
      await ai.backToPractice("inn");
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`);
      assert.deepEqual(reloads, ["inn", "inn"]);
      await ai.startRealModels("quiet", 100);
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`, "another game's choice changes nothing here");
    } finally {
      await ai.stopAll();
    }
  });

  it("names the helper the person's own plan answers through, and practice again after Stop", async () => {
    const { ai, editor, add } = await studio();
    try {
      const inn = await add("inn");
      await editor.show("inn");
      await ai.startPlan("inn", PLAN.engine);
      assert.equal(await handoff(inn), `{"key":"${PLAN_KEY}"}`, "the next Play in Unreal is answered on the plan");
      assert.deepEqual([ai.state("inn").mode, ai.state("inn").plan], [PreviewAiMode.Plan, PLAN]);
      await ai.backToPractice("inn");
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`);
    } finally {
      await ai.stopAll();
    }
  });

  it("moves with Live to the next Unreal game", async () => {
    const { ai, editor, add } = await studio();
    try {
      const inn = await add("inn");
      const mill = await add("mill");
      await editor.show("inn");
      await editor.show("mill");
      assert.equal(await handoff(inn), null, "the game Live left is named no helper");
      assert.equal(await handoff(mill), `{"key":"${MOCK_KEY}"}`);
      assert.equal(ai.runningPids().length, 1, "only the shown game's helper runs");
      await editor.leave("inn");
      assert.equal(await handoff(mill), `{"key":"${MOCK_KEY}"}`, "a late goodbye from the last game removes nothing");
    } finally {
      await ai.stopAll();
    }
  });

  it("gives a game whose Unreal project calls no model no file and no bar", async () => {
    let calls = true;
    const { ai, editor, add } = await studio({ calls: () => calls });
    try {
      const inn = await add("inn");
      await editor.show("inn");
      calls = false;
      await editor.show("inn");
      assert.equal(await handoff(inn), null);
      assert.equal(ai.state("inn").mode, PreviewAiMode.None);
      assert.deepEqual(ai.runningPids(), []);
      assert.deepEqual(await readdir(path.join(inn, ".studio")), [], "nothing is left in the game's .studio");
    } finally {
      await ai.stopAll();
    }
  });

  it("removes the file when Live stops and when the app quits", async () => {
    const { ai, editor, add } = await studio();
    const inn = await add("inn");
    await editor.show("inn");
    await ai.release(LIVE);
    await editor.liveStopped();
    assert.equal(await handoff(inn), null, "Live stopped");
    await editor.show("inn");
    assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`);
    await ai.stopAll();
    await editor.stopAll();
    assert.equal(await handoff(inn), null, "the app quit");
    await editor.show("inn");
    assert.equal(await handoff(inn), null, "nothing is named once the helpers are stopped for good");
  });

  it("asks for a new helper when the named one stops on its own", async () => {
    const { ai, editor, pids, add } = await studio({ mockExitsAfterMs: 300 });
    try {
      const inn = await add("inn");
      await editor.show("inn");
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`);
      const first = pids[0] ?? 0;
      for (let waited = 0; waited < 5000 && (running(first) || pids.length < 2); waited += 20) await sleep(20);
      await editor.idle();
      assert.equal(running(first), false, "the first helper ended");
      assert.equal(ai.runningPids().length, 1, "another answers in its place");
      assert.equal(await handoff(inn), `{"key":"${MOCK_KEY}"}`, "and the handoff names it");
    } finally {
      await ai.stopAll();
    }
  });

  it("stops Live's page of another game that ran with a key, and leaves a page that has none alone", async () => {
    const { ai, editor, page, add } = await studio();
    try {
      await add("inn");
      await ai.keyFor(LIVE, "web");
      page.game = "web";
      await editor.show("inn");
      assert.equal(page.stops, 1, "the page's helper went to the Unreal game: it stops as Stop stops it");
      await editor.leave("inn");
      await editor.show("inn");
      assert.equal(page.stops, 1, "a page with no key is not stopped");
    } finally {
      await ai.stopAll();
    }
  });

  it("keeps the helper Live's page of the same game runs with, and follows the page", async () => {
    const { ai, editor, page, add } = await studio();
    try {
      const inn = await add("inn");
      const mill = await add("mill");
      await ai.keyFor(LIVE, "inn");
      page.game = "inn";
      await editor.show("inn");
      assert.equal(page.stops, 0);
      await editor.leave("inn");
      assert.equal(await handoff(inn), null);
      assert.equal(ai.runningPids().length, 1, "the page still runs with it");
      await editor.show("inn");
      await ai.noModels(LIVE, "inn");
      await editor.pageAsked("inn");
      assert.equal(
        await handoff(inn),
        `{"key":"${MOCK_KEY}"}`,
        "the page let go; the editor's play is named a helper again",
      );
      await editor.show("mill");
      assert.equal(page.game, null, "the page of the other game stopped");
      await ai.noModels(LIVE, "web");
      await editor.pageAsked("web");
      assert.equal(await handoff(mill), `{"key":"${MOCK_KEY}"}`, "a page that needs no helper leaves the editor's");
      assert.equal(ai.runningPids().length, 1);
      await ai.keyFor(LIVE, "inn");
      page.game = "inn";
      await editor.pageAsked("inn");
      assert.equal(await handoff(mill), null, "Live's page took the helper for another game");
    } finally {
      await ai.stopAll();
    }
  });

  it("with a calls-nothing Unreal game shown, leaves the helper Live's page runs with", async () => {
    const { ai, editor, page, add } = await studio({ calls: () => false });
    try {
      await add("mill");
      await ai.keyFor(LIVE, "web");
      page.game = "web";
      await editor.show("mill");
      assert.equal(ai.runningPids().length, 1);
      assert.equal(page.stops, 0);
    } finally {
      await ai.stopAll();
    }
  });

  it("logs, and throws nothing, when the game's folder takes no handoff", async () => {
    const { ai, editor, logs, add } = await studio();
    try {
      const inn = await add("inn");
      const outside = await tmpDir("studio-practice-outside-");
      await symlink(outside, path.join(inn, ".studio"));
      await editor.show("inn");
      assert.deepEqual(await readdir(outside), [], "nothing is written through the link");
      assert.equal(logs.length, 1);
      assert.equal(ai.state("inn").mode, PreviewAiMode.Practice, "the bar still says what answers");
      await editor.leave("inn");
      assert.equal((await lstat(path.join(inn, ".studio"))).isSymbolicLink(), true);
    } finally {
      await ai.stopAll();
    }
  });
});
