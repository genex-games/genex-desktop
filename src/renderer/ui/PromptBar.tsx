import { markPerformance } from "../performance.tsx";
import { PerformanceMarkName } from "../../shared/performance.ts";
import type { ClipboardEvent, DragEvent, JSX, KeyboardEvent, Ref, RefObject } from "react";
import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { Shortcut } from "./Shortcut.tsx";
import { ComposerTip } from "./PickerPanel.tsx";
import { filesToFramesDetailed, MAX_REFERENCE_FRAMES, type PickedFrame } from "../reference-frames.ts";
import {
  ModelMenu,
  shortModelName,
  type ModelChoice,
  type ModelMenuHandle,
  type RoleGroup,
  type RoleKey,
  type RoleRecord,
  type RoleRow,
} from "./ModelMenu.tsx";
import { ComposerEffort } from "./ComposerEffort.tsx";
import { ConnectModelButton, useModelNudge } from "./ConnectModelButton.tsx";
import { ComposerModeMenu } from "./ComposerModeMenu.tsx";
import { ComposerPermissionMenu } from "./ComposerPermissionMenu.tsx";
import type { PermissionMode } from "../../shared/permissions.ts";
import { ComposerAddMenu, type AddMenuHandle, PlanModeOff } from "./ComposerAddMenu.tsx";
import { ComposerLimits, type ContextUsage } from "./ComposerLimits.tsx";
import {
  ComposerCommandMenu,
  compactCommand,
  type PluginCommand,
  useComposerCommands,
} from "./ComposerCommandMenu.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";
import { selectedCompact } from "../chat/compact-control.ts";
import { useToolbarFit } from "./toolbar-fit.ts";
import { composerPlaceholder, PLAN_PLACEHOLDER } from "../composer-placeholder.ts";
import { browserStorage, removeKey, STORAGE_KEYS } from "../storage.ts";
import {
  type ComposerBuild,
  composerExtras,
  composerLoopView,
  type LoopSetting,
  modeMenuReach,
  pinChatLoop,
  rememberChatLoop,
  RUNNING_BUILD,
  storedChatLoop,
} from "../loop-setting.ts";
import { parseModelKey } from "../model-key.ts";
import {
  atomicBackspaceRange,
  splitMentions,
  insertMention as insertTag,
  type MentionDoc,
  type MentionRef,
  mentionQueryAt,
  mentionRef,
  pluginDoc,
  PROMPT_MENTION_MAX,
  sentMentions,
} from "../../shared/prompt-mention.ts";
export { shortModelName };
export type { ModelChoice, RoleGroup, RoleRecord, RoleRow };
export interface AutopilotSend {
  reviewPlan?: boolean;
  roles?: RoleRecord;
  hours: number | null;
  frames: PickedFrame[];
}
export interface ComposerExtras {
  autopilot?: AutopilotSend;
  reviewPlan?: boolean;
  frames?: PickedFrame[];
  /** The games, tools and assets the message tags with @. */
  mentions?: MentionRef[];
}

/** Adds pictures to a composer's attachments: `{conversationKey, frames}` (a rewound message's). */
export const COMPOSE_FRAMES_EVENT = "studio:compose-frames";

/** A reply about something on the Builds graph: the chip above the prompt, and its hint. */
export interface ReplyAboutChip {
  label: string;
  placeholder: string;
  onClear: () => void;
}

/** What the chat can ask of its composer without reaching into its DOM. */
export interface PromptBarHandle {
  /** Put the cursor in the prompt. */
  focus(): void;
  /** Open the model menu, as its own button would. */
  openModelMenu(): void;
  /** Put words in the prompt when it has none yet (the first-launch idea), cursor after them. */
  compose(text: string): void;
}

/**
 * The composer's model controls, in one object: the choices and the pick, the roles panel (a
 * delegated engine's workers and judges) and the effort (rendered only when `onEffort` is given).
 */
export interface ComposerModelProps {
  choices: ModelChoice[];
  selected: string | null;
  onPick: (key: string) => void;
  /** The roles panel (delegated engines only): current picks and the setter. */
  roles?: RoleRecord | null;
  onRoles?: (roles: RoleRecord) => void;
  /** One reasoning effort for every role; the control renders only when onEffort is given. */
  effort?: string | null;
  /** The levels the effort control offers (the orchestrator's own). */
  efforts?: string[];
  onEffort?: (value: string | null) => void;
}

/**
 * The chat's permission mode: the pill after Mode, on every engine, with the modes that engine
 * honours (`permissionModesFor`).
 */
export interface ComposerPermissions {
  /** The mode the chat's engine runs in. */
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
  /** The chat's model cannot use Auto, so Claude asks first instead. */
  autoUnavailable: boolean;
  /** The chat's engine (`EngineId`), whose modes the menu offers. */
  engine: string;
}

export function readStoredReviewPlan(): boolean {
  return false;
}
/** The prompt grows with its text between these heights (px), then scrolls. */
const MIN_INPUT_HEIGHT = 38;
const MAX_INPUT_HEIGHT = 138;
/** The send control morphs into Stop on the same click; this long after a send, Stop ignores it (ms). */
const STOP_PAD_MS = 600;
const DEFAULT_PLACEHOLDER = "Write a message…";

/**
 * The composer's mode: the chat's own Loop (`loop-setting.ts`), what Mode shows and allows given
 * the chat's build, and plan review (Add's Plan mode: one message, fresh for each chat). Switching chats re-reads the Loop while
 * rendering, so the composer is never remounted and its draft and pictures stay.
 */
