/**
 * The provider CLIs Studio asks for a listing, started as Windows starts them: npm installs Codex
 * and OpenCode as `codex.cmd` / `opencode.cmd`, which Node refuses to spawn without cmd.exe. Each
 * fixture CLI here is such a script on Windows (`writeCliLauncher`) and a plain executable elsewhere.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { codexGlobalSkills } from "../../src/main/provider-skills.ts";
import { configureCodingClis } from "../../src/substrate/engines/external-cli.ts";
import { OpenCodeEngine } from "../../src/substrate/engines/opencode.ts";
import { cliName, writeCliLauncher } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const OPENCODE_LISTING = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "transcripts",
  "opencode-api-model-2.0.20.json",
);
const CODEX_FLAGS = "--json --output-schema --ignore-user-config --skip-git-repo-check";

/** A fixture CLI from its Node source: on POSIX the same source behind a shebang to this Node. */
async function fixtureCli(file: string, js: string): Promise<void> {
  await writeCliLauncher(file, `#!${process.execPath}\n${js}`, js);
}

/** Codex's `app-server`: answers `initialize`, then lists one skill; anything else is its version or help. */
function fakeCodex(skillPath: string): string {
  return `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.200.0"); process.exit(0); }
if (args[0] !== "app-server") { console.log(${JSON.stringify(CODEX_FLAGS)}); process.exit(0); }
const skill = { name: "from-script", path: ${JSON.stringify(skillPath)}, scope: "user", description: "listed" };
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
  if (message.id === 2) console.log(JSON.stringify({ id: 2, result: { data: [{ skills: [skill] }] } }));
});
`;
}

/** OpenCode 2.x's `serve --stdio`: prints its loopback address, serves the recorded listing, ends with stdin. */
function fakeOpenCode(): string {
  return `
if (process.argv[2] !== "serve") process.exit(2);
const listing = require("fs").readFileSync(${JSON.stringify(OPENCODE_LISTING)});
const server = require("http").createServer((request, response) => {
  if (request.url !== "/api/model") { response.statusCode = 404; response.end(); return; }
  response.setHeader("content-type", "application/json");
  response.end(listing);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: "http://127.0.0.1:" + server.address().port })));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;
}

test("the Codex skills catalog starts an npm-installed codex (codex.cmd on Windows)", async () => {
  const root = await tmpDir("provider-cli-codex-");
  const bin = path.join(root, "npm");
  const skill = path.join(root, "skills", "from-script", "SKILL.md");
  await fixtureCli(path.join(bin, cliName("codex")), fakeCodex(skill));
  configureCodingClis(path.join(root, "settings.json"), [], {
    loginPath: bin,
    home: root,
    env: { PATH: "" },
    standardDirs: [],
  });
  const inventory = await codexGlobalSkills(root, null);
  assert.deepEqual(inventory.warnings, []);
  assert.deepEqual(
    inventory.skills.map((row) => row.path),
    [skill],
  );
});

test("OpenCode 2.x's model listing starts an npm-installed opencode (opencode.cmd on Windows)", async () => {
  const root = await tmpDir("provider-cli-opencode-");
  const binary = path.join(root, "npm", cliName("opencode"));
  await fixtureCli(binary, fakeOpenCode());
  const engine = new OpenCodeEngine({
    scratchRoot: path.join(root, "scratch"),
    resolveCli: async () => ({ ready: true, path: binary, version: "2.0.20", detail: "" }),
  });
  await engine.refreshModels(true);
  const listed = JSON.parse(await readFile(OPENCODE_LISTING, "utf8")) as { data: unknown[] };
  assert.ok(listed.data.length > 0);
  assert.ok((await engine.models()).length > 0, "the recorded listing's models reach the picker");
});
