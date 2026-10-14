import type { PerformanceMark } from "./performance.ts";
import type { ComposerSendOptions } from "./composer.ts";
import type {
  ExportReview,
  GithubLookup,
  GithubVersion,
  PluginInfo,
  PluginCatalogEntry,
  PluginIndexView,
  PluginPanelDocument,
} from "./plugins.ts";
import type { PluginFileRequest } from "./plugin-file-request.ts";
import type { McpConnectorView, McpTestResult, McpToolSummary } from "./mcp.ts";
import type { McpConnectorDraft } from "./mcp-import.ts";
import type { ConversationRecord, EventEnvelope, SnapshotRecord } from "./event-log.ts";
import type { EngineDescriptor } from "./engine-descriptor.ts";
import type { BackdropShaderRequest, BackdropShaderResult } from "./backdrop-shader.ts";
import type {
  BuildTarget,
  ExportResult,
  FolderInspection,
  GameLocation,
  GameName,
  GameNameRequest,
  GameProject,
  GameStack,
  StackDefaultSwitch,
} from "./game-project.ts";
import type { BuildProblem, InstallResult } from "./build-problem.ts";
import type { LoopRunReview } from "./run-review.ts";
import type { StagedTarget } from "./self-change-files.ts";
import type { CodexLoginState } from "./codex-login.ts";
import type { ClaudeLoginState } from "./claude-login.ts";
import type { ProjectAsset, ProjectAssetRead, ProjectAssets } from "./game-assets.ts";
import type { ModelRig } from "./model-rig.ts";
import type { UiEvent } from "./ui-events.ts";
import type { GameFile } from "./game-file.ts";
import type { ChatFileLink, ChatFileOpenOutside, ChatFileRef } from "./chat-files.ts";
import type { ReferenceFrame } from "./protocol.ts";
import type { ProviderUsageReport } from "./provider-usage.ts";
import type { BootState, SandboxSetupResult } from "./boot.ts";
import type { AppAbout, ReadyUpdate, UpdateCheckResult } from "./app-update.ts";
import type { PermissionMode, PermissionSettingsView, ToolPermissionAnswer } from "./permissions.ts";
import type { LiveBehindEvent } from "./live-behind.ts";
import type { NativeEmbedSize, NativeFrameMeta, NativeInputActions, NativeRunStatus } from "./native-contract.ts";
import type {
  AndroidLicence,
  MobileBuildTarget,
  ToolchainInstallJob,
  ToolchainPruneResult,
  ToolchainStatus,
} from "./toolchain.ts";
import type { SigningReference } from "./game-export-contract.ts";
import type { DeviceLaunchRequest, DeviceLaunchResult } from "./device-launch.ts";
import type { SeedRetakeAnswer } from "./seed-retake.ts";
import type { CrateDecisionInput, CrateRequestView } from "./crate-requests.ts";
import type { EngineEjectAnswer, EngineState, EngineTrustAnswer } from "./game-conformance.ts";
import type { FieldRow, RunSharingDeleteResult, RunSharingStatus } from "./run-sharing.ts";

export type { ProjectAsset, ProjectAssets };

export interface Bootstrap {
  threadId: string;
  layout: Record<string, string>;
  /** `~/AI Games` as a human reads it — the renderer never sees absolute paths. */
  gamesRootLabel: string;
  /** capabilities: what the loaded harness claimed in its ready handshake — [] until ready. */
  harness: { state: string; version: string | null; capabilities: string[] };
  threads: ConversationRecord[];
  events: EventEnvelope[];
  /** Where `events()` continues from: every thread's head when `events` was read. */
  eventsCursor?: string | null;
  games: GameProject[];
  engines: EngineDescriptor[];
  /** Current host state, independent of the bounded notification tail. */
  threadStatus?: Record<string, { status: string; since: number }>;
  /**
   * Builders working right now, by game: how many. A reload reads which games are building from
   * here, since the `delegation.*` events that announced them were before it.
   */
  activeDelegations: Record<string, number>;
  /** This session may welcome a first launch: not in smoke, self-test or fixture sessions, except the first-launch fixture. */
  welcome?: boolean;
  /** An unpackaged developer run: the renderer may offer its developer tools (the colour tweaker). */
  developer?: boolean;
  /**
   * Whether this build makes Rust · wgpu games (`main/core/stack-gate.ts`): every developer build,
   * and a release build where the Rust lane runs. Create game offers Rust only when it is true.
   */
  rustCreation?: boolean;
  /**
   * The new-game stack switch main read from the studio's settings (`stackDefault`): absent is
   * the shipped switch. Reverted (`three-js`), Create game starts on Three.js with Rust · wgpu
   * an explicit choice where it is offered.
   */
  stackDefault?: StackDefaultSwitch;
}

/** The window-control overlay's background and glyph colours, as `#rrggbb`. */
export interface WindowControlColors {
  color: string;
  symbolColor: string;
}

/** One read of the all-threads log: the events, and the cursor the next read starts after. */
export interface EventFeed {
  events: EventEnvelope[];
  cursor: string | null;
}

