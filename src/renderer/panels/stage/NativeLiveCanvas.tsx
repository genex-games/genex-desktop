/**
 * Live's canvas for a C++ game's Mac build (Native): the game runs headless and hands each frame
 * over as a `VideoFrame` (`window.studio.nativeFrames`); this draws it with WebGL2 and the preload
 * closes and releases it once the listener returns. Being part of the page, popovers, dialogs and
 * Builds draw over it by themselves. A click captures the keyboard and mouse for the game (Esc or ⌘
 * gives them back); captured input reaches the game through `nativeInput`, batched per frame. The
 * canvas holds the embedded run while it is mounted (`hold`), and tells the game its new size as the
 * slot changes. `native-live.ts` decides what it draws, sends and says; this wires it to the DOM.
 */
import type { JSX, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BootStage,
  type NativeInputAction,
  NativeRunState,
  type NativeRunStatus,
} from "../../../shared/native-contract.ts";
import type { CompiledStack } from "../../../shared/game-project.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { CLOCK_TICK_MS } from "../../asset-making.ts";
import { useNative } from "../../state/hooks.ts";
import { nativeEmbedOf, nativeStoreFor } from "../../state/native.ts";
import { studio } from "../../state/studio.ts";
import { Button } from "../../ui/Button.tsx";
import { NATIVE_WORDS } from "../../words.ts";
import { TroubleDetails } from "./build-problem.tsx";
import {
  awaitsFirstFrame,
  buildingWords,
  CanvasAction,
  CanvasPhase,
  canvasActions,
  canvasPhase,
  canvasWords,
  createFrameGate,
  embedSizeOf,
  heldAfter,
  mouseButtonOf,
  NO_HELD,
  padAction,
  padChanges,
  pointerMoveAction,
  queueAction,
  releaseActions,
  releasesCapture,
  resizeDue,
  type ShownRun,
  startingProgress,
  textAction,
} from "./native-live.ts";

/** A wheel line, in the DOM pixels the game counts a wheel turn in (`deltaMode` 1). */
const WHEEL_LINE_PX = 16;

/** The canvas card's button words. */
const ACTION_WORDS: Record<CanvasAction, string> = {
  [CanvasAction.TryAgain]: NATIVE_WORDS.tryAgain,
  [CanvasAction.Restart]: NATIVE_WORDS.restart,
  [CanvasAction.PopOut]: NATIVE_WORDS.embed.popOut,
};

/** A full-screen triangle; `uv` is in GL coordinates, so the game's bottom-up rows need no flip. */
const VERTEX_SHADER = `#version 300 es
out vec2 uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D frame;
in vec2 uv;
out vec4 color;
void main() {
  color = vec4(texture(frame, uv).rgb, 1.0);
}`;

/** Draws one frame at a time onto the canvas; null where this page has no WebGL2. */
interface FrameRenderer {
  draw(frame: VideoFrame, width: number, height: number): void;
  dispose(): void;
}

/** One compiled shader, or null when it did not compile. */
function shader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const compiled = gl.createShader(type);
  if (!compiled) return null;
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  return gl.getShaderParameter(compiled, gl.COMPILE_STATUS) ? compiled : null;
}

/** The two shaders linked, or null. */
function program(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const linked = gl.createProgram();
  if (!vertex || !fragment || !linked) return null;
  gl.attachShader(linked, vertex);
  gl.attachShader(linked, fragment);
  gl.linkProgram(linked);
  return gl.getProgramParameter(linked, gl.LINK_STATUS) ? linked : null;
}

/**
 * A WebGL2 renderer for `canvas`: `texImage2D(VideoFrame)` into one texture, no colour-space
 * conversion (the frame is already sRGB), drawn as one triangle. The backing store follows each
 * frame's size, which is the ring's; CSS keeps the slot's.
 */
function createRenderer(canvas: HTMLCanvasElement): FrameRenderer | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  const linked = gl ? program(gl) : null;
  const texture = gl?.createTexture() ?? null;
  if (!gl || !linked || !texture) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
  gl.useProgram(linked);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  for (const [name, value] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, name, value);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  return {
    draw(frame, width, height) {
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteProgram(linked);
    },
  };
}

/** Whether `frame` is a `VideoFrame` this page can draw (the preload hands one over through the bridge). */
const isVideoFrame = (frame: unknown): frame is VideoFrame =>
  typeof VideoFrame !== "undefined" && frame instanceof VideoFrame;

