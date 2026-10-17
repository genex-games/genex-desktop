import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exportPublicGame } from "../../src/substrate/game-export.ts";

it("exports public runtime files without nested credentials or private directories; fails safely on symlinks", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-"));
  const source = path.join(temp, "game"),
    target = path.join(temp, "public");
  try {
    await mkdir(path.join(source, "assets"), { recursive: true });
    await mkdir(path.join(source, "src"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(path.join(source, "assets/texture.png"), "fixture");
    for (const p of [
      ".env",
      "private.pem",
      "assets/.env",
      "assets/private.key",
      "assets/production.env",
      "src/env.local",
      "assets/keys.jks",
    ])
      await writeFile(path.join(source, p), "PRIVATE FIXTURE");
    const result = await exportPublicGame(source, target, ["index.html", "src", "assets", ".env", "private.pem"]);
    assert.deepEqual(result.included.sort(), ["assets/texture.png", "index.html", "src/main.js"]);
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "missing-public-file"]),
      /Selected public path is missing/,
    );
    assert.equal(await readFile(path.join(target, "assets/.env"), "utf8").catch(() => null), null);
    await symlink(path.join(source, ".env"), path.join(source, "assets/leak.txt"));
    await assert.rejects(exportPublicGame(source, target, ["index.html", "src", "assets"]), /symlink/);
    assert.match(await readFile(path.join(target, "index.html"), "utf8"), /main.js/);
    await assert.rejects(exportPublicGame(source, path.join(source, "export"), ["index.html"]), /outside/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("ships Studio's Genex SDK, with its licenses, only in a game that maps it", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-genex-"));
  const game = path.join(temp, "game"),
    vendor = path.join(temp, "vendor");
  try {
    await mkdir(game);
    await mkdir(path.join(vendor, "genex"), { recursive: true });
    await writeFile(path.join(vendor, "three.module.js"), "export const REVISION = 'test';");
    await writeFile(path.join(vendor, "three-LICENSE"), "three notice");
    await writeFile(path.join(vendor, "genex", "multiplayer.js"), 'export * from "./chunk-A.js";');
    await writeFile(path.join(vendor, "genex", "chunk-A.js"), "export const connect = () => {};");
    await writeFile(path.join(vendor, "genex", "embed-sdk.js"), "export const waitForPlayer = () => {};");
    await writeFile(path.join(vendor, "genex", "LICENSES.md"), "colyseus notice");
    await writeFile(path.join(vendor, "genex", "VERSION.json"), "{}");
    const page = (imports: Record<string, string>) =>
      `<script type="importmap">${JSON.stringify({ imports: { three: "/vendor/three.module.js", ...imports } })}</script><script type="module" src="./main.js"></script>`;
    await writeFile(path.join(game, "index.html"), page({}));
    await writeFile(path.join(game, "main.js"), 'import * as THREE from "three"; console.log(THREE);');
    const solo = await exportPublicGame(game, path.join(temp, "solo"), ["index.html", "main.js"], vendor);
    assert.deepEqual(
      solo.included.filter((rel) => rel.startsWith("vendor/genex/")),
      [],
      "a single-player game carries none of it, licenses included",
    );
    assert.ok(solo.included.includes("vendor/three-LICENSE"), "the vendor root's own notices stay");

    await writeFile(
      path.join(game, "index.html"),
      page({
        "@genex-ai/multiplayer": "/vendor/genex/multiplayer.js",
        "@genex-ai/embed-sdk": "/vendor/genex/embed-sdk.js",
      }),
    );
    await writeFile(
      path.join(game, "main.js"),
      'import { connect } from "@genex-ai/multiplayer"; console.log(connect);',
    );
    const online = await exportPublicGame(game, path.join(temp, "online"), ["index.html", "main.js"], vendor);
    for (const rel of ["multiplayer.js", "chunk-A.js", "embed-sdk.js", "LICENSES.md", "VERSION.json"])
      assert.ok(online.included.includes(`vendor/genex/${rel}`), rel);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("validates module dependencies, ignores commented examples and keeps only reachable vendored files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-modules-"));
  const game = path.join(temp, "game"),
    vendor = path.join(temp, "vendor");
  try {
    await mkdir(game);
    await mkdir(vendor);
    await writeFile(
      path.join(game, "index.html"),
      '<script type="importmap">{"imports":{"engine":"/vendor/engine.js"}}</script><script type="module" src="./main.js"></script>',
    );
    await writeFile(
      path.join(game, "main.js"),
      '// import "./not-real.js";\nimport {value} from "engine"; console.log(value);',
    );
    await writeFile(path.join(vendor, "engine.js"), 'export {value} from "./part.js";');
    await writeFile(path.join(vendor, "part.js"), "export const value=1;");
    await writeFile(path.join(vendor, "unused.js"), 'import "./missing-example.js";');
    await writeFile(path.join(vendor, "LICENSE"), "notice");
    const result = await exportPublicGame(game, path.join(temp, "public"), ["index.html", "main.js"], vendor);
    assert.ok(result.included.includes("vendor/part.js"));
    assert.ok(result.included.includes("vendor/LICENSE"));
    assert.ok(!result.included.includes("vendor/unused.js"));
    await writeFile(path.join(game, "main.js"), 'import "./missing.js";');
    await assert.rejects(
      exportPublicGame(game, path.join(temp, "public"), ["index.html", "main.js"], vendor),
      /missing.js/,
    );
    assert.match(
      await readFile(path.join(temp, "public/main.js"), "utf8"),
      /not-real/,
      "a failed replacement preserves the last valid export",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("refuses to export a file that holds a credential Studio knows, and leaves the last export in place (SEC-6)", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-export-secrets-"));
  const source = path.join(temp, "game"),
    target = path.join(temp, "public");
  const secret = "genex-FAKE-token-value";
  try {
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "assets"));
    await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(path.join(source, "assets/data.bin"), Buffer.from([1, 2, 3]));
    await exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, {
      secretValues: [secret, "short"],
    });
    await writeFile(path.join(source, "src/main.js"), `const KEY='${secret}';console.log("game")`);
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      (error: Error) => {
        assert.match(error.message, /src\/main\.js/);
        assert.equal(error.message.includes(secret), false, "the refusal does not repeat the value");
        return true;
      },
    );
    assert.equal(
      await readFile(path.join(target, "src/main.js"), "utf8"),
      'console.log("game")',
      "the previous export is untouched",
    );
    await writeFile(path.join(source, "src/main.js"), 'console.log("game")');
    await writeFile(
      path.join(source, "assets/data.bin"),
      Buffer.concat([Buffer.from([0, 1]), Buffer.from(secret), Buffer.from([2])]),
    );
    await assert.rejects(
      exportPublicGame(source, target, ["index.html", "src", "assets"], undefined, { secretValues: [secret] }),
      /assets\/data\.bin/,
      "binary files are checked too",
    );
    const names = (await readdir(temp)).filter((n) => n.startsWith(".studio-export-"));
    assert.deepEqual(names, [], "no staging directory is left behind");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
