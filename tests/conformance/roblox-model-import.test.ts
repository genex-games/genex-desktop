/**
 * The Roblox plugin's model tools (`plugins/roblox/model-import.ts`): `check-model` runs the asset
 * gate and says what a model fails on; `import-model` asks the person on a card, runs the gate, and
 * only a model that passes reaches the Genex helper's `model.import`, as the helper's mesh (`GXM1`)
 * in studs. A model that fails, or a file that can't be checked, reaches no Studio. When Studio
 * can't add it, the answer names the checked file and Studio's own click path.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_BUSY_FILE } from "../../src/plugins/roblox/agent-marks.ts";
import { createRobloxBackend, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import type { HelperAsk, Upload } from "../../src/plugins/roblox/helper-link.ts";
import { HelperLinkError, HelperLinkFailure } from "../../src/plugins/roblox/helper-link.ts";
import { HelperErrorCode, HelperMessage, MODEL_MAGIC, MODEL_PART } from "../../src/plugins/roblox/helper-protocol.ts";
import {
  checkModelTool,
  type ImportGame,
  importModel,
  STUDS_PER_METRE,
} from "../../src/plugins/roblox/model-import.ts";
import type { MomentServices } from "../../src/plugins/roblox/moment-ops.ts";
import { createStudioWatch } from "../../src/plugins/roblox/studio-moments.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { ConsentChoice, consentChoices, consentTitle } from "../../src/renderer/chat/consent-card.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { buildGlb, gridCube, MODEL_FIXTURES } from "../helpers/roblox-models.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/roblox/plugin.json");
const NOW = 1_800_000_000_000;
const STUDIO = "studio-7";

type Asked = { type: string; body: unknown; upload: Upload[] };

/** A helper that records each request and answers with `answer`. */
function helper(answer: (asked: Asked) => unknown = () => ({ instance: "Workspace.cube" })) {
  const asked: Asked[] = [];
  const ask = (async (type: string, body: unknown, options?: { upload?: Upload[] }) => {
    const one = { type, body, upload: options?.upload ?? [] };
    asked.push(one);
    return answer(one);
  }) as HelperAsk;
  return { ask, asked };
}

/** A game folder with the committed fixtures in `models/`, its helper bound unless said. */
async function gameWith(ask: HelperAsk, bound = true): Promise<ImportGame & { folder: string; marks: string }> {
  const root = await tmpDir("roblox-import-");
  const folder = path.join(root, "game");
  const marks = path.join(root, "storage", "mcp", "game-1");
  await mkdir(path.join(folder, "models"), { recursive: true });
  await mkdir(marks, { recursive: true });
  for (const name of ["cube.glb", "open-box.glb", "jpeg-texture.glb"])
    await copyFile(path.join(MODEL_FIXTURES, name), path.join(folder, "models", name));
  return { folder, marks, ask, bound: () => (bound ? STUDIO : undefined) };
}

const deps = { now: () => NOW };

/** The helper's mesh read back: vertices, triangles, and each vertex's position. */
function readMesh(data: Uint8Array) {
  const bytes = Buffer.from(data);
  assert.equal(bytes.toString("latin1", 0, 4), MODEL_MAGIC);
  const vertices = bytes.readUInt32LE(4);
  const triangles = bytes.readUInt32LE(8);
  assert.equal(bytes.length, 12 + vertices * 32 + triangles * 12, "the size the helper checks");
  const positions = Array.from({ length: vertices }, (_, at) =>
    [0, 1, 2].map((axis) => bytes.readFloatLE(12 + at * 12 + axis * 4)),
  );
  const normalsAt = 12 + vertices * 12;
  const normals = Array.from({ length: vertices }, (_, at) =>
    [0, 1, 2].map((axis) => bytes.readFloatLE(normalsAt + at * 12 + axis * 4)),
  );
  const trianglesAt = 12 + vertices * 32;
  const corners = Array.from({ length: triangles * 3 }, (_, at) => bytes.readUInt32LE(trianglesAt + at * 4));
  return { vertices, triangles, positions, normals, corners };
}

