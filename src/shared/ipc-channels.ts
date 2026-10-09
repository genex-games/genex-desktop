/**
 * The IPC contract between the preload (`window.studio`) and main's `handle()` table.
 *
 * Every `studio:*` invoke channel is a key of {@link STUDIO_INVOKE_CHANNELS}, which names the
 * {@link StudioApi} call it carries, and of {@link StudioInvokePayloads}, which says what the
 * preload sends. The answer is always that call's result, so it is derived, never restated. The
 * preload's `invoke` and main's `handle` both take their types from here: a payload or result
 * that disagrees between the two sides, or a channel only one side knows, does not compile.
 * `main/dev/native-policy.ts` must classify every key.
 *
 * Push channels (main → renderer) are {@link STUDIO_PUSH_CHANNELS}; each names the `on*` call that
 * delivers it, and its payload is that listener's argument.
 *
 * The payload types describe what the preload sends. A renderer is still a browser, so main keeps
 * validating the fields it acts on.
 */
import type { StudioApi } from "./studio-api.ts";
import type { ExportReview, GithubVersion } from "./plugins.ts";

type Arg<M extends keyof StudioApi, I extends number> = Parameters<StudioApi[M]>[I];

/** Each invoke channel and the `StudioApi` call whose result it answers with. */
export const STUDIO_INVOKE_CHANNELS = {
  "studio:performance.mark": "performanceMark",
  "studio:boot": "bootState",
  "studio:boot.retry": "retrySandboxSetup",
  "studio:boot.setup": "setUpSandbox",
  "studio:window.controls": "setWindowControls",
  "studio:update": "readyUpdate",
  "studio:update.restart": "restartToUpdate",
  "studio:update.check": "checkForUpdates",
  "studio:update.download": "openUpdateDownload",
  "studio:update.about": "appAbout",
  "studio:bootstrap": "bootstrap",
  "studio:send": "send",
  "studio:plan.answer": "answerPlan",
  "studio:cancel": "cancelTurn",
  "studio:queue.message": "changeQueuedMessage",
  "studio:chat.rewind.preview": "rewindPreview",
  "studio:chat.rewind": "rewindChat",
  "studio:events": "events",
  "studio:thread.events": "threadEvents",
  "studio:chat.page": "chatPage",
  "studio:threads": "threads",
  "studio:thread.new": "newGameThread",
  "studio:thread.forGame": "threadForGame",
  "studio:thread.rename": "renameThread",
  "studio:compact": "compactThread",
  "studio:game.archive": "archiveGame",
  "studio:game.history": "gameHistory",
  "studio:game.history.clear": "clearGameHistory",
  "studio:game.engine.undo": "undoEngineLink",
  "studio:jobs.stop": "stopJob",
  "studio:app-look.open-settings": "openPrivacySettings",
  "studio:engines": "engines",
  "studio:provider-usage": "providerUsage",
  "studio:hardware": "hardware",
  "studio:game.create": "createGame",
  "studio:game.name": "nameGame",
  "studio:game.location.pick": "pickGameLocation",
  "studio:games-root.choose": "chooseGamesRoot",
  "studio:game.update": "updateGame",
  "studio:game.remove": "removeGame",
  "studio:games": "games",
  "studio:snapshots": "snapshots",
  "studio:selfchanges": "selfChanges",
  "studio:activity": "studioActivity",
  "studio:run.summary": "runSummary",
  "studio:run.review": "runReview",
  "studio:staged": "staged",
  "studio:settings": "settings",
  "studio:settings.set": "setSettings",
  "studio:diagnostics": "diagnostics",
  "studio:feedback.send": "sendFeedback",
  "studio:licenses": "licenses",
  "studio:run-sharing.status": "runSharingStatus",
  "studio:run-sharing.set": "setRunSharing",
  "studio:run-sharing.preview": "runSharingPreview",
  "studio:run-sharing.delete": "deleteSharedRuns",
  "studio:skills.list": "studioSkills",
  "studio:skills.providers": "providerSkills",
  "studio:skills.project": "projectSkills",
  "studio:plugins.skill": "pluginSkillText",
  "studio:plugins.list": "pluginsList",
  "studio:plugins.catalog": "pluginsCatalog",
  "studio:plugins.enable": "pluginEnable",
  "studio:plugins.remove": "pluginRemove",
  "studio:plugins.install": "pluginInstall",
  "studio:plugins.panel": "pluginPanel",
  "studio:plugins.settings": "pluginSettings",
  "studio:plugins.setting": "pluginSetSetting",
  "studio:plugins.review": "pluginReview",
  "studio:plugins.action": "pluginAction",
  "studio:plugins.choose-file": "pluginChooseFile",
  "studio:plugins.genex-publish-review": "genexPublishReview",
  "studio:plugins.genex-publish": "genexPublish",
  "studio:plugins.index": "pluginsIndex",
  "studio:plugins.install-github": "pluginInstallGithub",
  "studio:plugins.lookup-github": "pluginLookupGithub",
  "studio:plugins.github-versions": "pluginGithubVersions",
  "studio:plugins.update": "pluginUpdate",
  "studio:plugins.watch": "pluginWatch",
  "studio:plugins.consent": "pluginConsent",
  "studio:permissions.get": "permissions",
  "studio:permissions.mode": "setPermissionMode",
  "studio:permissions.answer": "answerPermission",
  "studio:permissions.forget": "forgetPermission",
  "studio:loop.dontWait": "setDontWait",
  "studio:loop.dontWaitState": "dontWaitState",
  "studio:mcp.list": "mcpList",
  "studio:context.get": "contextSettings",
  "studio:context.set": "setContextPolicy",
  "studio:connections": "connections",
  "studio:mcp.save": "mcpSave",
  "studio:mcp.remove": "mcpRemove",
  "studio:mcp.test": "mcpTest",
  "studio:mcp.connect": "mcpConnect",
  "studio:mcp.cancel-authorization": "mcpCancelAuthorization",
  "studio:mcp.disconnect-account": "mcpDisconnectAccount",
  "studio:mcp.tools": "mcpTools",
  "studio:mcp.forget-always": "mcpForgetAlwaysAllowed",
  "studio:engines.recheck": "recheckEngines",
  "studio:models.refresh": "refreshModels",
  "studio:cli.update": "cliUpdate",
  "studio:subscription.signin": "subscriptionSignIn",
  "studio:subscription.forget-studio-login": "subscriptionForgetStudioLogin",
  "studio:claude-login.state": "claudeLoginState",
  "studio:claude-login.code": "claudeLoginCode",
  "studio:claude-login.browser": "claudeLoginOpenBrowser",
  "studio:claude-login.cancel": "claudeLoginCancel",
  "studio:opencode.signin": "openCodeSignIn",
  "studio:openrouter.key.save": "openRouterKeySave",
  "studio:openrouter.key.clear": "openRouterKeyClear",
  "studio:terminal.list": "terminalList",
  "studio:terminal.accessibility": "terminalAccessibility",
  "studio:terminal.open": "terminalOpen",
  "studio:terminal.run": "terminalRun",
  "studio:terminal.attach": "terminalAttach",
  "studio:terminal.input": "terminalInput",
  "studio:terminal.resize": "terminalResize",
  "studio:terminal.ack": "terminalAcknowledge",
  "studio:terminal.stop": "terminalStop",
  "studio:terminal.remove": "terminalRemove",
  "studio:terminal.open-link": "terminalOpenLink",
  "studio:codex-login.state": "codexLoginState",
  "studio:codex-login.cancel": "codexLoginCancel",
  "studio:codex-login.dismiss": "codexLoginDismiss",
  "studio:codex-login.browser": "codexLoginOpenBrowser",
  "studio:codex-login.retry": "codexLoginRetry",
  "studio:open-url": "openUrl",
  "studio:notify": "notify",
  "studio:badge": "setBadge",
  "studio:rollback": "rollback",
  "studio:selfchange.undo": "undoChange",
  "studio:preview.load": "loadPreview",
  "studio:build.preview": "buildPreview",
  "studio:preview.screens": "agentScreens",
  "studio:run.still": "readRunStill",
  "studio:game.references": "readReferenceStills",
  "studio:game.asset.preview": "previewProjectAsset",
  "studio:game.asset.present": "presentProjectAssets",
  "studio:game.asset.rigs": "projectModelRigs",
  "studio:game.assets": "projectAssets",
  "studio:game.asset.still": "readProjectAsset",
  "studio:run.feedback": "runFeedback",
  "studio:review.play": "playSnapshot",
  "studio:build.show": "showBuild",
  "studio:build.land": "landBuild",
  "studio:preview.bounds": "previewBounds",
  "studio:preview.sound": "previewSound",
  "studio:preview.reload": "reloadPreview",
  "studio:preview.stop": "stopPreview",
  "studio:preview.play": "playPreview",
  "studio:preview.fullscreen": "previewFullScreen",
  "studio:live.behind": "liveBehind",
  "studio:preview.state": "previewState",
  "studio:preview.live": "previewLive",
  "studio:build.problem": "buildProblem",
  "studio:packages.install": "installPackages",
  "studio:run.start": "startRun",
  "studio:run.stop": "stopRun",
  "studio:run.finish": "finishRun",
  "studio:autopilot.resume": "resumeAutopilot",
  "studio:skillopt.start": "startSkillOpt",
  "studio:skillopt.accept": "acceptProposal",
  "studio:skillopt.discard": "discardProposal",
  "studio:export": "exportGame",
  "studio:cancel-model-download": "cancelModelDownload",
  "studio:model-install.status": "modelInstallStatus",
  "studio:cli-install.start": "cliInstall",
  "studio:cli-install.status": "cliInstallStatus",
  "studio:pull-model": "pullModel",
  "studio:models.lookup": "lookupModel",
  "studio:models.remove": "removeModel",
  "studio:reveal-project": "revealProject",
  "studio:game-file.read": "readGameFile",
  "studio:game-file.reveal": "revealGameFile",
  "studio:chat-files.resolve": "resolveChatFiles",
  "studio:chat-file.open": "openChatFile",
  "studio:message-images": "messageImages",
  "studio:project.pick": "pickProject",
  "studio:project.inspect": "inspectFolder",
  "studio:project.adopt": "adoptFolder",
  "studio:project.open": "openProject",
} as const satisfies Record<`studio:${string}`, keyof StudioApi>;

