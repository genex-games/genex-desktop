/**
 * Publishing to Roblox: a place's first publish, and its updates. No Studio or plugin API publishes a
 * place, and Open Cloud's place publishing takes API keys Genex never asks for, so the person's own
 * computer control clicks File › Publish to Roblox in their Studio: Genex hands the game's chat that
 * task through `game.engine.assist`. The person approves every publish: the panel's press, or the
 * card the manifest declares on the agent's `first-publish` and `publish-update`, which the host
 * asks before the plugin runs.
 *
 * - **First publish** (`first-publish`): a place never published (its link has no `remote` ids)
 *   becomes a new game on Roblox under the name the person approved (the Genex game's title unless
 *   they gave another), with Studio's own privacy and settings and an empty description. The task
 *   stops the turn at any age, ID, two-step, terms or payment question, which stay the person's.
 * - **Publish an update** (`publish-update`): a published place, updated.
 *
 * Where Genex can't click (no desktop driver, the person said no), the answer gives Studio's click
 * path. Afterwards Genex links the game to the published place by itself (`relink.ts`).
 */
import type {
  PluginEngineAssistAnswer,
  PluginEngineAssistRefusal,
  PluginEngineLink,
  PluginReview,
} from "../../plugin-sdk/index.d.ts";
import { PUBLISH_PROMPTS } from "./publish-prompts.ts";
import { MESSAGE, PUBLISH_CLICK_PATH } from "./words.ts";

export { PUBLISH_CLICK_PATH };

/** A place name at most this long goes into the task whole; a longer one is cut, so the task stays one short line. */
const MAX_TASK_NAME_CHARS = 60;
/** The longest name Roblox takes for a new game. */
export const MAX_GAME_NAME_CHARS = 50;
/** The last character code of the ASCII controls, and DEL. */
const LAST_CONTROL = 0x1f;
const DELETE = 0x7f;

/** Who asked to publish, which decides the answer's words. Wire values: never rename. */
export const PublishAsker = {
  /** The person pressed Publish an update or Publish to Roblox in the panel. */
  Person: "person",
  /** An agent called `publish-update` or `first-publish` and the person approved its card. */
  Agent: "agent",
} as const;
export type PublishAsker = (typeof PublishAsker)[keyof typeof PublishAsker];

/** Why nothing was handed to the chat, before the host was asked. Wire values: never rename. */
export const PublishMiss = {
  NoPlace: "no-place",
  /** Publish an update of a place never published: it needs its first publish. */
  FirstPublish: "first-publish",
  /** A first publish of a place Roblox already has: it needs an update. */
  Published: "published",
  /** An agent's first publish under a name Roblox wouldn't take as it is (empty, too long, changed). */
  Name: "name",
} as const;
export type PublishMiss = (typeof PublishMiss)[keyof typeof PublishMiss];

/** The game's place as publishing sees it: its link (ids when published), its name and the Genex game's title. */
export interface PublishPlace {
  link: PluginEngineLink | null;
  name?: string;
  title?: string;
}

/** What publishing asks of the host and of the game's helper. */
export interface PublishDeps {
  assist(task: string): Promise<PluginEngineAssistAnswer>;
  /** Sends the script files changed and not yet in Studio, so the publish holds them. */
  flush?(): Promise<void>;
  /**
   * Notes a first publish under this name once the chat has started it, so Genex links the game to
   * the published place afterwards (`relink.ts`); a refused hand-over is never noted.
   */
  noted?(name: string): Promise<void>;
}

/** A publish's answer: handed to the chat, or why not and Studio's own click path. */
export interface PublishAnswer {
  started: boolean;
  message: string;
  reason?: PublishMiss | PluginEngineAssistRefusal;
  clickPath?: string;
  /** A first publish's name on Roblox. */
  name?: string;
}

