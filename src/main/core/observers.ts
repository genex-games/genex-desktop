/**
 * Genex's observers of a game at work (`shared/observers.ts`): on the harness's request a plugin's
 * observer runs its tool as a harness step told it observes (`PluginBinding.observe`), under that
 * tool's locks, the person first and the run's own holds passing as a moment of the run does. Its
 * answer is read for pictures, play frames and a note only (`hookAnswerOf`), and the pictures are
 * kept with the run (`runs/<run>/observers/`) and recorded as one `observer_capture` (files, never
 * data). A run's checkpoint whose after step is an observer's tool keeps those pictures the same
 * way. Plan mode never holds a capture: it only looks.
 */
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { CapturedImage, ObserverCaptureResult } from "../../shared/harness-api.ts";
import {
  type CapturedFile,
  OBSERVE_CALL_MS,
  type ObserverCapturePayload,
  type ObserverRef,
  ObserverSource,
  ObserveWhy,
} from "../../shared/observers.ts";
import {
  HOOK_IMAGE_MAX_BYTES,
  type HookAnswer,
  HookHold,
  type HookImage,
  hookAnswerOf,
} from "../../shared/plugin-hooks.ts";
import { type PluginBinding, PluginToolAudience } from "../../shared/plugins.ts";
import { ensureDirBelow, writeFileInDir } from "../../substrate/fsx.ts";
import { shortId } from "../../substrate/ids.ts";
import { sniffImage } from "../../substrate/image-sniff.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { HOLD_OF_REFUSAL, isLockRefused, type LockRef, type LockRefused, runHolders } from "./plugin-locks.ts";
import { runDir, safePathSegment } from "./run-shots.ts";

/** The longest an observer waits for its tool's locks (the person first). */
export const OBSERVE_LOCK_WAIT_MS = 30 * SECOND_MS;
/** The longest side of a picture handed back for a reviewer's prompt; the kept file stays as taken. */
export const OBSERVE_IMAGE_PX = 1280;
/**
 * What a capture keeps free before the asker's time: keeping, recording and shrinking its pictures,
 * and the answer's trip back. No observer is told, nor waits, past the time before it.
 */
export const OBSERVE_KEEP_MS = 3 * SECOND_MS;

/** The folder of a run's captures, one folder per observer below it. */
const OBSERVERS_FOLDER = "observers";
/** The kinds of picture a capture keeps. */
const KEPT_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

/** What a capture says, the reviewer and the log read. */
const MESSAGE = {
  notThisGamesRun: "That run is not a run of this game.",
  unknownObserver: (key: string) => `This game has no observer ${key} of a plugin that is on.`,
  noObserver: "Its plugin no longer has this observer.",
  failed: (why: string) => `couldn't capture: ${why}`,
  noTime: "no time to look",
  tooSlow: "couldn't capture: it took longer than an observer's time.",
  label: (plugin: string, id: string) => `${plugin}: ${id}`,
  checkpointLabel: (plugin: string, id: string, at: string) => `${plugin}: ${id} at "${at}"`,
  logNotKept: (project: string, why: string) => `[core] checkpoint pictures in ${project} not kept: ${why}`,
} as const;

/** A lock not given, in Genex's words: what held it and the lock's label, never the refusal's own text. */
const HELD_WORDS = {
  [HookHold.PersonFirst]: (label: string) => `The person was using ${label}, so Genex took no picture there.`,
  [HookHold.CantTell]: (label: string) =>
    `Genex couldn't tell whether the person was using ${label}, so it took no picture there.`,
  [HookHold.Busy]: (label: string) => `Something else was working in ${label}, so Genex took no picture there.`,
} as const satisfies Record<(typeof HOLD_OF_REFUSAL)[keyof typeof HOLD_OF_REFUSAL], (label: string) => string>;

/** Nothing to let go: an observer whose tool needs no lock. */
const NO_RELEASE = (): void => {};

/**
 * A capture asked for: the game, its run, the chat it answers to, one observer or every one, when
 * the asker stops waiting (`until`, on the service's clock: `deadlineIn` reads it as the ask comes
 * in; every lock wait, call and keep fits before it), and Stop.
 */
