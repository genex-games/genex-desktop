import type { StudioInvokeChannel } from "../../shared/ipc-channels.ts";
/**
 * Fixture policy for every IPC channel, as an explicit two-way table. Main runs the guard before
 * invoking any handler (and before a few native steps inside one, named in `NATIVE_STEPS`). The
 * two tables take their keys from the channel map (`shared/ipc-channels.ts`), and a channel of the
 * map in neither table does not typecheck, so a new native action is never allowed by default.
 * At runtime an unclassified channel is still refused in fixtures.
 */
const NATIVE_CHANNELS = [
  "studio:terminal.open",
  // A command a chat reply offered runs in the user's own shell, like the project terminal.
  "studio:terminal.run",
  "studio:plugins.install",
  "studio:plugins.install-github",
  // Looking a pasted link up asks GitHub for the repository, its latest release and its plugin.json.
  "studio:plugins.lookup-github",
  "studio:plugins.github-versions",
  "studio:plugins.update",
  // A plugin panel's Choose file opens Studio's native file picker; a fixture profile answers unsupported.
  "studio:plugins.choose-file",
  // Publish from Studio's dialog uploads the game to Genex with the user's real account.
  "studio:plugins.genex-publish",
  "studio:subscription.signin",
  "studio:subscription.forget-studio-login",
  // OpenCode's sign-in runs its CLI in a terminal and reaches the provider the person picks.
  "studio:opencode.signin",
  // Opens the sign-in page a terminal printed in the person's browser.
  "studio:terminal.open-link",
  // Saving checks the key with OpenRouter and writes it to the OS secret store; forgetting it
  // deletes it there. A fixture profile has no key and no network.
  "studio:openrouter.key.save",
  "studio:openrouter.key.clear",
  "studio:codex-login.browser",
  "studio:codex-login.retry",
  "studio:claude-login.browser",
  "studio:open-url",
  // A macOS notification lands in the developer's Notification Center, outside the fixture.
  "studio:notify",
  // Show in Finder for a file a chat names, like `studio:reveal-project`.
  "studio:game-file.reveal",
  // Opening a file the chat names hands it to another app or to the file manager; resolving
  // names (`studio:chat-files.resolve`) only reads.
  "studio:chat-file.open",
  "studio:reveal-project",
  "studio:project.pick",
  // Create game's location is chosen in the native folder picker.
  "studio:game.location.pick",
  // Settings → Games opens the native folder picker.
  "studio:games-root.choose",
  "studio:pull-model",
  "studio:models.lookup",
  // Delete removes model files from this Mac, or asks the person's own Ollama to delete one.
  "studio:models.remove",
  // Install fetches the vendor's installer and runs it as the person: a download and a real install.
  "studio:cli-install.start",
  "studio:models.refresh",
  "studio:cli.update",
  // Delete what I shared asks the Genex API to remove this install's rows: the network.
  "studio:run-sharing.delete",
  // Send feedback posts the report to genex.games: the network.
  "studio:feedback.send",
  "studio:cancel-model-download",
  "studio:export",
  // The one channel that opens the network: "Install packages" runs the folder's own
  // package manager with registry.npmjs.org allowed. A fixture profile refuses downloads.
  "studio:packages.install",
  // Set up (Windows) creates a local user account and network filters behind an administrator
  // prompt; a fixture profile never provisions anything on the machine.
  "studio:boot.setup",
  // Relaunch to update quits the app and installs a downloaded release over it.
  "studio:update.restart",
  // Download opens the waiting release's page in the person's real browser.
  "studio:update.download",
] as const satisfies readonly StudioInvokeChannel[];
/**
 * Native steps inside a handler, asserted by name with `assertNativeActionAllowed`; no channel of
 * their own, so they are not keys of the channel map.
 */
