/**
 * What an agent may ask Genex for: the operations the host tool maps to CLI commands, the options
 * it forwards, the validation every request passes before any CLI is spawned, and the arguments
 * a valid request becomes.
 */
import path from "node:path";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { GenexOperation, type GenexRequest } from "../../shared/genex.ts";

/** Each supported asset operation and the CLI subcommand it runs. */
export const OPERATIONS: Record<string, string[]> = {
  [GenexOperation.Model]: ["model"],
  [GenexOperation.Image]: ["image"],
  [GenexOperation.Texture]: ["texture"],
  [GenexOperation.Video]: ["video"],
  [GenexOperation.Sfx]: ["sfx"],
  [GenexOperation.Music]: ["music"],
  [GenexOperation.Voice]: ["voice"],
  [GenexOperation.ModelImport]: ["model", "import"],
  [GenexOperation.ModelSegment]: ["model", "segment"],
  [GenexOperation.ModelRig]: ["model", "rig"],
  [GenexOperation.ModelAnimate]: ["model", "animate"],
  [GenexOperation.Character]: ["character"],
  [GenexOperation.Creature]: ["creature"],
  [GenexOperation.CharacterPreview]: ["character", "preview"],
  [GenexOperation.CharacterFinalize]: ["character", "finalize"],
  [GenexOperation.CharacterImport]: ["character", "import"],
  [GenexOperation.CharacterAnimate]: ["character", "animate"],
  [GenexOperation.CreatureAnimate]: ["creature", "animate"],
  [GenexOperation.CharacterMotions]: ["character", "motions"],
  [GenexOperation.AnimationsSearch]: ["animations", "search"],
  [GenexOperation.Wait]: ["wait"],
};
/** Every operation the host tool accepts: the CLI operations plus the host-side asset checks. */
export const TOOL_OPERATIONS = [...Object.keys(OPERATIONS), GenexOperation.InspectUse, GenexOperation.VerifyUse];
/** Operations answered by the host itself, from delivered files, never by the CLI. */
export const USE_OPERATIONS = new Set<string>([GenexOperation.InspectUse, GenexOperation.VerifyUse]);

/** The options a one-shot Meshy body takes: `creature`, and `character` on its direct routes. */
const MESHY_ONE_SHOT = ["image", "polycount", "height", "pose", "texture", "no-ultra", "animation"] as const;

/**
 * The options each operation forwards to the CLI: all the host accepts for it, and what a refusal
 * names. Taken from what the pinned CLI reads for each command; a flag the CLI would silently drop
 * for that command (or refuse beside `--no-wait`, which Studio always passes) is not listed.
 */
export const LANE_OPTIONS = {
  [GenexOperation.Model]: ["auto-size", "face-limit", "low-poly", "texture", "geometry", "quad", "parts", "image"],
  [GenexOperation.Image]: [
    "aspect",
    "size",
    "quality",
    "transparent",
    "candidates",
    "edit",
    "inpaint",
    "remove-bg",
    "bg-mode",
    "clean",
    "upscale",
  ],
  [GenexOperation.Texture]: ["terrain"],
  [GenexOperation.Video]: ["duration", "resolution", "loop", "frame", "start-frame", "first-frame", "last-frame"],
  [GenexOperation.Sfx]: ["duration", "loop"],
  [GenexOperation.Music]: ["duration"],
  [GenexOperation.Voice]: ["voice", "voice-id"],
  [GenexOperation.ModelImport]: [],
  [GenexOperation.ModelSegment]: ["granularity"],
  [GenexOperation.ModelRig]: ["type"],
  [GenexOperation.ModelAnimate]: ["preset"],
  [GenexOperation.Character]: ["direct-text", ...MESHY_ONE_SHOT, "no-controller-pack"],
  [GenexOperation.Creature]: MESHY_ONE_SHOT,
  [GenexOperation.CharacterPreview]: ["candidate", "texture", "no-ultra"],
  [GenexOperation.CharacterFinalize]: ["animation", "height"],
  [GenexOperation.CharacterImport]: ["height", "no-fingers"],
  [GenexOperation.CharacterAnimate]: ["action", "animation", "locomotion", "video", "duration"],
  [GenexOperation.CreatureAnimate]: ["locomotion", "video", "duration", "lean"],
  [GenexOperation.CharacterMotions]: [],
  [GenexOperation.AnimationsSearch]: [],
  [GenexOperation.Wait]: [],
} as const satisfies Record<keyof typeof OPERATIONS, readonly string[]>;

