/**
 * The one file a change the agent made to itself wrote, as its log record names it. The harness
 * writes these records and edits its own code, so a record whose file could leave the harness
 * workspace names no change: Activity does not list it and an undo never touches it.
 */
import { CustomEvent } from "./custom-events.ts";

/** A skill's file name without `.md`: what `write_skill` and SkillOpt accept. */
export const SKILL_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** A workspace-relative path that stays inside the workspace. */
export function isWorkspaceRelative(file: string): boolean {
  return Boolean(file) && !file.startsWith("/") && !file.split(/[\\/]/).some((part) => part === ".." || part === "");
}

/** Records of the agent changing its own files: `write_own_file`, `write_skill`, `install_tool`. */
export const AGENT_SELF_CHANGES: ReadonlySet<string> = new Set<string>([
  CustomEvent.SelfEdit,
  CustomEvent.SkillEdited,
  CustomEvent.ToolInstalled,
]);

/** The workspace-relative file an agent self-change record wrote, or null when it names none safely. */
export function agentChangedFile(eventType: string, payload: Record<string, unknown>): string | null {
  if (!AGENT_SELF_CHANGES.has(eventType)) return null;
  if (eventType === CustomEvent.SkillEdited) {
    return typeof payload.slug === "string" && SKILL_SLUG.test(payload.slug) ? `skills/${payload.slug}.md` : null;
  }
  return typeof payload.file === "string" && isWorkspaceRelative(payload.file) ? payload.file : null;
}

/**
 * What a staged suggestion changes: one skill file, or the lessons every builder's brief carries.
 * A record without a target predates lessons and is a skill edit. Persisted: never rename a value.
 * The harness keeps a copy (`loop/contract-lessons.ts`), held to this one by seed-contracts.test.ts.
 */
export const StagedTarget = { Skill: "skill", Lessons: "lessons" } as const;
export type StagedTarget = (typeof StagedTarget)[keyof typeof StagedTarget];

/** The one file a lessons suggestion may write, relative to the harness workspace. */
export const CONTRACT_LESSONS_FILE = "library/contract-lessons.md";

/** The name a lessons suggestion is staged, refused and remembered under. */
export const LESSONS_SKILL = "contract-lessons";
