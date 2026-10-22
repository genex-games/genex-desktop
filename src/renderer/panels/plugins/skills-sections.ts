/**
 * The Skills tab's sections, as data: Studio's own skills, this game's own, each provider's global
 * skills and the plugins'. Pure, so what each row says is tested without React; `SkillsBrowse.tsx`
 * draws it.
 */
import { t } from "../../../shared/i18n.ts";
import { engineLabel } from "../../../shared/model-roles.ts";
import {
  isFileSkill,
  type PluginInfo,
  type PluginSkill,
  type PluginSkillChange,
  pluginSkillLine,
} from "../../../shared/plugins.ts";
import type { ProjectSkill, ProjectSkillInventory, ProviderSkillInventory } from "../../../shared/provider-skills.ts";
import { SKILLS_WORDS } from "../../words.ts";

/** Each section's `data-skills-section` value. Read by smoke checks: never rename a value. */
export const SkillsSection = {
  Studio: "studio",
  Game: "game",
  Provider: "provider",
  Plugins: "plugins",
} as const;
export type SkillsSection = (typeof SkillsSection)[keyof typeof SkillsSection];

/** A skill shown on its own page: a plugin's, a provider's, this game's or one of Studio's own. */
export interface ShownSkill {
  plugin: string;
  name: string;
  /** The whole text; absent for a file skill until its file is read. */
  text?: string;
  /** The line agents are given for a file skill. */
  summary?: string;
  /** A plugin's file skill: agents read its file on demand, and so does its page. */
  onDemand?: boolean;
  /** Where it comes from, when not a plugin: a provider's name or this game. */
  provider?: string;
}

/** A plugin's skill as its own page shows it: a file skill by its summary until its file is read. */
export function shownPluginSkill(plugin: string, skill: PluginSkill): ShownSkill {
  if (isFileSkill(skill)) return { plugin, name: skill.name, summary: skill.summary, onDemand: true };
  return { plugin, name: skill.name, text: skill.text };
}

/** One row of a section: a name, the line under it, small words beside it, and what opening it shows. */
export interface SkillRow {
  key: string;
  name: string;
  line: string;
  /** Beside the row: which builders load a game's skill. */
  tag?: string;
  /** A plugin skill's plugin is on. */
  enabled?: boolean;
  /** What the search looks through besides the name. */
  search: string[];
  skill: ShownSkill;
}

/** A section of the tab: its hook, title and intro, and its rows. */
export interface SkillsSectionView {
  id: SkillsSection;
  title: string;
  intro: string;
  rows: SkillRow[];
  /** What an empty section says. */
  empty?: string;
  /** What could not be read. */
  warnings?: string[];
}

/** Studio's own skills, under a label that says what uses them. */
export function studioSkillsSection(
  builtins: ReadonlyArray<{ name: string; text: string; description: string }>,
): SkillsSectionView {
  return {
    id: SkillsSection.Studio,
    title: SKILLS_WORDS.studioTitle,
    intro: SKILLS_WORDS.studioIntro,
    rows: builtins.map((s) => ({
      key: s.name,
      name: s.name,
      line: s.description,
      search: [s.description],
      skill: { plugin: "", name: s.name, text: s.text },
    })),
  };
}

/** Which builders load a game's skill, as the row's tag says it. */
const engineWords = (skill: ProjectSkill): string => skill.engines.map(engineLabel).join(" · ");

/** This game's own skills and commands, each naming the builders that load it from the folder. */
export function gameSkillsSection(inventory: ProjectSkillInventory): SkillsSectionView {
  const title = SKILLS_WORDS.gameTitle;
  const rows = inventory.skills.map(
    (s): SkillRow => ({
      key: s.path,
      name: s.name,
      line: s.description || s.path,
      tag: engineWords(s),
      search: [s.description, s.path],
      skill: {
        plugin: "",
        provider: title,
        name: s.name,
        text: `${s.description}\n\n${s.path}\n${engineWords(s)}`.trim(),
      },
    }),
  );
  return {
    id: SkillsSection.Game,
    title,
    intro: SKILLS_WORDS.gameIntro,
    rows,
    empty: SKILLS_WORDS.gameEmpty,
    warnings: inventory.warnings,
  };
}

/** What a provider's section says about its skills: whether they reach Studio's builders. */
export const providerNote = (provider: ProviderSkillInventory): string => SKILLS_WORDS.builders[provider.builders];

/** Every skill an installed, allowed plugin gives agents, disabled plugins' too, by its one line. */
export function pluginSkillRows(plugins: readonly PluginInfo[]): SkillRow[] {
  return plugins
    .filter((p) => !p.removed && !p.unlisted)
    .flatMap((p) =>
      p.manifest.skills.map(
        (s): SkillRow => ({
          key: `${p.manifest.id}:${s.name}`,
          name: s.name,
          line: pluginSkillLine(s),
          enabled: p.enabled,
          search: [pluginSkillLine(s), p.manifest.name],
          skill: shownPluginSkill(p.manifest.id, s),
        }),
      ),
    );
}

/** What the last update or reload did to a plugin's skills: "Added a · Changed b", or "" when nothing. */
export function skillChangeWords(change: PluginSkillChange | undefined): string {
  if (!change) return "";
  const parts = (["added", "changed", "removed"] as const)
    .filter((key) => change[key].length)
    .map((key) => t("{change} {names}", { change: SKILLS_WORDS.changed[key], names: change[key].join(", ") }));
  return parts.join(" · ");
}
