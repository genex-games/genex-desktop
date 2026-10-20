/**
 * A game's play-time AI in its public copy (`substrate/game-export.ts`, `GameWorkspaces.export`):
 * the code under `ai/` goes with the game it belongs to, as the AI starters lay it out, and a saved
 * playtest (`ai/tapes/`, recorded prompts, player text and answers) stays home unless the creator put
 * it in `ai/tapes/ship/` (§8 Privacy). Every hostile spelling of a tape path either stays out or
 * refuses the export before anything is written.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ProjectStarter } from "../../src/shared/project-facts.ts";
import { exportPublicGame } from "../../src/substrate/game-export.ts";
import { STARTERS, STARTERS_DIR, starterTape } from "../../scripts/ai-starters/starters.ts";
import { tapeFile } from "../../src/shared/game-ai-tape.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { makeResources } from "../helpers/resources.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const TAPE_LINE = '{"v":1,"key":"x","n":0,"site":"npc.reply","op":"ask","value":"the player said hi"}\n';

/** A game folder with an entry page, a module and `files` (relative path → text). */
async function gameWith(temp: string, folder: string, files: Record<string, string>): Promise<string> {
  const source = path.join(temp, folder);
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
  await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(source, rel)), { recursive: true });
    await writeFile(path.join(source, rel), text);
  }
  return source;
}

/** Every file under `dir`, `/`-joined and sorted; none when it is not there. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("saved playtests in a public copy", () => {
  it("leaves every tape outside ai/tapes/ship/ out, and ships the ones the creator put there", async () => {
    const temp = await tmpDir("studio-export-tapes-");
    try {
      const source = await gameWith(temp, "game", {
        "ai/schema.js": "export const Reply = {};",
        "ai/tapes/talk.jsonl": TAPE_LINE,
        "ai/tapes/sub/talk.jsonl": TAPE_LINE,
        "ai/tapes/ship/intro.jsonl": TAPE_LINE,
        "ai/tapes/shipped.jsonl": TAPE_LINE,
      });
      const target = path.join(temp, "public");
      const result = await exportPublicGame(source, target, ["index.html", "src", "ai"]);
      assert.deepEqual(result.included.sort(), [
        "ai/schema.js",
        "ai/tapes/ship/intro.jsonl",
        "index.html",
        "src/main.js",
      ]);
      // A folder of tapes is left out whole, and reported as the folder.
      for (const rel of ["ai/tapes/talk.jsonl", "ai/tapes/sub", "ai/tapes/shipped.jsonl"]) {
        assert.ok(result.excluded.includes(rel), `${rel} is reported left out`);
      }
      assert.deepEqual(await filesUnder(path.join(target, "ai")), ["schema.js", "tapes/ship/intro.jsonl"]);
    } finally {
      await removeTree(temp);
    }
  });

  const HOSTILE_ROOTS: Array<{ label: string; folder: string; files: Record<string, string>; roots: string[] }> = [
    {
      label: "a tape named as a root of its own",
      folder: "named",
      files: { "ai/tapes/talk.jsonl": TAPE_LINE },
      roots: ["index.html", "src", "ai/tapes/talk.jsonl"],
    },
    {
      label: "the tapes folder named as a root",
      folder: "folder",
      files: { "ai/tapes/talk.jsonl": TAPE_LINE },
      roots: ["index.html", "src", "ai/tapes"],
    },
    {
      label: "the folders spelled in capitals",
      folder: "capitals",
      files: { "AI/Tapes/talk.jsonl": TAPE_LINE },
      roots: ["index.html", "src", "AI"],
    },
    {
      label: "a Windows separator",
      folder: "backslash",
      files: { "ai/tapes/talk.jsonl": TAPE_LINE },
      roots: ["index.html", "src", "ai\\tapes\\talk.jsonl"],
    },
  ];
  for (const row of HOSTILE_ROOTS) {
    it(`leaves a tape out when it is ${row.label}`, async () => {
      const temp = await tmpDir("studio-export-tape-row-");
      try {
        const source = await gameWith(temp, row.folder, row.files);
        const target = path.join(temp, "public");
        const result = await exportPublicGame(source, target, row.roots);
        assert.deepEqual(result.included.sort(), ["index.html", "src/main.js"]);
        assert.ok(!(await filesUnder(target)).some((rel) => rel.endsWith(".jsonl")), "no tape reached the public copy");
      } finally {
        await removeTree(temp);
      }
    });
  }

  it("refuses a path that climbs out of ai/tapes/ship/, and writes nothing", async () => {
    const temp = await tmpDir("studio-export-tape-climb-");
    try {
      const source = await gameWith(temp, "game", { "ai/tapes/talk.jsonl": TAPE_LINE });
      const target = path.join(temp, "public");
      await assert.rejects(
        exportPublicGame(source, target, ["index.html", "ai/tapes/ship/../talk.jsonl"]),
        /Invalid public path/,
      );
      assert.deepEqual((await readdir(temp)).sort(), ["game"], "no target and no staging folder");
    } finally {
      await removeTree(temp);
    }
  });
});

describe("an AI starter's game exported with Studio's default files", () => {
  let lite: CoreLite;
  before(async () => {
    // The template's page loads Studio's vendored libraries: stand-ins for each, so the export's
    // reference check reads a whole game, as it does in the app.
    const resources = await makeResources({ tsc: false });
    const template = path.join(resources, "game-template");
    const page = await readFile(path.join(template, "index.html"), "utf8");
    const addons = await Promise.all(
      (await filesUnder(path.join(template, "src"))).map((rel) => readFile(path.join(template, "src", rel), "utf8")),
    );
    const vendored = [
      ...[...page.matchAll(/"\/vendor\/([^"]+\.js)"/g)].map(([, rel = ""]) => rel),
      ...addons.flatMap((code) =>
        [...code.matchAll(/from "three\/addons\/([^"]+)"/g)].map(([, rel = ""]) => `three/examples/jsm/${rel}`),
      ),
      ...["basis_transcoder.js", "basis_transcoder.wasm"].map((name) => `three/examples/jsm/libs/basis/${name}`),
    ];
    for (const rel of vendored) {
      await mkdir(path.dirname(path.join(resources, "vendor", rel)), { recursive: true });
      await writeFile(path.join(resources, "vendor", rel), "export {};\n");
    }
    lite = await coreLite({ resources });
  });
  after(async () => {
    await lite.close();
  });

  for (const starter of STARTERS) {
    it(`exports ${starter.name}'s ai/ code beside src/, and leaves its tape home`, async () => {
      const game = await lite.core.createGame(`Starter ${starter.name}`);
      await lite.core.games.start(game.name, ProjectStarter.Web);
      for (const folder of ["ai", "src"]) {
        await cp(path.join(STARTERS_DIR, starter.name, folder), path.join(game.dir, folder), {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
      }
      const tape = tapeFile(starter.demo);
      assert.equal(
        await readFile(path.join(game.dir, ...tape.split("/")), "utf8"),
        await readFile(starterTape(starter), "utf8"),
      );
      const target = path.join(path.dirname(game.dir), `${game.name}-public`);
      const result = await lite.core.games.export(game.name, target);
      const shipped = await filesUnder(target);
      const aiCode = (await filesUnder(path.join(STARTERS_DIR, starter.name, "ai"))).filter(
        (rel) => !rel.startsWith("tapes/"),
      );
      for (const rel of aiCode) assert.ok(shipped.includes(`ai/${rel}`), `ai/${rel} is in the public copy`);
      assert.ok(result.excluded.includes(tape), `${tape} is reported left out`);
      assert.ok(!shipped.includes(tape), "the tape stays home");
    });
  }
});
