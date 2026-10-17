/**
 * The page Studio publishes to Genex. The games host puts its environment, mobile kit, crash
 * watchdog and cover responder into the page's `<head>` tag, so a page without one got none of
 * them; and a game that never connects to Genex is shown to its players as one they cannot sign in
 * to. Studio gives every published page a head, and connects a game that brings no SDK of its own.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GENEX_EMBED_VENDOR } from "../../src/shared/genex.ts";
import { connectScript, embedSdkFiles } from "../../src/plugins/genex/entry-page.ts";
import { withConnectScript, withHead } from "../../src/shared/genex-page.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SRC = `./vendor/${GENEX_EMBED_VENDOR.Connect}`;
const TAG = `<script type="module" src="${SRC}"></script>`;

describe("a published page's head", () => {
  it("is added where the parser would have opened one, and an existing one is kept", () => {
    const table: Array<[string, string, string]> = [
      ["template page", "<!doctype html>\n<meta charset=utf-8>", "<!doctype html><head></head>\n<meta charset=utf-8>"],
      ["upper-case doctype", "<!DOCTYPE html><title>x</title>", "<!DOCTYPE html><head></head><title>x</title>"],
      [
        "byte-order mark",
        "\uFEFF<!doctype html><title>x</title>",
        "\uFEFF<!doctype html><head></head><title>x</title>",
      ],
      [
        "html tag",
        '<!doctype html><html lang="en"><title>x</title>',
        '<!doctype html><html lang="en"><head></head><title>x</title>',
      ],
      ["no doctype", "<title>x</title>", "<head></head><title>x</title>"],
      ["a head", "<!doctype html><head><title>x</title></head>", "<!doctype html><head><title>x</title></head>"],
      ["a head with attributes", '<HEAD data-x="1"><title>x</title>', '<HEAD data-x="1"><title>x</title>'],
      ["a header is not a head", "<!doctype html><header>x</header>", "<!doctype html><head></head><header>x</header>"],
      [
        "a head inside a comment is not a head",
        "<!doctype html><!-- <head> --><title>x</title>",
        "<!doctype html><head></head><!-- <head> --><title>x</title>",
      ],
    ];
    for (const [name, page, expected] of table) assert.equal(withHead(page), expected, name);
  });
});

describe("the connect script in a published page", () => {
  it("runs after the last import map and before any of the game's modules", () => {
    const map = '<script type="importmap">{"imports":{}}</script>';
    const scopedMap = "<script type='importmap' data-x>{}</script>";
    const table: Array<[string, string, string]> = [
      [
        "no import map",
        "<head><script type=module src=a.js></script>",
        `<head>${TAG}<script type=module src=a.js></script>`,
      ],
      [
        "one import map",
        `<head>${map}<script type=module></script>`,
        `<head>${map}${TAG}<script type=module></script>`,
      ],
      ["two import maps", `<head>${map}${scopedMap}<p>`, `<head>${map}${scopedMap}${TAG}<p>`],
      [
        "an import map inside a comment is not one",
        `<head><!-- ${map} --><script type=module></script>`,
        `<head>${TAG}<!-- ${map} --><script type=module></script>`,
      ],
      ["already connected", `<head>${TAG}<p>`, `<head>${TAG}<p>`],
      ["no head yet", "<!doctype html><title>x</title>", `<!doctype html><head>${TAG}</head><title>x</title>`],
    ];
    for (const [name, page, expected] of table) assert.equal(withConnectScript(page, SRC), expected, name);
  });

  it("names the game's project and lets the games host name the environment", () => {
    const script = connectScript({
      slug: "rain-circuit",
      apiUrl: "https://api.genex.games",
      dashboardOrigins: ["https://genex.games"],
    });
    assert.match(script, /^\/\/ /, "it says what wrote it");
    assert.match(script, /import \{ initEmbed \} from "\.\/embed-sdk\/index\.js";/);
    assert.match(script, /slug: "rain-circuit"/);
    assert.match(script, /served\.apiUrl \?\? "https:\/\/api\.genex\.games"/);
    assert.match(script, /served\.dashboardOrigins \?\? \["https:\/\/genex\.games"\]/);
  });

  it("refuses a project or address that is not one", () => {
    const good = { slug: "rain-circuit", apiUrl: "https://api.genex.games", dashboardOrigins: ["https://genex.games"] };
    const table: Array<[string, Parameters<typeof connectScript>[0]]> = [
      ["a slug that leaves the string", { ...good, slug: 'x"; alert(1); "' }],
      ["an empty slug", { ...good, slug: "" }],
      ["a script address", { ...good, apiUrl: "javascript:alert(1)" }],
      ["an origin with a path", { ...good, dashboardOrigins: ["https://genex.games/evil"] }],
      ["no origin", { ...good, dashboardOrigins: [] }],
    ];
    for (const [name, connection] of table) assert.throws(() => connectScript(connection), name);
  });
});

describe("the embed SDK files a published copy needs", () => {
  it("are its entry and every module it imports, and nothing else", async () => {
    const dir = await tmpDir("studio-embed-sdk-");
    await writeFile(path.join(dir, "index.js"), 'import { a } from "./chunk-A.js";\nexport { a };\n');
    await writeFile(path.join(dir, "chunk-A.js"), 'import "./chunk-B.js";\nexport const a = 1;\n');
    await writeFile(path.join(dir, "chunk-B.js"), "export {};\n");
    await writeFile(path.join(dir, "sentry.js"), 'import * as S from "@sentry/browser";\n');
    await writeFile(path.join(dir, "index.d.ts"), "export {};\n");
    assert.deepEqual(await embedSdkFiles(dir), ["chunk-A.js", "chunk-B.js", "index.js"]);
  });

  it("refuses an SDK that imports a package or leaves its folder", async () => {
    const table: Array<[string, string]> = [
      ["a package", 'import * as S from "@sentry/browser";'],
      ["a parent folder", 'import "../outside.js";'],
      ["a missing module", 'import "./missing.js";'],
    ];
    for (const [name, source] of table) {
      const dir = await tmpDir("studio-embed-sdk-bad-");
      await writeFile(path.join(dir, "index.js"), source);
      await assert.rejects(embedSdkFiles(dir), name);
    }
  });

  it("is the pinned SDK Studio builds with", async () => {
    const pkg = path.resolve(import.meta.dirname, "../../node_modules/@genex-ai/embed-sdk");
    const files = await embedSdkFiles(path.join(pkg, "dist"));
    assert.ok(files.includes("index.js") && files.length > 1);
    assert.ok(!files.some((file) => /sentry|development|\.d\.ts$/.test(file)), files.join(", "));
    const version = JSON.parse(await readFile(path.join(pkg, "package.json"), "utf8")).version;
    const root = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8"));
    assert.equal(root.devDependencies["@genex-ai/embed-sdk"], version, "Studio builds with the version it installs");
  });
});
