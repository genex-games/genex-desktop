/**
 * Self-edit recovery that actually recovers (PROD-1, PH-5, ARCH-6).
 *
 * A harness that cannot boot must be rewound by the host without a human: at a cold start (the
 * app used to show an error box and exit before the watchdog ran), after a broken loop edit is
 * restarted into, and when the rewind itself fails (the shipped seed is the last resort).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { coreLite } from "../helpers/core-lite.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;
const BROKEN = "throw new Error('I broke myself');\n";

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function lite() {
  const events: Array<{ type: string; payload: unknown }> = [];
  const made = await coreLite({ onUiEvent: (event) => events.push(event) });
  const main = path.join(made.core.layout.harnessWs, "loop", "main.ts");
  const shipped = await readFile(path.join(made.resources, "harness-seed", "loop", "main.ts"), "utf8");
  return { ...made, events, main, shipped, api: made.api() as unknown as Api };
}

describe("self-edit recovery", () => {
  it("a cold start into a harness that cannot boot rewinds to the healthy snapshot and starts", async () => {
    const { core, main, shipped, close } = await lite();
    const good = await core.snapshot("harness", "known good", undefined, true);
    // A self-edit written but never restarted into before the app quit.
    await writeFile(main, BROKEN);

    await core.start();
    assert.equal(core.host.state, "ready", "the studio opens");
    assert.equal(await readFile(main, "utf8"), shipped, "the broken edit was rewound");
    const restored = (await core.listAllEvents()).filter((event) => event.data.type === "workspace_restored");
    assert.equal((restored.at(-1)?.data as { snapshot_id?: string } | undefined)?.snapshot_id, good.snapshot_id);
    await close();
  });

  it("a broken loop edit that is restarted into rewinds past its own after-snapshot", async () => {
    const { core, main, shipped, events, api, close } = await lite();
    await core.start();
    const good = await core.snapshot("harness", "booted and healthy", undefined, true);
    // What write_own_file does: before, write, after (asking for healthy), then restart_studio.
    await api["snapshot.create"]!({ scope: "harness", reason: "before self-edit: loop/main.ts" });
    await writeFile(main, BROKEN);
    await api["snapshot.create"]!({ scope: "harness", healthy: true, reason: "after self-change: loop/main.ts" });
    await core.requestSelfRestart("load my new loop", 0);

    await until(
      () => events.some((event) => event.type === "watchdog.recovered" || event.type === "watchdog.failed"),
      60_000,
      "the watchdog to act",
    );
    assert.equal(events.filter((event) => event.type === "watchdog.failed").length, 0, "the watchdog recovered");
    assert.equal(core.host.state, "ready");
    assert.equal((await core.journal.pending()).length, 0, "the update is settled");
    assert.equal(await readFile(main, "utf8"), shipped, "the watchdog rewound past the broken edit");
    assert.equal(await core.host.healthcheck(), true);
    // Straight to the last self that booted — not onto the broken edit's own after-snapshot,
    // and not saved only by the shipped-seed fallback.
    const log = await core.listAllEvents();
    const restored = log
      .filter((event) => event.data.type === "workspace_restored")
      .map((event) => (event.data as { snapshot_id?: string }).snapshot_id);
    assert.deepEqual(restored, [good.snapshot_id]);
    assert.equal(
      log.some((event) => event.data.type === "custom" && event.data.event_type === "harness_reseeded"),
      false,
    );
    await close();
  });

  it("code the harness wrote without a restart becomes healthy once a plain relaunch boots it, and later skill edits follow (R3)", async () => {
    const { core, api, close } = await lite();
    const ws = core.layout.harnessWs;
    await core.start();
    await core.snapshot("harness", "booted and healthy", undefined, true);
    // write_own_file on code that takes effect without restart_studio: before, write, after.
    await api["snapshot.create"]!({ scope: "harness", reason: "before self-edit: loop/helper.ts" });
    await writeFile(path.join(ws, "loop", "helper.ts"), "export const helper = () => 1;\n");
    const code = (await api["snapshot.create"]!({
      scope: "harness",
      healthy: true,
      reason: "after self-change: loop/helper.ts",
    })) as { snapshot_id: string };
    assert.equal(core.snapshotIndex.get(code.snapshot_id)?.healthy, false, "not yet: it has never booted");

    // The app quits and opens again: the self that boots and answers is the one with the code in it.
    await core.host.stop();
    await core.start();
    assert.equal(core.host.state, "ready");
    assert.equal(core.snapshotIndex.get(code.snapshot_id)?.healthy, true, "a booted self is a healthy self");

    // A later skill edit is measured against it, not held back by it.
    // The seed ships no skills folder now: the agent makes one for its own skill.
    await mkdir(path.join(ws, "skills"), { recursive: true });
    await writeFile(path.join(ws, "skills", "a-lesson.md"), "- Keep ownership explicit.\n");
    const skill = (await api["snapshot.create"]!({
      scope: "harness",
      healthy: true,
      reason: "after self-change: skills/a-lesson.md",
    })) as { snapshot_id: string };
    assert.equal(core.snapshotIndex.newestHealthy("harness")?.snapshot_id, skill.snapshot_id);
    await close();
  });

  it("a relaunch that also booted code no snapshot holds vouches for nothing (R3)", async () => {
    const { core, api, close } = await lite();
    const ws = core.layout.harnessWs;
    await core.start();
    const good = await core.snapshot("harness", "booted and healthy", undefined, true);
    await writeFile(path.join(ws, "loop", "helper.ts"), "export const helper = () => 1;\n");
    const code = (await api["snapshot.create"]!({
      scope: "harness",
      healthy: true,
      reason: "after self-change: loop/helper.ts",
    })) as { snapshot_id: string };
    // More code, written after the last snapshot: what boots is not what the snapshot holds.
    await writeFile(path.join(ws, "loop", "other.ts"), "export const other = () => 2;\n");
    await core.host.stop();
    await core.start();
    assert.equal(core.host.state, "ready");
    assert.equal(core.snapshotIndex.get(code.snapshot_id)?.healthy, false);
    assert.equal(core.snapshotIndex.newestHealthy("harness")?.snapshot_id, good.snapshot_id);
    await close();
  });

  it("the start-up dialog's reset boots the shipped self, and a pending self-update is not called applied", async () => {
    const { core, main, shipped, events, close } = await lite();
    await writeFile(main, BROKEN);
    const broken = await core.snapshot("harness", "self-update: my new loop", undefined, false);
    await core.journal.queue("load my new loop", broken.snapshot_id);

    await core.start("cold_start", { resetHarness: true });
    assert.equal(core.host.state, "ready");
    assert.equal(await readFile(main, "utf8"), shipped);
    assert.equal(
      events.some((event) => event.type === "watchdog.triggered"),
      false,
      "the shipped self booted first time; nothing had to be rewound",
    );
    assert.equal((await core.journal.pending()).length, 0, "the update is settled");
    assert.equal(
      core.snapshotIndex.get(broken.snapshot_id)?.healthy,
      false,
      "the update that never booted is not marked healthy",
    );
    await close();
  });

  it("when the rewind itself fails, the watchdog falls back to the shipped self and restarts", async () => {
    const { core, main, shipped, events, close } = await lite();
    const restarts: unknown[] = [];
    // No harness process in this case: the restart is recorded, and the new self answers.
    core.host.restart = (async (notice: unknown) => {
      restarts.push(notice);
    }) as never;
    core.host.healthcheck = (async () => true) as never;
    await core.snapshot("harness", "known good", undefined, true);
    await writeFile(main, BROKEN);
    // A git process killed mid-write leaves its lock behind: `git reset --hard` now fails.
    await writeFile(path.join(core.layout.harnessWs, ".git", "index.lock"), "");

    await core.recover("harness crashed 3× in a row");
    assert.equal(restarts.length, 1, "the harness is restarted, not left down");
    assert.equal(await readFile(main, "utf8"), shipped, "from the shipped seed");
    assert.ok(
      (await core.listAllEvents()).some(
        (event) => event.data.type === "custom" && event.data.event_type === "harness_reseeded",
      ),
    );
    assert.equal(events.filter((event) => event.type === "watchdog.failed").length, 0);
    assert.ok(events.some((event) => event.type === "watchdog.recovered"));
    await close();
  });
});
