/**
 * Live backgrounds a model made for home, kept on this Mac only: a name, the words they were made
 * from and their shader body. Read back through the same static checks a new one passes, so a
 * hand-edited entry never reaches the GPU unchecked.
 */
import { useSyncExternalStore } from "react";
import { SHADER_PROMPT_MAX_CHARS, SHADER_TITLE_MAX_CHARS, shaderProblem } from "../../shared/backdrop-shader.ts";
import { readText, STORAGE_KEYS, writeText } from "../storage.ts";

/** How many made backgrounds are kept. */
export const MAX_MADE_SHADERS = 12;
const PREFIX = "custom:";
const ID = /^custom:[A-Za-z0-9-]+$/;

/** A background a model made. */
export interface MadeShader {
  id: string;
  title: string;
  prompt: string;
  wgsl: string;
  at: number;
}

/** A stored entry as a made background, or null when it is not one. */
function madeFrom(value: unknown): MadeShader | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const { id, title, prompt, wgsl, at } = entry;
  if (typeof id !== "string" || !ID.test(id) || typeof title !== "string" || typeof prompt !== "string") return null;
  if (typeof wgsl !== "string" || shaderProblem(wgsl) || typeof at !== "number") return null;
  return {
    id,
    title: title.slice(0, SHADER_TITLE_MAX_CHARS),
    prompt: prompt.slice(0, SHADER_PROMPT_MAX_CHARS),
    wgsl,
    at,
  };
}

/** The stored list read back: entries it cannot use are let go, oldest first, at most the cap. */
export function readMadeShaders(raw: string | null): MadeShader[] {
  let saved: unknown;
  try {
    saved = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  const made = saved.map(madeFrom).filter((entry): entry is MadeShader => entry !== null);
  const unique = made.filter((entry, index) => made.findIndex((other) => other.id === entry.id) === index);
  return unique.sort((a, b) => a.at - b.at).slice(-MAX_MADE_SHADERS);
}

let current: MadeShader[] | null = null;
const listeners = new Set<() => void>();

function list(): MadeShader[] {
  current ??= readMadeShaders(readText(STORAGE_KEYS.homeBackdropShaders));
  return current;
}

function save(next: MadeShader[]): void {
  current = next;
  writeText(STORAGE_KEYS.homeBackdropShaders, JSON.stringify(next));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The made backgrounds, kept up to date. */
export function useMadeShaders(): MadeShader[] {
  return useSyncExternalStore(subscribe, list);
}

/** The made background `id` names, if it is still kept. */
export function madeShader(id: string): MadeShader | undefined {
  return list().find((entry) => entry.id === id);
}

/** Whether another background can be kept. */
export function madeShadersFull(): boolean {
  return list().length >= MAX_MADE_SHADERS;
}

/** Keep a background a model made; null when the list is full or the body fails the checks. */
export function addMadeShader(made: Pick<MadeShader, "title" | "prompt" | "wgsl">): MadeShader | null {
  if (madeShadersFull()) return null;
  const entry = madeFrom({ ...made, id: `${PREFIX}${crypto.randomUUID()}`, at: Date.now() });
  if (!entry) return null;
  save([...list(), entry]);
  return entry;
}

/** Forget a made background. */
export function removeMadeShader(id: string): void {
  save(list().filter((entry) => entry.id !== id));
}

/** Put a better body (and name) in place of a made background's, keeping its place; false when it is gone or the body fails the checks. */
export function improveMadeShader(id: string, better: Pick<MadeShader, "title" | "wgsl">): boolean {
  const kept = madeShader(id);
  const entry = kept ? madeFrom({ ...kept, ...better }) : null;
  if (!entry) return false;
  save(list().map((other) => (other.id === id ? entry : other)));
  return true;
}
