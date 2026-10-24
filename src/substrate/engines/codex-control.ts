import { spawnCommand } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { CatalogError, CATALOG_DEADLINE_MS } from "./model-catalog.ts";
import { ModelCatalogProblemCode } from "../../shared/model-catalog.ts";
import { t } from "../../shared/i18n.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const Method = { Initialize: "initialize", Initialized: "initialized" } as const;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
/** Owned, bounded control transport; caller must close it in finally. */
export function codexControl(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = CATALOG_DEADLINE_MS) {
  const child = spawnCommand(binary, [...args, "app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let buffer = "";
  let bytes = 0;
  let failure: Error | undefined;
  let stopped: Promise<void> | undefined;
  const close = (): Promise<void> => {
    clearTimeout(timer);
    child.stdin?.end();
    stopped ??= stopChild(child, { signal: "SIGTERM" }).then(() => {});
    return stopped;
  };
  const fail = (error: Error): void => {
    failure = error;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    void close();
  };
  const timer = setTimeout(
    () => fail(new CatalogError(ModelCatalogProblemCode.Timeout, t("Model discovery timed out. Try again."))),
    timeoutMs,
  );
  const send = (message: object): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: object): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  };
  const answer = (line: string): void => {
    const message: unknown = JSON.parse(line);
    if (!message || typeof message !== "object") throw new Error("Invalid control message");
    const row = message as { id?: unknown; result?: unknown; error?: { code?: unknown } };
    if (typeof row.id !== "number") return;
    const item = pending.get(row.id);
    if (!item) return;
    pending.delete(row.id);
    if (row.error) {
      item.reject(
        new CatalogError(
          row.error.code === -32601 ? ModelCatalogProblemCode.Unsupported : ModelCatalogProblemCode.Provider,
          t("The CLI could not list models."),
        ),
      );
      return;
    }
    item.resolve(row.result);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BYTES) {
      fail(new CatalogError(ModelCatalogProblemCode.Malformed, t("The CLI model response is too large.")));
      return;
    }
    const lines = `${buffer}${chunk}`.split("\n");
    buffer = lines.pop() ?? "";
    try {
      for (const line of lines) if (line.trim()) answer(line);
    } catch {
      fail(new CatalogError(ModelCatalogProblemCode.Malformed, t("The CLI returned an invalid control response.")));
    }
  });
  const disconnected = () =>
    fail(new CatalogError(ModelCatalogProblemCode.Provider, t("Model discovery disconnected.")));
  child.on("error", disconnected);
  child.on("close", disconnected);
  child.stdin?.on("error", disconnected);
  return {
    request,
    close,
    async initialize(): Promise<void> {
      await request(Method.Initialize, { clientInfo: { name: "genex", version: "1" }, capabilities: null });
      send({ method: Method.Initialized });
    },
  };
}