/**
 * Draws the shown run's frames while mounted: one `nativeFrames` subscription, a frame drawn
 * synchronously inside the listener (the preload closes it after), one at a time. False once
 * WebGL2 turned out to be missing; a lost context is drawn again once it is restored.
 */
function useFrames(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  shown: ShownRun | null,
): { drawable: boolean; drawnRun: string | null } {
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [drawable, setDrawable] = useState(true);
  const [drawnRun, setDrawnRun] = useState<string | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer = createRenderer(canvas);
    setDrawable(renderer !== null);
    const gate = createFrameGate();
    const lost = (event: Event): void => {
      event.preventDefault();
      renderer = null;
    };
    const restored = (): void => {
      renderer = createRenderer(canvas);
      setDrawable(renderer !== null);
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    const stop = window.studio.nativeFrames((frame, meta) => {
      const current = renderer;
      if (!current || !isVideoFrame(frame)) return;
      gate.draw(meta, shownRef.current, () => current.draw(frame, meta.width, meta.height));
      // React skips the update when the run is the same: one render per run's first frame.
      setDrawnRun(gate.drawnRun());
    });
    return () => {
      stop();
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      renderer?.dispose();
    };
  }, [canvasRef]);
  return { drawable, drawnRun };
}

/**
 * Holds `project`'s embedded run at the slot's size while mounted, and tells the game each new size
 * at most once per frame (main debounces into a new ring). A size the game could not take yet (no
 * run so far) is sent again once the run is ready. The returned size is what Try again asks for.
 */
function useEmbedHold(box: RefObject<HTMLDivElement | null>, project: string, ready: boolean) {
  const sent = useRef<ReturnType<typeof embedSizeOf>>(null);
  const measured = useRef<ReturnType<typeof embedSizeOf>>(null);
  const schedule = useRef<() => void>(() => {});
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const store = nativeStoreFor(studio().api);
    let release: (() => void) | null = null;
    let frame = 0;
    const flush = (): void => {
      frame = 0;
      const size = measured.current;
      if (!release) {
        if (size) release = store.hold(project, size);
        sent.current = size;
        return;
      }
      const due = resizeDue(sent.current, size);
      if (!due) return;
      sent.current = due;
      store.resized(project, due);
      void window.studio
        .nativeResize(project, due)
        .then((taken) => {
          if (!taken && sent.current === due) sent.current = null;
        })
        .catch(() => {});
    };
    // The slot's exact device pixels, from the observer's device-pixel box where the browser
    // reports one: the ring then matches the canvas pixel for pixel (no compositor resample).
    let device: { width: number; height: number } | undefined;
    schedule.current = () => {
      measured.current = embedSizeOf(element.getBoundingClientRect(), window.devicePixelRatio, device);
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const observe = (): void => schedule.current();
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.devicePixelContentBoxSize?.[0];
      device = box ? { width: box.inlineSize, height: box.blockSize } : undefined;
      observe();
    });
    try {
      observer.observe(element, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(element);
    }
    window.addEventListener("resize", observe);
    observe();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", observe);
      cancelAnimationFrame(frame);
      schedule.current = () => {};
      release?.();
    };
  }, [box, project]);
  useEffect(() => {
    if (ready) schedule.current();
  }, [ready]);
  return measured;
}

/** Per-capture bookkeeping: what waits for the next frame, what the game holds, the pads last sent, whether it looks with the mouse. */
interface CaptureState {
  queue: NativeInputAction[];
  held: typeof NO_HELD;
  pads: ReturnType<typeof padChanges>["last"];
  composing: boolean;
  mouseLook: boolean;
}

/** The pads connected now, in the standard mapping's bounds. */
function connectedPads() {
  const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
  return pads.flatMap((pad) => {
    const action = pad ? padAction(pad) : null;
    return action ? [action] : [];
  });
}

/** Listens on the hidden field while captured: keys by DOM code, committed text; Esc and ⌘ release. */
function listenKeyboard(
  input: HTMLTextAreaElement,
  push: (action: NativeInputAction) => void,
  state: CaptureState,
  signal: AbortSignal,
): void {
  input.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing || state.composing) return;
      event.stopPropagation();
      if (releasesCapture(event.key)) {
        // Esc was the release; ⌘ reaches the app's shortcuts once the field has let the keyboard go.
        if (event.key === "Escape") event.preventDefault();
        input.blur();
        return;
      }
      if (event.key === "Tab") event.preventDefault();
      if (!event.repeat && event.code) push({ type: "down", keys: [event.code] });
    },
    { signal },
  );
  input.addEventListener(
    "keyup",
    (event) => {
      event.stopPropagation();
      if (state.held.keys.includes(event.code)) push({ type: "up", keys: [event.code] });
    },
    { signal },
  );
  input.addEventListener(
    "beforeinput",
    (event) => {
      if (event.isComposing || state.composing) return;
      const text = event.inputType === "insertText" && event.data ? textAction(event.data) : null;
      if (text) push(text);
      // The field stays empty: the game, not the field, takes what was typed.
      event.preventDefault();
    },
    { signal },
  );
  input.addEventListener(
    "compositionstart",
    () => {
      state.composing = true;
    },
    { signal },
  );
  input.addEventListener(
    "compositionend",
    (event) => {
      state.composing = false;
      const text = textAction(event.data);
      if (text) push(text);
      input.value = "";
    },
    { signal },
  );
}