export interface SelfChange {
  from: string;
  to: string;
  reason: string;
  /** The file the change wrote, as the exact edit names it. */
  file: string;
  at: string;
  healthy: boolean;
  diff: string;
}

export interface StagedProposal {
  /** What it changes (`self-change-files.ts`): a skill when absent, or the lessons every brief carries. */
  target?: StagedTarget;
  skill: string;
  file: string;
  proposedText: string;
  currentText: string;
  /** The blind gate's verdict on a skill edit; lessons are not gated, so they carry none. */
  gate?: { accept: boolean; votes: string; reason: string };
  rationale: string;
  /** Plain-language description for the person using the app; absent on older proposals. */
  title?: string;
  summary?: string[];
  at: string;
}

/** One catalog model judged against this Mac (Settings → Local Models). */
export interface LocalModelChoice {
  model: string;
  name: string;
  variant?: string;
  engine?: string;
  sizeGb: number;
  tools: boolean;
  vision: boolean;
  about: string;
  fits: boolean;
  needGb: number;
  needsRamGb: number | null;
  reason: string;
}

/** This Mac's hardware and the local models it can run (`StudioApi.hardware`, harness `engine.hardware`). */
export interface HardwareReport {
  hardware: { cpu: string; ramGb: number; usableModelGb: number };
  recommendation: {
    tier: { label: string; expectation: string };
    defaultModel: string | null;
    /** The tier's ranked models that fit; the first is Best fit. */
    picks: LocalModelChoice[];
    /** Every other model this Mac can run, smallest first, fitting or not. */
    more: LocalModelChoice[];
  };
}

export interface StudioApi {
  /** Record a content-free journey sample only in opted-in diagnostics launches. */
  performanceMark(mark: PerformanceMark): Promise<boolean>;
  contextSettings(engine: string, model: string, threadId?: string): Promise<import("./context.ts").ContextSettings>;
  setContextPolicy(
    engine: string,
    model: string,
    policy: import("./context.ts").ContextPolicy | null,
    threadId?: string,
  ): Promise<import("./context.ts").ContextSettings>;
  studioSkills(): Promise<Array<{ name: string; text: string; description: string }>>;
  providerSkills(): Promise<import("./provider-skills.ts").ProviderSkillInventory[]>;
  /** The skills and commands one game's folder gives its builders. */
  projectSkills(project: string): Promise<import("./provider-skills.ts").ProjectSkillInventory>;
  /** A plugin skill's whole text: an inline skill's, or a file skill's file or one of its references. */
  pluginSkillText(id: string, name: string, file?: string): Promise<string>;
  pluginsList(): Promise<PluginInfo[]>;
  pluginsCatalog(): Promise<PluginCatalogEntry[]>;
  pluginEnable(id: string, enabled: boolean): Promise<void>;
  pluginRemove(id: string): Promise<void>;
  pluginInstall(id?: string): Promise<void>;
  pluginPanel(id: string, panel: string): Promise<PluginPanelDocument>;
  pluginSettings(id: string): Promise<Record<string, unknown>>;
  pluginSetSetting(id: string, key: string, value: unknown): Promise<void>;
  pluginReview(
    id: string,
    name: string,
    args: unknown,
    project?: string,
  ): Promise<{ images?: Array<{ label: string; dataUrl: string }>; message?: string; ticket?: string }>;
  pluginAction(id: string, name: string, args: unknown, project?: string, ticket?: string): Promise<unknown>;
  /** A plugin panel's Choose file: Studio's native file picker; the chosen file's real path, or null when cancelled. */
  pluginChooseFile(id: string, request: PluginFileRequest): Promise<string | null>;
  /** The files Publish would put online for a game, for Studio's Publish dialog to show. Uploads nothing. */
  genexPublishReview(project: string): Promise<ExportReview>;
  /**
   * Publish the game to the Genex gallery from Studio's Publish dialog: its Publish press approved
   * the files in `review`; `title` is the name players see.
   */
  genexPublish(project: string, review: ExportReview, title?: string): Promise<void>;
  pluginsIndex(refresh?: boolean): Promise<PluginIndexView>;
  pluginInstallGithub(spec: string): Promise<void>;
  /** What a pasted GitHub link leads to, pinned to one exact commit; nothing is installed. */
  pluginLookupGithub(link: string, version?: GithubVersion): Promise<GithubLookup>;
  /** A GitHub repository's recent releases and default branch, to install another version from. */
  pluginGithubVersions(repo: string): Promise<GithubVersion[]>;
  pluginUpdate(id: string): Promise<void>;
  pluginWatch(id: string, enabled: boolean): Promise<void>;
  /** The person's Ask every time: a local plugin's tools they always allowed ask again before they run. */
  pluginForgetAllowed(id: string): Promise<void>;
  /** The user's answer to a `plugin_consent` card; `resolved` is false once the question is no longer waiting. */
  /** The person's answer to a consent card; `always` (a connector's card) also allows that tool from now on. */
  pluginConsent(consentId: string, approved: boolean, always?: boolean): Promise<{ resolved: boolean }>;

