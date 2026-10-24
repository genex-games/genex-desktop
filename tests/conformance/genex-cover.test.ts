/**
 * The game's Genex cover in Studio: one real 16:9 frame of the game, staged by the game itself as
 * the demo named `genex-cover`, photographed by the host (`observe` with a `still`) into the Genex
 * plugin's own storage, checked with genex__cover and sent with the pinned CLI's
 * `genex cover <file> --json`: after a publish has been recorded, or at once with genex__cover-set.
 *
 * Studio never sends a frame nobody staged, never reads the game folder for one, and a cover can
 * never block or fail a publish: it is sent only after the upload is recorded, and whatever Genex
 * answers (refused, limited, down, silent) leaves the publish done with a warning.
 *
 * The publish cases run the real pinned CLI against a fixture Genex API on 127.0.0.1, with a bare
 * git repo on disk as the managed source repo. Nothing leaves the machine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { createGenexPlugin } from "../../src/plugins/genex/backend.ts";
import {
  CLIP_MESSAGE,
  CLIP_VIEW,
  COVER_CLIP,
  clipSentRecord,
  clipToSend,
  readClipAnswer,
} from "../../src/plugins/genex/clip.ts";
import {
  COVER_AUTO_GAP_MS,
  COVER_MAX_BYTES,
  COVER_VIEW,
  type CoverCamera,
  decideSend,
  INVOCATION_BUDGET_MS,
  MESSAGE as COVER_MESSAGE,
  MIN_REMAINING_FOR_SHOT_MS,
  parseCoverAnswer,
  parseCoverView,
} from "../../src/plugins/genex/cover.ts";
import { needsCover } from "../../src/renderer/panels/plugins/genex/genex-publish-view.ts";
import {
  GenexCoverOrigin,
  GenexCoverOutcome,
  type GenexCoverSent,
  type GenexCoverShot,
} from "../../src/shared/genex.ts";
import { PluginConsentDeclined, PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import {
  buildGenexPluginFor,
  type GenexReply,
  type GenexRequest,
  startGenexFixtureApi,
} from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "racing-demo";
const SLUG = "racing-demo";
const AGENT_COVER = "https://cdn.genex.games/covers/racing-demo-agent.webp";
const OWNER_COVER = "https://cdn.genex.games/covers/racing-demo-owner.webp";
const LIT = { lumaMean: 0.45, lumaStdDev: 0.21, nearBlackFraction: 0.08, litFraction: 0.97 };

/**
 * A PNG whose header says `width`×`height`, tagged so two shots differ. The CLI reads only the
 * header before uploading, and the fixture never decodes pixels.
 */
