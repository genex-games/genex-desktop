/**
 * One chat = one folder + one contractor session (the Cursor/Codex shape).
 *
 * Follow-ups, including "keep going", continue THAT conversation. The contractor is never
 * re-briefed from the last line alone, and a chat never guesses a different game folder.
 */
import { launchRules, RESUME_LOOP_CHAT, type LaunchGrant } from "./launch-prompts.ts";
import { GameEngine } from "./game-engine.ts";
import { handoverSection } from "./session-compact-prompts.ts";
import { toolCall } from "./model-roles.ts";
import { EventKind, InterviewMode, RunEvent } from "./run-events.ts";
import { engineChoiceRule, unrealRules, unrealWorkHere, unrealWorkspaceRule } from "./unreal-prompts.ts";
import type { UnrealOnComputer } from "./unreal/editor-wait.ts";
import { TRANSCRIPT_CHARS, TRANSCRIPT_MESSAGES } from "./brief-window.ts";
import {
  CoreFact,
  type FactRef,
  FolderHolds,
  factsOfEngine,
  hasFact,
  kindPending,
  kindUnknown,
  servedAsWeb,
} from "./folder-facts.ts";
import {
  appIdentity,
  factPrefix,
  ownKindRules,
  pendingKindRule,
  UNREAL_KIND,
  unknownKindRules,
  unrealWithoutPlugin,
} from "./project-prompts.ts";
import { WORKERS_BRIEF_LINE } from "./workers/prompts.ts";
import type { AnyRecord } from "../types/harness.d.ts";
import type { PluginKindOffer } from "../types/host-api.d.ts";

/** How many content words of the ask a folder name keeps. */
const NAME_WORDS = 3;
/** How much of the original ask a contractor's brief quotes. */
const ORIGINAL_ASK_CHARS = 4_000;
/** A game's shape as a brief reads it: its page, its entry module and its build. */
export interface BriefShape {
  entry?: string;
  main?: string;
  build?: string | null;
}

/** A message as a brief quotes it. */
export interface BriefMessage {
  role?: string;
  content?: string;
}

/** "Keep going" / "continue" — resume the same dialogue, don't start a new unattended Loop. */
export function isContinueAsk(text: unknown): boolean {
  const ask = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!ask) return false;
  if (/^(continue|resume|go on)\b/.test(ask)) return true;
  return /\bk+e+p\s+going\b/.test(ask);
}

/**
 * The workspace this chat is allowed to touch. Never the preview, never "the newest game" —
 * those are how a follow-up quietly landed in a sibling folder.
 * Returns null when this turn should scaffold a fresh folder.
 */
export function resolveChatProject(
  options: { newProject?: boolean; project?: string | null } | null | undefined,
  games: unknown,
): string | null {
  if (options?.newProject === true) return null;
  const name = options?.project;
  const known = Array.isArray(games) && games.some((game) => game.name === name);
  if (name && known) return name;
  return null;
}

// Filler that says nothing about the game — a polite ask must not become the project's name
// ("Could you please make a game where I am a seller…" once named a project
// `could-you-please-make`). The name comes from the CONTENT words.
const NAME_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "so",
  "well",
  "just",
  "like",
  "such",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "is",
  "are",
  "be",
  "was",
  "were",
  "in",
  "on",
  "of",
  "for",
  "with",
  "to",
  "at",
  "as",
  "by",
  "from",
  "into",
  "inside",
  "about",
  "there",
  "i",
  "im",
  "me",
  "my",
  "we",
  "our",
  "you",
  "u",
  "your",
  "he",
  "she",
  "they",
  "can",
  "could",
  "would",
  "should",
  "will",
  "want",
  "need",
  "let",
  "lets",
  "please",
  "make",
  "makes",
  "build",
  "builds",
  "create",
  "creates",
  "add",
  "do",
  "does",
  "game",
  "games",
  "play",
  "player",
  "where",
  "when",
  "what",
  "how",
  "am",
  "kind",
  "kinda",
  "some",
  "any",
  "really",
  "very",
  "new",
  "general",
  "come",
  "comes",
  "sell",
  "sellers",
]);

