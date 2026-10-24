#!/usr/bin/env node
/**
 * A tiny deterministic game that speaks the Genex Play Protocol v3 on stdin/stdout
 * (docs/play-protocol.md): a dot that runs left and right and jumps, hazards dropped by a seeded
 * RNG that cost health, a step-locked clock in 16 ms ticks, and screenshots drawn as a small PNG.
 * Clicks count in the simulation; like all input they land at the start of the next tick, so
 * nothing given while paused moves it before a step. Its state carries the protocol's input echo.
 * The conformance suite drives it through the studio's real client and target.
 *
 * Flags for the hostile rows: --view=WxH, --never-ready, --fatal, --die-on=<op>, --ignore-quit,
 * --noise (garbage before ready and an id-less event after every reply), --pid-file=<path> (its
 * own pid, written first, so a test can prove a stop left nothing running), --protocol=<n> (the
 * version its hello announces), --build=<id> and --source-hash=<hash> (the build it names),
 * --stderr=<text> (one stderr line before anything else), --stderr-flood=<bytes> (that much
 * stderr before ready, written the blocking way a native engine writes it), --crash (exit before
 * ready), and --reduced (a game that declares a relative pointer, a freeze-only clock, no seed,
 * no actions and no text input, and refuses those ops with `unsupported`).
 */
import { writeFileSync, writeSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const TICK_MS = 16;
const MAX_STEP_MS = 60_000;
const MAX_HOLD_TICKS = 3600;
const MAX_TYPED = 1000;
const ACTIONS = ["jump", "left", "right"];
const LEFT_KEYS = ["ArrowLeft", "KeyA"];
const RIGHT_KEYS = ["ArrowRight", "KeyD"];
const JUMP_KEYS = ["Space", "ArrowUp", "KeyW"];
const PLAYER = 4;
const HAZARD_EVERY_TICKS = 20;
const HAZARD_TTL_TICKS = 30;

const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.length ? value.join("=") : true];
  }),
);
const [W, H] = String(flags.get("view") ?? "64x40")
  .split("x")
  .map(Number);

