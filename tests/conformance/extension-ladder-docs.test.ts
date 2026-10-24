/**
 * The extension ladder as integrated (M7.3): the guidance agents read names only refusal codes the
 * contract vocabularies hold, and every extension refusal an agent can meet; a harness workspace
 * kept without the ladder skill still serves Rust nights; an ejected game without a green
 * conformance run on its build is refused at prepare (Live's and an agent's run) and at export,
 * while the suite's own runs and a game on the store's engine pass; the person's engine rows read
 * the game's engine and trust flag; and the escapes report counts what an owned profile recorded.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { summarizeEscapes } from "../../scripts/extension-escapes.ts";
import { checkConformanceGate, exportConformanceGate } from "../../src/main/core/game-conformance-gate.ts";
import { type ExportRunners, runExport } from "../../src/main/core/native-export-run.ts";
import { type NativePrepareDeps, prepareNativeRun } from "../../src/main/core/native-prepare.ts";
import type { NativePrepareRequest } from "../../src/main/core/native-runs.ts";
import { engineStateOf } from "../../src/main/engine-state.ts";
import { type BuildOutcome, type GameBuildGame, GameBuildLanes } from "../../src/main/game-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import type { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { CrateRefusal } from "../../src/shared/crate-requests.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { ExportError, ExportRefusal } from "../../src/shared/game-export-contract.ts";
import {
  CONFORMANCE_CHECKS,
  ConformanceOutcome,
  type ConformanceRunPayload,
  ExtensionRefusal,
} from "../../src/shared/game-conformance.ts";
import {
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  ProjectKind,
} from "../../src/shared/game-project.ts";
import { NativeError, NativeRefusal, NativeRunMode } from "../../src/shared/native-contract.ts";
import { skillWords } from "../../src/shared/skill-words.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { removeRunDir } from "../../src/substrate/native-bundle.ts";
import { RUST_NIGHT_PARTS, seedNightRefusal } from "../../src/substrate/seed-upgrade.ts";
import { tools as seedGameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { ApplePlatform, buildVersion } from "../fixtures/rust-bundles/binaries.ts";
import { LoadCommand, loadCommand, machO } from "../helpers/macho.ts";
import { admittedReport } from "../helpers/rust-admitted.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SEED = path.join(REPO, "src", "harness-seed");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const LADDER_SKILL = "skills/rust-extension-ladder.md";
const CONFORMANCE_TOOL = "check_conformance";

const PROJECT = "forked";
const RUN_ID = "0123456789abcdef";
const RUST_LOCK = { version: 1, entries: {}, digest: "ab".repeat(32) } as ToolchainLock;
const HEADLESS_EXE = "game-headless";
/** The release the rigs' ejected games were copied from. */
const RELEASE = "0.1.0";
const EJECTED_TOML = `[game]\ntitle = "Forked"\n\n[engine]\nejected_from = "${RELEASE}"\n`;
const STORE_TOML = '[game]\ntitle = "Forked"\n';

// ── the guidance names real codes ─────────────────────────────────────────────────────────────

/** Every refusal an agent's guidance may name: the extension, run, crate and Rust lane vocabularies. */
const KNOWN_CODES: ReadonlySet<string> = new Set([
  ...Object.values(ExtensionRefusal),
  ...Object.values(NativeRefusal),
  ...Object.values(CrateRefusal),
  ...Object.values(RustBuildRefusal),
]);

/** The extension refusals an agent's work can meet (not the build's "cannot yet" stub). */
const AGENT_FACING = Object.values(ExtensionRefusal).filter((code) => code !== ExtensionRefusal.Unavailable);

/** The text of the `## <heading>` section of `markdown`, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  assert.ok(start >= 0, `no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** The backticked codes of every table row's first cell (`| \`a\`, \`b\` | ...`). */
function tableCodes(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) => [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""));
}

/** The backticked codes that open each bullet of a list (`- \`a\`, \`b\`: ...`). */
function bulletCodes(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("- `"))
    .flatMap((line) => [...(line.split(":")[0] ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""));
}