function png(tag: string, width = 1920, height = 1080): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("tEXt", Buffer.from(`studio-cover-test\0${tag}`)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** What the host's `observe` answers for a still of the genex-cover demo. */
const still = (tag: string, size: { width: number; height: number } = { width: 1920, height: 1080 }) => ({
  still: {
    image: png(tag, size.width, size.height),
    mimeType: "image/png",
    width: size.width,
    height: size.height,
    source: "page",
    view: { demo: COVER_VIEW },
    stats: LIT,
    preview: Buffer.from(`jpeg preview of ${tag}`),
  },
});
const noDemo = { stillProblem: { code: "view_unknown", available: ["jump", "boss"] } };

/** A camera as the backend hands one to a publish: the host's still, inside an invocation begun at `invokedAt`. */
function camera(answer: () => unknown, invokedAt = Date.now()): CoverCamera & { shots: number } {
  const lens = {
    invokedAt,
    shots: 0,
    shoot: async () => {
      lens.shots++;
      return answer();
    },
  };
  return lens;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const run = (command: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });

/** Every file under `dir`, relative to it and sorted. */
async function filesUnder(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

/** Wait until `check` holds, polling; a check that never holds fails by name. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/**
 * What genex.games keeps of an uploaded clip, mirrored from its transcoder (genex-demo
 * `apps/api/src/cover/clip-transcoder.ts`, `leadInMsFor` and the 150-frame check): it trims up to
 * 300 ms of the start, everything past five seconds, then needs 150 frames at 30 fps, else the clip
 * is refused as too short.
 */
const GENEX_KEEPS = { frames: 150, fps: 30, maxLeadInMs: 300 } as const;
const framesGenexKeeps = (durationMs: number): number => {
  const keptMs = (GENEX_KEEPS.frames / GENEX_KEEPS.fps) * 1000;
  const leadInMs = Math.min(GENEX_KEEPS.maxLeadInMs, Math.max(0, Math.round(durationMs - keptMs)));
  return Math.min(GENEX_KEEPS.frames, Math.floor(((durationMs - leadInMs) * GENEX_KEEPS.fps) / 1000));
};

describe("the clip's length", () => {
  it("leaves genex.games five whole seconds after it trims the start, a frame short or not", () => {
    // The incident: Simple Fast Tic Tac Toe's 5.0077 s recording kept 149 frames and was refused.
    assert.equal(framesGenexKeeps(5007.7), 149);
    const asked = COVER_CLIP.seconds * 1000;
    const oneFrame = 1000 / COVER_CLIP.fps;
    for (const recorded of [asked - oneFrame, asked, asked + oneFrame])
      assert.equal(framesGenexKeeps(recorded), GENEX_KEEPS.frames, `${recorded} ms recorded`);
  });
});

describe("which frame is sent", () => {
  const shot = (sha256: string): GenexCoverShot => ({
    sha256,
    width: 1920,
    height: 1080,
    mimeType: "image/png",
    bytes: 1000,
    source: "page",
    stats: LIT,
    takenAt: "2026-10-09T10:00:00.000Z",
  });
  const sent = (kind: GenexCoverSent["kind"], sha256?: string): GenexCoverSent => ({
    kind,
    at: "2026-10-09T10:00:00.000Z",
    ...(sha256 ? { sha256 } : {}),
  });

  it("sends a frame Genex has not answered for, and nothing for one it has or for none at all", () => {
    const rows: Array<[string, GenexCoverShot | null, GenexCoverSent | null, ReturnType<typeof decideSend>]> = [
      ["no shot", null, null, { send: false, kind: GenexCoverOutcome.None }],
      ["no shot, an earlier answer", null, sent(GenexCoverOutcome.Applied, "a"), { send: false, kind: "none" }],
      ["a first shot", shot("a"), null, { send: true }],
      ["the frame Genex set", shot("a"), sent(GenexCoverOutcome.Applied, "a"), { send: false, kind: "unchanged" }],
      [
        "the frame the owner outranked",
        shot("a"),
        sent(GenexCoverOutcome.Outranked, "a"),
        { send: false, kind: "unchanged" },
      ],
      ["the frame Genex refused", shot("a"), sent(GenexCoverOutcome.Rejected, "a"), { send: false, kind: "unchanged" }],
      ["a file that is no cover", shot("a"), sent(GenexCoverOutcome.Invalid, "a"), { send: false, kind: "unchanged" }],
      ["the owner's pick held", shot("a"), sent(GenexCoverOutcome.KeptOwner, "a"), { send: false, kind: "unchanged" }],
      ["already unchanged", shot("a"), sent(GenexCoverOutcome.Unchanged, "a"), { send: false, kind: "unchanged" }],
      ["a send that failed", shot("a"), sent(GenexCoverOutcome.Failed, "a"), { send: true }],
      ["a new frame", shot("b"), sent(GenexCoverOutcome.Applied, "a"), { send: true }],
      ["after a publish with no shot", shot("a"), sent(GenexCoverOutcome.None), { send: true }],
    ];
    for (const [name, frame, memo, expected] of rows) assert.deepEqual(decideSend(frame, memo), expected, name);
  });
});

describe("what the CLI says about a cover", () => {
  it("reads the CLI's one JSON line by its fields, never by its words", () => {
    const line = (value: unknown) => JSON.stringify(value);
    const file = "/storage/covers/racing-demo/shot.png";
    const rows: Array<[string, string, unknown]> = [
      [
        "set",
        line({ file, kind: "applied", coverUrl: AGENT_COVER, coverSource: "agent" }),
        { kind: "applied", coverUrl: AGENT_COVER, coverSource: "agent" },
      ],
      [
        "outranked",
        line({ file, kind: "outranked", coverUrl: OWNER_COVER, coverSource: "owner" }),
        { kind: "outranked", coverUrl: OWNER_COVER, coverSource: "owner" },
      ],
      [
        "refused, with the gate's numbers",
        line({ file, kind: "rejected", reason: "too_dark", stats: { mean: 0.05, std: 0.02, darkShare: 0.93 } }),
        { kind: "rejected", reason: "too_dark", stats: { mean: 0.05, std: 0.02, darkShare: 0.93 } },
      ],
      [
        "refused, numbers malformed",
        line({ file, kind: "rejected", reason: "flat", stats: { mean: "dark" } }),
        { kind: "rejected", reason: "flat", stats: null },
      ],
      ["refused, no reason", line({ file, kind: "rejected" }), { kind: "rejected", reason: "rejected", stats: null }],
      [
        "not a cover file",
        line({ file, kind: "invalid", message: "not a PNG" }),
        { kind: "invalid", message: "not a PNG" },
      ],
      ["failed, already printed", line({ file, kind: "failed", message: null }), { kind: "failed", message: null }],
      [
        "log lines first, then the answer",
        `Uploading…\n${line({ file, kind: "applied", coverUrl: AGENT_COVER, coverSource: "agent" })}\n`,
        { kind: "applied", coverUrl: AGENT_COVER, coverSource: "agent" },
      ],
      [
        "the last JSON line wins",
        `${line({ kind: "failed", message: "first" })}\n${line({ kind: "outranked", coverUrl: null, coverSource: null })}`,
        { kind: "outranked", coverUrl: null, coverSource: null },
      ],
      [
        "a link of the wrong type",
        line({ kind: "applied", coverUrl: 5, coverSource: true }),
        { kind: "applied", coverUrl: null, coverSource: null },
      ],
      ["no output", "", { kind: "failed", message: null }],
      ["not JSON", "Cover set — this game's cover now.", { kind: "failed", message: null }],
      ["an unknown kind", line({ kind: "painted" }), { kind: "failed", message: null }],
      ["a list", line(["applied"]), { kind: "failed", message: null }],
      [
        "the current cover, not an upload",
        line({ coverUrl: OWNER_COVER, coverSource: "owner" }),
        { kind: "failed", message: null },
      ],
    ];
    for (const [name, stdout, expected] of rows) assert.deepEqual(parseCoverAnswer(stdout), expected, name);
  });

  it("reads the hosted cover and who chose it, or nothing when the CLI could not say", () => {
    const rows: Array<[string, string, unknown]> = [
      [
        "the owner's",
        JSON.stringify({ coverUrl: OWNER_COVER, coverSource: "owner" }),
        { coverUrl: OWNER_COVER, coverSource: "owner" },
      ],
      ["none yet", JSON.stringify({ coverUrl: null, coverSource: null }), { coverUrl: null, coverSource: null }],
      ["a refusal", JSON.stringify({ file: null, kind: "failed", message: "Not signed in." }), null],
      ["garbled", "{not json", null],
      ["wrong types", JSON.stringify({ coverUrl: 1, coverSource: 2 }), { coverUrl: null, coverSource: null }],
    ];
    for (const [name, stdout, expected] of rows) assert.deepEqual(parseCoverView(stdout), expected, name);
  });
});

/** What genex__cover answers, as the assertions read it. */
type CoverAnswerView = {
  shot: GenexCoverShot & { advice: string[] };
  problem: { code: string; available?: string[] };
  kept: GenexCoverShot;
  images?: unknown;
  last: unknown;
  hosted: unknown;
};

/** The backend for a game bound as `project`, with a host that answers a still with `answer`, recording every host call. */
async function coverBackend(answer: () => unknown, project = PROJECT) {
  const temp = await tmpDir("studio-genex-cover-tool-");
  const storage = path.join(temp, "storage");
  const game = path.join(temp, "game");
  await mkdir(path.join(game, ".genex", "scratch"), { recursive: true });
  // A frame the CLI's own lane would pick up: Studio never reads it, nor anything else in the game.
  await writeFile(path.join(game, ".genex", "scratch", "cover.png"), png("planted in the game"));
  await writeFile(path.join(game, "index.html"), "<!doctype html><title>Racing</title>");
  const calls: Array<{ method: string; args: unknown }> = [];
  const plugin = await createGenexPlugin("http://127.0.0.1:9");
  const ctx = {
    project,
    directory: game,
    host: async (method: string, args?: unknown) => {
      calls.push({ method, args });
      if (method === "storage.root") return storage;
      if (method === "credentials.session") return null;
      if (method === "observe") return answer();
      if (method === "events.emit") return true;
      throw new Error(`unexpected host call ${method}`);
    },
  };
  const tool = (args: Record<string, unknown>) => plugin.tool("cover", args, ctx) as Promise<CoverAnswerView>;
  const set = () => plugin.tool("cover-set", {}, ctx);
  return { temp, storage, game, calls, tool, set };
}

describe("genex__cover", () => {
  const observeCalls = (calls: Array<{ method: string; args: unknown }>) =>
    calls.filter((call) => call.method === "observe").map((call) => call.args);

  it("photographs only the genex-cover demo into its own storage and answers with the preview", async () => {
    let frame: unknown = still("first");
    const fx = await coverBackend(() => frame);
    const posix = process.platform !== "win32";
    // Locked: a read anywhere in the game folder would fail the shot.
    if (posix) await chmod(fx.game, 0o000);
    try {
      const shot = await fx.tool({ operation: "shoot" });
      assert.deepEqual(observeCalls(fx.calls), [
        {
          project: PROJECT,
          root: fx.game,
          files: [],
          still: { demo: COVER_VIEW, width: 1920, height: 1080, maxBytes: COVER_MAX_BYTES },
        },
      ]);
      assert.deepEqual(await filesUnder(fx.storage), [
        `covers/${PROJECT}/agent.json`,
        `covers/${PROJECT}/candidates.json`,
        `covers/${PROJECT}/candidates/${sha256(png("first"))}.png`,
        `covers/${PROJECT}/shot.json`,
        `covers/${PROJECT}/shot.png`,
      ]);
      const saved = await readFile(path.join(fx.storage, "covers", PROJECT, "shot.png"));
      assert.deepEqual(saved, png("first"), "the host's still, never the frame planted in the game");
      assert.equal(shot.shot.width, 1920);
      assert.equal(shot.shot.height, 1080);
      assert.deepEqual(shot.shot.stats, LIT);
      assert.deepEqual(shot.shot.advice, []);
      assert.deepEqual(shot.images, [
        {
          mimeType: "image/jpeg",
          data: Buffer.from("jpeg preview of first").toString("base64"),
          label: COVER_MESSAGE.PreviewLabel,
        },
      ]);

      frame = noDemo;
      const missing = await fx.tool({ operation: "shoot" });
      assert.equal(missing.problem.code, "view_unknown");
      assert.deepEqual(missing.problem.available, ["jump", "boss"]);
      assert.equal(missing.kept.sha256, shot.shot.sha256, "the last shot is kept");
      assert.equal(missing.images, undefined);
      assert.deepEqual(await readFile(path.join(fx.storage, "covers", PROJECT, "shot.png")), png("first"));

      frame = { image: Buffer.from("first screen"), loadedFiles: [], consoleAvailable: true };
      const older = await fx.tool({ operation: "shoot" });
      assert.equal(older.problem.code, "unavailable", "a host without stills answers an ordinary observation");

      frame = still("small", { width: 1024, height: 768 });
      const small = await fx.tool({ operation: "shoot" });
      assert.deepEqual(small.shot.advice, ["small", "not_16_9"]);

      const status = await fx.tool({ operation: "status" });
      assert.equal(status.shot.sha256, small.shot.sha256);
      assert.equal(status.last, null, "nothing was ever sent");
      assert.equal(status.hosted, null, "no account and no hosted project: Genex is not asked");
      assert.deepEqual(
        fx.calls
          .map((call) => call.method)
          .filter((method) => !["observe", "storage.root", "credentials.session"].includes(method)),
        [],
        "a shot asks the host for nothing else",
      );
      await assert.rejects(fx.tool({ operation: "upload" }), /shoot, clip or status/);
    } finally {
      if (posix) await chmod(fx.game, 0o755);
    }
    assert.deepEqual(await filesUnder(fx.game), [".genex/scratch/cover.png", "index.html"], "the game is untouched");
  });
});

describe("the cover's storage is named by the game, never by a path", () => {
  /** Project names a binding could carry that are no folder name of their own. */
  const HOSTILE_PROJECTS: Array<[label: string, project: string]> = [
    ["a parent step", "../x"],
    ["a nested path", "a/b"],
    ["a backslash path", "a\\b"],
    ["empty", ""],
    ["the folder itself", "."],
    ["its parent", ".."],
    ["a NUL", "x\u0000"],
    ["a right-to-left override", "\u202eevil"],
    ["an absolute path", "/etc"],
  ];
  for (const [label, project] of HOSTILE_PROJECTS) {
    it(`refuses ${label} before the host is asked for a shot or anything is written`, async () => {
      const fx = await coverBackend(() => still("never asked for"), project);
      const named = /Invalid project|A project is required/;
      await assert.rejects(fx.tool({ operation: "shoot" }), named);
      await assert.rejects(fx.tool({ operation: "status" }), named);
      await assert.rejects(fx.set(), named);
      assert.deepEqual(
        fx.calls.filter((call) => call.method === "observe"),
        [],
        "no still was asked of the host",
      );
      assert.deepEqual(
        await filesUnder(fx.temp),
        ["game/.genex/scratch/cover.png", "game/index.html"],
        "nothing was written in the plugin's storage or anywhere beside it",
      );
    });
  }
});

let hasGit = false;
const originalPath = process.env.PATH;
before(async () => {
  hasGit = await run("git", ["--version"]);
  // The CLI's source push shells out to git-lfs and tries to install it when it is missing.
  const shim = await tmpDir("studio-genex-cover-bin-");
  await writeFile(path.join(shim, "git-lfs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${shim}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  process.env.PATH = originalPath;
});

/** How the fixture answers a cover commit: Genex's own answers, and one it never gives. */
type Commit = "applied" | "outranked" | "rejected" | "rate-limited" | "error" | "silent";

/** Genex's answer to a commit; `silent` never answers, and notes when the client gives up on it. */
function commitReply(mode: Commit, reply: GenexReply, closed: Promise<void>, seen: CoverSeen): unknown {
  if (mode === "applied") return reply.json({ coverUrl: AGENT_COVER, coverSource: "agent", applied: true });
  if (mode === "outranked") return reply.json({ coverUrl: OWNER_COVER, coverSource: "owner", applied: false });
  if (mode === "rejected")
    return reply.json(
      { error: "cover_rejected", reason: "too_dark", stats: { mean: 0.05, std: 0.02, darkShare: 0.93 } },
      422,
    );
  if (mode === "rate-limited") return reply.json({ error: "rate_limited" }, 429);
  if (mode === "error") return reply.json({ error: "unavailable" }, 500);
  void closed.then(() => seen.steps.push("dropped"));
  return new Promise(() => {});
}

/**
 * What the fixture saw of covers: each upload's start (with the publish job as Studio recorded it
 * then), the bytes, the commits, and every step in order, an unanswered commit's client going away too.
 */
interface CoverSeen {
  mints: Array<{ jobId?: string; jobState?: string }>;
  puts: Buffer[];
  commits: number;
  steps: string[];
}

/**
 * What the fixture answers, changed mid-test: who chose the cover, how a commit goes, and whether
 * the game is listed (set here as the owner's own dashboard does, with no deploy from Studio).
 */
interface Live {
  coverSource: string | null;
  commit: Commit;
  game: { status: string; stagingCommitSha: string };
  /** Whether the draft's page serves the upload: while false, a draft's readiness check fails. */
  serving: boolean;
  /** Runs once, the next time Genex is asked about the game by its slug, before it answers. */
  whileAsked?: () => Promise<unknown>;
}

const UPLOAD_LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 100_000_000,
  maxTotalBytes: 1_000_000_000,
  partSizeBytes: 5_000_000,
  singlePutMaxBytes: 5_000_000,
};

/**
 * Genex's routes for publishing one hosted game: the project, the source push, the uploads, the
 * draft, the promotion and the listing. The owner's view by slug also says who chose the cover.
 */
function publishRoutes(pushUrl: string, live: Live, api: () => string) {
  const files = new Map<string, string>();
  const { game } = live;
  const thumbnail = () => (live.coverSource === "owner" ? OWNER_COVER : live.coverSource && AGENT_COVER);
  const exact: Record<string, (request: GenexRequest, reply: GenexReply) => unknown> = {
    "POST /api/projects": (_request, reply) =>
      reply.json({
        project: { id: "p1", slug: SLUG, cloneUrl: pushUrl, playUrl: "https://racing-demo.genex.technology/" },
      }),
    [`GET /api/projects/by-slug/${SLUG}`]: async (_request, reply) => {
      const meanwhile = live.whileAsked;
      live.whileAsked = undefined;
      await meanwhile?.();
      return reply.json({ project: { slug: SLUG, ...game, thumbnailUrl: thumbnail(), coverSource: live.coverSource } });
    },
    "POST /api/projects/p1/push-token": (_request, reply) => reply.json({ pushUrl, managed: true }),
    "POST /api/projects/p1/publish": (_request, reply) => {
      game.status = "published";
      reply.json({ ok: true });
    },
    "POST /api/games/p1/upload-token": (_request, reply) =>
      reply.json({
        token: "fixture-upload-token",
        uploadUrl: `${api()}/upload`,
        playUrl: `${api()}/live`,
        channels: ["staging", "production"],
        limits: UPLOAD_LIMITS,
      }),
    "POST /api/games/p1/publish": ({ body }, reply) => {
      const deploy = JSON.parse(body || "{}");
      game.stagingCommitSha = deploy.commit;
      reply.json({ url: `${api()}/live`, channel: deploy.channel ?? "production" });
    },
    "POST /api/games/p1/promote": (_request, reply) =>
      reply.json({ commit: game.stagingCommitSha, url: `${api()}/live` }),
  };
  return (request: GenexRequest, reply: GenexReply): unknown => {
    const { method, url, body } = request;
    const route = exact[`${method} ${url}`];
    if (route) return route(request, reply);
    if (url.startsWith("/upload/") && method === "PUT") {
      files.set(decodeURIComponent(url.slice("/upload/".length)), body);
      return reply.json({ ok: true });
    }
    if (url.startsWith("/live/")) return serveLive(url, live.serving ? files : new Map(), reply);
    if (url.startsWith("/api/gallery/world/")) return reply.json({ item: null });
    return undefined;
  };
}

/** The draft's page: a file the last upload sent, or 404 for any other (all of them while it serves none). */
function serveLive(url: string, files: Map<string, string>, reply: GenexReply): unknown {
  const served = files.get(decodeURIComponent(url.slice("/live/".length).split("?")[0] ?? ""));
  return reply.text(served ?? "missing", served === undefined ? 404 : 200);
}

/** Genex's cover routes: each upload's start (noting Studio's record of the publish job), its PUT and its commit. */
function coverRoutes(seen: CoverSeen, live: Live, api: () => string, record: string) {
  return async ({ method, url, bytes, closed }: GenexRequest, reply: GenexReply): Promise<unknown> => {
    if (url === "/api/projects/p1/cover/upload-url" && method === "POST") {
      const studio = JSON.parse(await readFile(record, "utf8").catch(() => "{}"));
      seen.mints.push({ jobId: studio.job?.id, jobState: studio.job?.state });
      seen.steps.push("mint");
      return reply.json({
        uploadUrl: `${api()}/cover-put/${seen.mints.length}`,
        key: `covers/p1/${seen.mints.length}`,
      });
    }
    if (url.startsWith("/cover-put/") && method === "PUT") {
      seen.puts.push(bytes);
      return reply.text("", 200);
    }
    if (url === "/api/projects/p1/cover/commit" && method === "POST") {
      seen.commits++;
      seen.steps.push("commit");
      return commitReply(live.commit, reply, closed, seen);
    }
    return undefined;
  };
}

const isCoverRoute = (url: string) => url.startsWith("/api/projects/p1/cover/") || url.startsWith("/cover-put/");

/**
 * A fixture Genex for one hosted game, with the cover routes: the owner's view (by slug, with who
 * chose the cover), the upload grant, the PUT and the commit. `live` changes its answers mid-test.
 */
async function coverFixture(options: { sendMs?: number } = {}) {
  const temp = await tmpDir("studio-genex-cover-");
  const bare = path.join(temp, "source.git");
  await mkdir(bare, { recursive: true });
  assert.ok(await run("git", ["init", "--bare", "-q", bare]));
  const live: Live = {
    coverSource: null,
    commit: "applied",
    game: { status: "draft", stagingCommitSha: "" },
    serving: true,
  };
  const seen: CoverSeen = { mints: [], puts: [], commits: 0, steps: [] };
  let api = "";
  const host = path.join(temp, "host");
  const publishing = publishRoutes(pathToFileURL(bare).href, live, () => api);
  const covers = coverRoutes(seen, live, () => api, path.join(host, "publish", PROJECT, "publish.json"));
  const server = await startGenexFixtureApi((request, reply) =>
    isCoverRoute(request.url) ? covers(request, reply) : publishing(request, reply),
  );
  api = server.url;
  const game = path.join(temp, "game");
  await mkdir(game);
  await writeFile(path.join(game, "index.html"), "<!doctype html><title>Racing</title>");
  const genex = new GenexTools(host, api, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    ...(options.sendMs ? { coverTimeouts: { sendMs: options.sendMs } } : {}),
  });
  const workspace = path.join(host, "publish", PROJECT);
  /** What the host's `export.stage` answers: the public copy, written into Studio's own workspace. */
  const exportStage = async () => {
    const dist = path.join(workspace, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), '<!doctype html><meta charset="utf-8"><title>Racing</title>');
    return { dir: dist, files: 1, included: ["index.html"], excluded: [] };
  };
  const start = (kind: "gallery" | "draft", lens?: CoverCamera) =>
    kind === "gallery"
      ? genex.publishGallery(PROJECT, exportStage, "Racing Demo", lens)
      : genex.publishDraft(PROJECT, exportStage, lens);
  /** Publish, then wait as an agent does: for the job, and then for its cover. */
  const publish = async (kind: "gallery" | "draft", lens?: CoverCamera) => {
    const started = await start(kind, lens);
    return genex.publishWait(PROJECT, started.job?.id);
  };
  return { genex, live, seen, game, host, start, publish, close: () => server.close() };
}

describe("a publish sends the staged frame after it is done", () => {
  it("sends the genex-cover frame once the job is recorded done, and leaves the game alone", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      const before = await filesUnder(fx.game);
      const lens = camera(() => still("first"));
      const done = await fx.publish("gallery", lens);
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(lens.shots, 1, "Publish shoots the demo again after exporting");
      assert.deepEqual(fx.seen.mints, [{ jobId: done.job?.id, jobState: "done" }], "sent only after the job was done");
      assert.deepEqual(fx.seen.puts, [png("first")]);
      assert.equal(done.cover?.last?.kind, GenexCoverOutcome.Applied);
      assert.equal(done.cover?.last?.jobId, done.job?.id);
      assert.equal(done.cover?.last?.coverUrl, AGENT_COVER);
      assert.equal(done.cover?.sending, false);
      assert.equal(done.warnings, undefined);
      assert.deepEqual(await filesUnder(fx.game), before, "the game folder is never written");
      const scratch = await filesUnder(path.join(fx.host, "publish", PROJECT, ".genex", "scratch"));
      assert.deepEqual(scratch, [], "nothing for the CLI's own scratch pickup");
    } finally {
      await fx.close();
    }
  });

  it("sends nothing for a frame Genex already has, and uploads nothing over the owner's own pick", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      const again = await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      assert.equal(again.cover?.last?.kind, GenexCoverOutcome.Unchanged);
      assert.equal(fx.seen.mints.length, 1, "an unchanged frame is not uploaded again");
      fx.live.coverSource = "owner";
      const owned = await fx.publish(
        "gallery",
        camera(() => still("second")),
      );
      assert.equal(owned.job?.state, "done", owned.job?.error);
      assert.equal(owned.cover?.last?.kind, GenexCoverOutcome.KeptOwner);
      assert.equal(owned.cover?.last?.coverUrl, OWNER_COVER);
      assert.equal(fx.seen.mints.length, 1, "the owner's cover stands: nothing is uploaded");
      assert.equal(owned.warnings, undefined);
    } finally {
      await fx.close();
    }
  });
});

