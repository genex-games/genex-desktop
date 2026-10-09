/**
 * Live stays still while the person watches it: the game does not update on its own when code
 * changes, and only Reload is highlighted, with a changed tooltip. The harness looks through a stand-in window of its own; what it loads there,
 * a checkpoint or a rewind only marks Live behind (`live.behind`), and the person's Reload brings
 * it in. The live evidence: a run's lead showed its integration build in Live and then landed
 * it, and Live changed twice under the person without a click.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPreviewIpc } from "../../src/main/ipc/preview.ts";
import { coreLite, type CoreLite } from "../helpers/core-lite.ts";
import { gitFile } from "../helpers/git.ts";
import { makeFakePreview } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A preview port that records what it served and answers the ready probe as a settled page. */
function fakePort() {
  const port = {
    loads: [] as Array<{ project: string; root: string | null }>,
    reloads: 0,
    inputs: 0,
    disposed: false,
    /** The next load fails, as a page that never arrived does. */
    failNext: false,
    async load(project: string, entry: string, root?: string) {
      if (port.failNext) {
        port.failNext = false;
        throw new Error("the page did not load");
      }
      port.loads.push({ project, root: root ?? null });
      return `game://${project}/${entry}`;
    },
    async reload() {
      port.reloads++;
    },
    async input() {
      port.inputs++;
    },
    status: () => ({ project: port.loads.at(-1)?.project ?? null, loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
    async dispose() {
      port.disposed = true;
    },
  };
  return port;
}
type FakePort = ReturnType<typeof fakePort>;

interface Stage {
  lite: CoreLite;
  live: FakePort;
  hidden: FakePort[];
  behind: Array<{
    project: string;
    reason: string | null;
    commit: string | null;
    note: string | null;
    shows: string | null;
  }>;
  api: Record<string, (params?: unknown) => Promise<unknown>>;
  dir: string;
}

async function stage({ headless = true }: { headless?: boolean } = {}): Promise<Stage> {
  const live = fakePort();
  const hidden: FakePort[] = [];
  const behind: Stage["behind"] = [];
  const lite = await coreLite({
    preview: live as never,
    gamesRoot: await realpath(await tmpDir("studio-live-gate-")),
    previewPoolMax: 2,
    ...(headless
      ? {
          createHeadlessPreview: async () => {
            const port = fakePort();
            hidden.push(port);
            return port as never;
          },
        }
      : {}),
    onUiEvent: (event) => {
      if (event.type === "live.behind") behind.push(event.payload as Stage["behind"][number]);
    },
  });
  const project = await lite.core.games.scaffold("pong");
  const api = lite.api() as unknown as Stage["api"];
  // The person opens the game: the one load that is theirs.
  await lite.core.loadPreview({ project: "pong" });
  return { lite, live, hidden, behind, api, dir: project.dir };
}

/** Main's preview IPC over the lite core, as the Studio page calls it. */
function previewIpc(lite: CoreLite) {
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => listeners.set(channel, listener) },
    { fixture: true, isStudioUi: () => true },
  );
  registerPreviewIpc(handle, { core: lite.core, preview: () => null, previewBoundsSeen: { last: null } });
  return (channel: string) => (payload: unknown) =>
    listeners.get(channel)!({ sender: "studio", senderFrame: "main-frame" } as IpcSender, payload);
}

