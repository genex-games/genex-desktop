/**
 * The Genex editor helper's loop tools are Python that runs inside Unreal. Their input checks
 * (part script paths, part.json, capture names, import kinds, export files) are tested outside
 * the editor against a stub `unreal`, `toolset_registry` and `editor_toolset`
 * (tests/fixtures/unreal-helper/stubs): refused input must never run a part's script, change the
 * editor or write a file. Each Python test module runs as its own case.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { agentBrief } from "../../src/harness-seed/loop/unreal/agent-prompts.ts";
import { AgentKind } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { TOOLSET_OF } from "../../src/plugins/unreal/loop-tools.ts";
import { checkPython, GENEX_NAMES } from "../../src/plugins/unreal/python-check.ts";

const FIXTURES = path.resolve("tests/fixtures/unreal-helper");
const HELPER_PYTHON = path.resolve("src/plugins/unreal/GenexEditorHelper/Content/Python");
/** Unreal 5.8 ships Python 3.11; the helper uses 3.10 syntax (`X | None`). */
const MIN_PYTHON = [3, 10] as const;
const PYTHON_TIMEOUT_MS = 60_000;

function pythonVersion(): number[] | undefined {
  const probe = spawnSync("python3", ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], {
    encoding: "utf8",
  });
  if (probe.status !== 0) return undefined;
  return probe.stdout.trim().split(" ").map(Number);
}

function skipReason(): string | false {
  if (process.platform === "win32") return "the helper's path checks are tested on POSIX paths";
  const version = pythonVersion();
  if (!version) return "no python3 on PATH";
  const [major = 0, minor = 0] = version;
  if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1]))
    return `python3 ${version.join(".")} is older than ${MIN_PYTHON.join(".")}`;
  return false;
}

const SKIP = skipReason();
const modules = readdirSync(FIXTURES)
  .filter((name) => /^test_.*\.py$/.test(name))
  .map((name) => name.replace(/\.py$/, ""))
  .sort();

test("the helper's Python tests are found", { skip: SKIP }, () => {
  assert.ok(modules.length > 0, `no test_*.py in ${FIXTURES}`);
});

/** Python with the stubs first, then the helper's packages and the tests' support module. */
const PYTHON = {
  cwd: FIXTURES,
  encoding: "utf8",
  timeout: PYTHON_TIMEOUT_MS,
  env: {
    ...process.env,
    PYTHONPATH: [path.join(FIXTURES, "stubs"), HELPER_PYTHON, FIXTURES].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: "1",
  },
} as const;

/** Names each toolset class's public tools: `{"genex_loop.tools.GenexLoopTools": ["apply_part", ...]}`. */
const LIST_TOOLS = `import importlib, json, sys
names = {}
for dotted in sys.argv[1:]:
    module, name = dotted.rsplit('.', 1)
    names[dotted] = sorted(n for n in vars(getattr(importlib.import_module(module), name)) if not n.startswith('_'))
print(json.dumps(names))`;

test("every editor tool the Loop sends to the Genex editor helper is one of its tools", { skip: SKIP }, () => {
  // The helper's Python packages are genex_play and genex_loop; the rest are Epic's.
  const routed = Object.entries(TOOLSET_OF).filter(([, toolset]) => toolset.startsWith("genex_"));
  const toolsets = [...new Set(routed.map(([, toolset]) => toolset))];
  const run = spawnSync("python3", ["-c", LIST_TOOLS, ...toolsets], PYTHON);
  assert.equal(run.status, 0, run.stderr);
  const names = JSON.parse(run.stdout) as Record<string, string[]>;
  for (const [tool, toolset] of routed) assert.ok(names[toolset]?.includes(tool), `${toolset} has no tool ${tool}`);
});

/** Each import tool's parameters, in order, as the build toolset declares them. */
const IMPORT_PARAMS = `import inspect, json
from genex_build.tools import GenexBuildTools
names = ['import_model', 'import_character', 'import_animation', 'import_sound']
print(json.dumps({n: list(inspect.signature(getattr(GenexBuildTools, n)).parameters) for n in names}))`;

test("a sub-agent's brief writes every import call with every argument the build tools take", { skip: SKIP }, () => {
  const run = spawnSync("python3", ["-c", IMPORT_PARAMS], PYTHON);
  assert.equal(run.status, 0, run.stderr);
  const params = JSON.parse(run.stdout) as Record<string, string[]>;
  const brief = agentBrief({
    kind: AgentKind.BlenderModel,
    title: "Katana",
    brief: "A katana.",
    game: "Night Spire",
    folder: "assets/agents/blender_model-1",
    cppFolder: null,
    inputs: [],
    engine: "claude-code",
  });
  // The manifest's example import call: Unreal's tool schema has no defaults, so it passes them all.
  const example = /"import_model (\{.*\})"/.exec(brief)?.[1]?.replace(/\\"/g, '"') ?? "{}";
  assert.deepEqual(Object.keys(JSON.parse(example)), params.import_model);
  for (const [tool, names] of Object.entries(params))
    assert.ok(
      brief.includes(`${tool} {${names.join(", ")}`),
      `the brief names ${tool}'s arguments: ${names.join(", ")}`,
    );
});

/** The public names of the `genex` module `apply_part` hands a part's apply.py. */
const LIST_GENEX = `import json
from genex_loop import part_api
from genex_loop.part_files import PartFiles
api = part_api.for_part(PartFiles('Bike', '/game/unreal/parts/Bike', '', '', '', '', []))
print(json.dumps(sorted(n for n in vars(api) if not n.startswith('_'))))`;

test("apply.py's check knows exactly the names of the helper's genex module", { skip: SKIP }, () => {
  const run = spawnSync("python3", ["-c", LIST_GENEX], PYTHON);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [...GENEX_NAMES].sort());
});

/** Unreal 5.8.3's own names for every class the stub models (make_real_names.py). */
const REAL_NAMES = path.join(FIXTURES, "real-names-5.8.json");
/** The helper's packages agents call into the editor through; `*_math.py` modules are pure and touch no engine. */
const ENGINE_FACING = ["genex_build", "genex_play"].flatMap((pkg) =>
  readdirSync(path.join(HELPER_PYTHON, pkg))
    .filter((file) => file.endsWith(".py") && !file.endsWith("_math.py"))
    .map((file) => path.join(pkg, file)),
);

test("python-check finds every Unreal name the build and play tools use among Unreal 5.8's own", {
  skip: SKIP,
}, async () => {
  assert.ok(ENGINE_FACING.includes(path.join("genex_build", "terrain.py")), ENGINE_FACING.join(", "));
  for (const file of ENGINE_FACING) {
    const source = readFileSync(path.join(HELPER_PYTHON, file), "utf8");
    const problems = await checkPython({ python: "python3", names: REAL_NAMES }, source);
    assert.deepEqual(problems, [], `${file}: ${problems.map((p) => `line ${p.line}: ${p.message}`).join("; ")}`);
  }
});

for (const name of modules) {
  test(`Genex editor helper Python: ${name}`, { skip: SKIP }, () => {
    const run = spawnSync("python3", ["-m", "unittest", "-v", name], PYTHON);
    const report = `${run.stdout}\n${run.stderr}`;
    const ran = Number(/Ran (\d+) tests?/.exec(report)?.[1] ?? 0);
    assert.equal(run.status, 0, report);
    assert.ok(ran > 0, `no tests ran:\n${report}`);
    assert.match(report, /\nOK\b/, report);
  });
}