export interface CaptureAsk {
  project: string;
  runId: string;
  threadId?: string;
  observer?: string;
  until?: number;
  signal?: AbortSignal;
}

/** Pictures to keep with a run as one observer's capture. */
export interface KeepAsk {
  project: string;
  runId: string;
  /** The chat the run reports to, where the record goes. */
  chat: string;
  observer: string;
  label: string;
  source: ObserverSource;
  images: readonly HookImage[];
  recording: readonly HookImage[];
  note?: string;
  problem?: string;
}

/** A checkpoint's after step that answered: what it was for, which step, and what it said. */
export interface CheckpointPictures {
  project: string;
  runId: string;
  label?: string;
  plugin: string;
  tool: string;
  answer: HookAnswer;
}

/** What one observer handed back, or the problem that kept it from looking. */
interface Observed {
  images: HookImage[];
  recording: HookImage[];
  note?: string;
  problem?: string;
}

/** One observer's run: the game, the run, its chat, the binding, when the asker stops waiting (the service's clock) and Stop. */
interface ObserveScope {
  project: string;
  runId: string;
  chat: string;
  binding: PluginBinding;
  until: number;
  signal: AbortSignal | undefined;
}

/** The clock captures run on, a test seam: what time it is, a signal that aborts once `ms` passed, and how a picture shrinks. */
export interface ObserverServiceOptions {
  now?: () => number;
  timeout?: (ms: number) => AbortSignal;
  /** A picture made at most `maxPx` on its longest side (a JPEG), or null when nothing can (the previews' own). */
  resize?: (data: Buffer, maxPx: number) => Promise<Buffer | null>;
}

/** A picture written beside its run, with its bytes for the prompt. */
interface KeptPicture extends CapturedFile {
  mimeType: string;
  bytes: Buffer;
}

/** One observer's capture as kept: its pictures with their bytes as taken, its note or problem. */
export interface KeptCapture {
  observer: string;
  label: string;
  images: KeptPicture[];
  recording: KeptPicture[];
  note?: string;
  problem?: string;
}

/** A failure's message, ending as a sentence does. */
function sentence(error: unknown): string {
  const text = String(errorMessage(error)).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A step's answer as a capture: a block or a pending answer is its problem. */
function observedOf(answer: HookAnswer): Observed {
  const problem = answer.block ?? answer.pending;
  return {
    images: problem ? [] : (answer.images ?? []),
    recording: problem ? [] : (answer.recording ?? []),
    ...(answer.note ? { note: answer.note } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** A lock refusal in Genex's words. */
const heldProblem = (refused: LockRefused): Observed => ({
  images: [],
  recording: [],
  problem: HELD_WORDS[HOLD_OF_REFUSAL[refused.code]](refused.label),
});

/** The observers a game's plugins have on, each key once (an observer reaching two folders runs once). */
function pluginObservers(refs: readonly ObserverRef[]): ObserverRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!ref.plugin || !ref.on || seen.has(ref.key)) return false;
    seen.add(ref.key);
    return true;
  });
}

/** Runs a game's observers inside a run, and keeps their pictures with it. */
export class ObserverService {
  readonly #core: StudioCore;
  readonly #x: Pick<CoreInternals, "locks" | "delegation" | "previews">;
  readonly #now: () => number;
  readonly #timeout: (ms: number) => AbortSignal;
  readonly #resize: (data: Buffer, maxPx: number) => Promise<Buffer | null>;

  constructor(
    core: StudioCore,
    x: Pick<CoreInternals, "locks" | "delegation" | "previews">,
    options: ObserverServiceOptions = {},
  ) {
    this.#core = core;
    this.#x = x;
    this.#now = options.now ?? Date.now;
    this.#timeout = options.timeout ?? ((ms) => AbortSignal.timeout(ms));
    this.#resize = options.resize ?? ((data, maxPx) => this.#x.previews.resizeStill(data, maxPx));
  }

  /** When an asker that still waits `withinMs` stops waiting, on the service's clock; never without one. */
  deadlineIn(withinMs: number | undefined): number {
    return typeof withinMs === "number" ? this.#now() + withinMs : Number.POSITIVE_INFINITY;
  }

