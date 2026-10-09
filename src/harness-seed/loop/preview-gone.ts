/**
 * Why a game window's renderer went away (`preview.status` `gone`, beside `crashed`): Electron's
 * `render-process-gone` reason, read by the host as one typed code. `killed` and `oom` are the
 * machine's doing (the OS reclaimed memory under pressure), not the build's. The app's copy is
 * `PreviewGone` in `shared/preview-contract.ts`; the values are the host's: never rename one.
 *
 * A module of its own: a seed upgrade keeps an older evidence.ts the agent edited, which never
 * imported it, and an older host answers no `gone` at all (read that as no reason given).
 */
export const PreviewGone = {
  Killed: "killed",
  Oom: "oom",
  Crashed: "crashed",
  LaunchFailed: "launch-failed",
  Abnormal: "abnormal-exit",
  Integrity: "integrity-failure",
} as const;
export type PreviewGone = (typeof PreviewGone)[keyof typeof PreviewGone];

/**
 * The `source` of a line the studio itself writes on a game window's console (the page's own
 * lines carry their script URL). `window-gone` is the host's note that the renderer went away:
 * the crash is read off `preview.status`, never counted as an error the build logged. The app's
 * copy is `PreviewConsoleSource` in `shared/preview-contract.ts`. Wire values.
 */
export const PreviewConsoleSource = {
  Observation: "studio:observation",
  WindowGone: "studio:window-gone",
} as const;
export type PreviewConsoleSource = (typeof PreviewConsoleSource)[keyof typeof PreviewConsoleSource];
