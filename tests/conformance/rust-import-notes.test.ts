// A file the import step left out of a Rust build (B8) is said on the game's console, with the
// refusal's code and what to do. Before, a GLB the agent wrote under `assets/` that the glTF gate
// refused left the stage silently, and the game only read it as `missing: … was not fetched`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssetImportRefusal } from "../../src/shared/game-assets.ts";
import { ImportAction, ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { type StagedImportReport, StagePlacementRefusal } from "../../src/main/rust-assets.ts";
import { IMPORT_REFUSAL_REMEDY, importRefusalNotes } from "../../src/main/rust-import-notes.ts";

const report = (files: StagedImportReport["files"]): StagedImportReport => ({ jobs: 1, ms: 1, files });

describe("the import step's refusals on the game's console", () => {
  it("a GLB the gate refused is named with its code, the validator's codes and the remedy", () => {
    const notes = importRefusalNotes(
      report([
        { file: "assets/ok.glb", action: ImportAction.Normalize, converter: ImportConverter.GltfDecompress },
        {
          file: "assets/gunman/gunman_anim.glb",
          action: ImportAction.Normalize,
          converter: ImportConverter.GltfDecompress,
          refusal: AssetImportRefusal.ValidationFailed,
          detail: "ACCESSOR_INDEX_OOB, UNRESOLVED_REFERENCE",
        },
      ]),
    );
    assert.equal(notes.length, 1, "only the refused file");
    const [note = ""] = notes;
    assert.match(note, /assets\/gunman\/gunman_anim\.glb/);
    assert.match(note, /validation-failed/);
    assert.match(note, /ACCESSOR_INDEX_OOB, UNRESOLVED_REFERENCE/);
    assert.ok(note.includes(IMPORT_REFUSAL_REMEDY[AssetImportRefusal.ValidationFailed]), note);
  });

  it("every refusal the step can record has a remedy", () => {
    const codes = [...Object.values(AssetImportRefusal), ...Object.values(StagePlacementRefusal)];
    for (const code of codes) assert.ok(IMPORT_REFUSAL_REMEDY[code]?.length, code);
  });

  it("a build that ran no import, or refused nothing, says nothing", () => {
    assert.deepEqual(importRefusalNotes(null), []);
    assert.deepEqual(importRefusalNotes(report([{ file: "assets/a.png", action: ImportAction.Keep }])), []);
  });

  it("a long refusal list is cut, and says how many more files it left out", () => {
    const files = Array.from({ length: 30 }, (_, at) => ({
      file: `assets/m${at}.glb`,
      action: ImportAction.Refuse,
      refusal: AssetImportRefusal.Malformed,
    }));
    const notes = importRefusalNotes(report(files));
    assert.ok(notes.length < 30, `${notes.length} notes`);
    assert.match(notes.at(-1) ?? "", /more/);
  });
});
