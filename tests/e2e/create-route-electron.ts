/**
 * The Create Live route (D1) in a real Electron: a game page's own `fetch` reaches play-time AI
 * through `GamePreview`'s protocol handlers from the Live human partition only. Chromium hands a
 * protocol handler no `Origin`, and a protocol handler answers across origins with no CORS check,
 * so the sender is judged by its frame in the preview's webRequest hook: another game's frame, a
 * sandboxed frame and a cross-origin fetch never reach play-time AI. A machine driving Live and a
 * new document both abandon the page's calls.
 *
 * The page's fetches run through `webContents.executeJavaScript` directly, as the page's own code:
 * `GamePreview.evaluate` is a machine driving the page, which turns the route off (checked below).
 */
import { app, BrowserWindow, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GamePreview, loopbackPortFor, registerGameScheme } from "../../src/main/preview.ts";
import { AI_DRIVE_QUIET_MS, type CreateRouteHost } from "../../src/main/game-ai/create-route.ts";
import type { GameAiCaller } from "../../src/main/game-ai/types.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import {
  AiBridgeOp,
  AiErrorCode,
  AiOp,
  AiProvenance,
  AiSource,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import { AI_ROUTE_PREFIX, type AiBridgeMessage } from "../../src/shared/game-ai-bridge.ts";
import { AiPickPolicy } from "../../src/shared/game-ai-views.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "studio-create-route-"));
app.setPath("userData", path.join(root, "profile"));
registerGameScheme();
app.on("window-all-closed", () => {});

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, ...(ok ? {} : { detail }) });

const HELLO_ON = JSON.stringify({ v: GAME_AI_WIRE_VERSION, on: true });
const HELLO_OFF = JSON.stringify({ v: GAME_AI_WIRE_VERSION, on: false });

const CALL = {
  v: GAME_AI_WIRE_VERSION,
  op: AiOp.Say,
  site: "npc.line",
  ticket: "ticket-0001",
  grantId: "grant-0001",
  system: null,
  prompt: "Greet the player.",
  untrusted: {},
  memory: null,
  schema: null,
  tier: "fast",
  authority: "local",
  maxOutputTokens: 64,
  stream: false,
};

/** A play-time AI that records what reached it and answers each op, on a clock the test moves. */
function fakeAi() {
  let now = 1_000_000;
  let enabled = true;
  const calls: Array<{ caller: GameAiCaller; message: AiBridgeMessage }> = [];
  const abandoned: string[] = [];
  const handle = async (caller: GameAiCaller, message: AiBridgeMessage, onDelta?: (text: string) => void) => {
    calls.push({ caller, message });
    if (message.op === AiBridgeOp.Hello) return { v: GAME_AI_WIRE_VERSION, on: true };
    if (message.op !== AiBridgeOp.Call) return { view: null, code: null };
    onDelta?.("Hello");
    return {
      v: GAME_AI_WIRE_VERSION,
      ok: true,
      ticket: message.body.ticket,
      value: "Hello there",
      source: AiSource.Local,
      provenance: AiProvenance.Unverified,
      latencyMs: 5,
      cached: false,
    };
  };
  const host: CreateRouteHost = {
    clock: { now: () => now },
    settings: {
      view: async () => ({
        pick: AiPickPolicy.Best,
        signedIn: false,
        balanceCredits: null,
        pro: null,
        autoTopUp: null,
        dailyAlertCredits: null,
        keepForBuildingPercent: 50,
        openRouterMonthlyMicros: null,
        createRouteEnabled: enabled,
        allowPlan: false,
        shareFitCounts: false,
      }),
    },
    service: {
      handle: handle as CreateRouteHost["service"]["handle"],
      abandon: (channel) => {
        abandoned.push(channel);
      },
    },
    game: async (project) => ({ title: project, ownGame: true }),
  };
  const advance = (ms: number) => {
    now += ms;
  };
  const setEnabled = (on: boolean) => {
    enabled = on;
  };
  return { host, calls, abandoned, advance, setEnabled };
}
type FakeAi = ReturnType<typeof fakeAi>;

type PageAnswer = { status?: number; type?: string; text?: string; failed?: string };

/** Page code: send `body` to `url` and say what came back (status, type and text), or that fetch failed. */
function pagePost(url: string, body: unknown, init: { contentType?: string; mode?: string; method?: string } = {}) {
  const method = init.method ?? "POST";
  return `(async () => {
    try {
      const response = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        mode: ${JSON.stringify(init.mode ?? "same-origin")},
        headers: { "content-type": ${JSON.stringify(init.contentType ?? "application/json")} },
        body: ${JSON.stringify(method === "GET" ? null : JSON.stringify(body))},
      });
      return { status: response.status, type: response.type, text: await response.text() };
    } catch (error) {
      return { failed: String(error) };
    }
  })()`;
}

