/**
 * The design board's files, as main reads and serves them: a game's pages are the top-level HTML
 * files of `docs/design/`, served to the Design tab's frames from the game folder only, as inert
 * documents (no script of their own, no network), with the media the game folder holds.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DESIGN_BRIDGE,
  DESIGN_ITEMS_MAX,
  DesignHosts,
  designCsp,
  designHeaders,
  designPageUrl,
  designFontFile,
  listDesignBoard,
  serveDesignFile,
  subframeMayLoad,
  withDesignBridge,
} from "../../src/main/design-pages.ts";
import { DESIGN_FOLDER, DESIGN_SCHEME } from "../../src/shared/design-board.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PAGE = "<!doctype html><html><head><title>Concept</title></head><body><h1>Bee siege</h1></body></html>";

function write(file: string, text: string | Buffer = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A game folder with two pages, a picture beside them and the game's own files. */
async function game(): Promise<string> {
  const root = fs.realpathSync(await tmpDir("design-pages-"));
  write(path.join(root, DESIGN_FOLDER, "02-loop.html"), PAGE);
  write(path.join(root, DESIGN_FOLDER, "01-concept.html"), PAGE);
  write(path.join(root, DESIGN_FOLDER, "img", "hero.png"));
  write(path.join(root, DESIGN_FOLDER, "board.css"), "body{margin:0}");
  write(path.join(root, "assets", "bee.png"));
  write(path.join(root, "index.html"), "<html></html>");
  write(path.join(root, "src", "main.js"), "alert(1)");
  write(path.join(root, ".env"), "KEY=1");
  return root;
}

/** A link where the platform lets a test make one (Windows needs a privilege a developer may lack). */
function link(target: string, at: string): boolean {
  try {
    fs.symlinkSync(target, at);
    return true;
  } catch {
    return false;
  }
}

