/**
 * Self-improvement is stopped: a fresh install starts with learning off, an install from before
 * the stop is switched off once, and while it is off the harness cannot change its own code,
 * prompts or skills (`guardian.write_self`). Someone who turns it back on keeps that choice.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { coreLite } from "../helpers/core-lite.ts";

type WriteSelf = (params: unknown) => Promise<{ ok: boolean; stage?: string; message?: string }>;

const PROMPT = "prompts/operating-rules.md";

function writeSelf(api: unknown): WriteSelf {
  return (api as Record<string, WriteSelf>)["guardian.write_self"]!;
}

function selfEdits(events: Awaited<ReturnType<import("../../src/main/studio-core.ts").StudioCore["listAllEvents"]>>) {
  return events.filter((event) => event.data.type === "custom" && event.data.event_type === "self_edit");
}

describe("self-improvement is stopped", () => {
  it("a fresh install starts with learning off, and the harness is told so", async () => {
    const lite = await coreLite();
    assert.equal(lite.core.settings.learning, false);
    assert.equal(await lite.api()["learning.enabled"]!({} as never), false);
  });

  it("an install saved before the stop is switched off once; turning it back on is kept", async () => {
    const lite = await coreLite({ init: false });
    const settings = path.join(lite.userData, "settings.json");
    await mkdir(lite.userData, { recursive: true });
    await writeFile(settings, JSON.stringify({ learning: true, buildersMax: 4, buildersDefault: 4 }));
    await lite.core.init();
    assert.equal(lite.core.settings.learning, false, "an older install's learning is stopped");

    await lite.core.updateSettings({ learning: true });
    await lite.core.stop();
    await lite.core.init();
    assert.equal(lite.core.settings.learning, true, "a choice made after the stop survives a relaunch");
  });

  it("with learning off the harness cannot write its own files, and nothing is recorded", async () => {
    const lite = await coreLite();
    const file = path.join(lite.core.layout.harnessWs, PROMPT);
    const before = await readFile(file, "utf8");
    const result = await writeSelf(lite.api())({ file: PROMPT, contents: "Rewritten.\n", reason: "test" });
    assert.equal(result.ok, false);
    assert.equal(result.stage, "refused");
    assert.match(result.message ?? "", /self-improvement is off/i);
    assert.equal(await readFile(file, "utf8"), before, "the prompt is unchanged");
    assert.equal(selfEdits(await lite.core.listAllEvents()).length, 0, "no self-change is recorded");
  });

  it("with learning on the same write lands", async () => {
    const lite = await coreLite();
    await lite.core.updateSettings({ learning: true });
    const result = await writeSelf(lite.api())({ file: PROMPT, contents: "Rewritten.\n", reason: "test" });
    assert.equal(result.ok, true, result.message);
    assert.equal(await readFile(path.join(lite.core.layout.harnessWs, PROMPT), "utf8"), "Rewritten.\n");
  });
});
