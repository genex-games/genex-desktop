/**
 * A judged load whose build fails leaves the window on no page, so a capture refuses `build-failed`
 * instead of photographing an older build. These rows run a real core over the fake preview of the
 * studio rig, so they run serially (L3), apart from the pure capture-folder rows in build-preview.test.ts.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { latestBuildPreview } from "../../src/substrate/build-preview.ts";
import { CAPTURE_MANIFEST_VERSION, CaptureError, CaptureRefusal } from "../../src/shared/build-preview.ts";
import type { BuildOutcome } from "../../src/main/game-build.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { makeFakePreview } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A failed build of the game, as the build service reports one. */
function failedBuild(project: string): BuildOutcome {
  const problem = {
    project,
    command: "npm run build",
    code: 1,
    lines: ["src/main.ts(3,1): error TS1005: ';' expected."],
    needsInstall: false,
    install: null,
    showingLastBuild: false,
    at: new Date(0).toISOString(),
  };
  return { ok: false, output: null, lastGood: null, problem, ran: true };
}

/**
 * A pooled window that keeps "no page" as the real preview does: `clearPage` leaves it on none,
 * every capture then refuses `build-failed` until the next load.
 */
function noPageWindow() {
  const fake = makeFakePreview();
  const cleared: string[] = [];
  let noPage: string | null = null;
  const { load, screenshot } = fake;
  const withStats = fake.screenshotWithStats?.bind(fake);
  const refuseOnNoPage = () => {
    if (noPage !== null) throw new CaptureError(CaptureRefusal.BuildFailed, noPage);
  };
  fake.load = async (...args) => {
    noPage = null;
    return load(...args);
  };
  fake.clearPage = async (problem) => {
    cleared.push(problem);
    noPage = problem;
  };
  fake.screenshot = async (...args) => {
    refuseOnNoPage();
    return screenshot(...args);
  };
  if (withStats)
    fake.screenshotWithStats = async (...args) => {
      refuseOnNoPage();
      return withStats(...args);
    };
  return { fake, cleared };
}

/** A core whose pooled windows keep "no page"; without `headless`, Live is the only window a session gets. */
async function judgedRig(t: TestContext, { headless = true }: { headless?: boolean } = {}) {
  const windows: Array<ReturnType<typeof noPageWindow>> = [];
  const live = noPageWindow();
  const lite = await coreLite({
    preview: live.fake,
    ...(headless
      ? {
          createHeadlessPreview: async () => {
            const window = noPageWindow();
            windows.push(window);
            return window.fake;
          },
        }
      : {}),
  });
  const game = await lite.core.games.scaffold("pond", { title: "Pond" });
  const breakBuild = () => t.mock.method(lite.core.builds, "ensure", async () => failedBuild(game.name));
  return { ...lite, game, windows, live, breakBuild };
}

/** What a builder's capture tool is handed: its eyes, called as the build asks. */
type Capture = (args: { cameras?: string }) => Promise<string>;

/**
 * A builder that takes the captures `look` asks for, through a fake engine, on a self-capture of
 * the game folder for run `run_m`, part `river`, round 1.
 */
async function builderCaptures(rig: Awaited<ReturnType<typeof judgedRig>>, look: (capture: Capture) => Promise<void>) {
  const { core, api, game } = rig;
  core.engines.register({
    id: "fake",
    label: "fake",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request: { onCapture?: Capture }) => {
      const { onCapture } = request;
      assert.ok(onCapture, "a builder has eyes");
      await look(onCapture);
      return { ok: true, engine: "fake", turns: 1, usage: {}, summary: "done" };
    },
  } as never);
  const selfCapture = { project: game.name, root: game.dir, runId: "run_m", facetId: "river", iteration: 1 };
  await (api()["engine.delegate"] as (p: unknown) => Promise<unknown>)({
    engine: "fake",
    project: game.name,
    prompt: "build",
    selfCapture,
  });
  return path.join(core.layout.runs, "run_m", "facet_river", "self", "iter_001");
}