describe("the design board's pages", () => {
  it("lists the top-level HTML files of docs/design by name, each under its file's name", async () => {
    const root = await game();
    write(path.join(root, DESIGN_FOLDER, "notes.md"), "# not a page");
    write(path.join(root, DESIGN_FOLDER, ".draft.html"), PAGE);
    write(path.join(root, DESIGN_FOLDER, "img", "inner.html"), PAGE);
    const board = await listDesignBoard(root);
    assert.deepEqual(
      board.items.map((page) => [page.file, page.name]),
      [
        ["docs/design/01-concept.html", "01-concept"],
        ["docs/design/02-loop.html", "02-loop"],
      ],
    );
    assert.match(board.stamp, /^[0-9a-f]{12}$/);
  });

  it("answers an empty board for a game with no design folder, and for a folder that is a link", async () => {
    const root = fs.realpathSync(await tmpDir("design-empty-"));
    assert.deepEqual(await listDesignBoard(root), { items: [], stamp: "" });
    const outside = await game();
    fs.mkdirSync(path.join(root, "docs"));
    if (!link(path.join(outside, DESIGN_FOLDER), path.join(root, DESIGN_FOLDER))) return;
    assert.deepEqual(await listDesignBoard(root), { items: [], stamp: "" });
  });

  it("changes its stamp when any file of the board changes, and only then", async () => {
    const root = await game();
    const before = (await listDesignBoard(root)).stamp;
    assert.equal((await listDesignBoard(root)).stamp, before);
    write(path.join(root, "src", "main.js"), "the game changed, the board did not");
    assert.equal((await listDesignBoard(root)).stamp, before);
    write(path.join(root, DESIGN_FOLDER, "img", "hero.png"), "a new picture, longer than the last");
    assert.notEqual((await listDesignBoard(root)).stamp, before);
  });

  it("reads the title each page gives itself, in plain words", async () => {
    const root = fs.realpathSync(await tmpDir("design-titles-"));
    const titled = (title: string): string => `<!doctype html><html><head>${title}</head><body></body></html>`;
    write(path.join(root, DESIGN_FOLDER, "a.html"), titled("<title>Bee Siege: three directions</title>"));
    write(path.join(root, DESIGN_FOLDER, "b.html"), titled("<TITLE lang=en>\n  Cast &amp; who beats whom\n</TITLE>"));
    write(path.join(root, DESIGN_FOLDER, "c.html"), titled(""));
    write(path.join(root, DESIGN_FOLDER, "d.html"), titled(`<title>${"long ".repeat(80)}</title>`));
    const titles = (await listDesignBoard(root)).items.map((page) => page.title);
    assert.deepEqual(titles.slice(0, 3), ["Bee Siege: three directions", "Cast & who beats whom", ""]);
    assert.equal(titles[3]?.length, 120, "a title is cut where a caption would be");
  });

  it("gives a page a new version when it, or a file it shows, changes, and leaves the other pages alone", async () => {
    const root = await game();
    const outside = fs.realpathSync(await tmpDir("design-shown-outside-"));
    write(path.join(outside, "far.png"));
    const shows = [
      '<img src="img/hero.png">',
      "<img src='../../assets/bee.png?size=2#top'>",
      "<video poster=/assets/poster.png></video>",
      '<link rel="stylesheet" href="board.css">',
      '<div style="background:url(../../assets/sky.png)"></div>',
      // what a page may not read is never looked at
      `<img src="${"../".repeat(12)}far.png">`,
      '<img src="https://example.com/far.png">',
      '<img src="../../src/main.js">',
      '<img src="../../.env">',
      '<a href="02-loop.html">the loop</a>',
    ].join("");
    write(path.join(root, DESIGN_FOLDER, "01-concept.html"), `<!doctype html><title>Concept</title>${shows}`);
    const facts = new Map();
    const versions = async (): Promise<Array<string | undefined>> =>
      (await listDesignBoard(root, facts)).items.map((page) => page.version);
    const [concept, loop] = await versions();
    assert.match(concept ?? "", /^[0-9a-f]{12}$/);
    assert.notEqual(concept, loop);
    assert.deepEqual(await versions(), [concept, loop], "nothing changed: the same versions");

    const changes: Array<[string, string, boolean]> = [
      ["a picture beside the page", path.join(root, DESIGN_FOLDER, "img", "hero.png"), true],
      ["a picture of the game", path.join(root, "assets", "bee.png"), true],
      ["a picture that was not there yet", path.join(root, "assets", "poster.png"), true],
      ["its style sheet", path.join(root, DESIGN_FOLDER, "board.css"), true],
      ["a picture its style names", path.join(root, "assets", "sky.png"), true],
      ["a file outside the game", path.join(outside, "far.png"), false],
      ["the game's code", path.join(root, "src", "main.js"), false],
      ["a hidden file", path.join(root, ".env"), false],
      ["a picture it does not show", path.join(root, "assets", "other.png"), false],
    ];
    let before = concept;
    for (const [what, file, reloads] of changes) {
      write(file, `changed: ${what}`);
      const [now, other] = await versions();
      assert.equal(now !== before, reloads, what);
      assert.equal(other, loop, `the other page stays as it was: ${what}`);
      before = now;
    }
    write(path.join(root, DESIGN_FOLDER, "02-loop.html"), `${PAGE}<p>a longer loop</p>`);
    const [afterLoop, newLoop] = await versions();
    assert.equal(afterLoop, before, "another page's change is not this page's");
    assert.notEqual(newLoop, loop);
  });

  it("lists pictures and models beside pages, section by section, and nothing else", async () => {
    const root = await game();
    const board = path.join(root, DESIGN_FOLDER);
    for (const file of ["world/town.png", "world/map.html", "characters/lantern.glb", "from-you/ref.jpg"])
      write(path.join(board, ...file.split("/")), file.endsWith(".html") ? PAGE : "x");
    const never = [
      "img/x.png",
      "world/img/y.png",
      "world/deep/z.png",
      "world/clip.mp4",
      "world/notes.md",
      ".hidden/a.png",
    ];
    for (const file of never) write(path.join(board, ...file.split("/")));
    const { items } = await listDesignBoard(root);
    assert.deepEqual(
      items.map((item) => [item.file.slice(DESIGN_FOLDER.length + 1), item.kind, item.section, item.name]),
      [
        ["01-concept.html", "page", "", "01-concept"],
        ["02-loop.html", "page", "", "02-loop"],
        ["characters/lantern.glb", "model", "characters", "lantern"],
        ["world/map.html", "page", "world", "map"],
        ["world/town.png", "picture", "world", "town"],
        // what the person dropped comes last, whatever its name sorts to
        ["from-you/ref.jpg", "picture", "from-you", "ref"],
      ],
    );
  });

  it("serves Genex's own typefaces from its reserved folder, and nothing else from there", () => {
    assert.equal(
      designFontFile("/~genex/fonts/ZalandoSansSemiExpanded-variable.woff2"),
      "ZalandoSansSemiExpanded-variable.woff2",
    );
    assert.equal(designFontFile("/~genex/fonts/GeistMono-variable.woff2"), "GeistMono-variable.woff2");
    for (const pathname of [
      "/~genex/fonts/other.woff2",
      "/~genex/fonts/../main.mjs",
      "/~genex/",
      "/docs/design/a.html",
      "",
    ])
      assert.equal(designFontFile(pathname), null, pathname);
  });

  it("draws a page in the app's look, dark unless it is asked for light", () => {
    assert.match(withDesignBridge("<h1>x</h1>"), /color-scheme:dark/);
    assert.match(withDesignBridge("<h1>x</h1>", "light"), /color-scheme:light/);
    assert.match(withDesignBridge("<h1>x</h1>"), /--genex-ink:/, "Genex's colours are a page's variables");
  });

  it("lists no more artboards than the canvas holds, and never a page that is a link", async () => {
    const root = fs.realpathSync(await tmpDir("design-many-"));
    for (let n = 0; n < DESIGN_ITEMS_MAX + 5; n += 1)
      write(path.join(root, DESIGN_FOLDER, `page-${String(n).padStart(2, "0")}.html`), PAGE);
    const outside = await game();
    const linked = link(path.join(outside, "index.html"), path.join(root, DESIGN_FOLDER, "aaa-linked.html"));
    const board = await listDesignBoard(root);
    assert.equal(board.items.length, DESIGN_ITEMS_MAX);
    assert.equal(board.items[0]?.name, "page-00", linked ? "the linked page is not listed" : "by name");
  });
});

