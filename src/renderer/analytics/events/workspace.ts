/** Home, starting and opening games, navigation and Settings (plan §1.4): how people get to a game and around the app. */
import type { ExportRefusal, WorkspaceRefusal } from "../../../shared/game-library.ts";
import type { FolderPreflight, ProjectKind } from "../../../shared/game-project.ts";
import type { ReasoningEffort } from "../../../shared/model-preferences.ts";
import type { EngineId } from "../../../shared/providers.ts";
import { watchAppearanceChanges } from "../../appearance/store.ts";
import type { ThemeImportProblem } from "../../appearance/themes.ts";
import type { HandoverStep, HeldState } from "../../chat/use-launch-handover.ts";
import type { NoticeKind, NoticeTone } from "../../notifications.ts";
import type { SettingsOpenedFrom, SettingsSection } from "../../settings-navigation.ts";
import type { StageView } from "../../stage.ts";
import { projectOf } from "../../state/threads.ts";
import type { Studio } from "../../state/studio.ts";
import { ToastTone } from "../../state/toasts.ts";
import { guarded, track } from "../client.ts";
import { gameRef } from "../game-ref.ts";
import type { AreaObservers } from "../observers.ts";
import type { CharsBucket, CountBucket } from "../properties.ts";
import { appearanceFieldsChanged, launchHandedProperties, stageChangedProperties } from "../workspace-properties.ts";
import { createQuietFields, type QuietTimers, settingsVisit, stageVia } from "../workspace-trackers.ts";
import {
  ActionOutcome,
  type AgeBucket,
  type DismissVia,
  type DraftSource,
  type FirstMessageAction,
  type FirstMessageOutcome,
  type FolderPickOutcome,
  type FreeSpaceAnswer,
  type GameAction,
  type GameCreatedFrom,
  type GamesRootOutcome,
  type HomeLeftTo,
  type HomeWords,
  type LaunchFailReason,
  type LaunchMode,
  type LaunchStage,
  type LocationOutcome,
  type ManageVia,
  type NavItem,
  type NavVia,
  type NoticeVia,
  type NoticeWent,
  type PlayMode,
  type PlayModeVia,
  type RuleScope,
  type SearchOutcome,
  type SearchTarget,
  type SearchVia,
  SettingKey,
  type SheetOutcome,
  type ShortcutKey,
  type SidebarVia,
  type SizeBucket,
  type StageSwitchVia,
  type StorageSurface,
  type ThemeImportOutcome,
} from "../workspace-vocabulary.ts";

export const WorkspaceEvent = {
  HomeViewed: "home_viewed",
  HomePromptSuggested: "home_prompt_suggested",
  HomeDraftStarted: "home_draft_started",
  HomeDraftDiscarded: "home_draft_discarded",
  GameLaunchStarted: "game_launch_started",
  GameLaunchFailed: "game_launch_failed",
  GameCreated: "game_created",
  GameLaunchHanded: "game_launch_handed",
  FirstMessageSettled: "first_message_settled",
  FirstMessageAction: "first_message_action",
  GameLocationPicked: "game_location_picked",
  OpenFolderPicked: "open_folder_picked",
  OpenFolderSheetViewed: "open_folder_sheet_viewed",
  OpenFolderSheetClosed: "open_folder_sheet_closed",
  NavClicked: "nav_clicked",
  ShortcutUsed: "shortcut_used",
  PlayModeSwitched: "play_mode_switched",
  SidebarToggled: "sidebar_toggled",
  GameOpened: "game_opened",
  GameOpenFailed: "game_open_failed",
  GameSearchOpened: "game_search_opened",
  GameSearchClosed: "game_search_closed",
  GameManaged: "game_managed",
  GameExportFinished: "game_export_finished",
  FreeSpaceAnswered: "free_space_answered",
  GamesRootChanged: "games_root_changed",
  StageViewChanged: "stage_view_changed",
  SettingsOpened: "settings_opened",
  SettingsClosed: "settings_closed",
  SettingChanged: "setting_changed",
  PermissionRuleForgotten: "permission_rule_forgotten",
  ThemeImported: "theme_imported",
  NoticeArrived: "notice_arrived",
  NoticeOpened: "notice_opened",
} as const;
export type WorkspaceEvent = (typeof WorkspaceEvent)[keyof typeof WorkspaceEvent];

/** An export's refusal: its own (`ExportRefusal`) or the library's (an unknown game). */
export type ExportCode = ExportRefusal | WorkspaceRefusal;

/** A finished action's two ends, without the cancel some actions have. */
type Settled = typeof ActionOutcome.Ok | typeof ActionOutcome.Failed;

