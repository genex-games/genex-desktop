/**
 * `app_look` for the chat's own session, a lead, every worker (readers included) and a Loop's reviewer, in every
 * permission mode, Plan too: it only looks. Without arguments it lists the windows on screen; with
 * `app` or `window` it answers that window's picture and accessibility tree through the core's port
 * (`substrate/app-look.ts`). While macOS access is missing Genex asks macOS once, tells the agent what
 * the person must turn on, and writes one `app_look_access` line in the chat per app session.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import type { LiveToolResult, LiveToolSpec } from "../../shared/engine-requests.ts";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { AppLookAccessKind } from "../../shared/jobs.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import {
  AccessStep,
  type AppLookImage,
  type AppLookProblem,
  AppLookProblemCode,
  type AppWindow,
  accessStep,
  isAppLookProblem,
  pickWindow,
  refusedApp,
  type ScreenAccess,
} from "../../substrate/app-look.ts";
import { ensureDirBelow, writeFileInDir } from "../../substrate/fsx.ts";
import { type NeverTouchList, pathVerdict } from "../../substrate/engines/never-touch.ts";
import { assertRelativePath, isBelow } from "../../substrate/paths.ts";
import { HOST_BUNDLE_ID } from "../../substrate/cua-embedded.ts";
import type { StudioCore } from "../studio-core.ts";
import { APP_LOOK_ANSWER, APP_LOOK_TOOL, type LookedWindow } from "./app-look-tool-prompts.ts";
import { ProjectToolSeat } from "./project-tools.ts";
import { NEVER_DRIVEN_BUNDLES } from "./desktop-target.ts";

/** The longest an app's name or a window's title reads in an answer. */
const NAME_MAX_CHARS = 120;
/** The longest save path taken. */
const SAVE_PATH_MAX_CHARS = 240;
const SAVE_EXTENSION = ".jpg";

const MESSAGE = {
  notRecorded: (error: unknown) => `[core] the app access line was not recorded in its chat: ${errorMessage(error)}`,
} as const;

/**
 * Where a session that may write keeps a picture it asks to save: its own folder by real path, the
 * folders it never touches, and whether its chat is in Plan mode now (nothing is written then).
 */
export interface LookSave {
  folder: string;
  neverTouch: NeverTouchList;
  planning(): Promise<boolean>;
}

/** Whom a look answers to: the game, the chat its access line goes to (none: no line), and where it may save (none: nowhere). */
export interface LookCaller {
  project: string;
  chatThreadId: string | null;
  save?: LookSave | null;
}

/** The apps computer control never drives, by bundle id in lower case: `app_look` never looks at them either. */
const NEVER_LOOKED_BUNDLES: ReadonlySet<string> = new Set(
  [...NEVER_DRIVEN_BUNDLES, HOST_BUNDLE_ID].map((id) => id.toLowerCase()),
);

/**
 * Whether `app_look` refuses a window: a password manager's, any app computer control never drives
 * (System Settings, the system's password prompts), or Genex's own (this process owns its windows).
 * It only looks, so it needs no Settings switch, but it never sees what computer control may never touch.
 */
export function lookRefused(window: AppWindow): boolean {
  if (refusedApp(window) || window.pid === process.pid) return true;
  return NEVER_LOOKED_BUNDLES.has(window.bundleId?.toLowerCase() ?? "");
}

/** The chats told this app session that access is missing, per core. */
const toldChats = new WeakMap<StudioCore, Set<string>>();

