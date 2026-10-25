/**
 * Play latest's build copy (lane PW): a Play of a commit plays the copy an earlier Play (or the
 * background prebuild) made of it, so its build folder and admitted output are found again, instead
 * of a new worktree and a new build folder per click. A copy that is no longer that commit's clean
 * checkout is never played again: the next Play makes a fresh one beside it. Over the lite core with
 * recording Live and hidden windows: nothing builds a compiled game here.
 */
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LiveUpdateKind } from "../../src/shared/live-behind.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A window that records what it served and reports a booted page. */
function recordingWindow() {
  const loads: Array<{ project: string; root: string | null }> = [];
  const window = {
    loads,
    /** While set, a load waits for it; `fail` makes the next load throw. */
    hold: null as Promise<void> | null,
    fail: false,
    async load(project: string, entry: string, root?: string) {
      if (window.hold) await window.hold;
      if (window.fail) throw new Error("the page did not load");
      loads.push({ project, root: root ?? null });
      return `game://${project}/${entry}`;
    },
    async reload() {},
    status: () => ({ project: loads.at(-1)?.project ?? null, loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    async dispose() {},
  };
  return window;
}

/** A game open in Live and a commit of it ahead of the game folder, as a run's integration makes one. */
async function stage() {
  const live = recordingWindow();
  const lite = await coreLite({
    preview: live as never,
    gamesRoot: await realpath(await tmpDir("studio-play-copy-")),
    previewPoolMax: 2,
    createHeadlessPreview: async () => recordingWindow() as never,
  });
  const game = await lite.core.games.scaffold("pond");
  await lite.core.loadPreview({ project: "pond" });
  const worktree = path.join(lite.core.layout.scratch, "autopilot", "run_x", "integration");
  await gitFile(["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: game.dir });
  await writeFile(path.join(worktree, "pond.js"), "export const pond = 'still';\n");
  await gitFile(["add", "-A"], { cwd: worktree });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pond"], { cwd: worktree });
  const head = (await gitFile(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
  const worktrees = async () =>
    (await gitFile(["worktree", "list", "--porcelain"], { cwd: game.dir })).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
  return { lite, live, head, worktrees };
}

describe("Play latest's build copy", () => {
  it("a second Play of the same commit plays the copy the first made, and makes none", async (t) => {
    const { lite, live, head, worktrees } = await stage();
    t.after(() => lite.close());
    const first = await lite.core.showBuild("pond", head);
    const copies = (await worktrees()).length;
    const second = await lite.core.showBuild("pond", head);
    assert.equal(second.dir, first.dir);
    assert.equal((await worktrees()).length, copies, "no new worktree");
    assert.equal(live.loads.at(-1)?.root, first.dir);
  });

  const SPOILED = [
    {
      name: "an edited file",
      spoil: (copy: string) => writeFile(path.join(copy, "pond.js"), "export const pond = 'rippled';\n"),
    },
    { name: "an untracked file", spoil: (copy: string) => writeFile(path.join(copy, "stone.js"), "export {};\n") },
  ] as const;
  for (const row of SPOILED) {
    it(`a copy with ${row.name} is not played again: the next Play makes a fresh copy and leaves it be`, async (t) => {
      const { lite, live, head } = await stage();
      t.after(() => lite.close());
      const first = await lite.core.showBuild("pond", head);
      await row.spoil(first.dir);
      const second = await lite.core.showBuild("pond", head);
      assert.notEqual(second.dir, first.dir);
      assert.equal(live.loads.at(-1)?.root, second.dir);
      assert.equal(
        (await gitFile(["status", "--porcelain"], { cwd: first.dir })).stdout.trim().length > 0,
        true,
        "the spoiled copy is left as it was",
      );
    });
  }
});

describe("Live while Play makes its build ready", () => {
  it("says it is opening that build while Play runs, and nothing once Live has it", async (t) => {
    const { lite, live, head } = await stage();
    t.after(() => lite.close());
    let open = () => {};
    live.hold = new Promise<void>((resolve) => {
      open = resolve;
    });
    const playing = lite.core.showBuild("pond", head);
    await sleep(300);
    const during = lite.core.liveState("pond").updating;
    assert.equal(during?.kind, LiveUpdateKind.Play);
    assert.equal(during?.commit, head);
    assert.ok(typeof during?.since === "number");
    live.hold = null;
    open();
    await playing;
    assert.equal(lite.core.liveState("pond").updating ?? null, null);
  });

  it("says nothing more once a Play failed", async (t) => {
    const { lite, live, head } = await stage();
    t.after(() => lite.close());
    live.fail = true;
    await assert.rejects(lite.core.showBuild("pond", head));
    assert.equal(lite.core.liveState("pond").updating ?? null, null);
  });
});