describe("a cover never fails a publish", () => {
  it("leaves the job done with a warning when Genex refuses, limits, fails or never answers", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture({ sendMs: 3000 });
    try {
      const rows: Array<[Commit, GenexCoverSent["kind"]]> = [
        ["rejected", GenexCoverOutcome.Rejected],
        ["rate-limited", GenexCoverOutcome.Failed],
        ["error", GenexCoverOutcome.Failed],
        ["silent", GenexCoverOutcome.Failed],
      ];
      for (const [commit, kind] of rows) {
        fx.live.commit = commit;
        const done = await fx.publish(
          "gallery",
          camera(() => still(commit)),
        );
        assert.equal(done.job?.state, "done", `${commit}: ${done.job?.error}`);
        assert.equal(done.job?.phase, "ready", commit);
        assert.equal(done.cover?.last?.kind, kind, commit);
        assert.equal(done.cover?.last?.jobId, done.job?.id, commit);
        const lines = done.cover?.last?.lines ?? [];
        assert.ok(lines.length > 0, `${commit}: the outcome is explained`);
        for (const line of lines) assert.ok(done.warnings?.includes(line), `${commit}: ${line}`);
        assert.equal(done.lastError, undefined, `${commit}: a cover is never the publish's error`);
      }
      assert.equal(fx.seen.commits, 4);
      fx.live.commit = "applied";
      const retried = await fx.publish(
        "gallery",
        camera(() => still("silent")),
      );
      assert.equal(retried.cover?.last?.kind, GenexCoverOutcome.Applied, "a failed send is tried again");
      const refused = await fx.publish(
        "gallery",
        camera(() => still("rejected")),
      );
      assert.equal(refused.cover?.last?.kind, GenexCoverOutcome.Applied, "a new frame after a refusal is sent");
    } finally {
      await fx.close();
    }
  });
});