/** `app_look` for a seat: the chat's own session, a lead, any worker the host seated and a Loop's reviewer; nobody else. */
export function appLookFor(seat: ProjectToolSeat): LiveToolSpec[] {
  return seat === ProjectToolSeat.None ? [] : [APP_LOOK_TOOL];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A name as one plain, clipped line. */
function plain(text: string): string {
  const line = text.replace(CONTROL_CHARACTERS, " ").trim();
  return line.length <= NAME_MAX_CHARS ? line : `${line.slice(0, NAME_MAX_CHARS - 1)}…`;
}

/** A window as an answer names it. */
const named = (window: AppWindow): LookedWindow => ({
  id: window.id,
  app: plain(window.app),
  title: plain(window.title),
});

/** A string argument, trimmed; anything else is empty. */
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

/** A tool answer that showed nothing. */
const refusal = (words: string): LiveToolResult => ({ text: words, isError: true });

/** What the person must still allow, after asking macOS once when Genex never has. */
async function missingAccess(access: ScreenAccess | null): Promise<AppLookAccessKind[]> {
  if (!access) return [];
  const first = accessStep(access.status(), await access.asked());
  if (first.step === AccessStep.Look) return [];
  if (first.step === AccessStep.Missing) return first.missing;
  await access.askOnce();
  return accessStep(access.status(), true).missing;
}

/** Tell the agent what is missing, and the chat once this app session. A failed line is logged, never the answer. */
async function accessMissing(
  core: StudioCore,
  caller: LookCaller,
  missing: AppLookAccessKind[],
): Promise<LiveToolResult> {
  const told = toldChats.get(core) ?? new Set<string>();
  toldChats.set(core, told);
  const threadId = caller.chatThreadId;
  if (threadId && !told.has(threadId)) {
    told.add(threadId);
    try {
      await core.append([customEventData(CustomEvent.AppLookAccess, { project: caller.project, missing })], threadId);
      core.emit(UiEvent.ThreadUpdated, { threadId, project: caller.project });
    } catch (error) {
      core.options.onLog?.(MESSAGE.notRecorded(error), "stderr");
    }
  }
  return refusal(APP_LOOK_ANSWER.missing(missing));
}

/** A port's problem, as the agent reads it. */
function problemAnswer(
  core: StudioCore,
  caller: LookCaller,
  found: AppLookProblem,
): Promise<LiveToolResult> | LiveToolResult {
  if (found.problem === AppLookProblemCode.NoScreenAccess)
    return accessMissing(core, caller, [AppLookAccessKind.Screen]);
  if (found.problem === AppLookProblemCode.NoAxAccess)
    return accessMissing(core, caller, [AppLookAccessKind.Accessibility]);
  if (found.problem === AppLookProblemCode.Unsupported) return refusal(APP_LOOK_ANSWER.unsupported);
  if (found.problem === AppLookProblemCode.NotOnScreen) return refusal(APP_LOOK_ANSWER.notOnScreen);
  if (found.problem === AppLookProblemCode.Refused) return refusal(APP_LOOK_ANSWER.refused);
  return refusal(APP_LOOK_ANSWER.failed(found.detail ?? ""));
}

/** Whether a save path has the shape Genex takes: relative, plain segments, a .jpg, within the length. */
function isSavePath(file: string): boolean {
  if (!file || file.length > SAVE_PATH_MAX_CHARS || !file.toLowerCase().endsWith(SAVE_EXTENSION)) return false;
  try {
    assertRelativePath(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a picture can't be kept at `file` in the caller's folder, or null once it is: only a session
 * that may write, not in Plan, a plain relative .jpg path whose folders are real folders inside its
 * own (made where missing, never through a link) and outside what it never touches.
 */
async function savePicture(caller: LookCaller, file: string, image: AppLookImage | null) {
  const save = caller.save;
  if (!image) return APP_LOOK_ANSWER.saveNoPicture;
  if (!save) return APP_LOOK_ANSWER.saveNoWrite;
  if (await save.planning()) return APP_LOOK_ANSWER.saveInPlan;
  if (!isSavePath(file)) return APP_LOOK_ANSWER.saveBadPath;
  const segments = file.split("/");
  const name = segments.pop() ?? "";
  // The folder by its real path (a games folder or game reached through a link): the made folders
  // answer real paths, so the check below compares like with like.
  const root = await realpath(save.folder).catch(() => null);
  if (!root) return APP_LOOK_ANSWER.saveOutside;
  // Refused before any folder is made: a path into what it never touches leaves nothing behind.
  const untouchable = (target: string) => pathVerdict({ path: target, searches: false }, save.neverTouch);
  const planned = [save.folder, root].map((base) => path.join(base, ...segments, name));
  if (planned.some(untouchable)) return APP_LOOK_ANSWER.saveOutside;
  try {
    const dir = await ensureDirBelow(root, segments);
    const target = path.join(dir, name);
    if (!isBelow(root, target) || untouchable(target)) return APP_LOOK_ANSWER.saveOutside;
    await writeFileInDir(dir, name, Buffer.from(image.data, "base64"));
    return null;
  } catch {
    return APP_LOOK_ANSWER.saveOutside;
  }
}

/** One window's look, as the agent reads it; with `save`, its picture also kept in the caller's folder. */
async function lookAt(core: StudioCore, caller: LookCaller, window: AppWindow, save: string | null) {
  if (lookRefused(window)) return refusal(APP_LOOK_ANSWER.refused);
  const looked = await core.appLook.look(window);
  if (isAppLookProblem(looked)) return problemAnswer(core, caller, looked);
  const unsaved = save === null ? undefined : await savePicture(caller, save, looked.image);
  const notes = [
    ...(looked.truncated ? [APP_LOOK_ANSWER.truncated] : []),
    ...(looked.image ? [] : [APP_LOOK_ANSWER.noPicture(looked.note ?? "")]),
    ...(save === null ? [] : [unsaved ? APP_LOOK_ANSWER.notSaved(unsaved) : APP_LOOK_ANSWER.saved(save)]),
  ];
  return {
    text: APP_LOOK_ANSWER.looked(named(looked.window), looked.tree, notes),
    images: looked.image ? [looked.image] : [],
  };
}

/**
 * `app_look`: the windows on screen without arguments (the ones it never looks at left out, see
 * {@link lookRefused}), else the window asked for, looked at. Access missing answers what the person must turn on.
 */
export async function runAppLook(
  core: StudioCore,
  args: Record<string, unknown>,
  caller: LookCaller,
): Promise<LiveToolResult> {
  const missing = await missingAccess(core.screenAccess);
  if (missing.length) return accessMissing(core, caller, missing);
  const windows = await core.appLook.windows();
  if (isAppLookProblem(windows)) return problemAnswer(core, caller, windows);
  const app = text(args.app);
  const window = text(args.window);
  if (!app && !window) return APP_LOOK_ANSWER.windows(windows.filter((shown) => !lookRefused(shown)).map(named));
  const picked = pickWindow(windows, { app, window });
  const save = typeof args.save === "string" ? args.save.trim() : null;
  return picked ? lookAt(core, caller, picked, save) : refusal(APP_LOOK_ANSWER.noMatch);
}