/** The folder name an ask with no words at all gets. */
const FALLBACK_NAME = "game";

/** A short folder name from the ask's content words — never from its politeness. */
export function nameFromAsk(ask: string): string {
  // A bare dash is punctuation, not a word, and a folder name cannot begin or end with a
  // hyphen — "make me - a racing thing please" once became `--racing-thing` and the scaffold
  // threw out of the whole turn.
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^-+$/.test(w));
  const content = words.filter((w) => !NAME_STOPWORDS.has(w));
  const slug = (content.length > 0 ? content : words)
    .slice(0, NAME_WORDS)
    .join("-")
    .replace(/^-+|-+$/g, "");
  return slug || FALLBACK_NAME;
}

/** First real user ask in this chat — not "keep going", not empty. */
export function originalAsk(messages: readonly BriefMessage[] | undefined): string {
  for (const message of messages ?? []) {
    if (message?.role !== "user") continue;
    const text = String(message.content ?? "").trim();
    if (!text || isContinueAsk(text)) continue;
    return text;
  }
  return "";
}

/**
 * The contractor session this chat already has, walking the log newest-last.
 * `contractor_session` is the durable bookmark, and the chat's own delegations always write it;
 * `delegation_incomplete` and a mirrored init event are fallbacks for chats that started before
 * the bookmark existed. A later one of those never outranks a bookmark: a coordinator, worker or
 * reviewer that ran in this thread leaves them too, and its session is not the chat's.
 */
export function lastContractorSession(
  events: readonly AnyRecord[] | undefined,
  engine?: string,
): ContractorSession | null {
  let bookmarked: ContractorSession | null = null;
  let fallback: ContractorSession | null = null;
  for (const event of events ?? []) {
    const data = event?.data ?? event;
    if (data?.type !== EventKind.Custom) continue;
    const session = sessionIn(data.event_type, data.payload ?? {}, engine);
    if (!session) continue;
    if (data.event_type === RunEvent.ContractorSession) bookmarked = session;
    else fallback = session;
  }
  return bookmarked ?? fallback;
}

/** A contractor session one chat can resume: its id, the engine that owns it, and its folder. */
interface ContractorSession {
  sessionId: string;
  engine: string;
  project?: string;
}

/** The session one custom event names for `engine` (any engine when none is asked for), if any. */
function sessionIn(type: unknown, payload: AnyRecord, engine: string | undefined): ContractorSession | null {
  if (type === RunEvent.ContractorSession) {
    const matches = !engine || payload.engine === engine;
    if (!payload.sessionId || !matches) return null;
    return { sessionId: payload.sessionId, engine: payload.engine, project: payload.project };
  }
  if (type === RunEvent.DelegationIncomplete) {
    const matches = !engine || !payload.engine || payload.engine === engine;
    if (!payload.sessionId || !matches) return null;
    return { sessionId: payload.sessionId, engine: payload.engine ?? engine, project: payload.project };
  }
  if (typeof type === "string" && type.startsWith(DELEGATED_PREFIX)) return mirroredInit(type, payload, engine);
  return null;
}

/** The prefix of a delegated session's mirrored events (`delegated.<engine>`). */
const DELEGATED_PREFIX = "delegated.";

/** A delegated session's mirrored `init` event: the session the engine opened. */
function mirroredInit(type: string, payload: AnyRecord, engine: string | undefined): ContractorSession | null {
  const inner = payload.data ?? {};
  const sessionId = inner.session_id ?? inner.sessionId;
  const isInit = payload.kind === "system" && inner.subtype === "init";
  if (!isInit || !sessionId) return null;
  const fromType = type.slice(DELEGATED_PREFIX.length);
  if (engine && fromType !== engine) return null;
  return { sessionId, engine: fromType, project: payload.project };
}

export function isResumeFailure(err: any): boolean {
  const text = String(err?.message ?? err ?? "");
  if (/oauth|sign in|authenticat|needs_login/i.test(text)) return false;
  return /resume|session.*(not found|expired|invalid|unknown)|no conversation|conversation not found/i.test(text);
}

