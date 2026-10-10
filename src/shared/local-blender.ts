/**
 * Local Blender, the bundled plugin that runs Blender on this computer: its id and the actions its
 * setup card calls. The plugin keeps its own copy of the action names (`plugins/blender/backend.ts`).
 */
import type { PluginNativeStatus, PluginRuntimeInstall } from "./plugins.ts";

export const LOCAL_BLENDER_PLUGIN_ID = "blender";

/** The plugin's actions: read where Blender stands, download Studio's copy, stop that download. */
export const LocalBlenderAction = { Status: "status", Install: "install", CancelInstall: "cancel-install" } as const;

/** What the `status` action answers. */
export interface LocalBlenderStatus {
  runtime: PluginNativeStatus;
  installation?: PluginRuntimeInstall | null;
}

/** Whether an answer is a status the setup card can draw. */
export function isLocalBlenderStatus(value: unknown): value is LocalBlenderStatus {
  const runtime = (value as { runtime?: { state?: unknown; detail?: unknown } } | null)?.runtime;
  return typeof runtime?.state === "string" && typeof runtime.detail === "string";
}