function useLoopSettings(props: PromptBarProps) {
  const { conversationKey, coordinating = false, gameMode = true } = props;
  const [pick, setPick] = useState<{ thread?: string; setting: LoopSetting } | null>(null);
  const [reviewPlan, setReviewPlan] = useState<boolean>(readStoredReviewPlan);
  const setting = useMemo(
    () => (pick && pick.thread === conversationKey ? pick.setting : storedChatLoop(browserStorage(), conversationKey)),
    [pick, conversationKey],
  );
  // A game chat keeps the Loop it opened with; the Studio chat and a keyless composer keep none.
  useLayoutEffect(() => {
    if (gameMode && conversationKey) pinChatLoop(browserStorage(), conversationKey);
  }, [conversationKey, gameMode]);
  useLayoutEffect(() => {
    setReviewPlan(false);
    removeKey(STORAGE_KEYS.autopilotReview);
  }, [conversationKey, coordinating]);
  const build = props.build ?? (coordinating ? RUNNING_BUILD : null);
  const view = composerLoopView({ own: setting, build, loopAvailable: props.loopAvailable });
  const chooseLoop = (next: LoopSetting): void => {
    setPick({ thread: conversationKey, setting: next });
    rememberChatLoop(browserStorage(), conversationKey, next);
  };
  // As Mode is: a build that owns the chat keeps its own plan, so its follow-ups get no review.
  const planAvailable = view.editable && !coordinating;
  // What the bulb, Add's row and the box show: plan review that this chat's next send will carry.
  const planOn = reviewPlan && planAvailable;
  return { setting, view, chooseLoop, reviewPlan, setReviewPlan, planAvailable, planOn, gate: props.loopGate };
}

type Mention = { query: string; start: number; end: number };

/**
 * @ at the caret opens Add as the @ picker; the query is what follows it. A picked card puts its
 * `@handle` in the text and joins `tagged`, the map the send and the painted tags read.
 */
function useMention(
  gameMode: boolean,
  draft: string,
  setDraft: (text: string) => void,
  inputRef: RefObject<HTMLTextAreaElement | null>,
) {
  const [mention, setMention] = useState<Mention | null>(null);
  const [mentionOption, setMentionOption] = useState<string | null>(null);
  const [tagged, setTagged] = useState<ReadonlyMap<string, MentionDoc>>(() => new Map());
  const mentionListId = useId();
  const findMention = (text: string, caret: number | null): Mention | null => {
    if (!gameMode || caret === null) return null;
    const open = mentionQueryAt(text, caret);
    return open ? { query: open.query, start: open.start, end: caret } : null;
  };
  const placeCaret = (caret: number): void => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };
  const insertMention = (text: string | null): void => {
    if (!mention) return;
    const insert = text ?? "";
    setDraft(draft.slice(0, mention.start) + insert + draft.slice(mention.end));
    setMention(null);
    placeCaret(mention.start + insert.length);
  };
  /** The draft becomes this tag alone, ready for the words after it (a pick from the / list). */
  const startWith = (doc: MentionDoc): void => {
    const value = `@${doc.handle} `;
    setTagged((current) => new Map(current).set(doc.handle, doc));
    setDraft(value);
    setMention(null);
    placeCaret(value.length);
  };
  const insertDoc = (doc: MentionDoc): void => {
    const caret = mention?.end ?? inputRef.current?.selectionStart ?? draft.length;
    const open = mention ? { start: mention.start, query: mention.query } : null;
    const next = insertTag(draft, caret, doc.handle, open);
    setTagged((current) => new Map(current).set(doc.handle, doc));
    setDraft(next.value);
    setMention(null);
    placeCaret(next.caret);
  };
  // A draft replaced from outside (another chat, a prefill) leaves no @ to complete.
  useLayoutEffect(() => {
    if (mention && draft[mention.start] !== "@") setMention(null);
  }, [draft]);
  const inText = useMemo(() => sentMentions(draft, tagged), [draft, tagged]);
  const taggedNow = useMemo(() => new Set(inText.map((doc) => doc.handle)), [inText]);
  return {
    mention,
    setMention,
    mentionOption,
    setMentionOption,
    mentionListId,
    findMention,
    insertMention,
    insertDoc,
    startWith,
    tagged,
    taggedNow,
    atCap: inText.length >= PROMPT_MENTION_MAX,
    refs: (): MentionRef[] => inText.map(mentionRef),
  };
}

/** One Backspace right after a whole tag removes the tag; true when it did. */
function backspaceTag(
  event: KeyboardEvent<HTMLTextAreaElement>,
  tagged: ReadonlyMap<string, MentionDoc>,
  setDraft: (text: string) => void,
): boolean {
  if (event.key !== "Backspace" || event.altKey || event.metaKey || event.ctrlKey) return false;
  const input = event.currentTarget;
  const range = atomicBackspaceRange(input.value, input.selectionStart, input.selectionEnd, tagged);
  if (!range) return false;
  event.preventDefault();
  setDraft(input.value.slice(0, range.start) + input.value.slice(range.end));
  requestAnimationFrame(() => input.setSelectionRange(range.start, range.start));
  return true;
}

/**
 * Autosize up to a compact maximum — and never smaller than the placeholder, which a wrapping
 * one was: an empty textarea measures none of it, so the instruction was sliced through
 * mid-word on the one screen a new user has.
 */
