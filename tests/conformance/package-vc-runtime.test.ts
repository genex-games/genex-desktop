/**
 * A Windows package carries the Visual C++ runtime DLLs its executables import, beside each
 * importer and for its architecture: Windows does not include them, and srt-win.exe exits
 * 0xC0000135 before it runs without vcruntime140.dll. Reads synthetic PE images
 * (helpers/pe-image.ts), copies from a stand-in redistributable folder, and drives the real
 * afterPrune hooks from forge.config.cjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import forgeConfig from "../../forge.config.cjs";
import vcRuntime from "../../scripts/package-vc-runtime.cjs";
import { dataDirectoryOffset, IMPORT_DIRECTORY, PeMachine, peImageBytes } from "../helpers/pe-image.ts";
import { tmpDir } from "../helpers/tmp.ts";

const { copyVcRuntime, crtFolder, missingVcRuntime, peImage } = vcRuntime;

const SRT_WIN = "node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win";
/** srt-win.exe's imports, as sandbox-runtime 0.0.73 links it (a shortened list). */
const SRT_WIN_IMPORTS = ["kernel32.dll", "advapi32.dll", "VCRUNTIME140.dll", "api-ms-win-crt-runtime-l1-1-0.dll"];

async function put(root: string, file: string, bytes: Buffer | string = ""): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/**
 * A stand-in Visual C++ redistributable version folder (`VC\Redist\MSVC\<version>`): each
 * architecture's runtime DLLs, `msvcp140.dll` importing `vcruntime140.dll` as the real one does.
 */
async function redistFolder(): Promise<string> {
  const redist = await tmpDir("studio-vc-redist-");
  const archs = [
    ["x64", PeMachine.X64],
    ["arm64", PeMachine.Arm64],
  ] as const;
  for (const [arch, machine] of archs) {
    const crt = `${arch}/Microsoft.VC143.CRT`;
    await put(redist, `${crt}/vcruntime140.dll`, peImageBytes({ machine, imports: ["KERNEL32.dll"] }));
    await put(redist, `${crt}/vcruntime140_1.dll`, peImageBytes({ machine, imports: ["KERNEL32.dll"] }));
    await put(redist, `${crt}/msvcp140.dll`, peImageBytes({ machine, imports: ["VCRUNTIME140.dll", "KERNEL32.dll"] }));
  }
  return redist;
}

/** The redistributable's runtime folder for an architecture, as the packaging step looks it up. */
const fromRedist = (redist: string) => (arch: string) => crtFolder(arch, { VCToolsRedistDir: redist });

test("reads a PE image's machine and the DLLs its import and delay-load tables name", () => {
  const cases = [
    { spec: { imports: ["KERNEL32.dll", "VCRUNTIME140.dll"] }, machine: PeMachine.X64 },
    { spec: { pe32: true, machine: PeMachine.X86, imports: ["msvcp140.dll"] }, machine: PeMachine.X86 },
    { spec: { machine: PeMachine.Arm64, delayed: ["concrt140.dll"] }, machine: PeMachine.Arm64 },
    {
      spec: { pe32: true, machine: PeMachine.X86, imports: ["a.dll"], delayed: ["b.dll"], delayedAsVa: true },
      machine: PeMachine.X86,
    },
    { spec: {}, machine: PeMachine.X64 },
  ];
  for (const { spec, machine } of cases) {
    const read = peImage(peImageBytes(spec));
    assert.equal(read.machine, machine, JSON.stringify(spec));
    assert.deepEqual(read.imports, [...(spec.imports ?? []), ...(spec.delayed ?? [])], JSON.stringify(spec));
  }
});

test("bytes that are not a well-formed PE image are refused as such, never read past their end", () => {
  const image = peImageBytes({ imports: ["VCRUNTIME140.dll"] });
  const edited = (edit: (bytes: Buffer) => void) => {
    const bytes = Buffer.from(image);
    edit(bytes);
    return bytes;
  };
  const hostile: Array<[string, Buffer]> = [
    ["empty", Buffer.alloc(0)],
    ["only the DOS magic", Buffer.from("MZ")],
    ["a script named .exe", Buffer.from("#!/bin/sh\necho hi\n")],
    ["wrong DOS magic", edited((b) => b.writeUInt16LE(0x4d5a, 0))],
    ["PE header offset past the end", edited((b) => b.writeUInt32LE(0xfffffff0, 0x3c))],
    ["wrong PE signature", edited((b) => b.writeUInt32LE(0x00004551, 0x40))],
    ["unknown optional header magic", edited((b) => b.writeUInt16LE(0x107, 0x58))],
    [
      "import table outside every section",
      edited((b) => b.writeUInt32LE(0x7fff0000, dataDirectoryOffset(IMPORT_DIRECTORY))),
    ],
    ["DLL name without its terminator", image.subarray(0, image.length - 1)],
    ["headers cut short", image.subarray(0, 0x100)],
  ];
  for (const [name, bytes] of hostile) {
    assert.throws(() => peImage(bytes), { message: "not a PE image" }, name);
  }
});