  /**
   * Claude Code permissions for game chats. Studio UI only (main-frame guarded); the harness has
   * no equivalent, so no agent can change its own mode or answer its own request.
   */
  permissions(): Promise<PermissionSettingsView>;
  /** The chat's mode (and the mode new chats start in); `threadId` null sets only the latter. */
  setPermissionMode(threadId: string | null, mode: PermissionMode): Promise<PermissionSettingsView>;
  /** The user's answer to a `tool_permission` card; `resolved` is false once it is no longer waiting. */
  answerPermission(requestId: string, answer: ToolPermissionAnswer): Promise<{ resolved: boolean }>;
  /** Stop allowing a saved "always allow" rule for a game. */
  forgetPermission(project: string, rule: string): Promise<PermissionSettingsView>;

  /**
   * MCP connectors. Values never cross this boundary in either direction: a connector carries
   * env and header NAMES, and `mcpSave` takes the values it is given straight to the OS secret
   * store. `mcpList` reports which names have a value stored, never the value.
   */
  mcpList(project?: string | null): Promise<McpConnectorView[]>;
  connections(threadId?: string, project?: string | null): Promise<import("./connections.ts").ConnectionSnapshot>;
  /** `secrets` keys are `env.<NAME>` / `header.<NAME>`; an empty string clears one. */
  mcpSave(
    connector: McpConnectorDraft & { createdAt?: string },
    secrets?: Record<string, string>,
  ): Promise<McpConnectorView>;
  mcpRemove(id: string): Promise<void>;
  /** Connect once, list the tools, disconnect — without touching the live connection. */
  mcpTest(id: string): Promise<McpTestResult>;
  mcpConnect(id: string, project?: string): Promise<McpTestResult>;
  mcpCancelAuthorization(id: string): Promise<void>;
  mcpDisconnectAccount(id: string): Promise<void>;
  mcpTools(id: string): Promise<McpToolSummary[]>;
  /** A plugin's connector asks again before every call: its "Always allow" answers are forgotten. */
  mcpForgetAlwaysAllowed(id: string): Promise<void>;