const listing = (dir: string) => readdir(dir).catch(() => [] as string[]);

test("a judged load whose build fails leaves the window on no page; a capture refuses build-failed and saves nothing", async (t) => {
  const { core, api, game, windows, breakBuild } = await judgedRig(t);
  const { handle } = await api()["preview.acquire"]({ label: "judge" });
  await api()["preview.load"]({ project: game.name, handle });
  const window = windows.at(-1);
  assert.ok(window, "the judge's window was made");
  assert.equal(window.fake.loads.length, 1, "the first build loaded");

  const broken = breakBuild();
  await api()["preview.load"]({ project: game.name, handle });
  assert.equal(window.fake.loads.length, 1, "nothing loaded over the old page");
  assert.equal(window.cleared.length, 1, "the window was left on no page");
  assert.match(window.cleared[0] ?? "", /expected/, "and says the build's own error");

  const runId = "run_judged";
  await assert.rejects(
    api()["preview.screenshot"]({ handle, runId, label: "judge_shot" }),
    (error: { refusal?: string }) => error.refusal === CaptureRefusal.BuildFailed,
    "a capture of no page is refused build-failed, never the older build",
  );
  assert.deepEqual(
    (await listing(path.join(core.layout.runs, runId))).filter((name) => name.startsWith("judge_shot")),
    [],
    "and nothing is saved for the run",
  );

  broken.mock.restore();
  await api()["preview.load"]({ project: game.name, handle });
  const shot = await api()["preview.screenshot"]({ handle });
  assert.ok(shot.bytes > 0, "a build that works again is photographed again");
});

test("a builder's capture saves a manifest beside each frame; a capture whose build fails saves a refusal and leaves no page", async (t) => {
  const rig = await judgedRig(t);
  const { core, game, windows, breakBuild } = rig;
  const answers: string[] = [];
  const dir = await builderCaptures(rig, async (capture) => {
    answers.push(await capture({ cameras: "default" }));
    const broken = breakBuild();
    answers.push(await capture({ cameras: "default" }));
    broken.mock.restore();
  });
  assert.match(answers[0] ?? "", /c1_default\.jpg/, answers[0]);
  assert.match(answers[1] ?? "", /build failed to load/, answers[1]);

  assert.deepEqual(
    (await listing(dir)).sort(),
    ["c1_default.jpg", "c1_default.manifest.json", "c2.refused.json"],
    "the failed capture saved no frame, only the record that it took none",
  );
  const head = (await git(game.dir, ["rev-parse", "HEAD"])).trim();
  const refusal: unknown = JSON.parse(await readFile(path.join(dir, "c2.refused.json"), "utf8"));
  assert.deepEqual(
    { ...(refusal as Record<string, unknown>), capturedAt: null },
    {
      version: CAPTURE_MANIFEST_VERSION,
      runId: "run_m",
      workerId: "river",
      call: 2,
      camera: "default",
      commit: head,
      edited: false,
      capturedAt: null,
      provenance: { seq: null, digest: null, camera: null, runId: null, build: null },
      refused: CaptureRefusal.BuildFailed,
    },
  );
  assert.equal(
    await latestBuildPreview(core.layout.runs, { runId: "run_m", facetId: "river", iteration: 1 }),
    null,
    "the newest capture is the failure: no older frame stands in for it",
  );
  assert.ok(
    windows.some((window) => window.cleared.length === 1),
    "the builder's window was left on no page",
  );
});

