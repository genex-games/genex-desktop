import { test } from "node:test";
import assert from "node:assert/strict";
import { startRig, makeFakePreview } from "../helpers/studio-rig.ts";
import { gitFile } from "../helpers/git.ts";

/** The harness's `preview.acquire` and `preview.capacity`, as an agent calls them over RPC. */
function harnessPreview(core: { api(): unknown }) {
  const api = core.api() as Record<string, (input?: unknown) => Promise<unknown>>;
  return {
    acquire: (input: unknown = { label: "facet" }) => api["preview.acquire"]!(input) as Promise<{ handle: string }>,
    capacity: () => api["preview.capacity"]!() as Promise<{ inUse: number; max: number }>,
  };
}

/** Hidden windows that, once gated, wait for `open`; `asked` settles when a gated one is asked for. */
function gatedWindows() {
  let open!: () => void;
  let ask!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const asked = new Promise<void>((resolve) => {
    ask = resolve;
  });
  let gated = false;
  return {
    gate: () => {
      gated = true;
    },
    open: () => open(),
    asked,
    create: async () => {
      if (gated) {
        ask();
        await opened;
      }
      return makeFakePreview();
    },
  };
}

test("Play latest loads the copy into Live while agents hold every window of the pool", async () => {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
  );
  try {
    const project = await rig.core.games.scaffold("preview-full", { title: "Preview full" });
    await rig.core.loadPreview({ project: project.name });
    const head = (await gitFile(["rev-parse", "HEAD"], { cwd: project.dir })).stdout.trim();
    const harness = harnessPreview(rig.core);
    await harness.acquire();
    await harness.acquire();
    await assert.rejects(harness.acquire(), /pool exhausted \(2\/2 leased\)/, "the agents' share is full");
    const shown = await rig.core.showBuild(project.name, head);
    assert.equal(rig.preview.loadRoot, shown.dir, "Live plays the build copy");
    assert.equal((await harness.capacity()).inUse, 2, "the person's window is given back and took none of theirs");
    await assert.rejects(
      harness.acquire({ label: "preview-candidate:preview-full", by: "person" }),
      /pool exhausted \(2\/2 leased\)/,
      "the harness cannot ask for the person's window",
    );
  } finally {
    await rig.stop();
  }
});

test("a second Play while the person's window is open and the pool is full refuses without navigating Live", async () => {
  const windows = gatedWindows();
  const rig = await startRig({ replies: [] }, { previewPoolMax: 1, createHeadlessPreview: windows.create });
  try {
    const first = await rig.core.games.scaffold("preview-first", { title: "Preview first" });
    const second = await rig.core.games.scaffold("preview-second", { title: "Preview second" });
    await rig.core.loadPreview({ project: second.name });
    const headOf = async (dir: string) => (await gitFile(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    const [firstHead, secondHead] = [await headOf(first.dir), await headOf(second.dir)];
    await harnessPreview(rig.core).acquire();
    windows.gate();
    const playing = rig.core.showBuild(first.name, firstHead);
    await windows.asked;
    const loads = rig.preview.loads.length,
      root = rig.preview.loadRoot;
    await assert.rejects(rig.core.showBuild(second.name, secondHead), /pool exhausted/);
    assert.equal(rig.preview.loads.length, loads);
    assert.equal(rig.preview.loadRoot, root);
    windows.open();
    const shown = await playing;
    assert.equal(rig.preview.loadRoot, shown.dir, "the first Play still plays");
  } finally {
    await rig.stop();
  }
});

test("a candidate that fails to load preserves the current game without reloading it", async () => {
  const candidate = makeFakePreview();
  candidate.load = async () => {
    throw new Error("candidate runtime failed");
  };
  const rig = await startRig({ replies: [] }, { previewPoolMax: 1, createHeadlessPreview: async () => candidate });
  try {
    const project = await rig.core.games.scaffold("preview-failed", { title: "Preview failed" });
    // The person's own load: a harness `preview.load` reaches its stand-in, not Live.
    await rig.core.loadPreview({ project: project.name });
    const head = (await gitFile(["rev-parse", "HEAD"], { cwd: project.dir })).stdout.trim(),
      loads = rig.preview.loads.length;
    await assert.rejects(rig.core.showBuild(project.name, head), /candidate runtime failed/);
    assert.equal(rig.preview.loads.length, loads);
  } finally {
    await rig.stop();
  }
});