describe("the extension ladder guidance names the contract's codes", () => {
  it("the Rust template's Extension ladder section names only known refusals, and every extension refusal", async () => {
    const text = section(await readFile(path.join(TEMPLATE, "CLAUDE.md"), "utf8"), "Extension ladder");
    const named = tableCodes(text);
    assert.ok(named.length >= AGENT_FACING.length);
    for (const code of named) assert.ok(KNOWN_CODES.has(code), `${code} is not a refusal code`);
    for (const code of AGENT_FACING) assert.ok(named.includes(code), `the template does not explain ${code}`);
    assert.equal(new Set(named).size, named.length, "a code is explained twice");
    assert.ok(text.includes(CONFORMANCE_TOOL), "the template names the conformance tool");
  });

  it("the seed skill names only known refusals, every extension refusal, and is a skill the app can word", async () => {
    const text = await readFile(path.join(SEED, LADDER_SKILL), "utf8");
    assert.match(text, /^---\nname: .+\ndescription: .+\n---\n/);
    const named = bulletCodes(section(text, "Reading a refusal"));
    for (const code of named) assert.ok(KNOWN_CODES.has(code), `${code} is not a refusal code`);
    for (const code of AGENT_FACING) assert.ok(named.includes(code), `the skill does not explain ${code}`);
    assert.notEqual(skillWords(LADDER_SKILL), skillWords("skills/some-other-skill.md"));
  });

  it("the facade reference names the level 5 codes it describes, and the tool the guidance names exists", async () => {
    const text = section(await readFile(path.join(TEMPLATE, "docs", "GENEX_API.md"), "utf8"), "Extension ladder");
    const ticked = [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
    for (const code of [ExtensionRefusal.ConformanceRequired, ExtensionRefusal.UnsafeCode]) {
      assert.ok(ticked.includes(code), `GENEX_API.md does not name ${code}`);
    }
    for (const code of ticked.filter((token) => /^[a-z]+(?:-[a-z]+)+$/.test(token) && !token.startsWith("genex"))) {
      assert.ok(KNOWN_CODES.has(code), `${code} is not a refusal code`);
    }
    assert.ok(
      seedGameTools.some((tool) => tool.name === CONFORMANCE_TOOL),
      "the seed has the agent's conformance tool",
    );
  });
});

// ── a kept harness without the skill ───────────────────────────────────────────────────────────

describe("a harness workspace kept without the ladder skill", () => {
  it("still serves a Rust night: the skill is guidance, never a part the night needs", async () => {
    const workspace = await tmpDir("ladder-kept-");
    for (const rel of RUST_NIGHT_PARTS) {
      await mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
      await copyFile(path.join(SEED, rel), path.join(workspace, rel));
    }
    // A copy of the seed from before the ladder: no skills folder at all.
    assert.equal(await seedNightRefusal(GameStack.RustWgpu, { seedDir: SEED, workspaceDir: workspace }), null);
    assert.ok(!RUST_NIGHT_PARTS.includes(LADDER_SKILL));
  });
});

// ── the conformance gate at prepare and export ────────────────────────────────────────────────

/** A thin arm64 macOS executable importing the system only, as a wgpu build does. */
function wgpuGame(): Buffer {
  const dylibs = ["/System/Library/Frameworks/Metal.framework/Versions/A/Metal", "/usr/lib/libSystem.B.dylib"];
  const commands = dylibs.map((value) => loadCommand({ cmd: LoadCommand.LoadDylib, value }));
  return machO({}, [...commands, buildVersion(ApplePlatform.MacOs, "11.0")]);
}

function rustGame(dir: string): GameProject {
  return {
    name: PROJECT,
    dir,
    title: "Forked",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/forked",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    built: false,
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
}

/** One recorded suite run of `digest`: green, or red on its first check. */
function run(digest: string, green: boolean): ConformanceRunPayload {
  const checks = CONFORMANCE_CHECKS.map((check, index) => ({
    check,
    outcome: green || index > 0 ? ConformanceOutcome.Pass : ConformanceOutcome.Fail,
    code: null,
    detail: null,
  }));
  return { project: PROJECT, target: BuildTarget.Mac, buildDigest: digest, passed: green, checks };
}

interface GateRig {
  home: string;
  game: GameProject;
  root: string;
  digest: string;
  builds: Array<{ target: BuildTarget; purpose: CppBuildPurpose }>;
  signed: number;
  runs: ConformanceRunPayload[];
  lanes: GameBuildLanes;
  /** The person's eject as the profile records it (the gate never reads the game's `genex.toml`). */
  ejectedFrom: (project: string) => Promise<string | null>;
  deps: NativePrepareDeps;
}

/** A Rust game folder (ejected or not), its lane's Mac `out/` and the deps that prepare a run with the gate on. */
async function gateRig(ejected: boolean): Promise<GateRig> {
  const home = await tmpDir("ladder-gate-");
  const dir = path.join(home, PROJECT);
  const out = path.join(home, "build", "out");
  await mkdir(path.join(out, "assets"), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), ejected ? EJECTED_TOML : STORE_TOML);
  const exe = wgpuGame();
  await writeFile(path.join(out, "game"), exe, { mode: 0o755 });
  await writeFile(path.join(out, HEADLESS_EXE), exe, { mode: 0o755 });
  const game = rustGame(dir);
  const state = {
    builds: [] as GateRig["builds"],
    signed: 0,
    runs: [] as ConformanceRunPayload[],
  };
  const lane = {
    ensure: async (_game: GameBuildGame, target: BuildTarget, purpose: CppBuildPurpose): Promise<BuildOutcome> => {
      state.builds.push({ target, purpose });
      return { ok: true, output: out, lastGood: out, problem: null, ran: true, rust: await admittedReport(out) };
    },
    cancelAll: () => {},
    cancelGame: () => {},
    sweep: async () => 0,
  };
  const lanes = new GameBuildLanes({ [GameStack.RustWgpu]: lane });
  const root = path.join(home, "runs");
  const rig = Object.assign(state, {
    home,
    game,
    root,
    digest: createHash("sha256").update(exe).digest("hex"),
    lanes,
    ejectedFrom: async () => (ejected ? RELEASE : null),
  }) as Omit<GateRig, "deps">;
  const deps: NativePrepareDeps = {
    root,
    host: StudioPlatform.Mac,
    gameBox: () => true,
    games: { list: async () => [game], bundleIdFor: async () => "games.genex.game.0123456789ab" },
    gameBuilds: lanes,
    toolchains: {
      currentLock: async () => RUST_LOCK,
      locate: async () => ({ ok: false, missing: ["angle-macos"] }),
    } as unknown as NativePrepareDeps["toolchains"],
    exec: async () => {
      state.signed += 1;
      return { code: 0, stdout: "", stderr: "" };
    },
    conformance: (built) =>
      checkConformanceGate({
        ...built,
        ejectedFrom: (project) => rig.ejectedFrom(project),
        runs: async () => state.runs,
      }),
  };
  return Object.assign(rig, { deps });
}

function request(mode: NativeRunMode, conformance = false): NativePrepareRequest {
  return { project: PROJECT, target: BuildTarget.Mac, mode, runId: RUN_ID, ...(conformance ? { conformance } : {}) };
}

/** The typed refusal `work` is rejected with. */
async function refusalOf(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => assert.fail("prepared, not refused"),
    (error: unknown) => {
      assert.ok(error instanceof NativeError, `typed: ${String(error)}`);
      return error.refusal;
    },
  );
}