export type WorkspaceEventProperties = {
  [WorkspaceEvent.HomeViewed]: {
    via: NavVia;
    waiting_words: HomeWords;
    games_bucket: CountBucket;
    backdrop_on: boolean;
  };
  [WorkspaceEvent.HomePromptSuggested]: { nth_in_visit: number; draft_was_empty: boolean };
  [WorkspaceEvent.HomeDraftStarted]: { ms_since_home_viewed: number; source: DraftSource };
  [WorkspaceEvent.HomeDraftDiscarded]: {
    chars_bucket: CharsBucket;
    from_suggestion: boolean;
    dwell_ms: number;
    left_to: HomeLeftTo;
  };
  [WorkspaceEvent.GameLaunchStarted]: {
    chars_bucket: CharsBucket;
    from_suggestion: boolean;
    from_welcome_idea: boolean;
    mode: LaunchMode;
    review_plan: boolean;
    pictures: number;
    mentions: number;
    engine: EngineId | null;
    effort: ReasoningEffort | null;
    custom_location: boolean;
    games_bucket: CountBucket;
  };
  [WorkspaceEvent.GameLaunchFailed]: {
    stage: LaunchStage;
    reason: LaunchFailReason;
    elapsed_ms: number;
    custom_location: boolean;
    /** The refusal's code (`WorkspaceRefusal`); null when main named none. */
    code: WorkspaceRefusal | null;
  };
  [WorkspaceEvent.GameCreated]: {
    from: GameCreatedFrom;
    create_ms?: number;
    custom_location: boolean;
    provisional: boolean;
    games_bucket: CountBucket;
    game_ref: string | null;
  };
  [WorkspaceEvent.GameLaunchHanded]: { total_ms: number; game_ref: string | null };
  [WorkspaceEvent.FirstMessageSettled]: {
    outcome: FirstMessageOutcome;
    held_state: HeldState;
    step: HandoverStep;
    ms_from_launch?: number;
    held_ms?: number;
  };
  [WorkspaceEvent.FirstMessageAction]: { action: FirstMessageAction; held_state: HeldState };
  [WorkspaceEvent.GameLocationPicked]: { outcome: LocationOutcome; pick_ms?: number; code?: WorkspaceRefusal | null };
  [WorkspaceEvent.OpenFolderPicked]: {
    outcome: FolderPickOutcome;
    pick_ms: number;
    inspect_ms?: number;
    code?: WorkspaceRefusal | null;
  };
  [WorkspaceEvent.OpenFolderSheetViewed]: {
    candidates: number;
    must_choose: boolean;
    suggested_kind: ProjectKind | null;
    nested_repos: number;
    engine_export: boolean;
    needs_install: boolean;
    problems: number;
    git: FolderPreflight["git"] | null;
  };
  [WorkspaceEvent.OpenFolderSheetClosed]: {
    outcome: SheetOutcome;
    via?: DismissVia;
    dwell_ms: number;
    changed_option: boolean;
    details_opened: boolean;
    trust_toggled: boolean;
    kind: ProjectKind | null;
    adopt_ms?: number;
    code?: WorkspaceRefusal | null;
  };
  [WorkspaceEvent.NavClicked]: { item: NavItem; mode: PlayMode; compact: boolean };
  [WorkspaceEvent.ShortcutUsed]: { key: ShortcutKey; did_nothing: boolean };
  [WorkspaceEvent.PlayModeSwitched]: { to: PlayMode; via: PlayModeVia };
  [WorkspaceEvent.SidebarToggled]: { visible: boolean; via: SidebarVia; compact: boolean };
  [WorkspaceEvent.GameOpened]: {
    via: NavVia;
    pinned: boolean;
    sidebar_index_bucket: CountBucket | null;
    open_ms: number;
    reload: boolean;
    game_ref: string | null;
  };
  [WorkspaceEvent.GameOpenFailed]: { via: NavVia };
  [WorkspaceEvent.GameSearchOpened]: { via: SearchVia; games_bucket: CountBucket };
  [WorkspaceEvent.GameSearchClosed]: {
    outcome: SearchOutcome;
    query_chars_bucket: CharsBucket;
    results_count: number;
    result_index?: number;
    target?: SearchTarget;
    no_results_seen: boolean;
    dwell_ms: number;
  };
  [WorkspaceEvent.GameManaged]: {
    action: GameAction;
    via: ManageVia;
    outcome: ActionOutcome;
    ms_since_created_bucket: AgeBucket | null;
    game_ref: string | null;
    code?: WorkspaceRefusal | null;
  };
  [WorkspaceEvent.GameExportFinished]: {
    outcome: Settled;
    files_bucket?: CountBucket;
    excluded_bucket?: CountBucket;
    export_ms: number;
    game_ref: string | null;
    code?: ExportCode | null;
  };
  [WorkspaceEvent.FreeSpaceAnswered]: {
    surface: StorageSurface;
    answer: FreeSpaceAnswer;
    freeable_bucket: SizeBucket;
    freed_bucket?: SizeBucket;
    skipped_games?: number;
    failed?: boolean;
  };
  [WorkspaceEvent.GamesRootChanged]: { outcome: GamesRootOutcome; choose_ms: number; code?: WorkspaceRefusal | null };
  [WorkspaceEvent.StageViewChanged]: {
    from: StageView;
    to: StageView;
    via: StageSwitchVia;
    from_dwell_ms: number;
    run_running: boolean;
  };
  [WorkspaceEvent.SettingsOpened]: { section: SettingsSection; from: SettingsOpenedFrom };
  [WorkspaceEvent.SettingsClosed]: {
    last_section: SettingsSection;
    dwell_ms: number;
    sections_visited: number;
    changes: number;
    errors_seen: number;
  };
  [WorkspaceEvent.SettingChanged]: { key: SettingKey; value: string | number | boolean; outcome: Settled };
  [WorkspaceEvent.PermissionRuleForgotten]: {
    scope: RuleScope;
    remaining_rules_bucket?: CountBucket;
    outcome: Settled;
  };
  [WorkspaceEvent.ThemeImported]: { outcome: ThemeImportOutcome; problem: ThemeImportProblem | null };
  [WorkspaceEvent.NoticeArrived]: {
    kind: NoticeKind;
    tone: NoticeTone | null;
    waiting: boolean;
    system_notified: boolean;
    window_focused: boolean;
  };
  [WorkspaceEvent.NoticeOpened]: {
    kind: NoticeKind;
    tone: NoticeTone | null;
    waiting: boolean;
    via: NoticeVia;
    age_ms: number | null;
    went: NoticeWent;
  };
};

