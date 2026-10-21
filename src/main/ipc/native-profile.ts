/**
 * `studio:native.profile`: Live's frame profile of the game it shows (game-systems PROF-6, read by
 * the stage's profile strip). A fixture-safe read: the native run the person sees (Live's embedded
 * run first, then the Play window), else the Rust web page Live shows for that same game. The
 * game and the request are checked by the registrar first (`ipc/native.ts`).
 */
import {
  type FrameProfileAnswer,
  type FrameProfileRequest,
  ProfileUnavailableReason,
  profileUnavailable,
} from "../../shared/frame-profile.ts";
import { NativeRunMode } from "../../shared/native-contract.ts";
import { previewFrameProfile } from "../../substrate/native-profile.ts";

/** The runs Live can show, in the order the person looks at them. */
const SHOWN_MODES = [NativeRunMode.Embedded, NativeRunMode.Window] as const;

/** A native run's port, as far as the profile reads it. */
interface ProfiledRun {
  frameProfile(request: FrameProfileRequest): Promise<FrameProfileAnswer>;
}

/** Live's web page, as far as the profile reads it: which game it shows, and its page verbs. */
export interface LiveProfilePage {
  status(): { project: string | null };
  studioCall(method: string, arg?: unknown): Promise<unknown>;
}

/** What the Live profile reads: the run registry's ports and, where there is a window, Live's page. */
export interface NativeProfileDeps {
  nativeRuns: { portOf(project: string, mode?: NativeRunMode): ProfiledRun | null };
  livePreview?: () => LiveProfilePage | null;
}

/** The run of `project` the person sees, embedded first; null when none runs. */
function shownPort(deps: NativeProfileDeps, project: string): ProfiledRun | null {
  for (const mode of SHOWN_MODES) {
    const port = deps.nativeRuns.portOf(project, mode);
    if (port) return port;
  }
  return null;
}

/**
 * The frame profile of what Live shows of `project` for a checked `request`: the native run's, or
 * the Live page's when it shows that game; `no-run` when neither does. Never another game's page.
 */
export async function answerNativeProfile(
  deps: NativeProfileDeps,
  project: string,
  request: FrameProfileRequest,
): Promise<FrameProfileAnswer> {
  const port = shownPort(deps, project);
  if (port) return port.frameProfile(request);
  const page = deps.livePreview?.() ?? null;
  if (page?.status().project !== project) return profileUnavailable(ProfileUnavailableReason.NoRun);
  return previewFrameProfile(page, request);
}
