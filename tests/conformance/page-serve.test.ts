/**
 * The one HTML rewriter (M4.1): where the studio's own tags land in a page it did not write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  CHARSET_BUDGET,
  HOOK_TAG,
  MAX_REWRITE_BYTES,
  SHIM_TAG,
  confinePreviewContents,
  cspNote,
  findMetaCsp,
  gameRequestAllowed,
  packedBuildFile,
  previewNavigationAllowed,
  rewriteGameHtml,
  shimTag,
  resolveServed,
  routeHttp,
  servableProject,
  servedLocation,
  servedRelative,
  shouldRewrite,
  tooLargeNote,
  unpackedResponse,
} from "../../src/main/page-serve.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.resolve("tests/fixtures/pages");
const DOCUMENTS = [
  "template.html",
  "vite-dist.html",
  "doctype-only.html",
  "map-first.html",
  "commented-head.html",
  "meta-csp.html",
];
const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

describe("the served page", () => {
  it("puts the shim ahead of every module script and of the import map", () => {
    for (const name of DOCUMENTS) {
      const { html, injected } = rewriteGameHtml(read(name));
      assert.equal(injected, true, name);
      const shim = html.indexOf(SHIM_TAG);
      assert.ok(shim >= 0, `${name} has no shim tag`);
      const firstModule = html.indexOf('<script type="module"');
      if (firstModule >= 0) assert.ok(shim < firstModule, `${name}: the shim must precede the first module`);
      const map = html.indexOf('<script type="importmap"');
      if (map >= 0) assert.ok(shim < map, `${name}: the shim must precede the import map`);
    }
  });

  it("puts the hook after the import map, because a module ahead of a map disables it", () => {
    for (const name of ["template.html", "map-first.html", "meta-csp.html"]) {
      const { html } = rewriteGameHtml(read(name));
      const map = html.indexOf('<script type="importmap"');
      const hook = html.indexOf(HOOK_TAG);
      assert.ok(map >= 0 && hook > map, `${name}: hook at ${hook}, map at ${map}`);
      assert.ok(hook > html.indexOf("</script>", map), `${name}: the hook must follow the whole map`);
    }
  });

  it("keeps the charset declaration inside the first kilobyte", () => {
    for (const name of DOCUMENTS) {
      const { html } = rewriteGameHtml(read(name));
      const at = html.toLowerCase().indexOf("<meta charset");
      assert.ok(at < CHARSET_BUDGET, `${name}: charset at ${at}`);
      if (read(name).toLowerCase().includes("<meta charset")) assert.ok(at >= 0, `${name} lost its charset`);
    }
  });

  it("is idempotent — a page already carrying the shim comes back unchanged", () => {
    for (const name of DOCUMENTS) {
      const once = rewriteGameHtml(read(name));
      const twice = rewriteGameHtml(once.html);
      assert.equal(twice.injected, false, name);
      assert.equal(twice.html, once.html, name);
    }
  });

  it("still serves the studio onto a page that merely mentions the shim's attribute", () => {
    // The idempotence guard is the injected TAG, not the string. A bare substring test meant one
    // mention anywhere — a comment, a debug line asking whether the studio is attached, a CSS
    // content value — served the page byte-identical: no shim, no hook, no map, no clock, and
    // nothing in the run to say why.
    const mentions = [
      (html: string) => html.replace("<head>", "<head>\n<!-- the studio adds data-studio-shim here -->"),
      (html: string) =>
        html.replace(
          "<head>",
          '<head>\n<script>window.__attached = !!document.querySelector("script[data-studio-shim]");</script>',
        ),
      (html: string) => html.replace("<head>", '<head>\n<style>#hint::after { content: "data-studio-shim"; }</style>'),
    ];
    for (const mention of mentions) {
      const source = mention(read("template.html"));
      const result = rewriteGameHtml(source, { documentUrl: "game://sweep/index.html" });
      assert.equal(result.injected, true, "a page that only mentions the attribute was left untouched");
      assert.ok(result.html.includes(SHIM_TAG), "the served page has no shim");
      assert.equal(result.reach, "import-map");
      // And the real thing is still idempotent.
      assert.equal(rewriteGameHtml(result.html, { documentUrl: "game://sweep/index.html" }).injected, false);
    }
  });

  it("does not drop its tags into a comment that mentions the head", () => {
    const { html } = rewriteGameHtml(read("commented-head.html"));
    const comment = html.indexOf("<!-- <head>");
    const shim = html.indexOf(SHIM_TAG);
    assert.ok(shim > html.indexOf("-->", comment), "the shim landed inside the comment");
    assert.ok(shim > html.toLowerCase().indexOf("<head>"), "the shim must be inside the real head");
  });

  it("leaves the page's own import map byte-identical", () => {
    const source = read("template.html");
    const map = source.slice(
      source.indexOf('<script type="importmap"'),
      source.indexOf("</script>") + "</script>".length,
    );
    assert.ok(rewriteGameHtml(source).html.includes(map));
  });

  it("names a meta content-security-policy instead of editing it", () => {
    const source = read("meta-csp.html");
    const csp = findMetaCsp(source);
    assert.equal(csp?.directive, "script-src");
    const { html, notes } = rewriteGameHtml(source);
    assert.ok(notes.includes(cspNote(csp!)));
    assert.ok(html.includes(`content="default-src 'none'; script-src 'unsafe-inline'; img-src data:"`));
    assert.equal(findMetaCsp(read("template.html")), null);
  });

  it("bakes this load's shim options into the tag, and nothing when there are none", () => {
    assert.equal(shimTag(null), SHIM_TAG);
    assert.equal(shimTag({}), SHIM_TAG);
    const tag = shimTag({ readyMs: 30_000, seed: null });
    assert.match(tag, /data-studio-shim data-studio-options="/);
    const encoded = /data-studio-options="([^"]*)"/.exec(tag)?.[1] ?? "";
    assert.deepEqual(JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, "&")), {
      readyMs: 30_000,
      seed: null,
    });
    assert.ok(rewriteGameHtml(read("template.html"), { shim: { readyMs: 30_000, seed: null } }).html.includes(tag));
  });
});

describe("which responses receive the studio", () => {
  it("rewrites the entry, and nothing it cannot name", () => {
    assert.equal(shouldRewrite("text/html", "index.html", true, null, 400), true);
    assert.equal(shouldRewrite("text/html", "level.html", false, "", 400), false);
    assert.equal(shouldRewrite("text/html", "level.html", false, "empty", 400), false);
    assert.equal(shouldRewrite("text/html", "level.html", false, "document", 400), true);
    assert.equal(shouldRewrite("text/html", "level.html", false, "iframe", 400), true);
    assert.equal(shouldRewrite("text/html", "vendor/studio/shim.js", true, "document", 400), false);
    assert.equal(shouldRewrite("text/html", "index.html", true, "document", 9 * 1024 * 1024), false);
    assert.equal(shouldRewrite("text/javascript", "index.html", true, "document", 400), false);
    assert.equal(shouldRewrite(null, "index.html", true, null, 400), true);
    assert.equal(shouldRewrite(null, "main.js", false, "document", 400), false);
    assert.equal(shouldRewrite("text/html; charset=utf-8", "dist/index.html", true, null, null), true);
  });

  it("says why a document was left alone", () => {
    assert.equal(
      tooLargeNote("index.html", MAX_REWRITE_BYTES + 1),
      "index.html is too large to receive the studio shim (8.0 MB); the studio cannot pace this page's clock",
    );
  });
});

describe("which file a request names", () => {
  // Containment is checked on real paths, so every expected path is a real one (macOS temp
  // folders sit behind the /var → /private/var link).
  const real = (p: string) => fs.realpathSync(p);
  const touch = (file: string, text = "x\n") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  it("decodes before it resolves, so an encoded step up is refused like a literal one", async () => {
    const base = await tmpDir("studio-serve-");
    touch(path.join(base, "src", "main.js"));
    touch(path.join(base, "etc", "passwd"));
    assert.equal(servedRelative("/"), "index.html");
    assert.equal(servedRelative("///level%201.html"), "level 1.html");
    assert.deepEqual(await resolveServed(base, servedRelative("/src/main.js")!), {
      ok: true,
      path: path.join(real(base), "src", "main.js"),
    });
    for (const escape of ["/../secret.txt", "/%2e%2e/secret.txt", "/src/..%2F..%2Fsecret.txt"]) {
      assert.deepEqual(await resolveServed(base, servedRelative(escape)!), { ok: false, status: 403 }, escape);
    }
    // An encoded absolute path loses its leading slashes with the rest, so it stays in the folder.
    assert.deepEqual(await resolveServed(base, servedRelative("/%2Fetc%2Fpasswd")!), {
      ok: true,
      path: path.join(real(base), "etc", "passwd"),
    });
    // Flipped (L7) from "a malformed escape throws URIError, which fails the handler": it is not a
    // path at all, and the handler answers 400.
    assert.equal(servedRelative("/%E0%A4%A"), null);
    assert.equal(servedRelative("/%"), null);
  });

  it("serves from the root it pinned at load, not a folder swapped in under the same name later (M1)", async () => {
    const holder = await tmpDir("studio-pin-");
    const outside = await tmpDir("studio-outside-");
    const worktree = path.join(holder, "facet-a");
    touch(path.join(worktree, "index.html"));
    touch(path.join(outside, "secret.txt"), "not the game's\n");
    touch(path.join(outside, "index.html"), "not the game's\n");
    const pinned = real(worktree);
    const vendor = await tmpDir("studio-vendor-");
    const roots = { vendor, gameRoot: () => worktree, pinnedGameRoot: () => pinned };
    assert.deepEqual(await servedLocation("index.html", roots), { ok: true, path: path.join(pinned, "index.html") });
    // The worktree folder is replaced by a link out of scratch after the check.
    fs.renameSync(worktree, `${worktree}-moved`);
    fs.symlinkSync(outside, worktree);
    for (const request of ["secret.txt", "index.html", "."]) {
      assert.deepEqual(await servedLocation(request, roots), { ok: false, status: 403 }, request);
      assert.deepEqual(await resolveServed(worktree, request, pinned), { ok: false, status: 403 }, request);
    }
  });

  it("answers 404 for anything but a regular file or a folder: a FIFO would hang the reader (M4)", {
    skip: process.platform === "win32" && "Windows has no FIFOs in the file system",
  }, async () => {
    const base = await tmpDir("studio-serve-");
    const fifo = path.join(base, "pipe.json");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    assert.deepEqual(await resolveServed(base, "pipe.json"), { ok: false, status: 404 });
    fs.symlinkSync(fifo, path.join(base, "alias.json"));
    assert.deepEqual(await resolveServed(base, "alias.json"), { ok: false, status: 404 });
  });

  it("serves the folder itself, and not a sibling that shares its name as a prefix", async () => {
    const base = await tmpDir("studio-serve-");
    const evil = `${base}-evil`;
    touch(path.join(evil, "index.html"));
    try {
      assert.deepEqual(await resolveServed(base, "."), { ok: true, path: real(base) });
      assert.deepEqual(await resolveServed(base, `../${path.basename(base)}-evil/index.html`), {
        ok: false,
        status: 403,
      });
    } finally {
      fs.rmSync(evil, { recursive: true, force: true });
    }
  });

  it("reads vendor paths from the studio's vendor folder and asks for a game root only otherwise", async () => {
    const vendor = await tmpDir("studio-vendor-");
    const game = await tmpDir("studio-game-");
    touch(path.join(vendor, "three.module.js"));
    touch(path.join(game, "vendorish", "a.js"));
    let asked = 0;
    const roots = { vendor, gameRoot: () => (asked++, game) };
    assert.deepEqual(await servedLocation("vendor/three.module.js", roots), {
      ok: true,
      path: path.join(real(vendor), "three.module.js"),
    });
    assert.deepEqual(await servedLocation("vendor", roots), { ok: true, path: real(vendor) });
    assert.deepEqual(await servedLocation("vendor/../../x", roots), { ok: false, status: 403 });
    assert.equal(asked, 0, "a vendor request never looks the game up");
    assert.deepEqual(await servedLocation("vendorish/a.js", roots), {
      ok: true,
      path: path.join(real(game), "vendorish", "a.js"),
    });
    assert.equal(asked, 1);
  });

  it("serves only game names the library could have made", () => {
    assert.equal(servableProject("pond-life_2"), true);
    for (const name of ["", "-lead", "Pond", "pond life", "../pond", "pond/.."])
      assert.equal(servableProject(name), false, name);
  });

  it("refuses a symlink planted in the game that leads out of it (SECUI-2)", async () => {
    // Flipped from the Stage 0 pin "follows a symlink out of the game folder (current behaviour)":
    // lexical containment passed the link, and the main process's file:// fetch followed it.
    const outside = await tmpDir("studio-outside-");
    const base = await tmpDir("studio-serve-");
    touch(path.join(outside, "secret.txt"), "not the game's\n");
    fs.mkdirSync(path.join(base, "assets"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(base, "assets", "k.txt"));
    fs.symlinkSync(outside, path.join(base, "linked-dir"));
    fs.symlinkSync(path.join(base, "assets", "k.txt"), path.join(base, "hop.txt"));
    for (const request of ["/assets/k.txt", "/linked-dir/secret.txt", "/linked-dir", "/hop.txt"]) {
      assert.deepEqual(await resolveServed(base, servedRelative(request)!), { ok: false, status: 403 }, request);
    }
  });

  it("serves a link that stays inside the game, at its real path", async () => {
    const base = await tmpDir("studio-serve-");
    touch(path.join(base, "assets", "real.png"));
    fs.symlinkSync(path.join(base, "assets", "real.png"), path.join(base, "alias.png"));
    assert.deepEqual(await resolveServed(base, "alias.png"), {
      ok: true,
      path: path.join(real(base), "assets", "real.png"),
    });
  });

  it("serves a worktree's packages through the studio's link to the live game's node_modules (R4)", async () => {
    // SnapshotEngine.worktreeAt links <worktree>/node_modules to the live game's; a game with an
    // import map onto ./node_modules/three must still load in a worker's preview.
    const live = await tmpDir("studio-live-");
    const outside = await tmpDir("studio-outside-");
    const module = path.join("node_modules", "three", "build", "three.module.js");
    touch(path.join(live, module), "export {};\n");
    touch(path.join(live, "sub", module), "export {};\n");
    touch(path.join(outside, "secret.txt"), "not the game's\n");
    touch(path.join(outside, "node_modules", "x.js"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(live, "node_modules", "planted.txt"));
    const worktree = await tmpDir("studio-worktree-");
    touch(path.join(worktree, "index.html"));
    fs.symlinkSync(path.join(live, "node_modules"), path.join(worktree, "node_modules"), "dir");
    fs.mkdirSync(path.join(worktree, "sub"));
    fs.symlinkSync(path.join(live, "sub", "node_modules"), path.join(worktree, "sub", "node_modules"), "dir");
    const vendor = await tmpDir("studio-vendor-");
    const roots = { vendor, gameRoot: () => worktree, liveRoot: () => live };
    assert.deepEqual(await servedLocation(module, roots), { ok: true, path: path.join(real(live), module) });
    assert.deepEqual(await servedLocation(`sub/${module}`, roots), {
      ok: true,
      path: path.join(real(live), "sub", module),
    });
    // Hostile rows: the exception reaches the live game's own packages and nothing else.
    fs.symlinkSync(path.join(outside, "node_modules"), path.join(worktree, "other-modules"));
    fs.mkdirSync(path.join(worktree, "evil"));
    fs.symlinkSync(path.join(outside, "node_modules"), path.join(worktree, "evil", "node_modules"));
    fs.symlinkSync(path.join(live, "node_modules"), path.join(worktree, "alias"));
    const refused = [
      "node_modules/planted.txt",
      "evil/node_modules/x.js",
      "other-modules/x.js",
      `alias/three/build/three.module.js`,
      "node_modules/../../x",
    ];
    for (const request of refused)
      assert.deepEqual(await servedLocation(request, roots), { ok: false, status: 403 }, request);
    // Without a live game to compare with (the live preview itself), nothing changes.
    assert.deepEqual(await servedLocation(module, { vendor, gameRoot: () => worktree }), { ok: false, status: 403 });
  });

  it("serves a game whose own folder is reached through a link (a linked games root)", async () => {
    const holder = await tmpDir("studio-holder-");
    const game = await tmpDir("studio-game-");
    touch(path.join(game, "index.html"));
    const linked = path.join(holder, "pond-life");
    fs.symlinkSync(game, linked);
    assert.deepEqual(await resolveServed(linked, "index.html"), {
      ok: true,
      path: path.join(real(game), "index.html"),
    });
    assert.deepEqual(await resolveServed(linked, "."), { ok: true, path: real(game) });
  });

  it("answers 404, not a guess, when the file or the folder is missing", async () => {
    const base = await tmpDir("studio-serve-");
    assert.deepEqual(await resolveServed(base, "missing.js"), { ok: false, status: 404 });
    assert.deepEqual(await resolveServed(base, "no/such/dir/a.js"), { ok: false, status: 404 });
    assert.deepEqual(await resolveServed(path.join(base, "gone"), "index.html"), { ok: false, status: 404 });
    // A dangling link is missing too: nothing is read through it.
    fs.symlinkSync(path.join(base, "nowhere.txt"), path.join(base, "dangling.txt"));
    assert.deepEqual(await resolveServed(base, "dangling.txt"), { ok: false, status: 404 });
  });

  it("applies the same real-path check to the studio's vendor folder", async () => {
    const outside = await tmpDir("studio-outside-");
    const vendor = await tmpDir("studio-vendor-");
    touch(path.join(outside, "secret.txt"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vendor, "three.module.js"));
    const roots = { vendor, gameRoot: () => vendor };
    assert.deepEqual(await servedLocation("vendor/three.module.js", roots), { ok: false, status: 403 });
    assert.deepEqual(await servedLocation("vendor/missing.js", roots), { ok: false, status: 404 });
  });
});

describe("which http requests are the studio's", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("serves a game on the loopback port it was given, under either loopback name", () => {
    assert.deepEqual(routeHttp("http://localhost:41234/index.html", ports), { route: "serve", project: "pond-life" });
    assert.deepEqual(routeHttp(new URL("http://127.0.0.1:41234/src/main.js"), ports), {
      route: "serve",
      project: "pond-life",
    });
  });

  it("denies every other http request instead of fetching it from the main process (SECUI-3)", () => {
    // Flipped from the Stage 0 pin "passes every other http request through (current behaviour)".
    for (const url of [
      "http://localhost:41235/",
      "http://localhost/",
      "http://[::1]:41234/",
      "http://example.com:41234/",
      "http://localhost.evil:41234/",
      "http://example.com/",
    ]) {
      assert.deepEqual(routeHttp(url, ports), { route: "deny" }, url);
    }
  });
});

describe("what the game partition may request (SECUI-3)", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("allows the studio's own schemes and the game's registered loopback port", () => {
    for (const url of [
      "game://pond-life/index.html",
      "game://pond-life/vendor/three.module.js",
      "data:image/png;base64,AAAA",
      "blob:game://pond-life/1b4a2f",
      "devtools://devtools/bundled/devtools_app.html",
      "http://localhost:41234/index.html",
      "http://127.0.0.1:41234/assets/a.png",
    ])
      assert.equal(gameRequestAllowed(url, ports), true, url);
  });

  it("refuses the network: remote hosts, unregistered loopback ports and every other scheme", () => {
    for (const url of [
      "https://attacker.example/x",
      "http://attacker.example/x",
      "wss://attacker.example/socket",
      "ws://localhost:41234/",
      "https://localhost:41234/",
      "http://localhost:41235/",
      "http://localhost/",
      "http://[::1]:41234/",
      "http://localhost:41234@attacker.example/",
      "http://localhost.attacker.example:41234/",
      "file:///etc/passwd",
      "ftp://example.com/",
      "chrome-extension://abc/x.js",
      "not a url",
      "",
      // L2: other spellings of "this machine", which reach a server the game did not get.
      "http://localhost.:41234/",
      "http://0.0.0.0:41234/",
      "http://a.localhost:41234/",
      "http://[::ffff:127.0.0.1]:41234/",
      "filesystem:game://pond-life/temporary/x",
      "chrome://gpu",
    ])
      assert.equal(gameRequestAllowed(url, ports), false, url);
    // The URL parser lowercases the host: this is the registered origin, not another one.
    assert.equal(gameRequestAllowed("http://LOCALHOST:41234/", ports), true);
  });

  it("lets a game read its libraries and fonts from the well-known public CDNs, and nothing else there", () => {
    for (const url of [
      "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
      "https://unpkg.com/three@0.170.0/build/three.module.js",
      "https://esm.sh/three@0.170.0",
      "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
      "https://fonts.googleapis.com/css2?family=Inter",
      "https://fonts.gstatic.com/s/inter/v13/abc.woff2",
    ]) {
      assert.equal(gameRequestAllowed(url, ports, "GET"), true, url);
      assert.equal(gameRequestAllowed(url, ports, "HEAD"), true, url);
      assert.equal(gameRequestAllowed(url, ports), true, `${url} (method unknown means a read)`);
    }
    for (const [url, method] of [
      ["https://cdn.jsdelivr.net/npm/three/x.js", "POST"],
      ["https://unpkg.com/x", "PUT"],
      ["http://cdn.jsdelivr.net/npm/three/x.js", "GET"],
      ["wss://esm.sh/socket", "GET"],
      ["https://cdn.jsdelivr.net.attacker.example/x.js", "GET"],
      ["https://evil.cdn.jsdelivr.net/x.js", "GET"],
      ["https://cdn.jsdelivr.net@attacker.example/x.js", "GET"],
      ["https://attacker.example/?host=cdn.jsdelivr.net", "GET"],
      ["https://unpkg.com:8443/x.js", "GET"],
      // A punycode lookalike: Cyrillic "е" in jsdelivr.
      ["https://cdn.jsdеlivr.net/npm/three/x.js", "GET"],
      ["https://cdn.jsdelivr.net./npm/three/x.js", "GET"],
    ] as const)
      assert.equal(gameRequestAllowed(url, ports, method), false, `${method} ${url}`);
  });
});

describe("traffic the request filter never sees (M7)", () => {
  it("sends no WebRTC UDP around the proxy: ICE candidates would leave the machine unfiltered", () => {
    const policies: string[] = [];
    confinePreviewContents({ setWebRTCIPHandlingPolicy: (policy: string) => void policies.push(policy) });
    assert.deepEqual(policies, ["disable_non_proxied_udp"]);
  });
});

describe("where a game page may navigate (SECUI-3)", () => {
  const ports = new Map([[41234, "pond-life"]]);

  it("keeps the page on game:// and its registered loopback origin", () => {
    for (const url of [
      "game://pond-life/level-2.html",
      "http://localhost:41234/index.html?genex_local_test=1",
      "http://127.0.0.1:41234/",
    ]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), true, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), true, url);
    }
  });

  it("refuses a remote page in the preview, top level or embedded", () => {
    for (const url of [
      "https://attacker.example/sign-in",
      "http://attacker.example/",
      "http://localhost:41235/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "http://localhost.:41234/",
      "http://0.0.0.0:41234/",
      "http://a.localhost:41234/",
      "http://[::ffff:127.0.0.1]:41234/",
      "filesystem:game://pond-life/temporary/x",
      "chrome://gpu",
    ]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), false, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), false, url);
    }
  });

  it("lets an embedded frame hold content the page already has, never the top level", () => {
    for (const url of ["about:blank", "about:srcdoc", "data:text/html,<p>hi</p>", "blob:game://pond-life/1b4a2f"]) {
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: false }), true, url);
      assert.equal(previewNavigationAllowed(url, ports, { mainFrame: true }), false, url);
    }
  });
});

describe("a Unity WebGL build packed with Brotli or gzip", () => {
  it("is served unpacked, as the file inside; any other packed file is served as it is", () => {
    const rows: Array<[string, { packing: string; type: string } | null]> = [
      ["web/Build/web.wasm.br", { packing: "br", type: "application/wasm" }],
      ["web/Build/web.framework.js.br", { packing: "br", type: "text/javascript; charset=utf-8" }],
      ["web/Build/web.data.gz", { packing: "gzip", type: "application/octet-stream" }],
      ["web/Build/web.symbols.json.br", { packing: "br", type: "application/json" }],
      ["Build/arena.wasm.gz", { packing: "gzip", type: "application/wasm" }],
      ["web/Build/web.loader.js", null],
      ["web/Build/web.wasm", null],
      ["web/Build/web.data.unityweb", null],
      ["web/Build/.wasm.br", null],
      ["assets/level.json.gz", null],
      ["web/levels/map.data.gz", null],
      ["web/Build/notes.txt.br", null],
    ];
    for (const [relative, packed] of rows) assert.deepEqual(packedBuildFile(relative), packed, relative);
  });

  it("streams the file inside, never cached", async () => {
    const dir = await tmpDir("packed-build-");
    const wasm = Buffer.from("\0asm the arena's engine, as Unity wrote it");
    const packedFile = path.join(dir, "web.wasm.br");
    fs.writeFileSync(packedFile, zlib.brotliCompressSync(wasm));
    const response = unpackedResponse(packedFile, { packing: "br", type: "application/wasm" });
    assert.equal(response.headers.get("content-type"), "application/wasm");
    assert.equal(response.headers.get("content-encoding"), null, "the page gets the file itself");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), wasm);
    const gzipped = path.join(dir, "web.data.gz");
    fs.writeFileSync(gzipped, zlib.gzipSync(Buffer.from("the arena's data")));
    const data = unpackedResponse(gzipped, { packing: "gzip", type: "application/octet-stream" });
    assert.equal(await data.text(), "the arena's data");
  });
});