function useAutosize(inputRef: RefObject<HTMLTextAreaElement | null>, draft: string, placeholder: string): void {
  const lastWidth = useRef(0);
  useLayoutEffect(() => {
    markPerformance(PerformanceMarkName.ComposerCommit);
    const input = inputRef.current;
    if (!input) return;
    const measure = (): number => {
      input.style.height = "0px";
      return input.scrollHeight;
    };
    const fit = (): void => {
      let height = measure();
      if (draft.length === 0 && input.placeholder) {
        // Borrowed for the measurement and given back inside the same layout pass: nothing paints
        // with the placeholder as the value.
        input.value = input.placeholder;
        height = Math.max(height, measure());
        input.value = "";
      }
      input.style.height = `${Math.min(Math.max(height, MIN_INPUT_HEIGHT), MAX_INPUT_HEIGHT)}px`;
      input.style.overflowY = height > MAX_INPUT_HEIGHT ? "auto" : "hidden";
    };
    fit();
    // The chat column is draggable, so the same words wrap differently from one drag to the next.
    let resizeFrame = 0;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth.current) < 0.5) return;
      lastWidth.current = width;
      // Write the new height outside the observer delivery cycle.
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(fit);
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [draft, placeholder]);
}

/** The board with these pictures added after the ones already on it, each once. */
function withFrames(current: PickedFrame[], added: PickedFrame[]): PickedFrame[] {
  const seen = new Set(current.map((f) => f.data));
  return [...current, ...added.filter((f) => !seen.has(f.data))].slice(0, MAX_REFERENCE_FRAMES);
}

/** The pictures on the mood board, and the files that could not be read as pictures. */
function useBoardFrames(conversationKey: string | undefined) {
  const [frames, setFrames] = useState<PickedFrame[]>([]);
  const [skippedFiles, setSkippedFiles] = useState<string[]>([]);
  // A rewound message comes back with its pictures, beside any already attached.
  useEffect(() => {
    const compose = (event: Event): void => {
      const detail = (event as CustomEvent<{ conversationKey?: string; frames?: PickedFrame[] }>).detail;
      const added = detail?.frames;
      if (!added?.length || detail.conversationKey !== conversationKey) return;
      setFrames((current) => withFrames(current, added));
    };
    window.addEventListener(COMPOSE_FRAMES_EVENT, compose);
    return () => window.removeEventListener(COMPOSE_FRAMES_EVENT, compose);
  }, [conversationKey]);
  const addFiles = (files: FileList | File[]): void => {
    void filesToFramesDetailed(files).then(({ frames: picked, skipped }) => {
      // A still the browser cannot decode is said so, never silently dropped.
      setSkippedFiles(skipped);
      if (!picked.length) return;
      setFrames((current) => withFrames(current, picked));
    });
  };
  /** A send that failed puts its pictures back in front of what was added since. */
  const restore = (sent: PickedFrame[]): void =>
    setFrames((current) =>
      [...sent, ...current.filter((f) => !sent.some((frame) => frame.data === f.data))].slice(0, MAX_REFERENCE_FRAMES),
    );
  return { frames, setFrames, skippedFiles, setSkippedFiles, addFiles, restore };
}

/** Which roles each subscription serves right now, for the plan limits beside the context. */
function rolesInUse(modelKey: string | null, roles: RoleRecord | null, rolesApply: boolean): Record<string, RoleKey[]> {
  const orchestratorEngine = modelKey ? parseModelKey(modelKey).engine : undefined;
  const usedBy: Record<string, RoleKey[]> = {};
  const serve = (engineId: string | undefined, role: RoleKey): void => {
    if (engineId) (usedBy[engineId] ??= []).push(role);
  };
  serve(orchestratorEngine, "planner");
  if (rolesApply && roles)
    for (const role of ["builder", "judge"] as const) serve(roles.engines?.[role] ?? orchestratorEngine, role);
  return usedBy;
}

/**
 * What the send control offers; the value is its data-state, which the stylesheet reads. Blocked
 * is a draft with no AI model to take it: Send stays quiet, and pressing it points at Connect AI model.
 */
const SendAction = { Ready: "ready", Stop: "stop", Idle: "idle", Blocked: "blocked" } as const;
type SendAction = (typeof SendAction)[keyof typeof SendAction];

/** Send for a sendable draft, Stop while work runs, else nothing. */
function sendAction(canSend: boolean, canStop: boolean): SendAction {
  if (canSend) return SendAction.Ready;
  return canStop ? SendAction.Stop : SendAction.Idle;
}

