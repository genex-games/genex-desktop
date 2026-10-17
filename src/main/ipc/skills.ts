/** Skills: the studio's own, a game's own, plugin skills' text, and those the signed-in providers already hold. */
import path from "node:path";
import type { ProjectSkillInventory, ProviderSkillInventory } from "../../shared/provider-skills.ts";
import { claudeGlobalSkills, codexGlobalSkills, openCodeGlobalSkills, projectSkills } from "../provider-skills.ts";
import { studioSkills } from "../skill-inventory.ts";
import type { StudioCore } from "../studio-core.ts";
import type { SubscriptionEngine } from "../login-controllers.ts";
import type { IpcHandle } from "./registrar.ts";
import { EngineId } from "../../shared/providers.ts";

/** Why a skills request from the renderer is refused. */
const MESSAGE = {
  invalidProject: "Invalid project",
  invalidSkill: "Invalid skill request",
} as const;

export interface SkillsIpcDeps {
  core: Pick<StudioCore, "layout" | "games" | "assertProjectAllowed"> & {
    plugins: Pick<StudioCore["plugins"], "skillText">;
  };
  subscription(id: string): SubscriptionEngine | null;
  /** The user's home folder. */
  home(): string;
}

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

/** One game's own skills, after its name resolves to a folder Studio may read. */
async function gameSkills(core: SkillsIpcDeps["core"], project: unknown): Promise<ProjectSkillInventory> {
  if (typeof project !== "string") throw new Error(MESSAGE.invalidProject);
  const dir = core.games.dirFor(project);
  await core.assertProjectAllowed(dir);
  return { project, ...(await projectSkills(dir)) };
}

export function registerSkillsIpc(handle: IpcHandle, { core, subscription, home }: SkillsIpcDeps): void {
  handle("studio:skills.list", async () => studioSkills(core.layout.harnessWs));
  handle("studio:skills.project", async (p) => gameSkills(core, p?.project));
  handle("studio:plugins.skill", async (p) => {
    const valid = typeof p?.id === "string" && typeof p.name === "string" && isOptionalString(p.file);
    if (!valid) throw new Error(MESSAGE.invalidSkill);
    return core.plugins.skillText(p.id, p.name, p.file);
  });
  let providerSkillsPending: Promise<ProviderSkillInventory[]> | undefined;
  handle("studio:skills.providers", async () => {
    if (!providerSkillsPending)
      providerSkillsPending = (async () => {
        const claude = await subscription(EngineId.ClaudeCode)?.resolveLogin(),
          codex = await subscription(EngineId.Codex)?.resolveLogin();
        return Promise.all([
          claudeGlobalSkills(claude?.home ?? path.join(home(), ".claude"), home()),
          codexGlobalSkills(core.layout.harnessWs, codex ?? null),
          openCodeGlobalSkills(home()),
        ]);
      })().finally(() => {
        providerSkillsPending = undefined;
      });
    return providerSkillsPending;
  });
}