describe("a cover the plugin cannot keep never holds up a publish", () => {
  it("publishes, says the new shot was not kept, and lets the next publish start", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      // The plugin's own storage cannot take the shot (a full disk, a permission): a file where its folder goes.
      const blocked = path.join(fx.host, "covers", PROJECT);
      await mkdir(path.dirname(blocked), { recursive: true });
      await writeFile(blocked, "not a folder");
      const done = await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.job?.phase, "ready");
      assert.ok(done.warnings?.includes(COVER_MESSAGE.ShotNotKept), JSON.stringify(done.warnings));
      assert.ok(!JSON.stringify(done).includes(blocked), "Studio's storage path is never in the answer");
      assert.deepEqual(fx.seen.mints, [], "no frame was sent");
      await rm(blocked);
      const next = await fx.publish(
        "gallery",
        camera(() => still("second")),
      );
      assert.notEqual(next.job?.id, done.job?.id, "a new publish started");
      assert.equal(next.job?.state, "done", next.job?.error);
      assert.deepEqual(fx.seen.puts, [png("second")]);
    } finally {
      await fx.close();
    }
  });
});

describe("when a publish shoots and sends", () => {
  it("with no genex-cover demo sends nothing and says Genex keeps its own cover", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      const done = await fx.publish(
        "gallery",
        camera(() => noDemo),
      );
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.cover?.last?.kind, GenexCoverOutcome.None);
      assert.equal(done.cover?.shot, null);
      assert.deepEqual(fx.seen.mints, []);
      assert.ok(done.warnings?.includes(COVER_MESSAGE.NoShotSent));
    } finally {
      await fx.close();
    }
  });

  it("with too little of the request left skips the new shot and sends the last one", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("kept")),
      );
      const late = Date.now() - (INVOCATION_BUDGET_MS - MIN_REMAINING_FOR_SHOT_MS) - 1000;
      const lens = camera(() => still("fresh"), late);
      const done = await fx.publish("gallery", lens);
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(lens.shots, 0, "no shot is started that could outlast the request");
      assert.deepEqual(fx.seen.puts, [png("kept")]);
      assert.ok(done.warnings?.includes(COVER_MESSAGE.NoTimeToShoot));
    } finally {
      await fx.close();
    }
  });

  it("sends from a never-public game's draft, and never from a listed game's draft", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      const first = await fx.publish(
        "draft",
        camera(() => still("draft")),
      );
      assert.ok(first.job?.uploadedAt, first.job?.error);
      assert.equal(first.cover?.last?.kind, GenexCoverOutcome.Applied, "a draft of a game never public sends it");
      assert.deepEqual(fx.seen.puts, [png("draft")]);
      const listed = await fx.publish(
        "gallery",
        camera(() => still("draft")),
      );
      assert.equal(listed.status, "published", listed.job?.error);
      const lens = camera(() => still("later"));
      const draft = await fx.publish("draft", lens);
      assert.ok(draft.job?.uploadedAt, draft.job?.error);
      assert.equal(lens.shots, 0, "a listed game's draft takes no shot");
      assert.equal(fx.seen.mints.length, 1, "and sends nothing");
      assert.notEqual(draft.cover?.last?.jobId, draft.job?.id);
    } finally {
      await fx.close();
    }
  });

  it("stops the cover upload of a publish when the next one starts", { timeout: 120_000 }, async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture({ sendMs: 10 * 60_000 });
    try {
      fx.live.commit = "silent";
      const first = await fx.start(
        "gallery",
        camera(() => still("first")),
      );
      await until(() => fx.seen.commits === 1, "the first publish's cover commit");
      assert.equal((await fx.genex.publishView(PROJECT)).cover?.sending, true);
      fx.live.commit = "applied";
      const second = await fx.publish(
        "gallery",
        camera(() => still("second")),
      );
      assert.deepEqual(
        fx.seen.steps,
        ["mint", "commit", "dropped", "mint", "commit"],
        "the first upload was stopped before the second publish sent its own",
      );
      assert.notEqual(second.job?.id, first.job?.id);
      assert.equal(second.cover?.last?.kind, GenexCoverOutcome.Applied);
      assert.equal(second.cover?.last?.jobId, second.job?.id);
      assert.equal(fx.seen.commits, 2);
      assert.deepEqual(fx.seen.puts, [png("first"), png("second")]);
    } finally {
      await fx.close();
    }
  });
});

