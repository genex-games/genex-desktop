/**
 * The host-to-harness channel on Windows.
 *
 * srt-win does not pass a sandboxed process's stdin through (the Windows runner showed `cat`
 * reading nothing), so the harness cannot hear the host over stdin there. Instead the bootstrap
 * listens on a loopback port the host picked (`HARNESS_INBOX_PORT`), the host connects to it (host
 * to sandbox loopback is allowed; sandbox to sandbox is not), and the first line the host sends is
 * a one-time token (`HARNESS_INBOX_TOKEN`) so no other local process can speak for it. Messages
 * written before the connection is up wait in order. The harness still answers on stdout.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../shared/duration.ts";

/** How long the host keeps trying to reach a starting harness's inbox. */
const CONNECT_TIMEOUT_MS = 30 * SECOND_MS;
/** The pause between two connection attempts while the harness boots. */
const CONNECT_RETRY_MS = 100;
/** Random bytes in the inbox token. */
const TOKEN_BYTES = 32;
const LOOPBACK = "127.0.0.1";

/** The environment variables the bootstrap reads its inbox from (`src/harness-boot/bootstrap.mjs`). */
export const HarnessInboxEnv = {
  Port: "HARNESS_INBOX_PORT",
  Token: "HARNESS_INBOX_TOKEN",
} as const;
export type HarnessInboxEnv = (typeof HarnessInboxEnv)[keyof typeof HarnessInboxEnv];

/** A loopback port nothing listens on right now. */
export async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || !address) throw new Error("no loopback port");
  return address.port;
}

/** One harness's inbox: where it listens, how it proves the host, and the connection once made. */
export class HarnessInbox {
  readonly port: number;
  readonly token: string;
  #socket: net.Socket | null = null;
  #queue: string[] = [];
  #closed = false;

  private constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
  }

  /** A fresh inbox on a free loopback port with a new token. */
  static async open(): Promise<HarnessInbox> {
    return new HarnessInbox(await freeLoopbackPort(), randomBytes(TOKEN_BYTES).toString("hex"));
  }

  /** The variables that tell the bootstrap where to listen and what to expect first. */
  env(): Record<HarnessInboxEnv, string> {
    return { [HarnessInboxEnv.Port]: String(this.port), [HarnessInboxEnv.Token]: this.token };
  }

  /**
   * Keep trying to connect until the harness listens, `alive()` turns false, the inbox is closed
   * or the time runs out; then send the token and everything queued. Resolves true once connected.
   */
  async connect(alive: () => boolean, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#closed && alive() && Date.now() < deadline) {
      const socket = await attempt(this.port);
      if (socket) {
        if (this.#closed) {
          socket.destroy();
          return false;
        }
        this.#socket = socket;
        socket.on("error", () => this.close());
        socket.write(`${this.token}\n`);
        for (const line of this.#queue.splice(0)) socket.write(line);
        return true;
      }
      await sleep(CONNECT_RETRY_MS);
    }
    return false;
  }

  /** Send one encoded line now, or as soon as the connection is up. */
  write(line: string): void {
    if (this.#closed) return;
    if (this.#socket?.writable) this.#socket.write(line);
    else this.#queue.push(line);
  }

  /** Finish the connection once what was written has gone; anything still queued is dropped. */
  end(): void {
    this.#closed = true;
    this.#queue = [];
    this.#socket?.end();
  }

  /** Drop the connection and anything still queued. */
  close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#socket?.destroy();
    this.#socket = null;
  }
}

/** One connection attempt: the socket, or null when nothing listens yet. */
function attempt(port: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(null);
    });
  });
}
