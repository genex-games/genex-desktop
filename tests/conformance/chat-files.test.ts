import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ChatFileLink,
  type ChatFileLookup,
  type ChatFileRef,
  fileMentions,
  wholeFileName,
} from "../../src/shared/chat-files.ts";
import {
  ChatFileResolver,
  type ChatFileScope,
  chatFileName,
  credentialRoots,
  openModeFor,
} from "../../src/main/chat-files.ts";
import { fileLinkTitle, linkifyHtml } from "../../src/renderer/ui/file-links.ts";
import { markdownHtml } from "../../src/renderer/ui/markdown-html.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const names = (text: string) => fileMentions(text).map((mention) => mention.name);

test("a chat names files the way people and agents write them", () => {
  assert.deepEqual(names("I updated src/game.js and assets/video/intro.mp4."), [
    "src/game.js",
    "assets/video/intro.mp4",
  ]);
  assert.deepEqual(names("Saved to ~/AI Games/rift/src/main.js, then ran it."), ["~/AI Games/rift/src/main.js"]);
  assert.deepEqual(names("Open /Users/me/AI Games/rift/docs/DESIGN.md: it lists everything"), [
    "/Users/me/AI Games/rift/docs/DESIGN.md",
  ]);
  assert.deepEqual(names("See ./docs/DESIGN.md and ../shared/a.ts:42 (and .github/workflows/ci.yml)"), [
    "./docs/DESIGN.md",
    "../shared/a.ts:42",
    ".github/workflows/ci.yml",
  ]);
  assert.deepEqual(names('file:///Users/me/AI%20Games/a.md and "quoted/path.txt"'), [
    "file:///Users/me/AI%20Games/a.md",
    "quoted/path.txt",
  ]);
  assert.deepEqual(names("cat src/a.js | grep foo; node scripts/build.mjs --out=/tmp/out.png"), [
    "src/a.js",
    "scripts/build.mjs",
    "/tmp/out.png",
  ]);
  // Bare names are asked about (main looks for them in the game); these never are.
  assert.deepEqual(names("Uses Node.js, e.g. v1.2.3, see https://example.com/a.md and me@example.com"), ["Node.js"]);
  assert.deepEqual(names("</div> a / b and/or /usr @react-three/fiber @genex/job/out.png"), []);
  assert.deepEqual(names("package.json changed"), ["package.json"]);
});

test("comments, the next sentence and the next argument are not part of a path", () => {
  assert.deepEqual(names("let a = 1; // one"), []);
  assert.deepEqual(names("x = y // 2"), []);
  assert.deepEqual(names("x // see src/a.js"), ["src/a.js"]);
  assert.deepEqual(names("Wrote /tmp/shot.png. See docs/DESIGN.md for more."), ["/tmp/shot.png", "docs/DESIGN.md"]);
  assert.deepEqual(names("Saved /Users/me/AI Games/rift/index.html. Also Assets/hero.png changed."), [
    "/Users/me/AI Games/rift/index.html",
    "Assets/hero.png",
  ]);
  assert.deepEqual(names("cp /tmp/out src/a.js"), ["/tmp/out", "src/a.js"]);
  assert.deepEqual(names("~/Library/Application Support/AI Game Studio/runs/x.png"), [
    "~/Library/Application Support/AI Game Studio/runs/x.png",
  ]);
  // The tail of a spaced name is not a file of its own.
  assert.deepEqual(names("Updated assets/Hero Sprite.png now"), []);
  assert.deepEqual(names("src/game.ts package.json"), ["src/game.ts", "package.json"]);
  assert.equal(wholeFileName("//"), null);
});

test("names in any script and between any quotes are names", () => {
  assert.deepEqual(names("Файл «src/game.js» обновлён"), ["src/game.js"]);
  assert.deepEqual(names("Updated “src/game.js” today; see src/a.js—the main loop"), ["src/game.js", "src/a.js"]);
  assert.deepEqual(names("Обновил assets/герой.png и docs/ПЛАН.md"), ["assets/герой.png", "docs/ПЛАН.md"]);
  assert.deepEqual(names("Сохранил в ~/AI Games/Моя игра/index.html"), ["~/AI Games/Моя игра/index.html"]);
  assert.deepEqual(names("и т.д. и т.п."), []);
});