/** Whether Live's canvas holds the pointer lock (mouse look). */
const lockedBy = (element: HTMLElement): boolean => document.pointerLockElement === element;

/** Ask for the pointer lock on `element`; a refusal (no gesture, the window not focused) leaves the cursor free. */
function lockPointer(element: HTMLElement): void {
  try {
    const asked: unknown = element.requestPointerLock();
    if (asked instanceof Promise) asked.catch(() => {});
  } catch {
    // The canvas keeps the keyboard and a free cursor; the next press asks again.
  }
}

/**
 * Listens on the canvas while captured: buttons, the wheel, and a move as the place in the game's
 * ring (the last frame's size) or, while the pointer is locked for mouse look, as look. A press
 * while a mouse-look game's pointer is free asks for the lock again.
 */
function listenPointer(
  element: HTMLElement,
  canvas: HTMLCanvasElement,
  push: (action: NativeInputAction) => void,
  state: CaptureState,
  signal: AbortSignal,
): void {
  const move = (event: PointerEvent): void => {
    const ring = { width: canvas.width, height: canvas.height };
    const at = { locked: lockedBy(element), rect: element.getBoundingClientRect(), ring, dpr: window.devicePixelRatio };
    const action = pointerMoveAction(event, at);
    if (action) push(action);
  };
  element.addEventListener("pointermove", move, { signal });
  element.addEventListener(
    "pointerdown",
    (event) => {
      // No focus change: the hidden field keeps the keyboard.
      event.preventDefault();
      if (state.mouseLook && !lockedBy(element)) lockPointer(element);
      move(event);
      const button = mouseButtonOf(event.button);
      if (button) push({ type: "mousedown", button });
      element.setPointerCapture(event.pointerId);
    },
    { signal },
  );
  element.addEventListener(
    "pointerup",
    (event) => {
      move(event);
      const button = mouseButtonOf(event.button);
      if (button && state.held.buttons.includes(button)) push({ type: "mouseup", button });
    },
    { signal },
  );
  element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const scale = [1, WHEEL_LINE_PX, element.clientHeight][event.deltaMode] ?? 1;
      push({ type: "scroll", dx: event.deltaX * scale, dy: event.deltaY * scale });
    },
    { signal, passive: false },
  );
  element.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
}

/** While captured with mouse look: the pointer lock ending (Esc, the system taking it) releases the capture too. */
function listenLock(element: HTMLElement, input: HTMLTextAreaElement, signal: AbortSignal): void {
  let locked = lockedBy(element);
  document.addEventListener(
    "pointerlockchange",
    () => {
      const now = lockedBy(element);
      if (locked && !now) input.blur();
      locked = now;
    },
    { signal },
  );
}

/**
 * Click-to-capture. While captured, keys, text, pointer, wheel and pads go to the game, batched
 * into one `nativeInput` per animation frame; nothing goes while not. A game played with mouse
 * look (`mouseLook`) also takes the pointer lock, as the web game's page does, and its moves are
 * look. Esc, ⌘, a click elsewhere, Genex losing focus or the canvas losing its place release it,
 * the lock with it, and everything held is let go.
 */
