/**
 * Play: the genex.games catalog inside the app. Main reads the gallery (the API refuses the
 * renderer's origin), the renderer draws the dashboard, and a game plays full screen in a native
 * view main owns. These are the shapes and names both sides share.
 */
import type { LibraryKind } from "./asset-library.ts";

import type { PlayCuration } from "./play-manage.ts";
import type { PlayBarNative, PlayNative } from "./play-native.ts";
import type { PlayPurchaseSheet } from "./play-purchase.ts";

/** Where Play talks to genex.games: the API main calls and the website the app links to. */
export interface PlayOrigins {
  api: string;
  web: string;
}

/**
 * genex.games' own origins, which every release uses. A development profile may point Play
 * elsewhere (`main/play/origins.ts`); the renderer learns the website it links to at bootstrap.
 */
export const PLAY_ORIGIN = {
  api: "https://api.genex.games",
  web: "https://genex.games",
} as const satisfies PlayOrigins;
/** The host every published game is served under: `https://<slug>.genex.technology/`. */
export const PLAY_GAMES_DOMAIN = "genex.technology";

/**
 * The website's three shelves, each with its own tabs: what Play's sidebar lists. Values are the
 * gallery's bucket names on the wire: never rename one.
 */
export const PlayShelf = { Games: "games", Tools: "tools", Assets: "assets" } as const;
export type PlayShelf = (typeof PlayShelf)[keyof typeof PlayShelf];

/** The shelves in the website's order. */
export const PLAY_SHELVES: readonly PlayShelf[] = Object.values(PlayShelf);

/** Whether a value names a shelf. */
export const isPlayShelf = (value: unknown): value is PlayShelf =>
  typeof value === "string" && (PLAY_SHELVES as readonly string[]).includes(value);

/**
 * The dashboard's tabs. Featured is the gallery read with no category; every other value is the
 * gallery's own category name on the wire, and Tools and Assets are their shelves' whole lists.
 * Never rename a value.
 */
export const PlayCategory = {
  Featured: "featured",
  Arcade: "arcade",
  Shooter: "shooter",
  Racing: "racing",
  Sports: "sports",
  Survival: "survival",
  Exploration: "exploration",
  Multiplayer: "multiplayer",
  Fighting: "fighting",
  Tools: "tools",
  Physics: "physics",
  Terrain: "terrain",
  Lighting: "lighting",
  Vfx: "vfx",
  Assets: "assets",
} as const;
export type PlayCategory = (typeof PlayCategory)[keyof typeof PlayCategory];

/** Each shelf's tabs in the website's order; the first is the one a shelf opens on. */
export const PLAY_SHELF_TABS = {
  [PlayShelf.Games]: [
    PlayCategory.Featured,
    PlayCategory.Arcade,
    PlayCategory.Shooter,
    PlayCategory.Racing,
    PlayCategory.Sports,
    PlayCategory.Survival,
    PlayCategory.Exploration,
    PlayCategory.Multiplayer,
    PlayCategory.Fighting,
  ],
  [PlayShelf.Tools]: [
    PlayCategory.Tools,
    PlayCategory.Physics,
    PlayCategory.Terrain,
    PlayCategory.Lighting,
    PlayCategory.Vfx,
  ],
  [PlayShelf.Assets]: [PlayCategory.Assets],
} as const satisfies Record<PlayShelf, readonly PlayCategory[]>;

/** Every tab, shelf by shelf, in the website's order. */
export const PLAY_CATEGORIES: readonly PlayCategory[] = PLAY_SHELVES.flatMap((shelf) => PLAY_SHELF_TABS[shelf]);

/** Whether a value names one of the tabs. */
export const isPlayCategory = (value: unknown): value is PlayCategory =>
  typeof value === "string" && (PLAY_CATEGORIES as readonly string[]).includes(value);

/** The shelf a tab belongs to. */
export const shelfOf = (category: PlayCategory): PlayShelf =>
  PLAY_SHELVES.find((shelf) => (PLAY_SHELF_TABS[shelf] as readonly PlayCategory[]).includes(category)) ??
  PlayShelf.Games;

/** The shelves' counts and the tabs worth showing. */
export interface PlayShelves {
  /** Each shelf's size as the website shows it beside the name; null while it could not be read. */
  counts: Record<PlayShelf, number | null>;
  /** The tabs with something in them (each shelf's first always), shelf by shelf. */
  categories: PlayCategory[];
}

