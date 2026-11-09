/**
 * Graphics memory on Windows and Linux PCs, for the local-model fit (`hardware.ts`).
 *
 * Ollama runs a model on the graphics card when it fits there, and splits it between the card
 * and system memory when it does not (NVIDIA through CUDA, AMD and Intel through ROCm or Vulkan),
 * so a PC's model budget is its graphics memory plus its share of RAM. Macs are not probed:
 * Apple Silicon memory is unified and already counted as RAM, and Ollama does not use an Intel
 * Mac's graphics card.
 *
 * - Windows: each display adapter's driver key holds `HardwareInformation.qwMemorySize`, its
 *   dedicated memory in bytes, read with `reg.exe` (on every Windows, by its full path). The class
 *   keeps the key of a card that was swapped out, so only the largest card counts.
 * - Linux: `nvidia-smi`, which comes with NVIDIA's driver, for NVIDIA cards; the amdgpu driver's
 *   `mem_info_vram_total` for AMD cards. Both list only the cards that are in the machine.
 *
 * A card under 2 GB (an integrated GPU's small carve-out) is left out. Anything that cannot be
 * read counts as no graphics card: the fit then rests on RAM alone, as it did before.
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { regExeOf } from "./toolchain.ts";

const BYTES_PER_GB = 1024 ** 3;
const MIB_PER_GB = 1024;
/** How long one probe command may take, and how much it may print. */
const PROBE_TIMEOUT_MS = 3 * SECOND_MS;
const PROBE_MAX_BYTES = 1024 * 1024;
/** A card with less memory than this is an integrated GPU's carve-out, too small to hold a model. */
const MIN_GPU_MEMORY_GB = 2;

/** The display adapters' device class: one numbered subkey per adapter driver. */
const DISPLAY_CLASS_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
const REGISTRY_MEMORY = "HardwareInformation.qwMemorySize";
const REGISTRY_NAME = "DriverDesc";
/** Where Linux lists its graphics cards, one `cardN` folder each. */
const DRM_ROOT = "/sys/class/drm";
const DRM_CARD = /^card\d+$/;
/** The name a card goes by when its driver does not say. */
const AMD_FALLBACK_NAME = "AMD Radeon";
const FALLBACK_NAME = "GPU";

/** One graphics card a local model can run on. */
export interface GpuInfo {
  name: string;
  /** Its own memory, in GB (GiB, as RAM is counted). */
  memoryGb: number;
}

/** Runs a program and answers what it printed, even when it exits non-zero; never throws. */
export type ProbeRun = (file: string, args: readonly string[]) => Promise<string>;

/** What the probe reads; tests stand in for each. */
export interface GpuProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ProbeRun;
  /** Linux's `/sys/class/drm`. */
  drmRoot?: string;
}

/**
 * `reg.exe` exits 1 when one adapter's key denies access, after printing every other key's
 * value, so what it printed is used whatever the exit. A missing program prints nothing.
 */
const runQuietly: ProbeRun = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES, windowsHide: true, encoding: "utf8" },
      (_error, stdout) => resolve(String(stdout ?? "")),
    );
  });

/** `bytes` in GB, to one decimal place. */
const gbOf = (bytes: number): number => Math.round((bytes / BYTES_PER_GB) * 10) / 10;

/** Each registry key's `name` value from `reg query … /s /v <name>` output, by key. */
function registryValues(output: string, name: string): Map<string, string> {
  const values = new Map<string, string>();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = new RegExp(`^\\s+${escaped}\\s+REG_\\w+\\s+(.*)$`, "i");
  let key = "";
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) key = line.trim().toUpperCase();
    const value = row.exec(line)?.[1]?.trim();
    if (key && value) values.set(key, value);
  }
  return values;
}

/**
 * The display adapters in `reg query` output: each key's dedicated memory (`memory`, a REG_QWORD
 * in hex) with its driver's name (`names`). A key without a readable memory size is no card.
 */
