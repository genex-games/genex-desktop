/**
 * Stand-ins for the Roblox plugin's helper link tests: Roblox Studio as StudioMCP shows it (listed
 * Studios, each with the session marker the Genex helper set in its CoreGui), a clock the test moves
 * by hand, and the Genex helper itself, over an in-memory connection or a real WebSocket; and the
 * real helper file as the build ships it.
 */
import path from "node:path";
import type { HelperConnection, HelperHandlers } from "../../src/plugins/roblox/helper-socket.ts";
import { HELPER_PATH, WsClose } from "../../src/plugins/roblox/helper-socket.ts";
import { HELPER_PROTOCOL, HelperMessage } from "../../src/plugins/roblox/helper-protocol.ts";
import type { HelperLink } from "../../src/plugins/roblox/helper-link.ts";
import type { StudioClient, StudioEntry, StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import { StudioTool } from "../../src/plugins/roblox/studio-tools.ts";
import type { JobClock } from "../../src/substrate/job-process.ts";

type Call = { name: string; args: Record<string, unknown> };

/** Studio as StudioMCP lists it; `mark` is what the helper's `session.mark` does inside it. */
export function fakeStudio(listed: StudioEntry[]) {
  let studios = [...listed];
  const markers = new Map<string, string>();
  /** Studios whose CoreGui `execute_luau` can't reach. */
  const unreachable = new Set<string>();
  const calls: Call[] = [];
  const text = (value: string): StudioToolResult => ({ content: [{ type: "text", text: value }] });
  const client: Pick<StudioClient, "studios" | "callTool"> = {
    studios: async () => [...studios],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name !== StudioTool.ExecuteLuau) return text("ok");
      const id = String(args.studio_id);
      if (!studios.some((studio) => studio.id === id)) return { isError: true, content: [] };
      if (unreachable.has(id)) return text("genex-marker-unreachable");
      return text(`genex-marker:${markers.get(id) ?? ""}`);
    },
  };
  return {
    client,
    calls,
    unreachable,
    /** The helper marks a session: beside the sessions of its other Genex apps' connections. */
    mark: (studioId: string, session: string) => {
      const held = markers.get(studioId);
      markers.set(studioId, held ? `${held},${session}` : session);
    },
    /** Studio restarted, quit or opened: the list StudioMCP gives from now on. */
    list: (next: StudioEntry[]) => {
      studios = [...next];
    },
    /** Calls other than the marker reads. */
    otherCalls: () => calls.filter((call) => call.name !== StudioTool.ExecuteLuau),
  };
}

export type FakeStudio = ReturnType<typeof fakeStudio>;

/** A clock that moves only when the test says, running each timer that falls due on the way. */
export function manualClock(start = 1_800_000_000_000) {
  let now = start;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: JobClock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    setTimeout: (run, ms) => {
      const handle = ++nextHandle;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    pending: () => timers.size,
  };
  return clock;
}

type Frame = { v: number; id: number; type: string; body?: Record<string, unknown> };

/** What a fake helper does when the backend asks it to mark its session. */
type MarkOptions = { studio: FakeStudio; studioId: string; mark?: boolean };

/** The helper's answer to a `session.mark`, after putting the marker where the backend reads it. */
function markAnswer(frame: Frame, options: MarkOptions, id: number): string | undefined {
  if (frame.type !== HelperMessage.SessionMark) return undefined;
  if (options.mark !== false) options.studio.mark(options.studioId, String(frame.body?.session));
  return JSON.stringify({ v: HELPER_PROTOCOL, id, type: HelperMessage.Answer, re: frame.id, ok: true, result: {} });
}

/** The Genex helper on an in-memory connection the link accepted. */
export function memoryHelper(link: HelperLink, options: MarkOptions) {
  let nextId = 0;
  const received: Frame[] = [];
  let handlers: HelperHandlers | undefined;
  const state = { open: true, closedWith: undefined as number | undefined };
  const connection: HelperConnection = {
    id: 1,
    get open() {
      return state.open;
    },
    send(text) {
      const frame = JSON.parse(text) as Frame;
      received.push(frame);
      const answer = markAnswer(frame, options, ++nextId);
      if (answer) queueMicrotask(() => handlers?.message(answer));
    },
    close(code = WsClose.Normal) {
      if (!state.open) return;
      state.open = false;
      state.closedWith = code;
      queueMicrotask(() => handlers?.closed());
    },
  };
  handlers = link.accept(connection);
  return {
    received,
    state,
    /** Sends raw text, as a broken or hostile helper would. */
    raw: (text: string) => handlers?.message(text),
    /** Sends an event with the next id. */
    say: (type: string, body: unknown) =>
      handlers?.message(JSON.stringify({ v: HELPER_PROTOCOL, id: ++nextId, type, body })),
    hello: (place = { id: "0", name: "Place1" }) =>
      handlers?.message(
        JSON.stringify({ v: HELPER_PROTOCOL, id: ++nextId, type: HelperMessage.Hello, body: { helper: 1, place } }),
      ),
    /** The next id this helper would use, so a test can send one on purpose. */
    nextId: () => nextId + 1,
    skipTo: (id: number) => {
      nextId = id;
    },
    /** Studio quit: the connection ends from the helper's side. */
    end: () => connection.close(WsClose.GoingAway),
  };
}

/** The Genex helper over a real WebSocket to the backend's port. */
export async function socketHelper(port: number, options: MarkOptions & { place?: { id: string; name: string } }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${HELPER_PATH}`);
  let nextId = 0;
  const received: Frame[] = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    received.push(frame);
    const answer = markAnswer(frame, options, ++nextId);
    if (answer) socket.send(answer);
  });
  const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("the helper could not connect")), { once: true });
  });
  socket.send(
    JSON.stringify({
      v: HELPER_PROTOCOL,
      id: ++nextId,
      type: HelperMessage.Hello,
      body: { helper: 1, place: options.place ?? { id: "0", name: "Place1" } },
    }),
  );
  return {
    socket,
    received,
    closed,
    say: (type: string, body: unknown) => socket.send(JSON.stringify({ v: HELPER_PROTOCOL, id: ++nextId, type, body })),
    end: async () => {
      socket.close();
      await closed;
    },
  };
}

let shipped: Promise<string> | undefined;

/**
 * The Genex helper as the build ships it (`GenexStudioHelper.rbxmx`, assembled from
 * `src/plugins/roblox/helper/`), written once per test file to a temporary folder.
 */
export function shippedHelper(): Promise<string> {
  shipped ??= (async () => {
    const [{ robloxHelperModel }, { writeFile }, { tmpDir }, { HELPER_FILE }] = await Promise.all([
      import("../../scripts/build-plugins.mjs"),
      import("node:fs/promises"),
      import("./tmp.ts"),
      import("../../src/plugins/roblox/setup.ts"),
    ]);
    const file = path.join(await tmpDir("roblox-shipped-helper-"), HELPER_FILE);
    await writeFile(file, await robloxHelperModel(path.resolve(import.meta.dirname, "..", "..")));
    return file;
  })();
  return shipped;
}
