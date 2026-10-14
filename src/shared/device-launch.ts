/**
 * A person-initiated launch of a game's admitted phone build on a Simulator, an emulator or a phone
 * (`studio:native.launchDevice`). Containment stage 1: a device run is outside ProcessSandbox, so
 * only the person starts one, from Studio's window; no harness method reaches it
 * (docs/tool-permissions.md "Devices and emulators"). Every launch is recorded as a persisted
 * `device_launch` event with the device, the build's digest and the outcome.
 */
import { BuildTarget } from "./game-project.ts";
import { CustomEvent, type CustomEventData, customPayload } from "./custom-events.ts";
import type { NativeRefusal } from "./native-contract.ts";

/** What kind of device a launch reaches. Wire values (IPC, the `device_launch` record): never rename one. */
export const DeviceKind = {
  /** The iOS Simulator on this Mac. */
  Simulator: "simulator",
  /** An Android emulator on this computer. */
  Emulator: "emulator",
  /** A phone the person connected. */
  Phone: "phone",
} as const;
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind];

/** The phone destinations a launch may name. */
export const DEVICE_TARGETS = [BuildTarget.Ios, BuildTarget.Android] as const;
export type DeviceTarget = (typeof DEVICE_TARGETS)[number];

/** What the person asked to launch: the phone destination, the kind of device, and which one when several are attached. */
export interface DeviceLaunchRequest {
  target: DeviceTarget;
  device: DeviceKind;
  /** The Simulator's UDID or the emulator's or phone's serial; absent picks the only one there is. */
  deviceId?: string;
}

/** How a launch ended. Wire values (the `device_launch` record): never rename one. */
export const DeviceLaunchOutcome = {
  /** Installed and started on the device. */
  Launched: "launched",
  /** Refused before anything reached the device (`refusal` says why). */
  Refused: "refused",
  /** The install or the start failed on the device. */
  Failed: "failed",
} as const;
export type DeviceLaunchOutcome = (typeof DeviceLaunchOutcome)[keyof typeof DeviceLaunchOutcome];

/** What a launch answers, and what its `device_launch` record holds. */
export interface DeviceLaunchResult {
  outcome: DeviceLaunchOutcome;
  target: DeviceTarget;
  device: DeviceKind;
  /** The device the launch reached; null when it reached none. */
  deviceId: string | null;
  /** The SHA-256 of the admitted build that was installed; null when none was. */
  buildDigest: string | null;
  /** Why it was refused; null unless `outcome` is `refused`. */
  refusal: NativeRefusal | null;
  /** When it ended, ISO 8601. */
  at: string;
}

/** The persisted `device_launch` payload: the game and the launch's result. Every field optional, as old logs keep old shapes. */
export type DeviceLaunchPayload = Partial<DeviceLaunchResult> & { project?: string };

/** The `device_launch` record's payload, or null for any other event. */
export function deviceLaunchOf(data: CustomEventData): DeviceLaunchPayload | null {
  return customPayload(data, CustomEvent.DeviceLaunch);
}
