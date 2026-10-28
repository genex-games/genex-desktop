/**
 * Do it for me (`game.engine.assist`): an engine plugin hands a setup task to its game's chat, and
 * that chat's own session clicks it with the person's computer control (`desktop-session.ts`).
 *
 * Computer use here is only for setup clicks and publishing the person approved: a switch or a
 * dialog that only the engine's own window offers. It never builds or play-tests a game; the
 * engine's own tools do that, and the engine-app guard (`desktop-target.ts`) refuses its editor to
 * every other turn.
 *
 * - **Who may ask.** The person: a plugin action they pressed, or a tool call whose own card they
 *   approved (`asked`). A plugin that came with Genex may also start one from its own tools, for the
 *   setup it knows (its task is its own code's, never an agent's words). A Genex moment's or an
 *   observer's step never asks (the plugin services refuse it first); any other call is `not-person`.
 *   An unasked one while the chat's assist is under way is `in-assist`: the turn answering that
 *   assist is the one that clicks, so it never hands its own task on again.
 * - **Trust.** The task is posted verbatim as "<plugin> asks: <task>". A plugin that came with
 *   Genex asks nothing more; any other shows the task on a card first, every time.
 * - **Computer control off.** A card offers to turn it on, for every chat (it is one setting).
 * - **Apps.** The turn may drive only the apps the plugin's `engine.apps` declares for this system
 *   (Mac bundle ids, Windows executables); a call cannot widen them. Only the turn that answers the
 *   task holds the grant (never another turn of the chat running beside it), until it ends and
 *   never past {@link ASSIST_GRANT_MAX_MS}.
 * - **Where it can't run.** A computer with no desktop driver (Linux, or a development build
 *   without one): `unavailable`, and the plugin shows its click path instead.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { SteerDelivery } from "../../shared/message-queue.ts";
import {
  computerSettingNote,
  computerSettingQuestion,
  type EngineAssistAnswer,
  EngineAssistRefusal,
  type PluginBinding,
  type PluginInfo,
  PluginSourceKind,
  StudioConsentSource,
} from "../../shared/plugins.ts";
import type { EngineApps } from "../../shared/game-engine.ts";
import { t } from "../../shared/i18n.ts";
import { windowsAppId } from "../../substrate/desktop-driver.ts";
import { shortId } from "../../substrate/ids.ts";
import type { StudioCore } from "../studio-core.ts";

/** The longest an assist's grant lasts when the host cannot see its turn end (a resumed turn, the harness's own loop). */
export const ASSIST_GRANT_MAX_MS = 20 * MINUTE_MS;

/**
 * What the person reads: the task's card, the setting's card, and the turn's message. The cards'
 * questions are in the person's language; the descriptions (never shown on a card) and the turn's
 * message, which the chat's agent reads as the task, stay English.
 */
const MESSAGE = {
  task: () => t("Let the agent do this with computer control?"),
  taskNote: (plugin: string, task: string) => t("{plugin} asks: {task}", { plugin, task }),
  taskDescription: "a setup step done with computer control",
  setting: computerSettingQuestion,
  settingNote: computerSettingNote,
  settingDescription: "turning on computer control for every chat",
  asks: (plugin: string, task: string) => `${plugin} asks: ${task}`,
} as const;

/** The cards an assist may ask. */
export const AssistCardKind = {
  /** A plugin that did not come with Genex: its task, shown before anything happens. */
  Task: "task",
  /** Computer control is off: turn it on for every chat? */
  ComputerSetting: "computer-setting",
} as const;
export type AssistCardKind = (typeof AssistCardKind)[keyof typeof AssistCardKind];

/** One card an assist asks the person. */
export type AssistCard =
  | { kind: typeof AssistCardKind.Task; pluginId: string; pluginName: string; task: string }
  | { kind: typeof AssistCardKind.ComputerSetting };

/** What one chat's setup assist may drive: the plugin's apps, for the turn that answers its message. */
export interface AssistGrant {
  pluginId: string;
  /** The plugin's `engine.apps` for this system ({@link engineAppIds}). */
  apps: ReadonlySet<string>;
  /** The queue id of the message that asks for the task. */
  messageId: string;
  /**
   * The person asked for it (an action they pressed, or a card they approved): that is their yes
   * to computer control for its turn, so the turn asks no session or app card of its own.
   */
  asked: boolean;
}

/** A grant as it is held: when it was given, and the turn its message was steered into, if any. */
interface HeldGrant extends AssistGrant {
  at: number;
  into: string | null;
}

