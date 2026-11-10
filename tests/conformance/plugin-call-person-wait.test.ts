/**
 * `genex__publish` asks twice: its own card before the call, then, inside the call, the file list
 * the export will upload. The call's local wait (190 seconds) kept running while that second card
 * was on screen, so a person who read the list for a few minutes got `Stopped local plugin wait;
 * accepted remote jobs may continue. Do not repeat unresolved creation.` and a publish job left at
 * "exporting", unsure whether a hosted project had been made.
 *
 * Now a host request that waits on the person (`invocation.personAnswers`) stands the call's own
 * deadline still while the card is up: the time before and after it still counts, so plugin work
 * is held to the same limit, and the card itself keeps its own limit and closes with the call.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { PluginBinding } from "../../src/shared/plugins.ts";
import { UiEvent, type UiEventMap } from "../../src/shared/ui-events.ts";
import { type PersonWait, type PluginInvocation, PluginProcess } from "../../src/substrate/plugins/process.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BOOTSTRAP = path.resolve("src/plugin-sdk/backend.mjs");
/** The call's own time in these tests. */
const CALL_MS = 1500;
/** A person who reads the card for longer than the call's whole time. */
const READS_MS = 2 * CALL_MS;
/** Plugin work on either side of the card that, together, outlasts the call's time. */
const WORK_MS = 0.6 * CALL_MS;
const STOPPED = /Stopped local plugin wait/;
/** How long a test waits for the host's file-list card; a card nobody expected declines then. */
const ASK_WAIT_MS = 5000;
const ASK_POLL_MS = 20;
type Consent = UiEventMap[typeof UiEvent.PluginConsent];

/** A backend whose one tool asks the host `ask` once and answers what the host said. */
async function askingBackend(): Promise<string> {
  const entry = path.join(await tmpDir("studio-person-wait-"), "backend.mjs");
  await writeFile(
    entry,
    [
      "export const activate = () => ({",
      '  tool: async (_name, _args, context) => ({ answer: await context.host("ask", {}) }),',
      "});",
    ].join("\n"),
  );
  return entry;
}

/** Runs one call whose host request is `service`, and answers how it ended. */
async function callWith(service: (invocation: PluginInvocation) => Promise<unknown>) {
  const backend = new PluginProcess(
    BOOTSTRAP,
    await askingBackend(),
    (_method, _args, _context, invocation) => service(invocation),
    () => {},
  );
  // The backend starts on its first call: started first, so its start is not the call's time.
  await backend.call("ping", "", {}).catch(() => {});
  try {
    return await backend.call("tool", "publish", {}, undefined, undefined, CALL_MS);
  } finally {
    backend.stop();
  }
}

describe("a plugin call's deadline while the person answers its card", () => {
  it("stands still while the card is up: a person reading longer than the call's time still gets the call's answer", async () => {
    const result = await callWith((invocation) => invocation.personAnswers(() => sleep(READS_MS, "approved")));
    assert.deepEqual(result, { answer: "approved" });
  });

  it("still ends plugin work past the call's time: the same wait with no card stops as before", async () => {
    await assert.rejects(
      callWith(() => sleep(READS_MS, "worked")),
      STOPPED,
    );
  });

  it("counts the time before and after the card: work on both sides that outlasts the call's time still stops it", async () => {
    const service = async (invocation: PluginInvocation) => {
      await sleep(WORK_MS);
      const answer = await invocation.personAnswers(() => sleep(READS_MS / 4, "approved"));
      await sleep(WORK_MS);
      return answer;
    };
    await assert.rejects(callWith(service), STOPPED);
  });
});

/** A real core with one web game, and Genex's export of it as a plugin call makes it. */
async function exportRig() {
  const consents: Consent[] = [];
  const lite = await coreLite({
    consentTimeoutMs: ASK_WAIT_MS,
    onUiEvent: (event) => {
      if (event.type === UiEvent.PluginConsent) consents.push(event.payload as Consent);
    },
  });
  const game = await lite.core.games.scaffold("arena");
  await writeFile(path.join(game.dir, "index.html"), "<!DOCTYPE html><title>Arena</title><h1>Playable</h1>");
  const binding: PluginBinding = { project: "arena", directory: game.dir };
  const waits = { held: 0, released: 0 };
  /** The call's person wait, counted: what the process does, without its clock. */
  const personAnswers: PersonWait = async (answer) => {
    waits.held++;
    try {
      return await answer();
    } finally {
      waits.released++;
    }
  };
  const stage = (signal: AbortSignal) => {
    const exportStage = lite.core.pluginServices.exportStage;
    assert.ok(exportStage);
    return exportStage(binding, path.join(lite.userData, "stage"), "genex", { signal, personAnswers });
  };
  const asked = async (): Promise<Consent> => {
    for (let waited = 0; waited < ASK_WAIT_MS && !consents.some((c) => c.state === "pending"); waited += ASK_POLL_MS)
      await sleep(ASK_POLL_MS);
    const pending = consents.find((c) => c.state === "pending");
    assert.ok(pending, "a card asked about the files");
    return pending;
  };
  return { ...lite, waits, stage, asked };
}

describe("the export's file-list card inside a plugin call", () => {
  it("is the person's time: the call's deadline stands still from the card's showing to its answer", async () => {
    const rig = await exportRig();
    try {
      const staged = rig.stage(new AbortController().signal);
      const card = await rig.asked();
      assert.deepEqual(rig.waits, { held: 1, released: 0 }, "held while the card is up");
      rig.core.resolveConsent(card.consentId, true);
      const result = await staged;
      assert.ok(result.included.includes("index.html"), "the approved copy reaches the plugin");
      assert.deepEqual(rig.waits, { held: 1, released: 1 }, "and the call's time runs again");
    } finally {
      await rig.close();
    }
  });

  it("closes when its call ends, so no publish goes ahead on an answer nobody waits for", async () => {
    const rig = await exportRig();
    try {
      const call = new AbortController();
      const staged = rig.stage(call.signal);
      void staged.catch(() => {});
      await rig.asked();
      call.abort();
      await assert.rejects(staged, /declined/);
      assert.deepEqual(rig.waits, { held: 1, released: 1 });
    } finally {
      await rig.close();
    }
  });
});
