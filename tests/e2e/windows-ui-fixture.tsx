/** Production Windows UI components in an Electron fixture; no accounts, providers or OS setup. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SandboxSetup } from "../../src/renderer/SandboxSetup.tsx";
import { useAppShortcuts } from "../../src/renderer/use-app-shortcuts.ts";
import { SandboxProblemCode, StudioPlatform } from "../../src/shared/boot.ts";

const calls: string[] = [];
let blocked = false;
let rerender: () => void = () => {};
type Mode = "shortcuts" | "setup" | "git-setup" | "busy" | "cancelled" | "error";
let mode: Mode = "shortcuts";
const problem = {
  platform: StudioPlatform.Windows,
  code: SandboxProblemCode.NotProvisioned,
  missingTools: [],
  installCommands: [],
  details: ["Synthetic setup problem; no installer is invoked."],
};

function Fixture() {
  const [, refresh] = useState(0);
  rerender = () => refresh((value) => value + 1);
  useAppShortcuts({
    blocked,
    search: () => calls.push("search"),
    toggleSidebar: () => calls.push("sidebar"),
    closeDrawer: () => {
      calls.push("close");
      return true;
    },
    newGame: () => calls.push("new"),
    returnToGame: () => calls.push("game"),
    enterStudio: () => calls.push("studio"),
    focusComposer: () => calls.push("composer"),
    stepRail: (step) => calls.push(`rail:${step}`),
  });
  if (mode === "shortcuts") return <input aria-label="Keyboard fixture" autoFocus />;
  return (
    <SandboxSetup
      problem={mode === "git-setup" ? { ...problem, code: SandboxProblemCode.GitMissing } : problem}
      retrying={false}
      error={mode === "error" ? "Synthetic failure in C:/a-very-long-path/".repeat(18) : null}
      onRetry={() => calls.push("retry")}
      setUp={{ settingUp: mode === "busy", cancelled: mode === "cancelled", onSetUp: () => calls.push("setup") }}
    />
  );
}

declare global {
  interface Window {
    windowsFixture: {
      calls(): string[];
      reset(): void;
      mode(value: Mode): void;
      block(value: boolean): void;
    };
  }
}
window.windowsFixture = {
  calls: () => [...calls],
  reset: () => {
    calls.length = 0;
  },
  mode: (value) => {
    mode = value;
    rerender();
  },
  block: (value) => {
    blocked = value;
    rerender();
  },
};
document.documentElement.dataset.platform = StudioPlatform.Windows;
const root = document.getElementById("root");
if (!root) throw new Error("Windows UI fixture root is missing");
createRoot(root).render(<Fixture />);
