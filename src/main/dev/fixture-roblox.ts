/**
 * The roblox-game fixture: the fixture game linked to a stand-in Roblox place at its top, with the
 * bundled Roblox Studio plugin turned on. Its chat shows the link line (with Undo) and offers the
 * steps card, whose rows come live from the real plugin on this machine, as does the toolbar's
 * Roblox Studio button. Dev fixtures may name a bundled plugin to turn it on and seed its records;
 * this one holds data only. No Studio is opened, set up or signed in to: the place file is a
 * stand-in, and Set up, Open Studio and every other action that reaches the computer are native, so
 * a fixture refuses them.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ROBLOX_PLUGIN_ID } from "../../shared/observers.ts";
import type { StudioCore } from "../studio-core.ts";

/** The stand-in place: an empty place in Roblox's XML format, at the game's top as Roblox keeps one. */
const PLACE_FILE = "FixtureGame.rbxlx";
const PLACE =
  '<roblox version="4">\n\t<Item class="Workspace" referent="RBX0">\n\t\t<Properties>\n\t\t\t<string name="Name">Workspace</string>\n\t\t</Properties>\n\t</Item>\n</roblox>\n';

/** Turns Roblox Studio on, links the game to its stand-in place and offers the steps card in its chat. */
export async function seedRobloxGame(
  core: StudioCore,
  project: { name: string; dir: string },
  threadId: string,
): Promise<void> {
  const file = path.join(project.dir, PLACE_FILE);
  await writeFile(file, PLACE);
  await core.plugins.setEnabled(ROBLOX_PLUGIN_ID, true);
  const binding = { project: project.name, directory: project.dir, threadId };
  await core.engineLinks.link(ROBLOX_PLUGIN_ID, binding, { project: file, auto: true });
  await core.engineLinks.steps(ROBLOX_PLUGIN_ID, binding);
}