/** An operation's options, for a refusal to name: the lane's own, or none. */
const laneOptions = (operation: string): readonly string[] =>
  Object.hasOwn(LANE_OPTIONS, operation) ? LANE_OPTIONS[operation as keyof typeof LANE_OPTIONS] : [];

const WAIT_HINT =
  "Studio submits every create without waiting: pick the result up with operation wait and its generationId.";
/** The line a refusal adds for an option agents reach for that the lanes or Studio settle themselves. */
const OPTION_HINTS: Readonly<Record<string, string>> = {
  provider:
    "There is no provider option: each lane's provider is fixed (status names them). The model lane is Tripo; Meshy makes only character and creature bodies.",
  wait: WAIT_HINT,
  noWait: WAIT_HINT,
  "no-wait": WAIT_HINT,
};
/** Options whose value is a file in the game, copied into the job before the CLI sees it. */
export const FILE_OPTIONS = new Set([
  "image",
  "edit",
  "frame",
  "start-frame",
  "first-frame",
  "last-frame",
  "inpaint",
  "clean",
  "upscale",
  "video",
]);
/** Operations that show the user images to approve before anything is charged. */
export const APPROVAL_OPERATIONS = new Set<string>([GenexOperation.CharacterPreview, GenexOperation.CharacterFinalize]);
/** Operations that retrieve an existing generation or catalog instead of creating one. */
export const READ_OPERATIONS = new Set<string>([
  GenexOperation.Wait,
  GenexOperation.CharacterMotions,
  GenexOperation.AnimationsSearch,
]);
/** Operations whose prompt is a model file in the game rather than text. */
export const IMPORT_OPERATIONS = new Set<string>([GenexOperation.CharacterImport, GenexOperation.ModelImport]);
/** Operations that answer inline and write no output folder. */
export const NO_OUTPUT_OPERATIONS = new Set<string>([GenexOperation.AnimationsSearch, GenexOperation.CharacterMotions]);

/** Rigging copies of a finalized character are remeshed to this many faces. */
export const REMESH_FACES = 10000;
const MAX_ANIMATIONS = 16;
const MAX_TEXT_CHARS = 16000;
/** A generation id or an animation name: no leading dash, so it can never read as a CLI flag. */
export const GENEX_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;
/** A catalog clip named or searched for ("Left Slash", 466): spaces inside, never a leading dash. */
const ANIMATION_SELECTOR = /^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,159}$/;
const SCALAR_TYPES = ["string", "number", "boolean"];

const MESSAGE = {
  Unsupported: "Unsupported Genex asset operation. Hosted and account commands are not available.",
  OptionsNotObject: "Options must be an object",
  InvalidPrompt: "Invalid asset prompt",
  InvalidAnimation: "Invalid animation selection",
  UnsupportedOption: (operation: string, key: string) => {
    const takes = laneOptions(operation);
    const lane = takes.length ? `${operation} takes: ${takes.join(", ")}.` : `${operation} takes no options.`;
    const hint = Object.hasOwn(OPTION_HINTS, key) ? OPTION_HINTS[key] : "";
    return [`Unsupported Genex option for ${operation}: ${key}.`, lane, hint].filter(Boolean).join(" ");
  },
  InvalidOptionValue: (key: string) => `Genex option ${key} takes a string, a number or true/false`,
  InvalidNumber: "Invalid numeric Genex option",
  OptionTooLong: "Genex option is too long",
  InvalidRequest: "Invalid asset request",
  CharacterOutside: "Character input must be inside this game",
  AssetInputOutside: "Asset input must be a file inside this game",
} as const;

const isFlagLike = (value: string) => value.startsWith("-");

/** One to {@link MAX_ANIMATIONS} animation names or numbers, none of them flag-like. */
function isValidAnimationSelection(value: unknown[]): boolean {
  if (!value.length || value.length > MAX_ANIMATIONS) return false;
  return value.every((item) => ["string", "number"].includes(typeof item) && ANIMATION_SELECTOR.test(String(item)));
}

/** One option of `operation`: one its lane takes, with a bounded scalar (or clip list) value. */
function validateOption(operation: string, key: string, value: unknown): void {
  if (!laneOptions(operation).includes(key)) throw new Error(MESSAGE.UnsupportedOption(operation, key));
  if (key === "animation" && Array.isArray(value)) {
    if (!isValidAnimationSelection(value)) throw new Error(MESSAGE.InvalidAnimation);
    return;
  }
  if (!SCALAR_TYPES.includes(typeof value)) throw new Error(MESSAGE.InvalidOptionValue(key));
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(MESSAGE.InvalidNumber);
  const unsafeText = typeof value === "string" && (value.length > MAX_TEXT_CHARS || isFlagLike(value));
  if (unsafeText) throw new Error(MESSAGE.OptionTooLong);
}

