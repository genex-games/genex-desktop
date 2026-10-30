/**
 * The fixed capture set every whole-game look asks for, so judges grade the same things on every
 * game: each zone's hero camera, the top-down map of the level and a close-up of each character's
 * clips. Body-cam-6's judges passed soldiers whose torsos collapsed into their legs, from small
 * captures with no close-up and no map of the place. A camera written with a trailing `*` stands
 * for every camera the game registers under that prefix, and for none when it registers none.
 *
 * A new module: a kept older sibling can never shadow these names.
 */

/** The prefix every capture-set camera is registered under (the template docs name them). */
export const CaptureCamera = {
  Hero: "hero:",
  Map: "map:",
  CloseUp: "closeup:",
} as const;
export type CaptureCamera = (typeof CaptureCamera)[keyof typeof CaptureCamera];

/** The whole-game capture set, as camera patterns. */
export const CAPTURE_SET: readonly string[] = Object.values(CaptureCamera).map((prefix) => `${prefix}*`);

/** Is this asked camera a pattern for every registered camera under its prefix. */
export const isCameraPattern = (name: string): boolean => name.endsWith("*");

/**
 * The asked cameras with each pattern replaced by the registered cameras under its prefix, in the
 * order the game lists them. A pattern with nothing registered (or no list) asks for nothing.
 */
export function expandCameraSet(asked: readonly string[], registered: readonly string[] | null): string[] {
  const out: string[] = [];
  for (const name of asked) {
    const matches = isCameraPattern(name)
      ? (registered ?? []).filter((camera) => camera.startsWith(name.slice(0, -1)))
      : [name];
    for (const camera of matches) if (!out.includes(camera)) out.push(camera);
  }
  return out;
}

/** The eval suite's roles for capture-set cameras (scripts/evals/aaa `roles.json`). Wire values. */
export const CaptureRole = {
  MapTopdown: "map-topdown",
  InteriorHero: "interior-hero",
  ExteriorHero: "exterior-hero",
} as const;
export type CaptureRole = (typeof CaptureRole)[keyof typeof CaptureRole];

/** The role one capture-set camera plays, or null for any other camera. */
function roleOf(camera: string, settings: Readonly<Record<string, unknown>>): string | null {
  if (camera.startsWith(CaptureCamera.Map)) return CaptureRole.MapTopdown;
  if (camera.startsWith(CaptureCamera.Hero))
    return settings[camera] === "interior" ? CaptureRole.InteriorHero : CaptureRole.ExteriorHero;
  if (!camera.startsWith(CaptureCamera.CloseUp)) return null;
  const [character, ...clip] = camera.slice(CaptureCamera.CloseUp.length).split(":");
  return character && clip.length ? `${CaptureCamera.CloseUp}${character}/${clip.join(":")}` : null;
}

/**
 * Each photographed capture-set camera's eval role, as the grader's `roles.json` maps them: a map
 * camera is the top-down map, `closeup:<character>:<clip>` is `closeup:<character>/<clip>`, and a
 * hero camera is its setting's hero (`run.cameraSettings`, else exterior). The first camera of a role takes it.
 */
export function captureRoles(
  cameras: readonly string[],
  settings: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const camera of cameras) {
    const role = roleOf(camera, settings);
    if (!role || taken.has(role)) continue;
    taken.add(role);
    out[camera] = role;
  }
  return out;
}

/**
 * The size a whole-game look asks a native capture to draw at. A Rust game draws its captures at
 * its world size (960×540 in the template) unless asked: body-cam-6 was graded on 960×540 frames.
 * A host or game that cannot draw it answers its own size, and that shot is simply not clean.
 */
export const JUDGE_CAPTURE_SIZE = { width: 3840, height: 2160 } as const;
/** The smallest frame the eval grader counts as a clean capture. */
export const CLEAN_MIN = { width: 1600, height: 900 } as const;
/** The lens a clean capture is drawn with: no depth of field, no motion blur. */
export const CLEAN_LENS = { depthOfField: false, motionBlur: false } as const;

/** Was a shot drawn at a clean size: its own pixels at least the grader's floor. */
export function isCleanShot(stats: { width?: unknown; height?: unknown } | null | undefined): boolean {
  const width = Number(stats?.width);
  const height = Number(stats?.height);
  return width >= CLEAN_MIN.width && height >= CLEAN_MIN.height;
}
