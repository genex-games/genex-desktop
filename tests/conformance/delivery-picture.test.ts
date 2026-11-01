/**
 * The copy Genex keeps of a delivered picture (`main/delivery-picture.ts`). A Loop's workers deliver
 * into their own copies of the game and the lead into the run's integration worktree; the game folder
 * has those files only once the build lands, and a worker's copy goes after its merge. So the host
 * keeps a copy of the delivery's first picture in the run's folder, where the Builds graph reads it.
 * The workspace is one an agent writes: a link, an escape or bytes that are no picture keep nothing.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { keepDeliveredPicture } from "../../src/main/delivery-picture.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A picture's bytes as `sniffImage` reads them: the PNG and JPEG signatures, then anything. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("render")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("a smaller copy")]);
const RUN = "run_mvva22xxw88i";

/** A worker's copy with a Blender delivery in it, and a picture outside it. */
async function workspace() {
  const base = await tmpDir("studio-delivery-picture-");
  const root = path.join(base, "copy");
  const job = path.join(root, "assets", "blender", "job-car");
  await mkdir(job, { recursive: true });
  await writeFile(path.join(job, "model.glb"), "glTF");
  await writeFile(path.join(job, "render-front.png"), PNG);
  await writeFile(path.join(job, "render.png"), Buffer.concat([PNG, Buffer.from("-side")]));
  const outside = path.join(base, "secret.png");
  await writeFile(outside, PNG);
  return { base, root, outside };
}

/** A run folder's writer that keeps what it was asked to write. */
function recordingSave() {
  const saved: Array<{ runId: string; name: string; data: Buffer }> = [];
  return {
    saved,
    save: async (runId: string, name: string, data: Buffer) => {
      saved.push({ runId, name, data });
      return `/runs/${runId}/${name}`;
    },
  };
}

const CAR = [
  "assets/blender/job-car/model.glb",
  "assets/blender/job-car/render-front.png",
  "assets/blender/job-car/render.png",
];

describe("the copy kept of a delivered picture", () => {
  it("keeps the delivery's first picture in the run's folder and answers where", async () => {
    const { root } = await workspace();
    const { saved, save } = recordingSave();
    const kept = await keepDeliveredPicture({ root, files: CAR, runId: RUN, jobId: "job-car" }, { save });
    assert.equal(kept, `/runs/${RUN}/deliveries/job-car.png`);
    assert.deepEqual(
      saved.map((row) => [row.runId, row.name]),
      [[RUN, "deliveries/job-car.png"]],
      "one copy: the first picture, the model is none",
    );
    assert.deepEqual(saved[0]?.data, PNG);
  });

  it("keeps a smaller JPEG when the host can make one", async () => {
    const { root } = await workspace();
    const { saved, save } = recordingSave();
    const resize = async (data: Buffer, maxPx: number) => (data.equals(PNG) && maxPx > 0 ? JPEG : null);
    const kept = await keepDeliveredPicture({ root, files: CAR, runId: RUN, jobId: "job-car" }, { save, resize });
    assert.equal(kept, `/runs/${RUN}/deliveries/job-car.jpg`);
    assert.deepEqual(saved[0]?.data, JPEG);
  });

  it("names the copy by a job id it cannot climb out of", async () => {
    const { root } = await workspace();
    const { saved, save } = recordingSave();
    await keepDeliveredPicture({ root, files: CAR, runId: RUN, jobId: "../../escape/x" }, { save });
    const [row] = saved;
    assert.ok(row);
    assert.match(row.name, /^deliveries\/[A-Za-z0-9_-]+\.png$/, row.name);
  });

  it("keeps nothing a hostile or empty delivery names", async () => {
    const { root, outside } = await workspace();
    await symlink(outside, path.join(root, "assets", "linked.png"));
    await symlink(path.dirname(outside), path.join(root, "assets", "linked-folder"));
    await writeFile(path.join(root, "assets", "words.png"), "not a picture");
    const rows: Array<[string, string[]]> = [
      ["a file above the workspace", ["../secret.png"]],
      ["an absolute path", [outside]],
      ["a link to a picture outside", ["assets/linked.png"]],
      ["a picture through a linked folder", ["assets/linked-folder/secret.png"]],
      ["bytes that are no picture", ["assets/words.png"]],
      ["a missing file", ["assets/blender/job-car/gone.png"]],
      ["a model alone", ["assets/blender/job-car/model.glb"]],
      ["no files", []],
    ];
    for (const [name, files] of rows) {
      const { saved, save } = recordingSave();
      const kept = await keepDeliveredPicture({ root, files, runId: RUN, jobId: "job-x" }, { save });
      assert.equal(kept, null, name);
      assert.deepEqual(saved, [], `${name}: nothing written`);
    }
    assert.deepEqual(await readFile(outside), PNG, "the picture outside is untouched");
  });

  it("a run folder that refuses the write keeps nothing and never throws", async () => {
    const { root } = await workspace();
    const save = async () => {
      throw new Error("a run artifact must stay inside its run folder");
    };
    assert.equal(await keepDeliveredPicture({ root, files: CAR, runId: "../x", jobId: "job-car" }, { save }), null);
  });
});