const signal = () => new AbortController().signal;

describe("an ejected game's run waits for a green conformance run on its build (prepare)", () => {
  for (const mode of [NativeRunMode.Embedded, NativeRunMode.Headless]) {
    it(`${mode}: refused conformance-required with no run, a red run or a green run of another build; nothing assembled`, async () => {
      const r = await gateRig(true);
      assert.equal(
        await refusalOf(prepareNativeRun(r.deps, request(mode), signal())),
        NativeRefusal.ConformanceRequired,
      );
      r.runs.push(run("cd".repeat(32), true));
      assert.equal(
        await refusalOf(prepareNativeRun(r.deps, request(mode), signal())),
        NativeRefusal.ConformanceRequired,
      );
      r.runs.push(run(r.digest, true), run(r.digest, false));
      assert.equal(
        await refusalOf(prepareNativeRun(r.deps, request(mode), signal())),
        NativeRefusal.ConformanceRequired,
        "the latest run on the digest counts: red after green closes the gate",
      );
      assert.deepEqual(await readdir(r.root).catch(() => []), [], "no run directory");
      assert.equal(r.signed, 0, "nothing signed");
    });
  }

  it("asks the person's eject, never the game's genex.toml: a row removed after the build leaves the gate shut", async () => {
    const r = await gateRig(true);
    await writeFile(path.join(r.game.dir, "genex.toml"), STORE_TOML);
    assert.equal(
      await refusalOf(prepareNativeRun(r.deps, request(NativeRunMode.Embedded), signal())),
      NativeRefusal.ConformanceRequired,
    );
    const claimed = await gateRig(false);
    await writeFile(path.join(claimed.game.dir, "genex.toml"), EJECTED_TOML);
    const plain = await prepareNativeRun(claimed.deps, request(NativeRunMode.Embedded), signal());
    await removeRunDir(plain.runDir);
    assert.equal(
      plain.build?.digest,
      claimed.digest,
      "a row the person never made is not an eject (its build links no fork)",
    );
  });

  it("opens on a green run of the very build, and lets the suite's own run and a store-engine game through", async (t) => {
    const ejected = await gateRig(true);
    const own = await prepareNativeRun(ejected.deps, request(NativeRunMode.Headless, true), signal());
    t.after(() => removeRunDir(own.runDir));
    assert.equal(own.build?.digest, ejected.digest, "the suite's run is the build the gate later judges");
    ejected.runs.push(run(ejected.digest, true));
    const live = await prepareNativeRun(
      ejected.deps,
      { ...request(NativeRunMode.Embedded), runId: "fedcba9876543210" },
      signal(),
    );
    t.after(() => removeRunDir(live.runDir));
    const store = await gateRig(false);
    const plain = await prepareNativeRun(store.deps, request(NativeRunMode.Embedded), signal());
    t.after(() => removeRunDir(plain.runDir));
    assert.equal(plain.build?.digest, store.digest);
  });
});

