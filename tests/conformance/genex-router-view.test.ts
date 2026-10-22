/**
 * The Plugins page as the router shows it: the router's own name and line on Genex's row and page,
 * its picture (eight routed tools on a 2×2 board that is never empty), and the catalog's Plugins and
 * Community plugins.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import type { PluginIndexEntry, PluginInfo } from "../../src/shared/plugins.ts";
import {
  CommunityView,
  catalogShelves,
  communityIds,
  communityView,
  installedSteps,
  listingSteps,
  needsSetup,
} from "../../src/renderer/panels/plugins/labels.ts";
import { PLUGINS_WORDS } from "../../src/renderer/words.ts";
import { routerLine, shownDescription, shownIntro, shownName } from "../../src/renderer/panels/plugins/labels.ts";
import { BOARD_CELLS, boardMoves, pieceFrames } from "../../src/renderer/panels/plugins/genex/router-icon.ts";
import { ICON_TOOLS, ROUTED_TOOLS } from "../../src/renderer/panels/plugins/genex/routed-tools.ts";

const plugin = (id: string, name: string, description: string): PluginInfo =>
  ({ manifest: { id, name, description, publisher: "Someone" } }) as unknown as PluginInfo;

describe("Genex's row and page name the router", () => {
  it("shows Genex as the Genex plugin, the game dev tools router, connected as the account on its page", () => {
    const genex = plugin(GENEX_PLUGIN_ID, "Genex plugin", "3D models, characters, sound and art…");
    assert.equal(shownName(genex), "Genex plugin");
    assert.equal(shownIntro(genex), "Game dev tools router");
    assert.equal(shownIntro(genex, "Rab Neba"), "Game dev tools router · connected as Rab Neba");
  });

  it("says on Genex's row what its switch does: tools for the agent, never the account", () => {
    const genex = plugin(GENEX_PLUGIN_ID, "Genex plugin", "3D models, characters, sound and art…");
    const on = { ...genex, enabled: true, removed: false };
    const off = { ...genex, enabled: false, removed: false };
    assert.deepEqual(routerLine(on), {
      lead: "Tools for your agent: 3D, textures, animation, music, multiplayer.",
      tail: "Uses your Genex account.",
    });
    assert.deepEqual(routerLine(off), {
      lead: "Off. Your agent can't use Genex tools.",
      tail: "Your profile, friends and Publish stay.",
    });
    assert.equal(
      shownDescription(on),
      "Tools for your agent: 3D, textures, animation, music, multiplayer. Uses your Genex account.",
    );
    assert.equal(
      shownDescription(off),
      "Off. Your agent can't use Genex tools. Your profile, friends and Publish stay.",
    );
  });

  it("leaves every other plugin's own name and description alone", () => {
    const blender = plugin("blender", "Local Blender", "Model 3D assets with Blender on this Mac.");
    assert.equal(shownName(blender), "Local Blender");
    assert.equal(shownDescription(blender), "Model 3D assets with Blender on this Mac.");
  });
});

describe("the router's picture", () => {
  const moves = boardMoves(ICON_TOOLS.length);

  /** Where every piece is after each move, replaying the moves from the start cells. */
  const replay = (): Array<Map<number, readonly [number, number]>> => {
    const at = new Map<number, readonly [number, number]>(BOARD_CELLS.map((cell, piece) => [piece, cell]));
    const boards: Array<Map<number, readonly [number, number]>> = [];
    for (const move of moves) {
      for (const step of move) at.set(step.piece, step.to);
      boards.push(new Map(at));
    }
    return boards;
  };
  const onBoard = (cell: readonly [number, number]): boolean =>
    cell[0] >= 0 && cell[0] <= 1 && cell[1] >= 0 && cell[1] <= 1;

  it("is never empty: after every move exactly four tools fill the four cells", () => {
    for (const board of replay()) {
      const filled = [...board.values()].filter(onBoard).map((c) => c.join(","));
      assert.equal(filled.length, 4);
      assert.equal(new Set(filled).size, 4);
    }
  });

  it("brings every routed tool onto the board, and ends where it began so the loop has no seam", () => {
    const boards = replay();
    const seen = new Set<number>();
    for (const board of boards) for (const [piece, cell] of board) if (onBoard(cell)) seen.add(piece);
    assert.equal(seen.size, ICON_TOOLS.length);
    const last = boards.at(-1);
    for (const [piece, cell] of BOARD_CELLS.entries()) assert.deepEqual(last?.get(piece), cell);
  });

  it("gives each tool a timeline from 0 to 1 that starts and ends in the same place", () => {
    const frames = pieceFrames(ICON_TOOLS.length);
    assert.equal(frames.length, ICON_TOOLS.length);
    for (const timeline of frames) {
      assert.equal(timeline[0]?.offset, 0);
      assert.equal(timeline.at(-1)?.offset, 1);
      const offsets = timeline.map((frame) => frame.offset);
      assert.deepEqual(
        offsets,
        [...offsets].sort((a, b) => a - b),
      );
      assert.equal(new Set(offsets).size, offsets.length);
      assert.deepEqual(timeline.at(-1)?.cell, timeline[0]?.cell);
    }
  });

  it("only jumps while a tool is off the board, never across it", () => {
    for (const timeline of pieceFrames(ICON_TOOLS.length))
      for (const [i, frame] of timeline.entries()) {
        if (!frame.jump) continue;
        assert.ok(!onBoard(frame.cell), "a jump starts off the board");
        const next = timeline[i + 1];
        assert.ok(next && !onBoard(next.cell), "and lands off the board");
      }
  });

  it("draws only tools the router really routes", () => {
    const routed = new Set(ROUTED_TOOLS.map((t) => t.id));
    for (const id of ICON_TOOLS) assert.ok(routed.has(id), id);
  });
});

