/**
 * One session: a waking run's lead IS its chat's own contractor session.
 *
 * Before this, launching a build from a chat handed the run to a second mind: a director session
 * of its own, opened in the run's integration worktree beside the chat's contractor session, which
 * knew nothing of the conversation the build came from and wrote a memory file to survive its own
 * compactions. Now the chat's own session leads: the run resumes the session the chat's bookmark
 * names (`contractor_session`), in the game folder where that session lives, read-only while the
 * build runs — workers write, and the lead reads the integration worktree it leads. After the close
 * the chat goes on in the same session, before, during and after the build one conversation.
 *
 * When the chat has no session this lead can continue — its bookmark names another engine or
 * model, or it cannot be resumed — the lead starts a fresh one in the game folder with the brief,
 * the chat's latest messages and the digest (`freshChat`). A fresh session on the chat's own engine
 * and model becomes the chat's bookmark; one on another leaves the chat's bookmark alone.
 *
 * The long turn (`run.directorLoop: "turn"`), the classic pipeline and a kept older director.ts
 * keep the separate director in its integration worktree.
 */
import { lastContractorSession } from "../chat-session.ts";
import { GIT, gitAt, resetClean, updateRef } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { plannerModel } from "../model-roles.ts";
import { runRef } from "../repo.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { compactedSummary } from "../compaction-log.ts";
import { handoverSection } from "../session-compact-prompts.ts";
import { chatSoFar, LEAD_SET_ASIDE } from "./lead-session-prompts.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent, Run } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/** The model a session was opened on when the chat named none: the engine's own default. */
const DEFAULT_MODEL = "default";

/**
 * Why the host refused a delegation before any engine ran (the error's `code`). The app's copy is
 * `DelegationRefusal` in `shared/engine-requests.ts`; wire values, never renamed.
 */
export const DelegationRefusal = {
  /** Another session holds the lock this one needs: for a lead, the build it leads. */
  FolderBusy: "folder_busy",
} as const;
export type DelegationRefusal = (typeof DelegationRefusal)[keyof typeof DelegationRefusal];

/** Did the host refuse this delegation because another session holds its lock? It passes: ask again. */
export function folderBusy(err: unknown): boolean {
  return (err as AnyRecord | null)?.code === DelegationRefusal.FolderBusy;
}

/**
 * Does every part of the run a lead depends on serve one (`SERVES_LEAD`): its words and its hands
 * for a lead that writes nothing are there? A seed upgrade keeps a part the agent edited before one
 * session, which never exported it — and would tell a lead in the game folder to edit and commit in
 * its worktree. Such a run seats no lead: a director with its own hands leads, as it did before.
 */
export function servesLead(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_LEAD === true);
}

/** Where a waking run's lead sits and whose session it is (`run.lead`). */
export interface LeadSeat {
  /** The game folder its session sits in: the live folder the user sees. */
  folder: string;
  /** Its session is the chat's own: the chat's bookmark follows it (`bookmarkLead`). */
  chatSession: boolean;
  /** The session its first turn resumes: the chat's, or its own from before a pause; null opens a fresh one. */
  sessionId: string | null;
  /** The session the chat's bookmark names now, so an unchanged one is not written again. */
  bookmarked: string | null;
  engine: string | undefined;
  model: string | null;
}

/** The chat's bookmark as the lead reads it: its session, engine and folder, and its model when one was recorded. */
export interface ChatBookmark {
  sessionId: string;
  engine: string | undefined;
  project?: string;
  model: string | null;
  /** The bookmark recorded its model (bookmarks written before one session did not). */
  modelKnown: boolean;
}

/** One custom event's type and payload, or null. */
function customOf(event: HarnessEvent | AnyRecord | null | undefined): { type: string; payload: AnyRecord } | null {
  const data = (event as AnyRecord)?.data ?? event;
  if (data?.type !== EventKind.Custom) return null;
  return { type: String(data.event_type), payload: data.payload ?? {} };
}

/** The model the newest bookmark of `sessionId` recorded, if any recorded one. */
function recordedModel(events: readonly (HarnessEvent | AnyRecord)[], sessionId: string): AnyRecord | null {
  let found: AnyRecord | null = null;
  for (const event of events) {
    const custom = customOf(event);
    const bookmark = custom?.type === RunEvent.ContractorSession && custom.payload.sessionId === sessionId;
    if (bookmark && custom && "model" in custom.payload) found = custom.payload;
  }
  return found;
}

/** The chat's current session, whatever its engine: what the chat resumes next (chat-session.ts `lastContractorSession`). */
export function chatBookmark(events: readonly (HarnessEvent | AnyRecord)[] | undefined): ChatBookmark | null {
  const found = lastContractorSession(events ?? []);
  if (!found) return null;
  const recorded = recordedModel(events ?? [], found.sessionId);
  return {
    sessionId: found.sessionId,
    engine: found.engine,
    ...(found.project ? { project: found.project } : {}),
    model: recorded ? (recorded.model ?? null) : null,
    modelKnown: recorded !== null,
  };
}

/** A model as a bookmark compares it: none named and the engine's default are the same model. */
function modelKey(model: unknown): string {
  const named = String(model ?? "").trim();
  return named === DEFAULT_MODEL ? "" : named;
}