/** A launch's hand-over to its chat, as the launch store moves. */
function watchLaunch(app: Studio, now: () => number): () => void {
  return app.launch.subscribe(
    guarded((state, previous) => {
      const handed = launchHandedProperties(previous.launch, state.launch, now(), gameRef(state.launch?.project));
      if (handed) track(WorkspaceEvent.GameLaunchHanded, handed);
    }),
  );
}

/** The stage's view as the layout store moves: from, to, how long the last one stayed, and what moved it. */
function watchStage(app: Studio, now: () => number): () => void {
  let since = now();
  return app.layout.subscribe(
    guarded((state, previous) => {
      if (state.stageView === previous.stageView) return;
      const at = now();
      const project = projectOf(app.threads.getState());
      const running = project !== null && app.library.getState().building.has(project);
      const changed = stageChangedProperties({
        from: previous.stageView,
        to: state.stageView,
        via: stageVia.take(at),
        since,
        at,
        running,
      });
      since = at;
      track(WorkspaceEvent.StageViewChanged, changed);
    }),
  );
}

/** An error toast while Settings is open counts against the visit. */
function watchErrors(app: Studio): () => void {
  return app.toasts.subscribe(
    guarded((state, previous) => {
      if (state.lastId === previous.lastId) return;
      if (state.items.at(-1)?.tone === ToastTone.Error) settingsVisit.errored();
    }),
  );
}

/**
 * Appearance changes, each field once it keeps still (a slider dragged is one change). They count
 * toward the Settings visit too; the value is the field's own name, never a preset's.
 */
function watchAppearance(timers?: QuietTimers): () => void {
  const settled = createQuietFields(
    guarded((field: string) => {
      settingsVisit.changed(false);
      track(WorkspaceEvent.SettingChanged, {
        key: SettingKey.AppearanceField,
        value: field,
        outcome: ActionOutcome.Ok,
      });
    }),
    undefined,
    timers,
  );
  return watchAppearanceChanges(guarded((previous, next) => settled(appearanceFieldsChanged(previous, next))));
}

/**
 * What this area hears without a click: a launch handed to its chat, the stage's view, errors and
 * appearance changes under Settings.
 */
export function createWorkspaceObservers(now: () => number = Date.now, timers?: QuietTimers): AreaObservers {
  return {
    start(app) {
      const stops = [watchLaunch(app, now), watchStage(app, now), watchErrors(app), watchAppearance(timers)];
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