function useCapture(
  project: string,
  refs: {
    box: RefObject<HTMLDivElement | null>;
    canvas: RefObject<HTMLCanvasElement | null>;
    keyboard: RefObject<HTMLTextAreaElement | null>;
  },
  enabled: boolean,
  mouseLook: boolean,
) {
  const { box, canvas: canvasRef, keyboard } = refs;
  const [captured, setCaptured] = useState(false);
  const send = useCallback(
    (actions: NativeInputAction[]): void => {
      if (actions.length > 0) void window.studio.nativeInput(project, actions).catch(() => {});
    },
    [project],
  );
  useEffect(() => {
    if (!enabled) setCaptured(false);
  }, [enabled]);
  useEffect(() => {
    const element = box.current;
    const canvas = canvasRef.current;
    const input = keyboard.current;
    if (!captured || !element || !canvas || !input) return;
    const state: CaptureState = { queue: [], held: NO_HELD, pads: new Map(), composing: false, mouseLook };
    const push = (action: NativeInputAction): void => {
      state.queue = queueAction(state.queue, action);
      state.held = heldAfter(state.held, action);
    };
    let frame = 0;
    const tick = (): void => {
      const pads = padChanges(state.pads, connectedPads());
      state.pads = pads.last;
      for (const pad of pads.actions) push(pad);
      const actions = state.queue;
      state.queue = [];
      send(actions);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const listening = new AbortController();
    listenKeyboard(input, push, state, listening.signal);
    listenPointer(element, canvas, push, state, listening.signal);
    if (mouseLook) listenLock(element, input, listening.signal);
    input.addEventListener("blur", () => setCaptured(false), { signal: listening.signal });
    return () => {
      cancelAnimationFrame(frame);
      listening.abort();
      send([...state.queue, ...releaseActions(state.held)]);
      if (lockedBy(element)) document.exitPointerLock();
      if (document.activeElement === input) input.blur();
    };
  }, [captured, box, canvasRef, keyboard, send, mouseLook]);
  const capture = useCallback((): void => {
    if (!enabled) return;
    keyboard.current?.focus({ preventScroll: true });
    // Asked inside the press itself: a pointer lock needs the person's gesture.
    if (mouseLook && box.current) lockPointer(box.current);
    setCaptured(true);
  }, [enabled, keyboard, mouseLook, box]);
  return { captured, capture };
}

/** The run the canvas shows, for the frame filter: none until the host named one. */
const shownOf = (status: NativeRunStatus | null): ShownRun | null =>
  status ? { project: status.project, runId: status.runId } : null;

/** What a Mac build under way is: of the build copy Live shows or of the game folder, and the game's stack. */
export interface CanvasBuild {
  copy: boolean;
  stack: CompiledStack | null;
}

/** Now, moving on once a second while `running`: the clock a build under way is counted on. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** What the canvas says over the game when it is not simply playing, with its buttons. */
function CanvasCard({
  phase,
  status,
  build,
  popOut,
  onAction,
}: {
  phase: CanvasPhase;
  status: NativeRunStatus | null;
  build: CanvasBuild;
  /** Whether the game has a window of its own to pop out to. */
  popOut: boolean;
  onAction: (action: CanvasAction) => void;
}): JSX.Element {
  const now = useClock(status?.state === NativeRunState.Building);
  const { title, detail } = buildingWords(status, { ...build, now }) ?? canvasWords(phase, status);
  const actions = canvasActions(phase, status, { popOut });
  const busy = phase === CanvasPhase.Starting;
  const boot = busy ? startingProgress(status) : null;
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-base/80 p-8">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span role="status" className={busy ? "chat-status-shimmer text-body-sm" : "text-body-sm font-medium text-ink"}>
          {title}
        </span>
        {detail ? <span className="text-xs leading-relaxed text-pretty text-ink-2">{detail}</span> : null}
        {boot ? (
          <span
            aria-hidden="true"
            data-stage-native-progress=""
            className="h-1 w-48 overflow-hidden rounded-full bg-ink/10"
          >
            <span
              className="block h-full origin-left rounded-full bg-accent-primary transition-transform duration-200 ease-out"
              style={{ transform: `scaleX(${boot.fill})` }}
            />
          </span>
        ) : null}
        {status?.problem ? (
          <div className="w-full text-start">
            <TroubleDetails problem={status.problem} installLines={null} />
          </div>
        ) : null}
        {actions.length > 0 ? (
          <span className="flex items-center gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                data-stage-native-canvas-action={action}
                variant={action === CanvasAction.PopOut ? "secondary" : "default"}
                onClick={() => onAction(action)}
              >
                {ACTION_WORDS[action]}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Over a ready run whose first frame has not been drawn yet: the starting card's last words, so the
 * person never sees the empty (black) canvas between the card and the game. It takes no clicks.
 */
function FirstFrameVeil(): JSX.Element {
  return (
    <div
      data-stage-native-first-frame=""
      className="pointer-events-none absolute inset-0 grid place-items-center bg-base/80 p-8"
    >
      <span aria-live="polite" className="chat-status-shimmer text-body-sm">
        {NATIVE_WORDS.boot.stage[BootStage.Frame]}
      </span>
    </div>
  );
}

/** Over a playing game: Click to play until captured, then a short hint on how to give the keyboard back. */
function CaptureHint({
  captured,
  onCapture,
  veiled,
}: {
  captured: boolean;
  onCapture: () => void;
  /** The first frame is not drawn yet: the pill waits under the veil's words, the click still captures. */
  veiled: boolean;
}): JSX.Element {
  if (captured)
    return (
      <span
        data-stage-native-hint=""
        aria-live="polite"
        className="surface-glass pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 animate-[fade-in_300ms_ease-out_2500ms_reverse_both] rounded-lg px-3 py-1.5 text-xs text-ink-2"
      >
        {NATIVE_WORDS.embed.releaseHint}
      </span>
    );
  return (
    <button
      type="button"
      data-stage-native-capture=""
      className="absolute inset-0 grid cursor-pointer place-items-center"
      onPointerDown={(event) => {
        // The press is the capture, not the game's: it never reaches the game, and focus stays on the field.
        event.preventDefault();
        onCapture();
      }}
      onClick={onCapture}
    >
      <span className={`surface-glass rounded-lg px-3 py-1.5 text-body-sm text-ink${veiled ? " invisible" : ""}`}>
        {NATIVE_WORDS.embed.clickToPlay}
      </span>
    </button>
  );
}

/**
 * Whether Live's Native view fills the screen (`native.full-screen`, main's `game-full-screen.ts`):
 * the window is full screen and the canvas covers all of it until a held Esc or the exit button.
 */
function useFullScreen(): boolean {
  const [on, setOn] = useState(false);
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type === UiEvent.NativeFullScreen) setOn(event.payload.on);
      }),
    [],
  );
  return on;
}

