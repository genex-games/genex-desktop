#!/usr/bin/env node
/**
 * A stand-in for `cua-driver mcp`: a stdio MCP server answering the driver's tools with fixed data,
 * so the studio's client is exercised over a real MCP connection (the SDK's transport, the
 * handshake, the permission check) without touching this Mac. Settings come as arguments, since the
 * studio hands its driver only a minimal environment: `--log <file>` appends every tool call as one
 * JSON line, `--denied` answers that a grant is missing, `--fail-start` exits the way the real
 * driver does when its daemon never comes up, and `--pending <file>` answers `permissions_pending`
 * until that file exists (the restart a test stands in for creates it).
 *
 * Embedded, as the studio runs the real one: `serve --embedded --socket <path>` is the daemon. It
 * listens on that socket, appends one line to `--serve-log <file>` (its pid, arguments and what it
 * saw of the environment), and reads its grants once, when it starts, from whether `--grants <file>`
 * exists, as macOS caches a process's grants; `--serve-fail` exits the way a daemon that cannot
 * start does. `mcp --embedded --socket <path>` is the proxy: it asks the daemon on that socket for
 * its grants and answers the MCP tools with them.
 */
import { appendFileSync, existsSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";

/** A 1×1 PNG. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const argv = process.argv.slice(2);
const denied = argv.includes("--denied");
const logFile = argv.includes("--log") ? argv[argv.indexOf("--log") + 1] : null;
const pendingUntil = argv.includes("--pending") ? argv[argv.indexOf("--pending") + 1] : null;
if (argv.includes("--fail-start")) {
  process.stderr.write("cua-driver-rs: daemon did not appear on /tmp/cua.sock within 10s. If this is the first launch, grant Accessibility + Screen Recording\n");
  process.exit(1);
}

/** One flag's value, or null. */
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const socket = flag("--socket");

/** The proxy's grants: the embedded daemon's, asked over its socket; else the flags'. */
async function daemonGrants() {
  if (!socket) return !denied;
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    let answer = "";
    connection.on("data", (chunk) => (answer += chunk));
    connection.on("end", () => resolve(answer.trim() === "granted"));
    connection.on("error", () => {
      process.stderr.write(`cua-driver-rs: no daemon is listening on ${socket}\n`);
      process.exit(1);
    });
  });
}

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

const ANSWERS = {
  check_permissions: () =>
    pendingUntil && !existsSync(pendingUntil)
      ? {
          isError: true,
          content: [{ type: "text", text: "permissions_pending: macOS Accessibility or Screen Recording permission is still pending" }],
        }
      : json({ accessibility: grants, screen_recording: grants }),
  get_desktop_state: () => ({
    content: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
    structuredContent: { screenshot_width: 1366, screenshot_height: 854, screen_width: 1512, screen_height: 945 },
  }),
  list_apps: () => json({ apps: [{ name: "Notes", bundle_id: "com.apple.Notes", pid: 7, active: true }] }),
  list_windows: (args) =>
    json({
      windows: [
        args.pid === 4242
          ? { pid: 4242, window_id: 420, z_index: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 } }
          : { pid: 7, window_id: 70, z_index: 0, bounds: { x: 0, y: 0, width: 1512, height: 945 } },
      ],
    }),
  get_window_state: () => ({ content: [{ type: "text", text: "- AXWindow Notes\n  - AXTextArea body" }] }),
  // The browser tools: a separate, clean browser with one search page.
  browser_prepare: () => json({ prepared: true, prepared_pid: 4242 }),
  get_browser_state: (args) => {
    if (!args.snapshot_format) return json({ target_id: "bt-1", tabs: [{ active: true, tab_id: "tab-1" }] });
    const page = json({
      page: { title: "Search", url: "https://example.com/" },
      outline: '- searchbox "Search" [editable="plaintext"]\n- link "Godot" [focusable=true]',
      refs: [
        { ref: "p1:0", role: "searchbox", name: "Search", actions: ["type", "pointer"], visibility: "in_viewport" },
        { ref: "p1:1", role: "link", name: "Godot", actions: ["click", "pointer"], visibility: "in_viewport" },
      ],
    });
    // The tab's picture rides the answer when asked for, as cua-driver sends it.
    if (args.include_screenshot) page.content.push({ type: "image", data: PIXEL, mimeType: "image/png" });
    return page;
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    return send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-cua-driver", version: "0" },
      },
    });
  }
  if (method === "tools/list") return send({ id, result: { tools: [] } });
  if (method === "tools/call") {
    const name = params?.name;
    if (logFile) appendFileSync(logFile, `${JSON.stringify({ name, args: params?.arguments ?? {} })}\n`);
    const answer = ANSWERS[name]?.(params?.arguments ?? {}) ?? json({ effect: "confirmed" });
    return send({ id, result: answer });
  }
  if (method === "ping") return send({ id, result: {} });
  send({ id, error: { code: -32601, message: `method not found: ${method}` } });
}

/** The grants this proxy answers with. */
let grants = !denied;

async function startProxy() {
  grants = await daemonGrants();
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // Not JSON: a real server would ignore it too.
    }
  });
  lines.on("close", () => process.exit(0));
}

/** The embedded daemon: listens on its socket and answers with the grants it read when it started. */
function serve() {
  if (argv.includes("--serve-fail")) {
    process.stderr.write("cua-driver-rs: could not bind the daemon socket\n");
    process.exit(3);
  }
  const grantsFile = flag("--grants");
  const granted = grantsFile ? existsSync(grantsFile) : true;
  const seen = ["CUA_DRIVER_EMBEDDED", "CUA_DRIVER_HOST_BUNDLE_ID", "DO_NOT_TRACK", "CUA_DRIVER_RS_UPDATE_CHECK", "GENEX_SECRET"];
  const env = Object.fromEntries(seen.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
  const serveLog = flag("--serve-log");
  if (serveLog) appendFileSync(serveLog, `${JSON.stringify({ pid: process.pid, argv, env })}\n`);
  const server = net.createServer((connection) => {
    // A readiness probe hangs up at once: like the real daemon, it shrugs that off.
    connection.on("error", () => {});
    connection.end(granted ? "granted\n" : "denied\n");
  });
  server.listen(socket);
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}

if (argv.includes("serve")) serve();
else await startProxy();