describe("serving a design page", () => {
  it("serves a page as HTML with Genex's bridge in it, and the board's and the game's media", async () => {
    const root = await game();
    const page = await serveDesignFile(root, "/docs/design/01-concept.html");
    assert.equal(page.status, 200);
    assert.ok(page.status === 200 && "text" in page.body);
    assert.equal(page.type, "text/html; charset=utf-8");
    assert.ok(page.body.text.includes(DESIGN_BRIDGE), "the bridge is on the page");
    assert.ok(page.body.text.startsWith("<!doctype html>"), "the doctype stays first: no quirks mode");

    const picture = await serveDesignFile(root, "/docs/design/img/hero.png");
    assert.deepEqual(picture, {
      status: 200,
      type: "image/png",
      body: { file: path.join(root, DESIGN_FOLDER, "img", "hero.png") },
    });
    const asset = await serveDesignFile(root, "/assets/bee.png");
    assert.equal(asset.status, 200, "a page shows the game's own pictures");
    const css = await serveDesignFile(root, "/docs/design/board.css");
    assert.ok(css.status === 200 && css.type === "text/css; charset=utf-8");
  });

  it("refuses everything else, reading nothing outside the game", async () => {
    const root = await game();
    const outside = fs.realpathSync(await tmpDir("design-outside-"));
    write(path.join(outside, "secret.png"));
    write(path.join(outside, "secret.html"), PAGE);
    const linked = link(path.join(outside, "secret.png"), path.join(root, DESIGN_FOLDER, "img", "leak.png"));
    link(path.join(outside, "secret.html"), path.join(root, DESIGN_FOLDER, "leak.html"));
    link(outside, path.join(root, DESIGN_FOLDER, "out"));
    const refused: Array<[string, number]> = [
      // out of the game folder, as written, encoded, and through a link
      ["/../secret.png", 403],
      ["/%2e%2e/secret.png", 403],
      ["/docs/design/..%2F..%2F..%2Fsecret.png", 403],
      ...(linked
        ? ([
            ["/docs/design/img/leak.png", 403],
            ["/docs/design/leak.html", 403],
            ["/docs/design/out/secret.png", 403],
          ] as Array<[string, number]>)
        : []),
      // a page only from the board's own folder
      ["/index.html", 403],
      ["/src/page.html", 403],
      ["/docs/other.html", 403],
      ["/docs/design/img/inner.html", 403],
      // never code, never a hidden file, never a folder
      ["/src/main.js", 403],
      ["/docs/design/run.js", 403],
      ["/docs/design/run.mjs", 403],
      ["/.env", 403],
      ["/.git/config", 403],
      ["/.studio/shot.png", 403],
      ["/node_modules/pkg/logo.png", 403],
      ["/docs/design", 403],
      ["/docs/design/img", 403],
      ["/", 403],
      // nothing there
      ["/docs/design/missing.html", 404],
      ["/assets/missing.png", 404],
      // not a path at all
      ["/docs/design/%E0%A4%A.html", 400],
    ];
    for (const [pathname, status] of refused) {
      assert.deepEqual(await serveDesignFile(root, pathname), { status }, pathname);
    }
  });

  it("does not serve a page too large to be one", async () => {
    const root = await game();
    write(path.join(root, DESIGN_FOLDER, "huge.html"), Buffer.alloc(5 * 1024 * 1024, "a"));
    assert.deepEqual(await serveDesignFile(root, "/docs/design/huge.html"), { status: 403 });
  });

  it("puts the bridge where a page of any shape keeps its mode", () => {
    const cases: Array<[string, RegExp]> = [
      ["<!doctype html><html><head><title>t</title></head><body></body></html>", /^<!doctype html><html><head><style/],
      ["<!DOCTYPE html>\n<html lang=en>\n<body>hi</body></html>", /^<!DOCTYPE html>\n<html lang=en><style/],
      ["<!doctype html><h1>bare</h1>", /^<!doctype html><style/],
      ["<h1>no doctype</h1>", /^<style/],
      ["<HTML><HEAD data-x='<head>'></HEAD></HTML>", /^<HTML><HEAD data-x='<head>'><style/],
    ];
    for (const [html, start] of cases) {
      const served = withDesignBridge(html);
      assert.match(served, start, html);
      assert.equal(served.split(DESIGN_BRIDGE).length, 2, "the bridge is there once");
      assert.ok(served.endsWith(html.slice(-12)), "the page's own text is whole");
    }
  });

  it("lets a page run Genex's bridge only, and reach nothing but the board's own scheme", () => {
    const csp = designCsp();
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'(;|$)/, "only the bridge, by its hash");
    assert.doesNotMatch(csp, /script-src[^;]*('unsafe-inline'|'self'|https?:|genex-design:)/);
    assert.match(csp, new RegExp(`img-src ${DESIGN_SCHEME}: data:`));
    assert.doesNotMatch(csp, /https?:/, "no network");
    for (const directive of ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"])
      assert.ok(csp.includes(directive), directive);
    const headers = designHeaders({ status: 200, type: "image/png", body: { file: "x" } });
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Cache-Control"], "no-store");
    assert.match(headers["Content-Security-Policy"] ?? "", /sandbox/, "a file opened as a document runs nothing");
  });
});

describe("the design board's addresses", () => {
  it("gives each game a host only this launch knows, and reads it back", () => {
    const hosts = new DesignHosts();
    const host = hosts.hostFor("My Game");
    assert.match(host, /^[0-9a-f]{24}$/);
    assert.equal(hosts.hostFor("My Game"), host, "one host per game");
    assert.notEqual(hosts.hostFor("other"), host);
    assert.equal(hosts.projectOf(host), "My Game");
    assert.equal(hosts.projectOf("my-game"), null, "a game's name is not its host");
    assert.equal(hosts.projectOf(""), null);
    assert.equal(
      designPageUrl(host, "docs/design/core loop.html", "abc"),
      `${DESIGN_SCHEME}://${host}/docs/design/core%20loop.html?v=abc`,
    );
  });

  it("keeps the window's frames on the app's own schemes", () => {
    for (const url of [`${DESIGN_SCHEME}://abc/docs/design/a.html`, "studio-plugin://genex/panel", "about:blank"])
      assert.equal(subframeMayLoad(url), true, url);
    for (const url of [
      "https://example.com/",
      "http://localhost:3000/",
      "file:///etc/passwd",
      "game://x/",
      "data:text/html,x",
      "",
    ])
      assert.equal(subframeMayLoad(url), false, url);
  });
});