  /** The time left before `until`, at most `cap`. */
  #leftOf(until: number, cap: number): number {
    return Math.min(cap, until - this.#now());
  }

  /**
   * Run the observers of a run of this game (one, when named), each in turn. A run that is not this
   * game's, or an observer it has not, is refused before anything runs; a failing or held observer
   * is a problem on its own capture; only a Stop ends the rest. An observer is told, and given, the
   * time up to `OBSERVE_KEEP_MS` before `until`; past that it is not asked, and one that answers after
   * it is neither kept nor recorded, so the whole answer is in before the asker stops waiting.
   */
  async capture(ask: CaptureAsk): Promise<ObserverCaptureResult[]> {
    ask.signal?.throwIfAborted();
    const until = (ask.until ?? Number.POSITIVE_INFINITY) - OBSERVE_KEEP_MS;
    const chat = await this.#x.delegation.chatOfGameRun(ask.project, ask.runId);
    if (!chat) throw new Error(MESSAGE.notThisGamesRun);
    const refs = await this.#observersOf(ask.project, ask.observer);
    const binding = await this.#binding(ask.project, chat);
    const scope: ObserveScope = { project: ask.project, runId: ask.runId, chat, binding, until, signal: ask.signal };
    const results: ObserverCaptureResult[] = [];
    for (const ref of refs) {
      ask.signal?.throwIfAborted();
      const observed = await this.#observe(ref, scope);
      ask.signal?.throwIfAborted();
      const label = this.#label(ref);
      // Past the asker's time nothing is kept: it has stopped waiting.
      if (observed.problem === MESSAGE.noTime || this.#now() >= until) {
        results.push({ observer: ref.key, label, images: [], recording: [], problem: MESSAGE.noTime });
        continue;
      }
      results.push(
        await this.#kept({ ...scope, observer: ref.key, label, source: ObserverSource.Plugin, ...observed }),
      );
    }
    return results;
  }

  /** One observer's capture kept and handed back for a prompt; pictures it could not keep are its problem. */
  async #kept(ask: KeepAsk): Promise<ObserverCaptureResult> {
    try {
      const kept = await this.keep(ask);
      return { ...kept, images: await this.#forPrompt(kept.images), recording: await this.#forPrompt(kept.recording) };
    } catch (error) {
      const problem = MESSAGE.failed(sentence(error));
      return { observer: ask.observer, label: ask.label, images: [], recording: [], problem };
    }
  }

  /**
   * Keep pictures with a run as one observer's capture: each a PNG or JPEG (by its bytes) of at most
   * `HOOK_IMAGE_MAX_BYTES`, written under the run's `observers/` folder; one `observer_capture`
   * record with the files. Answers the kept pictures with their bytes, as taken.
   */
  async keep(ask: KeepAsk): Promise<KeptCapture> {
    const { images, recording } = await this.#write(ask);
    return this.#record(ask, images, recording);
  }

  /**
   * Write a capture's pictures that Genex keeps under the run's `observers/` folder. The runs folder
   * is one an agent's box writes: a link or a file on the way is refused, never written through.
   */
  async #write(ask: KeepAsk): Promise<{ images: KeptPicture[]; recording: KeptPicture[] }> {
    const pictures = [...ask.images, ...ask.recording];
    if (!pictures.some((picture) => keptType(Buffer.from(picture.data, "base64"))))
      return { images: [], recording: [] };
    const runs = this.#core.layout.runs;
    const parts = [
      path.basename(runDir(runs, ask.runId)),
      OBSERVERS_FOLDER,
      safePathSegment(ask.observer.replace("/", "-")),
    ];
    const dir = await ensureDirBelow(runs, parts);
    const stamp = String(this.#now());
    const images = await writePictures(dir, stamp, ask.images);
    const recording = await writePictures(dir, `${stamp}-play`, ask.recording);
    return { images, recording };
  }

