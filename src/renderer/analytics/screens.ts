/**
 * The screen analytics reports: where the person is, as a path from the app's own vocabularies
 * (/welcome/connect, /game/live, /settings/privacy) — never what is on it. The page's real
 * address is file:///…/index.html, which can hold the user's name, so while analytics runs every
 * URL PostHog would send becomes this screen under https://studio.invalid.
 */
import { WelcomeScreen } from "../onboarding/state.ts";
import { SettingsSection } from "../settings-navigation.ts";
import { StageView } from "../stage.ts";
import { PlayPage } from "../state/play.ts";
import { Room } from "../state/threads.ts";

/** The screens with no part of their own: what covers the window, or a room. */
export const AnalyticsScreen = {
  Home: "/home",
  /** Home while a first message is starting its game. */
  HomeLaunching: "/home/launching",
  Harness: "/harness",
  Plugins: "/plugins",
  Items: "/items",
  Search: "/search",
  Feedback: "/feedback",
  OpenFolder: "/open-folder",
  PlayViewer: "/play/viewer",
  Welcome: "/welcome",
} as const;
export type AnalyticsScreen = (typeof AnalyticsScreen)[keyof typeof AnalyticsScreen];

const welcomeScreen = (step: WelcomeScreen): string =>
  step === WelcomeScreen.Welcome ? AnalyticsScreen.Welcome : `${AnalyticsScreen.Welcome}/${step}`;
const gameScreen = (view: StageView): string => `/game/${view}`;
const settingsScreen = (section: SettingsSection): string => `/settings/${section}`;
const playScreen = (page: PlayPage): string => `/play/${page}`;

/** Where the person is, from the shell's own state. */
export interface ScreenPlace {
  welcoming: boolean;
  /** The welcome's own screen while it is up; null reads as its first. */
  welcomeScreen: WelcomeScreen | null;
  /** A game playing in Play's viewer, over everything. */
  playViewer: boolean;
  /** The open Settings section, or null while Settings is closed. */
  settings: SettingsSection | null;
  searching: boolean;
  feedback: boolean;
  /** The Open a folder sheet. */
  openFolder: boolean;
  plugins: boolean;
  items: boolean;
  /** Play's page while Play covers the workspace, else null. */
  play: PlayPage | null;
  room: Room;
  /** Home's first message is starting a game. */
  launching: boolean;
  stageView: StageView;
}

/** The covers above the workspace, in the order they sit: the first that is up names the screen. */
const COVERS: ReadonlyArray<[(place: ScreenPlace) => boolean, (place: ScreenPlace) => string]> = [
  [(p) => p.welcoming, (p) => welcomeScreen(p.welcomeScreen ?? WelcomeScreen.Welcome)],
  [(p) => p.playViewer, () => AnalyticsScreen.PlayViewer],
  [(p) => p.settings !== null, (p) => settingsScreen(p.settings ?? SettingsSection.Providers)],
  [(p) => p.searching, () => AnalyticsScreen.Search],
  [(p) => p.feedback, () => AnalyticsScreen.Feedback],
  [(p) => p.openFolder, () => AnalyticsScreen.OpenFolder],
  [(p) => p.plugins, () => AnalyticsScreen.Plugins],
  [(p) => p.items, () => AnalyticsScreen.Items],
  [(p) => p.play !== null, (p) => playScreen(p.play ?? PlayPage.Shelf)],
];

/** The room under every cover. */
function roomScreen(place: ScreenPlace): string {
  if (place.room === Room.Studio) return AnalyticsScreen.Harness;
  if (place.room === Room.Build) return gameScreen(place.stageView);
  return place.launching ? AnalyticsScreen.HomeLaunching : AnalyticsScreen.Home;
}

/** The screen analytics reports: what covers the window first, else the room. */
export function analyticsScreen(place: ScreenPlace): string {
  const cover = COVERS.find(([up]) => up(place));
  return cover ? cover[1](place) : roomScreen(place);
}

/** Every screen the app can name; an address fragment that is not one of them is not trusted. */
export const SCREENS: ReadonlySet<string> = new Set([
  ...Object.values(AnalyticsScreen),
  ...Object.values(WelcomeScreen).map(welcomeScreen),
  ...Object.values(StageView).map(gameScreen),
  ...Object.values(SettingsSection).map(settingsScreen),
  ...Object.values(PlayPage).map(playScreen),
]);

/** Screens are paths under a name that never resolves. */
export const SCREEN_ORIGIN = "https://studio.invalid";
/** The screen before the shell has named one. */
const START_SCREEN = "/";

let screen = START_SCREEN;

/** The screen the person is on now. */
export const currentScreen = (): string => screen;
/** The screen as the URL PostHog files events under. */
export const screenUrl = (): string => SCREEN_ORIGIN + screen;

/** The person moved; true when the screen changed. */
export function screenChanged(path: string): boolean {
  if (path === screen) return false;
  screen = path;
  return true;
}
