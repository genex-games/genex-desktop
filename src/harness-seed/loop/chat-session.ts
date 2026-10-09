/**
 * One chat = one folder + one contractor session (the Cursor/Codex shape).
 *
 * Follow-ups, including "keep going", continue THAT conversation. The contractor is never
 * re-briefed from the last line alone, and a chat never guesses a different game folder.
 */
import { launchRules, RESUME_LOOP_CHAT, type LaunchGrant } from "./launch-prompts.ts";
import { handoverSection } from "./session-compact-prompts.ts";
import { toolCall } from "./model-roles.ts";
import { EventKind, InterviewMode, RunEvent } from "./run-events.ts";
import { TRANSCRIPT_CHARS, TRANSCRIPT_MESSAGES } from "./brief-window.ts";
import type { AnyRecord } from "../types/harness.d.ts";

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

/**
 * The rules every chat build follows, in the voice of the engine that reads them: a tool is
 * named once, spelled the way this session can actually call it (M4.8b).
 */
function contractorRules(engine: string | undefined): string[] {
  return [
    TEMPLATE_RULE,
    "Helper scripts of your own (an inspector, a syntax check, a probe) go under .studio/ (gitignored); source scripts for generated assets live under assets/src/.",
    "Before you build or change how the game looks, if the folder has a references/ or ref/ directory with stills, look at those pictures — they are the visual bar, not files to load as textures.",
    "The game's work happens in this workspace: never in another copy of this game or in another game's folder, and a path the user named is a stills folder to look at, not a parent to walk. When the user asks about something elsewhere on their Mac (another folder, their Downloads, their disk), that is the ask: what you may reach is your session's permissions, not this brief.",
    "When your shell is sandboxed, it rejects commands it cannot statically analyze — avoid $-expansions, escaped whitespace, heredocs and long && chains; run one simple command at a time, and put multi-step logic in a script file you then run with node.",
    `When a sandbox blocks a step only the user's own Mac can do (an install or download that needs the network, such as brew or pip, a system tool, a sign-in), do not work around it: end your reply with that one command on a single line in a \`\`\`${USER_COMMAND_FENCE} block and one plain sentence on why. The chat shows it with a Run button; how it went comes back as the user's next message. Never offer a command you can run yourself, sudo, or anything piped into a shell.`,
    `The moment the game first runs end-to-end, and after each substantial feature lands, call ${toolCall(engine, "checkpoint")} with a one-line note — the studio lights the user's Reload with your note, so they see your progress when they press it.`,
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
 *   launch?: LaunchGrant | null,
 *   afterLoopRun?: string | null,
 *   compacted?: string | null,
 *   fresh?: boolean,
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
  /** Loop is on: this chat may also launch a build. */
  launch = null,
  /** The build this chat's session led is over: what it is told of it (after-loop-run-prompts.ts). */
  afterLoopRun = null,
  /** The handover the session before this one wrote when the chat was compacted (session-compact.ts). */
  compacted = null,
  /** Nothing has been made in this game yet: the studio's template, as it was made. */
  fresh = false,
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
  launch?: LaunchGrant | null;
  afterLoopRun?: string | null;
  compacted?: string | null;
  fresh?: boolean;
} = {}): string {
  // Where the game's work goes, never what else the session may reach: that is its permissions'.
  const workHere = folderLabel
    ? `The game's work stays in this workspace (folder \`${folderLabel}\`).`
    : "The game's work stays in this workspace.";
  const stills = stillsBlock(extraReads);
  const launchBlock = launch?.toolName ? launchRules(engine, launch) : [];

  if (resume)
    return [ask, "", resumePickup(afterLoopRun, launch), ...launchBlock, workHere, stills].filter(Boolean).join("\n");

  // The rules a build follows depend on whose game this is — every run brief already carries
  // the shape (autopilot.ts, director.ts, facet-loop.ts); a chat build used to carry none.
  const baseRules = contractorRules(engine);
  const rules = ownShape ? [...ownShapeRules(shape, contractMissing), ...baseRules.slice(1)] : baseRules;
  const { head, followUp } = briefHead(ask, messages, { compacted, fresh: fresh || scaffolded });

  const recent = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-TRANSCRIPT_MESSAGES)
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n")
    .slice(-TRANSCRIPT_CHARS);
  return [
    ...head,
    ...(compacted ? [`\n${handoverSection(compacted)}`] : []),
    ...(followUp && recent ? [`\nRecent conversation (retain decisions and completed work):\n${recent}`] : []),
    "",
    CONVERSATION_RULE,
    ...rules,
    ...launchBlock,
    ...(afterLoopRun ? [afterLoopRun] : []),
    workHere,
    stills,
  ]
    .filter((line) => line !== "")
    .join("\n");
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
  { compacted, fresh }: { compacted: string | null; fresh: boolean },
): { head: Array<string | undefined>; followUp: boolean } {
  const original = compacted ? "" : originalAsk(messages);
  const followUp = Boolean(compacted) || Boolean(original && original !== ask);
  if (!followUp) {
    const origin = fresh
      ? "This game is brand new: nothing has been built in it yet, so there is nothing to inspect. It starts from the studio's empty template."
      : "Continue from the existing code in this workspace.";
    return { head: [ask, "", origin], followUp };
  }
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
