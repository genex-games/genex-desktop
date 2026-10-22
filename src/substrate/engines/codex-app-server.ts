/**
 * Codex's own compaction of a session, on its app server (`codex app-server`, JSON-RPC over
 * stdio). `codex exec` has no compaction command (`/compact` there is only a prompt), so Compact
 * Now opens the session on the app server and compacts it in place (`thread/compact/start`); the
 * next `exec resume` goes on with it under the same id. Driven live against CLI 0.160:
 * `initialize`, `initialized`, `thread/resume`, `thread/compact/start`, after which the compaction's
 * own turn reports a `contextCompaction` item and ends with `turn/completed`.
 *
 * A known gap: the app server has no `--ignore-user-config`, so where the studio borrows the
 * person's own sign-in (`CODEX_HOME` is their `~/.codex`) it reads their config.toml and starts
 * their MCP servers for the few seconds it runs. No model turn runs and no tool can be called.
 */
import readline from "node:readline";
import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** One connection to an app server: messages out, messages in, and its end. */
export interface CodexAppServerConnection {
  send(message: Record<string, unknown>): void;
  messages: AsyncIterable<Record<string, unknown>>;
  close(): void;
}

/**
 * Starts `codex app-server` for one compaction or one delegation turn (`codex-turns.ts`); injected
 * in tests, as `CodexExec` is. `onStderr` hears the server's own log, which a turn keeps the end of.
 */
export type CodexAppServer = (invocation: {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onStderr?: (chunk: string) => void;
}) => CodexAppServerConnection;

/** How a compaction on the app server ended; `error` is Codex's own words when it did not compact. */
export interface CodexCompaction {
  compacted: boolean;
  error: string | null;
}

/**
 * The app server's methods the studio speaks, in their wire spelling: the requests it sends, the
 * server requests it answers and the notifications it reads (`codex-turns.ts` reads the most).
 */
export const AppServerMethod = {
  Initialize: "initialize",
  Initialized: "initialized",
  ThreadStart: "thread/start",
  ThreadResume: "thread/resume",
  ThreadCompactStart: "thread/compact/start",
  TurnStart: "turn/start",
  TurnInterrupt: "turn/interrupt",
  ItemStarted: "item/started",
  ItemCompleted: "item/completed",
  AgentMessageDelta: "item/agentMessage/delta",
  TokenUsageUpdated: "thread/tokenUsage/updated",
  TurnCompleted: "turn/completed",
  Error: "error",
  ToolCall: "item/tool/call",
  CommandApproval: "item/commandExecution/requestApproval",
  FileChangeApproval: "item/fileChange/requestApproval",
  ExecCommandApproval: "execCommandApproval",
  ApplyPatchApproval: "applyPatchApproval",
  Elicitation: "mcpServer/elicitation/request",
} as const;
export type AppServerMethod = (typeof AppServerMethod)[keyof typeof AppServerMethod];

/** The id of each request this sends: one of each, in this order. */
const RequestId = {
  Initialize: 1,
  Resume: 2,
  Compact: 3,
} as const;

/** The thread item a compaction reports, and the turn status it ends with when it compacted. */
const COMPACTION_ITEM = "contextCompaction";
const TURN_COMPLETED = "completed";

/** Who is asking, as the app server's `initialize` records it. */
export const CLIENT_INFO = { name: "genex", title: "Genex", version: "1" };

/** A polite stop's grace before the app server is killed. */
const KILL_GRACE_MS = 5 * SECOND_MS;

const MESSAGE = {
  Closed: "Codex's app server closed before the compaction finished",
  NotCompacted: "Codex did not compact the session",
  NoOutput: "Codex's app server started without an output stream",
} as const;

/** What one compaction has seen so far. */
interface CompactionState {
  compactAsked: boolean;
  compactionItem: boolean;
}

/**
 * Compacts one thread on an open app server: the session opens by its id, compacts, and the
 * answer is whether the compaction's turn completed with its compaction item.
 */