describe("the owner's own cover, while Studio keeps no shot", () => {
  it("is recorded as the owner's pick by a publish, so the dialog asks for no cover over it", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      const first = await fx.publish(
        "gallery",
        camera(() => noDemo),
      );
      assert.equal(first.cover?.last?.kind, GenexCoverOutcome.None, first.job?.error);
      assert.equal(needsCover(first), true, "no shot and no cover the owner chose: Studio takes one");
      // The owner sets the game's cover on genex.games; Studio still has no genex-cover shot.
      fx.live.coverSource = "owner";
      const owned = await fx.publish(
        "gallery",
        camera(() => noDemo),
      );
      assert.equal(owned.job?.state, "done", owned.job?.error);
      assert.equal(owned.cover?.shot, null);
      assert.equal(owned.cover?.last?.kind, GenexCoverOutcome.KeptOwner);
      assert.equal(owned.cover?.last?.jobId, owned.job?.id);
      assert.equal(owned.cover?.last?.coverUrl, OWNER_COVER);
      assert.equal(owned.warnings?.includes(COVER_MESSAGE.NoShotSent), false, "nobody is told no cover was sent");
      assert.deepEqual(fx.seen.mints, [], "nothing is uploaded");
      assert.equal(needsCover(owned), false, "Studio takes no cover over the owner's");
    } finally {
      await fx.close();
    }
  });

  it("is recorded as the owner's pick by a status check, so the ask ends before the next publish", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.publish(
        "gallery",
        camera(() => noDemo),
      );
      fx.live.coverSource = "owner";
      const status = await fx.genex.coverStatus(PROJECT);
      assert.equal((status.hosted as { coverSource: string }).coverSource, "owner");
      assert.equal((status.last as GenexCoverSent).kind, GenexCoverOutcome.KeptOwner);
      assert.equal(needsCover(await fx.genex.publishView(PROJECT)), false);
      assert.deepEqual(fx.seen.mints, [], "a status check uploads nothing");
    } finally {
      await fx.close();
    }
  });
});