/**
 * The rule that describes the game itself. The studio's own template is an empty project with
 * no build, no package manager and no network, and this sentence says so. A folder the user
 * brought is none of those things — see `ownShapeRules` — and telling its contractor otherwise
 * would have it move a real game's DOM UI into a HUD it never had.
 */
const TEMPLATE_RULE =
  "When you build, follow CLAUDE.md in the workspace root: keep window.__studio (seed/start/pause/step/state/debugCamera) working, keep gameplay deterministic (rng from reset(seed), never Math.random), assets come from procedural code, imports, or the currently enabled plugin tools. Follow the selected tool’s returned file paths and verification guidance.";

/**
 * …and the same rule for a game that came with its own shape: what it already is stays, the
 * contract is installed into its own entry, and its build is run before the turn ends. The
 * wording mirrors the run's own briefs (facet-loop.ts `facetPrompt`) so a chat build and a
 * run's builder are told the same thing about the same folder.
 */
function ownShapeRules(shape: BriefShape | null | undefined, contractMissing = false): string[] {
  const main = shape?.main ?? "src/main.js";
  const entry = shape?.entry ?? "index.html";
  const build = shape?.build ?? null;
  return [
    // The game cannot be judged, checked or compared until its page loads the contract, and a
    // chat build is the fastest way somebody gets that done (M2.6): the run's own first step
    // is the same job in the same words (director.ts `contractBrief`). Said first, because a
    // turn that spends itself on the ask and never wires it leaves the folder unjudgeable.
    ...(contractMissing
      ? [
          `FIRST, BEFORE THE ASK: nothing on this game's page installs the studio contract and the studio could not attach to it on its own, so nothing here can be looked at, checked or compared — not by you, not by a build's judges. Two lines fix it, in ${main} (or a module it imports): \`import { installStudio } from "./studio.js"\` — the contract module the studio keeps in src/, types in src/studio.d.ts beside it — and \`installStudio({ renderer, player })\` with this game's real renderer and a player() locator, once the renderer exists. That is the whole ask: the studio's own code is already on the page and finds the scene, the camera and the frames from what the game draws. Change nothing else about the game while you do it${build ? `, and run \`${build}\` afterwards` : ""}. Then do what was asked.`,
        ]
      : []),
    `This game came with its own shape — the studio did not write it. Its entry is ${main}${build ? `, it is built with \`${build}\`` : " and it runs as written"} and the studio serves ${entry}. Follow CLAUDE.md in the workspace root. Keep its structure, its screen and its input handling as they are: its UI is its own (no __studio.hud overlays, no second input path), and whatever it already loads at run time keeps loading. Keep window.__studio working: the studio attaches its own code to every page it serves, and the two lines that make the attachment exact are \`import { installStudio } from "./studio.js"\` and \`installStudio({ renderer, player })\` in ${main}. Do not remove them, and do not replace this game's randomness or its clock with the template's — this is the user's own code, not the studio's scaffold.`,
    ...(build
      ? [
          `Run \`${build}\` before you finish and fix what it reports: the studio runs the same build before every preview, so a build that fails is a black screen for the user. If the compiler rejects ./studio.js, use the types in src/studio.d.ts beside it — never drop the import.`,
        ]
      : []),
  ];
}

/**
 * How the chat talks, ahead of every rule about building: the user reads every word. A "Hello" in
 * a new game once came back as seven tool steps and a report on the workspace, its renderer and
 * the studio's inspection hooks.
 */
const CONVERSATION_RULE =
  "Talk with the user like a person. A greeting, thanks or small talk gets a short, friendly reply and no tools; when they have not said what to make or change yet, ask them. Talk about their game, never about the workspace, files, hooks, the renderer, panels or the studio's own machinery.";

/** The fence a command for the user to run goes in: the chat offers Run under a one-line block of it. */
const USER_COMMAND_FENCE = "bash";

/** Where a web game's work happens: this workspace, and no other copy or game. */
const WORKSPACE_RULE =
  "The game's work happens in this workspace: never in another copy of this game or in another game's folder, and a path the user named is a stills folder to look at, not a parent to walk. When the user asks about something elsewhere on their Mac (another folder, their Downloads, their disk), that is the ask: what you may reach is your session's permissions, not this brief.";

/**
 * What a brief knows about the game: what its folder holds (`facts`; `[]`: none, and then `holds`
 * says whether that is no kind yet), the Unreal project file it is linked to, and whether the Unreal
 * plugin is off. `legacy`: the caller named the engine, not the facts (a kept older caller), and the
 * facts stand for that engine.
 */
interface GameBuild {
  gameEngine: GameEngine;
  facts: FactRef[];
  /** With no facts, what the folder holds (`game.list`'s `holds`); null: not said, read as nothing. */
  holds: FolderHolds | null;
  engineProject: string | null;
  /** Where an Unreal project found in the folder (not linked) is; undefined when linked or unknown. */
  unrealFound: string | undefined;
  pluginsOff: boolean;
  legacy: boolean;
}

/** A web game's folder as a brief reads it: brought by the user in its own shape, and whether its page lacks the contract. */
interface FolderShape {
  ownShape: boolean;
  shape: BriefShape | null;
  contractMissing: boolean;
}

/** The game as a brief reads it, from the facts when the caller has them and from its engine when not. */
function gameBuild(
  facts: readonly FactRef[] | null | undefined,
  {
    gameEngine,
    engineProject,
    pluginsOff,
    holds,
  }: { gameEngine: GameEngine; engineProject: string | null; pluginsOff: boolean; holds: FolderHolds | null },
): GameBuild {
  const legacy = !Array.isArray(facts);
  const known = legacy ? factsOfEngine(gameEngine) : facts.map(({ id, path }) => ({ id, path }));
  const unreal = known.find((fact) => fact.id === CoreFact.UnrealProject);
  const unrealFound = legacy || engineProject ? undefined : unreal?.path;
  return { gameEngine, facts: known, holds, engineProject, unrealFound, pluginsOff, legacy };
}

/** The game is worked on in its Unreal project, through the Unreal tools: it holds one, is no web game at its root, and the plugin is on. */
const inUnreal = (game: GameBuild) =>
  !servedAsWeb(game) && hasFact(game.facts, CoreFact.UnrealProject) && !game.pluginsOff;

/** The rules of one kind the folder holds: the web template's or the game's own shape, Unreal's, or a line for any other. */
function rulesOfFact(engine: string | undefined, fact: FactRef, game: GameBuild, folder: FolderShape): string[] {
  if (fact.id === CoreFact.WebGame)
    return folder.ownShape ? ownShapeRules(folder.shape, folder.contractMissing) : [TEMPLATE_RULE];
  if (fact.id !== CoreFact.UnrealProject) return ownKindRules(engine, fact);
  if (game.pluginsOff) return unrealWithoutPlugin(engine);
  const found = game.unrealFound;
  return unrealRules(engine, game.engineProject, { found, ownFiles: found !== undefined });
}

/**
 * The rules that describe the game itself, one block per kind the folder holds, each named by its
 * folder when there are several. A folder with no kind yet is told how its request picks one
 * (`offered`: the kinds engine plugins on offer make; `asked`: the question card offers them), then
 * the web template's rule its web answer builds on; one of a kind Genex can't name is looked through first.
 */
function factRules(
  engine: string | undefined,
  game: GameBuild,
  folder: FolderShape,
  { offered, asked, unreal }: { offered: readonly PluginKindOffer[]; asked: boolean; unreal: UnrealOnComputer | null },
): string[] {
  if (kindUnknown(game)) return unknownKindRules(engine, game.holds);
  if (kindPending(game)) return [...pendingKindRule(engine, offered, unreal, game.holds, asked), TEMPLATE_RULE];
  const several = game.facts.length > 1;
  return game.facts.flatMap((fact) => {
    const rules = rulesOfFact(engine, fact, game, folder);
    const prefix = several ? factPrefix(fact) : "";
    return rules.map((rule) => `${prefix}${rule}`);
  });
}

/**
 * The rules every chat build follows after the game's own, in the voice of the engine that reads
 * them: a tool is named once, spelled the way this session can actually call it (M4.8b).
 */
function contractorRules(engine: string | undefined, game: GameBuild): string[] {
  const unrealWork = !servedAsWeb(game) && hasFact(game.facts, CoreFact.UnrealProject);
  return [
    "Helper scripts of your own (an inspector, a syntax check, a probe) go under .studio/ (gitignored); source scripts for generated assets live under assets/src/.",
    "Before you build or change how the game looks, if the folder has a references/ or ref/ directory with stills, look at those pictures — they are the visual bar, not files to load as textures.",
    unrealWork ? unrealWorkspaceRule(game.engineProject, game.unrealFound) : WORKSPACE_RULE,
    "When your shell is sandboxed, it rejects commands it cannot statically analyze — avoid $-expansions, escaped whitespace, heredocs and long && chains; run one simple command at a time, and put multi-step logic in a script file you then run with node.",
    `When a sandbox blocks a step only the user's own Mac can do (an install or download that needs the network, such as brew or pip, a system tool, a sign-in), do not work around it: end your reply with that one command on a single line in a \`\`\`${USER_COMMAND_FENCE} block and one plain sentence on why. The chat shows it with a Run button; how it went comes back as the user's next message. Never offer a command you can run yourself, sudo, or anything piped into a shell.`,
    // The Reload a checkpoint lights is the web preview's: any other kind is seen in its own app.
    ...(servedAsWeb(game)
      ? [
          `The moment the game first runs end-to-end, and after each substantial feature lands, call ${toolCall(engine, "checkpoint")} with a one-line note — the studio lights the user's Reload with your note, so they see your progress when they press it.`,
        ]
      : []),
    "Keep NOTES.md in the workspace root current as you build — the game's pitch (what the user asked for, in their words: not a wish list), the key decisions so far and why, and its current state (features, known issues). Update it when something lands, not only at the end. A newcomer should understand the game from NOTES.md alone.",
  ];
}

function stillsBlock(extraReads: unknown): string {
  if (!Array.isArray(extraReads) || extraReads.length === 0) return "";
  return [
    "Stills the user named — read these paths directly; do not walk their parent folders:",
    ...extraReads.map((dir) => `- ${dir}`),
  ].join("\n");
}

/**
 * This brief tells the chat's own session after a lead's run that the build is over
 * (`afterLoopRun`): chat-dispatch.ts asks before it sends the chat there (after-loop-run.ts
 * `servesAfterLoopRun`), since a kept copy from before would tell it to pick up where it left off.
 */
export const SERVES_AFTER_LOOP_RUN = true;

/** How a resumed build is told to go on; a Loop chat reads the message instead (`RESUME_LOOP_CHAT`). */
const RESUME_BUILD =
  "You are resuming your own session in this workspace — your context is restored. Pick up exactly where you left off and finish the remaining work.";

/**
 * What the contractor is actually told. Resume = short pickup (its own context is restored).
 * No session = the chat's original ask plus the latest instruction, so "keep going" cannot
 * become a blank new job. `launch` = Loop is on: the chat may also start a build
 * (launch-prompts.ts), and still answers, researches and edits itself. `afterLoopRun` = the build
 * this chat's session led is over (after-loop-run-prompts.ts): its note replaces the pickup of a
 * resumed session, and follows the rules of a fresh one.
 *
 * @param {{
 *   ask?: string,
 *   messages?: Array<{ role?: string, content?: string }>,
 *   resume?: boolean,
 *   extraReads?: string[],
 *   folderLabel?: string,
 *   scaffolded?: boolean,
 *   shape?: { entry?: string, main?: string, build?: string | null } | null,
 *   ownShape?: boolean,
 *   contractMissing?: boolean,
 *   engine?: string,
 *   gameEngine?: GameEngine,
 *   engineProject?: string | null,
 *   launch?: LaunchGrant | null,
 *   afterLoopRun?: string | null,
 *   engineChoice?: boolean,
 *   unrealEngine?: UnrealOnComputer | null,
 *   compacted?: string | null,
 *   fresh?: boolean,
 *   facts?: FactRef[] | null,
 *   kinds?: PluginKindOffer[],
 *   pluginsOff?: boolean,
 *   holds?: FolderHolds | null,
 *   workers?: boolean,
 * }} [opts]
 */
export function buildContractorBrief({
  ask,
  messages = [],
  resume = false,
  extraReads = [],
  folderLabel = "",
  scaffolded = false,
  shape = null,
  ownShape = false,
  contractMissing = false,
  /** Which engine reads this: the one thing in the brief that is spelled per engine. */
  engine = undefined,
  /** Which engine the GAME builds in (game-engine.ts `engineOfGame`): an Unreal game is no web page. */
  gameEngine = GameEngine.Web,
  /** The Unreal project file an Unreal game is linked to, which its work lands in. */
  engineProject = null,
  /** Loop is on: this chat may also launch a build. */
  launch = null,
  /** The build this chat's session led is over: what it is told of it (after-loop-run-prompts.ts). */
  afterLoopRun = null,
  /** A new game while the Unreal plugin is on: the user picks the web or Unreal first (unreal-prompts.ts). */
  engineChoice = false,
  /** What this computer has of Unreal, for the engine question's Unreal option (unreal/editor-wait.ts); null: unknown. */
  unrealEngine = null,
  /** The handover the session before this one wrote when the chat was compacted (session-compact.ts). */
  compacted = null,
  /** Nothing has been made in this game yet: the studio's template, as it was made. */
  fresh = false,
  /** What the game's folder holds (`game.list`'s `facts`; `[]`: no kind yet). Absent: read from `gameEngine`. */
  facts = null,
  /** The kinds the question card offers a folder with no kind yet (`plugins.tools`'s `kinds`). */
  kinds = [],
  /** The folder holds an Unreal project and the Unreal plugin is off: no Unreal tools reach it. */
  pluginsOff = false,
  /** With no facts, what the folder holds (`game.list`'s `holds`): nothing or notes (no kind yet), or files of its own. */
  holds = null,
  /** This turn's session may start workers (workers/chat-workers.ts): its brief says so in one line. */
  workers = false,
}: {
  ask?: string;
  messages?: readonly BriefMessage[];
  resume?: boolean;
  extraReads?: unknown;
  folderLabel?: string;
  scaffolded?: boolean;
  shape?: BriefShape | null;
  ownShape?: boolean;
  contractMissing?: boolean;
  engine?: string;
  gameEngine?: GameEngine;
  engineProject?: string | null;
  launch?: LaunchGrant | null;
  afterLoopRun?: string | null;
  engineChoice?: boolean;
  unrealEngine?: UnrealOnComputer | null;
  compacted?: string | null;
  fresh?: boolean;
  facts?: readonly FactRef[] | null;
  kinds?: readonly PluginKindOffer[];
  pluginsOff?: boolean;
  holds?: FolderHolds | null;
  workers?: boolean;
} = {}): string {
  const game = gameBuild(facts, { gameEngine, engineProject, pluginsOff, holds });
  const identity = appIdentity({ folderLabel, facts: game.facts, holds: game.holds });
  const workHere = workHereLine(game, folderLabel);
  const stills = stillsBlock(extraReads);
  const launchBlock = launch?.toolName ? launchRules(engine, launch, gameEngine) : [];
  const workersLine = workers ? WORKERS_BRIEF_LINE : "";

  if (resume)
    return [ask, "", identity, resumePickup(afterLoopRun, launch), ...launchBlock, workersLine, workHere, stills]
      .filter(Boolean)
      .join("\n");

  // The rules a build follows depend on whose game this is — every run brief already carries
  // the shape (autopilot.ts, director.ts, facet-loop.ts); a chat build used to carry none.
  // A folder with no kind yet hears of the kinds on offer on every message; the card only when bridged.
  const choice = {
    offered: engineChoice ? offeredKinds(kinds) : kinds,
    asked: engineChoice,
    unreal: unrealEngine,
  };
  const rules = [
    ...engineQuestion(engine, game, engineChoice, unrealEngine),
    ...factRules(engine, game, { ownShape, shape, contractMissing }, choice),
    ...contractorRules(engine, game),
  ];
  const { head, followUp } = briefHead(ask, messages, {
    compacted,
    fresh: fresh || scaffolded,
    pending: !game.legacy && kindPending(game),
    notes: game.holds === FolderHolds.Notes,
  });

  const recent = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-TRANSCRIPT_MESSAGES)
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n")
    .slice(-TRANSCRIPT_CHARS);
  return [
    ...head,
    identity,
    ...(compacted ? [`\n${handoverSection(compacted)}`] : []),
    ...(followUp && recent ? [`\nRecent conversation (retain decisions and completed work):\n${recent}`] : []),
    "",
    CONVERSATION_RULE,
    ...rules,
    ...launchBlock,
    ...(afterLoopRun ? [afterLoopRun] : []),
    workersLine,
    workHere,
    stills,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The kinds the question card offers: the host's, or the Unreal plugin's alone when it lists none. */
function offeredKinds(kinds: readonly PluginKindOffer[]): readonly PluginKindOffer[] {
  return kinds.length > 0 ? kinds : [UNREAL_KIND];
}

/**
 * The engine question, first, for a new web game of a caller that names the engine and not the
 * facts; nothing otherwise (a folder with no kind yet is asked by its facts' rules).
 */
function engineQuestion(
  engine: string | undefined,
  game: GameBuild,
  engineChoice: boolean,
  unreal: UnrealOnComputer | null,
): string[] {
  const asks = engineChoice && game.legacy && game.gameEngine === GameEngine.Web;
  return asks ? [engineChoiceRule(engine, unreal)] : [];
}

/**
 * Where the game's work goes, never what else the session may reach: that is its permissions'.
 * An Unreal game's lands in its project, and a resumed session is told so too.
 */
function workHereLine(game: GameBuild, folderLabel: string): string {
  if (inUnreal(game)) return unrealWorkHere(game.engineProject, folderLabel, game.unrealFound);
  return folderLabel
    ? `The game's work stays in this workspace (folder \`${folderLabel}\`).`
    : "The game's work stays in this workspace.";
}

/**
 * A fresh brief's opening: for a follow-up, the same chat's original request and its latest
 * instruction; else the ask and where the game stands. After a compaction the first kept
 * message is not the original request (the handover says it), so only the latest is quoted.
 * A game nothing has been made in is a blank page: "continue from the existing code" would send
 * a "Hello" off to inspect an empty template.
 */
function briefHead(
  ask: string | undefined,
  messages: readonly BriefMessage[],
  start: { compacted: string | null; fresh: boolean; pending: boolean; notes: boolean },
): { head: Array<string | undefined>; followUp: boolean } {
  const { compacted } = start;
  const original = compacted ? "" : originalAsk(messages);
  const followUp = Boolean(compacted) || Boolean(original && original !== ask);
  if (!followUp) return { head: [ask, "", firstOrigin(start)], followUp };
  return {
    head: [
      "This is the same chat, not a new job. Continue from the code already in this workspace. Do not start over, and do not go looking through other projects for it.",
      "",
      original ? `Original request:\n${original.slice(0, ORIGINAL_ASK_CHARS)}` : "",
      original !== ask ? `\nLatest instruction:\n${ask}` : "",
    ],
    followUp,
  };
}

/**
 * Where a first brief's game stands: a folder with no kind yet (empty, or notes only), the studio's
 * template as made, or code to continue.
 */
function firstOrigin({ fresh, pending, notes }: { fresh: boolean; pending: boolean; notes: boolean }): string {
  if (pending && notes)
    return "This project is brand new: its folder holds notes but no game yet, so read the notes before you start.";
  if (pending) return "This project is brand new and its folder is empty: there is nothing to inspect yet.";
  if (fresh)
    return "This game is brand new: nothing has been built in it yet, so there is nothing to inspect. It starts from the studio's empty template.";
  return "Continue from the existing code in this workspace.";
}

/** How a resumed session goes on: after a run it led, that run's note; else a build's or a Loop chat's pickup. */
function resumePickup(afterLoopRun: string | null, launch: LaunchGrant | null): string {
  if (afterLoopRun) return afterLoopRun;
  return launch ? RESUME_LOOP_CHAT : RESUME_BUILD;
}

/** What the interview tells the model about the run's clock. */
function budgetLine(mode: string | undefined, hours: number | null | undefined): string {
  if (mode === InterviewMode.Loop) return `The user committed ${hours ?? "?"} hours of unattended building.`;
  if (hours) return `The run is capped at ${hours} hours.`;
  return "The run goes until the critics are satisfied (24h safety ceiling).";
}

/**
 * The write-less commission interview of harnesses before Loop chats became contractors. The
 * current turn briefs a Loop chat with `buildContractorBrief({ launch })`; this stays exported
 * because a seed upgrade keeps a `delegated-turn.ts` the in-app agent edited, and that copy
 * still imports it (`tests/fixtures/seed-exports-2e-pre.json`).
 *
 * @param {{
 *   ask?: string,
 *   messages?: Array<{ role?: string, content?: string }>,
 *   resume?: boolean,
 *   folderLabel?: string,
 *   project?: string,
 *   mode?: InterviewMode,
 *   toolName?: string,
 *   hours?: number | null,
 *   frameCount?: number,
 * }} [opts]
 */
export function buildInterviewBrief({
  ask,
  messages = [],
  resume = false,
  folderLabel = "",
  project = "",
  mode = InterviewMode.Autopilot,
  toolName = "start_autopilot",
  hours = null,
  frameCount = 0,
}: {
  ask?: string;
  messages?: readonly BriefMessage[];
  resume?: boolean;
  folderLabel?: string;
  project?: string;
  mode?: string;
  toolName?: string;
  hours?: number | null;
  frameCount?: number;
} = {}): string {
  const modeLabel = mode === InterviewMode.Autopilot ? "Autopilot" : "Loop";
  const rules = [
    `You are the studio's intake interviewer for an ${modeLabel} run — NOT the builder. Do not write or edit any game code in this session; the run you commission does the building with its own contractors.`,
    "Everything you write goes straight to the user in the studio chat — write to them, briefly and warmly.",
    "Ask AT MOST one short question per reply, and only what genuinely changes how the run is set up (what you actually do in the game, the feeling to hit). Offer a recommended answer they can just accept. Never ask more than two questions across the whole interview.",
    "Use the ask_user tool for that question so it appears in the answer panel. Supply concise choices, recommended first; the user can type another answer in the composer. Do not repeat the question or choices in prose. After ask_user, end the reply and wait for the next user message. Never call the launch tool in the same reply as ask_user. Progress updates are not questions.",
    `Reference stills, if any, are in references/ inside this folder — Read them before asking about visuals. ${frameCount > 0 ? `The user attached ${frameCount} still(s) to this commission; they reach the run's critics automatically.` : "If references/ is empty and the ask is visual, ask once for a game/film to use as the bar."}`,
    budgetLine(mode, hours),
    `When you know enough (usually after one answered question), recap the plan in one short paragraph and call the ${toolName} tool exactly once. The run launches the moment your reply ends.`,
    project
      ? `This chat is bound to the project folder "${project}" — pass exactly that as the tool's "project" argument.`
      : "",
    folderLabel ? `Stay inside this workspace (folder \`${folderLabel}\`). Do not list or read sibling folders.` : "",
  ].filter(Boolean);

  if (resume) {
    return [
      `The user replied:\n${ask}`,
      "",
      "You are resuming your own interview session — your context is restored. If this answers what you needed, recap and call the tool now; otherwise ask your one remaining question.",
      ...rules,
    ].join("\n");
  }
  const original = originalAsk(messages);
  return [
    `The user's ask:\n${(original && original !== ask ? `${original}\n\nLatest message:\n` : "") + ask}`,
    "",
    ...rules,
  ].join("\n");
}