export async function compactCodexThread(server: CodexAppServerConnection, threadId: string): Promise<CodexCompaction> {
  const state: CompactionState = { compactAsked: false, compactionItem: false };
  server.send(
    request(RequestId.Initialize, AppServerMethod.Initialize, { clientInfo: CLIENT_INFO, capabilities: null }),
  );
  for await (const message of server.messages) {
    const outcome = readMessage(server, message, threadId, state);
    if (outcome) return outcome;
  }
  return { compacted: false, error: MESSAGE.Closed };
}

/** One message from the app server: the next request after an answer, or the compaction's end. */
function readMessage(
  server: CodexAppServerConnection,
  message: Record<string, unknown>,
  threadId: string,
  state: CompactionState,
): CodexCompaction | null {
  const refusal = (message.error as { message?: unknown } | undefined)?.message;
  if (message.id !== undefined && refusal !== undefined) return { compacted: false, error: String(refusal) };
  if (message.id === RequestId.Initialize) {
    server.send({ method: AppServerMethod.Initialized });
    server.send(request(RequestId.Resume, AppServerMethod.ThreadResume, { threadId }));
  }
  if (message.id === RequestId.Resume) {
    state.compactAsked = true;
    server.send(request(RequestId.Compact, AppServerMethod.ThreadCompactStart, { threadId }));
  }
  const params = (message.params ?? {}) as { threadId?: unknown; item?: { type?: unknown }; turn?: CodexTurn };
  if (!state.compactAsked || params.threadId !== threadId) return null;
  if (message.method === AppServerMethod.ItemCompleted && params.item?.type === COMPACTION_ITEM) {
    state.compactionItem = true;
  }
  if (message.method !== AppServerMethod.TurnCompleted) return null;
  const compacted = params.turn?.status === TURN_COMPLETED && state.compactionItem;
  return { compacted, error: compacted ? null : String(params.turn?.error?.message ?? MESSAGE.NotCompacted) };
}

/** The fields of a finished turn this reads. */
interface CodexTurn {
  status?: unknown;
  error?: { message?: unknown } | null;
}

function request(id: number, method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { id, method, params };
}

/**
 * The real app server: `binary app-server …` over stdio, one JSON message per line each way.
 * Closing ends its input, which it answers by exiting; a stop or a server that lingers is killed.
 * Nothing is written once the input has ended: a late answer to a tool call is dropped, not an error.
 */
export function spawnCodexAppServer(binary: string): CodexAppServer {
  return (invocation) => {
    const { onStderr } = invocation;
    const child = spawnCommand(binary, invocation.argv, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", onStderr ? "pipe" : "ignore"],
    });
    child.stderr?.setEncoding("utf8");
    if (onStderr) child.stderr?.on("data", (chunk: string) => onStderr(chunk));
    // A server that exits mid-write must not raise an unhandled error on its input.
    child.stdin?.on("error", () => {});
    const stop = (): void => {
      void stopChild(child, { signal: "SIGTERM" });
      setTimeout(() => void stopChild(child), KILL_GRACE_MS).unref?.();
    };
    const { stdout } = child;
    if (!stdout) throw new Error(MESSAGE.NoOutput);
    // A binary that cannot start ends the stream; its error must not escape as an uncaught event.
    child.on("error", () => stdout.destroy());
    if (invocation.signal.aborted) stop();
    else invocation.signal.addEventListener("abort", stop, { once: true });
    const lines = readline.createInterface({ input: stdout });
    return {
      send: (message) => {
        if (child.stdin?.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
      },
      messages: (async function* () {
        for await (const line of lines) {
          const message = parseLine(line);
          if (message) yield message;
        }
      })(),
      close: () => {
        invocation.signal.removeEventListener("abort", stop);
        lines.close();
        child.stdin?.end();
        setTimeout(() => void stopChild(child), KILL_GRACE_MS).unref?.();
      },
    };
  };
}

/** One line of the app server's output as a message; null for anything that is not a JSON object. */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
