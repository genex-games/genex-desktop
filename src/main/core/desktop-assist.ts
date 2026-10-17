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
 * - **Apps.** The turn may drive only the Mac apps the plugin's `engine.apps` declares; a call
 *   cannot widen them. Only the turn that answers the task holds the grant (never another turn of
 *   the chat running beside it), until it ends and never past {@link ASSIST_GRANT_MAX_MS}.
 * - **Where it can't run.** Windows, or a Mac with no desktop driver: `unavailable`, and the
 *   plugin shows its click path instead.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  COMPUTER_SETTING_QUESTION,
  type EngineAssistAnswer,
  EngineAssistRefusal,
  type PluginBinding,
  type PluginInfo,
  PluginSourceKind,
  StudioConsentSource,
} from "../../shared/plugins.ts";
import { shortId } from "../../substrate/ids.ts";
import type { StudioCore } from "../studio-core.ts";

/** The longest an assist's grant lasts when the host cannot see its turn end (a resumed turn, the harness's own loop). */
export const ASSIST_GRANT_MAX_MS = 20 * MINUTE_MS;

/** What the person reads: the task's card, the setting's card, and the turn's message. */
const MESSAGE = {
  task: (plugin: string, task: string) =>
    `Let this chat's agent do this for you with computer control? ${plugin} asks: ${task}`,
  taskDescription: "a setup step done with computer control",
  setting: COMPUTER_SETTING_QUESTION,
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
  /** Mac bundle ids, from the plugin's `engine.apps.mac`. */
  apps: ReadonlySet<string>;
  /** The queue id of the message that asks for the task. */
  messageId: string;
}

/** A grant as it is held: when it was given, and the turn its message was steered into, if any. */
interface HeldGrant extends AssistGrant {
  at: number;
  into: string | null;
}

/**
 * The chats' live assist grants, one per chat. A grant ends when the turn answering its message
 * ends: the turn that message started, or the running turn it was steered into. It never outlasts
 * {@link ASSIST_GRANT_MAX_MS}, for the turns the host cannot follow.
 */
export class AssistGrants {
  readonly #now: () => number;
  readonly #held = new Map<string, HeldGrant>();
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** Give a chat a grant for the turn that answers `messageId`; it replaces any it held. */
  record(threadId: string, grant: { pluginId: string; apps: readonly string[]; messageId: string }): void {
    const { pluginId, apps, messageId } = grant;
    this.#held.set(threadId, { pluginId, apps: new Set(apps), messageId, at: this.#now(), into: null });
  }
  /** The chat's grant while it lasts; null when it has none. */
  live(threadId: string): AssistGrant | null {
    const held = this.#held.get(threadId);
    if (!held) return null;
    if (this.#now() - held.at >= ASSIST_GRANT_MAX_MS) {
      this.#held.delete(threadId);
      return null;
    }
    return { pluginId: held.pluginId, apps: held.apps, messageId: held.messageId };
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
    if (held?.messageId === messageId) held.into = into;
  }
  /** A turn of the chat ended: the grant ends with it when that turn answered its message. */
  turnEnded(threadId: string, turn: string): void {
    const held = this.#held.get(threadId);
    if (held && (held.messageId === turn || held.into === turn)) this.#held.delete(threadId);
  }
}

/** Each core's assist grants. */
const GRANTS = new WeakMap<object, AssistGrants>();

/** The core's assist grants, made on first use. */
export function assistGrants(core: object): AssistGrants {
  const known = GRANTS.get(core);
  if (known) return known;
  const made = new AssistGrants();
  GRANTS.set(core, made);
  return made;
}

/** What the engine-app guard reads of a plugin: whether it is live, and its engine declaration. */
type EnginePlugin = Pick<PluginInfo, "enabled" | "removed"> & { manifest: Pick<PluginInfo["manifest"], "engine"> };

const livePlugins = (plugins: readonly EnginePlugin[]) => plugins.filter((plugin) => plugin.enabled && !plugin.removed);

/** The Mac bundle ids of the editors every enabled engine plugin declares: the guard's refusals outside an assist. */
export function declaredEngineApps(plugins: readonly EnginePlugin[]): ReadonlySet<string> {
  return new Set(livePlugins(plugins).flatMap((plugin) => plugin.manifest.engine?.apps?.mac ?? []));
}

/** The Mac bundle ids of the apps every enabled engine's games are played in: refused always, an assist included. */
export function declaredPlayerApps(plugins: readonly EnginePlugin[]): ReadonlySet<string> {
  return new Set(livePlugins(plugins).flatMap((plugin) => plugin.manifest.engine?.playerApps?.mac ?? []));
}

/** What an assist needs of the host. */
export interface AssistHost {
  /** The enabled plugin: its name, whether it came with Genex, and the Mac apps its engine declares. */
  plugin(id: string): { name: string; bundled: boolean; apps: readonly string[] } | null;
  /** Whether computer control can run here: a desktop and its driver (never on Windows). */
  desktopAvailable(): Promise<boolean>;
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
  const messageId = host.messageId();
  host.grants.record(threadId, { pluginId, apps: plugin.apps, messageId });
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
        confirmation: MESSAGE.setting,
        parameters,
      },
      args: {},
    };
  return {
    source: card.pluginId,
    tool: {
      name: "do-it-for-me",
      description: MESSAGE.taskDescription,
      confirmation: MESSAGE.task(card.pluginName, card.task),
      parameters,
    },
    args: { task: card.task },
  };
}

/** The real host: the core's plugins, settings, consent cards and chat. */
export function coreAssistHost(core: StudioCore): AssistHost {
  return {
    plugin: (id) => {
      const found = core.plugins.list().find((p) => p.manifest.id === id && p.enabled && !p.removed);
      if (!found) return null;
      const apps = found.manifest.engine?.apps?.mac ?? [];
      return { name: found.manifest.name, bundled: found.source === PluginSourceKind.Bundled, apps };
    },
    desktopAvailable: async () => {
      const desktop = core.options.desktop;
      return desktop ? desktop.available() : false;
    },
    computerControlOn: () => core.settings.computerControl,
    turnOnComputerControl: async () => {
      await core.updateSettings({ computerControl: true });
    },
    gameChat: (project) => core.threadForGame(project),
    ask: async (card, binding, signal) => {
      const { source, tool, args } = consentOf(card);
      const answer = await core.requestConsent(source, tool, args, binding, signal, undefined, { afresh: true });
      return answer.approved;
    },
    post: (threadId, project, text, messageId) =>
      core.sendUserMessage(text, { thread: threadId, project, clientId: messageId }),
    grants: assistGrants(core),
    messageId: () => `msg_${shortId("assist")}`,
  };
}