  /** The platform and where startup stands (`shared/boot.ts`); the renderer asks before anything else. */
  bootState(): Promise<BootState>;
  /** Re-run core startup from the sandbox setup screen; answers the state after the attempt. */
  retrySandboxSetup(): Promise<BootState>;
  /**
   * Windows: install the protected workspace (one administrator prompt), then re-run startup;
   * answers whether it was installed or the prompt was dismissed, and the state after.
   */
  setUpSandbox(): Promise<SandboxSetupResult>;
  /** Paint the Windows and Linux window controls (`titleBarOverlay`) in the theme's colours; macOS ignores it. */
  setWindowControls(colors: WindowControlColors): Promise<void>;
  /** The new version of the app downloaded in the background, or null; `onEvent` announces later ones. */
  readyUpdate(): Promise<ReadyUpdate | null>;
  /**
   * Quit and relaunch into the downloaded version. Asks first while a run is active; false when
   * there is nothing to install or the person kept the run going.
   */
  restartToUpdate(): Promise<boolean>;
  /** Check for a newer version now (Settings → About, the app menu); a found one also announces itself. */
  checkForUpdates(): Promise<UpdateCheckResult>;
  /** Open the waiting downloadable release's page in the browser; false when none waits. */
  openUpdateDownload(): Promise<boolean>;
  /** What is running (Settings → About): version, platform and architecture. */
  appAbout(): Promise<AppAbout>;
  bootstrap(): Promise<Bootstrap>;
  send(text: string, options?: ComposerSendOptions): Promise<boolean>;
  answerPlan(threadId: string, id: string, approved: boolean): Promise<boolean>;
  cancelTurn(threadId: string): Promise<boolean>;
  changeQueuedMessage(
    threadId: string,
    messageId: string,
    operation: "hold" | "edit" | "remove",
    text?: string,
  ): Promise<void>;
  /** What rewinding the chat to a message (its bubble's event and queue ids) would do to the game files. */
  rewindPreview(
    threadId: string,
    eventId: string,
    messageId: string,
  ): Promise<import("./chat-rewind.ts").RewindPreview>;
  /** Rewind the chat to just before that message; `files` also puts the game files back. */
  rewindChat(
    threadId: string,
    eventId: string,
    messageId: string,
    files: boolean,
  ): Promise<import("./chat-rewind.ts").RewindResult>;
  /** Every thread's events after `after`; ask again with the returned `cursor`, not an event id. */
  events(after?: string): Promise<EventFeed>;
  threadEvents(threadId: string): Promise<EventEnvelope[]>;
  chatPage(threadId: string, before?: string): Promise<import("./chat-history.ts").ChatPage>;
  threads(): Promise<ConversationRecord[]>;
  newGameThread(project?: string): Promise<ConversationRecord>;
  threadForGame(project: string): Promise<ConversationRecord>;
  renameThread(threadId: string, title: string): Promise<ConversationRecord>;
  compactThread(threadId: string, options?: { engine?: string; model?: string }): Promise<boolean>;
  archiveGame(project: string): Promise<boolean>;
  /** What freeing space deletes now, in one game or (none named) in all of them. */
  storageSpace(project?: string): Promise<import("./storage-space.ts").StorageSpace>;
  /** Free space in one game (refused while it works) or (none named) in every game not working. */
  freeStorage(project?: string): Promise<import("./storage-space.ts").StorageFreed>;
  /** Takes back a game's engine link from its chat line; refused once the link has changed since. */
  undoEngineLink(request: import("./game-engine.ts").EngineLinkUndo): Promise<boolean>;
  /** The person's Stop on a job's chat line: the job's record, or null for a job the game never had. */
  stopJob(project: string, jobId: string): Promise<import("./jobs.ts").JobRecord | null>;
  /** Opens macOS System Settings at the Privacy & Security pane that grants what app_look needs. */
  openPrivacySettings(pane: import("./jobs.ts").AppLookAccessKind): Promise<boolean>;
  engines(): Promise<EngineDescriptor[]>;
  /** Plan limits of each signed-in subscription; reading them never starts a turn. */
  providerUsage(): Promise<ProviderUsageReport[]>;
  hardware(): Promise<HardwareReport>;
  games(): Promise<GameProject[]>;
  /**
   * A new game in a fresh folder of its own: in the games folder, or inside `parent` when the user
   * chose one. `stack` and `targets` are where people play (Create Game's destinations); a game
   * created without them is a Three.js browser game. `stack` is the explicit choice and wins over
   * what `targets` imply. `rust-wgpu` is refused `stack-gated` in a release build; a development
   * build creates it, and its lane builds the Mac and the web (the phones' builders wait for their
   * toolchains; Windows and Linux are refused `target-unbuilt`). `provisional`: the title waits for
   * the game's first idea (`GameName.provisional`).
   */
  createGame(
    title: string,
    options?: { parent?: string; stack?: GameStack; targets?: BuildTarget[]; provisional?: boolean },
  ): Promise<GameProject>;
  /** A name for a game started from its first request, by the model picked for it; never fails for want of a model. */
  nameGame(request: GameNameRequest): Promise<GameName>;
  /** A live background for home from a description, by the model picked on home (`core/backdrop-generation.ts`). */
  makeBackdrop(request: BackdropShaderRequest): Promise<BackdropShaderResult>;
  /**
   * Create game's location: the native folder dialog, answered with the folder checked as
   * creating there will be. Resolves to null when cancelled; a refused folder rejects with why.
   */
  pickGameLocation(): Promise<GameLocation | null>;
  /** Settings → Games: asks for a folder for new games; resolves to its label, or null when cancelled. */
  chooseGamesRoot(): Promise<string | null>;
  updateGame(project: string, patch: import("./game-library.ts").GameUpdate): Promise<GameProject>;
  removeGame(project: string): Promise<void>;
  snapshots(): Promise<SnapshotRecord[]>;
  selfChanges(): Promise<{ changes: SelfChange[]; staged: StagedProposal[] }>;
  studioActivity(): Promise<import("./studio-activity.ts").StudioActivityItem[]>;
  /** With `graphFrom`, `graphEvents` holds only the events after it; `graphEventsFrom` says where they start. */
  runSummary(
    project: string,
    runId: string,
    graphFrom?: import("./run-summary-feed.ts").GraphCursor | null,
  ): Promise<import("./run-summary.ts").RunSummary>;
  onRunSummary(
    project: string,
    runId: string,
    listener: (summary: import("./run-summary.ts").RunSummary) => void,
  ): () => void;
  runReview(project: string, runId?: string): Promise<LoopRunReview>;
  staged(): Promise<StagedProposal[]>;
  settings(): Promise<StudioSettingsView>;
  setSettings(patch: {
    learning?: boolean;
    selfImproving?: boolean;
    architect?: boolean;
    buildersMax?: number;
    agentsMax?: number;
    blender?: boolean;
    autoResume?: boolean;
  }): Promise<StudioSettingsView>;
  /** Settings → Copy diagnostics: versions, provider status and the recent log, already redacted. */
  diagnostics(): Promise<string>;
  /** Send feedback (the sidebar's bug button): posts the report to genex.games; throws when it was not taken. */
  sendFeedback(draft: import("./feedback.ts").FeedbackDraft): Promise<void>;
  /** Settings → Licenses: Genex's MIT license and the third-party notices this build ships. */
  licenses(): Promise<import("./licenses.ts").LicenseTexts>;
  /** Settings → Privacy: whether Share build metrics is on, paused or offered at all. */
  runSharingStatus(): Promise<RunSharingStatus>;
  /** Turn Share build metrics on (for the current consent version) or off; off forgets unsent rows. */
  setRunSharing(on: boolean): Promise<RunSharingStatus>;
  /** See what would be sent: the real next row, or null before any build finished. */
  runSharingPreview(): Promise<FieldRow | null>;
  /** Delete what I shared: every row of this install's ids, proven by their secrets. */
  deleteSharedRuns(): Promise<RunSharingDeleteResult>;
  /** The modeller (AG-930): detection status; the one-click download; cancel. */