/** A published game as the dashboard shows it. */
export interface PlayGame {
  id: string;
  slug: string;
  title: string;
  description: string;
  /** The 16:9 cover, or null when the game has none the app may load. */
  coverUrl: string | null;
  /** A five-second clip of real play that runs over the cover while the card is hovered, or null. */
  clipUrl: string | null;
  multiplayer: boolean;
  /** Plays so far, as the gallery counts them. */
  plays: number;
  /** Players in it now; null when the game is single-player or the count is unknown. */
  online: number | null;
  /** Who made it; `id` opens their profile, null when the API did not name the account. */
  author: { id: string | null; name: string; imageUrl: string | null };
  /** Anyone may make their own copy: its source is public. */
  remixable: boolean;
  /** An asset's kind (3D, picture, sound, video); null for a game or a tool, or an asset genex.games does not kind. */
  assetKind: LibraryKind | null;
  /** What the card menu reads (mobile flag, tags, remixing); a search's card carries none, so it has no menu. */
  curation?: PlayCuration;
  /** Its native builds, once the API names any: absent for a web game, as every game was before. */
  native?: PlayNative;
}

/** A game's own page (`studio:play.game`): its card with what its page adds. */
export interface PlayGameDetail extends PlayGame {
  likes: number;
  /** The signed-in account likes it. */
  liked: boolean;
  comments: number;
  /** Up to four screenshots, https images on Genex's hosts. */
  shots: string[];
  /** When it last changed, ISO 8601, or null when the API does not say. */
  updatedAt: string | null;
}

/** One page of a tab. */
export interface PlayFeedPage {
  games: PlayGame[];
  /** Where the next page starts, or null at the end. */
  nextCursor: string | null;
}

/** Which page of which tab to read. */
export interface PlayFeedRequest {
  category: PlayCategory;
  cursor?: string | null;
}

/** A gallery slug: lowercase letters, digits and dashes. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/** Whether a value is a slug the app will build an address from. */
export const isPlaySlug = (value: unknown): value is string => typeof value === "string" && SLUG.test(value);

/** The game itself, served on its own subdomain. */
export const playGameUrl = (slug: string): string => `https://${slug}.${PLAY_GAMES_DOMAIN}/`;

/** The game's page on the website at `web` (genex.games' unless a development profile says): what Share hands out. */
export const playPageUrl = (web: string, slug: string): string => `${web}/${slug}`;

/** The website's page of what Genex gives a game and its maker: where Learn goes. */
export const playToolsUrl = (web: string): string => `${web}/tools`;

/** Where a game's viewer stands. Wire values: never rename one. */
export const PlayViewerPhase = {
  /** The view is loading the game; the renderer shows the cover under it. */
  Loading: "loading",
  /** The game's page is up and painting. */
  Playing: "playing",
  /** The page could not be loaded; the renderer offers Try again and Back. */
  Failed: "failed",
  /** The viewer is gone: Back, Exit, the guest card's Install plugin or a remix that opened in Create. */
  Closed: "closed",
} as const;
export type PlayViewerPhase = (typeof PlayViewerPhase)[keyof typeof PlayViewerPhase];

/**
 * The viewer's bar: the app's own 48px strip across the window's top, the game below it, never under
 * it. It is drawn in a layer of its own above the game's native view.
 */
export const PLAY_BAR_HEIGHT = 48;

/** The longest name of a game the viewer's bar is given to show. */
export const PLAY_TITLE_MAX = 200;

/** What the viewer's header asks main for (`studio:play.control`). Wire values: never rename one. */
export const PlayControl = {
  Back: "back",
  Like: "like",
  Share: "share",
  Invite: "invite",
  Remix: "remix",
  Exit: "exit",
  /** The guest card's Install plugin: the viewer closes and the app installs Genex. */
  Install: "install",
  /** The guest card's ×. */
  DismissCard: "dismiss-card",
  /** Esc in the header: the keyboard goes back to the game. */
  Resume: "resume",
  /** The mic switch: the person's microphone feeds the game's voice chat, or not. */
  Mic: "mic",
  /** The mic's menu: which microphone. */
  MicDevices: "mic-devices",
  /** The maker's name: the viewer closes and the app shows their profile. */
  Maker: "maker",
  /** The game's native app: install it, or play it in its own window (the viewer gives way). */
  NativeApp: "native-app",
  /** Full screen: the game's page takes the whole window, as its own full screen does; Esc brings the bar back. */
  FullScreen: "full-screen",
} as const;
export type PlayControl = (typeof PlayControl)[keyof typeof PlayControl];

const CONTROLS: ReadonlySet<string> = new Set(Object.values(PlayControl));
/** Whether a value names a control. */
export const isPlayControl = (value: unknown): value is PlayControl => typeof value === "string" && CONTROLS.has(value);