/** Can this run's lead continue the chat's session: the same engine, the same game and the same model? */
export function continuesChat(bookmark: ChatBookmark, run: Run, leadModel: string | null | undefined): boolean {
  if (!bookmark.engine || bookmark.engine !== run.engine) return false;
  if (bookmark.project && bookmark.project !== run.project) return false;
  // A bookmark from before one session names no model: the chat launched on its own model.
  return !bookmark.modelKnown || modelKey(bookmark.model) === modelKey(leadModel);
}

/**
 * The lead's seat for this run. The chat's session when it can continue it; a fresh one — the
 * chat's own from then on — when the chat has none; and when the chat's session is another
 * engine's or model's, a session of the lead's own (the one it had before a pause, if any) that
 * leaves the chat's bookmark alone.
 */
export function leadSeat({
  events,
  run,
  folder,
  priorJournal = null,
}: {
  events: readonly (HarnessEvent | AnyRecord)[] | undefined;
  run: Run;
  folder: string;
  priorJournal?: AnyRecord | null;
}): LeadSeat {
  const model = plannerModel(run) ?? null;
  const seat = { folder, engine: run.engine, model };
  const bookmark = chatBookmark(events);
  if (!bookmark) return { ...seat, chatSession: true, sessionId: null, bookmarked: null };
  if (continuesChat(bookmark, run, model))
    return { ...seat, chatSession: true, sessionId: bookmark.sessionId, bookmarked: bookmark.sessionId };
  // A lead of its own before the pause: its session sat in this game folder too.
  const prior = priorJournal?.director;
  const own = prior?.lead?.chatSession === false ? (prior.sessionId ?? null) : null;
  return { ...seat, chatSession: false, sessionId: own, bookmarked: null };
}

/**
 * The chat's latest messages, as a fresh lead session is told them (empty when the chat has none),
 * after the handover its compaction wrote when it was compacted (session-compact.ts).
 */
export async function freshChat(ctx: HarnessCtx, threadId: string): Promise<string> {
  const listed = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const events: HarnessEvent[] = Array.isArray(listed) ? listed : [];
  // The messages the host's own `events.messages` would answer: every message event's, in order.
  const lines = events
    .flatMap((event) => (event?.data?.type === EventKind.Messages ? event.data.messages : []))
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({ role: String(m.role), content: String(m.content ?? "") }))
    .filter((m) => m.content.trim());
  const handover = compactedSummary(events);
  return [handover ? handoverSection(handover) : "", chatSoFar(lines)].filter(Boolean).join("\n\n");
}

/**
 * The lead's session becomes the chat's bookmark when it is the chat's own and it changed (a fresh
 * one, or an engine that answers a resume with a new id): the chat's next turn resumes it. The host
 * keeps the chat's record (`contractor`) the same way (delegation.ts `chatLead`).
 */
export async function bookmarkLead(
  ctx: HarnessCtx,
  { threadId, run, seat }: { threadId: string; run: Run; seat: LeadSeat },
  sessionId: string | null | undefined,
): Promise<void> {
  if (!seat.chatSession || !sessionId || sessionId === seat.bookmarked) return;
  seat.bookmarked = sessionId;
  const payload = { project: run.project, engine: seat.engine, sessionId, model: seat.model };
  await ctx
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: [{ type: EventKind.Custom, event_type: RunEvent.ContractorSession, payload }],
    })
    .catch(() => {});
}

/** What the studio set aside of a lead's integration worktree: the ref that keeps it, and its paths. */
export interface SetAside {
  ref: string;
  files: string[];
}

/** A porcelain status line's path: the new name of a rename, quoted names as git wrote them. */
function statusPath(line: string): string {
  const named = line.slice(3).trim();
  const renamed = named.indexOf(" -> ");
  return renamed >= 0 ? named.slice(renamed + 4) : named;
}

/**
 * Changes in a lead's integration worktree that nobody committed — a game that builds in place, a
 * tool's cache, a lead's edit it did not commit — would hold every merge off for the rest of the run. The
 * studio keeps them instead: every change, staged, as a commit over the integration head on a ref
 * of the run (`refs/studio/runs/<run>/set-aside/<stamp>`, never the branch), and the worktree reset
 * to that head. Said on the run's log. Answers what it set aside, or null when nothing was
 * uncommitted; a git failure throws, and the worktree is left as it was found or reset.
 */
export async function setAsideStrays(loopRun: LoopRun, label: string): Promise<SetAside | null> {
  const { ctx, integrationWorktree: at, note, run } = loopRun;
  const status = await gitAt(ctx, at, GIT.status, { label }).catch(() => "");
  if (!status) return null;
  const files = status.split("\n").map(statusPath).filter(Boolean);
  const ref = runRef(run.runId, "set-aside", Date.now());
  const message = `studio: set aside what no worker made in ${run.runId}'s integration worktree`;
  // Everything, staged in the worktree's own index (the reset below clears it), as a commit on the
  // head. A kept older git.ts has no `snapshotCommit`, and then no lead is seated (`servesLead`).
  const commit = await gitAt(ctx, at, GIT.snapshotCommit(message), { label });
  await updateRef(ctx, at, ref, commit, { label });
  await resetClean(ctx, at, "HEAD", { label });
  note(LEAD_SET_ASIDE(ref, files));
  return { ref, files };
}