test("finding names stays fast on text built to be slow", () => {
  const started = performance.now();
  for (const text of [
    "a.".repeat(40_000),
    `/A${" Bb".repeat(16_000)}/x.js`,
    "ab/".repeat(30_000),
    ` /a${" B".repeat(20_000)}`,
    `${"x".repeat(90_000)}.js`,
  ])
    fileMentions(text);
  assert.ok(performance.now() - started < 1_000, `took ${Math.round(performance.now() - started)}ms`);
});

test("inline code is a file chip only when the whole of it is one name", () => {
  for (const code of ["docs/DESIGN.md", "~/AI Games/rift/a.js", "index.html", "src/game.ts:42", "/tmp/out.mp4"])
    assert.equal(wholeFileName(code), code);
  for (const code of ["npm run dev", "node scripts/build.mjs", "@react-three/fiber", "three", "a\nb.md"])
    assert.equal(wholeFileName(code), null, code);
});

test("the hover text says what a click does and where the file is, in the platform's words", () => {
  assert.equal(
    fileLinkTitle({ open: "beside", path: "docs/DESIGN.md" }, "docs/DESIGN.md", "darwin"),
    "Opens beside the chat",
  );
  assert.equal(
    fileLinkTitle({ open: "app", path: "~/AI Games/rift/src/game.js" }, "src/game.js", "darwin"),
    "Opens in its default app\n~/AI Games/rift/src/game.js",
  );
  assert.equal(
    fileLinkTitle({ open: "finder", path: "tools/run.command", build: true }, "tools/run.command", "darwin"),
    "Shows in Finder\nIn the build · not in your game folder yet",
  );
  assert.equal(
    fileLinkTitle({ open: "folder", path: "~/AI Games/rift" }, "~/AI Games/rift", "darwin"),
    "Opens in Finder",
  );
  assert.equal(fileLinkTitle({ open: "finder", path: "a.bat" }, "a.bat", "win32"), "Shows in Explorer");
  assert.equal(fileLinkTitle({ open: "folder", path: "x" }, "x", ""), "Opens in Finder", "macOS words until main says");
});

const known = new Map<string, ChatFileLink | null>([
  ["src/game.js", { open: "app", path: "~/AI Games/rift/src/game.js" }],
  ["docs/DESIGN.md", { open: "beside", path: "docs/DESIGN.md" }],
  ["scripts/build.mjs", { open: "app", path: "~/AI Games/rift/scripts/build.mjs" }],
  ["Node.js", null],
]);
const lookup: ChatFileLookup = (name) => known.get(name);

test("rendered text links only the names main confirmed, and leaves everything else as it was", () => {
  const asked: ChatFileRef[] = [];
  const html =
    '<p>Edited src/game.js &amp; intro.mp4, like Node.js.</p><pre><code><span class="hljs-built_in">node</span> scripts/build.mjs</code></pre><a href="https://x.dev/src/game.js">src/game.js</a>';
  const out = linkifyHtml(html, lookup, asked);
  assert.match(
    out,
    /<p>Edited <button type="button" class="prose-file" data-file-path="src\/game.js" data-file-open="app" data-file-target="~\/AI Games\/rift\/src\/game.js" title="Opens in its default app\n~\/AI Games\/rift\/src\/game.js">/,
  );
  assert.match(out, /&amp; intro.mp4, like Node.js.<\/p>/, "unknown and missing names stay text, escaped once");
  assert.match(
    out,
    /<\/span> <button type="button" class="file-link" data-file-path="scripts\/build.mjs"[^>]*>scripts\/build.mjs<\/button><\/code><\/pre>/,
    "code keeps its own look",
  );
  assert.match(out, /<a href="https:\/\/x.dev\/src\/game.js">src\/game.js<\/a>$/, "a link keeps its words");
  assert.deepEqual(
    [...new Set(asked.map((ref) => ref.name))],
    ["src/game.js", "intro.mp4", "Node.js", "scripts/build.mjs"],
  );
  const plain = "<p>Nothing to see &amp; here, 1 &lt; 2.</p>";
  assert.equal(linkifyHtml(plain, lookup, []), plain, "text without files is returned byte for byte");
});

