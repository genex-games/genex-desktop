/**
 * The `genex-ai` a game loads: Studio's build of `src/page/ai`, served from the vendor folder by
 * its import-map name. It is one ES module that imports nothing (on genex.games it calls the embed
 * SDK the page's connect module connected), it stays small, and on a page with no Studio and no
 * Genex it starts off and registers itself for the studio contract.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Metafile } from "esbuild";
import { genexAiBundle } from "../../scripts/genex-ai-bundle.mjs";
import { AiErrorCode } from "../../src/shared/game-ai.ts";
import { GENEX_AI_STUDIO_GLOBAL } from "../../src/shared/game-ai-lane.ts";
import { GENEX_AI_IMPORT, GENEX_AI_SPECIFIER, GENEX_AI_VENDOR } from "../../src/shared/genex.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The most the bundle may weigh, gzipped (plan: the SDK is at most 25 KB gzip). */
const MAX_GZIP_BYTES = 25 * 1024;

let outRoot = "";
let file = "";
let meta: Metafile | undefined;

before(async () => {
  outRoot = await tmpDir("genex-ai-bundle-");
  const options = { ...genexAiBundle(path.resolve("."), outRoot), logLevel: "silent" as const };
  meta = (await build(options)).metafile;
  file = path.join(outRoot, "vendor", GENEX_AI_VENDOR.Entry);
});

after(() => {
  Reflect.deleteProperty(globalThis, GENEX_AI_STUDIO_GLOBAL);
});

describe("the genex-ai bundle", () => {
  it("is one module that imports nothing, and at most 25 KB gzipped", async () => {
    const output = Object.values(meta?.outputs ?? {}).find((out) => out.entryPoint !== undefined);
    assert.ok(output, "the bundle was written");
    assert.deepEqual(output.imports, []);
    const size = gzipSync(await readFile(file)).byteLength;
    assert.ok(size <= MAX_GZIP_BYTES, `${size} bytes gzipped`);
  });

  it("starts off on a page Studio does not serve, and registers for the studio contract", async () => {
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module.createAi, "function");
    const ai = module.createAi({ requires: "optional" });
    await ai.ready();
    assert.equal(ai.status().on, false);
    ai.ask({ site: "npc.reply", prompt: "Hi", schema: module.s.object({ line: module.s.string({ max: 9 }) }) });
    assert.equal(ai.drain()[0]?.code, AiErrorCode.Off);
    const handle = Reflect.get(globalThis, GENEX_AI_STUDIO_GLOBAL);
    assert.equal(typeof handle?.status, "function");
    assert.equal(typeof handle?.reset, "function");
  });
});

describe("the template's import map", () => {
  it("maps genex-ai to the very file the build writes", async () => {
    const page = await readFile(path.resolve("src/game-template/index.html"), "utf8");
    const [, body = ""] = /<script type="importmap">([\s\S]*?)<\/script>/.exec(page) ?? [];
    const imports = JSON.parse(body).imports as Record<string, string>;
    assert.equal(imports[GENEX_AI_SPECIFIER], GENEX_AI_IMPORT[GENEX_AI_SPECIFIER]);
    const served = imports[GENEX_AI_SPECIFIER] ?? "";
    assert.equal(path.join(outRoot, served), file, "the served URL is the bundle's place under the vendor folder");
  });
});
