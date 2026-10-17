/**
 * check-scripts over a game's `.luau` files: luau-lsp (types, with Roblox's definitions and a Rojo
 * sourcemap of `src/`), selene (lint, Roblox's library) and StyLua (format), run with argument lists
 * from the game folder. Their findings come back as plain lines, each at its file and line. The
 * programs are stand-ins (`fixtures/fake-luau-tool.mjs`) printing what the real ones printed for
 * `fixtures/roblox-luau/game`, on their real streams with their real exit codes. A file found clean
 * is checked again only once it changes; the finish is held only by errors.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CHECK_CONFIGS,
  type CheckDeps,
  type CheckRun,
  checkScripts,
  FindingKind,
  type LuauFinding,
  luauFinish,
  luauNote,
  MAX_CHECK_OUTPUT_BYTES,
  parseLuauLsp,
  parseSelene,
  parseStylua,
  systemCheckRun,
  writeCheckConfigs,
} from "../../src/plugins/roblox/check-scripts.ts";
import { HOOK_NOTE_CHARS, HOOK_REASON_CHARS } from "../../src/shared/plugin-hooks.ts";
import { createRobloxBackend } from "../../src/plugins/roblox/backend.ts";
import { LuauTool, type LuauToolset } from "../../src/plugins/roblox/luau-tools.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;
const FIXTURE = path.resolve("tests/fixtures/roblox-luau");
const FAKE = path.resolve("tests/fixtures/fake-luau-tool.mjs");
const MAIN = "src/ServerScriptService/Main.server.luau";
const INPUT = "src/StarterPlayer/StarterPlayerScripts/Input.client.luau";
const UTIL = "src/ReplicatedStorage/Shared/Util.luau";
const ALL_FILES = [
  "src/ReplicatedStorage/Round/Timer.luau",
  "src/ReplicatedStorage/Round/init.luau",
  UTIL,
  MAIN,
  "src/ServerScriptService/Odd%3AName.server.luau",
  INPUT,
];

type Mode = "recorded" | "clean" | "hang" | "flood" | "crash" | "parse-error";

/** A copy of the fixture game, Genex's storage, and the stand-in programs as if found there. */
async function bench(modes: Partial<Record<LuauTool, Mode>> = {}) {
  const root = await realpath(await tmpDir("roblox-check-"));
  const folder = path.join(root, "game");
  const storage = path.join(root, "storage");
  await cp(path.join(FIXTURE, "game"), folder, { recursive: true });
  await mkdir(storage);
  const log = path.join(root, "calls.jsonl");
  const ours = path.join(storage, "luau", "selene-0.32.0", "selene");
  const tools: LuauToolset = {
    programs: {
      [LuauTool.LuauLsp]: { tool: LuauTool.LuauLsp, file: "/opt/tools/luau-lsp", ours: false },
      [LuauTool.Selene]: { tool: LuauTool.Selene, file: ours, ours: true },
      [LuauTool.StyLua]: { tool: LuauTool.StyLua, file: "/opt/tools/stylua", ours: false },
    },
    definitions: path.join(storage, "luau", "roblox-types-1.70.1", "globalTypes.None.d.luau"),
  };
  const run: CheckRun = (file, args, options) => {
    const tool = path.basename(file) as LuauTool;
    return systemCheckRun(process.execPath, [FAKE, tool, modes[tool] ?? "recorded", log, ...args], options);
  };
  const deps: CheckDeps = { run, storage, platform: process.platform, tools };
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { tool: string; args: string[]; cwd: string; home: string | null; sourcemap?: unknown },
      );
  return { root, folder, storage, deps, tools, calls };
}

const at = (finding: LuauFinding) =>
  `${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ""} ${finding.kind} ${finding.tool}`;