/** Export runners that record which ran, with the gate over `r`'s runs. */
function exportRunners(r: GateRig, ran: string[]): ExportRunners {
  const result = (dir: string): ExportResult => ({
    dir,
    files: 0,
    included: [],
    excluded: [],
    destination: BuildTarget.Web,
  });
  const recorded = (name: string) => async (_game: GameProject, dir: string) => {
    ran.push(name);
    return result(dir);
  };
  const never = async () => assert.fail("not this export");
  return {
    browserFolder: recorded("browser"),
    compiledWeb: recorded("compiled-web"),
    macApp: never,
    desktopArchive: never,
    iosApp: never,
    androidPackage: never,
    conformance: (game) =>
      exportConformanceGate(
        {
          gameBuilds: r.lanes,
          toolchains: { currentLock: async () => RUST_LOCK } as never,
          ejectedFrom: r.ejectedFrom,
          runs: async () => r.runs,
        },
        game,
      ),
  };
}

describe("an ejected game's export waits for a green conformance run on its current Mac build", () => {
  it("refuses conformance-required before any export runs, then exports once the build passes", async () => {
    const r = await gateRig(true);
    const ran: string[] = [];
    const ask = { game: r.game, destination: BuildTarget.Web, targetDir: path.join(r.home, "export"), person: true };
    await assert.rejects(runExport(exportRunners(r, ran), ask), (error: unknown) => {
      assert.ok(error instanceof ExportError);
      assert.equal(error.code, ExportRefusal.ConformanceRequired);
      return true;
    });
    assert.deepEqual(ran, [], "nothing exported");
    assert.deepEqual(r.builds, [{ target: BuildTarget.Mac, purpose: "judging" }], "the gate judged the Mac build");
    r.runs.push(run(r.digest, true));
    await runExport(exportRunners(r, ran), ask);
    assert.deepEqual(ran, ["compiled-web"]);
  });

  it("a game on the store's engine exports with no conformance run and no extra build", async () => {
    const r = await gateRig(false);
    const ran: string[] = [];
    const ask = { game: r.game, destination: BuildTarget.Web, targetDir: path.join(r.home, "export"), person: false };
    await runExport(exportRunners(r, ran), ask);
    assert.deepEqual(ran, ["compiled-web"]);
    assert.deepEqual(r.builds, [], "no build asked for the gate");
  });
});

