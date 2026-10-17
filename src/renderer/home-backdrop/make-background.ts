/**
 * Make your own: a live background from a description, by the model picked on home, a filter the
 * picture is seen through or a scene of its own. The model writes a shader; this Mac's GPU compiles
 * it, and a shader that fails goes back to the model with the compiler's words, twice at most. A
 * shader that compiles is kept (`made-shaders.ts`) and shown at once; then it is drawn off screen
 * (`shader-look.ts`) and the model, shown how it looks and what stood out, writes a better one,
 * which takes its place when it compiles and is not emptier. The state outlives the panel, so
 * closing it never loses the result.
 */
import { useSyncExternalStore } from "react";
import {
  type BackdropShader,
  type BackdropShaderKind,
  type BackdropShaderRequest,
  type BackdropShaderResult,
  LookFinding,
  ShaderFailure,
} from "../../shared/backdrop-shader.ts";
import { parseModelKey } from "../model-key.ts";
import { checkShader, ShaderCheck } from "./gpu.ts";
import { addMadeShader, improveMadeShader, madeShadersFull } from "./made-shaders.ts";
import { withShader } from "./presets.ts";
import { type LookInputs, lookAt } from "./shader-look.ts";
import { updateBackdrop } from "./store.ts";

/** Where making a background is. */
export const MakePhase = {
  Idle: "idle",
  /** The model is writing the first shader. */
  Writing: "writing",
  /** The first shader failed to compile; the model is fixing it. */
  Fixing: "fixing",
  /** The shader is on home; the model, shown how it looks, is making it better. */
  Refining: "refining",
  Failed: "failed",
} as const;
export type MakePhase = (typeof MakePhase)[keyof typeof MakePhase];

/** Why making a background failed. */
export const MakeProblem = {
  ...ShaderFailure,
  /** Every shader the model wrote failed to compile. */
  Broken: "broken",
  /** No WebGPU on this Mac. */
  NoGpu: "no-gpu",
  /** Every kept background's place is taken. */
  Full: "full",
} as const;
export type MakeProblem = (typeof MakeProblem)[keyof typeof MakeProblem];

/** What the panel shows of the making. */
export interface MakeState {
  phase: MakePhase;
  problem: MakeProblem | null;
}

/** A shader that fails to compile goes back to the model this many times; a better one, once. */
const COMPILE_REPAIRS = 2;
const REFINED_REPAIRS = 1;

let state: MakeState = { phase: MakePhase.Idle, problem: null };
const listeners = new Set<() => void>();

function set(next: MakeState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The making's state, kept up to date. */
export function useMakeState(): MakeState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Forget a failure, back to a fresh start. */
export function clearMakeProblem(): void {
  if (state.phase === MakePhase.Failed) set({ phase: MakePhase.Idle, problem: null });
}

const fail = (problem: MakeProblem): void => set({ phase: MakePhase.Failed, problem });
const NO_REPLY: BackdropShaderResult = { ok: false, failure: ShaderFailure.NoReply };

/** Whether a phase is a making in progress. */
export const makingIn = (phase: MakePhase): boolean =>
  phase === MakePhase.Writing || phase === MakePhase.Fixing || phase === MakePhase.Refining;

/** What a making is asked for: the words, the model, the kind, and what its look is drawn in. */
export interface MakeRequest {
  prompt: string;
  modelKey: string | null;
  kind: BackdropShaderKind;
  look: LookInputs;
}

/** A shader the GPU compiled, or why there is none. */
type Compiled = { ok: true; shader: BackdropShader } | { ok: false; problem: MakeProblem };

const ask = (request: BackdropShaderRequest): Promise<BackdropShaderResult> =>
  window.studio.makeBackdrop(request).catch(() => NO_REPLY);

/** `result`'s shader once it compiles here, its compiler's words sent back at most `repairs` times. */
async function compiled(
  asked: BackdropShaderRequest,
  result: BackdropShaderResult,
  repairs: number,
): Promise<Compiled> {
  let written = result;
  for (let repair = 0; ; repair++) {
    if (!written.ok) return { ok: false, problem: written.failure };
    const { check, report } = await checkShader(written.shader.wgsl);
    if (check === ShaderCheck.NoGpu) return { ok: false, problem: MakeProblem.NoGpu };
    if (check === ShaderCheck.Ok) return { ok: true, shader: written.shader };
    if (repair >= repairs) return { ok: false, problem: MakeProblem.Broken };
    if (state.phase === MakePhase.Writing) set({ phase: MakePhase.Fixing, problem: null });
    written = await ask({ ...asked, repair: { wgsl: written.shader.wgsl, problem: report } });
  }
}

/**
 * Make a background from `request.prompt` on the model `request.modelKey` names (the first ready
 * one when null), keep it, show it, then make it better. One making at a time; a second does nothing.
 */
export async function makeBackground(request: MakeRequest): Promise<void> {
  const prompt = request.prompt.trim();
  if (makingIn(state.phase) || !prompt) return;
  if (madeShadersFull()) return fail(MakeProblem.Full);
  set({ phase: MakePhase.Writing, problem: null });
  const { engine, model } = parseModelKey(request.modelKey);
  const asked = { prompt, kind: request.kind, ...(engine ? { engine } : {}), ...(model ? { model } : {}) };
  const first = await compiled(asked, await ask(asked), COMPILE_REPAIRS);
  if (!first.ok) return fail(first.problem);
  const made = addMadeShader({ title: first.shader.title, prompt, wgsl: first.shader.wgsl });
  if (!made) return fail(MakeProblem.Full);
  updateBackdrop((previous) => withShader(previous, made.id));
  set({ phase: MakePhase.Refining, problem: null });
  await refine(asked, made.id, first.shader, request.look);
  set({ phase: MakePhase.Idle, problem: null });
}

/**
 * Show the model how `shader` looks and put its better one in place, keeping the name; the first
 * stays when the better one fails, cannot be drawn, or comes out empty where the first did not.
 */
async function refine(asked: BackdropShaderRequest, id: string, shader: BackdropShader, inputs: LookInputs) {
  const look = await lookAt(shader.wgsl, inputs);
  if (!look) return;
  const better = await compiled(asked, await ask({ ...asked, refine: look }), REFINED_REPAIRS);
  if (!better.ok) return;
  const after = await lookAt(better.shader.wgsl, inputs);
  const emptier = after?.findings.includes(LookFinding.Empty) && !look.findings.includes(LookFinding.Empty);
  if (!after || emptier) return;
  improveMadeShader(id, { title: shader.title, wgsl: better.shader.wgsl });
}