test("Markdown links a document’s relative links from its own folder", () => {
  const asked: ChatFileRef[] = [];
  const answers: ChatFileLookup = (name, base) =>
    name === "NOTES.md" && base === "docs/DESIGN.md" ? { open: "beside", path: "docs/NOTES.md" } : undefined;
  const html = markdownHtml("See [the notes](NOTES.md) and `src/missing.js`.", {
    files: { lookup: answers, base: "docs/DESIGN.md", names: asked },
  });
  assert.match(
    html,
    /data-file-path="NOTES.md" data-file-base="docs\/DESIGN.md" data-file-open="beside" data-file-target="docs\/NOTES.md"/,
  );
  assert.match(html, /<code>src\/missing.js<\/code>/, "a name main has not answered yet is still code");
  const web = markdownHtml("[`src/a.js`](https://github.com/o/r/blob/main/src/a.js)", {
    files: { lookup: () => ({ open: "app", path: "~/g/src/a.js" }), names: [] },
  });
  assert.equal(
    web.trim(),
    '<p><a href="https://github.com/o/r/blob/main/src/a.js"><code>src/a.js</code></a></p>',
    "code in a web link is the link’s words",
  );
  assert.ok(asked.some((ref) => ref.name === "NOTES.md" && ref.base === "docs/DESIGN.md"));
  assert.ok(asked.some((ref) => ref.name === "src/missing.js" && !ref.base));
});

test("rendered Markdown is reused only while main's answers about its names hold, and still reports them", () => {
  const known = new Map<string, ChatFileLink | undefined>();
  const lookup: ChatFileLookup = (name) => known.get(name);
  const text = "Read `docs/CACHE-NOTES.md` first.";
  for (const streaming of [false, true]) {
    known.clear();
    const first: ChatFileRef[] = [];
    const before = markdownHtml(text, { files: { lookup, names: first }, streaming });
    assert.doesNotMatch(before, /prose-file/);
    const again: ChatFileRef[] = [];
    assert.equal(markdownHtml(text, { files: { lookup, names: again }, streaming }), before);
    assert.deepEqual(again, first, "a reused rendering still names its files");
    known.set("docs/CACHE-NOTES.md", { open: "beside", path: "docs/CACHE-NOTES.md" });
    const linked = markdownHtml(text, { files: { lookup, names: [] }, streaming });
    assert.match(linked, /data-file-path="docs\/CACHE-NOTES.md"/, "a new answer renders the text again");
    assert.doesNotMatch(markdownHtml(text, { streaming }), /prose-file/, "without a chat nothing is a file");
  }
});

test("documents open in their app; programs, scripts and unknown types are only shown", () => {
  for (const file of [
    "a.js",
    "intro.mp4",
    "notes.md",
    "hero.PNG",
    "song.wav",
    "ship.glb",
    "index.html",
    "font.woff2",
    "report.pdf",
  ])
    assert.equal(openModeFor(`/x/${file}`, "file", "darwin"), "app", file);
  for (const file of [
    "run.command",
    "setup.sh",
    "tool.py",
    "Installer.pkg",
    "disk.dmg",
    "Profile.mobileconfig",
    "site.webloc",
    "app.jar",
    "binary",
    ".env",
    "archive.zip",
    "weird.xyz",
    "run.bat",
    "run.ps1",
    "setup.exe",
  ])
    assert.equal(openModeFor(`/x/${file}`, "file", "darwin"), "finder", file);
  // Windows Script Host runs a .js file it is asked to open.
  for (const file of ["a.js", "a.mjs", "a.cjs"])
    assert.equal(openModeFor(`C:\\x\\${file}`, "file", "win32"), "finder", file);
  assert.equal(openModeFor("C:\\x\\notes.md", "file", "win32"), "app");
  assert.equal(openModeFor("/x/assets", "directory"), "folder");
  assert.equal(openModeFor("/x/Calculator.app", "directory"), "finder");
  assert.equal(openModeFor("/x/Pitch.key", "directory"), "app");
});

