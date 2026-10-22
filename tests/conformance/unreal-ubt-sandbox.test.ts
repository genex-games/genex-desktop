/**
 * check-part compiles C++ a builder wrote, so UnrealBuildTool runs in a macOS sandbox
 * (`ubt-sandbox.ts`): nothing in the user's home folder is read but the copy, the engine, Xcode and
 * UnrealBuildTool's own folders; only the copy's build output, UnrealBuildTool's log folder and a
 * private scratch folder are written; a credential home is never touched wherever it lives; there
 * is no network and no inherited environment. These run real `sandbox-exec` against a stand-in
 * home folder in a temp directory, never the user's own.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { type BuildSandbox, buildSandboxProfile, prepareBuildSandbox } from "../../src/plugins/unreal/ubt-sandbox.ts";
import { systemRunCommand } from "../../src/plugins/unreal/ubt.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SKIP = process.platform === "darwin" ? false : "the build sandbox is macOS's sandbox-exec";
/** What each stand-in secret holds: never in a sandboxed command's output. */
const MARK = "GENEX-STAND-IN-SECRET";

type World = {
  root: string;
  home: string;
  unreal: string;
  engine: string;
  moved: string;
  sandbox: BuildSandbox & { dispose(): Promise<void> };
};

/** A home folder with a copy of a game in it, an engine beside it, stand-in secrets and a moved credential home. */
async function makeWorld(): Promise<World> {
  const root = await realpath(await tmpDir("studio-ubt-sandbox-"));
  const home = path.join(root, "home");
  const unreal = path.join(home, "AI Games", "rush-copy", "unreal");
  const engine = path.join(root, "engine");
  const moved = path.join(root, "moved-claude-home");
  const ubtLog = path.join(home, "Library", "Application Support", "Epic", "UnrealBuildTool");
  for (const dir of [path.join(unreal, "Source"), path.join(unreal, "Intermediate"), engine, moved, ubtLog])
    await mkdir(dir, { recursive: true });
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh", "id_stand_in"), `${MARK}-ssh`);
  await writeFile(path.join(home, "notes.txt"), `${MARK}-notes`);
  await writeFile(path.join(moved, "token"), `${MARK}-moved`);
  await writeFile(path.join(unreal, "Rush.uproject"), "{}");
  await writeFile(path.join(unreal, "Source", "Bike.cpp"), "// the part's code\n");
  await writeFile(path.join(engine, "Engine.h"), "// the engine\n");
  await writeFile(path.join(ubtLog, "BuildConfiguration.xml"), "<Configuration/>");
  await symlink(path.join(home, "notes.txt"), path.join(unreal, "Source", "Leak.h"));
  await symlink(home, path.join(unreal, "Intermediate", "out"));
  const sandbox = await prepareBuildSandbox({
    projectDir: unreal,
    engineDir: engine,
    xcodeApp: null,
    home,
    denied: [moved],
  });
  return { root, home, unreal, engine, moved, sandbox };
}

/** Runs a shell script in the sandbox; its exit code and output. */
async function confined(sandbox: BuildSandbox, script: string) {
  return systemRunCommand("/bin/sh", ["-c", script], { signal: new AbortController().signal, sandbox });
}