/** A name as one plain line, cut to `max` characters: control characters become spaces. */
function plainName(name: string | undefined, max = MAX_TASK_NAME_CHARS): string {
  const plain = [...(name ?? "")]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code <= LAST_CONTROL || code === DELETE ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** A game's name as Roblox takes it: one plain line of at most {@link MAX_GAME_NAME_CHARS}, no double quotes. */
const gameName = (name: string | undefined) => plainName(name?.replaceAll('"', "'"), MAX_GAME_NAME_CHARS);

/**
 * An agent's first publish under a name the card showed but Roblox wouldn't take as it is: empty,
 * longer than {@link MAX_GAME_NAME_CHARS}, or changed by making it one plain line. Never published
 * under another name than the card showed: the answer asks for a name that fits. Undefined when
 * the name fits, or the place isn't one to publish the first time.
 */
export function unfitName(place: PublishPlace, requested: string | undefined): PublishAnswer | undefined {
  if (!place.link || place.link.remote) return undefined;
  const asked = requested?.trim() ?? "";
  const fits = gameName(asked);
  if (asked && fits === asked) return undefined;
  return {
    started: false,
    message: PUBLISH_PROMPTS.NameUnfit(fits || firstPublishName(place)),
    reason: PublishMiss.Name,
  };
}

/** The name a first publish uses: the one asked for, else the Genex game's title, else the place's. */
export function firstPublishName(place: PublishPlace, requested?: string): string {
  return gameName(requested) || gameName(place.title) || gameName(place.name) || MESSAGE.Publish.DefaultName;
}

/**
 * The task the game's chat is asked, shown verbatim in the chat: the place, Studio's own clicks, and
 * where the turn stops (anything Roblox asks beyond the publish is the person's).
 */
export function publishTask(name: string | undefined): string {
  const place = plainName(name) || "this place";
  return `Publish ${place} to Roblox: ${PUBLISH_CLICK_PATH} in its Roblox Studio window, now, with the desktop tool (not publish-update). If Roblox asks for the game's details, an age check or a sign-in, stop and tell the person.`;
}

/**
 * A first publish's task, shown verbatim in the chat: a new game under `name`, Studio's own clicks
 * done by this turn itself, Studio's settings, and where the turn stops. The publish skill (which the
 * roblox-studio skill sends a publishing turn to) has the dialog's steps.
 */
export function firstPublishTask(name: string): string {
  return `Publish to Roblox as a new game named "${gameName(name)}": ${PUBLISH_CLICK_PATH} in Studio, now, with the desktop tool (not first-publish). Keep Studio's privacy and settings, the description empty. Stop at any age, ID, two-step, terms or payment question.`;
}

/** The words a publish's answers are read from, whoever asked. */
interface PublishWords {
  Started: string;
  FirstStarted(name: string): string;
  Unavailable: string;
  Declined: string;
  NoChat: string;
  NotStarted: string;
  FirstPublish(name: string): string;
  AlreadyPublished: string;
  NoPlace: string;
}

/** The person's words for each answer, in Genex's language as it is now. */
function personWords(): PublishWords {
  const W = MESSAGE.Publish;
  return {
    Started: W.Started(),
    FirstStarted: W.FirstStarted,
    Unavailable: W.Unavailable(),
    Declined: W.Declined(),
    NoChat: W.NoChat(),
    NotStarted: W.NotStarted(),
    FirstPublish: W.FirstPublish,
    AlreadyPublished: W.AlreadyPublished(),
    NoPlace: W.NoPlace(),
  };
}

/** Each asker's words for each answer: the person's, or the agent's (English). */
const wordsOf = (asker: PublishAsker): PublishWords =>
  asker === PublishAsker.Person ? personWords() : PUBLISH_PROMPTS;

/** The answers that are the same line whoever asked. */
type PlainWords = "Unavailable" | "Declined" | "NoChat" | "NotStarted";

/** The host's refusals that have words of their own; any other gets "nothing was published". */
const REFUSAL_WORDS = {
  unavailable: "Unavailable",
  declined: "Declined",
  "no-chat": "NoChat",
} as const satisfies Partial<Record<PluginEngineAssistRefusal, PlainWords>>;

const hasWords = (reason: PluginEngineAssistRefusal): reason is keyof typeof REFUSAL_WORDS => reason in REFUSAL_WORDS;

/** What the host's refusal says to whoever asked, with Studio's click path. */
function refusedAnswer(answer: PluginEngineAssistAnswer, words: PublishWords): PublishAnswer {
  const reason = answer.reason;
  const key: PlainWords = reason && hasWords(reason) ? REFUSAL_WORDS[reason] : "NotStarted";
  const refused: PublishAnswer = { started: false, message: words[key], clickPath: PUBLISH_CLICK_PATH };
  if (reason) refused.reason = reason;
  return refused;
}

/** Hands the chat a publish's task, once the game's changed script files are in Studio. */
async function handOver(deps: PublishDeps, task: string): Promise<PluginEngineAssistAnswer> {
  // Studio holds the scripts it last had when a send fails; the publish goes on with those.
  await deps.flush?.().catch(() => undefined);
  return deps.assist(task);
}

/**
 * Publish an update of the game's place: a published place's task goes to the game's chat once its
 * changed script files are in Studio; a place never published, or no place, asks the host nothing.
 */
export async function publishUpdate(
  place: PublishPlace,
  deps: PublishDeps,
  asker: PublishAsker,
): Promise<PublishAnswer> {
  const words = wordsOf(asker);
  if (!place.link) return { started: false, message: words.NoPlace, reason: PublishMiss.NoPlace };
  if (!place.link.remote)
    return { started: false, message: words.FirstPublish(firstPublishName(place)), reason: PublishMiss.FirstPublish };
  const answer = await handOver(deps, publishTask(place.name));
  return answer.started ? { started: true, message: words.Started } : refusedAnswer(answer, words);
}

/**
 * A place's first publish as a new game on Roblox, under the name asked for (else the Genex game's
 * title): its task goes to the game's chat once its changed script files are in Studio. A place
 * Roblox already has, or no place, asks the host nothing.
 */
export async function firstPublish(
  place: PublishPlace,
  deps: PublishDeps,
  asker: PublishAsker,
  requested?: string,
): Promise<PublishAnswer> {
  const words = wordsOf(asker);
  if (!place.link) return { started: false, message: words.NoPlace, reason: PublishMiss.NoPlace };
  if (place.link.remote) return { started: false, message: words.AlreadyPublished, reason: PublishMiss.Published };
  const name = firstPublishName(place, requested);
  const answer = await handOver(deps, firstPublishTask(name));
  if (!answer.started) return { ...refusedAnswer(answer, words), name };
  // Followed once the chat has it, so Genex links the place it publishes.
  await deps.noted?.(name).catch(() => undefined);
  return { started: true, message: words.FirstStarted(name), name };
}

/** The panel's card for a published place: its name and what publishing does; a first publish keeps the manifest's. */
export function reviewPublish(place: PublishPlace): PluginReview {
  if (!place.link?.remote) return {};
  const name = plainName(place.name) || plainName(place.link.name);
  const message = name ? MESSAGE.Publish.Confirm(name) : MESSAGE.Publish.ConfirmUnnamed();
  return { message, detail: MESSAGE.Publish.Plan() };
}

/** The panel's card for a first publish: the name it gets on Roblox and what happens; a published place keeps the manifest's. */
export function reviewFirstPublish(place: PublishPlace, requested?: string): PluginReview {
  if (!place.link || place.link.remote) return {};
  return {
    message: MESSAGE.Publish.ConfirmFirst(firstPublishName(place, requested)),
    detail: MESSAGE.Publish.PlanFirst(),
  };
}