test("a name is read the way the chat wrote it, and clipped names are not files", () => {
  assert.equal(chatFileName("src/game.ts:42:7"), "src/game.ts");
  assert.equal(chatFileName("src/game.ts#L12-L20"), "src/game.ts");
  assert.equal(chatFileName("file:///Users/me/AI%20Games/a.md"), "/Users/me/AI Games/a.md");
  assert.equal(chatFileName("`docs/DESIGN.md`"), "docs/DESIGN.md");
  for (const name of ["https://example.com/a.md", "src/very/long… [12 more chars]", "a\u0000b", "", 42])
    assert.equal(chatFileName(name), null, String(name));
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "chat-files-")));
  const home = path.join(root, "home");
  const game = path.join(home, "AI Games", "rift");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", game, ...args], { env })
      .toString()
      .trim();
  for (const dir of ["docs", "src", "assets/video", "assets/sfx", "tools"])
    mkdirSync(path.join(game, dir), { recursive: true });
  writeFileSync(path.join(game, "docs", "DESIGN.md"), "# Plan");
  writeFileSync(path.join(game, "docs", "NOTES.md"), "# Notes");
  writeFileSync(path.join(game, "src", "game.js"), "old");
  writeFileSync(path.join(game, "src", "same.js"), "same");
  writeFileSync(path.join(game, "assets", "video", "intro.mp4"), "video");
  writeFileSync(path.join(game, "assets", "sfx", "hit.wav"), "a");
  writeFileSync(path.join(game, "assets", "video", "hit.wav"), "b");
  writeFileSync(path.join(game, "tools", "run.command"), "#!/bin/sh\necho hi");
  chmodSync(path.join(game, "tools", "run.command"), 0o755);
  // A document with an exec bit is only shown, like the links the window routes.
  writeFileSync(path.join(game, "docs", "tool.txt"), "#!/bin/sh\necho hi");
  chmodSync(path.join(game, "docs", "tool.txt"), 0o755);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "game");
  // The run's build: a newer game.js, a file only the build has, and same.js unchanged.
  writeFileSync(path.join(game, "src", "game.js"), "new");
  writeFileSync(path.join(game, "src", "enemy.js"), "enemy");
  writeFileSync(path.join(game, "docs", "BUILD.md"), "# Build");
  git("add", "-A");
  git("commit", "-qm", "build");
  const head = git("rev-parse", "HEAD");
  git("reset", "-q", "--hard", "HEAD~1");

  const outside = path.join(home, "Movies", "trailer.mov");
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, "movie");
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  writeFileSync(path.join(home, ".ssh", "id_rsa"), "secret");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"secret"}');
  symlinkSync(path.join(game, ".git"), path.join(game, "gitlink"));
  symlinkSync(path.join(home, ".ssh", "id_rsa"), path.join(game, "key.txt"));
  symlinkSync(path.join(game, "tools", "run.command"), path.join(game, "readme.md"));
  mkdirSync(path.join(home, "Tools", "Thing.app", "Contents"), { recursive: true });
  const worktree = path.join(root, "scratch", "autopilot", "run-1", "integration");
  mkdirSync(path.join(worktree, "docs"), { recursive: true });
  writeFileSync(path.join(worktree, "docs", "DESIGN.md"), "# Plan (worktree)");
  const workspace = path.join(root, "harness");
  mkdirSync(path.join(workspace, "skills"), { recursive: true });
  writeFileSync(path.join(workspace, "skills", "play.md"), "# Skill");

  const scope = (over: Partial<ChatFileScope> = {}): ChatFileScope => ({
    home,
    game: { dir: game, head, preferBuild: true, runId: "run-1" },
    workspace: null,
    deny: credentialRoots(home, {}),
    worktrees: path.join(root, "scratch", "autopilot"),
    copies: path.join(root, "opened-files"),
    ...over,
  });
  return { root, home, game, head, outside, worktree, workspace, scope };
}

test("resolving and opening build files never executes repository content filters", async () => {
  const f = fixture();
  const marker = path.join(f.root, "RAN");
  const command = `touch '${marker}'; cat`;
  for (const operation of ["clean", "smudge"])
    execFileSync("git", ["-C", f.game, "config", `filter.hostile.${operation}`, command]);
  writeFileSync(path.join(f.game, ".gitattributes"), "src/* filter=hostile\n");
  const resolver = new ChatFileResolver();
  await resolver.resolve(f.scope(), [{ name: "src/game.js" }]);
  const opened = await resolver.target(f.scope(), { name: "src/enemy.js" });
  assert.equal(readFileSync(opened.target, "utf8"), "enemy");
  assert.equal(existsSync(marker), false);
});