describe("import-model sends only a model that passes", () => {
  it("a model the gate fails reaches no helper, and the answer says why", async () => {
    const { ask, asked } = helper();
    const game = await gameWith(ask);
    const answer = await importModel(deps, { file: "models/open-box.glb" }, game);
    assert.equal(answer.done, false);
    assert.match(answer.message, /isn't closed/);
    assert.deepEqual(answer.problems, ["watertight"]);
    assert.deepEqual(asked, []);
  });

  const REFUSED: Array<[string, Record<string, unknown>, RegExp]> = [
    ["an FBX", { file: "models/chair.fbx" }, /export it as \.glb/i],
    ["a path out of the game folder", { file: "../outside.glb" }, /inside the game folder/],
    ["no file named", {}, /file/],
    ["a name of two lines", { file: "models/cube.glb", name: "a\nb" }, /name/],
    ["a name too long", { file: "models/cube.glb", name: "x".repeat(101) }, /name/],
  ];
  for (const [what, args, words] of REFUSED)
    it(`${what}: refused, no helper call`, async () => {
      const { ask, asked } = helper();
      const answer = await importModel(deps, args, await gameWith(ask));
      assert.equal(answer.done, false);
      assert.match(answer.message, words);
      assert.deepEqual(asked, []);
    });

  it("a model that passes reaches model.import as the helper's mesh, in studs, under the agent's busy mark", async () => {
    const { ask, asked } = helper();
    const game = await gameWith(ask);
    const answer = await importModel(deps, { file: "models/cube.glb" }, game);
    assert.equal(answer.done, true, answer.message);
    assert.equal(asked.length, 1);
    const [one] = asked;
    assert.equal(one?.type, HelperMessage.ModelImport);
    const upload = one?.upload ?? [];
    assert.deepEqual(
      upload.map((part) => part.part),
      [MODEL_PART],
    );
    const data = upload[0]?.data ?? new Uint8Array();
    assert.deepEqual(one?.body, { name: "cube", bytes: data.length });
    const mesh = readMesh(data);
    assert.equal(mesh.triangles, 12);
    assert.equal(mesh.vertices, 24, "the export's own vertices, each used");
    const half = 0.5 * STUDS_PER_METRE;
    for (const point of mesh.positions)
      for (const value of point) assert.ok(Math.abs(Math.abs(value) - half) < 1e-4, `corner at ±${half} studs`);
    for (const normal of mesh.normals) assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-5, "unit normals");
    assert.ok(mesh.corners.every((corner) => corner < mesh.vertices));
    assert.match(answer.message, /Workspace\.cube/);
    assert.match(answer.message, /Roblox account when .*publish/);
    const mark = JSON.parse(await readFile(path.join(game.marks, AGENT_BUSY_FILE), "utf8"));
    assert.deepEqual(mark, { since: NOW, until: NOW }, "Studio's change is the agent's");
  });

  it("names the part as asked, and moves a child node's mesh where the node puts it", async () => {
    const { ask, asked } = helper(() => ({ instance: "Workspace.Crate" }));
    const game = await gameWith(ask);
    await writeFile(
      path.join(game.folder, "models", "raised.glb"),
      buildGlb({ primitives: [gridCube()], child: [0, 2, 0] }),
    );
    const answer = await importModel(deps, { file: "models/raised.glb", name: "Crate" }, game);
    assert.equal(answer.done, true, answer.message);
    assert.deepEqual(asked[0]?.body, { name: "Crate", bytes: asked[0]?.upload[0]?.data.length });
    const mesh = readMesh(asked[0]?.upload[0]?.data ?? new Uint8Array());
    const heights = mesh.positions.map((point) => point[1] ?? 0);
    assert.ok(Math.abs(Math.min(...heights) - 1.5 * STUDS_PER_METRE) < 1e-4, "the bottom at 1.5 m up");
  });
});

describe("import-model when Studio can't take it", () => {
  it("with no helper connected for the game, says how to connect it and sends nothing", async () => {
    const { ask, asked } = helper();
    const answer = await importModel(deps, { file: "models/cube.glb" }, await gameWith(ask, false));
    assert.equal(answer.done, false);
    assert.match(answer.message, /isn't connected/);
    assert.deepEqual(asked, []);
  });

  const STUDIO_REFUSALS: Array<[string, Error]> = [
    [
      "this Studio can't build a mesh",
      new HelperLinkError(
        HelperLinkFailure.Answered,
        "This Studio can't build a mesh from a plugin.",
        HelperErrorCode.Unsupported,
      ),
    ],
    [
      "Studio failed making it",
      new HelperLinkError(HelperLinkFailure.Answered, "Studio couldn't make the model: quota", "failed"),
    ],
    [
      "the helper didn't answer in time",
      new HelperLinkError(
        HelperLinkFailure.TimedOut,
        "The Genex helper in Roblox Studio didn't answer model.import in time.",
      ),
    ],
  ];
  for (const [what, error] of STUDIO_REFUSALS)
    it(`when ${what}, names the checked file and Studio's own click path`, async () => {
      const { ask } = helper(() => {
        throw error;
      });
      const answer = await importModel(deps, { file: "models/cube.glb" }, await gameWith(ask));
      assert.equal(answer.done, false);
      assert.match(answer.message, /models\/cube\.glb/);
      assert.match(answer.message, /passed/);
      assert.equal(answer.clickPath, "File › Import 3D");
      assert.match(answer.message, /File › Import 3D/);
    });
});

describe("check-model", () => {
  it("says a passing model passes, with its triangles and texture sizes", async () => {
    const { ask } = helper();
    const game = await gameWith(ask);
    const answer = await checkModelTool({ file: "models/jpeg-texture.glb" }, game.folder);
    assert.equal(answer.passed, true, answer.message);
    assert.match(answer.message, /12 triangles/);
    assert.match(answer.message, /wood 640 by 320/);
  });

  it("lists each problem, and a stricter texture side when asked", async () => {
    const { ask } = helper();
    const game = await gameWith(ask);
    const open = await checkModelTool({ file: "models/open-box.glb" }, game.folder);
    assert.equal(open.passed, false);
    assert.deepEqual(open.problems, ["watertight"]);
    const strict = await checkModelTool({ file: "models/jpeg-texture.glb", textureSide: 512 }, game.folder);
    assert.deepEqual(strict.problems, ["texture"]);
  });

  const BAD: Array<[string, Record<string, unknown>]> = [
    ["no file", {}],
    ["a texture side that isn't a whole number", { file: "models/cube.glb", textureSide: 1.5 }],
    ["a texture side above 1024", { file: "models/cube.glb", textureSide: 2048 }],
    ["a texture side below 16", { file: "models/cube.glb", textureSide: 8 }],
  ];
  for (const [what, args] of BAD)
    it(`refuses ${what}`, async () => {
      const { ask } = helper();
      const answer = await checkModelTool(args, (await gameWith(ask)).folder);
      assert.equal(answer.passed, false);
      assert.ok(answer.refused, answer.message);
    });

  it("refuses with no game folder", async () => {
    const answer = await checkModelTool({ file: "models/cube.glb" }, undefined);
    assert.equal(answer.passed, false);
    assert.ok(answer.refused);
  });
});

describe("the manifest's model tools", () => {
  it("check-model asks nothing and waits on no one; import-model asks on a card and holds the Studio lock", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const check = manifest.tools.find((tool) => tool.name === "check-model");
    const importer = manifest.tools.find((tool) => tool.name === "import-model");
    assert.ok(check && importer);
    assert.equal(check.confirmation, undefined);
    assert.equal(check.needs, undefined);
    assert.deepEqual(check.facts, ["roblox-project"]);
    assert.deepEqual(importer.needs, ["studio"]);
    assert.deepEqual(importer.facts, ["roblox-project"]);
    const card = importer.confirmation ?? "";
    assert.ok(card.length > 0 && card.length <= 300, `${card.length} characters`);
    assert.match(card, /your Roblox account/);
    assert.match(card, /publish/);
  });
});