describe("Plugins and Community plugins below the MCP servers", () => {
  const index = { entries: [], updates: [], studioVersion: "1.0.0" } as never;
  const entry = (id: string, tier: PluginIndexEntry["tier"]) => ({ id, tier }) as PluginIndexEntry;

  it("files the catalog's official plugins under Plugins and everyone else's under Community plugins", () => {
    const shelves = catalogShelves([
      entry("genex", "official"),
      entry("acme-tool", "community"),
      entry("acme", "community"),
    ]);
    assert.deepEqual(
      shelves.ours.map((e) => e.id),
      ["genex"],
    );
    assert.deepEqual(
      shelves.community.map((e) => e.id),
      ["acme-tool", "acme"],
    );
  });
  it("shows Community plugins as coming soon while the catalog has none you don't have", () => {
    assert.equal(communityView({ index, entries: 0 }), CommunityView.Soon);
  });
  it("lists the community's plugins once the catalog has one", () => {
    assert.equal(communityView({ index, entries: 1 }), CommunityView.List);
  });
  it("stays coming soon while the catalog loads or can't be read: nothing else shows there yet", () => {
    assert.equal(communityView({ index: null, entries: 0 }), CommunityView.Soon);
    const failed = { ...(index as object), error: "offline" } as never;
    assert.equal(communityView({ index: failed, entries: 0 }), CommunityView.Soon);
  });
});

describe("a community plugin's page before it is installed", () => {
  const entry = (fields: Partial<PluginIndexEntry>) =>
    ({ id: "acme-tool", name: "Tool", capabilities: [], ...fields }) as PluginIndexEntry;
  const WORDS = PLUGINS_WORDS.listing;

  it("starts with Genex's install step and ends with when it is ready, its author's steps between", () => {
    assert.deepEqual(listingSteps(entry({ setup: ["Paste your key on its page."] })), [
      WORDS.installStep,
      "Paste your key on its page.",
      WORDS.readyStep,
    ]);
  });
  it("asks to connect the account when the plugin needs one and its author wrote no steps", () => {
    assert.deepEqual(listingSteps(entry({ capabilities: ["credentials"] })), [
      WORDS.installStep,
      WORDS.connectStep("Tool"),
      WORDS.readyStep,
    ]);
    assert.deepEqual(listingSteps(entry({})), [WORDS.installStep, WORDS.readyStep]);
  });
  it("keeps installed community plugins in Community plugins, not in Installed", () => {
    const index = {
      entries: [entry({ id: "genex", tier: "official" }), entry({ id: "acme-tool", tier: "community" })],
    } as never;
    assert.deepEqual([...communityIds(index)], ["acme-tool"]);
    assert.deepEqual([...communityIds(null)], [], "with no catalog, every installed plugin stays under Installed");
  });
});

describe("an installed plugin's page and tile after Install", () => {
  const WORDS = PLUGINS_WORDS.listing;
  const installed = (manifest: object, enabled = true) =>
    ({ enabled, manifest: { id: "acme-tool", name: "Tool", capabilities: [], ...manifest } }) as unknown as PluginInfo;
  const ACCOUNT = { connect: "c", unlock: "u", disconnect: "d", status: "s" };

  it("keeps its author's steps, with Install ticked off", () => {
    assert.deepEqual(installedSteps(installed({ setup: ["Paste your key on its page."] }).manifest), [
      { text: WORDS.installedStep, done: true },
      { text: "Paste your key on its page.", done: false },
      { text: WORDS.readyStep, done: false },
    ]);
  });
  it("shows no steps for a plugin that has nothing to set up", () => {
    assert.deepEqual(installedSteps(installed({}).manifest), []);
  });
  it("needs setup while its account is not connected, and not once it is", () => {
    const plugin = installed({ account: ACCOUNT });
    assert.equal(needsSetup(plugin, "not connected"), true);
    assert.equal(needsSetup(plugin, "locked"), true);
    assert.equal(needsSetup(plugin, "failed"), true);
    assert.equal(needsSetup(plugin, "unlocked"), false);
    assert.equal(needsSetup(plugin, "authorizing"), false, "the browser step is under way");
    assert.equal(needsSetup(installed({ account: ACCOUNT }, false), "not connected"), false, "off is off, not unset");
    assert.equal(needsSetup(installed({}), "not connected"), false, "a plugin with no account has nothing to connect");
  });
});