  /** One `observer_capture` record of the pictures kept. */
  async #record(ask: KeepAsk, images: KeptPicture[], recording: KeptPicture[]): Promise<KeptCapture> {
    const told = { ...(ask.note ? { note: ask.note } : {}), ...(ask.problem ? { problem: ask.problem } : {}) };
    const payload = {
      runId: ask.runId,
      project: ask.project,
      observer: ask.observer,
      label: ask.label,
      source: ask.source,
      images: images.map(fileOf),
      ...(recording.length ? { recording: recording.map(fileOf) } : {}),
      ...told,
      at: new Date().toISOString(),
    } satisfies ObserverCapturePayload;
    await this.#core.append([customEventData(CustomEvent.ObserverCapture, payload)], ask.chat);
    return { observer: ask.observer, label: ask.label, images, recording, ...told };
  }

  /**
   * A run's checkpoint: the pictures an after step of an observer's tool (a plugin that is on) took
   * are kept as that observer's capture. Nothing for a run that is not this game's.
   */
  async keepCheckpoint(pictures: CheckpointPictures): Promise<void> {
    const { answer } = pictures;
    if (!answer.images?.length && !answer.recording?.length) return;
    const chat = await this.#x.delegation.chatOfGameRun(pictures.project, pictures.runId);
    if (!chat) return;
    const game = await this.#core.games.kindOf(pictures.project);
    const ref = pluginObservers(this.#core.plugins.observers(game)).find(
      (one) => one.plugin === pictures.plugin && one.tool === pictures.tool,
    );
    if (!ref) return;
    const plugin = this.#pluginName(ref);
    const label = pictures.label ? MESSAGE.checkpointLabel(plugin, ref.id, pictures.label) : this.#label(ref);
    const ask: KeepAsk = {
      project: pictures.project,
      runId: pictures.runId,
      chat,
      observer: ref.key,
      label,
      source: ObserverSource.Checkpoint,
      images: answer.images ?? [],
      recording: answer.recording ?? [],
    };
    // A save point whose pictures were none Genex keeps leaves no capture; nor is anything resized here.
    const { images, recording } = await this.#write(ask);
    if (images.length || recording.length) await this.#record(ask, images, recording);
  }

  /** The words a checkpoint whose pictures could not be kept leaves in the log. */
  logNotKept(project: string, error: unknown): void {
    this.#core.options.onLog?.(MESSAGE.logNotKept(project, errorMessage(error)), "stderr");
  }

  /** The game's plugin observers that are on (only `key`'s, when named, refused when it has none). */
  async #observersOf(project: string, key: string | undefined): Promise<ObserverRef[]> {
    const game = await this.#core.games.kindOf(project);
    const refs = pluginObservers(this.#core.plugins.observers(game));
    if (key === undefined) return refs;
    const named = refs.filter((ref) => ref.key === key);
    if (!named.length) throw new Error(MESSAGE.unknownObserver(key));
    return named;
  }

  /**
   * One observer: its tool's locks, then its tool as a harness step told it observes, both within
   * the time the asker still waits. Only a Stop throws.
   */
  async #observe(ref: ObserverRef, scope: ObserveScope): Promise<Observed> {
    const step = this.#core.plugins.observerTool(ref.key);
    if (!step) return { images: [], recording: [], problem: MESSAGE.noObserver };
    const noTime: Observed = { images: [], recording: [], problem: MESSAGE.noTime };
    if (this.#leftOf(scope.until, OBSERVE_LOCK_WAIT_MS) <= 0) return noTime;
    let release = NO_RELEASE;
    try {
      release = await this.#hold(step.pluginId, step.needs, scope);
    } catch (error) {
      if (!isLockRefused(error)) throw error;
      return heldProblem(error);
    }
    // The call's time, read once its locks are held; the registry's own ceiling is longer, so the
    // call is cut at that time here.
    let withinMs = 0;
    let cut: AbortSignal | null = null;
    try {
      scope.signal?.throwIfAborted();
      withinMs = this.#leftOf(scope.until, OBSERVE_CALL_MS);
      if (withinMs <= 0) return noTime;
      cut = this.#timeout(withinMs);
      const observe = { observer: ref.key, runId: scope.runId, why: ObserveWhy.Finish, withinMs };
      const raw = await this.#core.plugins.tool(
        `${step.pluginId}__${step.tool}`,
        {},
        { ...scope.binding, observe },
        scope.signal ? AbortSignal.any([scope.signal, cut]) : cut,
        PluginToolAudience.Harness,
        withinMs,
      );
      return observedOf(hookAnswerOf(raw));
    } catch (error) {
      scope.signal?.throwIfAborted();
      // Cut at the asker's time, or at an observer's own.
      if (cut?.aborted) return withinMs < OBSERVE_CALL_MS ? noTime : { ...noTime, problem: MESSAGE.tooSlow };
      return { images: [], recording: [], problem: MESSAGE.failed(sentence(error)) };
    } finally {
      release();
    }
  }

  /** The tool's locks, held as a moment of the run: the person first, the run's own holds passing. */
  async #hold(pluginId: string, needs: readonly string[], scope: ObserveScope): Promise<() => void> {
    const refs: LockRef[] = needs.flatMap((id) => {
      const lock = this.#core.plugins.lockOf(pluginId, id);
      return lock ? [{ plugin: pluginId, lock }] : [];
    });
    if (!refs.length) return NO_RELEASE;
    return this.#x.locks.hold(refs, {
      binding: scope.binding,
      threadId: scope.chat,
      ...(scope.signal ? { signal: scope.signal } : {}),
      waitMs: Math.max(0, this.#leftOf(scope.until, OBSERVE_LOCK_WAIT_MS)),
      holder: shortId("observe"),
      passes: runHolders(scope.runId),
    });
  }

  async #binding(project: string, threadId: string): Promise<PluginBinding> {
    const binding = await this.#core.pluginBinding(project, threadId);
    if (!binding) throw new Error(MESSAGE.notThisGamesRun);
    return binding;
  }

  /** The pictures for a prompt: downscaled when something here can, else as kept. */
  async #forPrompt(pictures: readonly KeptPicture[]): Promise<CapturedImage[]> {
    const out: CapturedImage[] = [];
    for (const picture of pictures) {
      const resized = await this.#resize(picture.bytes, OBSERVE_IMAGE_PX);
      out.push({
        name: picture.name,
        file: picture.file,
        mimeType: resized ? "image/jpeg" : picture.mimeType,
        data: (resized ?? picture.bytes).toString("base64"),
      });
    }
    return out;
  }

  #label(ref: ObserverRef): string {
    return MESSAGE.label(this.#pluginName(ref), ref.id);
  }

  #pluginName(ref: ObserverRef): string {
    return this.#core.plugins.list().find((p) => p.manifest.id === ref.plugin)?.manifest.name ?? String(ref.plugin);
  }
}

