/**
 * Usage analytics, phase 3 (P5): a game or a folder for one that was refused says why. Main
 * refuses a game's location, a folder to open, a rename, a pin, a new games folder and an export
 * with a typed code beside the same words (`WorkspaceRefusal`, `ExportRefusal`); the code crosses
 * IPC and reaches `game_launch_failed`, `game_location_picked`, `open_folder_picked`,
 * `open_folder_sheet_closed`, `game_managed`, `games_root_changed` and `game_export_finished`.
 * Words, paths and Node codes read as none.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CodedError, errorMessage } from "../../src/shared/errors.ts";
import { ExportRefusal, WorkspaceRefusal } from "../../src/shared/game-library.ts";
import { exportPublicGame } from "../../src/substrate/game-export.ts";
import {
  exportCode,
  exportFinishedProperties,
  gameManagedProperties,
  launchFailedProperties,
  sheetClosedProperties,
  workspaceCode,
} from "../../src/renderer/analytics/workspace-properties.ts";
import {
  ActionOutcome,
  FolderPickOutcome,
  GameAction,
  LaunchFailReason,
  LaunchStage,
  ManageVia,
  SheetOutcome,
} from "../../src/renderer/analytics/workspace-vocabulary.ts";
import { inspectPickedFolder } from "../../src/renderer/open-folder.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { assertClean, crossed, HOSTILE_THROWS, refusalOf } from "../helpers/failure-codes.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

/** A refusal's code as the renderer reads it, after crossing IPC. */
const codeOf = async (call: Promise<unknown>) => workspaceCode(await refusalOf(call));

