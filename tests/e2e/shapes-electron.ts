import { fixtureCodingCli } from "../helpers/external-cli.ts";
/**
 * The proof of Milestone 4: five games nobody wrote the studio's contract for, opened as the
 * user's own games, health-checked and photographed — then driven through the real Codex
 * bridge and the real Claude MCP surface, with only the CLI and the model scripted.
 *
 * Everything below the two scripted seams is the studio itself: a real `StudioCore` with the
 * real `GamePreview`, the real serve layer, the real shadow build, the Loop's health check out of
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
import { checkHealth } from "../../src/harness-seed/loop/health-check.ts";
import { scriptedCodex, type ScriptedCodex } from "../helpers/scripted-codex.ts";
import { scriptedClaude, type ScriptedClaude } from "../helpers/scripted-claude.ts";

const repo = process.env.STUDIO_SHAPES_REPO!;
const output = process.env.STUDIO_SHAPES_OUT!;
const only = (process.env.STUDIO_SHAPES_ONLY ?? "").split(",").filter(Boolean);
const transports = (process.env.STUDIO_SHAPES_ENGINES ?? "fixture,codex,claude").split(",").filter(Boolean);
const keep = process.env.STUDIO_SHAPES_KEEP === "1";

const VIEW = { width: 960, height: 600 };
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
  // health check below is given the same thing, minus the pipe.
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

    // ── the fixture pass: the Loop's health check, then the served page looked at from outside ──
    if (transports.includes("fixture")) {
      const sheet = new Sheet(`${id}/fixture`);
      for (const row of prepared.rows) sheet.rows.push(row);
      const runId = `shapes_${id}`;
      // The check a Loop runs before it merges or lands: the page loads, logs no error, is not blank.
      const health = await checkHealth(ctx as never, {
        project: project.name,
        root: project.dir,
        runId,
        label: `${id}/health`,
      });
      sheet.ok("health-checked", health.unchecked === null, `unchecked: ${health.unchecked ?? "no"}`);
      sheet.ok("health-picture", typeof health.picture === "string", `picture: ${health.picture}`);
      sheet.ok("health-ok", health.ok, `problems: ${health.problems.join("; ") || "none"}`);

      const { handle } = (await api["preview.acquire"]!({ label: `shapes:${id}` } as never)) as { handle: string };
      await api["preview.load"]!({ project: project.name, root: project.dir, handle } as never);
      const ready = (await api["preview.ready"]!({ handle, timeoutMs: manifest.readyBudgetMs } as never)) as {
        ready?: boolean;
        pageMs?: number | null;
        timedOut?: boolean;
        via?: string;
      };
      sheet.ok(
        "ready",
        ready.ready === true && ready.timedOut === false && ready.via === "shim",
        `ready ${ready.ready} after ${ready.pageMs} ms (budget ${manifest.readyBudgetMs}), via ${ready.via}, timedOut ${ready.timedOut}`,
      );
      const judged = (await api["preview.screenshot"]!({
        runId,
        label: `${id}/default`,
        surface: "page",
        handle,
      } as never)) as { stats?: { litFraction?: number; meanLuma?: number; hueHistogram?: number[] } };
      sheet.ok(
        "lit",
        (judged.stats?.litFraction ?? 0) > 0.005,
        `default frame litFraction ${judged.stats?.litFraction}`,
      );

      // The one extra assertion this runner carries for the lane that owns that path.
      if (id === "esm-addons") {
        const hues = judged.stats?.hueHistogram ?? [];
        const dominant = hues.length ? hues.indexOf(Math.max(...hues)) : -1;
        // Bins are 30° each, red first: the lamps and their bloom are cyan/blue (bin 6 or 7). The
        // page's own picture (the compositor's), so the composer's last pass is in it.
        sheet.ok(
          "composer-frame",
          dominant === 6 || dominant === 7,
          `page capture, dominant hue bin ${dominant} of ${JSON.stringify(hues)}`,
        );
      }

      await api["preview.release"]!({ handle } as never);
      summary.entries.push({
        id,
        transport: "fixture",
        shape: detected,
        readyAfterMs: ready.pageMs,
        health: health.problems,
        checks: sheet.rows,
      });
      console.log(`${id}/fixture: ready in ${ready.pageMs} ms, ${sheet.rows.length} checks`);
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
  const traits = { mouseLook: manifest.game.mouseLook === true, keyboardMove: manifest.game.keyboardMove === true };
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
