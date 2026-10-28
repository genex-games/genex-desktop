/**
 * The command-line switches a launch reads, and the one parser for them. The smoke, self test and
 * acceptance runners and the developer launch are chosen by these; a normal launch has none.
 * Kept apart from `launch-context.ts`, which main imports only for a developer launch because it
 * reads the checkout's `scripts/studio-dev` files.
 */
import { StudioPlatform } from "../../shared/boot.ts";
import { Locale, LOCALES } from "../../shared/locale.ts";

/** Every switch main and its runners read. Values are the argv spelling runners pass: never rename one. */
export const StudioFlag = {
  /** Boot the real app, report whether it came up clean, quit. */
  Smoke: "--studio-smoke",
  /** Enable bounded performance diagnostics without developer control. */
  Diagnostics: "--studio-diagnostics",
  /** The in-app end-to-end self test. */
  SelfTest: "--studio-selftest",
  /** Any developer switch; a developer launch also carries {@link StudioFlag.DevLaunch}. */
  Dev: "--studio-dev",
  /** `=<launch.json>`: the owned developer profile to launch into. */
  DevLaunch: "--studio-dev-launch",
  BuildSmoke: "--studio-build-smoke",
  /** `=<png>`: where the build smoke saves its screenshots. */
  BuildShot: "--studio-build-shot",
  ComputerSmoke: "--studio-computer-smoke",
  /** `=<png>`: where the computer smoke saves its screenshot. */
  ComputerShot: "--studio-computer-shot",
  TerminalSmoke: "--studio-terminal-smoke",
  /** `=<png>`: where the smoke saves the sign-in screenshot. */
  LoginShot: "--studio-login-shot",
  /** `=<png>`: a PNG of the smoke window when it finishes. */
  Shot: "--studio-shot",
  /** `=<dir>`: the asset previews the smoke opens. */
  AssetsSmokeDir: "--studio-assets-smoke-dir",
  /** `=<root>`: the live provider acceptance's disposable root. */
  ProviderAcceptance: "--studio-provider-acceptance",
  /** `=<root>`: the local Bonsai acceptance's disposable root. */
  BonsaiAcceptance: "--studio-bonsai-acceptance",
  /** `=<spec.json>`: run one eval lane (`smoke/eval-lane.ts`); a smoke launch only. */
  EvalLane: "--studio-eval-lane",
  /** The eval lane runs on the scripted fixture engines instead of real providers. */
  EvalFixture: "--studio-eval-fixture",
  /** `=<model>`: the Bonsai model the acceptance pulls. */
  BonsaiModel: "--bonsai-model",
  /** `=<url>`: the Ollama the engines and the smoke talk to. */
  OllamaHost: "--ollama-host",
  /** `=<dir>`: the test run's data folder instead of a fresh temporary one. */
  UserData: "--userdata",
  /** Keep the self test's temporary data folder. */
  KeepUserData: "--keep-userdata",
  /** Show the self test's window. */
  Show: "--show",
  /**
   * `=<file>`: the self test also runs one Claude Code worker against the scripted Anthropic
   * stand-in its runner named in `ANTHROPIC_BASE_URL`, whose command writes `<file>` in the
   * worker's folder (`smoke/claude-worker-check.ts`).
   */
  ClaudeWorkerCheck: "--claude-worker-check",
} as const;
export type StudioFlag = (typeof StudioFlag)[keyof typeof StudioFlag];

const LAUNCH_SWITCHES: readonly string[] = Object.values(StudioFlag);
/** Windows' installer launches the app to make or remove shortcuts, then it exits at once. */
const SQUIRREL_SWITCH = "--squirrel-";