describe("check-scripts maps each program's findings to files and lines", () => {
  it("reports luau-lsp's type errors, selene's errors and warnings, and StyLua's format differences", async () => {
    const { folder, deps } = await bench();
    const check = await checkScripts(deps, { folder, all: true });
    assert.deepEqual(check.files, ALL_FILES);
    assert.deepEqual(check.ran, [LuauTool.LuauLsp, LuauTool.Selene, LuauTool.StyLua]);
    assert.deepEqual(check.failed, []);
    assert.deepEqual(check.findings.map(at), [
      `${MAIN}:4:1 error luau-lsp`,
      `${MAIN}:5:7 warning luau-lsp`,
      `${MAIN}:5:7 warning selene`,
      `${MAIN}:7 format stylua`,
      `${MAIN}:7:21 warning selene`,
      `${INPUT}:4:33 error luau-lsp`,
      `${INPUT}:4:33 error selene`,
    ]);
    const typeError = check.findings[0] as LuauFinding;
    assert.equal(typeError.rule, "TypeError");
    assert.equal(typeError.message, "Expected this to be 'number', but got 'string'");
    assert.deepEqual(
      { errors: check.errors, warnings: check.warnings, format: check.format },
      { errors: 3, warnings: 3, format: 1 },
    );
    const lines = check.message.split("\n");
    assert.match(lines[0] ?? "", /^Luau checks of 6 files: 3 errors, 3 warnings, 1 format difference\.$/);
    assert.ok(lines.includes(`${MAIN}:4:1 error (luau-lsp TypeError): Expected this to be 'number', but got 'string'`));
    assert.ok(lines.includes(`${MAIN}:7 format (StyLua): StyLua lays out line 7 differently`));
    assert.doesNotMatch(check.message, BANNED_WORDS);
  });

  it("counts only what was found: no zero counts in the head line", async () => {
    const { folder, deps } = await bench({ [LuauTool.Selene]: "clean", [LuauTool.StyLua]: "clean" });
    const check = await checkScripts(deps, { folder, all: true });
    assert.equal(check.message.split("\n")[0], "Luau checks of 6 files: 2 errors, 1 warning.");
  });

  it("runs each program from the game folder with argument lists: the sourcemap, the definitions, selene's config", async () => {
    const { folder, storage, deps, tools, calls } = await bench();
    await checkScripts(deps, { folder, all: true });
    const byTool = Object.fromEntries((await calls()).map((call) => [call.tool, call]));
    const lsp = byTool["luau-lsp"];
    assert.ok(lsp);
    assert.equal(lsp.cwd, folder);
    const map = lsp.args.find((arg) => arg.startsWith("--sourcemap="))?.slice("--sourcemap=".length) ?? "";
    assert.deepEqual(lsp.args, [
      "analyze",
      "--formatter=gnu",
      "--platform=roblox",
      `--sourcemap=${map}`,
      `--definitions=@roblox=${tools.definitions}`,
      ...ALL_FILES,
    ]);
    assert.ok(
      map.startsWith(path.join(storage, "luau")),
      "the sourcemap is Genex's, in its storage, never in the game",
    );
    assert.deepEqual(lsp.sourcemap, JSON.parse(await readFile(path.join(FIXTURE, "sourcemap.json"), "utf8")));
    assert.ok(
      !(await readdir(path.join(storage, "luau"))).some((name) => name.startsWith(".check-")),
      "the check's own folder is gone after it",
    );
    assert.deepEqual(byTool.selene?.args, [
      "--display-style=Json2",
      "--no-summary",
      `--config=${path.join(storage, "luau", "selene.toml")}`,
      ...ALL_FILES,
    ]);
    if (process.platform !== "win32")
      assert.equal(
        byTool.selene?.home,
        path.join(storage, "luau", "home"),
        "Genex's selene caches Roblox's library in Genex's storage",
      );
    assert.notEqual(
      byTool.stylua?.home,
      path.join(storage, "luau", "home"),
      "the person's own programs keep their home",
    );
    assert.deepEqual(byTool.stylua?.args, ["--check", "--output-format=json", ...ALL_FILES]);
  });

  it("uses the game's own selene.toml and sourcemap.json when it has them", async () => {
    const { folder, deps, calls } = await bench();
    await writeFile(path.join(folder, "selene.toml"), 'std = "roblox"\n');
    await writeFile(path.join(folder, "sourcemap.json"), '{"name":"Rojo","className":"DataModel"}\n');
    await checkScripts(deps, { folder, all: true });
    const byTool = Object.fromEntries((await calls()).map((call) => [call.tool, call]));
    assert.ok(byTool["luau-lsp"]?.args.includes("--sourcemap=sourcemap.json"));
    assert.ok(!byTool.selene?.args.some((arg) => arg.startsWith("--config=")));
  });

  it("reads StyLua's own parse errors as errors at their line", () => {
    const text = `[{"filename":"src/A.luau","location":{"end":9,"end_column":10,"end_line":1,"start":8,"start_column":9,"start_line":1},"message":"unexpected token \`=\`: expected an expression","type":"parse_error"}]`;
    assert.deepEqual(parseStylua(text), [
      {
        tool: LuauTool.StyLua,
        kind: FindingKind.Error,
        file: "src/A.luau",
        line: 1,
        column: 9,
        rule: "parse_error",
        message: "unexpected token `=`: expected an expression",
      },
    ]);
  });

  it("maps luau-lsp's absolute paths into the game folder, skips its log lines, and tells errors from lints", () => {
    const folder = process.platform === "win32" ? "C:\\games\\g" : "/games/g";
    const abs = process.platform === "win32" ? "C:\\games\\g\\src\\A.luau" : "/games/g/src/A.luau";
    const text = [
      "[INFO] Loading definitions file: @roblox - /x/defs.d.luau",
      `${abs} [game/ServerScriptService/A]:2.3-2.9: TypeError: Unknown global 'x'`,
      "src/A.luau:5.1-5.4: SyntaxError: Expected 'end'",
      "src/A.luau:6.7-6.12: LocalUnused: Variable 'unused' is never used",
      "not a finding line",
    ].join("\n");
    assert.deepEqual(
      parseLuauLsp(text, folder).map((f) => [f.file, f.line, f.column, f.kind, f.rule]),
      [
        ["src/A.luau", 2, 3, FindingKind.Error, "TypeError"],
        ["src/A.luau", 5, 1, FindingKind.Error, "SyntaxError"],
        ["src/A.luau", 6, 7, FindingKind.Warning, "LocalUnused"],
      ],
    );
  });

  it("reads selene's lines and columns, which count from zero", () => {
    const text = `{"type":"Diagnostic","severity":"Error","code":"undefined_variable","message":"\`x\` is not defined","primary_label":{"filename":"src/A.luau","span":{"start":1,"start_line":0,"start_column":0,"end":2,"end_line":0,"end_column":1},"message":""},"notes":[],"secondary_labels":[]}\n{"type":"Summary","errors":1,"warnings":0,"parse_errors":0}\nnot json`;
    assert.deepEqual(
      parseSelene(text).map((f) => [f.file, f.line, f.column, f.kind, f.rule]),
      [["src/A.luau", 1, 1, FindingKind.Error, "undefined_variable"]],
    );
  });
});