const hasInvalidOptions = (request: GenexRequest) =>
  Boolean(request.options) && (typeof request.options !== "object" || Array.isArray(request.options));
const hasInvalidPrompt = (request: GenexRequest) =>
  request.prompt !== undefined && (typeof request.prompt !== "string" || isFlagLike(request.prompt));
const hasOversizedPromptOrBadId = (request: GenexRequest) =>
  (request.prompt?.length ?? 0) > MAX_TEXT_CHARS || Boolean(request.id && !GENEX_NAME.test(request.id));

/** Refuse anything but a supported asset operation with supported, bounded, non-flag options. */
export function validateGenexRequest(request: GenexRequest): void {
  if (!request || !Object.hasOwn(OPERATIONS, request.operation)) throw new Error(MESSAGE.Unsupported);
  if (hasInvalidOptions(request)) throw new Error(MESSAGE.OptionsNotObject);
  if (hasInvalidPrompt(request)) throw new Error(MESSAGE.InvalidPrompt);
  for (const [key, value] of Object.entries(request.options ?? {})) validateOption(request.operation, key, value);
  if (hasOversizedPromptOrBadId(request)) throw new Error(MESSAGE.InvalidRequest);
}

/** The real path of a file inside the game `root`; a folder or anything outside is refused. */
async function containedGameFile(root: string, relative: string, refusal: string): Promise<string> {
  const source = await realpath(path.resolve(root, relative));
  const allowed = await realpath(root);
  if (!source.startsWith(allowed + path.sep) || (await lstat(source)).isDirectory()) throw new Error(refusal);
  return source;
}

/** The prompt argument: an import copies the named model into the job; other prompts pass as text. */
async function promptArg(request: GenexRequest, prompt: string, root: string, dir: string): Promise<string> {
  if (!IMPORT_OPERATIONS.has(request.operation)) return prompt;
  const source = await containedGameFile(root, prompt, MESSAGE.CharacterOutside);
  const local = path.join(dir, "character.glb");
  await copyFile(source, local);
  return local;
}

type OptionValue = NonNullable<GenexRequest["options"]>[string];

/** One option's flags. A game file becomes a job-local copy; `false` drops the flag; `true` is a bare flag. */
async function optionArgs(key: string, value: OptionValue, root: string, dir: string): Promise<string[]> {
  if (key === "animation" && Array.isArray(value)) return value.flatMap((item) => ["--animation", String(item)]);
  const localFile = FILE_OPTIONS.has(key) && typeof value === "string" && !value.startsWith("https://");
  const resolved = localFile ? await copyOptionFile(key, value, root, dir) : value;
  if (resolved === false) return [];
  return resolved === true ? [`--${key}`] : [`--${key}`, String(resolved)];
}

async function copyOptionFile(key: string, relative: string, root: string, dir: string): Promise<string> {
  const source = await containedGameFile(root, relative, MESSAGE.AssetInputOutside);
  const local = path.join(dir, `input-${key}${path.extname(source)}`);
  await copyFile(source, local);
  return local;
}

/** The flags that carry a user's approval, only on an operation that asked for one. */
function approvalArgs(request: GenexRequest, approved: boolean): string[] {
  if (!approved || !APPROVAL_OPERATIONS.has(request.operation)) return [];
  if (request.operation !== GenexOperation.CharacterFinalize) return ["--user-approved"];
  return ["--user-approved", "--approve-remesh", String(REMESH_FACES)];
}

/**
 * The CLI arguments for a validated request whose job folder is `dir`: game files it names are
 * copied in first, and results land in `dir/output`.
 */
export async function cliArgsFor(request: GenexRequest, root: string, dir: string, approved: boolean) {
  const args = [...OPERATIONS[request.operation]];
  if (request.id) args.push(request.id);
  if (request.prompt) args.push(await promptArg(request, request.prompt, root, dir));
  for (const [key, value] of Object.entries(request.options ?? {}))
    args.push(...(await optionArgs(key, value, root, dir)));
  args.push(...approvalArgs(request, approved));
  const output = path.join(dir, "output");
  await mkdir(output, { recursive: true });
  if (!NO_OUTPUT_OPERATIONS.has(request.operation)) args.push("--out-dir", output);
  const waitsForResult = READ_OPERATIONS.has(request.operation) || request.operation === GenexOperation.ModelImport;
  if (!waitsForResult) args.push("--no-wait");
  return { args, output };
}
