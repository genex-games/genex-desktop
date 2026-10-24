/**
 * The showcase scenes' fetched assets (`scripts/showcase-assets.ts`): each scene's committed
 * manifest (the lakeside's and Harbour Street's) is CC0-only, pinned and on allowlisted hosts; the
 * command names a known scene; a hostile URL, file name or licence is refused before
 * anything downloads; and a download is cached only when its size and sha256 match, so a bad
 * byte never reaches the cache. The network is a stub here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  AssetError,
  AssetRefusal,
  ALLOWED_HOSTS,
  CC0,
  cachedPath,
  checkedUrl,
  checkManifest,
  fetchFile,
  type Manifest,
  type ManifestAsset,
  type ManifestFile,
  parseArgs,
  SCENES,
  ShowcaseScene,
  sha256,
} from "../../scripts/showcase-assets.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SCRIPT = path.join(import.meta.dirname, "..", "..", "scripts", "showcase-assets.ts");
const USAGE = "node scripts/showcase-assets.ts fetch [--scene lakeside|harbour-street] [--pin] [--install]";

const BYTES = new TextEncoder().encode("a CC0 texture");
const GOOD_URL = "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/dirt/dirt_diff_1k.jpg";

function file(over: Partial<ManifestFile> = {}): ManifestFile {
  return {
    map: "diff",
    name: "dirt_diff_1k.jpg",
    url: GOOD_URL,
    bytes: BYTES.byteLength,
    sha256: sha256(BYTES),
    ...over,
  };
}

function asset(over: Partial<ManifestAsset> = {}): ManifestAsset {
  return { id: "dirt", kind: "texture", licence: CC0, files: [file()], ...over };
}

function refusal(run: () => unknown): AssetRefusal | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AssetError) return error.code;
    throw error;
  }
  return undefined;
}

async function refusalOf(run: () => Promise<unknown>): Promise<AssetRefusal | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AssetError) return error.code;
    throw error;
  }
  return undefined;
}

describe("the committed manifests", () => {
  for (const scene of Object.values(ShowcaseScene)) {
    it(`${scene}: lists only CC0 assets, every file pinned to its sha256 on an allowlisted host`, async () => {
      const manifest = JSON.parse(await readFile(SCENES[scene].manifest, "utf8")) as Manifest;
      checkManifest(manifest);
      for (const entry of manifest.assets) {
        assert.equal(entry.licence, CC0, entry.id);
        for (const item of entry.files) {
          assert.match(item.sha256 ?? "", /^[0-9a-f]{64}$/, `${entry.id}/${item.name} is pinned`);
          assert.ok(ALLOWED_HOSTS.has(new URL(item.url).hostname), item.url);
        }
      }
    });
  }

  it("keeps each scene's manifest, cache and installed copy apart", () => {
    const folders = Object.values(SCENES).flatMap((scene) => [scene.manifest, scene.cache, scene.installed]);
    assert.equal(new Set(folders).size, folders.length, "no two scenes share a manifest, cache or install folder");
  });
});

describe("the command line", () => {
  it("fetches the lakeside by default and another scene by --scene", () => {
    assert.deepEqual(parseArgs(["fetch"]), { scene: ShowcaseScene.Lakeside, pin: false, install: false });
    assert.deepEqual(parseArgs(["fetch", "--scene", ShowcaseScene.HarbourStreet, "--pin"]), {
      scene: ShowcaseScene.HarbourStreet,
      pin: true,
      install: false,
    });
    assert.deepEqual(parseArgs(["fetch", "--install", "--scene", ShowcaseScene.Lakeside]), {
      scene: ShowcaseScene.Lakeside,
      pin: false,
      install: true,
    });
  });

  const refused: [string, string[]][] = [
    ["no command", []],
    ["another command", ["download"]],
    ["an unknown flag", ["fetch", "--force"]],
    ["an unknown scene", ["fetch", "--scene", "moon-base"]],
    ["a scene that names a path", ["fetch", "--scene", "../lakeside"]],
    ["--scene with no value", ["fetch", "--scene"]],
  ];
  for (const [what, argv] of refused) {
    it(`refuses ${what}`, () => {
      assert.equal(
        refusal(() => parseArgs(argv)),
        AssetRefusal.Usage,
      );
    });
  }
});

describe("the command's refusals", () => {
  it("keeps every refusal's wire spelling", () => {
    const spelled = [
      "usage",
      "manifest-invalid",
      "host-not-allowed",
      "licence-not-cc0",
      "unsafe-name",
      "unpinned",
      "download-failed",
      "size-mismatch",
      "hash-mismatch",
      "process-failed",
    ];
    const values: readonly string[] = Object.values(AssetRefusal);
    for (const code of spelled) assert.ok(values.includes(code), code);
  });

  for (const argv of [["download"], ["fetch", "--scene", "moon-base"]]) {
    it(`prints one refusal line and exits 78 for ${argv.join(" ")}`, () => {
      const run = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8" });
      assert.equal(run.status, 78);
      assert.equal(run.stdout, "");
      assert.equal(
        run.stderr,
        `genex-showcase-assets-refusal: ${JSON.stringify({ code: AssetRefusal.Usage, detail: USAGE })}\n`,
      );
    });
  }
});

describe("Quaternius' CC0 packs on OpenGameArt (owner call AN-21)", () => {
  it("allows a manifest row on OpenGameArt's file store", () => {
    const url = "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip";
    assert.equal(checkedUrl(url).hostname, "opengameart.org");
    assert.equal(
      refusal(() => checkManifest({ assets: [asset({ files: [file({ url })] })] })),
      undefined,
    );
  });
});

describe("hostile manifest rows are refused before anything downloads", () => {
  const urls: [string, string, AssetRefusal][] = [
    ["plain http", "http://dl.polyhaven.org/file/a.jpg", AssetRefusal.HostNotAllowed],
    ["another host", "https://example.com/a.jpg", AssetRefusal.HostNotAllowed],
    [
      "a host that only ends like an allowed one",
      "https://evil-dl.polyhaven.org.example.com/a.jpg",
      AssetRefusal.HostNotAllowed,
    ],
    ["credentials in the URL", "https://user:pass@dl.polyhaven.org/a.jpg", AssetRefusal.HostNotAllowed],
    ["another port", "https://dl.polyhaven.org:8443/a.jpg", AssetRefusal.HostNotAllowed],
    ["not a URL", "dl.polyhaven.org/a.jpg", AssetRefusal.ManifestInvalid],
    ["OpenGameArt over plain http", "http://opengameart.org/sites/default/files/a.zip", AssetRefusal.HostNotAllowed],
    [
      "OpenGameArt with credentials",
      "https://u:p@opengameart.org/sites/default/files/a.zip",
      AssetRefusal.HostNotAllowed,
    ],
    [
      "OpenGameArt on another port",
      "https://opengameart.org:8443/sites/default/files/a.zip",
      AssetRefusal.HostNotAllowed,
    ],
    [
      "a subdomain of OpenGameArt",
      "https://www.opengameart.org/sites/default/files/a.zip",
      AssetRefusal.HostNotAllowed,
    ],
  ];
  for (const [what, url, code] of urls) {
    it(`refuses ${what}`, () => {
      assert.equal(
        refusal(() => checkedUrl(url)),
        code,
      );
      assert.equal(
        refusal(() => checkManifest({ assets: [asset({ files: [file({ url })] })] })),
        code,
      );
    });
  }

  const names: [string, string][] = [
    ["a parent folder", "../escape.jpg"],
    ["a nested path", "textures/dirt.jpg"],
    ["a hidden file", ".dirt.jpg"],
    ["an absolute path", "/etc/passwd"],
    ["an empty name", ""],
    ["a backslash", "dirt\\diff.jpg"],
  ];
  for (const [what, name] of names) {
    it(`refuses a file name with ${what}`, () => {
      assert.equal(
        refusal(() => checkManifest({ assets: [asset({ files: [file({ name })] })] })),
        AssetRefusal.UnsafeName,
      );
    });
    it(`refuses an asset id with ${what}`, () => {
      assert.equal(
        refusal(() => checkManifest({ assets: [asset({ id: name })] })),
        AssetRefusal.UnsafeName,
      );
    });
  }

  it("refuses an asset that is not CC0", () => {
    assert.equal(
      refusal(() => checkManifest({ assets: [asset({ licence: "CC-BY-4.0" })] })),
      AssetRefusal.NotCc0,
    );
  });

  it("refuses an empty manifest and a malformed digest", () => {
    assert.equal(
      refusal(() => checkManifest({ assets: [] })),
      AssetRefusal.ManifestInvalid,
    );
    assert.equal(
      refusal(() => checkManifest({ assets: [asset({ files: [file({ sha256: "not-a-digest" })] })] })),
      AssetRefusal.ManifestInvalid,
    );
  });
});

describe("a download is cached only when it is the pinned file", () => {
  async function setup() {
    const raw = await tmpDir("showcase-assets-");
    const target = cachedPath(raw, asset(), file());
    return { raw, target };
  }

  async function nothingWritten(raw: string, target: string) {
    assert.equal(existsSync(target), false, "the target is not written");
    assert.equal(existsSync(`${target}.partial`), false, "no partial file is left");
    const left = existsSync(path.dirname(target)) ? await readdir(path.dirname(target)) : [];
    assert.deepEqual(left, [], `nothing under ${raw}`);
  }

  it("writes a matching download into place", async () => {
    const { target } = await setup();
    await fetchFile(file(), target, false, async () => BYTES);
    assert.deepEqual(new Uint8Array(await readFile(target)), BYTES);
  });

  it("refuses a download whose sha256 differs from the pin and writes nothing", async () => {
    const { raw, target } = await setup();
    const tampered = new TextEncoder().encode("a CC0 textur!");
    assert.equal(
      await refusalOf(() => fetchFile(file(), target, false, async () => tampered)),
      AssetRefusal.HashMismatch,
    );
    await nothingWritten(raw, target);
  });

  it("refuses a download of another size and writes nothing", async () => {
    const { raw, target } = await setup();
    assert.equal(
      await refusalOf(() => fetchFile(file(), target, false, async () => BYTES.slice(1))),
      AssetRefusal.SizeMismatch,
    );
    await nothingWritten(raw, target);
  });

  it("refuses an unpinned file without --pin and records its digest with it", async () => {
    const { raw, target } = await setup();
    const unpinned = file({ sha256: null });
    assert.equal(await refusalOf(() => fetchFile(unpinned, target, false, async () => BYTES)), AssetRefusal.Unpinned);
    await nothingWritten(raw, target);
    await fetchFile(unpinned, target, true, async () => BYTES);
    assert.equal(unpinned.sha256, sha256(BYTES));
  });

  it("keeps a cached file that matches its pin without downloading again", async () => {
    const { target } = await setup();
    await fetchFile(file(), target, false, async () => BYTES);
    let asked = 0;
    await fetchFile(file(), target, false, async () => {
      asked += 1;
      return BYTES;
    });
    assert.equal(asked, 0);
  });

  it("downloads again over a cached file that no longer matches its pin", async () => {
    const { target } = await setup();
    await fetchFile(file(), target, false, async () => BYTES);
    await writeFile(target, "corrupted");
    await fetchFile(file(), target, false, async () => BYTES);
    assert.deepEqual(new Uint8Array(await readFile(target)), BYTES);
  });
});