describe("a draft's cover", () => {
  it("sends a first draft's frame once its upload is recorded, while its page is still being checked", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      // The draft landed but its page does not serve it yet: the check is retried, the job runs on.
      fx.live.serving = false;
      const draft = await fx.publish(
        "draft",
        camera(() => still("draft")),
      );
      assert.ok(draft.job?.uploadedAt, draft.job?.error);
      assert.equal(draft.job?.state, "running");
      assert.equal(draft.job?.phase, "verifying-deployment");
      assert.deepEqual(
        fx.seen.mints,
        [{ jobId: draft.job?.id, jobState: "running" }],
        "sent after the upload, not the check",
      );
      assert.equal(draft.cover?.last?.kind, GenexCoverOutcome.Applied);
      assert.equal(draft.cover?.last?.jobId, draft.job?.id);
    } finally {
      await fx.close();
    }
  });

  it("never sends from a draft of a game its owner listed on genex.games, whatever Studio last recorded", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      const first = await fx.publish(
        "draft",
        camera(() => still("draft")),
      );
      assert.equal(first.cover?.last?.kind, GenexCoverOutcome.Applied, first.job?.error);
      // The owner lists the game with the dashboard's Publish button: Studio deploys nothing and
      // its own record still says draft until it next asks Genex.
      fx.live.game.status = "published";
      const draft = await fx.publish(
        "draft",
        camera(() => still("later")),
      );
      assert.ok(draft.job?.uploadedAt, draft.job?.error);
      assert.equal(draft.status, "published", "the draft's record learned the game is listed");
      assert.equal(fx.seen.mints.length, 1, "and its cover was not sent");
      assert.notEqual(draft.cover?.last?.jobId, draft.job?.id);
    } finally {
      await fx.close();
    }
  });
});

describe("genex__cover-set", () => {
  it("sends nothing without a hosted project: the shot goes with the first publish", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("first")),
      );
      const answer = await fx.genex.coverSet(PROJECT);
      assert.equal(answer.kind, GenexCoverOutcome.NotHosted);
      assert.deepEqual(fx.seen.mints, []);
    } finally {
      await fx.close();
    }
  });

  it("sends the current shot now, and reports Genex's answer", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("second")),
      );
      const applied = await fx.genex.coverSet(PROJECT);
      assert.equal(applied.kind, GenexCoverOutcome.Applied);
      assert.deepEqual(fx.seen.puts, [png("first"), png("second")]);
      const unchanged = await fx.genex.coverSet(PROJECT);
      assert.equal(unchanged.kind, GenexCoverOutcome.Unchanged);
      fx.live.commit = "outranked";
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("third")),
      );
      const outranked = await fx.genex.coverSet(PROJECT);
      assert.equal(outranked.kind, GenexCoverOutcome.Outranked);
      assert.equal(outranked.coverUrl, OWNER_COVER);
      assert.equal(fx.seen.puts.length, 3);
    } finally {
      await fx.close();
    }
  });
});

describe("a shot taken while a send runs", () => {
  it("never changes what that send uploads or records: the bytes sent are the bytes it names", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("second")),
      );
      // The agent shoots again while cover-set's send asks Genex who chose the cover.
      fx.live.whileAsked = () =>
        fx.genex.coverShoot(
          PROJECT,
          camera(() => still("third")),
        );
      const sent = await fx.genex.coverSet(PROJECT);
      assert.equal(sent.kind, GenexCoverOutcome.Applied);
      assert.deepEqual(fx.seen.puts.at(-1), png("second"), "the send uploads the shot it set out with");
      assert.equal(sent.sha256, sha256(png("second")), "and records those bytes");
      const next = await fx.genex.coverSet(PROJECT);
      assert.equal(next.kind, GenexCoverOutcome.Applied, "the newer shot is not mistaken for one Genex has");
      assert.deepEqual(fx.seen.puts.at(-1), png("third"));
      const left = await filesUnder(path.join(fx.host, "covers", PROJECT));
      const beside = left.filter((name) => !name.startsWith("candidates"));
      assert.deepEqual(
        beside,
        ["agent.json", "sent.json", "shot.json", "shot.png"],
        "no copy of a sent frame is left behind",
      );
    } finally {
      await fx.close();
    }
  });
});

test("genex__cover-set waits for the user's yes, and a no sends nothing; genex__cover asks nobody", async () => {
  const temp = await tmpDir("studio-genex-cover-consent-");
  const requests: string[] = [];
  const server = await startGenexFixtureApi(({ url }) => {
    requests.push(url);
  });
  const resources = path.join(temp, "resources");
  await buildGenexPluginFor(resources, server.url);
  const data = path.join(temp, "data");
  const game = path.join(temp, "game");
  await mkdir(data);
  await mkdir(game);
  const service = async (_id: string, method: string) => {
    if (method === "storage.root") return data;
    if (method === "credentials.session") return "fixture-token";
    if (method === "events.emit") return true;
    throw new Error(`unexpected service ${method}`);
  };
  const registry = new PluginRegistry(
    path.join(temp, "installed"),
    path.join(resources, "plugins"),
    path.join(resources, "plugin-sdk/backend.mjs"),
    service,
  );
  const asked: string[] = [];
  registry.consent = async (_id, tool) => {
    asked.push(tool.name);
    return { approved: false, by: "user" };
  };
  try {
    await registry.init();
    const binding = { project: PROJECT, directory: game };
    await assert.rejects(registry.tool("genex__cover-set", {}, binding), PluginConsentDeclined);
    assert.deepEqual(asked, ["cover-set"]);
    const status = (await registry.tool("genex__cover", { operation: "status" }, binding)) as Record<string, unknown>;
    assert.equal(status.shot, null);
    assert.deepEqual(asked, ["cover-set"], "checking the cover asks nobody");
    assert.deepEqual(requests, [], "nothing reached Genex");
  } finally {
    registry.cancel();
    await server.close();
  }
});

/** A camera that answers the genex-cover demo with `demo()` and Studio's plain frame with `plain()`, recording which it was asked for. */
function twoViewCamera(demo: () => unknown, plain: () => unknown) {
  const asked: Array<"demo" | "plain"> = [];
  const lens: CoverCamera & { asked: typeof asked } = {
    invokedAt: Date.now(),
    asked,
    shoot: async (view) => {
      asked.push(view ? "plain" : "demo");
      return view ? plain() : demo();
    },
  };
  return lens;
}

/** A Genex plugin with no account and no network, on a clock the test moves. */
async function localGenex() {
  const temp = await tmpDir("studio-genex-cover-auto-");
  const clock = { now: Date.parse("2026-10-16T12:00:00Z") };
  const genex = new GenexTools(temp, "http://127.0.0.1:9", {
    credentials: { get: async () => null, set: async () => {}, clear: async () => {} },
    now: () => clock.now,
  });
  await genex.init();
  const dir = path.join(temp, "covers", PROJECT);
  return { genex, clock, dir };
}