test("a game chat links its own files, newer build files and files anywhere on this computer", {
  skip: process.platform === "win32" && "symbolic links and exec bits are POSIX",
}, async () => {
  const { game, outside, worktree, scope } = fixture();
  const chat = new ChatFileResolver();
  const resolve = async (name: string, base?: string, over?: Partial<ChatFileScope>) =>
    (await chat.resolve(scope(over), [base ? { name, base } : { name }]))[0];

  assert.deepEqual(await resolve("docs/DESIGN.md"), { open: "beside", path: "docs/DESIGN.md" });
  assert.deepEqual(
    await resolve("NOTES.md", "docs/DESIGN.md"),
    { open: "beside", path: "docs/NOTES.md" },
    "a document’s link is relative to it",
  );
  assert.deepEqual(await resolve("docs/BUILD.md"), { open: "beside", path: "docs/BUILD.md", build: true });
  assert.deepEqual(
    await resolve("src/game.js:3"),
    { open: "app", path: "src/game.js", build: true },
    "the build’s newer copy",
  );
  assert.deepEqual(
    await resolve("src/game.js", undefined, { game: { dir: game, head: null, preferBuild: false, runId: null } }),
    { open: "app", path: "~/AI Games/rift/src/game.js" },
  );
  assert.deepEqual(
    await resolve("src/same.js"),
    { open: "app", path: "~/AI Games/rift/src/same.js" },
    "unchanged in the build: the folder’s file",
  );
  assert.deepEqual(await resolve("src/enemy.js"), { open: "app", path: "src/enemy.js", build: true });
  assert.deepEqual(
    await resolve("intro.mp4"),
    { open: "app", path: "~/AI Games/rift/assets/video/intro.mp4" },
    "the one file with that name",
  );
  assert.deepEqual(await resolve("video/hit.wav"), { open: "app", path: "~/AI Games/rift/assets/video/hit.wav" });
  assert.equal(await resolve("hit.wav"), null, "two files share the name: neither is guessed");
  assert.deepEqual(await resolve("tools/run.command"), { open: "finder", path: "~/AI Games/rift/tools/run.command" });
  assert.deepEqual(await resolve("docs/tool.txt"), { open: "finder", path: "~/AI Games/rift/docs/tool.txt" });
  assert.deepEqual(
    await resolve("readme.md"),
    { open: "finder", path: "~/AI Games/rift/tools/run.command" },
    "a link is judged by what it points at",
  );
  assert.deepEqual(await resolve(`${game}/assets`), { open: "folder", path: "~/AI Games/rift/assets" });
  assert.deepEqual(await resolve("~/Movies/trailer.mov"), {
    open: "app",
    path: path.join("~", "Movies", "trailer.mov"),
  });
  assert.deepEqual(await resolve(`file://${encodeURI(outside)}`), {
    open: "app",
    path: path.join("~", "Movies", "trailer.mov"),
  });
  assert.deepEqual(await resolve("~/Tools/Thing.app"), { open: "finder", path: "~/Tools/Thing.app" });
  assert.deepEqual(
    await resolve(path.join(worktree, "docs", "DESIGN.md")),
    { open: "beside", path: "docs/DESIGN.md" },
    "the run’s worktree copy of a game document",
  );
  for (const name of [
    "key.txt",
    "~/.ssh/id_rsa",
    "~/.codex/auth.json",
    "../secret.md",
    ".git/config",
    ".GIT/config",
    "gitlink/config",
    `${game}/.git/config`,
    "docs/../../x.md",
    "Node.js",
    "src/missing.js",
    "https://example.com/a.md",
    "src/a… [9 more chars]",
    "//",
    "/",
  ]) {
    assert.equal(await resolve(name), null, name);
  }
});

test("Studio and a chat without a game resolve only what they can reach", async () => {
  const { workspace, scope } = fixture();
  const chat = new ChatFileResolver();
  const studio = scope({ game: null, workspace });
  assert.deepEqual(
    (await chat.resolve(studio, [{ name: "skills/play.md" }]))[0],
    { open: "app", path: path.join(workspace, "skills", "play.md") },
    "nothing opens beside Studio",
  );
  assert.deepEqual((await chat.resolve(studio, [{ name: "../x.md" }]))[0], null);
  const draft = scope({ game: null });
  assert.deepEqual(await chat.resolve(draft, [{ name: "docs/DESIGN.md" }, { name: "~/Movies/trailer.mov" }]), [
    null,
    { open: "app", path: path.join("~", "Movies", "trailer.mov") },
  ]);
});

