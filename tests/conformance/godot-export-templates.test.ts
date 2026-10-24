/**
 * Godot's export templates read from the release's archive by byte ranges (`export-templates.ts`):
 * an archive Genex can't trust is refused before anything is written, a server that ignores ranges
 * is refused before its body is read, a dropped request is tried again, and a stop or a deadline
 * reaches every request.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { ExportTemplate, fetchTemplates } from "../../src/plugins/godot/export-templates.ts";
import { type GodotInstall, parseVersion } from "../../src/plugins/godot/find-godot.ts";
import { GODOT_461, templatesArchive } from "../helpers/godot-fake-engine.ts";
import { tmpDir } from "../helpers/tmp.ts";

const WEB = `templates/${ExportTemplate.Web}`;
const VERSION = "templates/version.txt";

/** An official Godot 4.6.1, as Genex finds one. */
function install(): GodotInstall {
  const version = parseVersion(GODOT_461);
  assert.ok(version);
  return { binary: "/Applications/Godot.app/Contents/MacOS/Godot", app: null, version, supported: true };
}

/** The offsets of an archive's parts, found by their signatures: its end record and its first central entry. */
function partsOf(archive: Buffer) {
  return {
    end: archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])),
    entry: archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])),
  };
}

/** A fresh templates folder and what is in it after a fetch of the Web template from `network`. */
async function fetchInto(network: ReturnType<typeof templatesArchive>, signal?: AbortSignal) {
  const folder = path.join(await tmpDir("godot-templates-"), "4.6.1.stable");
  const fetching = fetchTemplates(network.fetch, install(), folder, [ExportTemplate.Web], signal);
  const files = async () => readdir(folder).catch(() => [] as string[]);
  return { fetching, files };
}

describe("Godot's templates archive, read by ranges", () => {
  it("refuses an archive it can't trust before writing anything", async () => {
    const rows: Array<[string, (archive: Buffer) => void]> = [
      ["no end record", (archive) => archive.fill(0, partsOf(archive).end, partsOf(archive).end + 4)],
      ["a ZIP64 directory offset", (archive) => archive.writeUInt32LE(0xffffffff, partsOf(archive).end + 16)],
      [
        "a directory past the archive's end",
        (archive) => archive.writeUInt32LE(archive.length, partsOf(archive).end + 16),
      ],
      [
        "an entry larger than any template",
        (archive) => archive.writeUInt32LE(600 * 1024 * 1024, partsOf(archive).entry + 24),
      ],
      ["a local header with a wrong signature", (archive) => archive.writeUInt32LE(0x12345678, 0)],
      ["a deflated entry with no packed bytes", (archive) => archive.writeUInt32LE(0, partsOf(archive).entry + 20)],
      [
        "an entry past the archive's end",
        (archive) => archive.writeUInt32LE(archive.length, partsOf(archive).entry + 42),
      ],
    ];
    for (const [what, damage] of rows) {
      const network = templatesArchive({ [WEB]: "the web template", [VERSION]: "4.6.1.stable" });
      damage(network.archive);
      const { fetching, files } = await fetchInto(network);
      await assert.rejects(fetching, /isn't one Genex can read/, what);
      assert.deepEqual(await files(), [], `${what}: nothing written`);
    }
  });

  it("refuses a server that answers a range with the whole archive, cancelling its body unread", async () => {
    const network = templatesArchive({ [WEB]: "the web template" }, { ignoresRange: true });
    const { fetching, files } = await fetchInto(network);
    await assert.rejects(fetching, /HTTP 200 with the whole archive/);
    assert.equal(network.cancelled(), 1, "its body is cancelled, never read");
    assert.equal(network.asked.filter((asked) => asked !== "HEAD").length, 1, "and never asked again");
    assert.deepEqual(await files(), []);
  });

  it("tries a dropped request again, twice at most", async () => {
    const twice = templatesArchive({ [WEB]: "the web template", [VERSION]: "4.6.1.stable" }, { drops: 2 });
    const { fetching, files } = await fetchInto(twice);
    assert.deepEqual(await fetching, [ExportTemplate.Web]);
    assert.deepEqual((await files()).sort(), ["version.txt", ExportTemplate.Web]);
    const thrice = templatesArchive({ [WEB]: "the web template" }, { drops: 3 });
    const failing = await fetchInto(thrice);
    await assert.rejects(failing.fetching, /Couldn't download Godot's export templates \(fetch failed\)/);
    assert.deepEqual(thrice.asked, ["dropped", "dropped", "dropped"]);
  });

  it("lets two fetches of one template run at once, each writing under a name of its own", async () => {
    const folder = path.join(await tmpDir("godot-templates-"), "4.6.1.stable");
    const fetches = [0, 1].map(() => {
      const network = templatesArchive({ [WEB]: "the web template", [VERSION]: "4.6.1.stable" });
      return fetchTemplates(network.fetch, install(), folder, [ExportTemplate.Web]);
    });
    await Promise.all(fetches);
    assert.deepEqual((await readdir(folder)).sort(), ["version.txt", ExportTemplate.Web], "no half-written file left");
    assert.equal(await readFile(path.join(folder, ExportTemplate.Web), "utf8"), "the web template");
  });

  it("gives every request the caller's stop with its own deadline, and asks nothing once stopped", async () => {
    const network = templatesArchive({ [WEB]: "the web template", [VERSION]: "4.6.1.stable" });
    const caller = new AbortController();
    await (await fetchInto(network, caller.signal)).fetching;
    assert.ok(network.signals.length > 0);
    for (const signal of network.signals) assert.ok(signal instanceof AbortSignal, "every request can be stopped");
    caller.abort(new Error("stopped by the person"));
    assert.ok(
      network.signals.every((signal) => signal?.aborted),
      "the caller's stop reaches each one",
    );
    const later = templatesArchive({ [WEB]: "the web template" });
    const stopped = await fetchInto(later, caller.signal);
    await assert.rejects(stopped.fetching, /stopped by the person/);
    assert.deepEqual(later.asked, []);
  });
});
