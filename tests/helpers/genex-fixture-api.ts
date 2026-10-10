/**
 * A fixture Genex API on 127.0.0.1 and a Genex plugin build pointed at it. Nothing leaves the
 * machine: the pinned CLI inside the plugin bundle talks to this server, never to genex.
 *
 * The server answers the signed-in session and the legal acceptance itself; everything else goes
 * to the test's handler first, and an unanswered request is a JSON 404.
 */
import http from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { buildPlugins } from "../../scripts/build-plugins.mjs";

const repo = path.resolve(import.meta.dirname, "../..");

export interface GenexRequest {
  method: string;
  url: string;
  /** The request body as text ('' when there is none). */
  body: string;
  /** The request body's bytes, for an upload whose bytes matter (a cover image). */
  bytes: Buffer;
  /** The `Authorization` header as sent ('' when there is none). */
  authorization: string;
  /** Settles when the connection closes: for a request left unanswered, when its client went away. */
  closed: Promise<void>;
}

export interface GenexReply {
  json(body: unknown, status?: number): void;
  text(body: string, status?: number): void;
}

/** Answer through `reply`; returning without replying falls through to the defaults. */
export type GenexHandler = (request: GenexRequest, reply: GenexReply) => unknown;

export interface GenexFixtureApi {
  /** `http://127.0.0.1:<port>` */
  url: string;
  close(): Promise<void>;
}

export async function startGenexFixtureApi(handler: GenexHandler = () => {}): Promise<GenexFixtureApi> {
  const server = http.createServer(async (req, res) => {
    const closed = new Promise<void>((resolve) => res.once("close", () => resolve()));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const body = bytes.toString("utf8");
    res.setHeader("content-type", "application/json");
    const reply: GenexReply = {
      json(value, status = 200) {
        res.statusCode = status;
        res.end(JSON.stringify(value));
      },
      text(value, status = 200) {
        res.statusCode = status;
        res.end(value);
      },
    };
    const url = req.url ?? "";
    const authorization = req.headers.authorization ?? "";
    await handler({ method: req.method ?? "GET", url, body, bytes, authorization, closed }, reply);
    if (res.writableEnded) return;
    if (url === "/api/auth/get-session") return reply.json({ user: { email: "fixture@example.invalid" } });
    if (url.includes("legal")) return reply.json({ accepted: true, required: "1", acceptedVersion: "1" });
    return reply.json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Build the plugins into `resources`, then rebuild the Genex backend bound to `api` — the same
 * backend source, with only the service origin swapped for the fixture's.
 */
export async function buildGenexPluginFor(resources: string, api: string): Promise<void> {
  await buildPlugins(repo, resources);
  await build({
    stdin: {
      contents: `import {createGenexPlugin} from './src/plugins/genex/backend.ts';export const activate=()=>createGenexPlugin(${JSON.stringify(api)});`,
      resolveDir: repo,
      loader: "ts",
    },
    outfile: path.join(resources, "plugins/genex/backend.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
    logLevel: "silent",
  });
}
