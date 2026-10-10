/** Why a confined native process ended. */
export const NativeEndReason = { Exit: "exit", Cancelled: "cancelled", Timeout: "timeout" } as const;
export type NativeEndReason = (typeof NativeEndReason)[keyof typeof NativeEndReason];

/** One confined native run: what it runs, what it may read and write, and its limits. */
export interface NativeProcessRequest {
  binary: string;
  binaryRoot?: string;
  args: string[];
  cwd: string;
  scratch: string;
  reads: string[];
  writes: string[];
  denyRead: string[];
  gpu?: boolean;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Captured outcome after a native process and its sandbox broker stop. */
export interface NativeProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  reason: string;
  pid: number | null;
}