/** The picture files in a paste. */
function pastedFiles(clipboard: DataTransfer): File[] {
  return [...clipboard.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * A copied file also carries its name as text; the picture is what was pasted, not
 * "Screenshot 2026-09-24 at 10.21.png" in the message. Real text pasted with it stays.
 */
function pasteIsOnlyNames(clipboard: DataTransfer, files: File[]): boolean {
  const text = clipboard.getData("text/plain").trim();
  const names = new Set(files.map((file) => file.name));
  return !text || text.split(/\r?\n/).every((line) => names.has(line.trim().split("/").pop() ?? ""));
}

/** Files a drop or paste could not read as pictures: said so, with a way to dismiss it. */
function SkippedFiles({ files, onDismiss }: { files: string[]; onDismiss: () => void }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1 pb-1.5" role="alert">
      <span
        className="rounded-[6px] border border-red/40 bg-red-tint px-1.5 py-0.5 text-micro text-red"
        title={files.join(", ")}
      >
        could not decode {files.length === 1 ? files[0] : `${files.length} files`} — not added to the board
      </span>
      <button
        type="button"
        className="text-micro text-ink-3 hover:text-control-text-hover"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

/** The pictures going with the next message, each with its own remove button. */
function FrameBoard({
  frames,
  gameMode,
  onRemove,
}: {
  frames: PickedFrame[];
  gameMode: boolean;
  onRemove: (index: number) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pt-1 pb-1.5" aria-label={gameMode ? "Mood board" : "Attached images"}>
      {frames.map((frame, index) => (
        <div key={`${frame.label}-${index}`} className="group relative">
          <img
            src={`data:${frame.mimeType};base64,${frame.data}`}
            alt={frame.label}
            title={frame.label}
            className="h-11 w-14 rounded-[6px] border border-line object-cover"
          />
          <button
            type="button"
            aria-label={`Remove ${frame.label}`}
            onClick={() => onRemove(index)}
            className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-ink text-micro text-surface group-hover:flex"
            style={{ background: "var(--ink)", color: "var(--surface)" }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The chip naming what the next message is a note about, with a way to stop replying about it. */
function ReplyAboutTag({ about }: { about: ReplyAboutChip }): JSX.Element {
  return (
    <div className="flex min-w-0 px-1 pt-1 pb-0.5">
      <span
        data-reply-about
        className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-[9px] bg-inset pr-1 pl-2 text-body-sm text-ink-2"
        title={`Your next message goes to the build as a note about ${about.label}`}
      >
        <Icon name="chat" size={13} />
        <span className="truncate">{about.label}</span>
        <button
          type="button"
          aria-label={`Stop replying about ${about.label}`}
          onClick={about.onClear}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[6px] text-ink-3 hover:bg-control-hover hover:text-control-text-hover"
        >
          <Icon name="close" size={11} />
        </button>
      </span>
    </div>
  );
}

/** One control that changes its glyph: Send while there is a draft, Stop while work runs. */
function SendControl({
  action,
  onSend,
  onStop,
  ignoreStopUntil,
}: {
  action: SendAction;
  onSend: () => void;
  onStop: () => void;
  ignoreStopUntil: RefObject<number>;
}): JSX.Element {
  const stopping = action === SendAction.Stop;
  // A blocked send's reason is Connect AI model's own tooltip.
  const quiet = action === SendAction.Idle || action === SendAction.Blocked;
  return (
    <ComposerTip
      align="end"
      hidden={quiet}
      content={
        stopping ? (
          "Stop"
        ) : (
          <span className="flex items-center gap-2">
            Send <Shortcut>↵</Shortcut>
          </span>
        )
      }
    >
      <button
        type="button"
        aria-label={stopping ? "Stop" : "Send"}
        data-state={action}
        disabled={action === SendAction.Idle}
        onClick={(event) => {
          if (action === SendAction.Ready || action === SendAction.Blocked) {
            onSend();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          // The send control morphs into Stop on the same click; the pad keeps that click from
          // cancelling the turn it just started.
          if (Date.now() < ignoreStopUntil.current) return;
          onStop();
        }}
        onKeyDown={(event) => {
          if (stopping && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onStop();
          }
        }}
        className="composer-send"
      >
        <span className="composer-send-glyph" data-glyph="send">
          <Icon name="send" />
        </span>
        <span className="composer-send-glyph" data-glyph="stop">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
          </svg>
        </span>
      </button>
    </ComposerTip>
  );
}

/** What the chat hands its composer. */
interface PromptBarProps {
  ref?: Ref<PromptBarHandle>;
  /** A reply about something on the Builds graph: the chip above the prompt, and its hint. */
  about?: ReplyAboutChip | null;
  /** A run already belongs to this chat. Messages go to its coordinator. */
  coordinating?: boolean;
  /** That run's lead takes the chat while it builds (chat/live-chat.ts): a message reaches it now. */
  leadListens?: boolean;
  activityLabel?: string;
  conversationKey?: string;
  /** The chat's build, when one belongs to it: Mode shows its own Loop while it runs or is paused. */
  build?: ComposerBuild | null;
  gameMode?: boolean;
  project?: string | null;
  /** The game can run a Loop (`loopAvailableFor`); without it Mode offers Off alone and says why. */
  loopAvailable?: boolean;
  /** Why the game can't run a Loop, naming its project and where it is (`engineLoopGate`). */
  loopGate?: string;
  contexts?: ContextUsage[];
  contextUsage?: ContextUsage | null;
  onCompact?: () => void;
  compacting?: boolean;
  /** A turn or a build is under way: Compact now waits for it. */
  compactBusy?: boolean;
  placeholder?: string;
  disabled?: boolean;
  busy?: boolean;
  /** A turn is running that the user may stop; Stop yields to Send for a sendable draft. */
  stoppable?: boolean;
  onStop?: () => void;
  model: ComposerModelProps;
  /** The chat's permission mode; the pill renders only when given. */
  permissions?: ComposerPermissions | null;
  onSend: (text: string, extras?: ComposerExtras) => void | Promise<void>;
  /** Controlled draft — ChatPanel keys this per thread so a half-written brief cannot follow you. */
  value?: string;
  onChange?: (text: string) => void;
  /** Where the @ picker opens: under the prompt bar on the home screen, above it in a chat. */
  mentionSide?: "top" | "bottom";
  /** Composer stays usable, but Enter/send starts sign-in instead of a turn. */
  blockSend?: boolean;
  onBlockedSend?: () => void;
}

/** The draft: the chat's own when it controls it, else the composer's. */
function useDraft(value: string | undefined, onChange: ((text: string) => void) | undefined) {
  const [localDraft, setLocalDraft] = useState("");
  const setDraft = (text: string): void => {
    if (onChange) onChange(text);
    else setLocalDraft(text);
  };
  return { draft: value ?? localDraft, setDraft };
}

/** Sending the draft with its extras, putting it all back when the send fails, and the Stop pad. */
function useComposerSend(
  props: PromptBarProps,
  composer: {
    draft: string;
    setDraft: (text: string) => void;
    loop: ReturnType<typeof useLoopSettings>;
    board: ReturnType<typeof useBoardFrames>;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    /** The @ query to close on send, and the tags in the draft, read at the moment it is sent. */
    mentions: Pick<ReturnType<typeof useMention>, "setMention" | "refs">;
  },
) {
  const ignoreStopUntil = useRef(0);
  const { draft, setDraft, loop, board, inputRef } = composer;
  // A game composer with no AI model at all offers Connect AI model in the model's place; a send
  // lights that up instead of going anywhere.
  const noModel = (props.gameMode ?? true) && props.model.choices.length === 0;
  const modelNudge = useModelNudge();
  const writable = !props.disabled && !props.busy && draft.trim().length > 0;
  const canSend = writable && !noModel;
  const send = (): void => {
    if (writable && noModel) {
      modelNudge.nudge();
      return;
    }
    if (props.blockSend) {
      props.onBlockedSend?.();
      return;
    }
    if (!canSend) return;
    // The send control morphs into Stop on the same click; without this pad that click
    // cancels the turn it just started ("keep going" → cancelled).
    ignoreStopUntil.current = Date.now() + STOP_PAD_MS;
    const text = draft.trim();
    const sentFrames = board.frames;
    setDraft("");
    composer.mentions.setMention(null);
    // The board goes with the message — a chip that lingers after send reads as "not sent".
    // The harness keeps the board attached for the rest of the interview on its side.
    if (sentFrames.length) board.setFrames([]);
    // A failed send is already durable in the thread (main appends the error); catching here
    // only stops the same failure from surfacing twice as console noise.
    const tags = composer.mentions.refs();
    const extras = {
      ...composerExtras({
        gameMode: props.gameMode ?? true,
        view: loop.view,
        reviewPlan: loop.reviewPlan,
        frames: sentFrames,
      }),
      ...(tags.length ? { mentions: tags } : {}),
    };
    loop.setReviewPlan(false);
    void Promise.resolve(props.onSend(text, Object.keys(extras).length ? extras : undefined)).catch(() => {
      if (extras.reviewPlan) loop.setReviewPlan(true);
      if (!inputRef.current?.value) setDraft(text);
      board.restore(sentFrames);
    });
  };
  const blocked = writable && noModel;
  const action = blocked ? SendAction.Blocked : sendAction(canSend, Boolean(props.stoppable && props.onStop));
  return { send, action, ignoreStopUntil, modelNudge: modelNudge.beat };
}

/** The prompt itself: typing, the @ mention or / command list it may open, and Enter to send. */
function PromptInput({
  inputRef,
  draft,
  setDraft,
  disabled,
  placeholder,
  mentions,
  commands,
  addMenuRef,
  commandMenuRef,
  onEnter,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (text: string) => void;
  disabled: boolean;
  placeholder: string;
  mentions: ReturnType<typeof useMention>;
  commands: ReturnType<typeof useComposerCommands> | null;
  addMenuRef: RefObject<AddMenuHandle | null>;
  commandMenuRef: RefObject<AddMenuHandle | null>;
  onEnter: () => void;
}): JSX.Element {
  const list = listAria(mentions, commands);
  const painted = useMemo(() => splitMentions(draft, mentions.tagged), [draft, mentions.tagged]);
  const hasTags = painted.some((run) => run.handle);
  const mirror = useRef<HTMLDivElement>(null);
  return (
    <div className="composer-input-wrap" data-painted={hasTags || undefined}>
      {hasTags ? <PaintedDraft runs={painted} mirrorRef={mirror} /> : null}
      <PromptTextarea
        {...{
          inputRef,
          draft,
          setDraft,
          disabled,
          placeholder,
          mentions,
          commands,
          addMenuRef,
          commandMenuRef,
          onEnter,
        }}
        list={list}
        onScroll={(top) => {
          if (mirror.current) mirror.current.scrollTop = top;
        }}
      />
    </div>
  );
}

/**
 * The draft's words drawn under a text box whose own glyphs are clear while it has tags, so a tag
 * shows as a pill in the sentence. The layer has the text box's box and type, glyph for glyph.
 */
function PaintedDraft({
  runs,
  mirrorRef,
}: {
  runs: { text: string; handle: string | null }[];
  mirrorRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  return (
    <div ref={mirrorRef} aria-hidden className={`${PROMPT_INPUT_CLASS} composer-input-paint`}>
      {runs.map((run, index) =>
        run.handle ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and rebuilt with the draft.
          <span key={index} className="mention-pill">
            {run.text}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and rebuilt with the draft.
          <span key={index}>{run.text}</span>
        ),
      )}
      {/* A last empty line still takes its height, as in the text box. */}
      {"\u200b"}
    </div>
  );
}

/** The text box: the draft, the @ and / lists' keys, and one Backspace per whole tag. */
function PromptTextarea({
  inputRef,
  draft,
  setDraft,
  disabled,
  placeholder,
  mentions,
  commands,
  addMenuRef,
  commandMenuRef,
  onEnter,
  list,
  onScroll,
}: Parameters<typeof PromptInput>[0] & {
  list: { id: string; option: string | null } | null;
  onScroll: (top: number) => void;
}): JSX.Element {
  const { mention, setMention, findMention } = mentions;
  return (
    <textarea
      ref={inputRef}
      rows={1}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        setMention(findMention(event.target.value, event.target.selectionStart));
        commands?.track(event.target.value, event.target.selectionStart);
      }}
      onSelect={(event) => {
        // Only a caret that moved changes the mention; typing and Escape are handled above.
        if (mention && event.currentTarget.selectionStart !== mention.end)
          setMention(findMention(event.currentTarget.value, event.currentTarget.selectionStart));
        // A caret moved off the end of a / command closes its list.
        if (commands?.query != null) commands.track(event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onKeyDown={(event) => {
        markPerformance(PerformanceMarkName.Keydown);
        if (addMenuRef.current?.keyDown(event)) return;
        if (commandMenuRef.current?.keyDown(event)) return;
        if (backspaceTag(event, mentions.tagged, setDraft)) return;
        const sends = event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
        if (sends) {
          event.preventDefault();
          onEnter();
        }
      }}
      placeholder={placeholder}
      aria-label="Prompt"
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      {...(list
        ? {
            "aria-controls": list.id,
            "aria-autocomplete": "list" as const,
            "aria-activedescendant": list.option ?? undefined,
          }
        : {})}
      className={`${PROMPT_INPUT_CLASS} resize-none bg-transparent text-ink outline-none placeholder:text-ink-3`}
    />
  );
}

/** The text box's box and type, which the painted words under it share glyph for glyph. */
const PROMPT_INPUT_CLASS =
  "composer-input min-h-[35px] w-full min-w-0 pt-[6px] pr-2 pb-[9px] pl-[7px] text-composer [overflow-wrap:anywhere]";

/** The / command list in a game's composer; the Harness chat has none. */
function CommandList({
  props,
  commands,
  anchor,
  menuRef,
  onPlugin,
}: {
  props: PromptBarProps;
  commands: ReturnType<typeof useComposerCommands>;
  anchor: RefObject<HTMLDivElement | null>;
  menuRef: RefObject<AddMenuHandle | null>;
  /** A plugin picked from the list: the draft becomes its tag. */
  onPlugin: (doc: MentionDoc) => void;
}): JSX.Element | null {
  // A plugin picked from the / list: the message becomes its @ tag, ready for the words after it.
  const plugins = usePluginCommands(commands.query !== null, (plugin) => {
    commands.setQuery(null);
    onPlugin(pluginDoc(plugin));
  });
  if (props.gameMode === false) return null;
  return (
    <ComposerCommandMenu
      ref={menuRef}
      query={commands.query}
      options={compactCommand(composerCompact(props), props.onCompact && commands.runner(props.onCompact))}
      plugins={plugins}
      anchor={anchor}
      listId={commands.listId}
      onClose={() => commands.setQuery(null)}
      onActiveOption={commands.setActiveOption}
    />
  );
}

/**
 * The plugins that are on, for the / list, read when it opens; picking one tags it in the message
 * as @ does. A failed read offers none.
 */
function usePluginCommands(open: boolean, tag: (plugin: { id: string; name: string }) => void): PluginCommand[] {
  const [names, setNames] = useState<{ id: string; name: string }[]>([]);
  useAsyncEffect(
    (alive) => {
      if (!open) return;
      window.studio.pluginsList().then(
        (plugins) => {
          if (!alive()) return;
          const on = plugins.filter((plugin) => plugin.enabled && !plugin.removed && !plugin.unlisted);
          setNames(on.map((plugin) => ({ id: plugin.manifest.id, name: plugin.manifest.name })));
        },
        () => {},
      );
    },
    [open],
  );
  return names.map((plugin) => ({ ...plugin, pick: () => tag(plugin) }));
}

/** Compact now as this composer's selected model and its work allow it. */
function composerCompact(props: PromptBarProps) {
  return selectedCompact(props.model.choices, props.model.selected, {
    compacting: Boolean(props.compacting),
    busy: Boolean(props.compactBusy),
  });
}

/** The option list the text box points at: the @ mention's, else an open / command list's. */
function listAria(
  mentions: ReturnType<typeof useMention>,
  commands: ReturnType<typeof useComposerCommands> | null,
): { id: string; option: string | null } | null {
  if (mentions.mention) return { id: mentions.mentionListId, option: mentions.mentionOption };
  if (commands?.activeOption) return { id: commands.listId, option: commands.activeOption };
  return null;
}

/** The hidden file picker behind Add → References and the attach button. */
function ImagePicker({
  fileRef,
  onFiles,
}: {
  fileRef: RefObject<HTMLInputElement | null>;
  onFiles: (files: FileList) => void;
}): JSX.Element {
  return (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      multiple
      className="hidden"
      onChange={(event) => {
        if (event.target.files) onFiles(event.target.files);
        event.target.value = "";
      }}
    />
  );
}

export function PromptBar(props: PromptBarProps): JSX.Element {
  const { disabled = false, coordinating = false, gameMode = true } = props;
  const { draft, setDraft } = useDraft(props.value, props.onChange);
  const loop = useLoopSettings(props);
  const board = useBoardFrames(props.conversationKey);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const addMenuRef = useRef<AddMenuHandle>(null);
  const commandMenuRef = useRef<AddMenuHandle>(null);
  const modelMenuRef = useRef<ModelMenuHandle>(null);
  usePromptHandle(props.ref, { inputRef, modelMenuRef, draft, setDraft });
  const mentions = useMention(gameMode, draft, setDraft, inputRef);
  const commands = useComposerCommands(draft, setDraft);
  // A reply about the build is a note to it, delivered at once, not a message waiting in line.
  // Add's Plan mode asks for what to plan, as Codex's does, until the message goes.
  const contextual = loop.planOn ? PLAN_PLACEHOLDER : (props.placeholder ?? DEFAULT_PLACEHOLDER);
  const placeholderNow = props.about?.placeholder ?? composerPlaceholder(coordinating, contextual, props.leadListens);
  useAutosize(inputRef, draft, placeholderNow);
  const composer = useComposerSend(props, { draft, setDraft, loop, board, inputRef, mentions });

  return (
    <div
      data-promptbar
      data-studio-composer={!gameMode || undefined}
      className="composer relative min-w-0"
      {...fileDropHandlers(disabled, board.addFiles)}
    >
      {/* ── composer ───────────────────────────────────── */}
      <div
        ref={panelRef}
        className={`composer-panel relative flex min-w-0 flex-col gap-0.5
          transition-colors duration-150 ${disabled ? "opacity-55" : ""}`}
      >
        {board.skippedFiles.length > 0 ? (
          <SkippedFiles files={board.skippedFiles} onDismiss={() => board.setSkippedFiles([])} />
        ) : null}
        {props.about ? <ReplyAboutTag about={props.about} /> : null}
        {board.frames.length > 0 ? (
          <FrameBoard
            frames={board.frames}
            gameMode={gameMode}
            onRemove={(index) => board.setFrames((current) => current.filter((_, i) => i !== index))}
          />
        ) : null}
        <PromptInput
          inputRef={inputRef}
          draft={draft}
          setDraft={setDraft}
          disabled={disabled}
          placeholder={placeholderNow}
          mentions={mentions}
          commands={gameMode ? commands : null}
          addMenuRef={addMenuRef}
          commandMenuRef={commandMenuRef}
          onEnter={composer.send}
        />
        <CommandList
          {...{ props, commands }}
          anchor={panelRef}
          menuRef={commandMenuRef}
          onPlugin={mentions.startWith}
        />
        <ImagePicker fileRef={fileRef} onFiles={board.addFiles} />
        <ComposerToolbar
          model={props.model}
          permissions={props.permissions ?? null}
          gameMode={gameMode}
          disabled={disabled}
          coordinating={coordinating}
          project={props.project}
          loop={loop}
          limits={composerLimits(props)}
          panelRef={panelRef}
          addMenuRef={addMenuRef}
          modelMenuRef={modelMenuRef}
          modelNudge={composer.modelNudge}
          mentions={mentions}
          mentionSide={props.mentionSide ?? "top"}
          onPickImages={() => fileRef.current?.click()}
          onClosed={() => inputRef.current?.focus()}
          send={
            <SendControl
              action={composer.action}
              onSend={composer.send}
              onStop={() => props.onStop?.()}
              ignoreStopUntil={composer.ignoreStopUntil}
            />
          }
        />
      </div>
    </div>
  );
}

/** The context meter's inputs, as the chat passed them. */
function composerLimits(props: PromptBarProps): ComposerLimitsInput {
  const { contextUsage, contexts, onCompact, compacting, compactBusy } = props;
  return { contextUsage, contexts, onCompact, compacting, compactBusy };
}

/** What the composer can do for the chat: focus, open the model menu, or take the welcome's idea. */
function usePromptHandle(
  ref: Ref<PromptBarHandle> | undefined,
  input: {
    inputRef: RefObject<HTMLTextAreaElement | null>;
    modelMenuRef: RefObject<ModelMenuHandle | null>;
    draft: string;
    setDraft: (text: string) => void;
  },
): void {
  const composeNow = useRef({ draft: input.draft, setDraft: input.setDraft });
  composeNow.current = { draft: input.draft, setDraft: input.setDraft };
  const { inputRef, modelMenuRef } = input;
  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      openModelMenu: () => modelMenuRef.current?.open(),
      compose: (text) => {
        if (!composeNow.current.draft) composeNow.current.setDraft(text);
        requestAnimationFrame(() => {
          const element = inputRef.current;
          element?.focus();
          element?.setSelectionRange(element.value.length, element.value.length);
        });
      },
    }),
    [],
  );
}

/** Pictures dropped or pasted on the composer join the board; a paste of only their names adds no text. */
function fileDropHandlers(disabled: boolean, addFiles: (files: FileList | File[]) => void) {
  return {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      if ([...event.dataTransfer.items].some((item) => item.kind === "file")) event.preventDefault();
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (disabled) return;
      const files = event.dataTransfer.files;
      if (files?.length) {
        event.preventDefault();
        addFiles(files);
      }
    },
    onPaste: (event: ClipboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      const files = pastedFiles(event.clipboardData);
      if (!files.length) return;
      addFiles(files);
      if (pasteIsOnlyNames(event.clipboardData, files)) event.preventDefault();
    },
  };
}

/** The context meter's inputs, passed through from the chat. */
interface ComposerLimitsInput {
  contextUsage?: ContextUsage | null;
  contexts?: ContextUsage[];
  onCompact?: () => void;
  compacting?: boolean;
  compactBusy?: boolean;
}

interface ComposerToolbarProps {
  model: ComposerModelProps;
  permissions: ComposerPermissions | null;
  gameMode: boolean;
  disabled: boolean;
  coordinating: boolean;
  project?: string | null;
  loop: ReturnType<typeof useLoopSettings>;
  limits: ComposerLimitsInput;
  panelRef: RefObject<HTMLDivElement | null>;
  addMenuRef: RefObject<AddMenuHandle | null>;
  modelMenuRef: RefObject<ModelMenuHandle | null>;
  /** A blocked send's beat while Connect AI model is lit (`useModelNudge`), else null. */
  modelNudge: number | null;
  mentions: ReturnType<typeof useMention>;
  mentionSide: "top" | "bottom";
  onPickImages: () => void;
  onClosed: () => void;
  send: JSX.Element;
}

/** The composer's toolbar: Add (or attach), Mode, permissions, then the limits, the model, the effort and Send. */
function ComposerToolbar(props: ComposerToolbarProps): JSX.Element {
  const { gameMode, loop, permissions } = props;
  const { view } = loop;
  // Mode's Loop changes only while no build owns the chat.
  const reach = modeMenuReach({ view, coordinating: props.coordinating });
  const toolbar = useRef<HTMLDivElement>(null);
  useToolbarFit(toolbar);
  return (
    <div ref={toolbar} className="flex min-w-0 items-center gap-1" data-composer-toolbar>
      <AttachControl {...props} />
      {gameMode && (
        <ComposerModeMenu
          value={view.shown}
          onChange={reach.changes ? loop.chooseLoop : undefined}
          disabled={!reach.opens}
          loopUnavailable={view.loopUnavailable === true}
          unavailableWhy={loop.gate}
        />
      )}
      {gameMode && permissions && (
        <ComposerPermissionMenu
          mode={permissions.mode}
          onMode={permissions.onMode}
          autoUnavailable={permissions.autoUnavailable}
          engine={permissions.engine}
          disabled={props.disabled}
        />
      )}
      {gameMode && loop.planOn && <PlanModeOff onOff={() => loop.setReviewPlan(false)} disabled={props.disabled} />}
      {/* The flexible space: its margin takes back its own gap, so at no width it costs the name nothing. */}
      <div className="-ms-1 min-w-0 flex-1" />
      <ModelControls {...props} />
      {props.send}
    </div>
  );
}

/** Add with its @ mention list in a game; a plain attach-images button in the Harness chat. */
function AttachControl({
  gameMode,
  project,
  disabled,
  loop,
  panelRef,
  addMenuRef,
  mentions,
  mentionSide,
  onPickImages,
}: ComposerToolbarProps): JSX.Element {
  if (gameMode) {
    return (
      <ComposerAddMenu
        ref={addMenuRef}
        project={project}
        anchor={panelRef}
        disabled={disabled}
        plan={{ on: loop.planOn, available: loop.planAvailable, onChange: loop.setReviewPlan }}
        onReferences={onPickImages}
        mention={mentions.mention?.query ?? null}
        listId={mentions.mentionListId}
        onMention={mentions.insertMention}
        onMentionClose={() => mentions.setMention(null)}
        onActiveOption={mentions.setMentionOption}
        tagging={{ tagged: mentions.taggedNow, atCap: mentions.atCap, onPick: mentions.insertDoc, side: mentionSide }}
      />
    );
  }
  return (
    <ComposerTip align="start" content="Attach images">
      <button
        type="button"
        aria-label="Attach images"
        disabled={disabled}
        onClick={onPickImages}
        className="composer-icon composer-add"
      >
        <Icon name="image" />
      </button>
    </ComposerTip>
  );
}

/** The limits, the model menu (with roles in a game) and the effort. */
function ModelControls({
  model,
  gameMode,
  disabled,
  loop,
  limits,
  modelMenuRef,
  modelNudge,
  onClosed,
  project,
}: ComposerToolbarProps): JSX.Element | null {
  const { choices: models, selected: modelKey, onPick: onModel, roles = null, onRoles, onEffort } = model;
  const { view } = loop;
  const effortControl = onEffort ? (
    <ComposerEffort
      efforts={model.efforts ?? []}
      value={model.effort ?? null}
      onChange={onEffort}
      disabled={disabled}
      onClosed={onClosed}
    />
  ) : null;
  // The Harness chat has one conversation model: the same menu, without roles.
  if (!gameMode) {
    if (models.length === 0) return null;
    return (
      <>
        <ModelMenu
          ref={modelMenuRef}
          choices={models}
          modelKey={modelKey}
          onModel={onModel}
          disabled={disabled}
          onClosed={onClosed}
        />
        {effortControl}
      </>
    );
  }
  const limitsControl = (
    <ComposerLimits
      models={models}
      modelKey={modelKey}
      usage={limits.contextUsage}
      contexts={limits.contexts}
      onCompact={limits.onCompact}
      compacting={limits.compacting}
      compactBusy={limits.compactBusy}
      usedBy={rolesInUse(modelKey, roles, Boolean(onRoles) && view.shown.on)}
      project={project}
    />
  );
  if (models.length === 0)
    return (
      <>
        {limitsControl}
        <ConnectModelButton beat={modelNudge} />
      </>
    );
  return (
    <>
      {limitsControl}
      <ModelMenu
        ref={modelMenuRef}
        choices={models}
        modelKey={modelKey}
        onModel={onModel}
        roles={roles}
        onRoles={onRoles}
        disabled={disabled}
        onClosed={onClosed}
      />
      {effortControl}
    </>
  );
}