async function commitChange(dir: string, file: string, text: string): Promise<string> {
  await writeFile(path.join(dir, file), text);
  await gitFile(["add", "-A"], { cwd: dir });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file], { cwd: dir });
  return (await gitFile(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

describe("Live's gate", () => {
  it("the harness loads, reloads and plays in its stand-in, never in the person's Live", async () => {
    const { live, hidden, behind, api } = await stage();
    await api["preview.load"]!({ project: "pong" });
    await api["preview.reload"]!({});
    await api["preview.input"]!({ actions: [{ type: "key", key: "w" }] });
    // Naming the live view explicitly reaches the stand-in too: the gate is the host's.
    await api["preview.load"]!({ project: "pong", handle: "live" });
    assert.equal(live.loads.length, 1, "only the person's own load");
    assert.equal(live.reloads, 0);
    assert.equal(live.inputs, 0);
    assert.equal(hidden.length, 1, "one stand-in, reused");
    assert.equal(hidden[0]!.loads.length, 2);
    assert.equal(hidden[0]!.inputs, 1);
    // Nothing changed in the game folder, so nothing waits for Reload.
    assert.deepEqual(behind, []);
  });

  it("a harness look with no load of its own sees in the stand-in what Live shows", async () => {
    const { live, hidden, api } = await stage();
    await api["preview.status"]!({});
    assert.deepEqual(hidden[0]!.loads, [{ project: "pong", root: null }]);
    assert.equal(live.loads.length, 1);
  });

  it("a changed game folder waits for Reload, with the builder's note, and Reload brings it in", async () => {
    const { lite, live, behind, api, dir } = await stage();
    await writeFile(path.join(dir, "jump.js"), "export const jump = 2;\n");
    await api["preview.load"]!({ project: "pong" });
    assert.equal(live.loads.length, 1, "Live did not move");
    assert.deepEqual(behind.at(-1), { project: "pong", reason: "changed", commit: null, note: null, shows: null });
    // A checkpoint is the same kind of change, and its note rides along.
    await lite.core.offerLive({ project: "pong", root: null, note: "added a double jump" });
    assert.equal(behind.at(-1)?.note, "added a double jump");
    assert.equal(live.loads.length, 1);
    await lite.core.reloadLive();
    assert.equal(live.loads.length, 2, "Reload loaded the game folder");
    assert.deepEqual(behind.at(-1), { project: "pong", reason: null, commit: null, note: null, shows: null });
    // Now Live has it: the same folder offered again is not a change.
    await lite.core.offerLive({ project: "pong", root: null });
    assert.equal(behind.at(-1)?.reason, null);
  });

  it("a run's build waits as a commit, and Reload plays it from the studio's own copy", async () => {
    const { lite, live, behind, api, dir } = await stage();
    const worktree = path.join(lite.core.layout.scratch, "autopilot", "run_x", "integration");
    await gitFile(["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: dir });
    const head = await commitChange(worktree, "plaza.js", "export const plaza = 'red';\n");
    await api["preview.load"]!({ project: "pong", root: worktree });
    assert.equal(live.loads.length, 1);
    assert.deepEqual(behind.at(-1), { project: "pong", reason: "build", commit: head, note: null, shows: null });
    await lite.core.reloadLive();
    const shown = live.loads.at(-1)!;
    assert.ok(shown.root?.startsWith(path.join(await realpath(lite.core.layout.scratch), "show")), shown.root ?? "");
    assert.deepEqual(behind.at(-1), { project: "pong", reason: null, commit: null, note: null, shows: head });
  });

  it("another game's change is not Live's", async () => {
    const { lite, behind } = await stage();
    const other = await lite.core.games.scaffold("tetris");
    await writeFile(path.join(other.dir, "x.js"), "1\n");
    await lite.core.offerLive({ project: "tetris", root: null });
    assert.deepEqual(behind, []);
  });

  it("the harness cannot say Live is behind: only the host sends that", async () => {
    const { behind, api } = await stage();
    const forged = { project: "pong", reason: "build", commit: "0123456789abcdef", note: null };
    assert.equal(await api["ui.notify"]!({ type: "live.behind", payload: forged }), false);
    assert.deepEqual(behind, []);
  });

  it("a studio with no hidden windows still has only the live view to drive", async () => {
    const { live, hidden, api } = await stage({ headless: false });
    await api["preview.load"]!({ project: "pong" });
    assert.equal(live.loads.length, 2);
    assert.equal(hidden.length, 0);
  });
});

/** A run's build: a commit in an integration worktree of the game, as a run leaves it. */
async function runBuild(lite: CoreLite, dir: string, runId = "run_x"): Promise<string> {
  const worktree = path.join(lite.core.layout.scratch, "autopilot", runId, "integration");
  await gitFile(["worktree", "add", "-q", "--detach", worktree, "HEAD"], { cwd: dir });
  return commitChange(worktree, "plaza.js", "export const plaza = 'red';\n");
}

/** Main's word on Live's Reload, as the stage reads it on mount. */
function liveOf(behind: Stage["behind"][number] | undefined) {
  return behind && { reason: behind.reason, commit: behind.commit, shows: behind.shows };
}

/**
 * Reload stayed lit after the person played a build from Builds, the morning card or a review:
 * those reach main directly, and only the stage's own Play said which build Live had. Main says it
 * now, on every path, and a stage that mounts later reads it.
 */
describe("what Live shows, whoever loaded it", () => {
  it("Play from anywhere says which build Live shows, and the game folder says it shows none", async () => {
    const { lite, live, behind, dir } = await stage();
    const head = await runBuild(lite, dir);
    await lite.core.showBuild("pong", head);
    assert.equal(live.loads.length, 2);
    assert.deepEqual(liveOf(behind.at(-1)), { reason: null, commit: null, shows: head });
    assert.equal(lite.core.liveState("pong").shows, head);
    await lite.core.loadPreview({ project: "pong" });
    assert.deepEqual(liveOf(behind.at(-1)), { reason: null, commit: null, shows: null });
  });

  it("clears what waited only once Live has loaded: a load that fails leaves it waiting", async () => {
    const { lite, live, behind, api, dir } = await stage();
    await writeFile(path.join(dir, "jump.js"), "export const jump = 2;\n");
    await api["preview.load"]!({ project: "pong" });
    assert.equal(behind.at(-1)?.reason, "changed");
    live.failNext = true;
    await assert.rejects(lite.core.loadPreview({ project: "pong" }), /did not load/);
    assert.equal(lite.core.liveState("pong").reason, "changed", "nothing new reached Live");
    assert.equal(behind.at(-1)?.reason, "changed");
    await lite.core.loadPreview({ project: "pong" });
    assert.equal(lite.core.liveState("pong").reason, null);
    assert.equal(behind.at(-1)?.reason, null);
  });

  it("answers a stage that mounts after the change, and refuses a payload that names no game", async () => {
    const { lite, api, dir } = await stage();
    await writeFile(path.join(dir, "jump.js"), "export const jump = 2;\n");
    await api["preview.load"]!({ project: "pong" });
    const read = previewIpc(lite)("studio:live.behind");
    assert.deepEqual(await read({ project: "pong" }), {
      ok: true,
      value: { project: "pong", reason: "changed", commit: null, note: null, shows: null },
    });
    assert.deepEqual(await read({ project: "tetris" }), {
      ok: true,
      value: { project: "tetris", reason: null, commit: null, note: null, shows: null },
    });
    for (const payload of [undefined, null, {}, { project: 7 }, { project: "" }])
      assert.equal((await read(payload)).ok, false, JSON.stringify(payload));
  });
});

/**
 * The harness still reached Live by two doors: a run's `show_build` and `land_build` loaded it
 * with nobody asking, and a session whose window the harness named "live" drove it. A show or land
 * loads Live only for a message the person sent that is still unanswered, and only while Live is
 * out of their sight; otherwise Reload offers it. A session never takes Live, or the stand-in, by
 * name. The owner's session: asked to change a title, the chat's own session after a
 * run edited the game, showed "live" itself, and Live reloaded under them — a message still
 * waiting for its answer cannot tell "show me" from "change the title".
 */
describe("the harness's other doors into Live", () => {
  async function finishedRun(lite: CoreLite, dir: string) {
    const head = await runBuild(lite, dir, "run_done");
    const threadId = await lite.core.threadForGame("pong");
    await lite.core.append(
      [
        {
          type: "custom",
          event_type: "run_registered",
          payload: { runId: "run_done", project: "pong", mode: "director" },
        },
        {
          type: "custom",
          event_type: "run_finished",
          payload: { runId: "run_done", project: "pong", integrationHead: head, landed: false },
        },
      ],
      threadId,
    );
    // No harness in a lite core: a dispatch reaches nothing, and a message is still the person's.
    lite.core.host.dispatch = async () => undefined;
    const tool = (name: string, messageId?: string, args: Record<string, unknown> = {}) =>
      lite.api()["coordinator.tool"]!({
        threadId,
        runId: "run_done",
        name,
        args,
        ...(messageId ? { messageId } : {}),
      });
    const personSays = async (clientId: string, text = "show me what you built") => {
      await lite.core.sendUserMessage(text, { thread: threadId, clientId });
      return clientId;
    };
    return { head, threadId, tool, personSays };
  }

  it("a show nobody asked for is offered to Reload; one the person asked for plays while Live is out of sight", async () => {
    const { lite, live, behind, dir } = await stage();
    const { head, tool, personSays } = await finishedRun(lite, dir);
    await lite.core.previewStageVisible(false);
    for (const messageId of [undefined, "forged-id"]) {
      const answer = String(await tool("show_build", messageId));
      assert.match(answer, /Reload button on the stage now offers this build/, answer);
      assert.equal(live.loads.length, 1, `Live did not move (${messageId ?? "no message"})`);
      assert.deepEqual(liveOf(behind.at(-1)), { reason: "build", commit: head, shows: null });
    }
    const asked = String(await tool("show_build", await personSays("m-show")));
    assert.match(asked, /now shows the run's build/, asked);
    assert.equal(live.loads.length, 2, "the person's own ask loads a Live they are not watching");
    assert.deepEqual(liveOf(behind.at(-1)), { reason: null, commit: null, shows: head });
  });

  it("a show or landing that answers the person while they watch Live only lights Reload", async () => {
    const { lite, live, behind, dir } = await stage();
    const { head, tool, personSays } = await finishedRun(lite, dir);
    await writeFile(path.join(dir, "title.js"), "export const title = 'PANCAKE FEAST';\n");
    const change = await personSays("m-title", "change the title to PANCAKE FEAST");
    const folder = String(await tool("show_build", change, { build: "live" }));
    assert.match(folder, /Reload button on the stage now offers it/, folder);
    assert.equal(live.loads.length, 1, "Live did not reload under the person");
    assert.deepEqual(liveOf(behind.at(-1)), { reason: "changed", commit: null, shows: null });
    const build = String(await tool("show_build", await personSays("m-show")));
    assert.match(build, /Reload button on the stage now offers this build/, build);
    assert.equal(live.loads.length, 1, "Live did not move to the build");
    assert.deepEqual(liveOf(behind.at(-1)), { reason: "build", commit: head, shows: null });
    await lite.core.reloadLive();
    assert.equal(live.loads.length, 2, "Reload plays it");
  });

  it("a landing that answers the person while they watch Live lands it and only offers it to Reload", async () => {
    const { lite, live, behind, dir } = await stage();
    const { head, tool, personSays } = await finishedRun(lite, dir);
    const answer = String(await tool("land_build", await personSays("m-land", "put the build in my game")));
    assert.match(answer, /^Landed [0-9a-f]{10} in the game folder \(merged\); Live was left/, answer);
    await gitFile(["merge-base", "--is-ancestor", head, "HEAD"], { cwd: dir });
    assert.equal(live.loads.length, 1, "Live did not move");
    assert.equal(behind.at(-1)?.reason, "changed");
  });

  it("a dialog over a watched Live is not out of sight: a show the person asked for only lights Reload", async () => {
    const { lite, live, dir } = await stage();
    const { tool, personSays } = await finishedRun(lite, dir);
    const bounds = previewIpc(lite)("studio:preview.bounds");
    // Settings, the game search or a popover over the stage takes the native view's rectangle
    // away; the person is still watching their game in Live.
    await bounds({ x: 0, y: 0, width: 0, height: 0, watching: true });
    const covered = String(await tool("show_build", await personSays("m-covered")));
    assert.match(covered, /Reload button on the stage now offers this build/, covered);
    assert.equal(live.loads.length, 1, "Live did not reload under the dialog");
    // Builds (or the Studio page) in front: Live is out of sight, and the ask plays at once.
    await bounds({ x: 0, y: 0, width: 0, height: 0, watching: false });
    const hidden = String(await tool("show_build", await personSays("m-hidden")));
    assert.match(hidden, /now shows the run's build/, hidden);
    assert.equal(live.loads.length, 2);
  });

  it("a show or landing the person asked for never puts its game in a Live that holds another one", async () => {
    const { lite, live, behind, dir } = await stage();
    const { tool, personSays } = await finishedRun(lite, dir);
    await lite.core.games.scaffold("tetris");
    await lite.core.loadPreview({ project: "tetris" });
    await lite.core.previewStageVisible(false);
    const heard = behind.length;
    const shown = String(await tool("show_build", await personSays("m-other")));
    assert.match(shown, /Another game is open in Live/, shown);
    const landed = String(await tool("land_build", await personSays("m-other-land", "put the build in my game")));
    assert.match(landed, /^Landed [0-9a-f]{10} in the game folder \(merged\); another game is open in Live/, landed);
    assert.deepEqual(
      live.loads.map((load) => load.project),
      ["pong", "tetris"],
      "Live still holds the game the person opened",
    );
    assert.equal(behind.length, heard, "nothing waits for a Reload that belongs to another game");
    assert.equal(lite.core.liveState("pong").reason, null);
  });

  it("a landing nobody asked for lands the build and only offers the game folder to Reload", async () => {
    const { lite, live, behind, dir } = await stage();
    const { head, tool } = await finishedRun(lite, dir);
    const answer = String(await tool("land_build"));
    assert.match(answer, /^Landed [0-9a-f]{10} in the game folder \(merged\); Live was left/, answer);
    await gitFile(["merge-base", "--is-ancestor", head, "HEAD"], { cwd: dir });
    assert.equal(live.loads.length, 1, "Live did not move");
    assert.equal(behind.at(-1)?.reason, "changed");
    await lite.core.reloadLive();
    assert.equal(live.loads.length, 2);
  });

  it("a session the harness pointed at Live or the stand-in gets a window of its own", async () => {
    const live = makeFakePreview();
    const hidden: Array<ReturnType<typeof makeFakePreview>> = [];
    const lite = await coreLite({
      preview: live as never,
      gamesRoot: await realpath(await tmpDir("studio-live-gate-")),
      previewPoolMax: 1,
      createHeadlessPreview: async () => {
        const port = makeFakePreview();
        hidden.push(port);
        return port as never;
      },
    });
    const project = await lite.core.games.scaffold("pong");
    await lite.core.loadPreview({ project: "pong" });
    for (const handle of ["live", "stand-in"]) {
      const tools = await lite.core._playtestToolsFor(
        { project: "pong", root: project.dir, runId: "run_p", facetId: "p", iteration: 0, handle },
        project.dir,
        path.join(lite.core.layout.runs, "run_p"),
      );
      await tools.onLiveTool("computer", { action: "screenshot" });
      await tools.release();
    }
    assert.deepEqual(live.loads, ["pong"], "only the person's own load reached Live");
    assert.equal(hidden.length, 2, "each session opened a window of its own");
    for (const port of hidden) assert.ok(port.loads.includes("pong"));
  });
});
