/**
 * Unreal's "Use Less CPU when in Background" (`bThrottleCPUWhenNotForeground`): while it is on, an
 * editor behind Genex plays at a few frames per second, so a play test measures a slow game. The
 * bridge and the Unreal Loop's editor queue read and write it through Epic's ObjectTools on the
 * settings' class default object, which changes the running editor and never its saved config.
 *
 * On a Mac, Genex lifts it only for an editor whose hardware ray tracing is off: UE 5.8 rendering
 * a ray-traced level at full speed behind another app hangs the GPU (an M4 Max crashed within a few
 * plays every time), while the same level throttled, or without ray tracing, played on.
 */

/** Epic's toolset that reads and writes an object's properties. */
export const OBJECT_TOOLSET = "editor_toolset.toolsets.object.ObjectTools";

/** Epic's ObjectTools tools that read and write the throttle, by their wire names. */
export const ObjectTool = { GetProperties: "get_properties", SetProperties: "set_properties" } as const;
export type ObjectTool = (typeof ObjectTool)[keyof typeof ObjectTool];

/** Epic's toolset with the editor's console variables, and its tool that lists them by name, by its wire name. */
export const EDITOR_APP_TOOLSET = "EditorToolset.EditorAppToolset";
export const CVarTool = { Search: "SearchCVars" } as const;
export type CVarTool = (typeof CVarTool)[keyof typeof CVarTool];

/** The console variable that says whether the editor runs hardware ray tracing. */
const RAY_TRACING = "r.RayTracing";
const MAC: NodeJS.Platform = "darwin";

/** The editor's performance settings, as their class default object, and the throttle's property. */
const SETTINGS = "/Script/UnrealEd.Default__EditorPerformanceSettings";
const PROPERTY = "bThrottleCPUWhenNotForeground";

/** The arguments of a `get_properties` call that reads the throttle. */
export const readThrottleArgs = (): Record<string, unknown> => ({ instance: SETTINGS, properties: [PROPERTY] });

/** The arguments of a `set_properties` call that turns the throttle on or off (Epic takes the values as JSON text). */
export const writeThrottleArgs = (on: boolean): Record<string, unknown> => ({
  instance: SETTINGS,
  values: JSON.stringify({ [PROPERTY]: on }),
});

/** The values a `get_properties` answer holds: Epic answers JSON text, which a caller may have parsed already. */
function answerValues(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return undefined;
  }
}

/** The throttle's value in a `get_properties` answer; undefined when the answer holds none. */
export function throttleIn(answer: unknown): boolean | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object") return undefined;
  const value = (values as Record<string, unknown>)[PROPERTY];
  return typeof value === "boolean" ? value : undefined;
}

/** The arguments of a `SearchCVars` call that finds the ray tracing switch. */
export const rayTracingArgs = (): Record<string, unknown> => ({ name: RAY_TRACING });

/** Whether a `SearchCVars` answer says ray tracing is on; undefined when the answer holds no value for it. */
export function rayTracingIn(answer: unknown): boolean | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object") return undefined;
  const entry: unknown = Reflect.get(values, RAY_TRACING);
  const value: unknown = entry && typeof entry === "object" ? Reflect.get(entry, "value") : undefined;
  return typeof value === "number" ? value !== 0 : undefined;
}

/** Whether Genex may lift the throttle of an editor on `platform`: on a Mac only when it is known to run without ray tracing. */
export function mayLiftThrottle(platform: NodeJS.Platform, rayTracing: boolean | undefined): boolean {
  return platform !== MAC || rayTracing === false;
}

/** Whether a `set_properties` answer says the editor took the values. */
export const tookValues = (answer: unknown): boolean => answer === true;
