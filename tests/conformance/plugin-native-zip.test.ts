import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractRuntimeZip } from "../../src/substrate/plugins/native-zip.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

function archive(entries: Array<{ name: string; text?: string; mode?: number; checksum?: number }>): Buffer {
  const locals: Buffer[] = [],
    records: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name),
      data = Buffer.from(item.text ?? "runtime"),
      compressed = deflateRawSync(data);
    const checksum = item.checksum ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    const part = Buffer.concat([local, name, compressed]);
    locals.push(part);
    records.push(Buffer.concat([record, name]));
    offset += part.length;
  }
  const central = Buffer.concat(records),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

test("portable runtime ZIP extracts spaced Unicode files and verifies deflate, lengths and CRC", async () => {
  const root = await tmpDir("runtime-zip-"),
    stage = path.join(root, "stage"),
    zip = path.join(root, "runtime.zip");
  await mkdir(stage);
  await writeFile(zip, archive([{ name: "Blender/данные file.txt", text: "asset" }, { name: "Blender/blender.exe" }]));
  await extractRuntimeZip(zip, stage, 100, new AbortController().signal);
  assert.equal(await readFile(path.join(stage, "Blender", "данные file.txt"), "utf8"), "asset");
});

test("hostile ZIP paths, duplicate names, links and over-budget archives fail before any extraction", async () => {
  for (const entries of [
    [{ name: "../outside" }],
    [{ name: "/absolute" }],
    [{ name: "C:/outside" }],
    [{ name: "Blender\\outside" }],
    [{ name: "Blender/data:stream" }],
    [{ name: "Blender/CON.txt" }],
    [{ name: "Blender/CONOUT$" }],
    [{ name: "Blender/COM¹.txt" }],
    [{ name: "Blender/trailing. " }],
    [{ name: "Blender/link", mode: 0o120777 }],
    [{ name: "Blender/a" }, { name: "Blender/A" }],
    [{ name: "Blender/a" }, { name: "Blender/a/file" }],
    [{ name: "Blender/too-large", text: "x".repeat(101) }],
  ]) {
    const root = await tmpDir("runtime-zip-hostile-"),
      stage = path.join(root, "stage"),
      zip = path.join(root, "runtime.zip");
    await mkdir(stage);
    await writeFile(zip, archive(entries));
    await assert.rejects(extractRuntimeZip(zip, stage, 100, new AbortController().signal), /archive/i);
    assert.deepEqual(await readdir(stage), []);
    assert.deepEqual((await readdir(root)).sort(), ["runtime.zip", "stage"]);
  }
});

test("corrupt ZIP payload and cancellation cannot produce a successful staged runtime", async () => {
  const root = await tmpDir("runtime-zip-corrupt-"),
    stage = path.join(root, "stage"),
    zip = path.join(root, "runtime.zip");
  await mkdir(stage);
  await writeFile(zip, archive([{ name: "Blender/blender.exe", checksum: 0 }]));
  await assert.rejects(extractRuntimeZip(zip, stage, 100, new AbortController().signal), /archive/i);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(extractRuntimeZip(zip, stage, 100, stop.signal), /abort/i);
});

test("runtime installation rejects an unverified staged binary and preserves the previous installation", async () => {
  const root = await tmpDir("runtime-zip-install-"),
    storage = path.join(root, "storage");
  const bytes = archive([{ name: "runtime/tool.exe" }, { name: "runtime/LICENSE" }]);
  const install = {
    action: "install",
    url: "https://example.invalid/runtime.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    unpackedBytes: 100,
    format: "zip",
    entry: "runtime",
    executable: "runtime/tool.exe",
    notices: ["runtime/LICENSE"],
  };
  const manifest = validateManifest({
    apiVersion: 3,
    id: "example",
    version: "1.0.0",
    name: "Example",
    publisher: "Test",
    description: "Test",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    nativeJobs: [],
    actions: [{ name: "install", label: "Install", confirmation: "Download runtime" }],
    nativeRuntimes: [
      {
        id: "runtime",
        label: "Runtime",
        candidates: ["storage:missing"],
        version: { args: ["--version"], pattern: "v(\\d+\\.\\d+\\.\\d+)", minimum: "24.0.0" },
        platforms: [{ platform: process.platform, arch: process.arch, candidates: ["storage:missing"], install }],
      },
    ],
  });
  const destination = path.join(storage, "runtimes", "runtime");
  await mkdir(path.join(storage, "runtime-downloads"), { recursive: true });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "previous.txt"), "preserve");
  await writeFile(path.join(storage, "runtime-downloads", "runtime.zip"), bytes);
  const service = new PluginNativeServices(root, []),
    signal = new AbortController().signal;
  await assert.rejects(
    service.call(
      manifest,
      root,
      storage,
      "runtime.install",
      { runtime: "runtime" },
      undefined,
      { method: "action", name: "install", signal },
      () => {},
    ),
    /probe|version/i,
  );
  assert.equal(await readFile(path.join(destination, "previous.txt"), "utf8"), "preserve");
  assert.deepEqual(await readdir(path.join(storage, "runtimes")), ["runtime"]);
  const record = JSON.parse(await readFile(path.join(storage, "runtime-install-runtime.json"), "utf8"));
  assert.equal(record.phase, "failed");
  assert.equal(record.active, false);
});