describe("through the backend", () => {
  const onMacWorld = { skip: process.platform === "win32" ? "the fake Mac helper is POSIX-only" : false };
  it("check-model reads the game folder and import-model reaches the game's helper", onMacWorld, async () => {
    const mac = await robloxMac();
    const game = await makeGame(mac, "sky-race", "Sky race");
    await mkdir(path.join(game.directory, "models"));
    await copyFile(path.join(MODEL_FIXTURES, "cube.glb"), path.join(game.directory, "models", "cube.glb"));
    const { ask, asked } = helper();
    const seen: string[] = [];
    mac.deps.gameSeen = async (_storage, id) => {
      seen.push(id);
    };
    mac.deps.moments = {
      ask: () => ask,
      bound: (id) => (id === game.project ? STUDIO : undefined),
      flush: async () => {},
      reapply: async () => true,
      watch: createStudioWatch(mac.deps.now),
    } satisfies MomentServices;
    const backend = createRobloxBackend(mac.deps);
    const { context } = hostFor(mac, game);
    const checked = (await backend.tool?.(RobloxTool.CheckModel, { file: "models/cube.glb" }, context)) as {
      passed: boolean;
    };
    assert.equal(checked.passed, true);
    const imported = (await backend.tool?.(RobloxTool.ImportModel, { file: "models/cube.glb" }, context)) as {
      done: boolean;
      message: string;
    };
    assert.equal(imported.done, true, imported.message);
    assert.equal(asked[0]?.type, HelperMessage.ModelImport);
    assert.deepEqual(seen, [], "a worker copy's folder is never handed to the script sync");
  });
});

describe("the card in a chat, through a real core", () => {
  let lite: CoreLite;
  let threadId: string;
  let dir: string;

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event: UiEventData) => {
        if (event.type !== UiEvent.PluginConsent) return;
        const payload = event.payload as { consentId: string; state: string };
        if (payload.state !== "pending") return;
        // Declined: nothing reaches the plugin, so no Studio is touched.
        void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, false));
      },
    });
    await lite.core.plugins.setEnabled("roblox", true);
    dir = (await lite.core.games.scaffold("obby")).dir;
    threadId = await lite.core.threadForGame("obby");
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("in Bypass import-model still shows its card, and a no runs nothing", async () => {
    const manifest = validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
    const binding = { project: "obby", directory: dir, threadId };
    await assert.rejects(
      lite.core.plugins.tool("roblox__import-model", { file: "models/cube.glb" }, binding),
      /declin|not allow/i,
    );
    const events = await lite.core.store.listEvents(threadId);
    const cards = toEntries(events).filter((entry) => (entry as { consentId?: string }).consentId) as Array<
      Parameters<typeof consentTitle>[0] & { pending?: boolean }
    >;
    assert.equal(cards.length, 1);
    const [card] = cards;
    assert.ok(card);
    assert.equal(consentTitle(card), manifest.tools.find((tool) => tool.name === "import-model")?.confirmation);
    assert.deepEqual(
      consentChoices(card).map((choice) => choice.id),
      [ConsentChoice.Once, ConsentChoice.Decline],
      "no Always allow",
    );
  });
});
