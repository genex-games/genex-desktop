/**
 * The `window.studio` object the preload exposes, built over the part of `ipcRenderer` it uses so a
 * test can drive it with a recorder. Every call goes through {@link invoke} or {@link subscribe},
 * whose channel, payload and result types come from `shared/ipc-channels.ts`.
 */
import { createRunSummaryFeeds, type GraphCursor } from "../shared/run-summary-feed.ts";
import type { StudioApi } from "../shared/studio-api.ts";
import type {
  IpcResult,
  StudioInvokeChannel,
  StudioInvokePayload,
  StudioInvokeResult,
  StudioPushChannel,
  StudioPushPayload,
} from "../shared/ipc-channels.ts";

/** The part of Electron's `ipcRenderer` the bridge uses; `ipcRenderer` itself satisfies it. */
export interface BridgeIpc {
  invoke(channel: StudioInvokeChannel, payload: unknown): Promise<unknown>;
  on<C extends StudioPushChannel>(
    channel: C,
    listener: (event: unknown, payload: StudioPushPayload<C>) => void,
  ): unknown;
  off<C extends StudioPushChannel>(
    channel: C,
    listener: (event: unknown, payload: StudioPushPayload<C>) => void,
  ): unknown;
}

/** A channel whose payload is `undefined` is called with no payload argument. */
type PayloadArgs<C extends StudioInvokeChannel> =
  StudioInvokePayload<C> extends undefined ? [] : [payload: StudioInvokePayload<C>];

