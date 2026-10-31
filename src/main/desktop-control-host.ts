/**
 * Computer control as this computer's app wires it: the cua-driver bundled with the app (an
 * installed one in a development build), run as the app's own embedded daemon — on a Mac so macOS
 * charges Accessibility and Screen Recording to Genex itself (or a VM's driver over SSH, when
 * `GENEX_COMPUTER_VM` names one), on Windows with no grant to ask for — the studio's own windows
 * never driven, and one global shortcut that stops every desktop session (⌃⌥⌘Esc on a Mac,
 * Ctrl+Alt+Shift+Esc on Windows: `shared/computer-control.ts`), registered only while one holds the
 * computer.
 */
import { app, desktopCapturer, globalShortcut, shell, systemPreferences } from "electron";
import { StudioPlatform } from "../shared/boot.ts";
import { computerControlOffered, desktopStopShortcut } from "../shared/computer-control.ts";
import { type DesktopControl, desktopControl } from "./core/desktop-control.ts";
import {
  awaitGrants,
  connectCuaDriver,
  driverEnv,
  findCuaDriver,
  GrantHolder,
  GrantStage,
  openConnection,
  vmDriverCommand,
} from "../substrate/cua-driver-client.ts";
import {
  bundledCuaDriver,
  type EmbeddedCuaDriver,
  embeddedCuaDriver,
  HOST_BUNDLE_ID,
  hostAppName,
} from "../substrate/cua-embedded.ts";
import type { DesktopApp } from "../substrate/desktop-driver.ts";

/** Where macOS lets the person turn screen recording on for an app. */
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/**
 * Ask macOS for one of Genex's own grants: Accessibility through its prompt; Screen Recording by a
 * capture attempt, which puts Genex in that list, and System Settings opened there.
 */
async function askForGrant(stage: GrantStage): Promise<void> {
  if (stage === GrantStage.Accessibility) {
    systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  if (stage !== GrantStage.ScreenRecording) return;
  await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
  await shell.openExternal(SCREEN_RECORDING_SETTINGS);
}

/** Whether an app is this studio: one of its own processes, or its own name. */
function isStudio(desktopApp: DesktopApp): boolean {
  const own = new Set(app.getAppMetrics().map((metric) => metric.pid));
  if (desktopApp.pid !== null && own.has(desktopApp.pid)) return true;
  return desktopApp.name === app.getName();
}

/**
 * Ask macOS for Genex's own grants, one at a time: Accessibility through its prompt, then Screen
 * Recording. A screen capture attempt puts Genex in the Screen Recording list (macOS raises no prompt
 * for it on every release), and System Settings opens there for the person to turn it on.
 */
async function askForGrants(): Promise<void> {
  if (!systemPreferences.isTrustedAccessibilityClient(true)) return;
  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return;
  await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
  await shell.openExternal(SCREEN_RECORDING_SETTINGS);
}

/**
 * The studio's computer control, or nothing where there is none: only macOS and Windows have a
 * desktop driver wired, and a smoke or eval profile never drives the real desktop.
 */
export function createDesktopControl(options: { automated: boolean; resources: string }): DesktopControl | undefined {
  if (!computerControlOffered(process.platform) || options.automated) return undefined;
  const mac = process.platform === StudioPlatform.Mac;
  // A VM is a macOS guest (lume), reached from a Mac.
  const vmCommand = mac && process.env.GENEX_COMPUTER_VM ? vmDriverCommand(process.env.GENEX_COMPUTER_VM) : null;
  const stop = desktopStopShortcut(process.platform).accelerator;
  let control: DesktopControl | null = null;
  let embedded: EmbeddedCuaDriver | null = null;
  const onActive = (count: number) => {
    const held = globalShortcut.isRegistered(stop);
    if (count > 0 && !held) globalShortcut.register(stop, () => void control?.stopAll());
    if (count === 0 && held) globalShortcut.unregister(stop);
  };
  const daemonFor = (binary: string) => {
    embedded ??= embeddedCuaDriver({ command: binary, args: [] }, { hostBundleId: HOST_BUNDLE_ID, env: driverEnv() });
    return embedded;
  };
  const connectLocal = (binary: string) => {
    const daemon = daemonFor(binary);
    return connectCuaDriver(() => daemon.command(), {
      local: true,
      holder: GrantHolder.Host,
      restart: () => daemon.restart(),
      ...(mac ? { askForGrants, hostApp: hostAppName(process.execPath) } : {}),
    });
  };
  control = desktopControl({
    findDriver: async () => (vmCommand ? "ssh" : findCuaDriver({ bundled: bundledCuaDriver(options.resources) })),
    connect: (binary) => (vmCommand ? connectCuaDriver(vmCommand, { local: false }) : connectLocal(binary)),
    ownApp: isStudio,
    ...(vmCommand ? { vm: true } : {}),
    // A press that hands a task to computer control waits here for the person to allow Genex.
    ...(mac && !vmCommand
      ? {
          awaitGrants: (binary: string, signal?: AbortSignal) => {
            const daemon = daemonFor(binary);
            return awaitGrants(async () => openConnection(await daemon.command()), {
              ask: askForGrant,
              restart: () => daemon.restart(),
              ...(signal ? { signal } : {}),
            });
          },
        }
      : {}),
    onActive,
    // A page of the task the agent answers (Creator Hub), in the browser where the person is signed in.
    ...(vmCommand ? {} : { openPage: (address: string) => shell.openExternal(address) }),
    shutdown: async () => {
      await embedded?.stop();
    },
  });
  return control;
}
