/**
 * The words the workspace's analytics events say things in (plan §1.4): how the person got to home
 * or a game, what they pressed, how a step ended. Renderer-only: each value is a wire spelling sent
 * as is, so a value is never renamed.
 */

/** How the person reached home or a game. */
export const NavVia = {
  /** The first home of this window, with nothing asked for. */
  Launch: "launch",
  /** The sidebar's wordmark. */
  Wordmark: "wordmark",
  /** The sidebar's New game row. */
  NewGame: "new_game",
  /** The + beside the sidebar's Games heading. */
  GamesPlus: "games_plus",
  /** A keyboard shortcut (⌘N, ⌘1, ⌘2, ⌘I). */
  Shortcut: "shortcut",
  /** ⌥↑ or ⌥↓ along the sidebar. */
  Rail: "rail",
  /** The welcome ended. */
  AfterWelcome: "after_welcome",
  /** The game on the stage was deleted. */
  AfterDelete: "after_delete",
  /** A launch failed and its words came back to home. */
  FailedLaunch: "failed_launch",
  /** A game's row in the sidebar. */
  Sidebar: "sidebar",
  /** ⌘K search. */
  Search: "search",
  /** A notification. */
  Notification: "notification",
  /** A folder adopted from the Open Game sheet. */
  OpenFolder: "open_folder",
  /** A Play remix that opened as a game. */
  Remix: "remix",
  /** A chat's own link or button (New game in a chat). */
  Chat: "chat",
  Other: "other",
} as const;
export type NavVia = (typeof NavVia)[keyof typeof NavVia];

/** A row or button of the sidebar. */
export const NavItem = {
  Home: "home",
  NewGame: "new_game",
  GamesPlus: "games_plus",
  Plugins: "plugins",
  Items: "items",
  Harness: "harness",
  Settings: "settings",
  Search: "search",
  Feedback: "feedback",
  PlayShelf: "play_shelf",
} as const;
export type NavItem = (typeof NavItem)[keyof typeof NavItem];

/** The sidebar's two sides. */
export const PlayMode = { Play: "play", Create: "create" } as const;
export type PlayMode = (typeof PlayMode)[keyof typeof PlayMode];

/** What switched the sidebar between Play and Create. */
export const PlayModeVia = {
  Switch: "switch",
  ProfilePlate: "profile_plate",
  Friends: "friends",
  OpenPlayEvent: "open_play_event",
  GameLink: "game_link",
  Notification: "notification",
} as const;
export type PlayModeVia = (typeof PlayModeVia)[keyof typeof PlayModeVia];

/** The app's shortcuts, by key. */
export const ShortcutKey = {
  K: "k",
  B: "b",
  N: "n",
  One: "1",
  Two: "2",
  I: "i",
  RailUp: "rail_up",
  RailDown: "rail_down",
} as const;
export type ShortcutKey = (typeof ShortcutKey)[keyof typeof ShortcutKey];

/** What showed or hid the sidebar. */
export const SidebarVia = { Button: "button", Shortcut: "shortcut" } as const;
export type SidebarVia = (typeof SidebarVia)[keyof typeof SidebarVia];

/** Words waiting in home's composer when it came up. */
export const HomeWords = { None: "none", WelcomeIdea: "welcome_idea", FailedLaunch: "failed_launch" } as const;
export type HomeWords = (typeof HomeWords)[keyof typeof HomeWords];

/** Where the first words of a home visit came from. */
export const DraftSource = {
  Typed: "typed",
  Suggestion: "suggestion",
  WelcomeIdea: "welcome_idea",
  FailedLaunch: "failed_launch",
} as const;
export type DraftSource = (typeof DraftSource)[keyof typeof DraftSource];

/** Where the person went when home went away with words still in it. */
export const HomeLeftTo = { Game: "game", Harness: "harness", Other: "other" } as const;
export type HomeLeftTo = (typeof HomeLeftTo)[keyof typeof HomeLeftTo];