export function parseRegistryGpus(memory: string, names: string): GpuInfo[] {
  const sizes = registryValues(memory, REGISTRY_MEMORY);
  const descriptions = registryValues(names, REGISTRY_NAME);
  const gpus: GpuInfo[] = [];
  for (const [key, hex] of sizes) {
    const bytes = /^0x[0-9a-f]+$/i.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
    if (Number.isFinite(bytes) && bytes > 0)
      gpus.push({ name: descriptions.get(key) || FALLBACK_NAME, memoryGb: gbOf(bytes) });
  }
  return gpus;
}

/** NVIDIA's cards from `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const comma = line.lastIndexOf(",");
    if (comma < 0) continue;
    const mib = Number(line.slice(comma + 1).trim());
    const name = line.slice(0, comma).trim();
    if (name && Number.isFinite(mib) && mib > 0)
      gpus.push({ name, memoryGb: Math.round((mib / MIB_PER_GB) * 10) / 10 });
  }
  return gpus;
}

async function windowsGpus(run: ProbeRun, env: NodeJS.ProcessEnv): Promise<GpuInfo[]> {
  const reg = regExeOf(env);
  const [memory, names] = await Promise.all([
    run(reg, ["query", DISPLAY_CLASS_KEY, "/s", "/v", REGISTRY_MEMORY]),
    run(reg, ["query", DISPLAY_CLASS_KEY, "/s", "/v", REGISTRY_NAME]),
  ]);
  return parseRegistryGpus(memory, names);
}

async function nvidiaGpus(run: ProbeRun): Promise<GpuInfo[]> {
  return parseNvidiaSmi(await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]));
}

/** A file's trimmed text, or null when it cannot be read. */
async function readText(file: string): Promise<string | null> {
  return readFile(file, "utf8").then(
    (text) => text.trim(),
    () => null,
  );
}

/** AMD cards on the amdgpu driver, from each card's `mem_info_vram_total` (bytes). */
async function amdGpus(drmRoot: string): Promise<GpuInfo[]> {
  const cards = (await readdir(drmRoot).catch(() => [] as string[])).filter((name) => DRM_CARD.test(name));
  const found = await Promise.all(
    cards.map(async (card): Promise<GpuInfo | null> => {
      const device = path.posix.join(drmRoot, card, "device");
      const bytes = Number(await readText(path.posix.join(device, "mem_info_vram_total")));
      if (!Number.isFinite(bytes) || bytes <= 0) return null;
      const name = (await readText(path.posix.join(device, "product_name"))) || AMD_FALLBACK_NAME;
      return { name, memoryGb: gbOf(bytes) };
    }),
  );
  return found.filter((gpu): gpu is GpuInfo => gpu !== null);
}

/** The cards on this platform, before the small ones are left out. */
async function platformGpus(deps: GpuProbeDeps): Promise<GpuInfo[]> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runQuietly;
  if (platform === StudioPlatform.Windows) return windowsGpus(run, deps.env ?? process.env);
  if (platform !== StudioPlatform.Linux) return [];
  const [nvidia, amd] = await Promise.all([nvidiaGpus(run), amdGpus(deps.drmRoot ?? DRM_ROOT)]);
  return [...nvidia, ...amd];
}

/** The largest card alone: Windows' class keeps the keys of cards no longer in the machine. */
function largest(gpus: GpuInfo[]): GpuInfo[] {
  const [first, ...rest] = gpus;
  if (!first) return [];
  return [rest.reduce((big, gpu) => (gpu.memoryGb > big.memoryGb ? gpu : big), first)];
}

/** The graphics cards a local model can run on, largest first; empty on a Mac or when none can be read. */
export async function detectGpus(deps: GpuProbeDeps = {}): Promise<GpuInfo[]> {
  const gpus = (await platformGpus(deps).catch(() => [] as GpuInfo[])).filter(
    (gpu) => gpu.memoryGb >= MIN_GPU_MEMORY_GB,
  );
  const counted = (deps.platform ?? process.platform) === StudioPlatform.Windows ? largest(gpus) : gpus;
  return counted.sort((a, b) => b.memoryGb - a.memoryGb);
}
