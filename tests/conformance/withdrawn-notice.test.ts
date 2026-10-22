/**
 * What a builder session is told about the plugins it is handed. Its brief names each one turned
 * on, by name, the prefix of its tools and what it does. A resumed session also hears what changed
 * since it last ran: a plugin switched off takes its tools and skills with it; a skill that no
 * longer applies to the game (a web-only skill once the game is an Unreal project) leaves its
 * plugin's tools in place, and the notice must never read as that plugin being off; a plugin turned
 * on is named once, by the first brief that hands it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  addedNotice,
  addedSince,
  type HandedPlugin,
  handedPluginsNote,
  withdrawnNotice,
  withdrawnSince,
} from "../../src/main/core/delegation-prompts.ts";
import { PluginAccountState, type PluginManifest } from "../../src/shared/plugins.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { accountPackage, EXAMPLE_PLUGIN, installLocalOn } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

/** How every notice of what changed since a resumed session last ran opens. */
const SINCE_LAST_RAN = "Studio notice: since this session last ran,";
/** How a plugin's line ends while the person has not connected its account yet. */
const NOT_SET_UP = "Not set up yet: the person still has to connect its account on its page.";

test("a skill that no longer applies to the game is withdrawn alone: its plugin stays on", () => {
  const before = {
    plugins: ["blender", "genex"],
    skills: ["blender/local-modeling", "genex/publishing", "genex/genex"],
  };
  const now = { plugins: ["blender", "genex", "unreal"], skills: ["genex/genex", "unreal/unreal-editor"] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  assert.match(notice, /blender\/local-modeling/);
  assert.match(notice, /genex\/publishing/);
  assert.doesNotMatch(notice, /no longer enabled|they are gone|do not call/i, notice);
  assert.match(notice, /still (on|enabled)/i, notice);
  assert.match(notice, /\bblender\b.*\bgenex\b|\bgenex\b.*\bblender\b/, "names the plugins that stay on");
  assert.doesNotMatch(notice, /\n\n/, "one paragraph");
});

test("a plugin switched off takes its tools and its skills with it", () => {
  const before = { plugins: ["blender", "genex"], skills: ["blender/local-modeling", "genex/genex"] };
  const now = { plugins: ["genex"], skills: ["genex/genex"] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  assert.match(notice, /no longer enabled/);
  assert.match(notice, /\bblender\b/);
  assert.match(notice, /blender\/local-modeling/);
  assert.match(notice, /do not call their tools/);
  assert.doesNotMatch(notice, /genex/, "nothing of a plugin still handed");
});

test("both at once: the plugin switched off, and another plugin's skill out of this game, in one paragraph", () => {
  const before = { plugins: ["blender", "genex"], skills: ["blender/local-modeling", "genex/publishing"] };
  const now = { plugins: ["genex"], skills: [] };
  const notice = withdrawnNotice(withdrawnSince(before, now));
  const [off, out] = [notice.indexOf("no longer enabled"), notice.indexOf("genex/publishing")];
  assert.ok(off >= 0 && out >= 0, notice);
  assert.doesNotMatch(notice, /\n\n/);
  assert.match(notice, /\bgenex\b[^.]*still/i, "the skill's plugin is still on");
});

/** Plugins as a brief names them: two with tools of their own, one of hooks alone. */
const BLENDER: HandedPlugin = {
  id: "blender",
  name: "Local Blender",
  description: "Model 3D assets with Blender on this Mac.",
  tools: true,
};
const GENEX: HandedPlugin = { id: "genex", name: "Genex plugin", description: "Assets made in chat.", tools: true };
const HOOKS: HandedPlugin = {
  id: "hooks",
  name: "Checkpoint hooks",
  description: "Runs at each checkpoint.",
  tools: false,
};

test("each plugin a session is handed is one line: its name, the prefix of its tools and what it does", () => {
  const lines = handedPluginsNote([BLENDER, HOOKS]).split("\n");
  assert.equal(lines.length, 3, "a heading and one line each");
  assert.equal(lines[1], "- Local Blender (blender__ tools): Model 3D assets with Blender on this Mac.");
  assert.equal(lines[2], "- Checkpoint hooks: Runs at each checkpoint.", "never the prefix of tools it does not have");
  assert.equal(handedPluginsNote([]), "", "none handed, no list");
});

test("an author's description over several lines, or past its length, stays one short line cut at a word", () => {
  const long = { ...BLENDER, description: `Models assets.\n\nAlso ${"renders ".repeat(60)}` };
  const note = handedPluginsNote([long]);
  const [, line = ""] = note.split("\n");
  assert.equal(note.split("\n").length, 2, note);
  assert.ok(line.startsWith("- Local Blender (blender__ tools): Models assets. Also renders"), line);
  assert.ok(line.endsWith("renders…"), line);
  assert.ok(line.length < 260, `${line.length}`);
});

test("a plugin whose account is not connected yet says so on its line; a connected one and one with no account do not", () => {
  const notConnected = [
    PluginAccountState.Locked,
    PluginAccountState.NotConnected,
    PluginAccountState.Authorizing,
    PluginAccountState.Failed,
  ];
  for (const account of notConnected) {
    const [, line = ""] = handedPluginsNote([{ ...GENEX, account }]).split("\n");
    assert.equal(line, `- Genex plugin (genex__ tools): Assets made in chat. ${NOT_SET_UP}`, account);
  }
  const connected = handedPluginsNote([{ ...GENEX, account: PluginAccountState.Unlocked }]);
  assert.ok(!connected.includes(NOT_SET_UP), connected);
  assert.ok(!handedPluginsNote([BLENDER]).includes(NOT_SET_UP), "no account, nothing to set up");
});

test("a resumed session hears of the plugins handed now and not before, in one paragraph", () => {
  const before = { plugins: ["genex"], skills: ["genex/genex"] };
  const added = addedSince(before, [GENEX, BLENDER, HOOKS]);
  assert.deepEqual(
    added.map((plugin) => plugin.id),
    ["blender", "hooks"],
  );
  const notice = addedNotice(added);
  assert.ok(notice.startsWith(SINCE_LAST_RAN), notice);
  assert.match(notice, /these plugins were turned on/);
  assert.ok(notice.includes("Local Blender (blender__ tools): Model 3D assets with Blender on this Mac."), notice);
  assert.ok(notice.includes("Checkpoint hooks: Runs at each checkpoint."), notice);
  assert.doesNotMatch(notice, /Genex/, "nothing of a plugin it was handed before");
  assert.doesNotMatch(notice, /\n/, "one paragraph");
});

test("nothing turned on, or nothing recorded of before, is no notice", () => {
  assert.deepEqual(addedSince({ plugins: ["blender"], skills: [] }, [BLENDER]), []);
  assert.deepEqual(addedSince(undefined, [BLENDER]), [], "no record to compare: the brief's list names it");
  assert.equal(addedNotice([]), "");
});

describe("a delegated session's brief and the plugins turned on", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId: string;
  let example: PluginManifest;
  const project = "handed";
  const prompts: string[] = [];

  before(async () => {
    lite = await coreLite();
    api = lite.api() as unknown as Api;
    await lite.core.games.scaffold(project);
    threadId = await lite.core.createGameThread(project);
    example = await installLocalOn(lite.core.plugins, EXAMPLE_PLUGIN);
    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        prompts.push(request.prompt);
        const sessionId = request.resume ?? `s${prompts.length}`;
        return { ok: true, engine: "claude-code", summary: "fixture", turns: 1, usage: {}, sessionId };
      },
    } as never);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** A turn of the game's chat, in a new session or resuming `resume`; answers the brief it read and its session. */
  const turn = async (resume?: string) => {
    const handler = api["engine.delegate"];
    assert.ok(handler, "engine.delegate");
    await handler({ engine: "claude-code", project, threadId, prompt: "Build it", ...(resume ? { resume } : {}) });
    return { brief: prompts.at(-1) ?? "", session: resume ?? `s${prompts.length}` };
  };
  /** How a brief names the example plugin: its name, the prefix of its tools and what it does. */
  const exampleLine = () => `${example.name} (${example.id}__ tools): ${example.description}`;

  test("a new session's brief names each plugin turned on, by name, tool prefix and what it does, with no notice", async () => {
    await lite.core.plugins.setEnabled(example.id, true);
    const { brief } = await turn();
    assert.ok(brief.includes(exampleLine()), brief);
    assert.ok(!brief.includes(SINCE_LAST_RAN), "a new session sees the list and needs no notice");
  });

  test("a plugin turned off is not named", async () => {
    await lite.core.plugins.setEnabled(example.id, false);
    const { brief } = await turn();
    assert.ok(!brief.includes(example.name), brief);
    assert.ok(!brief.includes(`${example.id}__`), brief);
  });

  test("a resumed session hears once of a plugin turned on since it last ran", async () => {
    await lite.core.plugins.setEnabled(example.id, false);
    const { session } = await turn();
    await lite.core.plugins.setEnabled(example.id, true);

    const told = (await turn(session)).brief;
    const [first = ""] = told.split("\n\n");
    assert.ok(first.startsWith(SINCE_LAST_RAN), told);
    assert.ok(first.includes(exampleLine()), first);
    assert.ok(first.includes("turned on"), first);
    assert.ok(told.indexOf("Build it") > first.length, "the notice heads the brief");

    const next = (await turn(session)).brief;
    assert.ok(!next.includes(SINCE_LAST_RAN), `once it answered, it is not told again: ${next}`);
    assert.ok(next.includes(exampleLine()), "the list still names it");
  });

  test("a plugin turned on whose account the person has not connected is named as not set up yet", async () => {
    await lite.core.plugins.setEnabled(example.id, true);
    const account = await accountPackage(await tmpDir("studio-handed-account-"), "a", "Publisher A");
    await installLocalOn(lite.core.plugins, account.dir, account.manifest.capabilities);
    const lines = (await turn()).brief.split("\n");
    const lineOf = (manifest: PluginManifest) => lines.find((line) => line.startsWith(`- ${manifest.name} (`)) ?? "";
    assert.equal(
      lineOf(account.manifest),
      `- ${account.manifest.name} (${account.manifest.id}__ tools): ${account.manifest.description} ${NOT_SET_UP}`,
    );
    assert.equal(lineOf(example), `- ${exampleLine()}`, "a plugin with no account is unaffected");
  });
});
