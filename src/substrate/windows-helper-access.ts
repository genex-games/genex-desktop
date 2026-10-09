/** Read/execute access for srt-win's self-launched probe before the runtime grants any roots. */
import { SandboxProblemCode, StudioPlatform } from "../shared/boot.ts";
import { SandboxUnavailableError } from "./sandbox-unavailable.ts";

export interface WindowsHelperAccess {
  grant(): Promise<void>;
  revoke(): Promise<void>;
  revokeSync(): void;
}

const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
type HelperRuntime = Pick<
  typeof import("@anthropic-ai/sandbox-runtime"),
  | "resolveSrtWin"
  | "getWindowsSandboxUserStatusAsync"
  | "getWindowsWfpStatusAsync"
  | "grantWindowsAcl"
  | "revokeWindowsAcl"
>;

/** Share srt-win's PID-refcounted ACL journal; never grant the helper's containing directory. */
export function windowsHelperAccess(file: string, runtime?: HelperRuntime): WindowsHelperAccess {
  let release: (() => void) | null = null;
  const revokeSync = (): void => {
    release?.();
    release = null;
  };
  return {
    async grant() {
      const srt: HelperRuntime = runtime ?? (await import(SRT_PACKAGE));
      const srtWin = srt.resolveSrtWin({ path: file });
      const user = await srt.getWindowsSandboxUserStatusAsync({ srtWin });
      // SDK dependency preflight throws an untyped Error before its Windows error mapping.
      // Read structured status here, before ACL mutation, so main opens built-in setup.
      const ready = user.provisioned && user.credPresent && !!user.sid;
      const wfp = ready ? await srt.getWindowsWfpStatusAsync({ srtWin }) : null;
      if (!ready || wfp?.state === "absent" || !user.sid)
        throw new SandboxUnavailableError({
          platform: StudioPlatform.Windows,
          code: SandboxProblemCode.NotProvisioned,
          missingTools: [],
          installCommands: [],
          details: [],
        });
      const sandboxUserSid = user.sid;
      // Register cleanup before mutation. Runtime reset uses the same holder PID and releases
      // this file along with its session roots; failed preflight needs this explicit cleanup.
      release = () => srt.revokeWindowsAcl({ sandboxUserSid, srtWin });
      srt.grantWindowsAcl({ write: [], read: [file], sandboxUserSid, srtWin });
    },
    async revoke() {
      revokeSync();
    },
    revokeSync,
  };
}
