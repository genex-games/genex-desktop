/**
 * The `asset-library` dev fixture: the fixture game's Assets tab with a file in every library state.
 * Its links, read by the app's own library sharing over the fixture library, put the mushroom in
 * the library unsaved, the strider and the crowd saved, the hut shared, and the dropped picture in
 * the game only. A picture, a model and a sound list no thumbnail, as most of a real library, and the
 * window gets their files from the fixture.
 */
import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { after, before, it } from "node:test";
import { type LibrarySharingDeps, librarySharing } from "../../src/main/core/library-sharing.ts";
import { fixtureDownload, fixtureFileResponse, FixtureGenerationId } from "../../src/main/dev/fixture-asset-library.ts";
import { ASSET_LIBRARY_FILES, seedAssetLibrary } from "../../src/main/dev/fixture-assets-tab.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FixtureName } from "../../src/main/dev/fixture-kit.ts";
import { FixtureAccount, fixtureAccountToken, launchFixtureAccount } from "../../src/main/dev/fixture-people.ts";
import { assetLibrary } from "../../src/main/play/asset-library.ts";
import { ShareMiss } from "../../src/shared/asset-library.ts";
import { assetKind, type ProjectAsset } from "../../src/shared/game-assets.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const DROPPED = "assets/stone-path.png";

let root = "";
before(async () => {
  root = await realpath(await tmpDir("asset-library-fixture-"));
});
after(async () => {
  await removeTree(root);
});

/** The game's files as the Assets tab lists them: the Genex ones by their job folders, the picture dropped in. */
const listed = (): ProjectAsset[] =>
  [...ASSET_LIBRARY_FILES, DROPPED].map((file) => ({
    file,
    kind: assetKind(file),
    bytes: 1,
    mtime: "2026-10-17T00:00:00Z",
    source: file === DROPPED ? "imported" : "genex",
  }));

it("writes each Genex file in its job's folder, the dropped picture, and the links to the fixture library", async () => {
  await seedAssetLibrary(root);
  for (const file of [...ASSET_LIBRARY_FILES, DROPPED]) await access(path.join(root, file));
  const glb = await readFile(path.join(root, ASSET_LIBRARY_FILES[0] ?? ""));
  assert.equal(glb.subarray(0, 4).toString("latin1"), "glTF");
  const links = JSON.parse(await readFile(path.join(root, ".studio", "library-links.json"), "utf8"));
  assert.deepEqual(
    Object.values(links.files).map((link) => (link as { generationId: string }).generationId),
    [FixtureGenerationId.Mushroom, FixtureGenerationId.Strider, FixtureGenerationId.Hut, FixtureGenerationId.Crowd],
  );
});

/** The app's library sharing on the seeded game, over the fixture library as the full account. */
function sharingOnFixture() {
  const library = assetLibrary({
    request: fixturePlayRequest,
    token: async () => fixtureAccountToken(FixtureAccount.Full),
    upload: async () => 200,
    localImages: true,
  });
  const deps: LibrarySharingDeps = {
    library: () => library,
    gameDir: async () => root,
    webGame: async () => true,
    assets: async () => ({ project: "fixture-game", assets: listed(), truncated: false, skipped: [] }),
    readFile: async () => ({ mimeType: "image/png", data: new Uint8Array(3) }),
    manifest: async () => null,
    download: fixtureDownload,
    vendorModule: async () => null,
  };
  return librarySharing(deps);
}

it("reads as every state the canvas draws: not saved, saved, shared, a saved sound, a file only in the game", async () => {
  const { states, unread } = await sharingOnFixture().states("fixture-game");
  assert.equal(unread, false);
  const view = states.map((entry) => [entry.saved, entry.shared?.live ?? false, entry.shareable]);
  assert.deepEqual(view, [
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, false, true],
    [false, false, false],
  ]);
});

it("answers a share named slow as still checked, and live by the next read; one named refuse as refused", async () => {
  const sharing = sharingOnFixture();
  const [mushroom, strider] = ASSET_LIBRARY_FILES;
  const outcomes = await sharing.share("fixture-game", [
    { file: mushroom ?? "", name: "Slow mushroom" },
    { file: strider ?? "", name: "Refuse me" },
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => ("miss" in outcome ? outcome.miss : "shared")),
    [ShareMiss.Checking, ShareMiss.Refused],
  );
  const { states } = await sharing.states("fixture-game");
  assert.equal(states[0]?.shared?.live, true);
  assert.equal(states[1]?.shared, null);
});

it("signs in as the full account, whose library it is, unless the launch names another", () => {
  assert.equal(launchFixtureAccount(undefined, FixtureName.AssetLibrary), FixtureAccount.Full);
  assert.equal(launchFixtureAccount(FixtureAccount.New, FixtureName.AssetLibrary), FixtureAccount.New);
});

it("lists a picture, a model and a sound with no thumbnail, and serves their files to the window", async () => {
  const library = assetLibrary({
    request: fixturePlayRequest,
    token: async () => fixtureAccountToken(FixtureAccount.Full),
    upload: async () => 200,
    localImages: true,
  });
  const { assets } = await library.list();
  const bare = assets.filter((asset) => asset.thumbnailUrl === null);
  assert.deepEqual(
    bare.map((asset) => asset.id),
    [FixtureGenerationId.Dusk, FixtureGenerationId.Sword, FixtureGenerationId.Wind],
  );
  const served = await Promise.all(bare.map((asset) => fixtureFileResponse(asset.fileUrl ?? "")));
  assert.deepEqual(
    served.map((response) => response?.headers.get("content-type")),
    ["image/png", "model/gltf-binary", "audio/wav"],
  );
  const glb = new Uint8Array(await (served[1]?.arrayBuffer() ?? new ArrayBuffer(0)));
  assert.equal(Buffer.from(glb.subarray(0, 4)).toString("latin1"), "glTF");
  for (const other of [
    "https://assets.genex.technology/generations/not-in-the-library/a.png",
    "https://evil.example/generations/fxgen-dusk-sky-0007/a.png",
    "not a url",
  ])
    assert.equal(await fixtureFileResponse(other), null, other);
});
