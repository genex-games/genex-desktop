/**
 * Which face the local server's row in Settings → Model Providers shows, and what it says about
 * the saved server and its models. Pure: the row (`LocalServerRow.tsx`) renders what these decide.
 */
import { type EngineStatus, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import {
  LOCAL_SERVER_NAMES,
  type LocalServerConnectResult,
  type LocalServerInfo,
  LocalServerKind,
  LocalServerProblem,
} from "../../shared/local-server.ts";
import type { EngineDescriptor } from "../types.ts";
import { formatTokens } from "../chat-labels.ts";
import { LOCAL_SERVER_WORDS } from "../words.ts";

const WORDS = LOCAL_SERVER_WORDS;

/** The row's states, from nothing saved to connected. */
export const LocalServerRowState = {
  NotSetUp: "not_set_up",
  Connecting: "connecting",
  Connected: "connected",
  NotRunning: "not_running",
  NeedsKey: "needs_key",
  NoModels: "no_models",
  Unreachable: "unreachable",
} as const;
export type LocalServerRowState = (typeof LocalServerRowState)[keyof typeof LocalServerRowState];

/** Each status of a saved server as the row's state; any other is a server the row could not check. */
const SAVED_STATES: Partial<Record<EngineStatus["code"], LocalServerRowState>> = {
  [EngineStatusCode.Ready]: LocalServerRowState.Connected,
  [EngineStatusCode.NotRunning]: LocalServerRowState.NotRunning,
  [EngineStatusCode.NeedsLogin]: LocalServerRowState.NeedsKey,
  [EngineStatusCode.NotInstalled]: LocalServerRowState.NoModels,
};

/** The row's state from the engine's status and saved server, and whether the row is connecting now. */
export function localServerRowState(
  engine: { status: Pick<EngineStatus, "code">; server?: LocalServerInfo | null },
  local: { connecting: boolean },
): LocalServerRowState {
  if (local.connecting) return LocalServerRowState.Connecting;
  if (!engine.server) return LocalServerRowState.NotSetUp;
  return SAVED_STATES[engine.status.code] ?? LocalServerRowState.Unreachable;
}

/** `127.0.0.1:5000`: a server's address as a person reads it. */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The software's own name, or null for a server Genex cannot name. */
export const kindName = (kind: LocalServerKind | null | undefined): string | null =>
  kind ? LOCAL_SERVER_NAMES[kind] : null;

/** "TabbyAPI at 127.0.0.1:5000", or the address alone. */
export function serverLine(server: Pick<LocalServerInfo, "url" | "kind">): string {
  return WORDS.serverAt(kindName(server.kind), serverHost(server.url));
}

/** What a model of the server is: its context (or the server's note when it reports none), its sight, its tools. */
export function modelDetails(model: EngineDescriptor["models"][number]): string {
  const parts = [model.note ?? WORDS.context(formatTokens(model.contextWindow))];
  if (model.supportsVision) parts.push(WORDS.seesImages);
  if (!model.supportsTools) parts.push(WORDS.cannotCallTools);
  return parts.join(" · ");
}

/** A connection that saved nothing: why, and which server answered when it asked for a key. */
export type Refusal = Extract<LocalServerConnectResult, { ok: false }>;

/** The problems that mean "paste a key": the row's hint says where that server keeps it. */
const KEY_PROBLEMS: ReadonlySet<LocalServerProblem> = new Set([
  LocalServerProblem.NeedsKey,
  LocalServerProblem.KeyRefused,
]);

/** Where a server keeps the key it asks for, when Genex knows; null for any other. */
const keyHint = (kind: LocalServerKind | null | undefined): string | null =>
  kind === LocalServerKind.TabbyApi ? WORDS.tabbyKeyHint : null;

/** Did the server ask for a key: none was given, or it refused the one that was? */
export const isKeyRefusal = (refusal: Refusal | null): boolean => refusal !== null && KEY_PROBLEMS.has(refusal.problem);

/** The hint under the address form: where the server keeps its key, once it asked for one. */
export function addressHint(refusal: Refusal | null): string | null {
  return refusal && isKeyRefusal(refusal) ? keyHint(refusal.kind) : null;
}

/** The hint under a saved server's key field: where the server that answered keeps its key. */
export function savedKeyHint(refusal: Refusal | null, server: Pick<LocalServerInfo, "kind"> | null): string | null {
  return addressHint(refusal) ?? keyHint(server?.kind);
}

/** The hint under the row: where the server keeps its key, while the row asks for an address or a key. */
export function rowHint(
  asks: { address: boolean; key: boolean },
  refusal: Refusal | null,
  server: Pick<LocalServerInfo, "kind"> | null,
): string | null {
  if (asks.address) return addressHint(refusal);
  return asks.key ? savedKeyHint(refusal, server) : null;
}

/** What the row says went wrong: the last action's error, else why the last connection saved nothing. */
export function rowProblem(error: string | null, refusal: Refusal | null): string | null {
  return error ?? (refusal ? WORDS.problem[refusal.problem] : null);
}