export function createStudioBridge(ipc: BridgeIpc): StudioApi {
  async function invoke<C extends StudioInvokeChannel>(
    channel: C,
    ...args: PayloadArgs<C>
  ): Promise<StudioInvokeResult<C>> {
    // Main answers every invoke with `IpcResult` (`main/ipc-handle.ts`), typed by the same map.
    const result = (await ipc.invoke(channel, args[0])) as IpcResult<StudioInvokeResult<C>>;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  function subscribe<C extends StudioPushChannel>(
    channel: C,
    listener: (payload: StudioPushPayload<C>) => void,
  ): () => void {
    const handler = (_event: unknown, payload: StudioPushPayload<C>) => listener(payload);
    ipc.on(channel, handler);
    return () => ipc.off(channel, handler);
  }
  const bridge: BridgeCalls = { ipc, invoke, subscribe };
  return {
    performanceMark: (mark) => invoke("studio:performance.mark", mark),
    ...threadCalls(bridge),
    ...gameCalls(bridge),
    ...runCalls(bridge),
    ...studioCalls(bridge),
    ...pluginCalls(bridge),
    ...accountCalls(bridge),
    ...terminalCalls(bridge),
    ...previewCalls(bridge),
  };
}

/** What every group of calls is built from: the raw IPC, and the typed invoke and subscribe over it. */
interface BridgeCalls {
  ipc: BridgeIpc;
  invoke<C extends StudioInvokeChannel>(channel: C, ...args: PayloadArgs<C>): Promise<StudioInvokeResult<C>>;
  subscribe<C extends StudioPushChannel>(channel: C, listener: (payload: StudioPushPayload<C>) => void): () => void;
}

/** Chats: sending, the event feed, threads and the files a chat names. */
function threadCalls(bridge: BridgeCalls) {
  const { invoke, subscribe } = bridge;
  return {
    bootstrap: () => invoke("studio:bootstrap"),
    send: (text, options) => invoke("studio:send", { text, ...options }),
    answerPlan: (threadId, id, approved) => invoke("studio:plan.answer", { threadId, id, approved }),
    cancelTurn: (threadId) => invoke("studio:cancel", { threadId }),
    changeQueuedMessage: (threadId, messageId, operation, text) =>
      invoke("studio:queue.message", { threadId, messageId, operation, text }),
    rewindPreview: (threadId, eventId, messageId) =>
      invoke("studio:chat.rewind.preview", { threadId, eventId, messageId }),
    rewindChat: (threadId, eventId, messageId, files) =>
      invoke("studio:chat.rewind", { threadId, eventId, messageId, files }),
    events: (after) => invoke("studio:events", { after }),
    threadEvents: (threadId) => invoke("studio:thread.events", { threadId }),
    chatPage: (threadId, before) => invoke("studio:chat.page", { threadId, before }),
    threads: () => invoke("studio:threads"),
    newGameThread: (project) => invoke("studio:thread.new", project ? { project } : {}),
    threadForGame: (project) => invoke("studio:thread.forGame", { project }),
    renameThread: (threadId, title) => invoke("studio:thread.rename", { threadId, title }),
    compactThread: (threadId, options) => invoke("studio:compact", { threadId, ...options }),
    messageImages: (threadId, messageId) => invoke("studio:message-images", { threadId, messageId }),
    readGameFile: (threadId, path) => invoke("studio:game-file.read", { threadId, path }),
    revealGameFile: (threadId, path) => invoke("studio:game-file.reveal", { threadId, path }),
    resolveChatFiles: (threadId, refs) => invoke("studio:chat-files.resolve", { threadId, refs }),
    openChatFile: (threadId, ref) => invoke("studio:chat-file.open", { threadId, ref }),
    onEvent: (listener) => subscribe("studio:event", listener),
  } satisfies Partial<StudioApi>;
}

/** The library: games, their folders, assets and history. */
function gameCalls(bridge: BridgeCalls) {
  const { invoke } = bridge;
  return {
    archiveGame: (project) => invoke("studio:game.archive", { project }),
    gameHistory: (project) => invoke("studio:game.history", { project }),
    clearGameHistory: (project) => invoke("studio:game.history.clear", { project }),
    undoEngineLink: (request) => invoke("studio:game.engine.undo", request),
    stopJob: (project, jobId) => invoke("studio:jobs.stop", { project, jobId }),
    openPrivacySettings: (pane) => invoke("studio:app-look.open-settings", { pane }),
    createGame: (title, options) =>
      invoke("studio:game.create", { title, ...(options?.parent === undefined ? {} : { parent: options.parent }) }),
    nameGame: (request) => invoke("studio:game.name", request),
    pickGameLocation: () => invoke("studio:game.location.pick"),
    chooseGamesRoot: () => invoke("studio:games-root.choose"),
    updateGame: (project, patch) => invoke("studio:game.update", { project, patch }),
    removeGame: (project) => invoke("studio:game.remove", { project }),
    games: () => invoke("studio:games"),
    snapshots: () => invoke("studio:snapshots"),
    selfChanges: () => invoke("studio:selfchanges"),
    studioActivity: () => invoke("studio:activity"),
    exportGame: (project) => invoke("studio:export", { project }),
    revealProject: (project, file) => invoke("studio:reveal-project", { project, ...(file ? { file } : {}) }),
    pickProject: () => invoke("studio:project.pick"),
    inspectFolder: (dir) => invoke("studio:project.inspect", { dir }),
    adoptFolder: (dir, options) => invoke("studio:project.adopt", { dir, ...(options ?? {}) }),
    openProject: (name) => invoke("studio:project.open", { name }),
    rollback: (snapshotId) => invoke("studio:rollback", { snapshotId }),
    undoChange: (snapshotId) => invoke("studio:selfchange.undo", { snapshotId }),
    readReferenceStills: (project) => invoke("studio:game.references", { project }),
    previewProjectAsset: (p) => invoke("studio:game.asset.preview", p),
    presentProjectAssets: (p) => invoke("studio:game.asset.present", p),
    projectModelRigs: (p) => invoke("studio:game.asset.rigs", p),
    projectAssets: (project) => invoke("studio:game.assets", { project }),
    readProjectAsset: (p) => invoke("studio:game.asset.still", p),
    installPackages: (project) => invoke("studio:packages.install", { project }),
  } satisfies Partial<StudioApi>;
}

/** A summary request: the run, and the graph events the caller already holds, when it holds any. */
function summaryPayload(project: string, runId: string, graphFrom?: GraphCursor | null) {
  return { project, runId, ...(graphFrom ? { graphFrom } : {}) };
}

/** Builds: starting and stopping a run, and what the Builds tab reads about one. */
function runCalls(bridge: BridgeCalls) {
  const { invoke, subscribe } = bridge;
  // Every view of one run (Build, Builds graph, morning card, review) shares one live summary,
  // which fetches only the graph events it does not hold yet.
  const summaries = createRunSummaryFeeds({
    runSummary: (project, runId, graphFrom) => invoke("studio:run.summary", summaryPayload(project, runId, graphFrom)),
    onEvent: (listener) => subscribe("studio:event", listener),
  });
  return {
    runSummary: (project, runId, graphFrom) => invoke("studio:run.summary", summaryPayload(project, runId, graphFrom)),
    onRunSummary: (project, runId, listener) => summaries.subscribe(project, runId, listener),
    runReview: (project, runId) => invoke("studio:run.review", { project, runId }),
    readRunStill: (file, maxPx) => invoke("studio:run.still", { file, ...(maxPx === undefined ? {} : { maxPx }) }),
    runFeedback: (p) => invoke("studio:run.feedback", p),
    playSnapshot: (snapshotId, project) => invoke("studio:review.play", { snapshotId, project }),
    showBuild: (project, commit) => invoke("studio:build.show", { project, commit }),
    landBuild: (project, commit) => invoke("studio:build.land", { project, commit }),
    buildProblem: (project) => invoke("studio:build.problem", { project }),
    startRun: (spec) => invoke("studio:run.start", spec),
    stopRun: (runId) => invoke("studio:run.stop", { runId }),
    finishRun: (runId, threadId) => invoke("studio:run.finish", { runId, threadId }),
    resumeAutopilot: (runId) => invoke("studio:autopilot.resume", { runId }),
  } satisfies Partial<StudioApi>;
}

/** Settings, models, skills, learning and notifications. */
function studioCalls(bridge: BridgeCalls) {
  const { invoke } = bridge;
  return {
    bootState: () => invoke("studio:boot"),
    retrySandboxSetup: () => invoke("studio:boot.retry"),
    setUpSandbox: () => invoke("studio:boot.setup"),
    setWindowControls: (colors) => invoke("studio:window.controls", colors),
    readyUpdate: () => invoke("studio:update"),
    restartToUpdate: () => invoke("studio:update.restart"),
    checkForUpdates: () => invoke("studio:update.check"),
    appAbout: () => invoke("studio:update.about"),
    openUpdateDownload: () => invoke("studio:update.download"),
    engines: () => invoke("studio:engines"),
    providerUsage: () => invoke("studio:provider-usage"),
    hardware: () => invoke("studio:hardware"),
    staged: () => invoke("studio:staged"),
    settings: () => invoke("studio:settings"),
    setSettings: (patch) => invoke("studio:settings.set", patch),
    diagnostics: () => invoke("studio:diagnostics"),
    sendFeedback: (draft) => invoke("studio:feedback.send", draft),
    licenses: () => invoke("studio:licenses"),
    runSharingStatus: () => invoke("studio:run-sharing.status"),
    setRunSharing: (on) => invoke("studio:run-sharing.set", { on }),
    runSharingPreview: () => invoke("studio:run-sharing.preview"),
    deleteSharedRuns: () => invoke("studio:run-sharing.delete"),
    studioSkills: () => invoke("studio:skills.list"),
    providerSkills: () => invoke("studio:skills.providers"),
    projectSkills: (project) => invoke("studio:skills.project", { project }),
    pluginSkillText: (id, name, file) => invoke("studio:plugins.skill", { id, name, file }),
    contextSettings: (engine, model, threadId) => invoke("studio:context.get", { engine, model, threadId }),
    setContextPolicy: (engine, model, policy, threadId) =>
      invoke("studio:context.set", { engine, model, policy, threadId }),
    startSkillOpt: () => invoke("studio:skillopt.start"),
    acceptProposal: (index, key) => invoke("studio:skillopt.accept", { index, ...key }),
    discardProposal: (index, reason, key) => invoke("studio:skillopt.discard", { index, reason, ...key }),
    cancelModelDownload: () => invoke("studio:cancel-model-download", {}),
    modelInstallStatus: () => invoke("studio:model-install.status"),
    refreshModels: (provider) => invoke("studio:models.refresh", { provider }),
    cliUpdate: (provider) => invoke("studio:cli.update", { provider }),
    cliInstall: (provider) => invoke("studio:cli-install.start", { provider }),
    cliInstallStatus: () => invoke("studio:cli-install.status"),
    pullModel: (model) => invoke("studio:pull-model", { model }),
    lookupModel: (model) => invoke("studio:models.lookup", { model }),
    removeModel: (model) => invoke("studio:models.remove", { model }),
    openUrl: (url) => invoke("studio:open-url", { url }),
    notify: (note) => invoke("studio:notify", note),
    setBadge: (count) => invoke("studio:badge", { count }),
  } satisfies Partial<StudioApi>;
}

/** Plugins and MCP connectors. */
function pluginCalls(bridge: BridgeCalls) {
  const { invoke } = bridge;
  return {
    pluginsList: () => invoke("studio:plugins.list"),
    pluginsCatalog: () => invoke("studio:plugins.catalog"),
    pluginEnable: (id, enabled) => invoke("studio:plugins.enable", { id, enabled }),
    pluginRemove: (id) => invoke("studio:plugins.remove", { id }),
    pluginInstall: (id) => invoke("studio:plugins.install", { id }),
    pluginPanel: (id, panel) => invoke("studio:plugins.panel", { id, panel }),
    pluginSettings: (id) => invoke("studio:plugins.settings", { id }),
    pluginSetSetting: (id, key, value) => invoke("studio:plugins.setting", { id, key, value }),
    pluginReview: (id, name, args, project) => invoke("studio:plugins.review", { id, name, args, project }),
    pluginAction: (id, name, args, project, ticket) =>
      invoke("studio:plugins.action", { id, name, args, project, ticket }),
    pluginChooseFile: (id, request) => invoke("studio:plugins.choose-file", { id, request }),
    genexPublishReview: (project) => invoke("studio:plugins.genex-publish-review", { project }),
    genexPublish: (project, review, title) => invoke("studio:plugins.genex-publish", { project, review, title }),
    pluginsIndex: (refresh) => invoke("studio:plugins.index", { refresh }),
    pluginInstallGithub: (spec) => invoke("studio:plugins.install-github", { spec }),
    pluginLookupGithub: (link, version) => invoke("studio:plugins.lookup-github", { link, version }),
    pluginGithubVersions: (repo) => invoke("studio:plugins.github-versions", { repo }),
    pluginUpdate: (id) => invoke("studio:plugins.update", { id }),
    pluginWatch: (id, enabled) => invoke("studio:plugins.watch", { id, enabled }),
    pluginConsent: (consentId, approved, always) =>
      invoke("studio:plugins.consent", { consentId, approved, ...(always ? { always } : {}) }),
    permissions: () => invoke("studio:permissions.get"),
    setPermissionMode: (threadId, mode) => invoke("studio:permissions.mode", { threadId, mode }),
    answerPermission: (requestId, answer) => invoke("studio:permissions.answer", { requestId, answer }),
    forgetPermission: (project, rule) => invoke("studio:permissions.forget", { project, rule }),
    setDontWait: (threadId, on, offerId) =>
      invoke("studio:loop.dontWait", { threadId, on, ...(offerId ? { offerId } : {}) }),
    dontWaitState: (threadId) => invoke("studio:loop.dontWaitState", { threadId }),
    mcpList: (project) => invoke("studio:mcp.list", project),
    connections: (threadId, project) => invoke("studio:connections", { threadId, project }),
    mcpSave: (connector, secrets) => invoke("studio:mcp.save", { connector, secrets }),
    mcpRemove: (id) => invoke("studio:mcp.remove", { id }),
    mcpTest: (id) => invoke("studio:mcp.test", { id }),
    mcpConnect: (id, project) => invoke("studio:mcp.connect", { id, project }),
    mcpCancelAuthorization: (id) => invoke("studio:mcp.cancel-authorization", { id }),
    mcpDisconnectAccount: (id) => invoke("studio:mcp.disconnect-account", { id }),
    mcpTools: (id) => invoke("studio:mcp.tools", { id }),
    mcpForgetAlwaysAllowed: (id) => invoke("studio:mcp.forget-always", { id }),
  } satisfies Partial<StudioApi>;
}

/** Subscriptions: engine checks and the Claude and Codex sign-ins. */
function accountCalls(bridge: BridgeCalls) {
  const { invoke, subscribe } = bridge;
  return {
    recheckEngines: (engine) => invoke("studio:engines.recheck", engine ? { engine } : {}),
    // One grammar for both subscriptions: which login, sign me in, forget the studio's account.
    subscriptionSignIn: (opts) => invoke("studio:subscription.signin", opts ?? {}),
    subscriptionForgetStudioLogin: (engine) =>
      invoke("studio:subscription.forget-studio-login", engine ? { engine } : {}),
    claudeLoginState: () => invoke("studio:claude-login.state"),
    claudeLoginCode: (code) => invoke("studio:claude-login.code", { code }),
    claudeLoginOpenBrowser: () => invoke("studio:claude-login.browser"),
    claudeLoginCancel: () => invoke("studio:claude-login.cancel"),
    openCodeSignIn: () => invoke("studio:opencode.signin"),
    openRouterKeySave: (key) => invoke("studio:openrouter.key.save", { key }),
    openRouterKeyClear: () => invoke("studio:openrouter.key.clear"),
    onClaudeLogin: (listener) => subscribe("studio:claude-login", listener),
    codexLoginState: () => invoke("studio:codex-login.state"),
    codexLoginCancel: () => invoke("studio:codex-login.cancel"),
    codexLoginDismiss: () => invoke("studio:codex-login.dismiss"),
    codexLoginOpenBrowser: () => invoke("studio:codex-login.browser"),
    codexLoginRetry: (method) => invoke("studio:codex-login.retry", { method }),
    onCodexLogin: (listener) => subscribe("studio:codex-login", listener),
  } satisfies Partial<StudioApi>;
}

/** The embedded terminal. */
function terminalCalls(bridge: BridgeCalls) {
  const { invoke, subscribe } = bridge;
  return {
    terminalList: () => invoke("studio:terminal.list"),
    terminalAccessibility: () => invoke("studio:terminal.accessibility"),
    terminalOpen: (project) => invoke("studio:terminal.open", { project }),
    terminalRun: (project, command) => invoke("studio:terminal.run", { project, command }),
    terminalAttach: (id) => invoke("studio:terminal.attach", { id }),
    terminalInput: (id, data) => invoke("studio:terminal.input", { id, data }),
    terminalResize: (id, cols, rows) => invoke("studio:terminal.resize", { id, cols, rows }),
    terminalAcknowledge: (id, count) => invoke("studio:terminal.ack", { id, count }),
    terminalStop: (id) => invoke("studio:terminal.stop", { id }),
    terminalRemove: (id) => invoke("studio:terminal.remove", { id }),
    terminalOpenLink: (id) => invoke("studio:terminal.open-link", { id }),
    onTerminal: (listener) => subscribe("studio:terminal", listener),
  } satisfies Partial<StudioApi>;
}

/** The game view. */
function previewCalls(bridge: BridgeCalls) {
  const { invoke } = bridge;
  return {
    loadPreview: (project) => invoke("studio:preview.load", { project }),
    buildPreview: (request) => invoke("studio:build.preview", request),
    agentScreens: () => invoke("studio:preview.screens"),
    previewBounds: (bounds) => invoke("studio:preview.bounds", bounds),
    previewSound: (request) => invoke("studio:preview.sound", request),
    reloadPreview: (options) => invoke("studio:preview.reload", { retry: options?.retry === true }),
    stopPreview: () => invoke("studio:preview.stop"),
    playPreview: () => invoke("studio:preview.play"),
    previewFullScreen: () => invoke("studio:preview.fullscreen"),
    liveBehind: (project) => invoke("studio:live.behind", { project }),
    previewState: () => invoke("studio:preview.state"),
    previewLive: () => invoke("studio:preview.live"),
  } satisfies Partial<StudioApi>;
}