describe("the frames the person flips between", () => {
  it("keeps the last four shots, newest first, each image once", async () => {
    let tag = "one";
    const fx = await coverBackend(() => still(tag));
    const shas: string[] = [];
    for (const next of ["one", "two", "three", "four", "five"]) {
      tag = next;
      shas.push((await fx.tool({ operation: "shoot" })).shot.sha256);
    }
    const dir = path.join(fx.storage, "covers", PROJECT);
    const listed = JSON.parse(await readFile(path.join(dir, "candidates.json"), "utf8")) as GenexCoverShot[];
    assert.deepEqual(
      listed.map((c) => c.sha256),
      shas.slice(1).reverse(),
      "newest first, the oldest gone",
    );
    assert.deepEqual(
      (await readdir(path.join(dir, "candidates"))).sort(),
      shas
        .slice(1)
        .map((sha) => `${sha}.png`)
        .sort(),
      "the oldest image went with its record",
    );
    tag = "three";
    await fx.tool({ operation: "shoot" });
    const again = JSON.parse(await readFile(path.join(dir, "candidates.json"), "utf8")) as GenexCoverShot[];
    assert.equal(again.length, 4, "a frame shot again moves to the front instead of twice");
    assert.equal(again[0]?.sha256, shas[2]);
  });

  it("makes a picked frame the kept shot, pinned, and refuses a name that is no candidate", async () => {
    const { genex, dir } = await localGenex();
    await genex.coverShoot(
      PROJECT,
      camera(() => still("first")),
    );
    await genex.coverShoot(
      PROJECT,
      camera(() => still("second")),
    );
    const first = sha256(png("first"));
    const picked = await genex.coverPick(PROJECT, first);
    assert.equal(picked.cover?.shot?.sha256, first);
    assert.equal(picked.cover?.shot?.pinned, true);
    assert.deepEqual(await readFile(path.join(dir, "shot.png")), png("first"));
    assert.deepEqual(
      picked.cover?.candidates?.map((c) => c.sha256),
      [sha256(png("second")), first],
      "picking reorders nothing",
    );
    for (const hostile of ["../shot", "a".repeat(64), first.toUpperCase(), 42, null])
      await assert.rejects(genex.coverPick(PROJECT, hostile), /no longer among/, String(hostile));
    assert.deepEqual(await readFile(path.join(dir, "shot.png")), png("first"), "a refused pick changes nothing");
    const fresh = await genex.coverShoot(
      PROJECT,
      camera(() => still("third")),
    );
    assert.equal((fresh.shot as GenexCoverShot).pinned, undefined, "a new shot replaces the pick");
  });
});

describe("Studio's own cover step", () => {
  it("shoots the genex-cover demo when the game has one", async () => {
    const { genex } = await localGenex();
    const lens = twoViewCamera(
      () => still("demo"),
      () => still("plain"),
    );
    const state = await genex.coverAuto(PROJECT, lens);
    assert.deepEqual(lens.asked, ["demo"]);
    assert.equal(state.cover?.shot?.sha256, sha256(png("demo")));
    assert.equal(state.cover?.shot?.origin, undefined, "a demo's frame");
  });

  it("takes a plain frame of a game with no demo, and replaces it with the demo's once there is one", async () => {
    const { genex, clock } = await localGenex();
    let demo: unknown = noDemo;
    const lens = twoViewCamera(
      () => demo,
      () => still("plain"),
    );
    const plain = await genex.coverAuto(PROJECT, lens);
    assert.deepEqual(lens.asked, ["demo", "plain"]);
    assert.equal(plain.cover?.shot?.origin, GenexCoverOrigin.Studio);
    clock.now += COVER_AUTO_GAP_MS;
    demo = still("demo");
    const staged = await genex.coverAuto(PROJECT, lens);
    assert.equal(staged.cover?.shot?.sha256, sha256(png("demo")));
    assert.equal(staged.cover?.shot?.origin, undefined);
  });

  it("never puts a plain frame over a demo's frame, nor any frame over a pick or the owner's cover", async () => {
    const { genex, clock, dir } = await localGenex();
    await genex.coverShoot(
      PROJECT,
      camera(() => still("demo")),
    );
    const lens = twoViewCamera(
      () => noDemo,
      () => still("plain"),
    );
    const kept = await genex.coverAuto(PROJECT, lens);
    assert.deepEqual(lens.asked, ["demo"], "the demo is gone, so no new frame, and no plain one over its last");
    assert.equal(kept.cover?.shot?.sha256, sha256(png("demo")));

    clock.now += COVER_AUTO_GAP_MS;
    await genex.coverPick(PROJECT, sha256(png("demo")));
    const pinnedLens = twoViewCamera(
      () => still("other"),
      () => still("plain"),
    );
    await genex.coverAuto(PROJECT, pinnedLens);
    assert.deepEqual(pinnedLens.asked, [], "the person's pick stands");

    await rm(path.join(dir, "shot.json"));
    await writeFile(
      path.join(dir, "sent.json"),
      JSON.stringify({ kind: "kept_owner", at: new Date(clock.now).toISOString(), coverSource: "owner" }),
    );
    const ownerLens = twoViewCamera(
      () => still("other"),
      () => still("plain"),
    );
    await genex.coverAuto(PROJECT, ownerLens);
    assert.deepEqual(ownerLens.asked, [], "the owner's cover on Genex stands");
  });

  it("takes a game's cover at most once in a while", async () => {
    const { genex, clock } = await localGenex();
    const lens = twoViewCamera(
      () => still("demo"),
      () => still("plain"),
    );
    await genex.coverAuto(PROJECT, lens);
    clock.now += COVER_AUTO_GAP_MS - 1;
    await genex.coverAuto(PROJECT, lens);
    assert.deepEqual(lens.asked, ["demo"]);
    clock.now += 1;
    await genex.coverAuto(PROJECT, lens);
    assert.deepEqual(lens.asked, ["demo", "demo"]);
  });
});

describe("a picked frame at publish", () => {
  it("goes as it is: the publish shoots no new frame over the person's pick", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("picked")),
      );
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("later")),
      );
      await fx.genex.coverPick(PROJECT, sha256(png("picked")));
      const lens = camera(() => still("fresh"));
      const done = await fx.publish("gallery", lens);
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(lens.shots, 0, "no shot over the pick");
      assert.deepEqual(fx.seen.puts, [png("picked")]);
    } finally {
      await fx.close();
    }
  });
});

/** A WebM's first bytes (its EBML header), tagged so two recordings differ. */
const webm = (tag: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`clip ${tag}`)]);
/** What the host's `observe` answers for a clip of the genex-clip demo. */
const recording = (tag: string, motion = 0.6) => ({
  clip: {
    video: webm(tag),
    mimeType: "video/webm",
    width: 960,
    height: 540,
    durationMs: 5000,
    view: { demo: CLIP_VIEW },
    poster: Buffer.from(`poster of ${tag}`),
    motion,
  },
});

