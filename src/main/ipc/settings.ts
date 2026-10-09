/**
 * The studio's own settings, the diagnostics report Settings copies, Send feedback and the shipped
 * licenses.
 */
import type { LicenseTexts } from "../../shared/licenses.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

export interface SettingsIpcDeps {
  core: Pick<StudioCore, "settings" | "updateSettings">;
  /** The redacted report (`main/diagnostics.ts`). */
  diagnostics(): Promise<string>;
  /** Check the dialog's payload and post the report (`main/feedback.ts`). */
  feedback(payload: unknown): Promise<void>;
  /** The license texts in the app's resources (`main/licenses.ts`). */
  licenses(): Promise<LicenseTexts>;
}

export function registerSettingsIpc(
  handle: IpcHandle,
  { core, diagnostics, feedback, licenses }: SettingsIpcDeps,
): void {
  handle("studio:settings", async () => core.settings);
  handle("studio:settings.set", async (payload) => core.updateSettings(payload));
  handle("studio:diagnostics", () => diagnostics());
  handle("studio:feedback.send", (payload) => feedback(payload));
  handle("studio:licenses", () => licenses());
}
