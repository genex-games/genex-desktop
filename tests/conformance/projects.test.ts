/**
 * Folders-as-projects: a game can live anywhere on disk, chats nest inside it, stills in
 * `references/` reach the model as pictures, and forgetting an external folder does not delete it.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { countImages } from "../helpers/fake-ollama.ts";
import { slugFromName, tildePath } from "../../src/substrate/game-workspace.ts";
import { ProjectStarter } from "../../src/shared/project-facts.ts";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("project folders", () => {
  it("slugFromName and tildePath are what the sidebar shows", () => {
    assert.equal(slugFromName("My Cool Game"), "my-cool-game");
    assert.equal(tildePath("/Users/simeon/coding/rift", "/Users/simeon"), "~/coding/rift");
  });

  it("adopts a folder anywhere, keeps the user's stills, and its web starter brings the missing game files", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-project-"), "mood-board");
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "references"), { recursive: true });
    await writeFile(path.join(dir, "references", "mood.png"), PNG_1x1);
    await writeFile(path.join(dir, "notes-from-me.txt"), "rainy neon streets");

    const project = await rig.core.adoptProject(dir);
    assert.equal(project.library, false);
    assert.match(project.pathLabel, /mood-board/);
    assert.equal(project.dir, await realpath(dir));
    // A folder of notes and stills starts with no kind; its web starter is written once picked.
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8").catch(() => null), null);
    await rig.core.games.start(project.name, ProjectStarter.Web);
    assert.ok(await readFile(path.join(dir, "index.html"), "utf8"));
    // The assets door (AG-930): a scaffolded or adopted game gets the folder, the loader and the git attributes.
    assert.match(await readFile(path.join(dir, "assets", "README.md"), "utf8"), /studio's own tools/);
    assert.match(await readFile(path.join(dir, ".gitattributes"), "utf8"), /\*\.glb binary/);
    assert.match(await readFile(path.join(dir, "src", "assets.js"), "utf8"), /export async function loadAsset/);
    assert.match(await readFile(path.join(dir, "docs", "CONTRACT.md"), "utf8"), /## Assets/);
    assert.equal(await readFile(path.join(dir, "notes-from-me.txt"), "utf8"), "rainy neon streets");
    assert.ok((await rig.core.games.list()).some((g) => g.name === project.name));
    assert.ok((await rig.core.games.recents()).some((g) => g.name === project.name));
  });

  it("a game reuses its conversation instead of creating additional chats", async () => {
    const rig = await startRig({ replies: [{ text: "On it." }] });
    rigs.push(rig);
    await rig.core.games.scaffold("arena", { title: "arena" });
    // Static tripwire: the scaffold must ship a game that runs on load. `running = false` means
    // a frozen screen until someone calls start() — and nobody in the pipeline does.
    assert.match(
      await readFile(path.join(rig.core.games.dirFor("arena"), "src", "studio.js"), "utf8"),
      // Anchored to the declaration — start() always contains a bare `running = true`.
      /let\s+running\s*=\s*true/,
    );
    const first = await rig.core.threadForGame("arena");
    await rig.core.sendUserMessage("add a dash", { thread: first });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "first chat");

    const second = await rig.core.createGameThread("arena");
    assert.equal(second, first);
    assert.equal(await rig.core.threadForGame("arena"), second, "the folder keeps its canonical chat");
    const firstRecord = await rig.core.store.getRecord(first);
    assert.equal((firstRecord.metadata as { project?: string }).project, "arena");
    assert.equal((firstRecord.metadata as { archived?: boolean }).archived, undefined);
  });

  it("forgetting an external folder leaves the files on disk", async () => {
    const rig = await startRig({ replies: [] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-project-keep-"), "keep-me");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "precious.txt"), "do not delete");
    const project = await rig.core.adoptProject(dir);
    const forgotten = await rig.core.archiveGame(project.name);
    assert.equal(forgotten.trash, false);
    assert.equal(await readFile(path.join(dir, "precious.txt"), "utf8"), "do not delete");
    assert.ok(!(await rig.core.games.list()).some((g) => g.name === project.name));
  });

  it("read_file of a still puts pixels on the next model round", async () => {
    const rig = await startRig({
      replies: [
        {
          toolCalls: [{ id: "c1", name: "read_file", arguments: { project: "refs", file: "references/mood.png" } }],
          text: "Looking.",
        },
        { text: "Rainy neon. Got it." },
      ],
    });
    rigs.push(rig);
    await rig.core.games.scaffold("refs", { title: "refs" });
    await writeFile(path.join(rig.core.games.dirFor("refs"), "references", "mood.png"), PNG_1x1);
    const threadId = await rig.core.threadForGame("refs");
    await rig.core.sendUserMessage("look at the reference still", { thread: threadId });
    const events = await waitForLog(
      rig.core,
      (log) => log.some((e) => e.data.type === "turn_ended"),
      30_000,
      "turn_ended",
    );

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(completions.length >= 2);
    const second = completions[1]!.body as { messages: Array<{ role: string; content?: unknown }> };
    assert.ok(countImages(second.messages) >= 1, "the model must receive the PNG, not a file path");

    const result = events.find((e) => e.data.type === "tool_result")?.data as {
      result: { content: string; details?: { data?: string } };
    };
    assert.match(result.result.content, /Attached|picture/i);
    assert.ok(!JSON.stringify(result.result).includes(PNG_1x1.toString("base64")), "pixels stay out of the log");

    const first = completions[0]!.body as { messages: Array<{ role: string; content?: unknown }> };
    const system = String(first.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /references\/mood\.png/);
    assert.match(system, /This project's folder/);
  });

  it("a first message that names an existing folder works in that folder, not a new library copy", async () => {
    const rig = await startRig({ replies: [{ text: "I'll work in this folder." }] });
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-named-ws-"), "blame-megastructure-game");
    await mkdir(path.join(dir, "ref"), { recursive: true });
    await writeFile(path.join(dir, "ref", "main.png"), PNG_1x1);

    const threadId = await rig.core.createGameThread();
    await rig.core.sendUserMessage(`make a megastructure. refs in ${dir}/ref`, { thread: threadId });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const record = await rig.core.store.getRecord(threadId);
    const project = (record.metadata as { project?: string }).project;
    assert.ok(project);
    assert.equal(await realpath(rig.core.games.dirFor(project!)), await realpath(dir));
    assert.ok(!(await rig.core.games.list()).some((g) => g.library && g.name !== project));
  });

  it("named stills outside the project are readable without copying, and read_file defaults to this chat's folder", async () => {
    const outside = path.join(await tmpDir("studio-stills-out-"), "ref");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "main.png"), PNG_1x1);

    const rig = await startRig({
      replies: [
        {
          toolCalls: [{ id: "c1", name: "read_file", arguments: { file: path.join(outside, "main.png") } }],
          text: "Looking.",
        },
        { text: "Grey concrete. Got it." },
      ],
    });
    rigs.push(rig);
    await rig.core.games.scaffold("inside", { title: "inside" });
    const threadId = await rig.core.threadForGame("inside");
    await rig.core.sendUserMessage(`keep going. stills are in ${outside}`, { thread: threadId });
    await waitForLog(rig.core, (log) => log.some((e) => e.data.type === "turn_ended"), 30_000, "turn_ended");

    const completions = rig.server.requests.filter((r) => r.path.startsWith("/v1/chat/completions"));
    assert.ok(completions.length >= 2);
    const first = completions[0]!.body as { messages: Array<{ role: string; content?: unknown }> };
    const system = String(first.messages.find((m) => m.role === "system")?.content ?? "");
    assert.match(system, /You are working in /);
    assert.match(system, /do not copy/i);
    const second = completions[1]!.body as { messages: Array<{ role: string; content?: unknown }> };
    assert.ok(countImages(second.messages) >= 1, "the named still must arrive as pixels");
  });
});