/** Whether `arg` makes a launch something other than the person opening Genex: a runner's, a developer's or the installer's. */
export function isLaunchSwitch(arg: string): boolean {
  if (arg.startsWith(SQUIRREL_SWITCH)) return true;
  return LAUNCH_SWITCHES.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/** The person opening Genex: no runner, developer or installer switch. */
export function isNormalLaunch(argv: readonly string[]): boolean {
  return !argv.some(isLaunchSwitch);
}

/** `--studio-expected-<engine>=<status>`: the connection status the smoke expects for one engine. */
export type ExpectedStatusFlag = `--studio-expected-${string}`;

/** The switch that names the status the smoke expects for `engine`. */
export function expectedStatusFlag(engine: string): ExpectedStatusFlag {
  return `--studio-expected-${engine}`;
}

/** A Chromium command-line switch and its value, as `app.commandLine.appendSwitch` takes them. */
export type ChromiumSwitch = readonly [name: string, value: string];

/**
 * Switches a test launch needs before the app is ready. The self test and the smoke park a shown
 * window off the visible desktop; Windows' native occlusion tracking would call it hidden and stop
 * requestAnimationFrame, freezing the game under test. A normal launch never changes Chromium.
 */
export function testLaunchChromiumSwitches(launch: {
  platform: NodeJS.Platform;
  testLaunch: boolean;
}): ChromiumSwitch[] {
  if (!launch.testLaunch || launch.platform !== StudioPlatform.Windows) return [];
  return [["disable-features", "CalculateNativeWinOcclusion"]];
}

/** The language a test or fixture launch pins, so its checks read the English they were written in. */
const TEST_LANGUAGE = "en-US";
/** Chromium's tag for an app language where it spells it differently. */
const CHROMIUM_LANGUAGE: Partial<Record<Locale, string>> = { [Locale.ChineseSimplified]: "zh-CN" };

/** `STUDIO_FIXTURE_LANGUAGE=system`: the launch finds its language as a person's does. */
const FIXTURE_SYSTEM_LANGUAGE = "system";

/**
 * `--lang` for a test or fixture launch: English, which its checks read, unless the launch asks for
 * one of the app's languages (`STUDIO_FIXTURE_LANGUAGE=ru`) to look at it, or for the computer's
 * (`system`, with `STUDIO_FIXTURE_SYSTEM_LANGUAGES` standing in a list on macOS). A normal launch
 * keeps the computer's.
 */
export function testLanguageSwitches(pinned: boolean, requested?: string): ChromiumSwitch[] {
  if (!pinned || requested === FIXTURE_SYSTEM_LANGUAGE) return [];
  const locale = LOCALES.find((candidate) => candidate === requested);
  return [["lang", locale ? (CHROMIUM_LANGUAGE[locale] ?? locale) : TEST_LANGUAGE]];
}

/** Desktop names Chromium recognises ahead of KDE, or instead of it, in `XDG_CURRENT_DESKTOP`. */
const NON_KDE_XDG_DESKTOPS = new Set([
  "Unity",
  "Deepin",
  "GNOME",
  "X-Cinnamon",
  "Pantheon",
  "XFCE",
  "UKUI",
  "LXQt",
  "COSMIC",
]);
const NON_KDE_SESSIONS = new Set(["deepin", "gnome", "mate", "xubuntu", "ukui"]);
const KDE_SESSIONS = new Set(["kde4", "kde-plasma"]);

/**
 * Would Chromium pick KWallet here? It follows `base::nix::GetDesktopEnvironment`, which reads
 * `XDG_CURRENT_DESKTOP` first, then `DESKTOP_SESSION`, then the old session variables, and takes
 * the first it recognises. `KDE_SESSION_VERSION` alone proves nothing: people set it on other
 * desktops for KDE apps. Without it, a `kde` session or `KDE_FULL_SESSION` is KDE3, which has no wallet.
 */
function choosesKWallet(env: Record<string, string | undefined>): boolean {
  const hasKdeVersion = env.KDE_SESSION_VERSION !== undefined;
  for (const name of (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((part) => part.trim())) {
    if (name === "KDE") return true;
    if (NON_KDE_XDG_DESKTOPS.has(name)) return false;
  }
  const session = env.DESKTOP_SESSION ?? "";
  if (KDE_SESSIONS.has(session)) return true;
  if (session === "kde") return hasKdeVersion;
  if (NON_KDE_SESSIONS.has(session) || session.includes("xfce")) return false;
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return false;
  return env.KDE_FULL_SESSION !== undefined && hasKdeVersion;
}

/**
 * The password store Linux Chromium should use for `safeStorage`. Electron 43 selects `basic_text`,
 * which encrypts under a public key and which the secret store refuses, on any desktop Chromium
 * does not recognise (Hyprland, Sway, i3). Ask for the Secret Service there. KDE keeps KWallet,
 * and a `--password-store` the person passed is theirs; the store still stays locked if the chosen
 * backend cannot start.
 */
export function linuxSecretStorageSwitches(launch: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  hasPasswordStoreSwitch: boolean;
}): ChromiumSwitch[] {
  const keepsChromiumChoice =
    launch.platform !== StudioPlatform.Linux || launch.hasPasswordStoreSwitch || choosesKWallet(launch.env);
  return keepsChromiumChoice ? [] : [["password-store", "gnome-libsecret"]];
}

/**
 * Does closing the last window quit? Off macOS it does, except in a test launch: the self test
 * closes its window before it prints its report, and its runner decides when the app exits.
 */
export function quitsWhenLastWindowCloses(launch: { platform: NodeJS.Platform; testLaunch: boolean }): boolean {
  return launch.platform !== StudioPlatform.Mac && !launch.testLaunch;
}

/** Is the bare switch on the command line? */
export function hasFlag(flag: StudioFlag, argv: readonly string[] = process.argv): boolean {
  return argv.includes(flag);
}

/** The value of `flag=value` on the command line, or undefined when the switch is absent. */
export function flagValue(flag: StudioFlag | ExpectedStatusFlag, argv: readonly string[] = process.argv) {
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
}
