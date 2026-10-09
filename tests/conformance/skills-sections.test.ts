/**
 * The Skills tab's sections, built without React: Studio's own skills under a label that says who
 * uses them, this game's own skills with the builders that load them, each provider's global
 * skills with a note chosen by whether they reach builders, and the plugins' skills by their line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import { ProviderBuilderUse, type ProviderSkillInventory } from "../../src/shared/provider-skills.ts";
import { EngineId } from "../../src/shared/providers.ts";
import {
  gameSkillsSection,
  pluginSkillRows,
  providerNote,
  skillChangeWords,
  SkillsSection,
  studioSkillsSection,
} from "../../src/renderer/panels/plugins/skills-sections.ts";

const plugin = (manifest: Partial<PluginManifest>, over: Partial<PluginInfo> = {}): PluginInfo =>
  ({
    manifest: { id: "genex", name: "Genex Tools", skills: [], ...manifest },
    enabled: true,
    removed: false,
    ...over,
  }) as PluginInfo;

const codex = (builders: ProviderBuilderUse): ProviderSkillInventory => ({
  provider: EngineId.Codex,
  label: "Codex",
  source: "native-catalog",
  skills: [],
  note: "",
  warnings: [],
  builders,
});

test("Studio's own skills say who uses them, not only local models", () => {
  const section = studioSkillsSection([{ name: "director", description: "Runs the run", text: "..." }]);
  assert.equal(section.id, SkillsSection.Studio);
  assert.doesNotMatch(`${section.title} ${section.intro}`, /Local models/);
  assert.match(section.intro, /director/);
  assert.deepEqual(
    section.rows.map((r) => [r.name, r.line]),
    [["director", "Runs the run"]],
  );
});

test("a file skill is listed by its summary and opens read on demand; an inline one by its first line", () => {
  const rows = pluginSkillRows([
    plugin({
      skills: [
        { name: "multiplayer", summary: "Rooms, presence and sync.", file: "skills/multiplayer.md" },
        { name: "publishing", text: "\nPublish drafts first.\nThen share." },
      ],
    }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.line, r.skill.onDemand === true]),
    [
      ["multiplayer", "Rooms, presence and sync.", true],
      ["publishing", "Publish drafts first.", false],
    ],
  );
  assert.equal(rows[0]?.skill.text, undefined);
  assert.equal(rows[1]?.skill.text, "\nPublish drafts first.\nThen share.");
});

test("removed and not-yet-allowed plugins list no skills; a disabled one lists them as off", () => {
  const skills = [{ name: "a", text: "A" }];
  const rows = pluginSkillRows([
    plugin({ id: "gone", skills }, { removed: true }),
    plugin({ id: "unlisted", skills }, { unlisted: true }),
    plugin({ id: "off", skills }, { enabled: false }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.skill.plugin, r.enabled]),
    [["off", false]],
  );
});

test("the Codex note follows whether its builders load these skills", () => {
  const notes = [ProviderBuilderUse.BorrowedLogin, ProviderBuilderUse.StudioProfile, ProviderBuilderUse.NoLogin].map(
    (use) => providerNote(codex(use)),
  );
  assert.equal(new Set(notes).size, 3);
  assert.ok(notes.every(Boolean));
  assert.notEqual(providerNote(codex(ProviderBuilderUse.NotLoaded)), notes[0]);
});

test("this game's skills name the builders that load them, and an empty game says so", () => {
  const section = gameSkillsSection({
    project: "demo",
    skills: [
      {
        name: "level-design",
        description: "Lay out levels",
        path: ".claude/skills/level-design/SKILL.md",
        kind: "skill",
        engines: [EngineId.ClaudeCode, EngineId.Codex],
      },
      {
        name: "playtest",
        description: "",
        path: ".claude/commands/playtest.md",
        kind: "command",
        engines: [EngineId.ClaudeCode],
      },
    ],
    warnings: [],
  });
  assert.equal(section.id, SkillsSection.Game);
  assert.deepEqual(
    section.rows.map((r) => [r.name, r.line, r.tag]),
    [
      ["level-design", "Lay out levels", "Claude Code · Codex"],
      ["playtest", ".claude/commands/playtest.md", "Claude Code"],
    ],
  );
  assert.equal(section.rows[0]?.skill.provider, section.title);
  assert.ok(gameSkillsSection({ project: "demo", skills: [], warnings: [] }).empty);
});

test("a plugin's last skill change names what it added, changed and removed", () => {
  assert.equal(skillChangeWords(undefined), "");
  assert.equal(
    skillChangeWords({ added: ["multiplayer", "embed"], changed: [], removed: ["asset-workflow"] }),
    "Added multiplayer, embed · Removed asset-workflow",
  );
});