/** The canvas's box: in its slot, or over the whole window in full screen; out of sight while Live is not seen. */
function boxClass(active: boolean, fullScreen: boolean): string {
  if (fullScreen) return "fixed inset-0 z-50 bg-black";
  return active ? "absolute inset-0 bg-black" : "invisible absolute inset-0 bg-black";
}

/** Live's canvas for `project`'s Mac build; `active` while Live is on the stage and the stage is seen. */
export function NativeLiveCanvas({
  project,
  active,
  build,
  mouseLook,
  onPopOut,
}: {
  project: string;
  active: boolean;
  /** What a Mac build under way is made of, for the card's words. */
  build: CanvasBuild;
  /** The game is played with mouse look: a click into it takes the pointer lock (`GameProject.mouseLook`). */
  mouseLook: boolean;
  /** Null for a game with no window of its own (a Rust game): the card never offers Pop out. */
  onPopOut: (() => void) | null;
}): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const embed = useNative((state) => nativeEmbedOf(state, project));
  const { drawable, drawnRun } = useFrames(canvas, shownOf(embed.status));
  const phase = canvasPhase(embed.status, embed.failed, drawable);
  const veiled = awaitsFirstFrame(phase, embed.status, drawnRun);
  const playing = phase === CanvasPhase.Playing;
  const measured = useEmbedHold(box, project, embed.status?.state === NativeRunState.Ready);
  const fullScreen = useFullScreen();
  const seen = active || fullScreen;
  const { captured, capture } = useCapture(project, { box, canvas, keyboard }, seen && playing, mouseLook);
  // Full screen gives the game the keyboard at once, as the web view's does; mouse look still asks for its lock.
  useEffect(() => {
    if (fullScreen) capture();
  }, [fullScreen, capture]);
  const act = (action: CanvasAction): void => {
    if (action === CanvasAction.PopOut) {
      onPopOut?.();
      return;
    }
    const size = measured.current;
    if (size) void nativeStoreFor(studio().api).retryEmbed(project, size);
  };
  return (
    <div
      ref={box}
      data-stage-native-canvas={phase}
      data-captured={captured || undefined}
      data-full-screen={fullScreen || undefined}
      className={boxClass(active, fullScreen)}
    >
      <canvas ref={canvas} className="block h-full w-full" />
      <textarea
        ref={keyboard}
        aria-label={NATIVE_WORDS.embed.keyboard}
        tabIndex={-1}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="sr-only"
      />
      {playing ? <CaptureHint captured={captured} onCapture={capture} veiled={veiled} /> : null}
      {veiled ? <FirstFrameVeil /> : null}
      {playing ? null : (
        <CanvasCard phase={phase} status={embed.status} build={build} popOut={onPopOut !== null} onAction={act} />
      )}
    </div>
  );
}