describe("phase 3 analytics: a refused game or folder says why", () => {
  it("main refuses a location, a folder, a rename, a pin and a games folder with a code beside the same words", async () => {
    const lite = await coreLite();
    const { core } = lite;
    try {
      const game = await core.games.scaffold("orchard");
      const away = await tmpDir("workspace-codes-");
      const file = path.join(away, "notes.txt");
      await writeFile(file, "x\n");
      assert.equal(await codeOf(core.games.location("relative/folder")), WorkspaceRefusal.LocationRefused);
      assert.equal(await codeOf(core.games.location(path.join(away, "gone"))), WorkspaceRefusal.LocationGone);
      assert.equal(await codeOf(core.games.location(file)), WorkspaceRefusal.LocationNotFolder);
      assert.equal(await codeOf(core.games.location(game.dir)), WorkspaceRefusal.InsideGame);
      const located = await refusalOf(core.games.location(file));
      assert.equal(errorMessage(located), "Choose a folder, not a file.", "the words stay as they were");
      assert.equal(await codeOf(core.games.inspect(lite.userData)), WorkspaceRefusal.BannedFolder);
      assert.equal(await codeOf(core.games.adopt(away, { subdir: "../elsewhere" })), WorkspaceRefusal.SubdirIsPath);
      assert.equal(await codeOf(core.games.adopt(away, { subdir: "nowhere" })), WorkspaceRefusal.NoSuchSubdir);
      assert.equal(await codeOf(core.updateGame("orchard", { title: "" })), WorkspaceRefusal.InvalidTitle);
      const pinned = { pinned: "yes" } as unknown as { pinned: boolean };
      assert.equal(await codeOf(core.updateGame("orchard", pinned)), WorkspaceRefusal.InvalidPin);
      const crowded = await tmpDir("workspace-root-");
      await mkdir(path.join(crowded, "someone-elses"));
      assert.equal(await codeOf(core.games.changeRoot(crowded)), WorkspaceRefusal.RootNotEmpty);
      assert.equal(await codeOf(core.createGame("")), WorkspaceRefusal.InvalidTitle);
    } finally {
      await lite.close();
    }
  });

  it("a game whose folder is gone is refused as gone, never with a Node error naming its path", async () => {
    const lite = await coreLite();
    const { core } = lite;
    try {
      const game = await core.games.scaffold("orchard");
      await removeTree(game.dir);
      const gone = await refusalOf(core.updateGame("orchard", { title: "Autumn orchard" }));
      assert.equal(workspaceCode(gone), WorkspaceRefusal.FolderGone);
      assert.ok(!errorMessage(gone).includes(lite.gamesRoot), "the words name no path");
    } finally {
      await lite.close();
    }
  });

  it("main refuses an export with a code: an unknown game, a target inside it, a missing public file, a held secret", async () => {
    const lite = await coreLite();
    const { core } = lite;
    try {
      const target = await tmpDir("workspace-export-");
      assert.equal(
        exportCode(await refusalOf(core.exportPublicCopy("nowhere", target))),
        WorkspaceRefusal.GameNotFound,
      );
      const source = await tmpDir("workspace-export-source-");
      await writeFile(path.join(source, "index.html"), "<p>sk-live-0123456789abcdefghij</p>\n");
      const inside = exportPublicGame(source, path.join(source, "out"), ["index.html"]);
      assert.equal(exportCode(await refusalOf(inside)), ExportRefusal.TargetInsideGame);
      const missing = exportPublicGame(source, path.join(target, "a"), ["missing.html"]);
      assert.equal(exportCode(await refusalOf(missing)), ExportRefusal.PublicPathMissing);
      const secret = exportPublicGame(source, path.join(target, "b"), ["index.html"], undefined, {
        secretValues: ["sk-live-0123456789abcdefghij"],
      });
      const leaked = await refusalOf(secret);
      assert.equal(exportCode(leaked), ExportRefusal.SecretLeaked);
    } finally {
      await lite.close();
    }
  });

  it("each event carries the refusal's code only when it failed, and nothing else ever", async () => {
    const refused = await crossed(new CodedError(WorkspaceRefusal.LocationRefused, "Studio can't create games there."));
    const launch = { stage: LaunchStage.Creating, reason: LaunchFailReason.CreateRefused, startedAt: 10, at: 25 };
    assert.deepEqual(launchFailedProperties({ ...launch, customLocation: true, failure: refused }), {
      stage: LaunchStage.Creating,
      reason: LaunchFailReason.CreateRefused,
      elapsed_ms: 15,
      custom_location: true,
      code: WorkspaceRefusal.LocationRefused,
    });
    const gone = await crossed(new CodedError(WorkspaceRefusal.FolderGone, "This game folder is no longer available."));
    const managed = { action: GameAction.Renamed, via: ManageVia.Menu, game: null, at: 0, ref: null };
    assert.equal(
      gameManagedProperties({ ...managed, outcome: ActionOutcome.Failed, failure: gone }).code,
      WorkspaceRefusal.FolderGone,
    );
    assert.equal(gameManagedProperties({ ...managed, outcome: ActionOutcome.Ok }).code, undefined);
    const facts = { shownAt: 0, changedOption: false, detailsOpened: false, trustToggled: false, kind: null };
    const banned = await crossed(new CodedError(WorkspaceRefusal.BannedFolder, "pick a project folder"));
    const closed = { outcome: SheetOutcome.Failed, at: 9, adoptStartedAt: 4, failure: banned };
    assert.equal(sheetClosedProperties(facts, closed).code, WorkspaceRefusal.BannedFolder);
    const secret = await crossed(new CodedError(ExportRefusal.SecretLeaked, "Export stopped: index.html contains…"));
    const timing = { startedAt: 0, at: 5, ref: null };
    assert.equal(exportFinishedProperties(null, timing, secret).code, ExportRefusal.SecretLeaked);
    assert.equal(exportFinishedProperties({ files: 3, excluded: [] }, timing).code, undefined);
    const picked: unknown[] = [];
    const inspecting = inspectPickedFolder(
      { pickProject: async () => "/Users/alice/Secret Game", inspectFolder: () => Promise.reject(banned) },
      (report) => picked.push(report),
      () => 0,
    );
    await assert.rejects(inspecting);
    assert.deepEqual(picked, [
      { outcome: FolderPickOutcome.Refused, pick_ms: 0, inspect_ms: 0, code: WorkspaceRefusal.BannedFolder },
    ]);
  });

  it("words, paths and Node codes read as no code in every workspace event", async () => {
    const facts = { shownAt: 0, changedOption: false, detailsOpened: false, trustToggled: false, kind: null };
    for (const [label, thrown] of HOSTILE_THROWS) {
      const failure = await crossed(thrown);
      assert.equal(workspaceCode(failure), null, label);
      assert.equal(exportCode(failure), null, label);
      const launch = launchFailedProperties({
        stage: LaunchStage.Opening,
        reason: LaunchFailReason.OpenRefused,
        startedAt: 0,
        at: 1,
        customLocation: false,
        failure,
      });
      assert.equal(launch.code, null, label);
      assertClean(label, launch);
      const managed = gameManagedProperties({
        action: GameAction.Removed,
        via: ManageVia.Menu,
        outcome: ActionOutcome.Failed,
        game: null,
        at: 0,
        ref: null,
        failure,
      });
      assert.equal(managed.code, null, label);
      assertClean(label, managed);
      const closed = sheetClosedProperties(facts, { outcome: SheetOutcome.Failed, at: 1, failure });
      assert.equal(closed.code, null, label);
      assertClean(label, closed);
      const exported = exportFinishedProperties(null, { startedAt: 0, at: 1, ref: null }, failure);
      assert.equal(exported.code, null, label);
      assertClean(label, exported);
    }
    const rewind = await crossed(new CodedError(ExportRefusal.NoEntry, "Export needs index.html"));
    assert.equal(workspaceCode(rewind), null, "an export's refusal is not the library's");
  });
});