/** A kept picture's record entry: its name and file. */
const fileOf = (picture: KeptPicture): CapturedFile => ({ name: picture.name, file: picture.file });

/** A picture's kind when a capture keeps it (a PNG or a JPEG by its bytes, within the size cap), else null. */
function keptType(bytes: Buffer): ReturnType<typeof sniffImage> {
  if (bytes.length > HOOK_IMAGE_MAX_BYTES) return null;
  const sniffed = sniffImage(bytes);
  return sniffed && KEPT_TYPES.has(sniffed.mimeType) ? sniffed : null;
}

/** Write each picture Genex keeps in the folder `dir` (made, by real path), in order: a PNG or a JPEG by its bytes, within the size cap. */
async function writePictures(dir: string, prefix: string, pictures: readonly HookImage[]): Promise<KeptPicture[]> {
  const kept: KeptPicture[] = [];
  for (const [index, picture] of pictures.entries()) {
    const bytes = Buffer.from(picture.data, "base64");
    const sniffed = keptType(bytes);
    if (!sniffed) continue;
    const name = `${prefix}-${index + 1}-${safePathSegment(picture.name)}${sniffed.ext}`;
    const file = path.join(dir, name);
    await writeFileInDir(dir, name, bytes);
    kept.push({ name: picture.name, file, mimeType: sniffed.mimeType, bytes });
  }
  return kept;
}