const NATIVE_STEPS = [
  // `studio:plugins.action` asserts it before the native dialog that approves a confirmed action.
  "studio:plugins.approval",
  // `studio:plugins.action` asserts it before an action its manifest marks `native`: one that starts,
  // quits or opens a desktop app or the browser, or writes outside the plugin's storage. A fixture
  // profile refuses it before the backend runs.
  "studio:plugins.native-action",
  // Names left from Genex's own channels, from before Genex became a plugin. Kept native, so a
  // channel that brings one back starts out refused in fixtures.
  "studio:genex.connect",
  "studio:genex.disconnect",
  "studio:genex.enable",
  "studio:genex.allowance",
  "studio:genex.approve",
  // Not a channel of its own: `studio:mcp.save` asserts it before the native trust dialog that
  // approves starting a program on this Mac. A fixture profile never launches a typed-in stdio
  // connector, so it never reaches the dialog either.
  "studio:mcp.trust",
  // Not a channel of its own either: `studio:mcp.connect` asserts it before opening a connector's
  // OAuth page in the user's real browser, where their real sessions could complete the sign-in.
  "studio:mcp.authorize",
  // Not channels either: the bundled Genex plugin's host tools. `host-cli` runs Studio's Genex CLI
  // with the user's real Genex account; `host-package` opens the npm registry for one install.
  "studio:plugins.host-cli",
  "studio:plugins.host-package",
] as const;
/** Channels a disposable fixture profile may run: no native account, dialog, download or external app. */
const FIXTURE_SAFE = [
  "studio:terminal.list",
  "studio:terminal.accessibility",
  "studio:terminal.attach",
  "studio:terminal.input",
  "studio:terminal.resize",
  "studio:terminal.ack",
  "studio:terminal.stop",
  "studio:terminal.remove",
  // Boot reads main's state; Retry re-runs core startup, which a fixture profile may do.
  "studio:boot",
  "studio:boot.retry",
  // Recolours this window's own title-bar controls; nothing outside the window changes.
  "studio:window.controls",
  // Reads which update main holds; a fixture profile never downloads one (update-ready seeds a stand-in).
  "studio:update",
  // A studio:dev launch never checks (`autoUpdateDecision`): it answers off, or the update-ready stand-in.
  "studio:update.check",
  // Names the running version, platform and architecture; reads nothing else.
  "studio:update.about",
  "studio:bootstrap",
  "studio:performance.mark",
  "studio:send",
  "studio:plan.answer",
  "studio:cancel",
  "studio:queue.message",
  // Rewind reads and rewrites only the chat's own log and its game folder's checkpoints.
  "studio:chat.rewind.preview",
  "studio:chat.rewind",
  "studio:events",
  "studio:chat.page",
  "studio:compact",
  "studio:activity",
  "studio:threads",
  "studio:thread.events",
  "studio:thread.new",
  "studio:thread.forGame",
  "studio:thread.rename",
  // Reads inside the chat's own game folder or its run's build, and the images a message saved.
  "studio:game-file.read",
  "studio:message-images",
  // Which names a chat wrote are files: it only looks (the Finder or app step is native).
  "studio:chat-files.resolve",
  "studio:context.get",
  "studio:context.set",
  "studio:games",
  "studio:snapshots",
  "studio:rollback",
  "studio:game.archive",
  // A game's history space and clearing its side tracks: git in the game's own folder.
  "studio:game.history",
  "studio:game.history.clear",
  "studio:game.engine.undo",
  "studio:game.create",
  // Naming a new game is one completion on the picked engine, like a chat message (`studio:send`).
  "studio:game.name",
  "studio:game.update",
  "studio:game.remove",
  "studio:game.references",
  "studio:game.asset.preview",
  "studio:game.asset.present",
  "studio:game.asset.rigs",
  "studio:game.assets",
  "studio:game.asset.still",
  "studio:engines",
  "studio:engines.recheck",
  "studio:hardware",
  "studio:model-install.status",
  "studio:cli-install.status",
  // Plan limits come from the profile's own engines; fixture engines report none and open no socket.
  "studio:provider-usage",
  // The count on Studio's own Dock icon; it reaches nothing outside this app.
  "studio:badge",
  "studio:preview.load",
  "studio:preview.screens",
  "studio:preview.bounds",
  "studio:preview.sound",
  "studio:preview.reload",
  "studio:preview.stop",
  "studio:preview.play",
  // The app's own window over its own game view: no account, dialog or other app is reached.
  "studio:preview.fullscreen",
  "studio:live.behind",
  "studio:preview.state",
  "studio:preview.live",
  "studio:build.preview",
  "studio:build.show",
  "studio:build.land",
  "studio:build.problem",
  "studio:run.still",
  "studio:run.feedback",
  "studio:run.summary",
  "studio:run.review",
  "studio:run.start",
  "studio:run.stop",
  "studio:run.finish",
  "studio:review.play",
  "studio:autopilot.resume",
  "studio:skillopt.start",
  "studio:skillopt.accept",
  "studio:skillopt.discard",
  "studio:selfchanges",
  "studio:selfchange.undo",
  "studio:staged",
  "studio:settings",
  "studio:settings.set",
  // Reads the profile's own log and engine statuses; the renderer does the copying.
  "studio:diagnostics",
  // The license files the build wrote into the app's own resources; no path comes from the page.
  "studio:licenses",
  // Share build metrics: the switch, its status and the preview read and write the profile's own
  // files; a developer or fixture launch never sends (`main/run-sharing.ts`), so no socket opens.
  "studio:run-sharing.status",
  "studio:run-sharing.set",
  "studio:run-sharing.preview",
  "studio:skills.list",
  "studio:skills.providers",
  // Reads one game's own skill folders and a plugin's skill files: no dialog, account or socket.
  "studio:skills.project",
  "studio:plugins.skill",
  // Reading the index and watching a local folder open no dialog and, offline, no socket either.
  // Actions reach native steps only through the `plugins.approval`, `plugins.native-action` and
  // `open-url` checks inside them.
  "studio:plugins.consent",
  // A chat's mode, its cards' answers and the saved rules: the profile's own files, no dialog or socket.
  "studio:permissions.get",
  "studio:permissions.mode",
  "studio:permissions.answer",
  "studio:permissions.forget",
  // The person's "Don't wait for me" and its state: the profile's own file and the chat's log.
  "studio:loop.dontWait",
  "studio:loop.dontWaitState",
  "studio:plugins.list",
  "studio:plugins.catalog",
  "studio:plugins.enable",
  "studio:plugins.remove",
  "studio:plugins.panel",
  "studio:plugins.settings",
  "studio:plugins.setting",
  "studio:plugins.review",
  "studio:plugins.action",
  // Publish's file list: the same export Export makes, into the profile's scratch, then removed.
  "studio:plugins.genex-publish-review",
  "studio:plugins.index",
  "studio:plugins.watch",
  // Connectors write a file inside the profile; only the trust step is native.
  "studio:mcp.list",
  "studio:mcp.save",
  "studio:mcp.remove",
  "studio:mcp.test",
  "studio:mcp.connect",
  "studio:mcp.cancel-authorization",
  "studio:mcp.disconnect-account",
  "studio:mcp.tools",
  "studio:mcp.forget-always",
  "studio:connections",
  "studio:claude-login.state",
  "studio:claude-login.code",
  "studio:claude-login.cancel",
  "studio:codex-login.state",
  "studio:codex-login.cancel",
  "studio:codex-login.dismiss",
  // Adoption opens no network and writes only inside the profile's own games root.
  "studio:project.inspect",
  "studio:project.adopt",
  "studio:project.open",
] as const satisfies readonly StudioInvokeChannel[];
export type NativeChannel = (typeof NATIVE_CHANNELS)[number];
export type NativeStep = (typeof NATIVE_STEPS)[number];
export type FixtureSafeChannel = (typeof FIXTURE_SAFE)[number];
export type ClassifiedChannel = NativeChannel | FixtureSafeChannel;
// Every channel of the map is classified: one missing from both tables fails here.
type Unclassified = Exclude<StudioInvokeChannel, ClassifiedChannel>;
const everyChannelClassified: [Unclassified] extends [never] ? true : { unclassified: Unclassified } = true;
void everyChannelClassified;
export const FIXTURE_BLOCKED_CHANNELS: ReadonlySet<string> = new Set<string>([...NATIVE_CHANNELS, ...NATIVE_STEPS]);
export const FIXTURE_SAFE_CHANNELS: ReadonlySet<string> = new Set(FIXTURE_SAFE);
/** The native steps: blocked in fixtures like native channels, but never registered as one. */
export const FIXTURE_NATIVE_STEPS: ReadonlySet<string> = new Set(NATIVE_STEPS);
/** How a fixture session treats a channel. */
export const ChannelClass = { FixtureSafe: "fixture-safe", Native: "native", Unclassified: "unclassified" } as const;
export type ChannelClass = (typeof ChannelClass)[keyof typeof ChannelClass];

/** Why a fixture session refuses a channel; scripts match the `unsupported-in-fixture` prefix. */
const MESSAGE = {
  native: "unsupported-in-fixture: native accounts, dialogs, downloads and external actions require a live profile",
  unclassified: (channel: string) =>
    `unsupported-in-fixture: ${channel} is not classified in src/main/dev/native-policy.ts`,
} as const;
export function classifyChannel(channel: string): ChannelClass {
  if (FIXTURE_BLOCKED_CHANNELS.has(channel)) return ChannelClass.Native;
  if (FIXTURE_SAFE_CHANNELS.has(channel)) return ChannelClass.FixtureSafe;
  return ChannelClass.Unclassified;
}
export function assertNativeActionAllowed(fixture: boolean, channel: string): void {
  if (!fixture) return;
  const kind = classifyChannel(channel);
  if (kind === ChannelClass.Native) throw new Error(MESSAGE.native);
  if (kind === ChannelClass.Unclassified) throw new Error(MESSAGE.unclassified(channel));
}
