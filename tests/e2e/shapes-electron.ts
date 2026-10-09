import { fixtureCodingCli } from "../helpers/external-cli.ts";
/**
 * The proof of Milestone 4: five games nobody wrote the studio's contract for, opened as the
 * user's own games, driven, photographed and judged — then driven again through the real Codex
 * bridge and the real Claude MCP surface, with only the CLI and the model scripted.
 *
 * Everything below the two scripted seams is the studio itself: a real `StudioCore` with the
 * real `GamePreview`, the real serve layer, the real shadow build, the real evidence pass out of
 * the harness seed, the real file bridge and the real in-process MCP server. `ctx` is
 * `core.api()` with the substrate pipe removed, which is exactly what the harness host
 * dispatches against — so what passes here is what a run would get.
 *
 * No model of any kind is started: `StudioCore` is built with `engines: []` (an explicit empty
 * list skips the default registration), and only the two scripted engines are registered.
 */
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GamePreview, registerGameScheme } from "../../src/main/preview.ts";
import { awaitReady } from "../../src/substrate/preview-ready.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { detectProjectShape } from "../../src/substrate/game-workspace.ts";
import { CodexEngine } from "../../src/substrate/engines/codex.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { BRIDGE_DIR } from "../../src/substrate/engines/studio-bridge.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import { gatherEvidence } from "../../src/harness-seed/loop/gauntlet.ts";
import { GAME_KINDS, inputProbesFor, gameLine, normalizeGameTraits } from "../../src/harness-seed/loop/kinds.ts";
import { scriptedCodex, type ScriptedCodex } from "../helpers/scripted-codex.ts";
import { scriptedClaude, type ScriptedClaude } from "../helpers/scripted-claude.ts";
import { undeclaredWarnings } from "./warning-policy.ts";

const repo = process.env.STUDIO_SHAPES_REPO!;
const output = process.env.STUDIO_SHAPES_OUT!;
const only = (process.env.STUDIO_SHAPES_ONLY ?? "").split(",").filter(Boolean);
const transports = (process.env.STUDIO_SHAPES_ENGINES ?? "fixture,codex,claude").split(",").filter(Boolean);
const keep = process.env.STUDIO_SHAPES_KEEP === "1";

const VIEW = { width: 960, height: 600 };
/** Two frames of one picture, the threshold the optimization pixel critic already uses. */
const SAME_APPEARANCE = 0.01;
const fixturesDir = path.join(repo, "tests/fixtures/games");
const resources = path.join(repo, "dist/resources");

interface Manifest {
  version: number;
  id: string;
  title: string;
  shape: Record<string, unknown>;
  addsAtLeast: string[];
  neverAdded: string[];
  edits: "none" | "two-line-install";
  /** The word `validate` must answer: a page that assigns `window.__studio` itself is `loaded`. */
  contract: "loaded" | "attached";
  needsNodeModules: boolean;
  backend: "webgl" | "webgpu";
  game: Record<string, unknown>;
  setup: Record<string, unknown> | null;
  cameras: string[];
  /** Warnings this game must produce. Anything else it produces has to be in `allowWarnings`. */
  expectWarnings: string[];
  /** Warnings this game may produce and need not. */
  allowWarnings: string[];
  delta: Array<{ path: string; min: number }>;
  deterministic: boolean;
  readyBudgetMs: number;
}

const summary: {
  passed: boolean;
  fixture: string;
  entries: unknown[];
  extras: unknown[];
  unverified: string[];
  error?: string;
} = {
  passed: false,
  fixture:
    "five games with no studio contract; real core, preview, serve layer, build, bridge and MCP server; only the CLI and the model are scripted",
  entries: [],
  extras: [],
  unverified: [],
};

// ── small tools ────────────────────────────────────────────────────────────────────────────

/** Every file under `dir`, project-relative, with git's own bookkeeping left out. */
async function walkFiles(dir: string, rel = "", skip = new Set([".git", "node_modules"])): Promise<string[]> {
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const relative = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await walkFiles(dir, relative, skip)));
    else found.push(relative);
  }
  return found.sort();
}

async function hashTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rel of await walkFiles(dir)) {
    const body = await readFile(path.join(dir, rel)).catch(() => Buffer.alloc(0));
    out.set(rel, createHash("sha256").update(body).digest("hex"));
  }
  return out;
}

function treeDiff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [rel, hash] of after) if (before.get(rel) !== hash) changed.add(rel);
  for (const rel of before.keys()) if (!after.has(rel)) changed.add(rel);
  return [...changed].sort();
}

/** The shim's own telemetry, which is a fact about the window and never about the game. */
const SHIM_STATE_KEYS = new Set([
  "frame",
  "simulatedMs",
  "running",
  "fps",
  "pointerLock",
  "render",
  "__render",
  "__attached",
  "drawCalls",
  "triangles",
]);

function gameOwnState(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state as Record<string, unknown>))
    if (!SHIM_STATE_KEYS.has(key)) out[key] = value;
  return out;
}

/**
 * The same state twice — to the precision the path supports. Two runs of one simulation
 * accumulate their floats in the same order but not through the same GPU frame timings, so a
 * position agrees to a millionth and never to the last bit.
 */
