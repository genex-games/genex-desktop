/**
 * The game's Assets during a Loop. Its workers deliver into their own copies and the lead into the
 * run's integration worktree, so until the run lands the game folder holds none of it, and the
 * Assets tab showed nothing while Builds counted every delivery. A delivery of a run still going
 * that is only in one of its build workspaces is now listed, marked as in the running build, and
 * read from there through a reference the host issues (`@build/<run>/<workspace>/<file>`). Once the
 * run lands the game's own file is listed as usual; a run that ended without landing shows nothing.
 *
 * The reference names a workspace the host lists for this game and a file in its asset folders:
 * traversal, links, another game's build and files outside the asset folders read nothing and
 * write nothing (hostile-input table).
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildRef } from "../../src/shared/build-ref.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { gitFile } from "../helpers/git.ts";

const RUN = "run_racer1";
const OTHER_RUN = "run_rival1";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(24)]);
const SIGN = "assets/genex/sign.png";
const ENGINE = "assets/genex/engine.wav";
const TYRE = "assets/genex/tyre.png";

let n = 0;
function record(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  n += 1;
  return {
    id: `e${n}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
    data: { type: EventKind.Custom, event_type: eventType, payload },
  } as EventEnvelope;
}
const delivered = (project: string, runId: string, jobId: string, files: string[]) =>
  record(CustomEvent.AssetDelivered, {
    project,
    source: "genex",
    pluginId: "genex",
    jobId,
    files: files.map((file) => ({ file, bytes: file.endsWith(".wav") ? WAV.length : PNG.length, kind: "image" })),
    at: "2026-10-31T10:00:00.000Z",
    workspace: "build",
    runId,
    facetId: "pool.w4",
  });
const finished = (runId: string, landed: boolean) =>
  record(CustomEvent.RunFinished, { runId, status: "finished", landed });

const git = (cwd: string, args: string[]) => gitFile(["-C", cwd, ...args]);

/** A game with a commit, and a worktree of it at `where` holding `files`. */
async function gameWithBuild(lite: CoreLite, name: string, runId: string, files: Record<string, Buffer>) {
  const game = await lite.core.games.scaffold(name);
  await git(game.dir, ["add", "-A"]);
  await git(game.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start", "--allow-empty"]);
  const integration = path.join(lite.core.layout.scratch, "autopilot", runId, "integration");
  await mkdir(path.dirname(integration), { recursive: true });
  await git(game.dir, ["worktree", "add", "-q", "--detach", integration]);
  for (const [file, data] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(integration, file)), { recursive: true });
    await writeFile(path.join(integration, file), data);
  }
  return { dir: game.dir, integration };
}

/** Every path under `root` with its size, or its link's target: what a read must leave as it was. */
async function tree(root: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) rows.push(`${full} -> ${await readlink(full)}`);
      else if (entry.isDirectory()) await walk(full);
      else rows.push(`${full} ${(await lstat(full)).size}`);
    }
  };
  await walk(root);
  return rows.sort();
}

describe("assets a running Loop delivered into its build", () => {
  let lite: CoreLite;
  let racer: { dir: string; integration: string };
  let secret: string;

  before(async () => {
    lite = await coreLite();
    racer = await gameWithBuild(lite, "racer", RUN, { [SIGN]: PNG, [ENGINE]: WAV });
    const worker = path.join(lite.core.layout.scratch, "autopilot", RUN, "worker-w4");
    await git(racer.dir, ["worktree", "add", "-q", "--detach", worker]);
    await mkdir(path.join(worker, "assets/genex"), { recursive: true });
    await writeFile(path.join(worker, TYRE), PNG);
    await gameWithBuild(lite, "rival", OTHER_RUN, { [SIGN]: PNG });
    secret = path.join(lite.core.layout.scratch, "secret.png");
    await writeFile(secret, PNG);
    await symlink(secret, path.join(racer.integration, "assets/genex/link.png"));
    await writeFile(path.join(racer.integration, "src/notes.png"), PNG);
  });
  after(async () => lite?.close());

  const ledger = () => [
    delivered("racer", RUN, "job-sign", [SIGN, ENGINE]),
    delivered("racer", RUN, "job-tyre", [TYRE]),
  ];

  it("lists a delivery that is only in the running build, marked so, and reads it from there", async () => {
    const { assets } = await lite.core.projectAssets("racer", ledger());
    const sign = assets.find((asset) => asset.file === SIGN);
    assert.ok(sign, "the sign is listed while the run goes on");
    assert.deepEqual(sign.building, { runId: RUN, workspace: "integration" });
    assert.equal(sign.assetRef, buildRef(RUN, "integration", SIGN));
    assert.equal(sign.kind, "image");
    assert.equal(sign.jobId, "job-sign");
    const tyre = assets.find((asset) => asset.file === TYRE);
    assert.deepEqual(tyre?.building, { runId: RUN, workspace: "worker-w4" }, "a worker's copy, before its merge");
    const still = await lite.core.readProjectAsset({ project: "racer", file: sign.assetRef ?? "" });
    assert.equal(still?.mimeType, "image/png");
    const engine = assets.find((asset) => asset.file === ENGINE);
    assert.ok(engine?.assetRef);
    const sound = await lite.core.previewProjectAsset({ project: "racer", file: engine.assetRef });
    assert.equal(sound.data.byteLength, WAV.length);
  });

  it("lists the game's own file once the run landed, and nothing of a run that ended without landing", async () => {
    await mkdir(path.join(racer.dir, "assets/genex"), { recursive: true });
    await writeFile(path.join(racer.dir, TYRE), PNG);
    const landed = await lite.core.projectAssets("racer", [...ledger(), finished(RUN, true)]);
    const tyre = landed.assets.find((asset) => asset.file === TYRE);
    assert.ok(tyre);
    assert.equal(tyre.building, undefined, "in the game: listed as any other file");
    assert.equal(tyre.assetRef, undefined);
    assert.equal(
      landed.assets.some((asset) => asset.building),
      false,
      "a closed run's build lends nothing",
    );
    const stopped = await lite.core.projectAssets("racer", [...ledger(), finished(RUN, false)]);
    assert.equal(
      stopped.assets.some((asset) => asset.file === SIGN),
      false,
    );
  });

  it("reads nothing and writes nothing for a reference the host did not issue for this game", async () => {
    const root = path.dirname(lite.core.layout.scratch);
    const hostile = [
      `@build/${RUN}/integration/../../../secret.png`,
      `@build/${RUN}/../integration/${SIGN}`,
      `@build/../autopilot/${RUN}/integration/${SIGN}`,
      `@build/${RUN}/integration/assets/genex/link.png`,
      `@build/${RUN}/integration/${secret}`,
      `@build/${RUN}/integration//etc/hosts`,
      `@build/${RUN}/integration/src/notes.png`,
      `@build/${OTHER_RUN}/integration/${SIGN}`,
      `@build/${RUN}/nope/${SIGN}`,
      `@build/${RUN}/integration/assets/genex/missing.png`,
      `@build/${RUN}/integration`,
      `@build/${RUN}`,
      "@build/",
      `@build/${RUN}/integration/assets/genex/sign.png\0.txt`,
    ];
    const before = await tree(root);
    for (const file of hostile) {
      assert.equal(await lite.core.readProjectAsset({ project: "racer", file }), null, file);
      await assert.rejects(lite.core.previewProjectAsset({ project: "racer", file }), file);
    }
    assert.deepEqual(await tree(root), before, "nothing was written, moved or linked");
  });
});
