/**
 * A model server the person runs themselves (LM Studio, llama.cpp, TabbyAPI, vLLM, KoboldCpp, an
 * Ollama elsewhere on the network), reached through its OpenAI-compatible API: what Settings
 * shows about it and the typed answers of connecting one. The engine is
 * `substrate/engines/local-server.ts`; its address rules are `substrate/local-server/address.ts`.
 */
import type { EngineStatus } from "./engine-descriptor.ts";

/** Which server software answers at the saved address, when the app can tell. Wire values: never rename one. */
export const LocalServerKind = {
  TabbyApi: "tabbyapi",
  LlamaCpp: "llama-cpp",
  LmStudio: "lm-studio",
  Vllm: "vllm",
  KoboldCpp: "koboldcpp",
  Ollama: "ollama",
} as const;
export type LocalServerKind = (typeof LocalServerKind)[keyof typeof LocalServerKind];

/** Each server software by the name its own window and docs use. */
export const LOCAL_SERVER_NAMES = {
  [LocalServerKind.TabbyApi]: "TabbyAPI",
  [LocalServerKind.LlamaCpp]: "llama.cpp",
  [LocalServerKind.LmStudio]: "LM Studio",
  [LocalServerKind.Vllm]: "vLLM",
  [LocalServerKind.KoboldCpp]: "KoboldCpp",
  [LocalServerKind.Ollama]: "Ollama",
} as const satisfies Record<LocalServerKind, string>;

/** Why a typed address cannot be a local server's. Wire values: never rename one. */
export const AddressProblem = {
  Empty: "empty",
  Malformed: "malformed",
  /** Not `http:` or `https:`. */
  Scheme: "scheme",
  /** A user name or password inside the address, where it would ride every log line. */
  Credentials: "credentials",
  /** Some address it names is outside this computer and the local network. */
  NotLocal: "not_local",
  /** A name nothing on the network answers to. */
  NotFound: "not_found",
} as const;
export type AddressProblem = (typeof AddressProblem)[keyof typeof AddressProblem];

/** Why connecting a server saved nothing: its address, or what the server answered. Wire values. */
export const LocalServerProblem = {
  ...AddressProblem,
  /** Nothing answers at the address. */
  NotAnswering: "not_answering",
  /** It answers, but not with an OpenAI-compatible model list. */
  NotOpenAi: "not_openai",
  /** It asks for an API key and none was given. */
  NeedsKey: "needs_key",
  /** It refused the key that was given. */
  KeyRefused: "key_refused",
  /** What was given cannot be a key (a space, a newline, far too long). */
  BadKey: "bad_key",
  /** The Ollama on this computer, which the app already reaches as its own provider. */
  OwnOllama: "own_ollama",
  /** The OS secret store is locked, so the key cannot be kept. */
  StoreLocked: "store_locked",
} as const;
export type LocalServerProblem = (typeof LocalServerProblem)[keyof typeof LocalServerProblem];

/** What the engine descriptor says about the saved server: its address and software, never its key. */
export interface LocalServerInfo {
  /** The API's base URL, as saved (`http://127.0.0.1:5000/v1`). */
  url: string;
  kind: LocalServerKind | null;
  /** An API key is saved for it. */
  hasKey: boolean;
}

/**
 * The answer to Connect: saved, with the engine's status; or why nothing was saved, with the
 * software that answered when it asked for a key (so Settings can say where that server keeps it).
 */
export type LocalServerConnectResult =
  | { ok: true; status: EngineStatus }
  | { ok: false; problem: LocalServerProblem; kind?: LocalServerKind | null };

/** A server found answering on this computer: where, which, and whether it wants a key. */
export interface FoundLocalServer {
  url: string;
  kind: LocalServerKind | null;
  needsKey: boolean;
  /** How many models it lists; zero while it asks for a key. */
  models: number;
}