function sameState(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameState(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.keys(a as Record<string, unknown>).sort();
    const right = Object.keys(b as Record<string, unknown>).sort();
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    return left.every((key) => sameState((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return a === b;
}

function at(state: unknown, dotted: string): unknown {
  let value: unknown = state;
  for (const part of dotted.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function pathExists(file: string): Promise<boolean> {
  return readdir(path.dirname(file))
    .then((names) => names.includes(path.basename(file)))
    .catch(() => false);
}

/** One check on one fixture: recorded either way, and the pass fails on the first false. */
class Sheet {
  readonly rows: Array<{ id: string; ok: boolean; note: string }> = [];
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
  ok(id: string, condition: unknown, note: string): void {
    const passed = Boolean(condition);
    this.rows.push({ id, ok: passed, note });
    assert.ok(passed, `${this.label} — ${id}: ${note}`);
  }
}

// ── the program ────────────────────────────────────────────────────────────────────────────

// Synchronous on purpose: the userData path has to exist before `app.setPath`.
const scratchRoot = mkdtempSync(path.join(os.tmpdir(), "studio-shapes-"));

app.setPath("userData", path.join(scratchRoot, "electron"));
registerGameScheme();
app.on("window-all-closed", () => {});

async function main(): Promise<void> {
  await app.whenReady();
  console.log(`Shapes E2E ready — ${scratchRoot}`);

  const gamesRoot = path.join(scratchRoot, "games");
  const copies = path.join(scratchRoot, "copies");
  await mkdir(gamesRoot, { recursive: true });
  await mkdir(copies, { recursive: true });

  let core!: StudioCore;
  const liveWindow = new BrowserWindow({
    width: VIEW.width,
    height: VIEW.height,
    show: false,
    focusable: false,
    skipTaskbar: true,
  });
  const windows: BrowserWindow[] = [liveWindow];
  const ports: GamePreview[] = [];
  const live: GamePreview = new GamePreview({
    gamesRoot,
    vendorDir: path.join(resources, "vendor"),
    partition: "shapes-live",
    offscreen: true,
    resolveRoot: (name: string): string => core.games.dirFor(name),
  });
  live.attachTo(liveWindow, { x: 0, y: 0, ...VIEW });
  ports.push(live);

  // The engines: real objects with a scripted transport. Their credential homes are inside the
  // scratch, so neither ever looks at a login this machine actually has.
  const codexHome = path.join(scratchRoot, "codex-home");
  const claudeHome = path.join(scratchRoot, "claude-home");
  await mkdir(codexHome, { recursive: true });
  await mkdir(claudeHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), "{}");
  await writeFile(path.join(claudeHome, ".credentials.json"), "{}");

  let codexPlan: ScriptedCodex | null = null;
  let claudePlan: ScriptedClaude | null = null;
  const codexEngine = new CodexEngine({
    engineHome: codexHome,
    systemHome: path.join(scratchRoot, "no-system-codex"),
    executable: "/fake/codex",
    authStatusFn: async () => ({ loggedIn: true, method: "chatgpt", detail: "Logged in using ChatGPT" }),
    execFn: (invocation) => codexPlan!.fn(invocation),
  });
  const claudeEngine = new ClaudeCodeEngine({
    resolveCli: fixtureCodingCli,
    engineHome: claudeHome,
    systemHome: path.join(scratchRoot, "no-system-claude"),
    queryFn: ((params: never) => (claudePlan!.queryFn as unknown as (p: never) => unknown)(params)) as never,
  });

  core = new StudioCore({
    engines: [codexEngine, claudeEngine],
    paths: { userData: path.join(scratchRoot, "electron"), resources },
    gamesRoot,
    preview: live,
    previewPoolMax: 4,
    createHeadlessPreview: async (): Promise<GamePreview> => {
      const win = new BrowserWindow({
        width: VIEW.width,
        height: VIEW.height,
        show: false,
        focusable: false,
        skipTaskbar: true,
        backgroundColor: "#05070d",
      });
      windows.push(win);
      const port: GamePreview = new GamePreview({
        gamesRoot,
        vendorDir: path.join(resources, "vendor"),
        partition: `shapes-headless-${ports.length}`,
        offscreen: true,
        // Without this every fixture request 404s: each one lives in a temp copy the preview can
        // only reach through the alias adoption recorded.
        resolveRoot: (name: string): string => core.games.dirFor(name),
      });
      port.attachTo(win, { x: 0, y: 0, ...VIEW });
      port.dispose = async () => {
        port.destroy();
        if (!win.isDestroyed()) win.destroy();
      };
      ports.push(port);
      return port;
    },
  });
  await core.init();
  await core.plugins.setEnabled("blender", false);
  const api: Record<string, (params: never) => Promise<unknown>> = core.api();
  // The harness host resolves any api() key by name and hands the loop exactly this; the
  // evidence pass below is given the same thing, minus the pipe.
  const ctx = { call: async (method: string, params: Record<string, unknown> = {}) => api[method]!(params as never) };

  const ids = (
    only.length ? only : ["inline-raf", "esm-addons", "bundled-ts", "menu-levels", "webgpu-field"]
  ) as string[];

  for (const id of ids) {
    const manifest = JSON.parse(await readFile(path.join(fixturesDir, id, "manifest.json"), "utf8")) as Manifest;
    const source = path.join(fixturesDir, id);
    const sourceBefore = await hashTree(source);

    // Adoption WRITES into the folder it opens, so the repository's own fixture is never the
    // folder that is adopted — and "it is byte-identical afterwards" is itself a check.
    const workdir = path.join(copies, id);
    await cp(source, workdir, { recursive: true });
    if (manifest.needsNodeModules) {
      const modules = path.join(repo, "node_modules");
      await symlink(modules, path.join(workdir, "node_modules"), "dir");
      const esbuild = await pathExists(path.join(modules, "esbuild", "package.json"));
      assert.ok(
        esbuild,
        `${id}: esbuild is not reachable through the repository's node_modules — this runner never installs packages`,
      );
    }

    const prepared = new Sheet(`${id}/prepare`);
    const detected = await detectProjectShape(workdir);
    prepared.ok(
      "shape",
      JSON.stringify(detected) === JSON.stringify(manifest.shape),
      `detectProjectShape ${JSON.stringify(detected)}`,
    );

    const planned = (await core.games.plannedWrites(workdir, { template: false })).slice().sort();
    const before = await hashTree(workdir);
    const project = await core.adoptProject(workdir, { template: false });
    const after = await hashTree(workdir);
    const written = treeDiff(before, after);
    if (await pathExists(path.join(workdir, ".git"))) written.push(".git");
    written.sort();
    // Creations AND edits alike: esm-addons ships its own studio.json, which #recordShape
    // legitimately merges into, so "changes no pre-existing file" is false as a rule.
    prepared.ok(
      "adoption-writes",
      JSON.stringify(written) === JSON.stringify(planned),
      `wrote ${written.join(" ")} / planned ${planned.join(" ")}`,
    );
    const studioJson = JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8")) as Record<
      string,
      unknown
    >;
    if (id === "esm-addons") {
      prepared.ok(
        "merge-survives",
        studioJson.title === "Orbit Yard" && (studioJson.game as { kind?: string })?.kind === "free-camera",
        `studio.json keeps ${JSON.stringify(studioJson)}`,
      );
    }
    for (const file of manifest.addsAtLeast)
      prepared.ok(`adds:${file}`, await pathExists(path.join(project.dir, file)), `${file} is there after adoption`);
    for (const file of manifest.neverAdded) {
      const existed = before.has(file) || file === "index.html";
      if (!existed)
        prepared.ok(
          `never:${file}`,
          !(await pathExists(path.join(project.dir, file))),
          `${file} was not written beside the real game`,
        );
    }
    const contract = await core.games.validateAt(project.dir);
    prepared.ok(
      "contract",
      contract.contract === manifest.contract,
      `validate says ${contract.contract} (${contract.problems.join("; ") || "no problems"})`,
    );
    prepared.ok(
      "no-contract-problem",
      contract.problems.length === 0,
      `validate problems: ${contract.problems.join("; ")}`,
    );

    const traits = normalizeGameTraits(manifest.game);
    const probes = inputProbesFor(traits);
    const line = gameLine(traits);

    // ── the fixture pass: load, drive, photograph, judge ──
    if (transports.includes("fixture")) {
      const sheet = new Sheet(`${id}/fixture`);
      for (const row of prepared.rows) sheet.rows.push(row);
      const runId = `shapes_${id}`;
      const { handle } = (await api["preview.acquire"]!({ label: `shapes:${id}` } as never)) as { handle: string };
      const evidence = await gatherEvidence(
        ctx as never,
        {
          run: { runId, project: project.name, setup: manifest.setup, game: manifest.game, ownShape: true },
          iterationId: "shapes",
          seed: 7,
          handle,
          // Load-bearing: without a root, gatherEvidence takes the reload branch, and a port just
          // returned by preview.acquire has nothing in #servedRoots — nothing is served, no shadow
          // build runs and no page is ever navigated.
          root: project.dir,
          labelPrefix: `${id}/first`,
          entry: undefined,
          motion: 2,
          userView: true,
          cameras: null,
        } as never,
      );
      const status = (await api["preview.status"]!({ handle } as never)) as { url?: string };

      sheet.ok(
        "ready",
        typeof evidence.readyAfterMs === "number" &&
          evidence.readyAfterMs <= manifest.readyBudgetMs &&
          evidence.ready?.timedOut === false &&
          evidence.ready?.via === "shim",
        `readyAfterMs ${evidence.readyAfterMs} (budget ${manifest.readyBudgetMs}), via ${evidence.ready?.via}, timedOut ${evidence.ready?.timedOut}`,
      );
      sheet.ok(
        "clock",
        evidence.clock?.ok === true && evidence.clock.frames > 0 && evidence.clock.drawCalls > 0,
        `two proving steps moved ${evidence.clock?.frames} stepped frames and ${evidence.clock?.drawCalls} draws in ${evidence.clock?.ms} ms`,
      );

      const measured = manifest.delta.map((entry) => {
        const moved = Math.abs(
          Number(at(evidence.state, entry.path) ?? NaN) - Number(at(evidence.stateEarly, entry.path) ?? NaN),
        );
        return { ...entry, moved };
      });
      for (const entry of measured)
        sheet.ok(
          `delta:${entry.path}`,
          entry.moved >= entry.min,
          `${entry.path} moved ${entry.moved} (min ${entry.min})`,
        );

      const judged = (evidence.shots ?? []).find((shot: { camera: string }) => shot.camera === "default");
      sheet.ok(
        "lit",
        judged?.stats?.canvas === true && judged.stats.litFraction > 0.005,
        `default frame litFraction ${judged?.stats?.litFraction}`,
      );
      sheet.ok(
        "not-black",
        !(evidence.problems ?? []).some((problem: string) => /renders effectively black|drew nothing/.test(problem)),
        `problems: ${(evidence.problems ?? []).join("; ")}`,
      );

      const declared = (await api["preview.call"]!({ method: "cameras", handle } as never)) as unknown;
      sheet.ok(
        "cameras",
        JSON.stringify(declared) === JSON.stringify(manifest.cameras),
        `cameras() answered ${JSON.stringify(declared)}`,
      );
      const wanted = ["default", ...manifest.cameras.filter((name) => name !== "default")].slice(0, 6);
      const photographed = (evidence.shots ?? [])
        .filter(
          (shot: { camera: string }) =>
            !shot.camera.startsWith("demo:") && shot.camera !== "user:view" && !shot.camera.startsWith("eye:"),
        )
        .map((shot: { camera: string }) => shot.camera);
      sheet.ok(
        "photographed",
        JSON.stringify(photographed) === JSON.stringify(wanted),
        `photographed ${photographed.join(", ")}, wanted ${wanted.join(", ")}`,
      );
      for (const eye of evidence.eyes ?? []) {
        if (!["eye:spawn", "eye:here", "eye:down"].includes(eye)) continue;
        sheet.ok(
          `eye:${eye}`,
          (evidence.shots ?? []).some((shot: { camera: string }) => shot.camera === eye),
          `${eye} was photographed`,
        );
      }
      // Photographed is not the promise. A harness camera placed on a game that renders its own
      // frame used to be clobbered by that render, and every `eye:*` picture came back as the
      // game's own view — byte-identical to `default`, and named after a viewpoint nobody saw.
      // At least one placed eye must therefore differ from the default frame.
      const eyeShots = (evidence.shots ?? []).filter((shot: { camera: string }) => shot.camera.startsWith("eye:")) as {
        camera: string;
        base64?: string;
      }[];
      if (eyeShots.length > 0) {
        const defaultFrame = judged?.base64 ?? null;
        const distinct = eyeShots.filter((shot) => typeof shot.base64 === "string" && shot.base64 !== defaultFrame);
        sheet.ok(
          "eye-placed",
          distinct.length > 0,
          `${distinct.length} of ${eyeShots.length} eye frame(s) differ from the default frame (${eyeShots.map((shot) => shot.camera).join(", ")})`,
        );
      }

      sheet.ok("evidence-ok", evidence.ok === true, `problems: ${(evidence.problems ?? []).join("; ") || "none"}`);
      sheet.ok(
        "no-console-errors",
        (evidence.consoleErrors ?? []).length === 0,
        `console: ${(evidence.consoleErrors ?? []).join(" | ")}`,
      );
      sheet.ok(
        "no-gpu-errors",
        (evidence.gpuErrors ?? []).length === 0,
        `gpu: ${JSON.stringify(evidence.gpuErrors ?? [])}`,
      );

      // The GAME line: a kind with no measurable player carries the retraction; a kind with one
      // names probes that either moved or the game never reports at all.
      // A kind that names no axis is retracted by name, not by the template fallback the probe
      // table hands back for it.
      const declaredKind = (GAME_KINDS as Record<string, { look: string[]; move: string[] } | undefined>)[
        String(traits.kind)
      ];
      if ((declaredKind?.look.length ?? 0) === 0 && (declaredKind?.move.length ?? 0) === 0) {
        sheet.ok("game-line", line.includes("[dead-input] does not apply"), `GAME line: ${line}`);
      } else {
        sheet.ok("game-line", line.includes("__studio.state()"), `GAME line: ${line}`);
        for (const [name, probe] of [
          ["look", probes.look],
          ["move", probes.move],
        ] as const) {
          if (name === "look" && traits.mouseLook !== true) continue;
          if (name === "move" && traits.keyboardMove !== true) continue;
          const unmeasurable = probe.paths.every((dotted: string) => at(evidence.state, dotted) === undefined);
          const moved = probe.paths.some((dotted: string) =>
            measured.some((entry) => entry.path === dotted && entry.moved >= entry.min),
          );
          sheet.ok(
            `probe:${name}`,
            unmeasurable || moved,
            `${probe.paths.join(", ")} — ${unmeasurable ? "the game reports none of them" : `moved: ${moved}`}`,
          );
        }
      }

      const warnings = (evidence.warnings ?? []) as string[];
      for (const expected of manifest.expectWarnings)
        sheet.ok(
          `warn:${expected.slice(0, 32)}`,
          warnings.some((warning) => warning.includes(expected)),
          `warnings: ${warnings.join(" | ")}`,
        );
      // The other half of the promise: a manifest that names no warning is claiming this game
      // warns about nothing, so anything the run collected and no list names fails the sheet.
      const undeclared = undeclaredWarnings(warnings, manifest);
      sheet.ok("no-undeclared-warning", undeclared.length === 0, `undeclared: ${undeclared.join(" | ") || "none"}`);
      sheet.ok(
        "no-contract-warning",
        ![...warnings, ...(evidence.problems ?? [])].some((sentence: string) =>
          /contract|cannot be judged/.test(sentence),
        ),
        `nothing said the contract is missing: ${[...warnings, ...(evidence.problems ?? [])].join(" | ")}`,
      );

      sheet.ok(
        "backend",
        evidence.canvas?.kind === (manifest.backend === "webgpu" ? "webgpu" : "webgl2") ||
          evidence.canvas?.kind === manifest.backend,
        `the photographed canvas hands out ${evidence.canvas?.kind}`,
      );

      if (manifest.edits === "two-line-install") {
        // The bundled shape: what the browser was actually given is the BUILT page, not the
        // TypeScript entry it refuses. (The served URL is the port's, and the studio serves a
        // build out of its own shadow — so the proof is the page, not the path.)
        const entryScript = (await api["preview.evaluate"]!({
          handle,
          // The game's own module tags, not the two the serve layer inserted.
          expression: `[...document.querySelectorAll('script[type=module][src]')].map((s) => s.getAttribute('src')).filter((src) => !src.startsWith('/vendor/'))`,
        } as never)) as string[];
        sheet.ok(
          "built-entry",
          entryScript.length === 1 &&
            /main\.js$/.test(entryScript[0]!) &&
            !entryScript.some((src) => /\.tsx?$/.test(src)),
          `the served page loads ${entryScript.join(", ")}`,
        );
        sheet.ok(
          "built-url",
          typeof status.url === "string" && /\/index\.html$/.test(status.url),
          `the port is showing ${status.url}`,
        );
      }

      // Determinism: the same seed twice gives the same state and the same default frame.
      let repeat: Record<string, unknown> | null = null;
      if (manifest.deterministic) {
        repeat = (await gatherEvidence(
          ctx as never,
          {
            run: { runId, project: project.name, setup: manifest.setup, game: manifest.game, ownShape: true },
            iterationId: "shapes",
            seed: 7,
            handle,
            root: project.dir,
            labelPrefix: `${id}/second`,
            entry: undefined,
            // The same pass twice, motion strip and user:view included: a second pass that looked
            // at the page differently would be measuring the difference between two passes.
            motion: 2,
            userView: true,
            cameras: null,
          } as never,
        )) as Record<string, unknown>;
        const a = judged?.path;
        const b = ((repeat.shots as Array<{ camera: string; path: string }>) ?? []).find(
          (shot) => shot.camera === "default",
        )?.path;
        const diff =
          a && b
            ? ((await api["preview.diff"]!({ runId, a, b, label: `${id}/determinism`, handle } as never)) as {
                diffFraction?: number;
              } | null)
            : null;
        // The GAME's own state, not the shim's telemetry: `frame`, `fps` and the draw counters
        // are facts about the window, and two loads of the same page never share them.
        const own = gameOwnState(evidence.state);
        const again = gameOwnState(repeat.state);
        if (Object.keys(own).length === 0) {
          sheet.rows.push({
            id: "deterministic-state",
            ok: true,
            note: "this page reports no state of its own — the frame below is the whole claim",
          });
        } else {
          sheet.ok(
            "deterministic-state",
            sameState(own, again),
            `first ${JSON.stringify(own)} / second ${JSON.stringify(again)}`,
          );
        }
        // "The same appearance" — the number the optimization pixel critic already calls a
        // visible change. A literal 0 is not a claim this path supports: a game walked to its
        // state by a setup script is walked in WALL time, before the studio owns the clock, and
        // a WebGPU frame lands one asynchronous turn after the callback that asked for it, so
        // two passes agree on the picture and never on every pixel of it.
        sheet.ok(
          "deterministic-frame",
          diff !== null && (diff.diffFraction ?? 1) < SAME_APPEARANCE,
          `default frame diffFraction ${diff?.diffFraction} (bar ${SAME_APPEARANCE})`,
        );
      }

      // The two extra assertions this runner carries for the lanes that own those paths.
      if (id === "esm-addons") {
        const info = (await api["preview.call"]!({ method: "captureInfo", handle } as never)) as {
          source?: string;
          composited?: boolean;
        } | null;
        const hues = (judged?.stats?.hueHistogram ?? []) as number[];
        const dominant = hues.length ? hues.indexOf(Math.max(...hues)) : -1;
        // Bins are 30° each, red first: the lamps and their bloom are cyan/blue (bin 6 or 7).
        sheet.ok(
          "composer-frame",
          info?.source === "page" && (dominant === 6 || dominant === 7),
          `capture ${info?.source}, dominant hue bin ${dominant} of ${JSON.stringify(hues)}`,
        );
        // …and the frame really is the END of the frame. With the clock held, the compositor is
        // asked twice: once for the picture as the page left it (the composer's last pass), and
        // once after a plain `renderer.render(scene, camera)` — the frame a capture that
        // re-rendered would have taken. The bloom is the difference, and the judged frame's own
        // brightness has to sit on the composed side of it.
        await api["preview.call"]!({ method: "pause", handle } as never);
        const composed = (await api["preview.screenshot"]!({
          runId,
          label: `${id}/composed`,
          surface: "page",
          handle,
        } as never)) as { stats: { meanLuma: number } };
        await api["preview.evaluate"]!({
          handle,
          expression: `(() => { const i = window.__studio.inspect(); i.renderer.render(i.scene, i.camera); return true; })()`,
        } as never);
        const plain = (await api["preview.screenshot"]!({
          runId,
          label: `${id}/plain`,
          surface: "page",
          handle,
        } as never)) as { stats: { meanLuma: number } };
        await api["preview.call"]!({ method: "start", handle } as never);
        const lift = composed.stats.meanLuma - plain.stats.meanLuma;
        sheet.ok(
          "post-pass-visible",
          lift > 1,
          `the composed frame is ${composed.stats.meanLuma.toFixed(2)} against ${plain.stats.meanLuma.toFixed(2)} for a plain re-render`,
        );
        const judgedLuma = judged?.stats?.meanLuma ?? 0;
        sheet.ok(
          "capture-reads-the-end",
          Math.abs(judgedLuma - composed.stats.meanLuma) < Math.abs(judgedLuma - plain.stats.meanLuma),
          `the judged frame reads ${judgedLuma.toFixed(2)}: composed ${composed.stats.meanLuma.toFixed(2)}, plain ${plain.stats.meanLuma.toFixed(2)}`,
        );
      }
      if (manifest.backend === "webgpu") {
        sheet.ok(
          "webgpu-draws",
          Number.isFinite(evidence.canvas?.drawCalls) &&
            (evidence.canvas?.drawCalls ?? 0) > 0 &&
            evidence.canvas?.kind === "webgpu",
          `${evidence.canvas?.drawCalls} draw calls off a ${evidence.canvas?.kind} canvas`,
        );
      }

      await api["preview.release"]!({ handle } as never);
      summary.entries.push({
        id,
        transport: "fixture",
        shape: detected,
        cameras: declared,
        readyAfterMs: evidence.readyAfterMs,
        delta: measured,
        surface: evidence.surface,
        pageUi: evidence.pageUi,
        warnings: (evidence.warnings ?? []).length,
        checks: sheet.rows,
      });
      console.log(`${id}/fixture: ready in ${evidence.readyAfterMs} ms, ${sheet.rows.length} checks`);
    }

    // ── the same game through the real Codex bridge ──
    if (transports.includes("codex")) {
      const sheet = new Sheet(`${id}/codex`);
      const plan = scriptedCodex([
        { tool: "capture" },
        { tool: COMPUTER_TOOL_NAME, args: { action: "state" } },
        ...driveSteps(manifest, "codex"),
        { tool: COMPUTER_TOOL_NAME, args: { action: "state" } },
      ]);
      codexPlan = plan;
      const treeBefore = await hashTree(project.dir);
      const result = (await api["engine.delegate"]!({
        engine: "codex",
        project: project.name,
        prompt: "Look at this build.",
        selfCapture: {
          project: project.name,
          root: project.dir,
          runId: `shapes_${id}_codex`,
          facetId: "shapes",
          setup: manifest.setup,
        },
      } as never)) as { ok: boolean; summary: string };
      const treeAfter = await hashTree(project.dir);

      sheet.ok("delegated", result.ok === true, `codex delegation returned ${result.summary}`);
      sheet.ok(
        "bridge-tools",
        plan.tools.includes("capture") && plan.tools.includes(COMPUTER_TOOL_NAME) && plan.tools.includes("checkpoint"),
        `the bridge declared ${plan.tools.join(", ")}`,
      );
      const capture = plan.seen.find((call) => call.command.includes(" capture"));
      sheet.ok(
        "capture-answered",
        capture?.code === 0 && /Captured your CURRENT build/.test(capture.stdout),
        `capture printed: ${capture?.stdout.slice(0, 160)}`,
      );
      sheet.ok(
        "capture-command",
        capture?.command.startsWith(`node ${BRIDGE_DIR}/tool.mjs capture`),
        `the shim ran ${capture?.command}`,
      );
      const states = plan.seen.filter((call) => call.command.includes("--action=state"));
      sheet.ok(
        "state-answered",
        states.length === 2 && states.every((call) => call.code === 0 && call.stdout.startsWith("state: ")),
        `state calls: ${states.map((call) => call.code).join(",")}`,
      );
      const delta = deltaBetween(states[0]?.stdout ?? "", states[1]?.stdout ?? "", manifest);
      for (const entry of delta)
        sheet.ok(
          `delta:${entry.path}`,
          entry.moved >= entry.min,
          `${entry.path} moved ${entry.moved} through the bridge (min ${entry.min})`,
        );

      sheet.ok(
        "bridge-gone",
        !(await pathExists(path.join(project.dir, BRIDGE_DIR))),
        "the bridge directory is gone after the delegation",
      );
      const touched = treeDiff(treeBefore, treeAfter).filter((rel) => !rel.startsWith(".studio/"));
      sheet.ok(
        "build-untouched",
        touched.length === 0,
        `paths that differ outside .studio/: ${touched.join(", ") || "none"}`,
      );

      summary.entries.push({
        id,
        transport: "codex",
        tools: plan.tools,
        calls: plan.seen.map((call) => ({ command: call.command, code: call.code })),
        delta,
        checks: sheet.rows,
      });
      console.log(`${id}/codex: ${plan.seen.length} shim calls, ${sheet.rows.length} checks`);
      codexPlan = null;
    }

    // ── and through the real Claude MCP surface ──
    if (transports.includes("claude")) {
      const sheet = new Sheet(`${id}/claude`);
      const plan = scriptedClaude([
        { tool: "capture" },
        { tool: COMPUTER_TOOL_NAME, args: { action: "state" } },
        ...driveSteps(manifest, "claude"),
        { tool: COMPUTER_TOOL_NAME, args: { action: "state" } },
        { tool: COMPUTER_TOOL_NAME, args: { action: "screenshot" } },
      ]);
      claudePlan = plan;
      const result = (await api["engine.delegate"]!({
        engine: "claude-code",
        project: project.name,
        prompt: "Look at this build.",
        selfCapture: {
          project: project.name,
          root: project.dir,
          runId: `shapes_${id}_claude`,
          facetId: "shapes",
          setup: manifest.setup,
        },
      } as never)) as { ok: boolean; summary: string };

      sheet.ok("delegated", result.ok === true, `claude delegation returned ${result.summary}`);
      const allowed = ((plan.options?.allowedTools ?? []) as string[]).slice();
      sheet.ok(
        "mcp-tools",
        plan.tools.includes("capture") && plan.tools.includes(COMPUTER_TOOL_NAME) && plan.tools.includes("checkpoint"),
        `the studio's own MCP server registered ${plan.tools.join(", ")}`,
      );
      const capture = plan.calls.find((call) => call.tool === "capture");
      sheet.ok(
        "capture-answered",
        /Captured your CURRENT build/.test(capture?.text ?? ""),
        `capture answered: ${(capture?.text ?? "").slice(0, 160)}`,
      );
      const states = plan.calls.filter((call) => call.args.action === "state");
      sheet.ok(
        "state-answered",
        states.length === 2 && states.every((call) => call.text.startsWith("state: ")),
        `state calls: ${states.length}`,
      );
      const delta = deltaBetween(states[0]?.text ?? "", states[1]?.text ?? "", manifest);
      for (const entry of delta)
        sheet.ok(
          `delta:${entry.path}`,
          entry.moved >= entry.min,
          `${entry.path} moved ${entry.moved} through the MCP server (min ${entry.min})`,
        );
      const shot = plan.calls.find((call) => call.args.action === "screenshot");
      sheet.ok("screenshot-image", (shot?.images ?? 0) === 1, `the screenshot came back with ${shot?.images} image(s)`);

      // C1, as a comparison of two OBSERVED surfaces: the same studio tools reach both engines,
      // and the shell is Claude's alone.
      const codexEntry = summary.entries.find(
        (entry) =>
          (entry as { id: string; transport: string }).id === id &&
          (entry as { transport: string }).transport === "codex",
      ) as { tools?: string[] } | undefined;
      const claudeStudio = allowed
        .filter((name) => name.startsWith("mcp__studio__"))
        .map((name) => name.slice("mcp__studio__".length))
        .sort();
      if (codexEntry?.tools) {
        sheet.ok(
          "one-tool-list",
          JSON.stringify(claudeStudio) === JSON.stringify([...codexEntry.tools].sort()),
          `claude ${claudeStudio.join(", ")} vs codex ${[...codexEntry.tools].sort().join(", ")}`,
        );
      }
      sheet.ok(
        "bash-is-claude-only",
        allowed.includes("Bash") && !(codexEntry?.tools ?? []).includes("Bash"),
        `claude's allowlist is ${allowed.join(", ")}; the bridge declares ${(codexEntry?.tools ?? []).join(", ")}`,
      );
      sheet.ok(
        "no-bridge-syntax",
        !String(plan.prompt).includes(".studio/bridge/tool.mjs"),
        "no Claude session is shown a bridge command",
      );

      summary.entries.push({
        id,
        transport: "claude",
        tools: plan.tools,
        allowedTools: allowed,
        delta,
        checks: sheet.rows,
      });
      console.log(`${id}/claude: ${plan.calls.length} tool calls, ${sheet.rows.length} checks`);
      claudePlan = null;
    }

    const sourceAfter = await hashTree(source);
    assert.deepEqual(
      treeDiff(sourceBefore, sourceAfter),
      [],
      `${id}: the repository fixture must be byte-identical afterwards`,
    );
  }

  // ── two assertions this runner carries for the capture lane, on pages of its own ──
  // They are not fixtures (tests/fixtures/games holds exactly five games and its page of rules)
  // and they are not games: each is the smallest page that can tell the truth about one rule.
  if (!only.length) {
    const alphaDir = path.join(copies, "alpha-canvas");
    await mkdir(alphaDir, { recursive: true });
    await writeFile(path.join(alphaDir, "index.html"), ALPHA_PAGE);
    const alpha = await core.adoptProject(alphaDir, { template: false });
    const sheet = new Sheet("extras/alpha-canvas");
    const { handle } = (await api["preview.acquire"]!({ label: "shapes:alpha" } as never)) as { handle: string };
    await api["preview.load"]!({ project: alpha.name, root: alpha.dir, handle } as never);
    await api["preview.ready"]!({ handle } as never);
    const shot = (await api["preview.screenshot"]!({ label: "extras/alpha", surface: "canvas", handle } as never)) as {
      stats: Record<string, unknown>;
    };
    const stats = shot.stats as { composited?: boolean; source?: string; meanLuma: number; hueHistogram?: number[] };
    const hues = stats.hueHistogram ?? [];
    const dominant = hues.length ? hues.indexOf(Math.max(...hues)) : -1;
    // A canvas made with `alpha: true` hands back transparent pixels wherever nothing was
    // drawn. Un-composited they encode as black; over the page's own green they read green.
    sheet.ok(
      "composited",
      stats.composited === true && stats.source === "page",
      `capture ${stats.source}, composited ${stats.composited}`,
    );
    sheet.ok(
      "reads-green",
      dominant === 3 || dominant === 4,
      `dominant hue bin ${dominant} of ${JSON.stringify(hues)}`,
    );
    sheet.ok("not-black", stats.meanLuma > 20, `meanLuma ${stats.meanLuma}`);
    await api["preview.release"]!({ handle } as never);
    summary.extras.push({ id: "alpha-canvas", checks: sheet.rows });
    console.log(`extras/alpha-canvas: ${sheet.rows.length} checks`);

    const portraitDir = path.join(copies, "portrait-hud");
    await mkdir(portraitDir, { recursive: true });
    await writeFile(path.join(portraitDir, "index.html"), PORTRAIT_PAGE);
    const portrait = await core.adoptProject(portraitDir, { template: false });
    const portraitSheet = new Sheet("extras/portrait-hud");
    // This is a pixel-sized capture surface, independent of the current monitor/work area.
    // macOS otherwise clamps the outer window (960 requested became 868 content pixels).
    const portraitWindow = new BrowserWindow({
      width: PORTRAIT.width,
      height: PORTRAIT.height,
      frame: false,
      useContentSize: true,
      enableLargerThanScreen: true,
      show: false,
      focusable: false,
      skipTaskbar: true,
    });
    windows.push(portraitWindow);
    const portraitPort: GamePreview = new GamePreview({
      gamesRoot,
      vendorDir: path.join(resources, "vendor"),
      partition: "shapes-portrait",
      offscreen: true,
      resolveRoot: (name: string): string => core.games.dirFor(name),
    });
    portraitPort.attachTo(portraitWindow, { x: 0, y: 0, ...PORTRAIT });
    ports.push(portraitPort);
    await portraitPort.load(portrait.name, "index.html", portrait.dir);
    await awaitReady(portraitPort, { timeoutMs: 15_000 });
    // `captureInfo()` reports what the LAST capture did, so the picture is taken first.
    const portraitShot = await portraitPort.screenshotWithStats(80, { surface: "canvas" });
    const info = (await portraitPort.studioCall("captureInfo")) as {
      picked?: { width: number; height: number; kind: string; why?: string } | null;
      canvases?: unknown[];
    };
    // Two WebGL canvases on one portrait page: the world fills it, the minimap sits in a
    // corner. The eye must take the one the renderer draws on, not the first in the document.
    portraitSheet.ok(
      "two-canvases",
      (info.canvases ?? []).length === 2,
      `the page holds ${(info.canvases ?? []).length} canvas(es)`,
    );
    portraitSheet.ok(
      "picks-the-world",
      info.picked?.width === PORTRAIT.width && info.picked?.height === PORTRAIT.height,
      `picked ${info.picked?.width}x${info.picked?.height} (${info.picked?.why ?? "no reason given"})`,
    );
    portraitSheet.ok(
      "portrait-frame",
      portraitShot.stats.width === PORTRAIT.width &&
        portraitShot.stats.height === PORTRAIT.height &&
        portraitShot.stats.litFraction > 0.005,
      `the frame is ${portraitShot.stats.width}x${portraitShot.stats.height}, litFraction ${portraitShot.stats.litFraction}`,
    );
    summary.extras.push({ id: "portrait-hud", checks: portraitSheet.rows });
    console.log(`extras/portrait-hud: ${portraitSheet.rows.length} checks`);
  }

  await writeFile(path.join(output, "summary.json"), JSON.stringify({ ...summary, passed: true }, null, 2));
  console.log(`Shapes E2E: ${summary.entries.length} entries`);
  if (keep) console.log(`kept: ${scratchRoot}`);
  else await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
  for (const port of ports) port.destroy();
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}

/** A portrait window, and a second canvas in the corner of it. */
const PORTRAIT = { width: 540, height: 960 };

const IMPORT_MAP = `<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/":"/vendor/three/"}}</script>`;

/** A canvas made with `alpha: true` over a page that has a colour of its own. */
const ALPHA_PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>Alpha</title>
<style>html,body{margin:0;height:100%;background:#0a7d32;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
${IMPORT_MAP}
<script type="module">
import * as THREE from "three";
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
renderer.setPixelRatio(1);
renderer.setClearAlpha(0);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 5);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
scene.add(box);
function frame() { box.rotation.y += 0.01; renderer.render(scene, camera); requestAnimationFrame(frame); }
requestAnimationFrame(frame);
</script>
`;

/** Two WebGL canvases: the world, and a minimap in the corner. */
const PORTRAIT_PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>Portrait</title>
<style>html,body{margin:0;height:100%;background:#05070d;overflow:hidden}
#minimap{position:fixed;right:8px;top:8px;width:96px;height:96px;z-index:2}
#world{position:fixed;inset:0;width:100%;height:100%;z-index:1}</style>
${IMPORT_MAP}
<canvas id="minimap" width="96" height="96"></canvas>
<script type="module">
import * as THREE from "three";
const world = document.createElement("canvas");
world.id = "world";
document.body.appendChild(world);
const renderer = new THREE.WebGLRenderer({ canvas: world, antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x16324a);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 6);
const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xe8f0ff }));
scene.add(box);
const minimap = new THREE.WebGLRenderer({ canvas: document.getElementById("minimap"), antialias: false });
minimap.setPixelRatio(1);
minimap.setSize(96, 96, false);
const mapScene = new THREE.Scene();
mapScene.background = new THREE.Color(0x502010);
const mapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
mapCamera.position.z = 2;
mapScene.add(new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ color: 0xffcc44 })));
function frame() {
  box.rotation.y += 0.01;
  renderer.render(scene, camera);
  minimap.render(mapScene, mapCamera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>
`;

/** The computer actions that move this fixture's declared axes, if it declares any. */
function driveSteps(
  manifest: Manifest,
  transport: "codex" | "claude",
): Array<{ tool: string; args: Record<string, string> }> {
  const traits = normalizeGameTraits(manifest.game);
  const steps: Array<{ tool: string; args: Record<string, string> }> = [];
  const declares = (dotted: string) => manifest.delta.some((entry) => entry.path === dotted);
  if (traits.mouseLook === true && declares("player.yaw")) {
    steps.push({ tool: COMPUTER_TOOL_NAME, args: { action: "mouse_move", coordinate: "660,300" } });
  }
  if (traits.keyboardMove === true && (declares("player.z") || declares("player.x"))) {
    steps.push({ tool: COMPUTER_TOOL_NAME, args: { action: "hold_key", text: "w", duration: "1" } });
    if (declares("player.x"))
      steps.push({ tool: COMPUTER_TOOL_NAME, args: { action: "hold_key", text: "a", duration: "1" } });
  }
  void transport;
  return steps;
}

/** The two `state:` lines the computer tool printed, read back as the delta the manifest names. */
function deltaBetween(
  before: string,
  after: string,
  manifest: Manifest,
): Array<{ path: string; min: number; moved: number }> {
  const parse = (line: string): unknown => {
    const body = line.replace(/^state:\s*/, "");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  return manifest.delta.map((entry) => ({
    ...entry,
    moved: Math.abs(Number(at(b, entry.path) ?? NaN) - Number(at(a, entry.path) ?? NaN)),
  }));
}

main().catch(async (error) => {
  await mkdir(output, { recursive: true }).catch(() => {});
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify({ ...summary, passed: false, error: String((error as Error)?.stack ?? error) }, null, 2),
  ).catch(() => {});
  console.error(error);
  if (keep) console.log(`kept: ${scratchRoot}`);
  app.exit(1);
});