describe("what check-scripts checks again", () => {
  it("checks a clean file again only once it changes; files with findings each time", async () => {
    const { folder, deps } = await bench();
    const first = await checkScripts(deps, { folder, game: "game-1" });
    assert.deepEqual(first.files, ALL_FILES, "the first check reads every script");
    const second = await checkScripts(deps, { folder, game: "game-1" });
    assert.deepEqual(second.files, [MAIN, INPUT], "only the files that still had findings");
    await writeFile(path.join(folder, UTIL), "--!strict\nreturn {}\n");
    const third = await checkScripts(deps, { folder, game: "game-1" });
    assert.deepEqual(third.files, [UTIL, MAIN, INPUT]);
    const everything = await checkScripts(deps, { folder, game: "game-1", all: true });
    assert.deepEqual(everything.files, ALL_FILES);
  });

  it("checks everything again when the programs that check change", async () => {
    const { folder, deps, tools } = await bench();
    await checkScripts(deps, { folder, game: "game-1" });
    const withoutLsp: LuauToolset = { ...tools, programs: { ...tools.programs, [LuauTool.LuauLsp]: undefined } };
    const after = await checkScripts({ ...deps, tools: withoutLsp }, { folder, game: "game-1" });
    assert.deepEqual(after.files, ALL_FILES);
    assert.deepEqual(after.missing, [LuauTool.LuauLsp]);
  });

  it("answers there is nothing to check for a game with no scripts", async () => {
    const { root, deps, calls } = await bench();
    const empty = path.join(root, "empty");
    await mkdir(empty);
    const check = await checkScripts(deps, { folder: empty, all: true });
    assert.deepEqual(check.files, []);
    assert.deepEqual(await calls(), [], "no program runs");
    assert.match(check.message, /no \.luau scripts under src/);
  });
});