test("lists each file whose Visual C++ runtime imports have no copy of its architecture beside it", async () => {
  const app = await tmpDir("studio-vc-missing-");
  await put(app, "a/srt-win.exe", peImageBytes({ imports: SRT_WIN_IMPORTS }));
  await put(app, "b/both.exe", peImageBytes({ imports: ["MSVCP140.dll"], delayed: ["vcruntime140_1.dll"] }));
  // Present beside it, whatever the case of its name.
  await put(app, "c/fine.exe", peImageBytes({ imports: ["VCRUNTIME140.dll"] }));
  await put(app, "c/vcruntime140.dll", peImageBytes({ imports: ["KERNEL32.dll"] }));
  // Present, but for another architecture: Windows would refuse to load it.
  await put(app, "d/arm.exe", peImageBytes({ machine: PeMachine.Arm64, imports: ["vcruntime140.dll"] }));
  await put(app, "d/vcruntime140.dll", peImageBytes({ imports: ["KERNEL32.dll"] }));
  // Windows' own C runtimes are no gap.
  await put(
    app,
    "e/system.dll",
    peImageBytes({ imports: ["msvcrt.dll", "ucrtbase.dll", "api-ms-win-crt-heap-l1-1-0.dll"] }),
  );
  await put(app, "e/addon.node", peImageBytes({ imports: ["node.exe", "KERNEL32.dll"] }));
  await put(app, "f/broken.dll", "not an image");
  await put(app, "f/readme.txt", "VCRUNTIME140.dll");

  const found = (await missingVcRuntime(app)).map(({ file, machine, missing, error }) => ({
    file: path.relative(app, file).split(path.sep).join("/"),
    machine,
    missing,
    error,
  }));
  assert.deepEqual(
    found.sort((x, y) => x.file.localeCompare(y.file)),
    [
      { file: "a/srt-win.exe", machine: PeMachine.X64, missing: ["vcruntime140.dll"], error: undefined },
      { file: "b/both.exe", machine: PeMachine.X64, missing: ["msvcp140.dll", "vcruntime140_1.dll"], error: undefined },
      { file: "d/arm.exe", machine: PeMachine.Arm64, missing: ["vcruntime140.dll"], error: undefined },
      { file: "f/broken.dll", machine: null, missing: [], error: "not a PE image" },
    ],
  );
});

test("a Windows package gets each runtime DLL beside its importer, for its architecture, and the DLLs those need", async () => {
  const redist = await redistFolder();
  const app = await tmpDir("studio-vc-copy-");
  await put(app, `${SRT_WIN}/x64/srt-win.exe`, peImageBytes({ imports: SRT_WIN_IMPORTS }));
  await put(app, "arm/tool.exe", peImageBytes({ machine: PeMachine.Arm64, imports: ["vcruntime140.dll"] }));
  await put(app, "cpp/tool.exe", peImageBytes({ imports: ["MSVCP140.dll"] }));
  await put(app, "plain/tool.exe", peImageBytes({ imports: ["KERNEL32.dll"] }));

  const copies = await copyVcRuntime(app, "win32", fromRedist(redist));

  assert.deepEqual(copies.map((file) => path.relative(app, file).split(path.sep).join("/")).sort(), [
    "arm/vcruntime140.dll",
    "cpp/msvcp140.dll",
    "cpp/vcruntime140.dll",
    `${SRT_WIN}/x64/vcruntime140.dll`,
  ]);
  assert.deepEqual(await missingVcRuntime(app), []);
  const copied = await readFile(path.join(app, SRT_WIN, "x64", "vcruntime140.dll"));
  assert.deepEqual(copied, await readFile(path.join(redist, "x64", "Microsoft.VC143.CRT", "vcruntime140.dll")));
  assert.equal(peImage(await readFile(path.join(app, "arm", "vcruntime140.dll"))).machine, PeMachine.Arm64);
  assert.deepEqual(await files(path.join(app, "plain")), ["tool.exe"]);
});

test("only Windows packages get runtime DLLs, and one that needs none is left as it is", async () => {
  const redist = await redistFolder();
  const app = await tmpDir("studio-vc-other-");
  await put(app, "srt-win.exe", peImageBytes({ imports: SRT_WIN_IMPORTS }));
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(await copyVcRuntime(app, platform, fromRedist(redist)), []);
  }
  assert.deepEqual(await files(app), ["srt-win.exe"]);
  const clean = await tmpDir("studio-vc-clean-");
  await put(clean, "tool.exe", peImageBytes({ imports: ["KERNEL32.dll"] }));
  let asked = 0;
  const copies = await copyVcRuntime(clean, "win32", () => {
    asked += 1;
    return null;
  });
  assert.deepEqual(copies, []);
  assert.equal(asked, 0, "no redistributable is looked for when nothing needs one");
});