const route = (op: string) => `${AI_ROUTE_PREFIX}${op}`;
const ask = async (wc: WebContents, code: string): Promise<PageAnswer> =>
  (await wc.executeJavaScript(code, true)) as PageAnswer;
const codeOf = (answer: PageAnswer): unknown => (JSON.parse(answer.text ?? "{}") as { code?: unknown }).code;

async function main(): Promise<void> {
  await app.whenReady();
  for (const game of ["pond-life", "other-game"]) {
    await mkdir(path.join(root, game, "__genex", "ai", "v1"), { recursive: true });
    await writeFile(path.join(root, game, "index.html"), `<!doctype html><title>${game}</title><p>${game}</p>`);
    // A file planted where the route lives: the route answers, the file is never served.
    await writeFile(path.join(root, game, "__genex", "ai", "v1", "hello"), HELLO_ON);
  }
  const ai = fakeAi();
  const win = new BrowserWindow({ width: 320, height: 240, show: false });
  const live = new GamePreview({ gamesRoot: root, vendorDir: path.join(root, "vendor"), ai: ai.host });
  live.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
  const wc = live.view?.webContents;
  if (!wc) throw new Error("no Live view");
  try {
    await live.load("pond-life");
    await checkReaches(wc, ai);
    await checkHostile(wc, ai);
    await checkDrive(live, wc, ai);
    await checkSwitchAndPage(live, wc, ai);
    await checkFacet(ai);
  } finally {
    await live.destroy();
    win.destroy();
  }
}

/** Live's own page reaches play-time AI as the game it shows. */
async function checkReaches(wc: WebContents, ai: FakeAi): Promise<void> {
  const hello = await ask(wc, pagePost(route(AiBridgeOp.Hello), null));
  check("Live: the page's own POST reaches play-time AI", hello.status === 200 && hello.text === HELLO_ON, hello);
  const caller = ai.calls[0]?.caller;
  check(
    "Live: the caller is derived from the page",
    caller?.game === "create:pond-life" && caller.context === AiContext.CreateLive && caller.channel === String(wc.id),
    caller,
  );
  const streamed = await ask(wc, pagePost(route(AiBridgeOp.Call), { ...CALL, stream: true }));
  check(
    "Live: a streamed call answers as server-sent events",
    streamed.status === 200 && streamed.text?.startsWith('event: delta\ndata: {"text":"Hello"}') === true,
    streamed,
  );
}

/** Hostile requests from the page's tree never reach play-time AI. */
async function checkHostile(wc: WebContents, ai: FakeAi): Promise<void> {
  const reached = ai.calls.length;
  const get = await ask(wc, pagePost(route(AiBridgeOp.Hello), null, { method: "GET" }));
  check("hostile: a GET of the route is refused, the planted file never served", get.status === 405, get);
  const simple = await ask(wc, pagePost(route(AiBridgeOp.Hello), null, { contentType: "text/plain" }));
  check("hostile: a simple text/plain POST is refused", simple.status === 415, simple);
  const other = `game://other-game${route(AiBridgeOp.Hello)}`;
  const foreign = await ask(wc, pagePost(other, null, { mode: "cors" }));
  check("hostile: a POST to another game's route never leaves the page", foreign.failed !== undefined, foreign);
  const blind = await ask(wc, pagePost(other, null, { mode: "no-cors", contentType: "text/plain" }));
  check(
    "hostile: a blind no-cors POST to another game's route never leaves the page",
    blind.failed !== undefined,
    blind,
  );

  await wc.executeJavaScript(
    `new Promise((resolve) => { const f = document.createElement("iframe"); f.onload = resolve; f.src = "game://other-game/index.html"; document.body.append(f); })`,
  );
  const frame = wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith("game://other-game/"));
  const framed = frame
    ? ((await frame.executeJavaScript(pagePost(route(AiBridgeOp.Hello), null))) as PageAnswer)
    : null;
  check("hostile: a frame of another game asking on its own origin is refused", framed?.status === 403, framed);
  const across = frame
    ? ((await frame.executeJavaScript(
        pagePost(`game://pond-life${route(AiBridgeOp.Hello)}`, null, { mode: "cors" }),
      )) as PageAnswer)
    : null;
  check(
    "hostile: a frame of another game asking on the shown game's origin is cancelled",
    across?.failed !== undefined,
    across,
  );
  await wc.executeJavaScript(
    `new Promise((resolve) => { const f = document.createElement("iframe"); f.onload = resolve; f.sandbox = "allow-scripts"; f.srcdoc = "<p>sandboxed</p>"; document.body.append(f); })`,
  );
  const sandboxed = wc.mainFrame.framesInSubtree.find((f) => f.url === "about:srcdoc");
  const opaque = sandboxed
    ? ((await sandboxed.executeJavaScript(
        pagePost(`game://pond-life${route(AiBridgeOp.Hello)}`, null, { mode: "no-cors", contentType: "text/plain" }),
      )) as PageAnswer)
    : null;
  check("hostile: a sandboxed frame (origin null) is cancelled", opaque?.failed !== undefined, opaque);
  check("hostile: none of them reached play-time AI", ai.calls.length === reached, ai.calls.slice(reached));
}

