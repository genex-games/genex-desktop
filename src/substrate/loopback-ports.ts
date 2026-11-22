/**
 * This computer's loopback ports: whether one is free for a listener now. For a server that must
 * listen on a port of a given range, as where a sandbox fences loopback (`ProcessSandbox.loopbackPorts`).
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { LoopbackProtocol } from "./linux-loopback-bridge.ts";

/** The loopback address a local server listens on. */
export const LOOPBACK_HOST = "127.0.0.1";

/** Whether a listener on `port` of {@link LOOPBACK_HOST} can open now: opened and closed again. */
export async function loopbackPortFree(port: number, protocol: LoopbackProtocol): Promise<boolean> {
  if (protocol === LoopbackProtocol.Udp) {
    const socket = createSocket("udp4");
    const bound = await new Promise<boolean>((resolve) => {
      socket.once("error", () => resolve(false));
      socket.bind(port, LOOPBACK_HOST, () => resolve(true));
    });
    if (bound) await new Promise<void>((resolve) => socket.close(() => resolve()));
    return bound;
  }
  const server = createServer();
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen({ port, host: LOOPBACK_HOST, exclusive: true }, () => resolve(true));
  });
  if (listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  return listening;
}
