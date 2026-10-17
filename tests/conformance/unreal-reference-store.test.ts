/**
 * The node reference and the Python names are exported once per engine by the Genex editor helper
 * and kept in the Unreal plugin's storage, so the builders' gate checks parts without the editor.
 * Pins read later are merged in. A file that isn't the reference's shape is never believed.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { ReferenceData } from "../../src/plugins/unreal/blueprint-reference.ts";
import { loadReference, mergePins, referencePaths, storeReference } from "../../src/plugins/unreal/reference-store.ts";
import { tmpDir } from "../helpers/tmp.ts";

const DATA: ReferenceData = {
  version: 1,
  engine: "5.8.3",
  common: ["Development|PrintString"],
  contexts: { "Actor/EventGraph": ["AddEvent|EventTick"] },
  pins: { "AddEvent|EventTick": { inputs: [], outputs: [["then", "Exec"]] } },
};

describe("the node reference in the plugin's storage", () => {
  it("is kept per engine and read back", async () => {
    const storage = await tmpDir("studio-reference-");
    assert.equal(await loadReference(storage, "5.8"), null, "none yet");
    await storeReference(storage, "5.8", DATA);
    assert.deepEqual(await loadReference(storage, "5.8"), DATA);
    assert.equal(await loadReference(storage, "5.7"), null);
  });

  it("merges pins read later without losing the names", async () => {
    const storage = await tmpDir("studio-reference-");
    await storeReference(storage, "5.8", DATA);
    await mergePins(storage, "5.8", { "Development|PrintString": { inputs: [["InString", "String"]], outputs: [] } });
    const merged = await loadReference(storage, "5.8");
    assert.deepEqual(merged?.common, DATA.common);
    assert.deepEqual(Object.keys(merged?.pins ?? {}).sort(), ["AddEvent|EventTick", "Development|PrintString"]);
  });

  it("refuses engine names that are paths, and files that aren't a reference", async () => {
    const storage = await tmpDir("studio-reference-");
    for (const engine of ["../5.8", "5.8/x", "", "latest"]) {
      assert.throws(() => referencePaths(storage, engine), Error, engine);
    }
    const { nodes } = referencePaths(storage, "5.8");
    await mkdir(path.dirname(nodes), { recursive: true });
    for (const text of ["{", "[]", JSON.stringify({ ...DATA, version: 2 }), JSON.stringify({ ...DATA, common: "x" })]) {
      await writeFile(nodes, text);
      assert.equal(await loadReference(storage, "5.8"), null, text);
    }
    assert.ok((await readFile(nodes, "utf8")).length > 0, "a bad file is left for a person to look at");
  });
});