/** Text items only: an app list as a grant's file keeps it. */
const textList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

/** A held grant as its file keeps it, or null when the entry is not one. */
function heldGrantOf(value: unknown): HeldGrant | null {
  if (!value || typeof value !== "object") return null;
  const { pluginId, apps, messageId, asked, at, into } = value as Record<string, unknown>;
  const appList = textList(apps);
  if (!appList || typeof at !== "number") return null;
  if (typeof pluginId !== "string" || typeof messageId !== "string") return null;
  return {
    pluginId,
    apps: new Set(appList),
    messageId,
    asked: asked === true,
    at,
    into: typeof into === "string" ? into : null,
  };
}

/** The grants a file kept, by chat; none from a file that is missing or not theirs. */
function readHeldGrants(file: string): Map<string, HeldGrant> {
  const held = new Map<string, HeldGrant>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return held;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return held;
  for (const [threadId, value] of Object.entries(parsed)) {
    const grant = heldGrantOf(value);
    if (grant) held.set(threadId, grant);
  }
  return held;
}

/**
 * The chats' live assist grants, one per chat. A grant ends when the turn answering its message
 * ends: the turn that message started, or the running turn it was steered into. It never outlasts
 * {@link ASSIST_GRANT_MAX_MS}, for the turns the host cannot follow. With a `file`, the grants
 * outlive Genex quitting: the person pressed Publish, then macOS asked them to reopen Genex for
 * Screen Recording, and the queue's retry of that message is still the turn that answers it.
 */