describe("UnrealBuildTool's sandbox", { skip: SKIP }, () => {
  let world: World;
  before(async () => {
    world = await makeWorld();
  });
  after(async () => {
    await world?.sandbox.dispose();
  });

  it("reads the copy, the engine and UnrealBuildTool's own folder, and writes the copy's build output", async () => {
    const { unreal, engine, home } = world;
    const ubtLog = path.join(home, "Library", "Application Support", "Epic", "UnrealBuildTool");
    const script = [
      `cat "${path.join(unreal, "Source", "Bike.cpp")}"`,
      `cat "${path.join(engine, "Engine.h")}"`,
      `cat "${path.join(ubtLog, "BuildConfiguration.xml")}"`,
      `echo built > "${path.join(unreal, "Intermediate", "Bike.o")}"`,
      `mkdir -p "${path.join(unreal, "Binaries", "Mac")}"`,
      `echo log > "${path.join(ubtLog, "Log.txt")}"`,
      'echo scratch > "$TMPDIR/scratch.txt"',
    ].join(" && ");
    const outcome = await confined(world.sandbox, script);
    assert.equal(outcome.code, 0, outcome.output);
    assert.match(outcome.output, /the part's code/);
    assert.match(outcome.output, /the engine/);
    assert.equal(await readFile(path.join(unreal, "Intermediate", "Bike.o"), "utf8"), "built\n");
    assert.ok(existsSync(path.join(unreal, "Binaries", "Mac")));
  });

  it("never reads a file it wasn't given, by its path or through a link in the copy", async () => {
    const { home, unreal, moved } = world;
    const rows: Array<[string, string]> = [
      ["a file elsewhere in the home folder", path.join(home, "notes.txt")],
      ["a credential folder in the home folder", path.join(home, ".ssh", "id_stand_in")],
      ["a credential home moved outside the home folder", path.join(moved, "token")],
      ["a link in the copy's Source to a home file", path.join(unreal, "Source", "Leak.h")],
      ["a home file through a link in the copy's build output", path.join(unreal, "Intermediate", "out", "notes.txt")],
    ];
    for (const [label, file] of rows) {
      const outcome = await confined(world.sandbox, `cat "${file}"`);
      assert.notEqual(outcome.code, 0, label);
      assert.ok(!outcome.output.includes(MARK), `${label}: ${outcome.output}`);
    }
  });

  it("never lists the home folder", async () => {
    const outcome = await confined(world.sandbox, `ls "${world.home}"`);
    assert.notEqual(outcome.code, 0);
    assert.ok(!outcome.output.includes("notes.txt"), outcome.output);
  });

  it("writes nothing outside the copy's build output, UnrealBuildTool's log folder and its scratch", async () => {
    const { home, unreal, engine, moved, root } = world;
    const rows: Array<[string, string]> = [
      ["the home folder", path.join(home, "planted.txt")],
      ["the copy's Source", path.join(unreal, "Source", "Planted.h")],
      ["the copy's .uproject", path.join(unreal, "Rush.uproject")],
      ["the copy's folder beside its build output", path.join(unreal, "Config.ini")],
      ["the engine", path.join(engine, "Planted.h")],
      ["a moved credential home", path.join(moved, "token")],
      ["the home folder through a link in the build output", path.join(unreal, "Intermediate", "out", "via-link.txt")],
      ["a folder beside the home folder", path.join(root, "planted.txt")],
    ];
    const before = await readFile(path.join(unreal, "Rush.uproject"), "utf8");
    for (const [label, file] of rows) {
      const outcome = await confined(world.sandbox, `echo planted > "${file}"`);
      assert.notEqual(outcome.code, 0, label);
    }
    for (const file of [
      path.join(home, "planted.txt"),
      path.join(unreal, "Source", "Planted.h"),
      path.join(unreal, "Config.ini"),
      path.join(engine, "Planted.h"),
      path.join(home, "via-link.txt"),
      path.join(root, "planted.txt"),
    ])
      assert.ok(!existsSync(file), `nothing at ${file}`);
    assert.equal(await readFile(path.join(unreal, "Rush.uproject"), "utf8"), before);
    assert.equal(await readFile(path.join(moved, "token"), "utf8"), `${MARK}-moved`);
  });

  it("has no network, not even this computer's own", async () => {
    const server = createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      const outcome = await confined(world.sandbox, `/usr/bin/nc -w 2 127.0.0.1 ${port} < /dev/null`);
      assert.ok(!outcome.output.includes("hello"), outcome.output);
    } finally {
      server.close();
    }
  });

  it("sends no Apple Event to another app, so a build can't script one or type into it", async () => {
    // Asking Finder for its scripting dictionary needs no Automation consent, so nothing is ever asked.
    const outcome = await confined(
      world.sandbox,
      `/usr/bin/osascript -e 'tell application "Finder" to «event ascrgdte» 0'`,
    );
    assert.notEqual(outcome.code, 0, outcome.output);
    assert.ok(!outcome.output.includes("«data aete"), outcome.output);
  });

  it("starts with only its own environment: a private HOME and TMPDIR, the system PATH and a language", async () => {
    const outcome = await confined(world.sandbox, "env");
    const names = outcome.output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")[0]);
    const shells = new Set(["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"]);
    assert.deepEqual(names.filter((name) => !shells.has(name ?? "")).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
    const home = /^HOME=(.*)$/m.exec(outcome.output)?.[1] ?? "";
    assert.ok(!home.startsWith(world.home), `HOME ${home} is the build's own`);
  });

  it("leaves nothing behind once disposed", async () => {
    const own = await makeWorld();
    const scratch = own.sandbox.cwd;
    assert.ok(existsSync(own.sandbox.profile));
    await own.sandbox.dispose();
    assert.ok(!existsSync(scratch));
  });
});

describe("the build sandbox's profile", () => {
  it("sends no Apple Events and reaches no service that acts outside the build", () => {
    const rules = buildSandboxProfile({ home: "/h", reads: [], writes: [], createOnly: [], denied: [] }).split("\n");
    assert.ok(rules.includes("(deny appleevent-send)"), "no Apple Event leaves the build (osascript, System Events)");
    const deniedMach = rules.find((rule) => rule.startsWith("(deny mach-lookup")) ?? "";
    for (const name of ["com.apple.coreservices.appleevents", "com.apple.lsd.open", "com.apple.pasteboard.1"])
      assert.ok(deniedMach.includes(`"${name}"`), `the build cannot reach ${name}`);
  });
});

describe("what the sandbox refuses to confine", () => {
  it("a project or engine folder that holds the home folder, writing nothing", async () => {
    const root = await realpath(await tmpDir("studio-ubt-sandbox-refused-"));
    const home = path.join(root, "home");
    await mkdir(path.join(home, "unreal"), { recursive: true });
    const rows: Array<[string, { projectDir: string; engineDir: string }]> = [
      ["the project is the home folder", { projectDir: home, engineDir: path.join(root, "engine") }],
      ["the project holds the home folder", { projectDir: root, engineDir: path.join(root, "engine") }],
      ["the engine is the home folder", { projectDir: path.join(home, "unreal"), engineDir: home }],
      ["the engine is the root folder", { projectDir: path.join(home, "unreal"), engineDir: "/" }],
      ["a relative project", { projectDir: "unreal", engineDir: path.join(root, "engine") }],
    ];
    for (const [label, paths] of rows)
      await assert.rejects(prepareBuildSandbox({ ...paths, xcodeApp: null, home, denied: [] }), label);
  });
});
