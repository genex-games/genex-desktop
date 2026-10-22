/**
 * The Visual C++ runtime in a Windows package. Windows carries the Universal CRT but not the
 * Visual C++ 2015-2022 runtime (`vcruntime140.dll`, `msvcp140.dll`, ...): a program linked
 * against it exits 0xC0000135 (STATUS_DLL_NOT_FOUND) before it runs on a PC where no installer
 * put those DLLs in System32. sandbox-runtime's `srt-win.exe` is one such program.
 *
 * Forge's afterPrune hook (forge.config.cjs) reads the imports of every executable and DLL in the
 * copied app and puts each runtime DLL one of them needs beside it, for its architecture
 * (Microsoft's app-local deployment), from the Visual C++ redistributable folder of the Visual
 * Studio on the build machine. The packaged smoke reads the finished package the same way and
 * fails on a runtime import that has no copy beside its importer.
 */
const { execFileSync } = require("node:child_process");
const { existsSync, readdirSync } = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");

/** Files Windows loads as code: executables, DLLs and Node addons. */
const PE_FILE = /\.(?:exe|dll|node)$/i;
/**
 * DLLs of the Visual C++ redistributable, which Windows does not include: the 2015-2022 runtime
 * (`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140*.dll`, `concrt140.dll`, `vccorlib140.dll`,
 * `vcomp140.dll`, `vcamp140.dll`), MFC, and the older versioned `msvcr*`/`msvcp*` runtimes.
 * Windows' own `msvcrt.dll` and the Universal CRT (`ucrtbase.dll`, `api-ms-win-crt-*`) are not.
 */
const VC_RUNTIME_DLL =
  /^(?:vcruntime\d+(?:_\d+)?|msvc[pr]\d+(?:_[a-z0-9]+)?|concrt\d+|vccorlib\d+|vcomp\d+|vcamp\d+|mfc\d+[a-z]*)\.dll$/i;
/** The redistributable's architecture folder (`VC\Redist\MSVC\<version>\<arch>`) by PE machine type. */
const REDIST_ARCH = new Map([
  [0x14c, "x86"],
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);
/** The redistributable's runtime folder inside an architecture folder. */
const CRT_FOLDER = /^Microsoft\.VC\d+\.CRT$/i;
/** Where the Visual Studio Installer keeps vswhere, which finds the installed Visual Studio. */
const VSWHERE = path.win32.join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe",
);
/**
 * Copy rounds before giving up: a copied DLL can import another (msvcp140.dll needs
 * vcruntime140.dll), and every round reads the copies made by the one before.
 */
const MAX_COPY_ROUNDS = 4;

/** PE layout: offsets and sizes from the PE/COFF specification. */
const PE = {
  DosMagic: 0x5a4d,
  LfanewOffset: 0x3c,
  Signature: 0x00004550,
  CoffSize: 20,
  SectionSize: 40,
  ImportDescriptorSize: 20,
  DelayDescriptorSize: 32,
  Pe32: 0x10b,
  Pe32Plus: 0x20b,
  ImportDirectory: 1,
  DelayImportDirectory: 13,
};
/** A cap on descriptors per directory, so a corrupt table cannot loop for long. */
const MAX_DESCRIPTORS = 4096;
/** A cap on one DLL name's length. */
const MAX_NAME = 512;

const MESSAGE = {
  notPe: "not a PE image",
  noRedist: (dlls, arch) =>
    `The Windows package needs ${dlls.join(", ")} (${arch}) beside the files that import them, and no Visual C++ redistributable folder was found: install Visual Studio's C++ build tools or set VCToolsRedistDir`,
  unknownMachine: (file, machine) => `${file}: no Visual C++ redistributable for PE machine 0x${machine.toString(16)}`,
  missingDll: (dll, dir) => `${dll} is not in the Visual C++ redistributable folder ${dir}`,
  rounds: (left) => `Visual C++ runtime DLLs still missing after ${MAX_COPY_ROUNDS} rounds: ${left}`,
};

