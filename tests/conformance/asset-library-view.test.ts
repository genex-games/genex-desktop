/**
 * What the Assets tab draws from a game's library states (`renderer/asset-library-view.ts`): each
 * card's tag and share line, which cards a Cmd- or Shift-click picks, what the bar's Save and Share
 * act on, the names the share window offers, and what a search finds in each group.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canSave,
  canShare,
  CardTag,
  cardTagOf,
  cleanName,
  communityMatches,
  gameMatches,
  generationsInGame,
  libraryMatches,
  lineRows,
  MissAction,
  offeredName,
  SEARCH_GROUP_MAX,
  type ShareProgress,
  ShareLineKind,
  ShareStep,
  shareItemsOf,
  shareLineOf,
  sharedAssetUrl,
  shareUnderway,
  selectionActions,
  StepMark,
  stepMark,
  toggledSelection,
} from "../../src/renderer/asset-library-view.ts";
import {
  type AssetLibraryState,
  type GameLibraryStates,
  LibraryKind,
  type LibraryAsset,
  ShareMiss,
} from "../../src/shared/asset-library.ts";
import type { ProjectAsset } from "../../src/shared/game-assets.ts";
import type { PlayGame } from "../../src/shared/play.ts";

const progress = (step: ShareStep, miss: ShareMiss | null = null, reported = false): ShareProgress => ({
  name: "Giant mushroom tree",
  step,
  miss,
  reported,
});

const state = (file: string, extra: Partial<AssetLibraryState> = {}): AssetLibraryState => ({
  file,
  generationId: `gen-${file}`,
  saved: false,
  shared: null,
  saveable: true,
  shareable: true,
  ...extra,
});

const game = (states: AssetLibraryState[], unread = false): GameLibraryStates => ({ project: "g", states, unread });

const asset = (file: string, extra: Partial<ProjectAsset> = {}): ProjectAsset => ({
  file,
  kind: "model",
  bytes: 1,
  mtime: "2026-10-17T00:00:00Z",
  source: "genex",
  ...extra,
});

const LIVE = { projectId: "p", slug: "chitin-hut", live: true };

describe("a share's line under its card", () => {
  it("names the steps, the current one bright and the passed ones done", () => {
    assert.deepEqual(shareLineOf(progress(ShareStep.Send)), {
      kind: ShareLineKind.Steps,
      current: ShareStep.Send,
      checking: false,
    });
    assert.deepEqual(
      [ShareStep.Send, ShareStep.Check, ShareStep.Live].map((step) => stepMark(step, ShareStep.Check)),
      [StepMark.Done, StepMark.On, StepMark.Ahead],
    );
  });

  it("says Checking while genex.games still checks it", () => {
    assert.deepEqual(shareLineOf(progress(ShareStep.Check, ShareMiss.Checking)), {
      kind: ShareLineKind.Steps,
      current: ShareStep.Check,
      checking: true,
    });
  });

  it("shows the ✓ once live", () => {
    assert.deepEqual(shareLineOf(progress(ShareStep.Live)), { kind: ShareLineKind.Live });
  });

  it("offers a report for genex.games' refusal, Try again for a failure, nothing for what can never go", () => {
    const action = (miss: ShareMiss, reported = false) => {
      const line = shareLineOf(progress(ShareStep.Missed, miss, reported));
      return line.kind === ShareLineKind.Missed ? line.action : null;
    };
    assert.equal(action(ShareMiss.Refused), MissAction.Report);
    assert.equal(action(ShareMiss.Refused, true), MissAction.Reported);
    assert.equal(action(ShareMiss.Failed), MissAction.Retry);
    assert.equal(action(ShareMiss.TooMany), MissAction.Retry);
    assert.equal(action(ShareMiss.NotShareable), MissAction.None);
    assert.equal(action(ShareMiss.KindNotShareable), MissAction.None);
  });

  it("takes a second row when a miss offers an action under its words", () => {
    assert.equal(lineRows(progress(ShareStep.Send)), 1);
    assert.equal(lineRows(progress(ShareStep.Live)), 1);
    assert.equal(lineRows(progress(ShareStep.Missed, ShareMiss.Refused)), 2);
    assert.equal(lineRows(progress(ShareStep.Missed, ShareMiss.Failed)), 2);
    assert.equal(lineRows(progress(ShareStep.Missed, ShareMiss.KindNotShareable)), 1);
  });

  it("is under way at Send and Check only", () => {
    assert.equal(shareUnderway(progress(ShareStep.Send)), true);
    assert.equal(shareUnderway(progress(ShareStep.Check, ShareMiss.Checking)), true);
    assert.equal(shareUnderway(progress(ShareStep.Live)), false);
    assert.equal(shareUnderway(progress(ShareStep.Missed, ShareMiss.Failed)), false);
    assert.equal(shareUnderway(undefined), false);
  });
});

describe("a card's tag and Share", () => {
  it("wears Shared once on Play, else Saved, else nothing", () => {
    assert.equal(cardTagOf(state("a", { saved: true, shared: LIVE })), CardTag.Shared);
    assert.equal(cardTagOf(state("a", { saved: true, shared: { ...LIVE, live: false } })), CardTag.Saved);
    assert.equal(cardTagOf(state("a")), null);
    assert.equal(cardTagOf(null), null);
  });

  it("can save what the library says Save can act on, and nothing else", () => {
    assert.equal(canSave(state("a")), true);
    assert.equal(canSave(state("a", { generationId: null })), true, "a file genex.games takes from the app");
    assert.equal(canSave(state("a", { saveable: false })), false);
    assert.equal(canSave(null), false);
  });

  it("can share a Genex file not on Play yet, and nothing else", () => {
    assert.equal(canShare(state("a")), true);
    assert.equal(canShare(state("a", { shared: LIVE })), false);
    assert.equal(canShare(state("a", { shareable: false })), false);
    assert.equal(canShare(null), false);
  });
});

describe("picking several cards", () => {
  it("starts from the card a plain click selected, and a second click on a card takes it out", () => {
    const first = toggledSelection(new Set(), "a", "b");
    assert.deepEqual([...first].sort(), ["a", "b"]);
    assert.deepEqual([...toggledSelection(first, null, "a")], ["b"]);
  });

  it("picks the one card when nothing was selected", () => {
    assert.deepEqual([...toggledSelection(new Set(), null, "a")], ["a"]);
    assert.deepEqual([...toggledSelection(new Set(["a"]), null, "a")], []);
  });

  it("keeps the picked set as it is once picking began, whatever was selected", () => {
    assert.deepEqual([...toggledSelection(new Set(["b"]), "a", "c")].sort(), ["b", "c"]);
  });

  it("saves the picked files not saved yet and shares the ones Share can take", () => {
    const dropped = state("dropped", { shareable: false, generationId: null });
    const library = game([
      state("saved", { saved: true }),
      state("fresh"),
      state("live", { shared: LIVE }),
      dropped,
      state("other", { shareable: false, generationId: null, saveable: false }),
    ]);
    const actions = selectionActions(library, new Set(["saved", "fresh", "live", "dropped", "other", "unknown"]));
    assert.deepEqual(actions.save, ["fresh", "live", "dropped"], "not what genex.games would not take");
    assert.deepEqual(actions.share, ["saved", "fresh"], "a saved file can still be shared");
  });

  it("does not share again what is being shared", () => {
    const actions = selectionActions(game([state("a"), state("b")]), new Set(["a", "b"]), {
      a: progress(ShareStep.Check, ShareMiss.Checking),
      b: progress(ShareStep.Missed, ShareMiss.Failed),
    });
    assert.deepEqual(actions.share, ["b"]);
  });

  it("acts on nothing while the library is unread (signed out)", () => {
    const actions = selectionActions(game([state("fresh")], true), new Set(["fresh"]));
    assert.deepEqual(actions, { save: [], share: [] });
  });
});

describe("the share window's names", () => {
  it("offers what the asset was made from, else its file name as words without Genex's id", () => {
    assert.equal(offeredName(asset("assets/x.glb", { prompt: "giant mushroom tree\nsecond" })), "Giant mushroom tree");
    assert.equal(offeredName(asset("assets/genex/6f1d2c3a-0b4e/silt-strider-ab12cd34.glb")), "Silt strider");
  });

  it("trims a typed name to what Play takes, and sends nothing while one is empty", () => {
    assert.equal(cleanName(`  ${"a".repeat(100)}  `).length, 80);
    assert.equal(shareItemsOf([{ file: "a", name: "  " }]), null);
    assert.deepEqual(shareItemsOf([{ file: "a", name: " Hut " }]), [{ file: "a", name: "Hut" }]);
  });

  it("opens a shared asset's page on genex.games", () => {
    assert.equal(sharedAssetUrl("https://genex.games", "chitin-hut"), "https://genex.games/world/chitin-hut");
  });
});

describe("search", () => {
  const assets = [
    asset("assets/genex/1/giant-mushroom-tree.glb"),
    asset("assets/stone-path.png", { kind: "image" }),
    asset("assets/genex/2/x.glb", { prompt: "Mossy stone arch" }),
  ];

  it("finds this game's cards by every word, in the file's name or what it was made from", () => {
    assert.deepEqual(
      gameMatches(assets, "Stone").map((found) => found.file),
      ["assets/stone-path.png", "assets/genex/2/x.glb"],
    );
    assert.deepEqual(
      gameMatches(assets, "mushroom tree").map((found) => found.file),
      ["assets/genex/1/giant-mushroom-tree.glb"],
    );
    assert.deepEqual(gameMatches(assets, "   "), []);
    assert.deepEqual(gameMatches(assets, "gothic"), []);
  });

  it("leaves out of My library what this game holds already", () => {
    const row = (id: string): LibraryAsset => ({
      id,
      kind: LibraryKind.Model,
      title: id,
      thumbnailUrl: null,
      fileUrl: null,
      fileKind: null,
      fileFormat: null,
      saved: false,
      shared: null,
      shareable: true,
      createdAt: "2026-10-17T00:00:00Z",
    });
    const inGame = generationsInGame(
      [asset("a.glb", { generationId: "g1" })],
      game([state("b", { generationId: "g2" })]),
    );
    assert.deepEqual([...inGame].sort(), ["g1", "g2"]);
    assert.deepEqual(
      libraryMatches([row("g1"), row("g2"), row("g3")], inGame).map((found) => found.id),
      ["g3"],
    );
  });

  it("leaves out of Community what this game shared itself", () => {
    const shared = (slug: string): PlayGame => ({
      id: slug,
      slug,
      title: slug,
      description: "",
      coverUrl: null,
      clipUrl: null,
      multiplayer: false,
      plays: 0,
      online: null,
      author: { id: null, name: "x", imageUrl: null },
      remixable: false,
      assetKind: LibraryKind.Model,
    });
    const found = communityMatches(
      [shared("chitin-hut"), shared("stone-fireplace")],
      game([state("h", { shared: LIVE })]),
    );
    assert.deepEqual(
      found.map((item) => item.slug),
      ["stone-fireplace"],
    );
  });

  it("caps each group", () => {
    const many = Array.from({ length: SEARCH_GROUP_MAX + 5 }, (_, i) => asset(`assets/stone-${i}.png`));
    assert.equal(gameMatches(many, "stone").length, SEARCH_GROUP_MAX);
  });
});
