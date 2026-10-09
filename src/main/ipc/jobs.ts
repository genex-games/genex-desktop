/** Background work in the chat: the person's Stop on a job's line, and Open Privacy settings for app_look. */
import { AppLookAccessKind } from "../../shared/jobs.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** The one System Settings page each pane opens; nothing else is ever opened from here. */
const PRIVACY_SETTINGS_URLS = {
  [AppLookAccessKind.Screen]: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  [AppLookAccessKind.Accessibility]: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
} as const satisfies Record<AppLookAccessKind, string>;

/** Why a request from the renderer is refused. */
const MESSAGE = {
  jobRequired: "A game and a job are required.",
  unknownPane: "There is no such Privacy & Security pane.",
} as const;

export interface JobsIpcDeps {
  core: Pick<StudioCore, "stopJob">;
  /** Electron's `shell.openExternal`; tests record the URL instead. */
  openExternal(url: string): Promise<void>;
}

/** The game and job a Stop names, refused unless both are text; the core answers null for one it never had. */
function jobOf(payload: unknown): { project: string; jobId: string } {
  const { project, jobId } = (payload ?? {}) as { project?: unknown; jobId?: unknown };
  if (typeof project !== "string" || typeof jobId !== "string") throw new Error(MESSAGE.jobRequired);
  return { project, jobId };
}

/** The settings page a pane opens, refused unless the pane is one app_look needs. */
function privacySettingsUrl(payload: unknown): string {
  const pane = (payload as { pane?: unknown } | null | undefined)?.pane;
  const known = Object.values(AppLookAccessKind).find((kind) => kind === pane);
  if (!known) throw new Error(MESSAGE.unknownPane);
  return PRIVACY_SETTINGS_URLS[known];
}

/** Register a job line's Stop and an access line's Open Privacy settings. */
export function registerJobsIpc(handle: IpcHandle, { core, openExternal }: JobsIpcDeps): void {
  handle("studio:jobs.stop", async (payload) => {
    const { project, jobId } = jobOf(payload);
    return core.stopJob(project, jobId);
  });
  handle("studio:app-look.open-settings", async (payload) => {
    await openExternal(privacySettingsUrl(payload));
    return true;
  });
}