test("opening re-resolves the name; a build-only file opens as a read-only copy", {
  skip: process.platform === "win32" && "exec bits and read-only modes are POSIX",
}, async () => {
  const { game, root, scope } = fixture();
  const chat = new ChatFileResolver();
  assert.deepEqual(await chat.target(scope(), { name: "assets/video/intro.mp4" }), {
    open: "app",
    target: path.join(game, "assets", "video", "intro.mp4"),
  });
  assert.deepEqual(await chat.target(scope(), { name: "tools/run.command" }), {
    open: "finder",
    target: path.join(game, "tools", "run.command"),
  });
  const copy = await chat.target(scope(), { name: "src/enemy.js" });
  assert.equal(copy.open, "app");
  assert.equal(path.basename(copy.target), "enemy.js");
  assert.ok(copy.target.startsWith(path.join(root, "opened-files")), "the copy is where the scope keeps copies");
  assert.equal(readFileSync(copy.target, "utf8"), "enemy");
  assert.equal(statSync(copy.target).mode & 0o222, 0, "the copy cannot be edited by mistake");
  assert.equal(
    (await chat.target(scope(), { name: "src/enemy.js" })).target,
    copy.target,
    "opened again, the same copy",
  );
  assert.equal(readFileSync((await chat.target(scope(), { name: "src/game.js" })).target, "utf8"), "new");
  await assert.rejects(chat.target(scope(), { name: "~/.ssh/id_rsa" }), /isn’t on this computer/);
});

test("a chat asks the core about the files it names; the studio's secrets never link", async () => {
  const { core, gamesRoot } = await coreLite({ gamesRoot: realpathSync.native(await tmpDir("chat-files-core-")) });
  const game = await core.games.scaffold("rift", { title: "Rift" });
  const threadId = await core.threadForGame("rift");
  mkdirSync(path.join(game.dir, "docs"), { recursive: true });
  writeFileSync(path.join(game.dir, "docs", "DESIGN.md"), "# Plan");
  writeFileSync(path.join(gamesRoot, "outside.md"), "elsewhere");
  const secret = path.join(core.layout.secrets, "token.txt");
  mkdirSync(path.dirname(secret), { recursive: true });
  writeFileSync(secret, "secret");

  const [plan, outside, stored, missing] = await core.resolveChatFiles(threadId, [
    { name: "docs/DESIGN.md" },
    { name: path.join(gamesRoot, "outside.md") },
    { name: secret },
    { name: "docs/MISSING.md" },
  ]);
  assert.deepEqual(plan, { open: "beside", path: "docs/DESIGN.md" });
  assert.equal(outside?.open, "app", "an absolute path anywhere but credentials links");
  assert.equal(stored, null, "the studio's own secrets never link");
  assert.equal(missing, null);
  assert.deepEqual(
    await core.resolveChatFiles(threadId, [{ name: 42 }, null]),
    [null, null],
    "a malformed name is not a file",
  );
  await assert.rejects(core.resolveChatFiles(threadId, "docs/DESIGN.md"), /File names are required/);
  await assert.rejects(core.resolveChatFiles("no-such-thread", []), /no longer here/);
  assert.deepEqual(await core.chatFileTarget(threadId, { name: "docs/DESIGN.md" }), {
    open: "app",
    target: path.join(realpathSync.native(game.dir), "docs", "DESIGN.md"),
  });
  await assert.rejects(core.chatFileTarget(threadId, { name: secret }), /isn’t on this computer/);
});

test("a Claude Code tool names its file in the row's chip", () => {
  const envelope = (id: number, data: EventData): EventEnvelope => ({
    id: String(id).padStart(6, "0"),
    thread_id: "game",
    turn_id: "turn",
    session_id: null,
    created_at: new Date().toISOString(),
    data,
  });
  const entries = toEntries([
    envelope(1, {
      type: "tool_requested",
      tool_call_id: "t1",
      request: { name: "Read", arguments: { file_path: "src/a.js" } },
    }),
    envelope(2, { type: "tool_result", tool_call_id: "t1", result: { ok: true, content: "…" } }),
  ]);
  const rows = entries.flatMap((entry) => (entry.kind === "tools" ? entry.rows : []));
  assert.equal(rows[0]?.chip, "src/a.js");
});