export class AssistGrants {
  readonly #now: () => number;
  readonly #file: string | null;
  readonly #held: Map<string, HeldGrant>;
  readonly #ended = new Set<(threadId: string) => void>();
  constructor(now: () => number = Date.now, file: string | null = null) {
    this.#now = now;
    this.#file = file;
    this.#held = file ? readHeldGrants(file) : new Map();
  }
  /** Keep the grants in their file, where they have one; a failed write only loses them at the next quit. */
  #save(): void {
    if (!this.#file) return;
    const kept = Object.fromEntries(
      [...this.#held].map(([threadId, held]) => [threadId, { ...held, apps: [...held.apps] }]),
    );
    try {
      mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 });
      renameSync(temporary, this.#file);
    } catch {
      // Held in memory still: this run of Genex keeps every grant it gave.
    }
  }
  /** Give a chat a grant for the turn that answers `messageId`; it replaces any it held. */
  record(
    threadId: string,
    grant: { pluginId: string; apps: readonly string[]; messageId: string; asked?: boolean },
  ): void {
    const { pluginId, apps, messageId, asked = false } = grant;
    this.#held.set(threadId, { pluginId, apps: new Set(apps), messageId, asked, at: this.#now(), into: null });
    this.#save();
  }
  /** The chat's grant while it lasts; null when it has none. */
  live(threadId: string): AssistGrant | null {
    const held = this.#held.get(threadId);
    if (!held) return null;
    if (this.#now() - held.at >= ASSIST_GRANT_MAX_MS) {
      this.#held.delete(threadId);
      this.#save();
      return null;
    }
    return { pluginId: held.pluginId, apps: held.apps, messageId: held.messageId, asked: held.asked };
  }
  /**
   * The chat's grant for one session: only the turn that answers its message (the turn the message
   * started, or the running turn it was steered into) holds it, so a build turn running beside the
   * assist never drives the engine's editor. A session with no turn the host can follow (the
   * harness's own loop) holds it within {@link ASSIST_GRANT_MAX_MS}.
   */
  forTurn(threadId: string, turn: string | undefined): AssistGrant | null {
    const grant = this.live(threadId);
    if (!grant || turn === undefined) return grant;
    const into = this.#held.get(threadId)?.into ?? null;
    return turn === grant.messageId || turn === into ? grant : null;
  }
  /** A message was steered into the running turn `into`: if it is the grant's, that turn answers it. */
  steered(threadId: string, into: string, messageId: string): void {
    const held = this.#held.get(threadId);
    if (held?.messageId !== messageId) return;
    held.into = into;
    this.#save();
  }
  /** A turn of the chat ended: the grant ends with it when that turn answered its message. */
  turnEnded(threadId: string, turn: string): void {
    const held = this.#held.get(threadId);
    if (!held || (held.messageId !== turn && held.into !== turn)) return;
    this.#held.delete(threadId);
    this.#save();
    for (const listener of this.#ended) listener(threadId);
  }
  /** Hear each grant's turn end (the person's app comes back to the front); returns the stop. */
  onEnded(listener: (threadId: string) => void): () => void {
    this.#ended.add(listener);
    return () => this.#ended.delete(listener);
  }
}

/** The queue's records that end a message: its turn answered it (or failed), or it was taken back. */
const MESSAGE_ENDS: ReadonlySet<string> = new Set([
  CustomEvent.CoordinatorMessageHandled,
  CustomEvent.CoordinatorMessageRemoved,
]);

/**
 * Follow the chat's queue records for assist messages: a message the log says reached a running
 * turn (read in place, or by interrupting that turn and resuming it with the message in front)
 * moves its grant to that turn. One handed to a build's lead moves nothing: a lead never clicks for
 * the person. A message answered or taken back ends its grant, also for a turn that never opened
 * computer control (one that failed before it could click).
 */
export function followAssistDeliveries(grants: AssistGrants, threadId: string, batch: readonly EventData[]): void {
  for (const data of batch) {
    const record = data.type === EventKind.Custom ? customRecord(data) : null;
    if (!record) continue;
    const { messageId, into, how } = record.payload;
    if (MESSAGE_ENDS.has(record.event_type) && typeof messageId === "string") grants.turnEnded(threadId, messageId);
    if (record.event_type !== CustomEvent.CoordinatorMessageDelivered) continue;
    const toTurn = typeof messageId === "string" && typeof into === "string" && how !== SteerDelivery.Lead;
    if (toTurn) grants.steered(threadId, into, messageId);
  }
}

/** Each core's assist grants. */
const GRANTS = new WeakMap<object, AssistGrants>();

/** Where a core keeps its grants: in its own data, beside the folders no agent process may write. */
const GRANTS_FILE = "assist-grants.json";

/** The core's assist grants, made on first use, kept across Genex quitting where the core has a layout. */
export function assistGrants(core: { readonly layout?: Pick<StudioCore["layout"], "jobs"> }): AssistGrants {
  const known = GRANTS.get(core);
  if (known) return known;
  const jobs = core.layout?.jobs;
  const made = new AssistGrants(Date.now, jobs ? path.join(path.dirname(jobs), GRANTS_FILE) : null);
  GRANTS.set(core, made);
  return made;
}

/** What the engine-app guard reads of a plugin: whether it is live, and its engine declaration. */
type EnginePlugin = Pick<PluginInfo, "enabled" | "removed"> & { manifest: Pick<PluginInfo["manifest"], "engine"> };

const livePlugins = <T extends Pick<PluginInfo, "enabled" | "removed">>(plugins: readonly T[]): T[] =>
  plugins.filter((plugin) => plugin.enabled && !plugin.removed);

/**
 * The apps an engine declares for `platform`, as the desktop names them: Mac bundle ids, or Windows
 * executables in lower case (`windowsAppId`).
 */
export function engineAppIds(apps: EngineApps | undefined, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return (apps?.windows ?? []).map(windowsAppId);
  return [...(apps?.mac ?? [])];
}

/** The editors every enabled engine plugin declares for `platform`: the guard's refusals outside an assist. */
export function declaredEngineApps(
  plugins: readonly EnginePlugin[],
  platform: NodeJS.Platform = process.platform,
): ReadonlySet<string> {
  return new Set(livePlugins(plugins).flatMap((plugin) => engineAppIds(plugin.manifest.engine?.apps, platform)));
}

/** The apps every enabled engine's games are played in on `platform`: refused always, an assist included. */
export function declaredPlayerApps(
  plugins: readonly EnginePlugin[],
  platform: NodeJS.Platform = process.platform,
): ReadonlySet<string> {
  return new Set(livePlugins(plugins).flatMap((plugin) => engineAppIds(plugin.manifest.engine?.playerApps, platform)));
}

/** What the page policy reads of a plugin: whether it is live, its id and the pages its engine declares. */
type PagePlugin = Pick<PluginInfo, "enabled" | "removed"> & {
  manifest: { id: string; engine?: { pages?: readonly string[] } };
};

/**
 * Why `open_page` may not open `address` in the person's browser now, or null: only the turn holding
 * an assist's grant opens a page, and only on a host its own engine declares (`engine.pages`), exactly.
 */
export function assistPageRefusal(
  address: URL,
  grant: Pick<AssistGrant, "pluginId"> | null,
  plugins: readonly PagePlugin[],
): string | null {
  if (!grant) return PAGE_MESSAGE.noGrant;
  const owner = livePlugins(plugins).find((plugin) => plugin.manifest.id === grant.pluginId);
  const pages = owner?.manifest.engine?.pages ?? [];
  if (pages.length === 0) return PAGE_MESSAGE.noPages;
  return pages.includes(address.hostname) ? null : PAGE_MESSAGE.notDeclared(pages);
}

/** Whether an assist's engine opens pages in the person's browser (`engine.pages`), so its step may need their browser. */
export function assistOpensPages(grant: Pick<AssistGrant, "pluginId">, plugins: readonly PagePlugin[]): boolean {
  const owner = livePlugins(plugins).find((plugin) => plugin.manifest.id === grant.pluginId);
  return (owner?.manifest.engine?.pages?.length ?? 0) > 0;
}

/** What the agent reads when a page is refused. */
const PAGE_MESSAGE = {
  noGrant: "open_page opens a page only in the turn that answers an engine's task (such as Publish to Roblox)",
  noPages: "this task's engine declares no pages to open",
  notDeclared: (pages: readonly string[]) => `this task opens only pages on ${pages.join(", ")}`,
} as const;

/** What an assist needs of the host. */
export interface AssistHost {
  /** The enabled plugin: its name, whether it came with Genex, and the apps its engine declares for this system. */
  plugin(id: string): { name: string; bundled: boolean; apps: readonly string[] } | null;
  /** Whether computer control can run here: a desktop and its driver (a Mac's or a PC's). */
  desktopAvailable(): Promise<boolean>;
  /** Whether the driver can see and move, waiting while the person allows it in System Settings. */
  grantsReady(signal?: AbortSignal): Promise<boolean>;
  computerControlOn(): boolean;
  /** Settings → Permissions → computer control, turned on. */
  turnOnComputerControl(): Promise<void>;
  /** The game's chat, when the call named none. */
  gameChat(project: string): Promise<string>;
  /** Ask the person on a card in the chat `binding` names; true on their yes. */
  ask(card: AssistCard, binding: PluginBinding, signal?: AbortSignal): Promise<boolean>;
  /** Start a turn in the chat with this message, under this queue id. */
  post(threadId: string, project: string, text: string, messageId: string): Promise<void>;
  grants: AssistGrants;
  /** A new queue id for the task's message. */
  messageId(): string;
}

/** One assist: the plugin that asks, the game it was called for, its task and the call's signal. */
export interface AssistRequest {
  pluginId: string;
  binding: PluginBinding | undefined;
  task: string;
  /** The person asked: an action they pressed, or a tool call whose own card they approved. */
  asked: boolean;
  signal?: AbortSignal;
}

const refused = (reason: EngineAssistRefusal): EngineAssistAnswer => ({ started: false, reason });

/**
 * Whether an assist can run for `pluginId` here: an enabled plugin whose engine declares apps for
 * this computer, and a desktop with its driver. Computer control that is off still counts: its card
 * offers to turn it on. Asks nothing and changes nothing.
 */
export async function assistAvailable(host: AssistHost, pluginId: string): Promise<boolean> {
  if (!host.plugin(pluginId)?.apps.length) return false;
  return host.desktopAvailable();
}

/**
 * Whether the game's chat still runs the turn `pluginId`'s assist started: its grant lasts until
 * that turn ends (answered, failed or taken back) or {@link ASSIST_GRANT_MAX_MS} is up.
 */
export async function assistUnderWay(host: AssistHost, pluginId: string, binding: PluginBinding): Promise<boolean> {
  const threadId = binding.threadId ?? (await host.gameChat(binding.project));
  return host.grants.live(threadId)?.pluginId === pluginId;
}

/**
 * Hand a setup task to the game's chat (module comment). Every refusal comes before anything
 * changes: no card, no setting, no grant and no message.
 */
export async function engineAssist(host: AssistHost, request: AssistRequest): Promise<EngineAssistAnswer> {
  const { pluginId, binding, task, signal } = request;
  if (!binding) return refused(EngineAssistRefusal.NoChat);
  const plugin = host.plugin(pluginId);
  if (!plugin?.apps.length) return refused(EngineAssistRefusal.NoApps);
  if (!request.asked && !plugin.bundled) return refused(EngineAssistRefusal.NotPerson);
  if (!(await host.desktopAvailable())) return refused(EngineAssistRefusal.Unavailable);
  const threadId = binding.threadId ?? (await host.gameChat(binding.project));
  if (!request.asked && host.grants.live(threadId)) return refused(EngineAssistRefusal.InAssist);
  const asked = { ...binding, threadId };
  const card: AssistCard = { kind: AssistCardKind.Task, pluginId, pluginName: plugin.name, task };
  if (!plugin.bundled && !(await host.ask(card, asked, signal))) return refused(EngineAssistRefusal.Declined);
  if (!host.computerControlOn()) {
    if (!(await host.ask({ kind: AssistCardKind.ComputerSetting }, asked, signal)))
      return refused(EngineAssistRefusal.Declined);
    await host.turnOnComputerControl();
  }
  // macOS's own grants come next, while the person is here: the turn then starts able to click.
  if (!(await host.grantsReady(signal))) return refused(EngineAssistRefusal.Declined);
  const messageId = host.messageId();
  host.grants.record(threadId, { pluginId, apps: plugin.apps, messageId, asked: request.asked });
  try {
    await host.post(threadId, binding.project, MESSAGE.asks(plugin.name, task), messageId);
  } catch (error) {
    host.grants.turnEnded(threadId, messageId);
    throw error;
  }
  return { started: true };
}

/** The consent card each assist card is asked on: whose it is, its tool and what it asks. */
function consentOf(card: AssistCard) {
  const parameters = { type: "object" as const, properties: {} };
  if (card.kind === AssistCardKind.ComputerSetting)
    return {
      source: StudioConsentSource.ComputerSetting,
      tool: {
        name: "computer-control",
        description: MESSAGE.settingDescription,
        confirmation: MESSAGE.setting(),
        parameters,
      },
      args: {},
      note: MESSAGE.settingNote(),
    };
  return {
    source: card.pluginId,
    tool: {
      name: "do-it-for-me",
      description: MESSAGE.taskDescription,
      confirmation: MESSAGE.task(),
      parameters,
    },
    args: { task: card.task },
    note: MESSAGE.taskNote(card.pluginName, card.task),
  };
}

/** The provider choice a chat remembers from its last message. */
type ChatChoiceMeta = { lastEngine?: string; lastModel?: string; lastEffort?: string } | undefined;

/**
 * The model the task's turn runs on: the one the chat last used, or the first ready subscription
 * for a chat that has used none. A message sent without one would run on the local model.
 */
async function chatChoice(
  core: StudioCore,
  threadId: string,
): Promise<Pick<ComposerSendOptions, "engine" | "model" | "effort">> {
  const record = await core.store.getRecord(threadId).catch(() => null);
  const meta = record?.metadata as ChatChoiceMeta;
  if (!meta?.lastEngine) return { engine: await core.defaultDelegatedEngine() };
  return {
    engine: meta.lastEngine,
    ...(meta.lastModel ? { model: meta.lastModel } : {}),
    ...(meta.lastEffort ? { effort: meta.lastEffort } : {}),
  };
}

/** The real host: the core's plugins, settings, consent cards and chat. */
export function coreAssistHost(core: StudioCore): AssistHost {
  return {
    plugin: (id) => {
      const found = core.plugins.list().find((p) => p.manifest.id === id && p.enabled && !p.removed);
      if (!found) return null;
      const apps = engineAppIds(found.manifest.engine?.apps);
      return { name: found.manifest.name, bundled: found.source === PluginSourceKind.Bundled, apps };
    },
    desktopAvailable: async () => {
      const desktop = core.options.desktop;
      return desktop ? desktop.available() : false;
    },
    grantsReady: async (signal) => {
      const desktop = core.options.desktop;
      return desktop ? desktop.grantsReady(signal) : false;
    },
    computerControlOn: () => core.settings.computerControl,
    turnOnComputerControl: async () => {
      await core.updateSettings({ computerControl: true });
    },
    gameChat: (project) => core.threadForGame(project),
    ask: async (card, binding, signal) => {
      const { source, tool, args, note } = consentOf(card);
      const answer = await core.requestConsent(source, tool, args, binding, signal, undefined, { afresh: true, note });
      return answer.approved;
    },
    post: async (threadId, project, text, messageId) => {
      const choice = await chatChoice(core, threadId);
      await core.sendUserMessage(text, { thread: threadId, project, clientId: messageId, ...choice });
    },
    grants: assistGrants(core),
    messageId: () => `msg_${shortId("assist")}`,
  };
}