export type StudioInvokeChannel = keyof typeof STUDIO_INVOKE_CHANNELS;

/** What the preload sends on each invoke channel; `undefined` when it sends nothing. */
export interface StudioInvokePayloads {
  "studio:performance.mark": Arg<"performanceMark", 0>;
  "studio:boot": undefined;
  "studio:boot.retry": undefined;
  "studio:boot.setup": undefined;
  "studio:window.controls": Arg<"setWindowControls", 0>;
  "studio:update": undefined;
  "studio:update.restart": undefined;
  "studio:update.check": undefined;
  "studio:update.download": undefined;
  "studio:update.about": undefined;
  "studio:bootstrap": undefined;
  "studio:send": { text: string } & NonNullable<Arg<"send", 1>>;
  "studio:plan.answer": { threadId: string; id: string; approved: boolean };
  "studio:cancel": { threadId: string };
  "studio:queue.message": {
    threadId: string;
    messageId: string;
    operation: Arg<"changeQueuedMessage", 2>;
    text?: string;
  };
  "studio:chat.rewind.preview": { threadId: string; eventId: string; messageId: string };
  "studio:chat.rewind": { threadId: string; eventId: string; messageId: string; files: boolean };
  "studio:events": { after?: string };
  "studio:thread.events": { threadId: string };
  "studio:chat.page": { threadId: string; before?: string };
  "studio:threads": undefined;
  "studio:thread.new": { project?: string };
  "studio:thread.forGame": { project: string };
  "studio:thread.rename": { threadId: string; title: string };
  "studio:compact": { threadId: string } & NonNullable<Arg<"compactThread", 1>>;
  "studio:game.archive": { project: string };
  "studio:game.history": { project: string };
  "studio:game.history.clear": { project: string };
  "studio:game.engine.undo": Arg<"undoEngineLink", 0>;
  "studio:jobs.stop": { project: string; jobId: string };
  "studio:app-look.open-settings": { pane: Arg<"openPrivacySettings", 0> };
  "studio:engines": undefined;
  "studio:provider-usage": undefined;
  "studio:hardware": undefined;
  "studio:game.create": { title: string } & NonNullable<Arg<"createGame", 1>>;
  "studio:game.name": Arg<"nameGame", 0>;
  "studio:game.location.pick": undefined;
  "studio:games-root.choose": undefined;
  "studio:game.update": { project: string; patch: Arg<"updateGame", 1> };
  "studio:game.remove": { project: string };
  "studio:games": undefined;
  "studio:snapshots": undefined;
  "studio:selfchanges": undefined;
  "studio:activity": undefined;
  "studio:run.summary": { project: string; runId: string; graphFrom?: NonNullable<Arg<"runSummary", 2>> };
  "studio:run.review": { project: string; runId?: string };
  "studio:staged": undefined;
  "studio:settings": undefined;
  "studio:settings.set": Arg<"setSettings", 0>;
  "studio:diagnostics": undefined;
  "studio:feedback.send": Arg<"sendFeedback", 0>;
  "studio:licenses": undefined;
  "studio:run-sharing.status": undefined;
  "studio:run-sharing.set": { on: Arg<"setRunSharing", 0> };
  "studio:run-sharing.preview": undefined;
  "studio:run-sharing.delete": undefined;
  "studio:skills.list": undefined;
  "studio:skills.providers": undefined;
  "studio:skills.project": { project: string };
  "studio:plugins.skill": { id: string; name: string; file?: string };
  "studio:plugins.list": undefined;
  "studio:plugins.catalog": undefined;
  "studio:plugins.enable": { id: string; enabled: boolean };
  "studio:plugins.remove": { id: string };
  "studio:plugins.install": { id?: string };
  "studio:plugins.panel": { id: string; panel: string };
  "studio:plugins.settings": { id: string };
  "studio:plugins.setting": { id: string; key: string; value: unknown };
  "studio:plugins.review": { id: string; name: string; args: unknown; project?: string };
  "studio:plugins.action": { id: string; name: string; args: unknown; project?: string; ticket?: string };
  "studio:plugins.choose-file": { id: string; request: Arg<"pluginChooseFile", 1> };
  "studio:plugins.genex-publish-review": { project: string };
  "studio:plugins.genex-publish": { project: string; review: ExportReview; title?: string };
  "studio:plugins.index": { refresh?: boolean };
  "studio:plugins.install-github": { spec: string };
  "studio:plugins.lookup-github": { link: string; version?: GithubVersion };
  "studio:plugins.github-versions": { repo: string };
  "studio:plugins.update": { id: string };
  "studio:plugins.watch": { id: string; enabled: boolean };
  "studio:plugins.consent": { consentId: string; approved: boolean; always?: boolean };
  "studio:permissions.get": undefined;
  "studio:permissions.mode": { threadId: string | null; mode: Arg<"setPermissionMode", 1> };
  "studio:permissions.answer": { requestId: string; answer: Arg<"answerPermission", 1> };
  "studio:permissions.forget": { project: string; rule: string };
  "studio:loop.dontWait": { threadId: string; on: boolean; offerId?: string };
  "studio:loop.dontWaitState": { threadId: string };
  /** The one channel whose payload is not an object: the project name, `null` or nothing. */
  "studio:mcp.list": Arg<"mcpList", 0>;
  "studio:context.get": { engine: string; model: string; threadId?: string };
  "studio:context.set": { engine: string; model: string; policy: Arg<"setContextPolicy", 2>; threadId?: string };
  "studio:connections": { threadId?: string; project?: string | null };
  "studio:mcp.save": { connector: Arg<"mcpSave", 0>; secrets?: Record<string, string> };
  "studio:mcp.remove": { id: string };
  "studio:mcp.test": { id: string };
  "studio:mcp.connect": { id: string; project?: string };
  "studio:mcp.cancel-authorization": { id: string };
  "studio:mcp.disconnect-account": { id: string };
  "studio:mcp.tools": { id: string };
  "studio:mcp.forget-always": { id: string };
  "studio:engines.recheck": { engine?: string };
  "studio:models.refresh": { provider: string };
  "studio:cli.update": { provider: string };
  "studio:subscription.signin": NonNullable<Arg<"subscriptionSignIn", 0>>;
  "studio:subscription.forget-studio-login": { engine?: string };
  "studio:claude-login.state": undefined;
  "studio:claude-login.code": { code: string };
  "studio:claude-login.browser": undefined;
  "studio:claude-login.cancel": undefined;
  "studio:opencode.signin": undefined;
  "studio:openrouter.key.save": { key: string };
  "studio:openrouter.key.clear": undefined;
  "studio:terminal.list": undefined;
  "studio:terminal.accessibility": undefined;
  "studio:terminal.open": { project: string };
  "studio:terminal.run": { project: string; command: string };
  "studio:terminal.attach": { id: string };
  "studio:terminal.input": { id: string; data: string };
  "studio:terminal.resize": { id: string; cols: number; rows: number };
  "studio:terminal.ack": { id: string; count: number };
  "studio:terminal.stop": { id: string };
  "studio:terminal.remove": { id: string };
  "studio:terminal.open-link": { id: string };
  "studio:codex-login.state": undefined;
  "studio:codex-login.cancel": undefined;
  "studio:codex-login.dismiss": undefined;
  "studio:codex-login.browser": undefined;
  "studio:codex-login.retry": { method: Arg<"codexLoginRetry", 0> };
  "studio:open-url": { url: string };
  "studio:notify": Arg<"notify", 0>;
  "studio:badge": { count: number };
  "studio:rollback": { snapshotId: string };
  "studio:selfchange.undo": { snapshotId: string };
  "studio:preview.load": { project: string };
  "studio:build.preview": Arg<"buildPreview", 0>;
  "studio:preview.screens": undefined;
  "studio:run.still": { file: string; maxPx?: number };
  "studio:game.references": { project: string };
  "studio:game.asset.preview": Arg<"previewProjectAsset", 0>;
  "studio:game.asset.present": Arg<"presentProjectAssets", 0>;
  "studio:game.asset.rigs": Arg<"projectModelRigs", 0>;
  "studio:game.assets": { project: string };
  "studio:game.asset.still": Arg<"readProjectAsset", 0>;
  "studio:run.feedback": Arg<"runFeedback", 0>;
  "studio:review.play": { snapshotId: string; project: string };
  "studio:build.show": { project: string; commit: string };
  "studio:build.land": { project: string; commit: string };
  "studio:preview.bounds": Arg<"previewBounds", 0>;
  "studio:preview.sound": Arg<"previewSound", 0>;
  "studio:preview.reload": { retry: boolean };
  "studio:preview.stop": undefined;
  "studio:preview.play": undefined;
  "studio:preview.fullscreen": undefined;
  "studio:live.behind": { project: string };
  "studio:preview.state": undefined;
  "studio:preview.live": undefined;
  "studio:build.problem": { project: string };
  "studio:packages.install": { project: string };
  "studio:run.start": Arg<"startRun", 0>;
  "studio:run.stop": { runId: string };
  "studio:run.finish": { runId: string; threadId: string };
  "studio:autopilot.resume": { runId: string };
  "studio:skillopt.start": undefined;
  "studio:skillopt.accept": { index: number } & NonNullable<Arg<"acceptProposal", 1>>;
  "studio:skillopt.discard": { index: number; reason?: string } & NonNullable<Arg<"discardProposal", 2>>;
  "studio:export": { project: string };
  "studio:cancel-model-download": Record<string, never>;
  "studio:model-install.status": undefined;
  "studio:cli-install.start": { provider: string };
  "studio:cli-install.status": undefined;
  "studio:pull-model": { model: string };
  "studio:models.lookup": { model: string };
  "studio:models.remove": { model: string };
  "studio:reveal-project": { project: string; file?: string };
  "studio:game-file.read": { threadId: string; path: string };
  "studio:game-file.reveal": { threadId: string; path: string };
  "studio:chat-files.resolve": { threadId: string; refs: Arg<"resolveChatFiles", 1> };
  "studio:chat-file.open": { threadId: string; ref: Arg<"openChatFile", 1> };
  "studio:message-images": { threadId: string; messageId: string };
  "studio:project.pick": undefined;
  "studio:project.inspect": { dir: string };
  "studio:project.adopt": { dir: string } & NonNullable<Arg<"adoptFolder", 1>>;
  "studio:project.open": { name: string };
}

