/**
 * The roblox-game fixture: the fixture game linked to a stand-in Roblox place at its top, with the
 * bundled Roblox Studio plugin turned on. Its chat shows the link line (with Undo) and offers the
 * steps card, whose rows come live from the real plugin on this machine, as does the toolbar's
 * Roblox Studio button. The place was just published for the first time (the publishing card shows
 * who can open it yet, with Creator Hub), and the chat shows a Roblox account card the person
 * answered with Allow in this chat. Dev fixtures may name a bundled plugin to turn it on and seed its records;
 * this one holds data only. No Studio is opened, set up or signed in to: the place file is a
 * stand-in, and Set up, Open Studio and every other action that reaches the computer are native, so
 * a fixture refuses them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { ROBLOX_PLUGIN_ID } from "../../shared/observers.ts";
import { PluginService } from "../../shared/plugins.ts";
import { RobloxPublishKind, RobloxPublishPhase } from "../../shared/roblox-publish.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import type { StudioCore } from "../studio-core.ts";

/** The stand-in place: an empty place in Roblox's XML format, at the game's top as Roblox keeps one. */
const PLACE_FILE = "FixtureGame.rbxlx";
const PLACE =
  '<roblox version="4">\n\t<Item class="Workspace" referent="RBX0">\n\t\t<Properties>\n\t\t\t<string name="Name">Workspace</string>\n\t\t</Properties>\n\t</Item>\n</roblox>\n';

/** The stand-in place as Roblox has it after its first publish. */
const REMOTE = { placeId: "99252242680156", universeId: "10773160217" };
/** The first publish's record, where the Roblox plugin keeps it (`publish-attempt.ts`). */
const ATTEMPTS_FOLDER = "publish-attempts";
/** An account tool's card, as the Roblox plugin's `import-model` asks it; answered Allow in this chat. */
const ACCOUNT_CARD = {
  consentId: "fixture-roblox-import-model",
  pluginId: ROBLOX_PLUGIN_ID,
  pluginName: "Roblox Studio",
  tool: `${ROBLOX_PLUGIN_ID}__import-model`,
  args: { file: "assets/genex/bazooka.glb" },
  prompt:
    "Add this model to the game's place? Genex checks it first, then Studio adds it. It is uploaded to your Roblox account when you publish the place, and Roblox moderates it there.",
  chatOffered: true,
} as const;

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
  await core.engineLinks.link(ROBLOX_PLUGIN_ID, binding, { project: file, auto: true, remote: REMOTE });
  await core.engineLinks.steps(ROBLOX_PLUGIN_ID, binding);
  const storage = String(await core.plugins.service(ROBLOX_PLUGIN_ID, PluginService.StorageRoot, {}));
  await mkdir(path.join(storage, ATTEMPTS_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(path.join(storage, ATTEMPTS_FOLDER, `${project.name}.json`), {
    phase: RobloxPublishPhase.Published,
    kind: RobloxPublishKind.First,
    at: Date.now(),
    name: "Fixture Game",
  });
  const card = { ...ACCOUNT_CARD, project: project.name, threadId };
  await core.append(
    [
      customEventData(CustomEvent.PluginConsent, { ...card, state: "pending" }),
      customEventData(CustomEvent.PluginConsent, { ...card, state: "approved", by: "user", always: true }),
    ],
    threadId,
  );
}