/** How a launch's first message runs: as a Loop, or answered in the chat. */
export const LaunchMode = { Loop: "loop", Auto: "auto" } as const;
export type LaunchMode = (typeof LaunchMode)[keyof typeof LaunchMode];

/** The launch step that stopped. */
export const LaunchStage = { Naming: "naming", Creating: "creating", Opening: "opening" } as const;
export type LaunchStage = (typeof LaunchStage)[keyof typeof LaunchStage];

/** Why a launch stopped, as the renderer knows it without reading English. */
export const LaunchFailReason = {
  UsageLimit: "usage_limit",
  CreateRefused: "create_refused",
  OpenRefused: "open_refused",
} as const;
export type LaunchFailReason = (typeof LaunchFailReason)[keyof typeof LaunchFailReason];

/** Where a game was made from. */
export const GameCreatedFrom = { Home: "home", OpenFolder: "open_folder", Remix: "remix" } as const;
export type GameCreatedFrom = (typeof GameCreatedFrom)[keyof typeof GameCreatedFrom];

/** How a launch's held first message ended. */
export const FirstMessageOutcome = {
  Sent: "sent",
  NotSent: "not_sent",
  Failed: "failed",
  ToComposer: "to_composer",
} as const;
export type FirstMessageOutcome = (typeof FirstMessageOutcome)[keyof typeof FirstMessageOutcome];

/** A press on a held first message's block. */
export const FirstMessageAction = { Retry: "retry", SignIn: "sign_in" } as const;
export type FirstMessageAction = (typeof FirstMessageAction)[keyof typeof FirstMessageAction];

/** How the home folder chip's choice ended. */
export const LocationOutcome = {
  Chosen: "chosen",
  Cancelled: "cancelled",
  Refused: "refused",
  Reset: "reset",
} as const;
export type LocationOutcome = (typeof LocationOutcome)[keyof typeof LocationOutcome];

/** How Open a folder…'s picker and inspection ended. */
export const FolderPickOutcome = { Picked: "picked", Cancelled: "cancelled", Refused: "refused" } as const;
export type FolderPickOutcome = (typeof FolderPickOutcome)[keyof typeof FolderPickOutcome];

/** How the Open Game sheet ended. */
export const SheetOutcome = { Adopted: "adopted", Dismissed: "dismissed", Failed: "failed" } as const;
export type SheetOutcome = (typeof SheetOutcome)[keyof typeof SheetOutcome];

/** How a sheet or dialog was put away without its answer: its Cancel, or its close (✕, Escape, outside). */
export const DismissVia = { Cancel: "cancel", Close: "close" } as const;
export type DismissVia = (typeof DismissVia)[keyof typeof DismissVia];

/** What opened ⌘K search. */
export const SearchVia = { Sidebar: "sidebar", Shortcut: "shortcut" } as const;
export type SearchVia = (typeof SearchVia)[keyof typeof SearchVia];

/** How ⌘K search ended. */
export const SearchOutcome = { Opened: "opened", Dismissed: "dismissed" } as const;
export type SearchOutcome = (typeof SearchOutcome)[keyof typeof SearchOutcome];

/** What a search result was. */
export const SearchTarget = { Game: "game", EarlierChat: "earlier_chat" } as const;
export type SearchTarget = (typeof SearchTarget)[keyof typeof SearchTarget];

/** Something done to a game from its menu or its chat's header. */
export const GameAction = {
  Renamed: "renamed",
  Pinned: "pinned",
  Unpinned: "unpinned",
  CoverChanged: "cover_changed",
  Removed: "removed",
  Revealed: "revealed",
} as const;
export type GameAction = (typeof GameAction)[keyof typeof GameAction];

/** Where a game was managed from. */
export const ManageVia = { Menu: "menu", ChatHeader: "chat_header" } as const;
export type ManageVia = (typeof ManageVia)[keyof typeof ManageVia];