export type StudioInvokePayload<C extends StudioInvokeChannel> = StudioInvokePayloads[C];
/** What main answers on a channel: the result of the `StudioApi` call it carries. */
export type StudioInvokeResult<C extends StudioInvokeChannel> = Awaited<
  ReturnType<StudioApi[(typeof STUDIO_INVOKE_CHANNELS)[C]]>
>;

/** Every invoke answers with this envelope; the preload turns `ok: false` into a rejection. */
export type IpcResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/** Each push channel and the `StudioApi` subscription that delivers it. */
export const STUDIO_PUSH_CHANNELS = {
  "studio:event": "onEvent",
  "studio:terminal": "onTerminal",
  "studio:claude-login": "onClaudeLogin",
  "studio:codex-login": "onCodexLogin",
} as const satisfies Record<`studio:${string}`, keyof StudioApi>;

export type StudioPushChannel = keyof typeof STUDIO_PUSH_CHANNELS;
type Subscription<M extends keyof StudioApi> = StudioApi[M] extends (listener: (payload: infer P) => void) => () => void
  ? P
  : never;
/** What main pushes on a channel: the argument the subscribing call's listener receives. */
export type StudioPushPayload<C extends StudioPushChannel> = Subscription<(typeof STUDIO_PUSH_CHANNELS)[C]>;

// Both directions: a channel with no payload entry, or a payload entry for no channel, fails here.
type MissingPayload = Exclude<StudioInvokeChannel, keyof StudioInvokePayloads>;
type StrayPayload = Exclude<keyof StudioInvokePayloads, StudioInvokeChannel>;
const payloadsMatchChannels: [MissingPayload | StrayPayload] extends [never]
  ? true
  : { missing: MissingPayload; stray: StrayPayload } = true;
void payloadsMatchChannels;