/** mulberry32: the same seed draws the same hazards. */
function nextRandom(sim) {
  sim.rng = (sim.rng + 0x6d2b79f5) >>> 0;
  let t = sim.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function freshSim(seed) {
  return {
    seed,
    rng: seed >>> 0,
    tick: 0,
    x: Math.floor(W / 2),
    y: H - 6,
    vy: 0,
    health: 5,
    score: 0,
    clicks: 0,
    hazards: [],
  };
}

/** Input as it is at launch: nothing held, typed or queued, the pointer in the middle. */
function freshInput() {
  return {
    keys: new Set(),
    latched: new Set(),
    actions: new Map(),
    pointer: { x: Math.floor(W / 2), y: Math.floor(H / 2), buttons: [] },
    typed: "",
    look: { dx: 0, dy: 0 },
    wheel: { dx: 0, dy: 0 },
    /** Clicks waiting for the next tick. */
    clicks: [],
  };
}

const game = { sim: freshSim(1), paused: false, ...freshInput() };

function inputOn(keys, action) {
  return keys.some((code) => game.keys.has(code) || game.latched.has(code)) || game.actions.has(action);
}

/** Clicks queued since the last tick land now, at the tick's start (docs/play-protocol.md: queued input). */
function landClicks(sim) {
  for (const { x, y, count } of game.clicks) {
    const onPlayer = x >= sim.x && x < sim.x + PLAYER && y >= sim.y && y < sim.y + PLAYER;
    if (onPlayer) sim.score += count;
    sim.clicks += count;
  }
  game.clicks = [];
}

function tick() {
  const sim = game.sim;
  landClicks(sim);
  const ground = H - 6;
  const dx = (inputOn(RIGHT_KEYS, "right") ? 2 : 0) - (inputOn(LEFT_KEYS, "left") ? 2 : 0);
  sim.x = Math.max(0, Math.min(W - PLAYER, sim.x + dx));
  if (inputOn(JUMP_KEYS, "jump") && sim.y >= ground) sim.vy = -6;
  sim.vy += 1;
  sim.y = Math.min(ground, sim.y + sim.vy);
  if (sim.y >= ground) sim.vy = 0;
  if (sim.tick % HAZARD_EVERY_TICKS === 0) sim.hazards.push({ x: Math.floor(nextRandom(sim) * (W - PLAYER)), ttl: HAZARD_TTL_TICKS });
  for (const hazard of sim.hazards) {
    hazard.ttl -= 1;
    if (Math.abs(hazard.x - sim.x) < PLAYER && sim.y > ground - PLAYER) {
      sim.health = Math.max(0, sim.health - 1);
      hazard.ttl = 0;
    }
  }
  sim.hazards = sim.hazards.filter((hazard) => hazard.ttl > 0);

  game.latched.clear();
  for (const [name, left] of game.actions) {
    if (left <= 1) game.actions.delete(name);
    else game.actions.set(name, left - 1);
  }
  sim.tick += 1;
}

setInterval(() => {
  if (!game.paused) tick();
}, TICK_MS);

function checksum() {
  let hash = 0x811c9dc5;
  for (const ch of JSON.stringify(game.sim)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function state() {
  const { sim } = game;
  return {
    paused: game.paused,
    seed: sim.seed,
    tick: sim.tick,
    simulatedMs: sim.tick * TICK_MS,
    player: { x: sim.x, y: sim.y, health: sim.health, score: sim.score },
    hazards: sim.hazards.length,
    clicks: sim.clicks,
    input: {
      keys: [...game.keys].sort(),
      pointer: game.pointer,
      typed: game.typed,
      look: game.look,
      wheel: game.wheel,
    },
    checksum: checksum(),
  };
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** The frame as a grey PNG: dark ground, hazards mid-grey, the player white. */
function screenshot() {
  const pixels = Buffer.alloc(W * H, 20);
  const paint = (x0, y0, size, luma) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + size); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + size); x++) pixels[y * W + x] = luma;
  };
  for (const hazard of game.sim.hazards) paint(hazard.x, H - 6, PLAYER, 128);
  paint(game.sim.x, game.sim.y, PLAYER, 255);
  const rows = [];
  for (let y = 0; y < H; y++) rows.push(Buffer.from([0]), pixels.subarray(y * W, (y + 1) * W));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(W, 0);
  header.writeUInt32BE(H, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const lit = pixels.filter((luma) => luma > 64).length;
  const meanLuma = pixels.reduce((sum, luma) => sum + luma, 0) / pixels.length;
  return {
    format: "png",
    data: png.toString("base64"),
    width: W,
    height: H,
    stats: { meanLuma, litFraction: lit / pixels.length },
  };
}

class BadArgs extends Error {}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
function need(ok, why) {
  if (!ok) throw new BadArgs(why);
}

function pointer(args) {
  need(finite(args.x) && finite(args.y), "pointer needs numeric x and y");
  const button = args.button ?? "left";
  need(["left", "middle", "right"].includes(button), "unknown button");
  need(args.down === undefined || typeof args.down === "boolean", "down is true or false");
  game.pointer.x = Math.max(0, Math.min(W - 1, Math.round(args.x)));
  game.pointer.y = Math.max(0, Math.min(H - 1, Math.round(args.y)));
  if (args.down === true && !game.pointer.buttons.includes(button)) game.pointer.buttons.push(button);
  if (args.down === false) game.pointer.buttons = game.pointer.buttons.filter((held) => held !== button);
  if (args.click !== undefined) {
    need(Number.isInteger(args.click) && args.click >= 1 && args.click <= 3, "click is 1, 2 or 3");
    game.clicks.push({ x: game.pointer.x, y: game.pointer.y, count: args.click });
  }
  return { x: game.pointer.x, y: game.pointer.y };
}

function act(args) {
  need(Array.isArray(args.list), "act needs a list");
  for (const item of args.list) {
    need(item && ACTIONS.includes(item.action), `unknown action ${item?.action}`);
    need(["press", "hold", "release"].includes(item.state), "state is press, hold or release");
    if (item.ticks !== undefined) need(Number.isInteger(item.ticks) && item.ticks >= 1, "ticks is a whole number");
  }
  for (const item of args.list) {
    if (item.state === "release") game.actions.delete(item.action);
    else game.actions.set(item.action, item.state === "press" ? 1 : Math.min(MAX_HOLD_TICKS, item.ticks ?? 1));
  }
  return { applied: args.list.length };
}

function step(args) {
  need(finite(args.ms) && args.ms > 0 && args.ms <= MAX_STEP_MS, `ms is more than 0, at most ${MAX_STEP_MS}`);
  game.paused = true;
  const ticks = Math.max(1, Math.round(args.ms / TICK_MS));
  for (let i = 0; i < ticks; i++) tick();
  return { simulatedMs: ticks * TICK_MS, tick: game.sim.tick };
}

function reset(args) {
  need(Number.isInteger(args.seed) && args.seed >= 0, "seed is a whole number");
  Object.assign(game, { sim: freshSim(args.seed), ...freshInput() });
  return { seed: args.seed };
}

const REDUCED = flags.has("reduced");
/** The core ops a reduced game lacks: what its hello's levels and `unsupported` list rule out. */
const LACKED = new Set(REDUCED ? ["pointer", "wheel", "step", "reset", "act", "type"] : []);
const PROTOCOL = Number(flags.get("protocol") ?? 3);

function build() {
  if (typeof flags.get("build") !== "string") return undefined;
  const hash = flags.get("source-hash");
  return { id: flags.get("build"), ...(typeof hash === "string" ? { sourceHash: hash } : {}) };
}

const CAPABILITIES = REDUCED
  ? { pointer: "relative", clock: "freeze", state: "game", seed: false, actions: [], screenshot: ["png"] }
  : { pointer: "absolute", clock: "replayable", state: "game", seed: true, actions: ACTIONS, screenshot: ["png"] };

const OPS = {
  hello: () => ({
    protocol: PROTOCOL,
    name: "fake-play-game",
    build: build(),
    view: { width: W, height: H },
    capabilities: CAPABILITIES,
    ops: ["hazards"],
    unsupported: REDUCED ? ["type"] : [],
  }),
  screenshot: (args) => {
    need(args.format === undefined || ["png", "jpeg"].includes(args.format), "format is png or jpeg");
    return screenshot();
  },
  pointer,
  key: (args) => {
    need(typeof args.code === "string" && args.code.length > 0, "key needs a code");
    need(args.down === undefined || typeof args.down === "boolean", "down is true or false");
    if (args.down === true) game.keys.add(args.code);
    else if (args.down === false) game.keys.delete(args.code);
    else game.latched.add(args.code);
    return {};
  },
  type: (args) => {
    need(typeof args.text === "string", "type needs text");
    game.typed = (game.typed + args.text).slice(-MAX_TYPED);
    return {};
  },
  look: (args) => {
    need(finite(args.dx) && finite(args.dy), "look needs dx and dy");
    game.look = { dx: game.look.dx + args.dx, dy: game.look.dy + args.dy };
    return {};
  },
  wheel: (args) => {
    need(finite(args.dx) && finite(args.dy), "wheel needs dx and dy");
    game.wheel = { dx: game.wheel.dx + args.dx, dy: game.wheel.dy + args.dy };
    return {};
  },
  act,
  pause: () => {
    game.paused = true;
    return {};
  },
  play: () => {
    game.paused = false;
    return {};
  },
  step,
  reset,
  state,
  hazards: () => game.sim.hazards.map((hazard) => ({ ...hazard })),
};

function say(message, then) {
  process.stdout.write(`${JSON.stringify(message)}\n`, then);
}

function answer(request) {
  const { id, op } = request;
  if (flags.get("die-on") === op) process.exit(7);
  if (op === "quit") {
    if (flags.has("ignore-quit")) return;
    say({ id, ok: true, op, result: {} }, () => process.exit(0));
    return;
  }
  if (LACKED.has(op)) {
    say({ id, ok: false, op, error: `this game has no ${op}`, code: "unsupported" });
    return;
  }
  const handler = Object.hasOwn(OPS, op) ? OPS[op] : null;
  if (!handler) {
    say({ id, ok: false, op, error: `unknown op ${op}`, code: "unknown-op", available: [...Object.keys(OPS), "quit"] });
    return;
  }
  try {
    say({ id, ok: true, op, result: handler(request) });
  } catch (error) {
    const code = error instanceof BadArgs ? "bad-args" : "unsupported";
    say({ id, ok: false, op, error: String(error.message), code });
  }
  if (flags.has("noise")) say({ event: "log", text: `answered ${op}` });
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  buffered += text;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      say({ ok: false, op: null, error: "not JSON", code: "bad-args" });
      continue;
    }
    if (request && typeof request === "object" && !Array.isArray(request)) answer(request);
    else say({ ok: false, op: null, error: "not an object", code: "bad-args" });
  }
});
process.stdin.on("end", () => {
  // A game that ignores quit ignores its closed stdin too: only a kill ends it.
  if (!flags.has("never-ready") && !flags.has("ignore-quit")) process.exit(0);
});

if (typeof flags.get("pid-file") === "string") writeFileSync(flags.get("pid-file"), String(process.pid));

/** Write to stderr the way a native engine does: blocking until the reader takes it. */
function blockingStderr(text) {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; ) {
    try {
      at += writeSync(2, bytes, at);
    } catch (error) {
      if (error.code !== "EAGAIN") throw error;
    }
  }
}

if (typeof flags.get("stderr") === "string") blockingStderr(`${flags.get("stderr")}\n`);
if (typeof flags.get("stderr-flood") === "string") {
  const line = `${"engine log ".repeat(9)}\n`;
  const lines = Math.ceil(Number(flags.get("stderr-flood")) / line.length);
  blockingStderr(line.repeat(lines));
}
if (flags.has("crash")) process.exit(3);

if (flags.has("fatal")) {
  say({ event: "fatal", error: "fake fatal: no display" }, () => process.exit(1));
} else if (!flags.has("never-ready")) {
  if (flags.has("noise")) {
    process.stdout.write("booting, not json\n");
    say({ event: "log", text: "loading" });
  }
  say({ event: "ready", protocol: 3, name: "fake-play-game", pid: process.pid });
}