/** How an action ended. */
export const ActionOutcome = { Ok: "ok", Failed: "failed", Cancelled: "cancelled" } as const;
export type ActionOutcome = (typeof ActionOutcome)[keyof typeof ActionOutcome];

/** Where space was freed from. */
export const StorageSurface = { ChatHeader: "chat_header", Settings: "settings" } as const;
export type StorageSurface = (typeof StorageSurface)[keyof typeof StorageSurface];

/** The answer to the free-space confirmation. */
export const FreeSpaceAnswer = { Free: "free", Keep: "keep", Dismiss: "dismiss" } as const;
export type FreeSpaceAnswer = (typeof FreeSpaceAnswer)[keyof typeof FreeSpaceAnswer];

/** How Settings → Games' Change… ended. */
export const GamesRootOutcome = { Changed: "changed", Cancelled: "cancelled", Refused: "refused" } as const;
export type GamesRootOutcome = (typeof GamesRootOutcome)[keyof typeof GamesRootOutcome];

/** What moved the stage to another view. */
export const StageSwitchVia = {
  /** The stage's own tabs. */
  Tab: "tab",
  /** A run started and Builds opened by itself. */
  AutoRunStarted: "auto_run_started",
  /** The chat put a build on screen (`stage.show`). */
  ChatStageShow: "chat_stage_show",
  /** A link or button in the chat (Show Live, Assets, Builds). */
  ChatLink: "chat_link",
  /** A build opened from Builds. */
  OpenBuild: "open_build",
  /** An asset focused from elsewhere. */
  AssetFocus: "asset_focus",
  Notification: "notification",
  /** A file opened beside the chat. */
  FileBeside: "file_beside",
  /** The file beside the chat closed. */
  FileClosed: "file_closed",
  Other: "other",
} as const;
export type StageSwitchVia = (typeof StageSwitchVia)[keyof typeof StageSwitchVia];

/** A setting Settings changes, by its own key. */
export const SettingKey = {
  SelfImproving: "selfImproving",
  BuildersMax: "buildersMax",
  AutoResume: "autoResume",
  ComputerControl: "computerControl",
  Language: "language",
  DefaultPermissionMode: "default_permission_mode",
  /** One field of the appearance (its value is the field's name). */
  AppearanceField: "appearance_field",
} as const;
export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

/** How a theme import ended. */
export const ThemeImportOutcome = {
  Imported: "imported",
  Failed: "failed",
  WrongScheme: "wrong_scheme",
  LimitReached: "limit_reached",
} as const;
export type ThemeImportOutcome = (typeof ThemeImportOutcome)[keyof typeof ThemeImportOutcome];

/** Where an "always allow" rule was forgotten. */
export const RuleScope = { OneGame: "one_game", AllGames: "all_games" } as const;
export type RuleScope = (typeof RuleScope)[keyof typeof RuleScope];

/** How a notification was opened. */
export const NoticeVia = { Panel: "panel", SystemNotification: "system_notification" } as const;
export type NoticeVia = (typeof NoticeVia)[keyof typeof NoticeVia];

/** Where opening a notification took the person. */
export const NoticeWent = { Thread: "thread", Settings: "settings", Play: "play", Nowhere: "nowhere" } as const;
export type NoticeWent = (typeof NoticeWent)[keyof typeof NoticeWent];

/** How old something is, in steps that say enough. */
export const AgeBucket = {
  Hour: "<1h",
  Day: "1h-1d",
  Week: "1-7d",
  Month: "7-30d",
  Older: "30d+",
} as const;
export type AgeBucket = (typeof AgeBucket)[keyof typeof AgeBucket];

/** How much disk space, in steps that say enough. */
export const SizeBucket = {
  Small: "<1GB",
  Medium: "1-5GB",
  Large: "5-20GB",
  Huge: "20GB+",
} as const;
export type SizeBucket = (typeof SizeBucket)[keyof typeof SizeBucket];