// ── the person's engine rows and the escapes report ───────────────────────────────────────────

describe("the engine rows read the game's engine and trust flag", () => {
  it("answers the release an ejected game was copied from, null for the store's engine, and the flag as kept", async () => {
    const ejected = await gateRig(true);
    const store = await gateRig(false);
    const dirs: Record<string, string> = { forked: ejected.game.dir, plain: store.game.dir };
    // The plain game's folder claims an eject in its own genex.toml: only the person's record counts.
    await writeFile(path.join(store.game.dir, "genex.toml"), EJECTED_TOML);
    const deps = {
      rustGame: async (project: string) => (dirs[project] ? { dir: dirs[project] } : null),
      ejections: { ejectedFrom: async (project: string) => (project === "forked" ? RELEASE : null) },
      trust: { trustOf: async (game: { project: string }) => ({ trusted: game.project === "forked", claim: null }) },
    };
    assert.deepEqual(await engineStateOf(deps, "forked"), { project: "forked", ejectedFrom: RELEASE, trusted: true });
    assert.deepEqual(await engineStateOf(deps, "plain"), { project: "plain", ejectedFrom: null, trusted: false });
    await assert.rejects(engineStateOf(deps, "missing"));
  });
});

/** One recorded event of the studio's log carrying `data`. */
function envelope(index: number, data: ReturnType<typeof customEventData>): EventEnvelope {
  return {
    id: `evt-${String(index).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(index).toISOString(),
    data,
  } as EventEnvelope;
}

describe("npm run report:extension-escapes", () => {
  it("counts crates across games, and each game's latest eject and trust state", () => {
    const events = [
      customEventData(CustomEvent.CrateRequest, { project: "a", name: "tidy", version: "1.0.0", state: "pending" }),
      customEventData(CustomEvent.CrateRequest, { project: "b", name: "tidy", version: "1.0.1", state: "pending" }),
      customEventData(CustomEvent.CrateRequest, { project: "a", name: "rare", version: "0.1.0", state: "pending" }),
      customEventData(CustomEvent.EngineEjected, { project: "a", ejected: true, ejectedFrom: "0.1.0" }),
      customEventData(CustomEvent.EngineEjected, { project: "a", ejected: false, ejectedFrom: null }),
      customEventData(CustomEvent.GameTrust, { project: "b", trusted: true }),
      customEventData(CustomEvent.ConformanceRun, { project: "a", passed: true }),
    ].map((data, index) => envelope(index, data));
    const report = summarizeEscapes(events);
    assert.equal(report.events, 6, "only escape events count");
    assert.deepEqual(
      report.crates.map(({ name, games, asks, recurring }) => ({ name, games, asks, recurring })),
      [
        { name: "tidy", games: ["a", "b"], asks: 2, recurring: true },
        { name: "rare", games: ["a"], asks: 1, recurring: false },
      ],
    );
    assert.deepEqual(report.ejected, [{ project: "a", ejected: false, ejectedFrom: null }]);
    assert.deepEqual(report.trusted, [{ project: "b", trusted: true }]);
  });
});