/** The note the header shows after an action. Wire values: never rename one. */
export const PlayNote = {
  Copied: "copied",
  InviteCopied: "invite-copied",
  SignIn: "sign-in",
  LikeFailed: "like-failed",
  /** The system refuses the microphone: it is allowed in its settings. */
  MicBlocked: "mic-blocked",
  MicMissing: "mic-missing",
  MicFailed: "mic-failed",
} as const;
export type PlayNote = (typeof PlayNote)[keyof typeof PlayNote];

/** The game's facts under its name in the header. */
export interface PlayFacts {
  author: string;
  /** The maker's account, whose name opens their profile; null when the gallery did not name it. */
  authorId: string | null;
  plays: number;
  /** Players in it now; null for a single-player game or an unknown count. */
  online: number | null;
}

/** The header's mic, once the game is in voice chat. */
export interface PlayMicBar {
  /** The person's switch for this game. */
  on: boolean;
  /** Their microphone is open, feeding the game. */
  live: boolean;
  /** The game is in voice chat while the switch is off: nobody hears the person yet. */
  waiting: boolean;
}

/** Where on the window's page a header control is, for a menu to open under it. */
export interface PlayPoint {
  x: number;
  y: number;
}

/** A point the renderer sent, as main accepts it: two finite numbers on the window, else undefined. */
export function readPlayPoint(value: unknown): PlayPoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y } = value as Record<string, unknown>;
  const onWindow = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 100_000;
  return onWindow(x) && onWindow(y) ? { x: Math.round(x), y: Math.round(y) } : undefined;
}

/** What the viewer's bar draws. */
export interface PlayBarState {
  /** The game's name, as the card that opened it showed it. */
  title: string;
  liked: boolean;
  likes: number;
  /** The game may be remixed: the header shows Remix. */
  remixable: boolean;
  /** The game is multiplayer: the bar offers Invite a friend. */
  multiplayer: boolean;
  note: PlayNote | null;
  /** The header offers a signed-out guest the Genex plugin. */
  guestCard: boolean;
  /** Null until the game's page facts are read. */
  facts: PlayFacts | null;
  /** Null until the game asks for a microphone: then the header has a mic switch and its menu. */
  mic: PlayMicBar | null;
  /** How many comments the game has; null until its page facts are read. */
  comments: number | null;
  /** A Genex account is unlocked: the comments end in a field to write one, else in Sign in. Null until known. */
  signedIn: boolean | null;
  /** A remix is being made: Remix waits for it. */
  remixing: boolean;
  /** The game's native app for this computer, beside Like; null when it has none. */
  nativeApp: PlayBarNative | null;
  /** The game asked to be paid: Studio's purchase sheet covers it. Null with none open. */
  purchase: PlayPurchaseSheet | null;
}

/** A remix's name in the library, from the game it copies: what main adopts it as and Create shows while it is made. */
export const remixTitle = (title: string): string => `${title} remix`;

/** A remix's steps, in order: its files, its models (Git LFS), its packages, its first build. */
export const RemixStep = { Copy: "copy", Models: "models", Packages: "packages", Build: "build" } as const;
export type RemixStep = (typeof RemixStep)[keyof typeof RemixStep];

/** Why Remix made nothing, by code: the renderer says each in its own words. Wire values: never rename one. */
export const PlayRemixRefusal = {
  /** The game's source on Genex holds no game: its creator never shared its project. */
  NoProject: "no-project",
} as const;
export type PlayRemixRefusal = (typeof PlayRemixRefusal)[keyof typeof PlayRemixRefusal];

/** What a Remix press answers: the new game's library name, or why nothing was made. */
export type PlayRemixAnswer = string | { refused: PlayRemixRefusal };

/** How far a remix has come (`UiEvent.PlayRemix`): the step it is on, and its bytes when it has any. */
export interface RemixProgress {
  slug: string;
  step: RemixStep;
  /** Bytes of the step done so far: the models downloaded. Null when the step is not measured. */
  done: number | null;
  /** Bytes the step comes to; null when it is not measured or not known. */
  total: number | null;
  /** The new game's library name, from the step after it was adopted; null before. */
  name: string | null;
}

/** What main tells the renderer about the viewer (`UiEvent.PlayViewer`). */
export interface PlayViewerEvent {
  slug: string;
  /** Which opening of the viewer this is about: each open counts up, so news of an earlier one is told apart. */
  openId: number;
  phase: PlayViewerPhase;
  /** The header as it should be drawn now. */
  bar?: PlayBarState;
  /** An Esc held in the game: the keyboard is the header's now. */
  focusBar?: boolean;
  /** The guest card's Install plugin closed the viewer: the app runs Play's Install plugin. */
  install?: boolean;
  /** Remix closed the viewer: the app makes the copy of the game it showed. */
  remix?: boolean;
  /** The maker's name closed the viewer: the app shows this account's profile. */
  profile?: string;
}
