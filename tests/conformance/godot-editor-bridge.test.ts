/**
 * The person's own Godot editor at Genex's moments, through the Genex addon's editor plugin
 * (`editor-bridge.ts`, played here by `editorStandIn` on the fixture's clock): before a checkpoint
 * or a restore it saves what is open, after a restore it reloads; an editor that isn't open, stopped
 * beating or never answers is asked nothing or noted, and a restore waits for the person rather than
 * replace work the editor still holds. Nothing is written through a link.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GodotTool } from "../../src/plugins/godot/backend.ts";
import { ANSWER_WAIT_MS, HEARTBEAT_FRESH_MS } from "../../src/plugins/godot/editor-bridge.ts";
import { HookEvent, type HookEvent as Moment } from "../../src/shared/plugin-hooks.ts";
import { editorStandIn, godotBackendFixture } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A game with a Godot project New Godot game made, and the backend's answer at a moment. */
async function gameWithProject() {
  const fixture = await godotBackendFixture();
  await fixture.backend.tool?.(GodotTool.NewGame, { template: "2d", name: "Moon" }, fixture.context());
  const project = path.join(fixture.gameDir, "godot");
  const at = async (tool: string, on: Moment) =>
    (await fixture.backend.tool?.(tool, {}, fixture.context({ hook: { on } }))) as Record<string, unknown>;
  return { ...fixture, project, at };
}

const SAVED = { ok: true, savedScripts: 1, unsavedScripts: 0 };

describe("the person's Godot editor at Genex's moments", () => {
  it("asks no editor that isn't open or stopped beating", async () => {
    const game = await gameWithProject();
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.CheckpointBefore), {});
    assert.deepEqual(await game.at(GodotTool.ReloadEditor, HookEvent.RestoreAfter), {});
    const editor = await editorStandIn(game.editor, game.project, () => SAVED);
    game.editor.clock.at += HEARTBEAT_FRESH_MS + 1;
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.RestoreBefore), {}, "a heartbeat gone stale");
    assert.deepEqual(editor.asked, []);
  });

  it("saves before a checkpoint and a restore, and reloads after a restore, leaving no file behind", async () => {
    const game = await gameWithProject();
    const editor = await editorStandIn(game.editor, game.project, (op) =>
      op === "reload" ? { ok: true, reloadedScenes: 1 } : SAVED,
    );
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.CheckpointBefore), {});
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.RestoreBefore), {});
    assert.deepEqual(await game.at(GodotTool.ReloadEditor, HookEvent.RestoreAfter), {});
    assert.deepEqual(
      await game.at(GodotTool.ReloadEditor, HookEvent.CheckpointAfter),
      {},
      "reloads only after a restore",
    );
    assert.deepEqual(editor.asked, ["save", "save", "reload"]);
    assert.deepEqual(await readdir(editor.folder), ["editor.json"]);
  });

  it("notes unsaved scripts at a checkpoint, and holds a restore until the person saves them", async () => {
    const game = await gameWithProject();
    await editorStandIn(game.editor, game.project, () => ({ ok: true, savedScripts: 0, unsavedScripts: 2 }));
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.CheckpointBefore), {
      note: "2 scripts open in Godot with unsaved changes aren't in this save point.",
    });
    assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.RestoreBefore), {
      block: "Your Godot editor holds 2 scripts with changes Genex couldn't save: save them in Godot, then try again.",
    });
  });

  it("an editor that never answers is noted, holds a restore, and its ask is taken back", async () => {
    const game = await gameWithProject();
    const editor = await editorStandIn(game.editor, game.project, () => null);
    const started = game.editor.clock.at;
    assert.match(String((await game.at(GodotTool.SaveAll, HookEvent.CheckpointBefore)).note), /didn't answer/);
    assert.ok(game.editor.clock.at - started >= ANSWER_WAIT_MS, "it waited the answer's time");
    await editor.beat();
    assert.match(String((await game.at(GodotTool.SaveAll, HookEvent.RestoreBefore)).block), /won't rewind/);
    await editor.beat();
    assert.match(String((await game.at(GodotTool.ReloadEditor, HookEvent.RestoreAfter)).note), /offer to reload/);
    assert.deepEqual(await readdir(editor.folder), ["editor.json"]);
  });

  it("writes nothing through a link: a bridge folder or a cache that is one counts as no editor", async () => {
    for (const what of ["the bridge folder", "Godot's cache"]) {
      const game = await gameWithProject();
      const outside = await tmpDir("studio-godot-bridge-outside-");
      const beat = JSON.stringify({ at: game.editor.clock.at, playing: false, unsavedScripts: 0 });
      await mkdir(path.join(outside, "genex"), { recursive: true });
      await writeFile(path.join(outside, "editor.json"), beat);
      await writeFile(path.join(outside, "genex", "editor.json"), beat);
      const cache = path.join(game.project, ".godot");
      await rm(cache, { recursive: true, force: true });
      if (what === "Godot's cache") await symlink(outside, cache);
      else {
        await mkdir(cache);
        await symlink(outside, path.join(cache, "genex"));
      }
      assert.deepEqual(await game.at(GodotTool.SaveAll, HookEvent.RestoreBefore), {}, what);
      assert.deepEqual((await readdir(outside)).sort(), ["editor.json", "genex"], what);
      assert.deepEqual(await readdir(path.join(outside, "genex")), ["editor.json"], what);
    }
  });
});