test("packaging stops when a needed runtime DLL has no source, and copies nothing", async () => {
  const redist = await redistFolder();
  const cases = [
    {
      name: "no redistributable",
      imports: ["VCRUNTIME140.dll"],
      crt: () => null,
      message: /vcruntime140\.dll \(x64\).*VCToolsRedistDir/,
    },
    {
      name: "a DLL the redistributable lacks",
      imports: ["mfc140u.dll"],
      crt: fromRedist(redist),
      message: /mfc140u\.dll is not in/,
    },
  ];
  for (const { name, imports, crt, message } of cases) {
    const app = await tmpDir("studio-vc-none-");
    await put(app, "tool.exe", peImageBytes({ imports }));
    await assert.rejects(copyVcRuntime(app, "win32", crt), message, name);
    assert.deepEqual(await files(app), ["tool.exe"], name);
  }
});

test("an import named like a path is no runtime DLL: nothing is written outside its importer's folder", async () => {
  const redist = await redistFolder();
  const root = await tmpDir("studio-vc-paths-");
  const hostile = [
    "../vcruntime140.dll",
    "..\\vcruntime140.dll",
    "C:\\Windows\\System32\\vcruntime140.dll",
    "/tmp/vcruntime140.dll",
    "vcruntime140.dll/../../x.dll",
    "sub\\msvcp140.dll",
  ];
  await put(root, "app/deep/tool.exe", peImageBytes({ imports: hostile }));
  assert.deepEqual(await missingVcRuntime(path.join(root, "app")), []);
  assert.deepEqual(await copyVcRuntime(path.join(root, "app"), "win32", fromRedist(redist)), []);
  assert.deepEqual(await files(root), ["app/deep/tool.exe"]);
});

test("the redistributable's runtime folder: the newest Microsoft.VC14x.CRT of the architecture asked", async () => {
  const redist = await tmpDir("studio-vc-find-");
  await put(redist, "x64/Microsoft.VC143.CRT/vcruntime140.dll");
  await put(redist, "x64/Microsoft.VC145.CRT/vcruntime140.dll");
  await put(redist, "x64/Microsoft.VC145.OpenMP/vcomp140.dll");
  await put(redist, "arm64/Microsoft.VC143.CRT/vcruntime140.dll");
  const env = { VCToolsRedistDir: redist };
  assert.equal(crtFolder("x64", env), path.join(redist, "x64", "Microsoft.VC145.CRT"));
  assert.equal(crtFolder("arm64", env), path.join(redist, "arm64", "Microsoft.VC143.CRT"));
  assert.equal(crtFolder("x86", env), null);
  if (process.platform !== "win32") assert.equal(crtFolder("x64", {}), null);
});

test("Forge's afterPrune leaves a Windows package's srt-win.exe with vcruntime140.dll beside it", async (t) => {
  const redist = await redistFolder();
  const saved = process.env.VCToolsRedistDir;
  process.env.VCToolsRedistDir = redist;
  t.after(() => {
    if (saved === undefined) delete process.env.VCToolsRedistDir;
    else process.env.VCToolsRedistDir = saved;
  });
  const app = await tmpDir("studio-vc-forge-");
  const pkg = (name: string, fields = {}) => JSON.stringify({ name, version: "1.0.0", ...fields });
  await put(app, "package.json", pkg("ai-game-studio", { dependencies: { "@anthropic-ai/sandbox-runtime": "1" } }));
  await put(app, "node_modules/@anthropic-ai/sandbox-runtime/package.json", pkg("@anthropic-ai/sandbox-runtime"));
  for (const arch of ["x64", "arm64"]) {
    const machine = arch === "x64" ? PeMachine.X64 : PeMachine.Arm64;
    await put(app, `${SRT_WIN}/${arch}/srt-win.exe`, peImageBytes({ machine, imports: SRT_WIN_IMPORTS }));
  }
  type Hook = (options: { buildPath: string; electronVersion: string; platform: string; arch: string }) => unknown;
  for (const hook of forgeConfig.packagerConfig.afterPrune as Hook[]) {
    await hook({ buildPath: app, electronVersion: "43.7.6", platform: "win32", arch: "x64" });
  }
  assert.deepEqual(await files(path.join(app, SRT_WIN)), ["x64/srt-win.exe", "x64/vcruntime140.dll"]);
  assert.deepEqual(await missingVcRuntime(app), []);
});