/** A bounds-checked reader over a PE file's bytes; any read past the end means a malformed file. */
function reader(bytes) {
  const at = (offset, size) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) throw new Error(MESSAGE.notPe);
    return offset;
  };
  return {
    u16: (offset) => bytes.readUInt16LE(at(offset, 2)),
    u32: (offset) => bytes.readUInt32LE(at(offset, 4)),
    u64: (offset) => Number(bytes.readBigUInt64LE(at(offset, 8))),
    /** The NUL-terminated ASCII string at `offset`. */
    name: (offset) => {
      const end = bytes.indexOf(0, at(offset, 1));
      if (end < 0 || end - offset > MAX_NAME) throw new Error(MESSAGE.notPe);
      return bytes.toString("latin1", offset, end);
    },
  };
}

/** The file offset of an RVA, by the section that maps it. */
function fileOffset(sections, rva) {
  const section = sections.find((s) => rva >= s.address && rva < s.address + Math.max(s.virtualSize, s.rawSize));
  if (!section) throw new Error(MESSAGE.notPe);
  return rva - section.address + section.rawPointer;
}

/** The headers a PE file's import tables are read through. */
function peHeaders(read) {
  if (read.u16(0) !== PE.DosMagic) throw new Error(MESSAGE.notPe);
  const pe = read.u32(PE.LfanewOffset);
  if (read.u32(pe) !== PE.Signature) throw new Error(MESSAGE.notPe);
  const coff = pe + 4;
  const optional = coff + PE.CoffSize;
  const magic = read.u16(optional);
  if (magic !== PE.Pe32 && magic !== PE.Pe32Plus) throw new Error(MESSAGE.notPe);
  const plus = magic === PE.Pe32Plus;
  const imageBase = plus ? read.u64(optional + 24) : read.u32(optional + 28);
  const directoryCount = read.u32(optional + (plus ? 108 : 92));
  const directories = optional + (plus ? 112 : 96);
  const directory = (index) => (index < directoryCount ? read.u32(directories + index * 8) : 0);
  const table = optional + read.u16(coff + 16);
  const sections = Array.from({ length: read.u16(coff + 2) }, (_, i) => {
    const entry = table + i * PE.SectionSize;
    return {
      virtualSize: read.u32(entry + 8),
      address: read.u32(entry + 12),
      rawSize: read.u32(entry + 16),
      rawPointer: read.u32(entry + 20),
    };
  });
  return { machine: read.u16(coff), imageBase, sections, directory };
}

/** The DLL names in one descriptor table: `nameOf` gives a descriptor's name RVA, 0 at the end. */
function tableNames(read, sections, rva, size, nameOf) {
  if (rva === 0) return [];
  const names = [];
  for (let i = 0; i < MAX_DESCRIPTORS; i += 1) {
    const nameRva = nameOf(fileOffset(sections, rva + i * size));
    if (nameRva === 0) return names;
    names.push(read.name(fileOffset(sections, nameRva)));
  }
  throw new Error(MESSAGE.notPe);
}

/**
 * A PE file's (`.exe`, `.dll`, `.node`) machine type and the DLLs it loads by name: its import
 * table and its delay-load table, as written. Throws on bytes that are not a well-formed PE image.
 */
function peImage(bytes) {
  const read = reader(bytes);
  const { machine, imageBase, sections, directory } = peHeaders(read);
  const imported = tableNames(read, sections, directory(PE.ImportDirectory), PE.ImportDescriptorSize, (entry) =>
    read.u32(entry + 12),
  );
  // A delay-load descriptor's first bit says its addresses are RVAs; old linkers wrote VAs.
  const delayed = tableNames(read, sections, directory(PE.DelayImportDirectory), PE.DelayDescriptorSize, (entry) => {
    const name = read.u32(entry + 4);
    return name === 0 || read.u32(entry) & 1 ? name : name - imageBase;
  });
  return { machine, imports: [...new Set([...imported, ...delayed])] };
}

/** The machine type of the PE file at `file`, or null when it is missing or no PE image. */
async function machineOf(file) {
  try {
    return peImage(await fs.readFile(file)).machine;
  } catch {
    return null;
  }
}

/** The Visual C++ runtime DLLs `image` imports with no copy of its own machine type in `dir`. */
async function runtimeGaps(image, dir) {
  const beside = new Map((await fs.readdir(dir)).map((name) => [name.toLowerCase(), name]));
  const gaps = [];
  for (const dll of image.imports.map((name) => name.toLowerCase())) {
    if (!VC_RUNTIME_DLL.test(dll)) continue;
    const copy = beside.get(dll);
    if (!copy || (await machineOf(path.join(dir, copy))) !== image.machine) gaps.push(dll);
  }
  return gaps;
}