/** A machine driving Live suspends its AI and abandons the page's calls once. */
async function checkDrive(live: GamePreview, wc: WebContents, ai: FakeAi): Promise<void> {
  const before = ai.abandoned.length;
  await live.input([{ type: "press", combo: "w" }]);
  check(
    "drive: an input abandons the page's calls once",
    ai.abandoned.slice(before).join() === String(wc.id),
    ai.abandoned,
  );
  const driven = await ask(wc, pagePost(route(AiBridgeOp.Call), CALL));
  check("drive: the route answers ai_off after a machine drove Live", codeOf(driven) === AiErrorCode.Off, driven);
  await live.evaluate("1");
  check(
    "drive: an agent's evaluate keeps it off without abandoning again",
    ai.abandoned.length === before + 1,
    ai.abandoned,
  );
  ai.advance(AI_DRIVE_QUIET_MS);
  const quiet = await ask(wc, pagePost(route(AiBridgeOp.Call), CALL));
  check(
    "drive: a quiet spell later the page reaches play-time AI again",
    JSON.parse(quiet.text ?? "{}").ok === true,
    quiet,
  );
}

/** The switch, a new document and the loopback origin. */
async function checkSwitchAndPage(live: GamePreview, wc: WebContents, ai: FakeAi): Promise<void> {
  ai.setEnabled(false);
  const off = await ask(wc, pagePost(route(AiBridgeOp.Hello), null));
  check("switch: with Create Live off, Live answers hello off", off.text === HELLO_OFF, off);
  ai.setEnabled(true);

  const navigated = ai.abandoned.length;
  await live.reload();
  check("navigation: a new document abandons the old page's calls", ai.abandoned.length > navigated, ai.abandoned);

  await live.load("pond-life", "index.html", undefined, { loopback: true });
  const loopback = await ask(wc, pagePost(route(AiBridgeOp.Hello), null));
  check(
    `loopback: the game's own http://localhost:${loopbackPortFor("pond-life")} origin reaches it`,
    loopback.status === 200 && loopback.text === HELLO_ON,
    loopback,
  );
}

/** A facet's offscreen window, with the same play-time AI behind it, answers off and abandons nothing. */
async function checkFacet(ai: FakeAi): Promise<void> {
  const win = new BrowserWindow({ width: 320, height: 240, show: false, webPreferences: { offscreen: true } });
  const facet = new GamePreview({
    gamesRoot: root,
    vendorDir: path.join(root, "vendor"),
    partition: "game-preview-facet-e2e",
    offscreen: true,
    muted: true,
    ai: ai.host,
  });
  try {
    facet.attachTo(win, { x: 0, y: 0, width: 320, height: 200 });
    await facet.load("pond-life");
    const before = { calls: ai.calls.length, abandoned: ai.abandoned.length };
    const wc = facet.view?.webContents;
    const hello = wc ? await ask(wc, pagePost(route(AiBridgeOp.Hello), null)) : null;
    check("facet: hello answers off", hello?.text === HELLO_OFF, hello);
    await facet.input([{ type: "press", combo: "w" }]);
    await facet.reload();
    check("facet: play-time AI never hears of it", ai.calls.length === before.calls, ai.calls.slice(before.calls));
    check("facet: nothing is abandoned on its behalf", ai.abandoned.length === before.abandoned, ai.abandoned);
  } finally {
    await facet.destroy();
    win.destroy();
  }
}

main()
  .catch((error) => check("fixture completed", false, String(error)))
  .finally(async () => {
    const passed = checks.length > 0 && checks.every((c) => c.ok);
    const result = { checks, passed, electron: process.versions.electron };
    if (process.env.STUDIO_CREATE_ROUTE_REPORT) {
      await writeFile(process.env.STUDIO_CREATE_ROUTE_REPORT, JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result, null, 2));
    app.exit(passed ? 0 : 1);
  });
