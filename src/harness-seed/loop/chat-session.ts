/**
 * One chat = one folder + one contractor session (the Cursor/Codex shape), and what that session
 * knows of Genex for its whole life: its context, said once in its system text (`chatContext`).
 * The person's words reach it as they wrote them; a chat never guesses a different game folder.
 */
import { EventKind, RunEvent } from "./run-events.ts";
import { ProjectTool } from "./folder-facts.ts";
import { askUser } from "./interview-question.ts";
import { appIdentity } from "./project-prompts.ts";
import type { AppLanguage } from "./app-language.ts";
import { languageRule } from "./language-prompts.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** How many content words of the ask a folder name keeps. */
const NAME_WORDS = 3;

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

/**
 * The contractor session this chat already has, walking the log newest-last.
 * `contractor_session` is the durable bookmark, and the chat's own delegations always write it;
 * `delegation_incomplete` and a mirrored init event are fallbacks for chats that started before
 * the bookmark existed. A later one of those never outranks a bookmark: a worker or reviewer that
 * ran in this thread leaves them too, and its session is not the chat's.
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
 * Who the person is, ahead of every fact about the game: they read every word. A "Hello" in a new
 * game once came back as seven tool steps and a report on the workspace and its inspection hooks.
 */
const TALK =
  "The person may not be a programmer: talk with them about their game, never about the workspace, files, worktrees, hooks or Genex's own machinery.";

/** The fence a command for the person to run goes in: the chat offers Run under a one-line block of it. */
const USER_COMMAND_FENCE = "bash";

/** What a one-line command block in a reply becomes in Genex's chat, and which commands earn one. */
const RUN_BUTTON = `A one-line \`\`\`${USER_COMMAND_FENCE} block in your reply shows the person a Run button: offer one only for a step your sandbox blocks that only their own computer can do (an install that needs the network, a system tool, a sign-in), never one you can run yourself, sudo, or a pipe into a shell.`;

/**
 * Whose steps are whose: the agent does every step its tools and the person's computer reach, and
 * hands the person only what is theirs alone, never a click it could make itself.
 */
const DO_IT_YOURSELF =
  "Do every step you can yourself rather than handing it to the person. When you have the desktop tool (computer control), you open and use any app on this computer, a launcher, a store, an installer and an engine's editor included, and where they are signed in already, content tied to their account (Fab, Epic's launcher, an asset store) is yours to add. Your tools start, stop and restart what the work needs. Only a password or two-step code, the system's own permission prompts, a payment, a choice about their own work, and a step in an app when you have no desktop tool are theirs: never tell them anything else is something only they can do.";

/**
 * Whose plan the work follows: the person's latest words and the stage their project is in. An
 * imported Unreal game whose HANDOFF.md said blockout and Fab picks was driven toward a shipped
 * build when the person asked to go on with the blockout and pick assets (DeathWish).
 */
const SCOPE =
  "Do what the person's latest message asks, at the stage their project is in, and nothing beyond it. A project's own notes (a HANDOFF.md, README, TODO or design doc) and the stage the person names (pre-production, a blockout, picking assets) are the plan: in a project you did not make, read them before your first change, and follow them. Build, package, publish or take the whole game to a finished version only when the person asks for that.";

/**
 * Who settles a new game's direction: the person, asked before the design and the build. Asking is
 * the rule, not a reading of how open their words are: "Plz lets make a game like a GunZ" was read
 * as a game the person named, and built at once with no question and no design. Only an ask to just
 * build, and a small game their words give whole ("make me Pong"), build at once. A session is
 * handed the question card and the design board on some turns only and keeps this text for its
 * whole life, so the rule says what to do without them.
 */
const ASK_FIRST = `A new game, or a large new part of one, starts with the person's own direction, never with your guess of it. Ask before you design or build: at most four short questions, one at a time, about what their words leave open (which part of the idea matters most to them, how it looks and feels, how it is played, how big the first version is), each with up to three answers and your pick first, with ${askUser.name} where you have it, in your reply where you don't. A game named only by a likeness or a genre ("a game like GunZ", "a roguelike") is open: that says what theirs resembles, not what theirs is. Once they have answered, where you have ${ProjectTool.ShowDesign}, put the design on the Design tab and show it to them, and build when they agree to it. Build at once, with no questions and no design, only when they said to just build, or when their words already give the whole of a small game (one whose rules everyone knows, as in "make me Pong", or one they described in full). Never ask what the project's own notes or the chat already answer.`;

/**
 * Who checks the work: the agent, with its own tools. The same turn ended "When the build is ready,
 * … walk through the blockout yourself and tell me what you think of the layout" (DeathWish).
 */
const CHECK_IT_YOURSELF =
  "Check what you were asked to do with your own tools before you report it (look at it, play it, read its output), and say what you checked. Ask for the person's opinion as well as your own look, never instead of it, and never hand them a check you can make.";

/**
 * Whose "no" a tool's answer is. The person's own refusal always says they denied it; an engine's
 * answer to a call Genex cut off (a Stop, a pause, a turn's end) reads as the user's. A lead once read
 * "The user doesn't want to take this action right now" on its own pause, which Genex had cut off, and
 * told the person they had declined it (sword duel).
 */
const CUT_OFF_CALLS =
  "Only a tool answer that says the person denied it is their refusal. An answer that says the user doesn't want to take this action, or that the call was interrupted, means Genex or your engine cut the call off (a Stop, a pause, a turn ending), not that the person declined: never tell them they declined it.";

/**
 * Genex's context for the chat's own session, said once in its system text: who runs it and the
 * game's folder (`appIdentity`), who the person is, the language they read, whose plan the work
 * follows, when to ask before a design or a build, whose steps and checks are whose, whose "no" a
 * tool's answer is and the chat's Run button.
 * Only what holds for the session's whole life, the same text on every turn, the lead's included
 * (director.ts): a resumed Claude Code or Codex session keeps the system text it started with. So
 * what the folder holds, which a turn can change, is never in it: a turn that changes it tells the
 * session in Genex's line (delegated-turn.ts `continueOnNewFacts`), and the Loop, workers, checkpoint,
 * kind choice and every other setting reach the session as its tools and its engine's options.
 */
export function chatContext({
  folderLabel,
  appLanguage,
}: {
  folderLabel: string;
  appLanguage: AppLanguage | null;
}): string {
  return [
    appIdentity({ folderLabel }),
    TALK,
    languageRule(appLanguage),
    SCOPE,
    ASK_FIRST,
    DO_IT_YOURSELF,
    CHECK_IT_YOURSELF,
    CUT_OFF_CALLS,
    RUN_BUTTON,
  ].join("\n");
}
