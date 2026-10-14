/**
 * The person's launch of a game's packaged phone build on the iOS Simulator, an Android emulator
 * or a phone (`studio:native.launchDevice`), above the stage like the native run card. Containment
 * stage 1: a device run is outside Genex's sandbox, so it is only ever a button the person
 * presses here; no agent can press it. One button per device a destination of the game runs on
 * (the Simulator and an iPhone only from a Mac); the last launch's outcome is said beside them.
 */
import { type JSX, useState } from "react";
import { StudioPlatform } from "../../../shared/boot.ts";
import {
  DeviceKind,
  DeviceLaunchOutcome,
  type DeviceLaunchResult,
  type DeviceTarget,
} from "../../../shared/device-launch.ts";
import { BuildTarget, destinationsOf, type GameProject } from "../../../shared/game-project.ts";
import { NativeRefusal } from "../../../shared/native-contract.ts";
import { type Notify, notifyProblem } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { hostOf } from "../../../shared/game-targets.ts";
import { hostPlatform } from "../../platform.ts";
import { NATIVE_WORDS } from "../../words.ts";

/** One device a destination runs on, as its button offers it. */
interface DeviceChoice {
  target: DeviceTarget;
  device: DeviceKind;
  label: string;
}

/** The row's own words. */
const MESSAGE = {
  heading: "On a device",
  idle: "Installs the latest packaged build and starts it.",
  launching: "Installing and starting",
  launched: "Started on the device.",
  failed: "The device didn’t install or start the game.",
  /** The refusals a launch says in its own words; any other is the run card's. */
  refusal: {
    [NativeRefusal.Unsupported]: "Export this destination first: there’s no packaged build to install yet.",
    [NativeRefusal.NotRunnableHere]: "No device is ready: start one (or connect your phone) and try again.",
    [NativeRefusal.Symlink]: "The packaged build holds a link, so it wasn’t installed.",
    [NativeRefusal.HardLink]: "The packaged build is linked from somewhere else, so it wasn’t installed.",
  } as Partial<Record<NativeRefusal, string>>,
  choice: {
    [BuildTarget.Ios]: { [DeviceKind.Simulator]: "Simulator", [DeviceKind.Phone]: "iPhone" },
    [BuildTarget.Android]: { [DeviceKind.Emulator]: "Emulator", [DeviceKind.Phone]: "Android phone" },
  },
} as const;

/** The devices each phone destination offers, and whether this host can reach them. */
function choicesFor(game: GameProject, host: StudioPlatform | null): DeviceChoice[] {
  const targets = destinationsOf(game).targets;
  const choices: DeviceChoice[] = [];
  if (targets.includes(BuildTarget.Ios) && host === StudioPlatform.Mac) {
    for (const device of [DeviceKind.Simulator, DeviceKind.Phone] as const)
      choices.push({ target: BuildTarget.Ios, device, label: MESSAGE.choice[BuildTarget.Ios][device] });
  }
  if (targets.includes(BuildTarget.Android)) {
    for (const device of [DeviceKind.Emulator, DeviceKind.Phone] as const)
      choices.push({ target: BuildTarget.Android, device, label: MESSAGE.choice[BuildTarget.Android][device] });
  }
  return choices;
}

/** What the last launch came to, in the person's words. */
function outcomeWords(result: DeviceLaunchResult): string {
  if (result.outcome === DeviceLaunchOutcome.Launched) return MESSAGE.launched;
  if (result.outcome === DeviceLaunchOutcome.Failed) return MESSAGE.failed;
  const refusal = result.refusal;
  if (!refusal) return MESSAGE.failed;
  return MESSAGE.refusal[refusal] ?? NATIVE_WORDS.refusal[refusal];
}

/** What the row says: launching, the last launch's outcome, or what a launch does. */
function statusWords(busy: boolean, last: DeviceLaunchResult | null): string {
  if (busy) return MESSAGE.launching;
  return last ? outcomeWords(last) : MESSAGE.idle;
}

/** The device launch row for `game`, or nothing when the game names no phone destination this host reaches. */
export function DeviceLaunch({ game, onNotice }: { game: GameProject; onNotice: Notify }): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<DeviceLaunchResult | null>(null);
  const choices = choicesFor(game, hostOf(hostPlatform()));
  if (choices.length === 0) return null;
  const launch = (choice: DeviceChoice): void => {
    setBusy(`${choice.target}:${choice.device}`);
    window.studio
      .nativeLaunchDevice(game.name, { target: choice.target, device: choice.device })
      .then(setLast, notifyProblem(onNotice))
      .finally(() => setBusy(null));
  };
  const status = statusWords(busy !== null, last);
  return (
    <div
      data-stage-device-launch={last?.outcome ?? ""}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5"
    >
      <span className="text-body-sm font-medium text-ink">{MESSAGE.heading}</span>
      <span role="status" className="min-w-32 flex-1 text-xs leading-relaxed text-pretty text-ink-3">
        <span className={busy ? "chat-status-shimmer" : undefined}>{status}</span>
      </span>
      <span className="ms-auto flex shrink-0 items-center gap-2">
        {choices.map((choice) => (
          <Button
            key={`${choice.target}:${choice.device}`}
            data-stage-device-action={`${choice.target}:${choice.device}`}
            disabled={busy !== null}
            onClick={() => launch(choice)}
          >
            {choice.label}
          </Button>
        ))}
      </span>
    </div>
  );
}