describe("a program that misbehaves is named, never mistaken for a clean check", () => {
  const rows: Array<{ name: string; tool: LuauTool; mode: Mode; why: RegExp }> = [
    { name: "hangs past its limit", tool: LuauTool.LuauLsp, mode: "hang", why: /didn't finish within/ },
    { name: "prints past the cap", tool: LuauTool.Selene, mode: "flood", why: /printed more than/ },
    { name: "stops with an unknown code", tool: LuauTool.StyLua, mode: "crash", why: /stopped with code 3/ },
  ];
  for (const row of rows)
    it(`${row.tool} ${row.name}`, async () => {
      const { folder, deps } = await bench({ [row.tool]: row.mode });
      const short: CheckDeps = { ...deps, timeout: () => AbortSignal.timeout(500) };
      const check = await checkScripts(short, { folder, game: "g", all: true });
      assert.deepEqual(
        check.failed.map((failure) => failure.tool),
        [row.tool],
      );
      assert.match(check.failed[0]?.why ?? "", row.why);
      assert.ok(!check.findings.some((finding) => finding.tool === row.tool));
      assert.match(check.message, new RegExp(`${row.tool === LuauTool.StyLua ? "StyLua" : row.tool} `));
      const again = await checkScripts(short, { folder, game: "g" });
      assert.deepEqual(again.files, ALL_FILES, "nothing counts as clean after a check that didn't finish");
    });

  it("a program that can't start", async () => {
    const { folder, deps } = await bench();
    const run: CheckRun = (file, args, options) =>
      path.basename(file) === LuauTool.Selene
        ? systemCheckRun("/no/such/selene", args, options)
        : deps.run(file, args, options);
    const check = await checkScripts({ ...deps, run }, { folder, all: true });
    assert.deepEqual(
      check.failed.map((failure) => [failure.tool, /couldn't start/.test(failure.why)]),
      [[LuauTool.Selene, true]],
    );
    assert.ok(MAX_CHECK_OUTPUT_BYTES < 6 * 1024 * 1024, "the flood row prints past the cap");
  });

  it("skips luau-lsp with a plain reason while Roblox's definitions aren't added", async () => {
    const { folder, deps, tools, calls } = await bench();
    const check = await checkScripts({ ...deps, tools: { programs: tools.programs } }, { folder, all: true });
    assert.deepEqual(check.ran, [LuauTool.Selene, LuauTool.StyLua]);
    assert.ok(!(await calls()).some((call) => call.tool === LuauTool.LuauLsp));
    assert.match(check.message, /Roblox's type definitions aren't added/);
  });
});

describe("the moments: a worker's end notes, the finish holds only for errors", () => {
  it("holds the finish on errors, naming the first in a reason within the host's cap", async () => {
    const { folder, deps } = await bench();
    const answer = luauFinish(await checkScripts(deps, { folder, all: true }));
    assert.ok(answer.block);
    assert.ok(answer.block.length <= HOOK_REASON_CHARS);
    assert.match(answer.block, /^The game's Luau has 3 errors\. /);
    assert.match(answer.block, /src\/ServerScriptService\/Main\.server\.luau:4/);
    assert.match(answer.block, /check-scripts/);
    assert.ok((answer.note ?? "").length <= HOOK_NOTE_CHARS);
    assert.doesNotMatch(answer.block, BANNED_WORDS);
  });

  it("lets the finish go on warnings and format alone, with a note", async () => {
    const { folder, deps } = await bench({ [LuauTool.LuauLsp]: "clean" });
    const onlyWarnings = await checkScripts(
      { ...deps, tools: { ...deps.tools, programs: { ...deps.tools.programs, [LuauTool.Selene]: undefined } } },
      { folder, all: true },
    );
    assert.equal(onlyWarnings.errors, 0);
    const answer = luauFinish(onlyWarnings);
    assert.equal(answer.block, undefined);
    assert.match(answer.note ?? "", /StyLua/);
  });

  it("notes a worker's findings at its end, and says nothing when its scripts are clean", async () => {
    const { folder, deps } = await bench();
    const note = luauNote(await checkScripts(deps, { folder, all: true }), "Shop remotes");
    assert.match(note.note ?? "", /^Luau checks after Shop remotes: 3 errors, 3 warnings/);
    assert.ok((note.note ?? "").length <= HOOK_NOTE_CHARS);
    const clean = await bench({ [LuauTool.LuauLsp]: "clean", [LuauTool.Selene]: "clean", [LuauTool.StyLua]: "clean" });
    assert.deepEqual(luauNote(await checkScripts(clean.deps, { folder: clean.folder, all: true }), "Shop remotes"), {});
  });
});

describe("a new game's check settings", () => {
  it("writes selene.toml and stylua.toml once, never over the game's own", async () => {
    const folder = await tmpDir("roblox-check-configs-");
    await writeFile(path.join(folder, "stylua.toml"), 'indent_type = "Spaces"\n');
    assert.deepEqual(await writeCheckConfigs(folder), ["selene.toml"]);
    assert.equal(await readFile(path.join(folder, "selene.toml"), "utf8"), CHECK_CONFIGS["selene.toml"]);
    assert.equal(await readFile(path.join(folder, "stylua.toml"), "utf8"), 'indent_type = "Spaces"\n');
    assert.deepEqual(await writeCheckConfigs(folder), []);
    assert.match(CHECK_CONFIGS["selene.toml"], /^std = "roblox"$/m);
  });
});

describe("through the Roblox backend", () => {
  /** A Mac whose plugin storage holds Genex's three programs (stand-ins) and the definitions. */
  async function macWithChecks(options: { definitions?: boolean; programs?: boolean } = {}) {
    const mac = await robloxMac();
    const game = await makeGame(mac, "shop", "Shop");
    await cp(path.join(FIXTURE, "game", "src"), path.join(game.directory, "src"), { recursive: true });
    const luauRoot = path.join(mac.storage, "luau");
    const placed: Array<[string, string]> = [
      ["luau-lsp-1.70.1", "luau-lsp"],
      ["selene-0.32.0", "selene"],
      ["stylua-2.6.0", "stylua"],
    ];
    if (options.programs ?? true)
      for (const [folder, name] of placed) {
        await mkdir(path.join(luauRoot, folder), { recursive: true });
        await writeFile(path.join(luauRoot, folder, name), "stand-in");
      }
    if (options.definitions ?? true) {
      await mkdir(path.join(luauRoot, "roblox-types-1.70.1"), { recursive: true });
      await writeFile(path.join(luauRoot, "roblox-types-1.70.1", "globalTypes.None.d.luau"), "declare game: any");
    }
    const run: CheckRun = (file, args, runOptions) =>
      systemCheckRun(process.execPath, [FAKE, path.basename(file), "recorded", "-", ...args], runOptions);
    const seen: string[] = [];
    const luau = {
      arch: "arm64",
      run,
      fetch: (async () => {
        throw new TypeError("no network in this test");
      }) as typeof fetch,
      unpack: mac.deps.install.run,
    };
    const backend = createRobloxBackend({
      ...mac.deps,
      env: {},
      luau,
      gameSeen: async (_storage, _game, folder) => void seen.push(folder),
    });
    return { mac, game, backend, seen };
  }

  it("check-scripts answers each finding at its file and line, and never hands a worker's copy to the script sync", async (t) => {
    if (process.platform === "win32") return t.skip("the fake Mac is POSIX-only");
    const { mac, game, backend, seen } = await macWithChecks();
    const answer = (await backend.tool?.("check-scripts", { all: true }, hostFor(mac, game).context)) as {
      checked: boolean;
      errors: number;
      message: string;
    };
    assert.equal(answer.checked, true);
    assert.equal(answer.errors, 3);
    assert.match(answer.message, /src\/StarterPlayer\/StarterPlayerScripts\/Input\.client\.luau:4:33 error/);
    assert.deepEqual(seen, [], "a check may run in a worker's copy, whose folder is never the game's");
  });

  it("holds the finish on errors and notes a worker's end, only at those moments", async (t) => {
    if (process.platform === "win32") return t.skip("the fake Mac is POSIX-only");
    const { mac, game, backend } = await macWithChecks();
    const context = hostFor(mac, game).context;
    const finish = (await backend.tool?.("luau-finish", {}, { ...context, hook: { on: "finish" } })) as {
      block?: string;
    };
    assert.match(finish.block ?? "", /^The game's Luau has 3 errors\./);
    const worker = { id: "w1", title: "Shop remotes" };
    const note = (await backend.tool?.("luau-note", {}, { ...context, hook: { on: "worker.end", worker } })) as {
      note?: string;
    };
    assert.match(note.note ?? "", /^Luau checks after Shop remotes: 3 errors/);
    assert.deepEqual(await backend.tool?.("luau-finish", {}, context), {}, "called outside its moment it says nothing");
  });

  it("answers check-scripts plainly while nothing is added, and offers Add Luau checks with this computer's size", async (t) => {
    if (process.platform === "win32") return t.skip("the fake Mac is POSIX-only");
    const { mac, game, backend } = await macWithChecks({ programs: false, definitions: false });
    const context = hostFor(mac, game).context;
    const answer = (await backend.tool?.("check-scripts", {}, context)) as { checked: boolean; message: string };
    assert.equal(answer.checked, false);
    // Flipped: the agent adds the checks itself with its own tool; the person only approves the card.
    assert.match(answer.message, /roblox__add-luau-checks/);
    const status = (await backend.action?.("status", {}, context)) as { luau?: { added: boolean; offered: boolean } };
    assert.deepEqual(status.luau, { added: false, offered: true });
    const review = await backend.review?.("add-luau-checks", {}, context);
    assert.equal(
      review?.message,
      "Download luau-lsp, selene and StyLua from GitHub (about 14 MB) for checking this game's scripts?",
    );
    assert.doesNotMatch(`${review?.message} ${review?.detail}`, BANNED_WORDS);
  });

  it("says the checks are added once every program and the definitions are here, downloading nothing", async (t) => {
    if (process.platform === "win32") return t.skip("the fake Mac is POSIX-only");
    const { mac, game, backend } = await macWithChecks();
    const context = hostFor(mac, game).context;
    const status = (await backend.action?.("status", {}, context)) as { luau?: { added: boolean; offered: boolean } };
    assert.deepEqual(status.luau, { added: true, offered: false });
    const added = (await backend.action?.("add-luau-checks", {}, context)) as { added: boolean; message: string };
    assert.deepEqual(added, { added: true, message: "Luau checks are already on this computer." });
  });
});