  recheckEngines(engine?: string): Promise<boolean>;
  refreshModels(provider: string): Promise<boolean>;
  cliUpdate(provider: string): Promise<import("./cli-install.ts").CliInstallJob>;
  subscriptionSignIn(opts?: {
    engine?: string;
    separate?: boolean;
  }): Promise<{ started: boolean; missingCli?: boolean; error?: string }>;
  /** The Claude sign-in as the card shows it: which phase, and the code box when one is wanted. */
  claudeLoginState(): Promise<ClaudeLoginState>;
  claudeLoginCode(code: string): Promise<ClaudeLoginState>;
  claudeLoginOpenBrowser(): Promise<unknown>;
  claudeLoginCancel(): Promise<unknown>;
  /** OpenCode's own sign-in (`opencode auth login`), in the terminal dock. */
  openCodeSignIn(): Promise<{ started: boolean; missingCli?: boolean }>;
  /**
   * Check a pasted OpenRouter API key with OpenRouter and keep it in the OS secret store when it is
   * accepted. The answer is OpenRouter's status; the key never comes back.
   */
  openRouterKeySave(key: string): Promise<import("./engine-descriptor.ts").EngineStatus>;
  /** Forget the saved OpenRouter key. */
  openRouterKeyClear(): Promise<import("./engine-descriptor.ts").EngineStatus>;
  /**
   * Connect OpenRouter in the browser: OpenRouter's page opens, and the call settles once the
   * person approved Genex there (the key is then checked and saved, never sent back), cancelled,
   * or it failed. A new call replaces one still waiting.
   */
  openRouterSignIn(): Promise<import("./openrouter-login.ts").OpenRouterSignInResult>;
  /** Open the waiting sign-in's page again; false when none is waiting. */
  openRouterSignInReopen(): Promise<boolean>;
  /** Stop the waiting sign-in; false when none is waiting. */
  openRouterSignInCancel(): Promise<boolean>;
  /**
   * Connect a model server the person runs (`shared/local-server.ts`): check the address is on this
   * computer or the local network, ask the server for its models with the key when one is given,
   * and save both only when it answers. The key never comes back.
   */
  localServerConnect(url: string, key?: string): Promise<import("./local-server.ts").LocalServerConnectResult>;
  /** Forget the saved local server's address and key. */
  localServerForget(): Promise<import("./engine-descriptor.ts").EngineStatus>;
  /** The model servers answering on this computer's usual ports, for Settings to offer. */
  localServerFind(): Promise<import("./local-server.ts").FoundLocalServer[]>;
  terminalList(): Promise<import("./terminal.ts").TerminalSession[]>;
  terminalAccessibility(): Promise<boolean>;
  terminalOpen(project: string): Promise<import("./terminal.ts").TerminalSession>;
  /** Run one command a chat reply offered, in the game's folder, as its own terminal session. */
  terminalRun(project: string, command: string): Promise<import("./terminal.ts").TerminalSession>;
  terminalAttach(id: string): Promise<void>;
  terminalInput(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalAcknowledge(id: string, count: number): Promise<void>;
  terminalStop(id: string): Promise<void>;
  terminalRemove(id: string): Promise<void>;
  /** Open, in the browser, the sign-in page this terminal session printed (none: nothing opens). */
  terminalOpenLink(id: string): Promise<void>;
  onTerminal(listener: (event: import("./terminal.ts").TerminalEvent) => void): () => void;
  onClaudeLogin(listener: (state: ClaudeLoginState) => void): () => void;
  codexLoginState(): Promise<CodexLoginState>;
  codexLoginCancel(): Promise<CodexLoginState>;
  codexLoginDismiss(): Promise<unknown>;
  codexLoginOpenBrowser(): Promise<unknown>;
  codexLoginRetry(method: "browser" | "device"): Promise<CodexLoginState>;
  onCodexLogin(listener: (state: CodexLoginState) => void): () => void;
  subscriptionForgetStudioLogin(engine?: string): Promise<boolean>;
  openUrl(url: string): Promise<boolean>;
  /** A macOS notification; clicking it focuses Studio and sends `notification.open` with the id. */
  notify(note: { id?: string; title: string; subtitle?: string; body: string }): Promise<boolean>;
  /** The Dock badge: how much work waits on the person. Zero clears it. */
  setBadge(count: number): Promise<boolean>;
  rollback(snapshotId: string): Promise<boolean>;
  /** Take back one learned change, leaving every later change and the game lessons in place. */
  undoChange(snapshotId: string): Promise<{ file: string }>;
  loadPreview(project: string): Promise<string>;
  buildPreview(
    request: import("./build-preview.ts").BuildPreviewRequest,
  ): Promise<import("./build-preview.ts").BuildPreviewFrame | null>;
  /** Every window a worker is driving right now, with its last frame. */
  agentScreens(): Promise<import("./agent-screen.ts").AgentScreenFrame[]>;
  readRunStill(file: string, maxPx?: number): Promise<{ mimeType: string; data: string } | null>;
  readReferenceStills(project: string): Promise<{
    frames: Array<{ label: string; mimeType: string; data: string }>;
    skipped: Array<{ file: string; why: string }>;
  }>;
  /** Everything under the game's `assets/` and `public/assets/`, with where each file came from. */
  previewProjectAsset(p: {
    project: string;
    file: string;
    maxBytes?: number;
  }): Promise<{ mimeType: string; data: Uint8Array<ArrayBuffer> }>;
  /** Which delivered files the game folder holds now; a build's files arrive when it lands. */
  presentProjectAssets(p: { project: string; files: string[] }): Promise<string[]>;
  /** What these GLB and glTF files hold, read from their headers: meshes, clips and bones; other files are skipped. */
  projectModelRigs(p: { project: string; files: string[] }): Promise<ModelRig[]>;
  projectAssets(project: string): Promise<ProjectAssets>;
  /**
   * One image from inside the game, contained and byte-sniffed. `maxPx` asks for a thumbnail;
   * `scope: "genex-inspection"` reads the one saved frame of the named job instead, and
   * `scope: "genex-cover"` the game's kept Genex cover shot (no file: the host knows where it is).
   */
  readProjectAsset(p: ProjectAssetRead): Promise<{ mimeType: string; data: string } | null>;
  runFeedback(p: {
    threadId: string;
    runId?: string;
    facetId?: string;
    camera?: string;
    iteration?: number;
    text: string;
    /** What the note is about, as the chat names it ("Tall mountain · try 5"). */
    label?: string;
  }): Promise<{ ok: true }>;
  playSnapshot(snapshotId: string, project: string): Promise<{ dir: string; snapshotId: string }>;
  /** A run's build (its integration head, any commit) in the user's window, from a worktree; the game folder is untouched. */
  showBuild(project: string, commit: string): Promise<{ dir: string; commit: string }>;
  /** Merge a build into the live game folder and show it. */
  landBuild(project: string, commit: string): Promise<{ commit: string; how: "merged" | "already" }>;
  /**
   * Where the native game view sits (zero while anything covers it), and whether the person is
   * watching a game in Live under whatever briefly covers it (`stage.ts` `watchingLive`).
   */
  /** The stage slot's rectangle, and the window size it was measured in (main carries it through resizes). */
  previewBounds(bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    watching: boolean;
    viewport?: { width: number; height: number };
  }): Promise<boolean>;
  /** The Live game's sound switch; main decides when Live is actually heard. */
  previewSound(request: import("./game-sound.ts").GameSoundRequest): Promise<boolean>;
  /** Reload the stage. `retry` is the build-failure strip's "Try again": build it again from scratch. */
  reloadPreview(options?: { retry?: boolean }): Promise<boolean>;
  /** Stop: take the Live game off its view, so it runs no scripts, frames or sound until Play. */
  stopPreview(): Promise<boolean>;
  /** Play a stopped Live game again: the same page, from the top. */
  playPreview(): Promise<boolean>;
  /** Full screen: the window goes full screen with the Live game over all of it; holding Esc, or its exit button, ends it. */
  previewFullScreen(): Promise<boolean>;
  /** What waits for this game's Live Reload and the build Live shows, as `live.behind` says it: read on mount. */
  liveBehind(project: string): Promise<LiveBehindEvent>;
  previewState(): Promise<unknown>;
  /** Whose page Live holds, whether it is still navigating, and whether its requests have settled. */
  previewLive(): Promise<{
    project: string | null;
    navigating: boolean;
    /** The person stopped the game (`stopPreview`): Live holds no page until Play. */
    stopped: boolean;
    loadError: string | null;
    crashed: boolean;
    page: { complete: boolean; resources: number; state: Record<string, unknown> | null } | null;
  }>;
  /** Why the stage cannot show this game's own build; null when the last build was fine. */
  buildProblem(project: string): Promise<BuildProblem | null>;
  /** Install this game's packages — the one action that reaches the network, on the user's press. */
  installPackages(project: string): Promise<InstallResult>;
  startRun(spec: {
    project: string;
    goal: string;
    reference: {
      name: string;
      shots: string[];
      notes?: string;
      kind?: "reference" | "direction";
      frames?: Array<{ label: string; mimeType: string; data: string }>;
    };
    hours: number;
    engine?: string;
    model?: string;
    judgeEngine?: string;
    judgeModel?: string;
  }): Promise<{ runId: string }>;
  stopRun(runId: string): Promise<boolean>;
  /** Wrap up: the builders finish what they are on, then the run integrates, checks and shows. */
  finishRun(runId: string, threadId: string): Promise<boolean>;
  resumeAutopilot(runId: string): Promise<boolean>;
  startSkillOpt(): Promise<boolean>;
  /** `key` names the suggestion the person saw; the index alone names whatever sits there now. */
  acceptProposal(index: number, key?: { at?: string; skill?: string }): Promise<{ skill: string }>;
  discardProposal(index: number, reason?: string, key?: { at?: string; skill?: string }): Promise<boolean>;
  /**
   * Export the game: the web folder by default, or `destination`: a Mac app on a Mac, or a Windows
   * zip or Linux tarball built on this Mac. `signing` is checked by `parseExportSigning` in main; a
   * Mac app is signed ad hoc and a Windows or Linux archive left unsigned unless it names another kind.
   */
  exportGame(project: string, options?: { destination?: BuildTarget; signing?: unknown }): Promise<ExportResult>;
  /**
   * The person picks a release keystore, a provisioning profile or a password file in the native
   * file dialog, for the signing they are filling in; null when they cancel. Main answers the
   * file's absolute path, which a signing choice then carries back through `parseExportSigning`.
   */
  exportSigningReference(kind: SigningReference): Promise<string | null>;
  modelInstallStatus(): Promise<import("./model-install.ts").ModelInstallJob | null>;
  /** Install Claude Code or Codex with its vendor's own installer, or join the install already running. */
  cliInstall(provider: string): Promise<import("./cli-install.ts").CliInstallJob>;
  /** The latest in-app install of each CLI, running or finished. */
  cliInstallStatus(): Promise<import("./cli-install.ts").CliInstallJob[]>;
  /** The C++ toolchain store: the Command Line Tools, what is installed, the current lock and the install job. */
  toolchainStatus(): Promise<ToolchainStatus>;
  /**
   * Install what `targets` need (default: Browser and this computer's own OS), or join the install
   * already running. A download the person starts from the Toolchain sheet; never an agent's.
   */
  toolchainInstall(targets?: BuildTarget[]): Promise<ToolchainInstallJob>;
  /** Cancel the running toolchain install; false when none runs. */
  toolchainCancel(): Promise<boolean>;
  /** Settings → Toolchains' "Remove old versions": every version no game's lock names. */
  toolchainPrune(): Promise<ToolchainPruneResult>;
  /** Asks macOS to install the Command Line Tools (Apple's own dialog); false when it could not ask. */
  toolchainInstallClt(): Promise<boolean>;
  /**
   * Install what a phone's builds need that the store downloads (the Rust standard libraries, and
   * for Android bundletool and the JDK), or join the install already running. The person's act
   * from the Toolchain sheet, never an agent's; the Android SDK, Build-Tools and NDK stay the
   * person's own install.
   */
  toolchainInstallMobile(target: MobileBuildTarget): Promise<ToolchainInstallJob>;
  /**
   * The person accepts the Android SDK licence the Toolchain sheet showed them. Only this press
   * accepts it, never an agent and never a fixture; resolves true once it is recorded.
   */
  toolchainAcceptAndroidLicence(licence: AndroidLicence): Promise<boolean>;
  /**
   * Play on Mac: build the game's Mac destination, admit the bundle and open the game in its own
   * window. Resolves with the run's status; a refusal is typed in it (`refusal`, `problem`).
   */
  nativeRun(project: string): Promise<NativeRunStatus>;
  /** Stop the game's own window; false when none runs. */
  nativeStop(project: string): Promise<boolean>;
  /** The game's own window run, or null when there is none. */
  nativeState(project: string): Promise<NativeRunStatus | null>;
  /** Bring the game's own window to the front; false when there is none or it could not. */
  nativeFront(project: string): Promise<boolean>;
  /**
   * Show the game's Mac build inside Live: a headless run whose frames reach `nativeFrames`, sized
   * to Live's canvas. Resolves with the run's status; a refusal is typed in it (`embed-unsupported`,
   * `game-predates-embedding`, …), and Pop out (`nativeRun`) is the way on.
   */
  nativeEmbed(project: string, size: NativeEmbedSize): Promise<NativeRunStatus>;
  /** End the game's embedded run (Web chosen, Live hidden for good, the game switched); false when none ran. */
  nativeUnembed(project: string): Promise<boolean>;
  /** Live's captured keyboard and mouse, to the embedded run; false when none runs or the actions were refused. */
  nativeInput(project: string, actions: NativeInputActions): Promise<boolean>;
  /** Live's canvas changed size: main debounces it into a new ring; false when no embedded run takes it. */
  nativeResize(project: string, size: NativeEmbedSize): Promise<boolean>;
  /**
   * The embedded run's frames, as the preload's `sharedTexture` receiver hands them over: a
   * `VideoFrame` (typed loosely; the DOM lib declares it) and main's meta. One subscriber: a second
   * replaces the first. The frame is closed and released when the listener's promise settles, so
   * draw it before then. Not an IPC push, and a no-op where this build has no `sharedTexture`.
   */
  nativeFrames(listener: (frame: unknown, meta: NativeFrameMeta) => void | Promise<void>): () => void;
  /**
   * The person launches the game's admitted phone build on a Simulator, emulator or phone. Only
   * the person does: no harness method reaches it (containment stage 1). Resolves with how it
   * ended, which is also recorded as a `device_launch` event.
   */
  nativeLaunchDevice(project: string, request: DeviceLaunchRequest): Promise<DeviceLaunchResult>;
  /**
   * Re-take the seed copy of one harness module the agent kept from before Rust games, keeping its
   * edit as a patch; `module` is the workspace-relative path a refused night named.
   */
  retakeSeedModule(module: string): Promise<SeedRetakeAnswer>;
  /** The crate requests agents made, newest first: one game's, or every game's when `project` is absent. */
  cratesList(project?: string): Promise<CrateRequestView[]>;
  /** The person approves or declines one crate request; build scripts and proc macros are approved separately. */
  cratesDecide(decision: CrateDecisionInput): Promise<CrateRequestView>;
  /**
   * The person ejects a Rust game's engine (extension ladder level 5): the genex crates of its lock
   * line become a game-owned fork in `engine/`. Never a harness method: an agent can only suggest it.
   */
  engineEject(project: string): Promise<EngineEjectAnswer>;
  /** The person gives an ejected game the store engine back, after a game snapshot. */
  engineUneject(project: string): Promise<EngineEjectAnswer>;
  /** The person turns a game's trust flag for `unsafe` and build scripts on or off; the sandbox never changes. */
  engineSetTrust(project: string, trusted: boolean): Promise<EngineTrustAnswer>;
  /** A Rust game's engine as the person's engine rows show it: ejected or Studio's, and its trust flag. A read. */
  engineState(project: string): Promise<EngineState>;
  pullModel(model: string): Promise<boolean>;
  /** Add from Ollama: an exact tag's download size and fit on this Mac, from the public registry. */
  lookupModel(
    model: string,
  ): Promise<
    | { ok: true; id: string; sizeGb: number; fits: boolean; needGb: number; needsRamGb: number | null }
    | { ok: false; reason: "invalid" | "not_found" | "unavailable"; id?: string; error?: string }
  >;
  cancelModelDownload(): Promise<boolean>;
  /** Delete a downloaded local model (Bonsai or Ollama) from this Mac. */
  removeModel(model: string): Promise<boolean>;
  revealProject(project: string, file?: string): Promise<boolean>;
  /** A file the chat names, from that chat's game folder or its run's unlanded build. */
  readGameFile(threadId: string, path: string): Promise<GameFile>;
  revealGameFile(threadId: string, path: string): Promise<boolean>;
  /** Which names the chat wrote are files on this computer, and how each opens (null: not a file). */
  resolveChatFiles(threadId: string, refs: ChatFileRef[]): Promise<Array<ChatFileLink | null>>;
  /** Opens a file the chat named in its app, or shows it; `problem` when no app opened it. */
  openChatFile(threadId: string, ref: ChatFileRef): Promise<{ open: ChatFileOpenOutside; problem?: string }>;
  /** The images sent with a chat message. */
  messageImages(threadId: string, messageId: string): Promise<ReferenceFrame[]>;
  /**
   * The native folder dialog. It answers *which folder* only — nothing is written by picking, and
   * the answer goes straight back to `inspectFolder`/`adoptFolder`; the renderer shows the folder
   * as `pathLabel`, never as the path it holds here.
   */
  pickProject(): Promise<string | null>;
  /** What a folder holds — games in it and one level down, how each runs, what would stop a run. Writes nothing. */
  inspectFolder(dir: string): Promise<FolderInspection>;
  /**
   * Open a folder as a game: the Open Game sheet's button, and the first thing that writes.
   * `versionNested` is the consent the row carried — the studio may make the game inside this
   * folder part of its history when a build goes live.
   */
  adoptFolder(
    dir: string,
    options?: {
      subdir?: string;
      template?: boolean;
      versionNested?: boolean;
      title?: string;
      trustProjectSettings?: boolean;
    },
  ): Promise<GameProject>;
  openProject(name: string): Promise<GameProject>;
  /** The transient UI events main pushes (`shared/ui-events.ts`); narrow on `type` to read the payload. */
  onEvent(listener: (event: UiEvent) => void): () => void;
}

export interface StudioSettingsView {
  /** Self-improvement: off, Studio learns nothing new and changes nothing about itself. */
  learning: boolean;
  /** Apply suggestions automatically, while learning is on. */
  selfImproving: boolean;
  architect?: boolean;
  /** Maximum builders a run may use at once; the lead decides how many it starts. */
  buildersMax?: number;
  agentsMax?: number;
  /** may builders model in Blender (AG-930); on by default */
  blender?: boolean;
  /** Resume builds automatically after an engine limit resets or the loop restarts; on by default. */
  autoResume?: boolean;
}

declare global {
  interface Window {
    studio: StudioApi;
  }
}

export type {
  BuildProblem,
  ConversationRecord,
  EventEnvelope,
  EngineDescriptor,
  InstallResult,
  SnapshotRecord,
  FolderInspection,
  GameLocation,
  GameProject,
};
