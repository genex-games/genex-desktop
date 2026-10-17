/**
 * Any plugin's call that makes an asset is one of its game's waiting jobs while it runs. A tool says
 * what its calls make (`tools[].asset`); the host stamps that on the call's own record and lists
 * the call in the game's Assets inventory (`ProjectAssets.jobs`) from the moment it goes out until
 * it answers, announcing each change (`asset.jobs`). A call of a tool that says nothing is no job,
 * and a call the app never saw end is never shown as still being made (memory only).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, it } from "node:test";
import { CALL_PROMPT_MAX, MakingKind, MakingPhase, type MakingJob } from "../../src/shared/asset-making.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { personAllowsLocalTools } from "../helpers/plugins.ts";

const PROJECT = "forge-game";
const PLUGIN = "sprite-forge";

let lite: CoreLite;
let threadId: string;
let folder: string;
const announced: string[] = [];

/** A plugin whose `paint` makes an image and holds until its release file exists; `ping` makes nothing. */
const MANIFEST = {
  apiVersion: 3,
  id: PLUGIN,
  version: "1.0.0",
  name: "Sprite Forge",
  publisher: "Studio tests",
  description: "Paints sprites for a test.",
  backend: "backend.mjs",
  capabilities: [],
  skills: [],
  panels: [],
  settings: [],
  actions: [],
  tools: [
    {
      name: "paint",
      description: "Paint a sprite.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" }, release: { type: "string" } },
        required: ["prompt", "release"],
      },
      asset: { kind: "image", tool: "Pixel Lab" },
    },
    { name: "ping", description: "Answer.", parameters: { type: "object", properties: {} } },
  ],
};
const BACKEND = `
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
export async function activate() {
  return {
    async tool(name, args) {
      if (name === "ping") return { pong: true };
      if (args.prompt === "fail") throw new Error("The forge is cold.");
      for (let tries = 0; tries < 500 && !existsSync(args.release); tries++) await sleep(20);
      return { painted: true };
    },
    async action() { return {}; },
  };
}
`;

before(async () => {
  lite = await coreLite({
    onUiEvent: (event) => void (event.type === UiEvent.AssetJobs && announced.push(event.payload.project)),
  });
  await lite.core.games.scaffold(PROJECT);
  threadId = await lite.core.createGameThread(PROJECT);
  folder = path.join(lite.userData, "forge-plugin");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "plugin.json"), JSON.stringify(MANIFEST));
  await writeFile(path.join(folder, "backend.mjs"), BACKEND);
  await lite.core.plugins.installLocal(folder, PluginSourceKind.Local);
  await lite.core.plugins.setEnabled(PLUGIN, true);
  personAllowsLocalTools(lite.core.plugins);
});

after(async () => {
  lite.core.plugins.cancel();
  await lite.core.mcp.close().catch(() => {});
  await lite.close();
});

/** The harness's `plugins.invoke` for an agent's call. */
function invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const call = api["plugins.invoke"];
  assert.ok(call);
  return call({ project: PROJECT, threadId, name, args });
}

const waiting = async (): Promise<MakingJob[]> =>
  ((await lite.core.projectAssets(PROJECT)).jobs ?? []).filter((job) => job.source === PLUGIN);

/** Read the inventory until `done` holds of it, or give up after a bounded number of reads. */
async function inventoryUntil(done: (jobs: MakingJob[]) => boolean): Promise<MakingJob[]> {
  for (let reads = 0; reads < 200; reads++) {
    const jobs = await waiting();
    if (done(jobs)) return jobs;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return waiting();
}

async function startedRecords(): Promise<Array<Record<string, unknown>>> {
  const events: EventEnvelope[] = await lite.core.store.listEvents(threadId);
  return events.flatMap((e) =>
    e.data.type === "custom" && e.data.event_type === CustomEvent.PluginToolStarted
      ? [e.data.payload as Record<string, unknown>]
      : [],
  );
}

it("lists a declared call as its game's waiting job while it runs, with what its record says it makes", async () => {
  const release = path.join(lite.userData, "release-1");
  const prompt = `A knight sprite ${"with a cape ".repeat(120)}`;
  announced.length = 0;
  const call = invoke(`${PLUGIN}__paint`, { prompt, release });
  const [job] = await inventoryUntil((jobs) => jobs.length > 0);
  assert.ok(job, "the call is a waiting job while it runs");
  const started = (await startedRecords()).at(-1);
  assert.deepEqual(started?.making, { kind: MakingKind.Image, tool: "Pixel Lab", prompt: job.prompt });
  assert.equal(job.jobId, started?.callId, "the job goes by the call's own id");
  assert.deepEqual(
    [job.kind, job.phase, job.tool, job.sourceName],
    [MakingKind.Image, MakingPhase.Making, "Pixel Lab", "Sprite Forge"],
  );
  assert.equal(job.prompt?.length, CALL_PROMPT_MAX, "a long prompt is kept to the cap");
  assert.ok(job.prompt?.endsWith("…"), "and says it was cut");
  assert.ok(announced.includes(PROJECT), "the change is announced as the call goes out");
  await writeFile(release, "");
  await call;
  assert.deepEqual(await waiting(), [], "an answered call is no longer waiting");
  assert.equal(announced.filter((project) => project === PROJECT).length, 2, "and its end is announced too");
});

it("gives a call of a tool that says nothing no job and no stamp", async () => {
  await invoke(`${PLUGIN}__ping`, {});
  assert.equal((await startedRecords()).at(-1)?.making, undefined);
  assert.deepEqual(await waiting(), []);
});

it("ends the job when the call fails as when it answers", async () => {
  const release = path.join(lite.userData, "never-written");
  const failed = await invoke(`${PLUGIN}__paint`, { prompt: "fail", release }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.match(String(failed), /The forge is cold/);
  assert.equal((await startedRecords()).at(-1)?.making !== undefined, true, "the failed call was one making an asset");
  assert.deepEqual(await waiting(), [], "a failed call leaves no job behind");
});