describe("which frames the agent took itself", () => {
  it("reports when the agent last kept a shot and a clip; Studio's own takes leave those times", async () => {
    const { genex, clock, dir } = await localGenex();
    const agentAt = new Date(clock.now).toISOString();
    await genex.coverShoot(
      PROJECT,
      camera(() => still("agent")),
    );
    await genex.coverClip(PROJECT, { ...camera(() => still("x")), record: async () => recording("agent") });
    assert.deepEqual((await genex.publishView(PROJECT)).cover?.agentTook, { shot: agentAt, clip: agentAt });

    clock.now += COVER_AUTO_GAP_MS;
    const lens = {
      ...twoViewCamera(
        () => still("studio"),
        () => still("plain"),
      ),
      record: async () => recording("studio"),
    };
    const auto = await genex.coverAuto(PROJECT, lens);
    assert.equal(auto.cover?.shot?.sha256, sha256(png("studio")), "Studio's take is the kept shot now");
    assert.equal(auto.cover?.clip?.sha256, sha256(webm("studio")), "and its clip the kept clip");
    assert.deepEqual(auto.cover?.agentTook, { shot: agentAt, clip: agentAt }, "the agent's times stand");

    clock.now += 1000;
    await genex.coverShoot(
      PROJECT,
      camera(() => noDemo),
    );
    await genex.coverClip(PROJECT, {
      ...camera(() => still("x")),
      record: async () => ({ clipProblem: { code: "view_unknown" } }),
    });
    assert.deepEqual(
      (await genex.publishView(PROJECT)).cover?.agentTook,
      { shot: agentAt, clip: agentAt },
      "a shot or clip that kept nothing is no new time",
    );
    for (const hostile of ["{", "[]", '{"shot":7,"clip":"soon"}', '{"shot":"2026-10-16T12:00:00.000Z","extra":1}']) {
      await writeFile(path.join(dir, "agent.json"), hostile);
      const read = (await genex.publishView(PROJECT)).cover?.agentTook;
      const sound = hostile.includes('"shot":"') ? { shot: "2026-10-16T12:00:00.000Z" } : {};
      assert.deepEqual(read, sound, hostile);
    }
  });

  it("says nothing of the agent before it took any", async () => {
    const { genex } = await localGenex();
    await genex.coverAuto(
      PROJECT,
      twoViewCamera(
        () => still("studio"),
        () => still("plain"),
      ),
    );
    assert.deepEqual((await genex.publishView(PROJECT)).cover?.agentTook, {});
  });
});

describe("the cover clip", () => {
  it("records only the genex-clip demo into the cover's storage and says when it is frozen", async () => {
    const { genex, dir } = await localGenex();
    let answer: unknown = recording("first");
    const lens = { ...camera(() => still("x")), record: async () => answer };
    const kept = await genex.coverClip(PROJECT, lens);
    assert.equal((kept.clip as { sha256: string }).sha256, sha256(webm("first")));
    assert.deepEqual(await readFile(path.join(dir, "clip.webm")), webm("first"));
    assert.deepEqual(kept.images, [
      {
        mimeType: "image/jpeg",
        data: Buffer.from("poster of first").toString("base64"),
        label: CLIP_MESSAGE.PosterLabel,
      },
    ]);
    assert.equal(kept.guidance, CLIP_MESSAGE.Kept);
    answer = recording("still", 0.02);
    assert.equal((await genex.coverClip(PROJECT, lens)).guidance, CLIP_MESSAGE.Frozen);
    answer = { clipProblem: { code: "view_unknown", available: ["jump"] } };
    const missing = await genex.coverClip(PROJECT, lens);
    assert.equal((missing.problem as { code: string }).code, "view_unknown");
    assert.equal(missing.guidance, CLIP_MESSAGE.NoDemo);
    assert.equal((missing.kept as { sha256: string }).sha256, sha256(webm("still")), "the last clip is kept");
    for (const malformed of [
      { clip: { ...recording("x").clip, mimeType: "video/ogg" } },
      { clip: { ...recording("x").clip, motion: 2 } },
      { clip: { ...recording("x").clip, video: "not bytes" } },
      { image: Buffer.from("an ordinary observation") },
    ])
      assert.deepEqual(
        readClipAnswer(malformed),
        { problem: { code: "unavailable" } },
        JSON.stringify(Object.keys(malformed)),
      );
    const state = await genex.publishView(PROJECT);
    assert.equal(state.cover?.clip?.sha256, sha256(webm("still")), "Publish reads the kept clip");
  });

  it("reads the CLI's answer about a clip by its fields", () => {
    const clip = {
      sha256: "c".repeat(64),
      mimeType: "video/webm",
      bytes: 10,
      width: 960,
      height: 540,
      durationMs: 5000,
      motion: 0.5,
      takenAt: "2026-10-16T12:00:00Z",
    };
    const at = "2026-10-16T12:01:00Z";
    const line = (value: unknown) => JSON.stringify(value);
    const clipUrl = "https://cdn.genex.technology/covers/racing/clip.mp4";
    const rows: Array<[string, string, Record<string, unknown>]> = [
      ["applied", line({ kind: "applied", clipUrl, clipSource: "agent" }), { kind: "applied", coverUrl: clipUrl }],
      ["outranked", line({ kind: "outranked", clipUrl: null, clipSource: "owner" }), { kind: "outranked" }],
      ["frozen", line({ kind: "rejected", reason: "frozen" }), { kind: "rejected", reason: "frozen" }],
      ["lane closed", line({ kind: "failed", message: "doesn't take cover clips" }), { kind: "failed" }],
      ["an older CLI with no --clip", "error: unknown option '--clip'", { kind: "failed" }],
      ["an unknown kind", line({ kind: "painted" }), { kind: "failed" }],
    ];
    for (const [name, stdout, expected] of rows) {
      const record = clipSentRecord(stdout, clip, at);
      for (const [key, value] of Object.entries(expected)) assert.equal(record[key as "kind"], value, name);
      assert.equal(record.sha256, clip.sha256, name);
    }
    assert.equal(clipToSend(clip, null), true, "never sent");
    assert.equal(clipToSend(clip, { kind: "applied", at, sha256: clip.sha256 }), false, "Genex has these bytes");
    assert.equal(clipToSend(clip, { kind: "failed", at, sha256: clip.sha256 }), true, "it did not get there");
    assert.equal(clipToSend(clip, { kind: "applied", at, sha256: "d".repeat(64) }), true, "a newer clip");
    assert.equal(clipToSend(null, null), false, "nothing kept");
  });

  it("goes after the cover at publish, and a clip that cannot go changes nothing about the cover", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.genex.coverClip(PROJECT, { ...camera(() => still("x")), record: async () => recording("ride") });
      const done = await fx.publish(
        "gallery",
        camera(() => still("cover")),
      );
      assert.equal(done.job?.state, "done", done.job?.error);
      assert.equal(done.cover?.last?.kind, GenexCoverOutcome.Applied, "the cover went");
      assert.deepEqual(fx.seen.puts, [png("cover")], "only the cover reached the fixture's cover routes");
      assert.equal(done.cover?.clipLast?.sha256, sha256(webm("ride")), "the clip's send was recorded");
    } finally {
      await fx.close();
    }
  });

  it("stays home on genex__cover-set: the approved send carries only the picture", async (t) => {
    if (!hasGit) return t.skip("git is not installed on this machine; the Genex publish path requires it");
    const fx = await coverFixture();
    try {
      await fx.genex.coverClip(PROJECT, { ...camera(() => still("x")), record: async () => recording("ride") });
      await fx.publish(
        "gallery",
        camera(() => still("first")),
      );
      await fx.genex.coverClip(PROJECT, { ...camera(() => still("x")), record: async () => recording("later") });
      await fx.genex.coverShoot(
        PROJECT,
        camera(() => still("second")),
      );
      const sent = await fx.genex.coverSet(PROJECT);
      assert.equal(sent.kind, GenexCoverOutcome.Applied, "the picture went");
      const after = await fx.genex.publishWait(PROJECT);
      assert.equal(after.cover?.clip?.sha256, sha256(webm("later")), "the newer clip is kept");
      assert.equal(after.cover?.clipLast?.sha256, sha256(webm("ride")), "and no send of it was attempted");
    } finally {
      await fx.close();
    }
  });
});
