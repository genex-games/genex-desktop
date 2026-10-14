/**
 * The window's first questions, answered before (and without) a core: where startup stands, Retry
 * and Set up (Windows' sandbox, or Genex's AppArmor profile on Ubuntu) from the sandbox setup
 * screen, and the colours of the Windows and Linux title-bar controls.
 * Registered once per launch, before any window opens.
 */
import type { WindowControlColors } from "../../shared/studio-api.ts";
import type { BootGate } from "../boot-gate.ts";
import type { IpcHandle } from "./registrar.ts";

/** A colour the overlay takes: opaque `#rrggbb`, nothing a CSS parser could read more into. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const MESSAGE = {
  invalidColors: "window control colours must be two #rrggbb values",
} as const;

export interface BootIpcDeps {
  gate: BootGate;
  /** Repaint the studio window's title-bar overlay; a no-op where there is none (macOS). */
  setWindowControls(colors: WindowControlColors): void;
}

/** The two colours the renderer sent, checked; throws on anything else. */
function windowControlColors(payload: unknown): WindowControlColors {
  const { color, symbolColor } = (payload ?? {}) as Partial<Record<keyof WindowControlColors, unknown>>;
  const valid = (value: unknown): value is string => typeof value === "string" && HEX_COLOR.test(value);
  if (!valid(color) || !valid(symbolColor)) throw new Error(MESSAGE.invalidColors);
  return { color, symbolColor };
}

export function registerBootIpc(handle: IpcHandle, { gate, setWindowControls }: BootIpcDeps): void {
  handle("studio:boot", () => gate.state());
  handle("studio:boot.retry", () => gate.retry());
  handle("studio:boot.setup", () => gate.setUp());
  handle("studio:window.controls", (payload) => {
    setWindowControls(windowControlColors(payload));
  });
}
