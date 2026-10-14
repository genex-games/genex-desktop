/**
 * The Chromium switches the Linux Studio would need for WebGPU in its game preview, applied before
 * the app is ready and only with the owner's approval. Electron 43.7.6 on Linux finds no WebGPU
 * adapter without switches; with the set below it reached WebGPU core on SwiftShader (the M0a.13
 * runner probe). Until the owner approves the set, the record is `linux-studio-webgpu: no`: a
 * Rust · wgpu game's web preview on the Linux Studio would show its unsupported page, so the
 * Linux Studio lists no Rust row yet (`STACK_HOST_MATRIX`): its native Linux run is not prepared
 * either. `index.ts` calls {@link applyLinuxWebGpuSwitches} once, before `app.whenReady()`.
 */
import { StudioPlatform } from "../shared/boot.ts";

/** The owner's record for the Linux Studio's WebGPU switches. Never rename a value. */
export const LinuxWebGpuApproval = {
  /** Not approved: the Linux Studio's web preview has no WebGPU. */
  None: "none",
  /** The owner approved {@link LINUX_WEBGPU_SWITCHES} on Linux. */
  Switches: "switches",
} as const;
export type LinuxWebGpuApproval = (typeof LinuxWebGpuApproval)[keyof typeof LinuxWebGpuApproval];

/**
 * The owner's current record (the M0b memo and the run's owner gates): no approval. Flipping it
 * is the owner's decision, made with the Linux Studio preview check's own record.
 */
export const LINUX_WEBGPU_APPROVAL: LinuxWebGpuApproval = LinuxWebGpuApproval.None;

/** One Chromium switch, as `app.commandLine.appendSwitch(name, value)` takes it. */
export interface ChromiumSwitch {
  readonly name: string;
  readonly value?: string;
}

/**
 * The switch set the M0a.13 probe recorded reaching WebGPU core on Electron 43.7.6 / Chrome 150
 * (Dawn on SwiftShader Vulkan, not a fallback adapter). It never loosens a sandbox: the probe ran
 * the browser with `--no-sandbox` for its CI container, which is not part of this set.
 */
export const LINUX_WEBGPU_SWITCHES: readonly ChromiumSwitch[] = Object.freeze([
  { name: "enable-unsafe-webgpu" },
  { name: "enable-features", value: "Vulkan" },
  { name: "use-vulkan", value: "swiftshader" },
  { name: "use-angle", value: "swiftshader" },
  { name: "enable-unsafe-swiftshader" },
  { name: "ignore-gpu-blocklist" },
]);

/** The switches `platform` gets under `approval`: the set on Linux with the owner's approval, else none. */
export function linuxWebGpuSwitches(platform: string, approval: unknown): readonly ChromiumSwitch[] {
  const approved = approval === LinuxWebGpuApproval.Switches;
  return platform === StudioPlatform.Linux && approved ? LINUX_WEBGPU_SWITCHES : [];
}

/** The part of Electron's `app.commandLine` the switches are appended to. */
export interface SwitchableCommandLine {
  appendSwitch(name: string, value?: string): void;
}

/**
 * Appends the approved switches to `commandLine` (before the app is ready, or Chromium ignores
 * them) and answers how many it appended. Defaults: this process's platform and the owner's record.
 */
export function applyLinuxWebGpuSwitches(
  commandLine: SwitchableCommandLine,
  options: { platform?: string; approval?: LinuxWebGpuApproval } = {},
): number {
  const switches = linuxWebGpuSwitches(options.platform ?? process.platform, options.approval ?? LINUX_WEBGPU_APPROVAL);
  for (const entry of switches) commandLine.appendSwitch(entry.name, entry.value);
  return switches.length;
}