test("a web capture's manifest names the build it shows and the camera it placed", async (t) => {
  const rig = await judgedRig(t);
  const { core, game } = rig;
  await builderCaptures(rig, async (capture) => {
    await capture({ cameras: "default" });
  });
  const frame = await latestBuildPreview(core.layout.runs, { runId: "run_m", facetId: "river", iteration: 1 });
  assert.equal(path.basename(frame?.path ?? ""), "c1_default.jpg");
  const head = (await git(game.dir, ["rev-parse", "HEAD"])).trim();
  assert.deepEqual(
    { ...frame?.manifest, capturedAt: null },
    {
      version: CAPTURE_MANIFEST_VERSION,
      runId: "run_m",
      workerId: "river",
      call: 1,
      camera: "default",
      commit: head,
      edited: false,
      capturedAt: null,
      provenance: {
        seq: null,
        digest: null,
        camera: "default",
        runId: null,
        build: { stack: GameStack.ThreeJs, target: BuildTarget.Web, digest: null, lock: null },
      },
    },
  );
});

test("a builder looking through Live (no hidden windows) never blanks the stage when its build fails", async (t) => {
  const rig = await judgedRig(t, { headless: false });
  const { live, breakBuild } = rig;
  const answers: string[] = [];
  await builderCaptures(rig, async (capture) => {
    answers.push(await capture({ cameras: "default" }));
    const broken = breakBuild();
    answers.push(await capture({ cameras: "default" }));
    broken.mock.restore();
  });
  assert.match(answers[0] ?? "", /c1_default\.jpg/, "the builder looked through Live");
  assert.match(answers[1] ?? "", /build failed to load/, answers[1]);
  assert.deepEqual(live.cleared, [], "the person's stage keeps its page");
});

/**
 * The runs folder is writable by every sandboxed agent, and the host writes captures there. A
 * link planted on the way must never carry a host write outside the run's own folder.
 */
const HOSTILE_CAPTURE_FOLDERS = [
  { name: "the round's folder linked to a folder outside", link: ["run_m", "facet_river", "self", "iter_001"] },
  { name: "the part's folder linked to a folder outside", link: ["run_m", "facet_river"] },
  { name: "the run's folder linked to a folder outside", link: ["run_m"] },
];

for (const { name, link } of HOSTILE_CAPTURE_FOLDERS) {
  test(`a capture refuses a capture folder with a link on the way: ${name}`, async (t) => {
    const rig = await judgedRig(t);
    const outside = await tmpDir("studio-capture-outside-");
    const planted = path.join(rig.core.layout.runs, ...link);
    await mkdir(path.dirname(planted), { recursive: true });
    await symlink(outside, planted);
    const answers: string[] = [];
    // The delegation refuses to make its shots folder through the link, or the capture refuses it.
    const refused = await builderCaptures(rig, async (capture) => {
      answers.push(await capture({ cameras: "default" }));
    }).then(
      () => null,
      (error: Error) => error.message,
    );
    const said = refused ?? answers[0] ?? "";
    assert.match(said, refused ? /has a link or a file on its way/ : /capture refused/, said);
    assert.deepEqual(await readdir(outside, { recursive: true }), [], "nothing was written outside the runs folder");
  });
}

test("a capture replaces a link planted at its frame's or manifest's name, never writing through it", async (t) => {
  const rig = await judgedRig(t);
  const outside = await tmpDir("studio-capture-outside-");
  const victims = { frame: path.join(outside, "victim.jpg"), manifest: path.join(outside, "victim.json") };
  await writeFile(victims.frame, "keep me");
  await writeFile(victims.manifest, "keep me too");
  const dir = await builderCaptures(rig, async (capture) => {
    await capture({ cameras: "default" });
    // Between two captures, an agent plants the next frame's names.
    await symlink(
      victims.frame,
      path.join(rig.core.layout.runs, "run_m", "facet_river", "self", "iter_001", "c2_default.jpg"),
    );
    await symlink(
      victims.manifest,
      path.join(rig.core.layout.runs, "run_m", "facet_river", "self", "iter_001", "c2_default.manifest.json"),
    );
    await capture({ cameras: "default" });
  });
  assert.equal(await readFile(victims.frame, "utf8"), "keep me");
  assert.equal(await readFile(victims.manifest, "utf8"), "keep me too");
  for (const file of ["c2_default.jpg", "c2_default.manifest.json"]) {
    const info = await lstat(path.join(dir, file));
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${file} is the capture's own file`);
  }
});
