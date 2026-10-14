/**
 * Which Electron the frames path is trusted on. `sharedTexture` is new and its behavior was
 * measured on one major only (`.studio-dev` m5a RESULTS §4–§5: Electron 43.7.6): another major may
 * change when a send resolves or when references are swept, so Live embeds no game there and
 * offers Pop out instead. Adding a major means re-running that end-to-end check first.
 */
import { NativeRefusal } from "../shared/native-contract.ts";

/** The Electron majors whose `sharedTexture` the embedded frames path was measured on. */
export const ELECTRON_TESTED_MAJORS = [43] as const;

/** Null when `major` is a tested Electron; otherwise the refusal Live's embed answers with. */
export function electronSupportsFrames(major: number): NativeRefusal | null {
  return ELECTRON_TESTED_MAJORS.some((tested) => tested === major) ? null : NativeRefusal.ElectronUntested;
}
