/**
 * An Unreal game made in Genex could not be made server-authoritative: the app shipped no Unreal
 * client for Genex rooms, and a sandboxed job may fetch none. Now the app ships Genex's own
 * `GenexMultiplayer` Unreal plugin, vendored from the Genex SDK (`sdks/unreal/GenexMultiplayer`)
 * at a pinned commit by `scripts/vendor-unreal-multiplayer.ts`.
 *
 * Byte identity is checked the way git itself names a folder: the vendored folder's git tree id,
 * computed here from the bytes on disk and the pin's file modes, must be the tree id the pinned
 * commit gives `sdks/unreal/GenexMultiplayer`. A changed, missing or extra byte changes the id.
 */
import assert from "node:assert/strict";
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  readUnrealMultiplayerPin,
  UNREAL_MULTIPLAYER_DIR,
  vendoredTreeId,
} from "../../scripts/vendor-unreal-multiplayer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const COMMIT = /^[0-9a-f]{40}$/;

describe("the app ships Genex's Unreal multiplayer plugin at its pin", () => {
  it("pins a Genex SDK commit and the plugin's tree there", async () => {
    const pin = await readUnrealMultiplayerPin();
    assert.equal(pin.source, "me-ai-org/genex-demo");
    assert.equal(pin.path, "sdks/unreal/GenexMultiplayer");
    assert.match(pin.commit, COMMIT);
    assert.match(pin.tree, COMMIT);
  });

  it("holds the pinned tree byte for byte", async () => {
    const pin = await readUnrealMultiplayerPin();
    assert.equal(await vendoredTreeId(UNREAL_MULTIPLAYER_DIR, pin.executables), pin.tree);
  });

  it("names any changed, extra or missing byte by a different tree", async () => {
    const pin = await readUnrealMultiplayerPin();
    const cases: Array<[string, (dir: string) => Promise<void>]> = [
      ["a changed source byte", (dir) => writeFile(path.join(dir, "GenexMultiplayer.uplugin"), "{}")],
      ["an extra file", (dir) => writeFile(path.join(dir, "Source", "Extra.h"), "#pragma once\n")],
      [
        "a CRLF checkout of a text file",
        async (dir) => {
          const file = path.join(dir, "Config", "FilterPlugin.ini");
          const { readFile } = await import("node:fs/promises");
          await writeFile(file, (await readFile(file, "utf8")).replaceAll("\n", "\r\n"));
        },
      ],
    ];
    for (const [name, change] of cases) {
      const dir = path.join(await tmpDir("studio-unreal-mp-vendor-"), "GenexMultiplayer");
      await cp(UNREAL_MULTIPLAYER_DIR, dir, { recursive: true });
      await change(dir);
      assert.notEqual(await vendoredTreeId(dir, pin.executables), pin.tree, name);
    }
  });
});