/**
 * Each PE file under `dir` that imports a Visual C++ runtime DLL with no copy of its own machine
 * type beside it: its path, machine and those DLLs (lower-cased). A file named like a PE file that
 * is not a well-formed image is listed with `error`.
 */
async function missingVcRuntime(dir) {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && PE_FILE.test(e.name)).map((e) => path.join(e.parentPath, e.name));
  const found = [];
  for (const file of files) {
    let image;
    try {
      image = peImage(await fs.readFile(file));
    } catch (error) {
      found.push({ file, machine: null, missing: [], error: error.message });
      continue;
    }
    const missing = await runtimeGaps(image, path.dirname(file));
    if (missing.length) found.push({ file, machine: image.machine, missing });
  }
  return found;
}

/** Visual Studio's newest `VC\Redist\MSVC\<version>` folder, by vswhere, or none. */
function visualStudioRedist() {
  if (process.platform !== "win32" || !existsSync(VSWHERE)) return null;
  const args = ["-latest", "-products", "*", "-property", "installationPath"];
  const install = execFileSync(VSWHERE, args, { encoding: "utf8" }).trim();
  const msvc = path.join(install, "VC", "Redist", "MSVC");
  if (!install || !existsSync(msvc)) return null;
  const versions = readdirSync(msvc).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
  const newest = versions.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  return newest ? path.join(msvc, newest) : null;
}

/**
 * The redistributable's runtime folder for `arch` (`<redist>\<arch>\Microsoft.VC14x.CRT`): under
 * `env.VCToolsRedistDir` (a Visual Studio developer prompt sets it), else the newest installed
 * Visual Studio's. Null when there is none.
 */
function crtFolder(arch, env = process.env) {
  const redist = env.VCToolsRedistDir || visualStudioRedist();
  if (!redist) return null;
  const archDir = path.join(redist, arch);
  const crt = (existsSync(archDir) ? readdirSync(archDir) : []).filter((name) => CRT_FOLDER.test(name)).sort();
  return crt.length ? path.join(archDir, crt.at(-1)) : null;
}

/** Copy one round of missing runtime DLLs beside their importers; `crt(arch)` finds each source. */
async function copyRound(needs, crt) {
  const copies = [];
  for (const { file, machine, missing } of needs) {
    if (missing.length === 0) continue;
    const arch = REDIST_ARCH.get(machine);
    if (!arch) throw new Error(MESSAGE.unknownMachine(file, machine));
    const source = crt(arch);
    if (!source) throw new Error(MESSAGE.noRedist(missing, arch));
    const available = new Map(readdirSync(source).map((name) => [name.toLowerCase(), name]));
    for (const dll of missing) {
      const name = available.get(dll);
      if (!name) throw new Error(MESSAGE.missingDll(dll, source));
      const to = path.join(path.dirname(file), name);
      await fs.copyFile(path.join(source, name), to);
      copies.push(to);
    }
  }
  return copies;
}

/**
 * Put the Visual C++ runtime DLLs each PE file under `dir` imports beside it, for its machine
 * type, from the redistributable's runtime folder `crt(arch)` (by default this machine's Visual
 * Studio, {@link crtFolder}). Windows only; nothing happens when no file needs one. Returns the
 * copies made; throws when a needed DLL has no source, so no package ships without it.
 */
async function copyVcRuntime(dir, platform, crt = crtFolder) {
  if (platform !== "win32") return [];
  const copies = [];
  for (let round = 0; round < MAX_COPY_ROUNDS; round += 1) {
    const needs = (await missingVcRuntime(dir)).filter((need) => need.missing.length);
    if (needs.length === 0) return [...new Set(copies)];
    copies.push(...(await copyRound(needs, crt)));
  }
  const left = (await missingVcRuntime(dir)).filter((need) => need.missing.length);
  if (left.length === 0) return [...new Set(copies)];
  throw new Error(MESSAGE.rounds(left.map((need) => `${need.file}: ${need.missing.join(", ")}`).join("; ")));
}

module.exports = { VC_RUNTIME_DLL, copyVcRuntime, crtFolder, missingVcRuntime, peImage };
