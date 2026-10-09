/**
 * Hardware detection & model fit.
 *
 * "Weak local model produces garbage games" is a listed corner case; the honest answer is to
 * know the machine and say what it can actually run, rather than letting the user discover it
 * after a 20 GB download and a run of bad output.
 *
 * Fit rule (from the plan): model file (≈ params × 0.55–0.65 GB/B at Q4/MXFP4) + KV cache
 * (0.5–3 GB) + 1–2 GB overhead must fit in the model budget — the whole machine's RAM is never
 * available to the model.
 *
 * That budget is ⅔ of RAM elsewhere, but 0.72 on Apple Silicon, where unified memory means Metal
 * is handed far more than a discrete GPU would get. Measured on an M2 Max/32 GB:
 * Ollama reported `gpu memory available 24.5 GiB` — 76.5% of the machine — and an 18.2 GB model
 * loaded with all 66 layers on the GPU at 18.0 GiB peak, with 22.5 GiB still free. At ⅔ the studio
 * would have told the user that its own verified default model did not fit.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import catalog from "./models-catalog.json" with { type: "json" };
import { SECOND_MS } from "../shared/duration.ts";

const execFileAsync = promisify(execFile);

const BYTES_PER_GB = 1024 ** 3;
const BYTES_PER_MB = 1024 ** 2;
/** The share of RAM the model may take: 0.72 on Apple Silicon (see the header), ⅔ elsewhere. */
const APPLE_SILICON_MODEL_SHARE = 0.72;
const OTHER_MODEL_SHARE = 2 / 3;
/** Runtime overhead added to weights and KV cache (the plan's 1–2 GB). */
const MODEL_OVERHEAD_GB = 1.5;
/** KV cache: this share of the weights, clamped to the plan's 0.5–3 GB. */
const KV_CACHE_SHARE = 0.12;
const KV_CACHE_MIN_GB = 0.5;
const KV_CACHE_MAX_GB = 3;
/** A machine this close under a tier's RAM floor still gets the tier (16 GB reads as 15.9). */
const TIER_RAM_SLACK_GB = 0.5;
/** How long `availableMemory` reuses its answer, and how long vm_stat may take. */
const MEMORY_CACHE_MS = 2 * SECOND_MS;
const VM_STAT_TIMEOUT_MS = 2 * SECOND_MS;
/** vm_stat's page size when its header does not say (Apple Silicon's 16 KiB). */
const DEFAULT_PAGE_SIZE_BYTES = 16_384;

const MESSAGE = {
  NoTiers: "the model catalog lists no hardware tiers",
} as const;

/** `value` rounded to one decimal place, as every GB figure is shown. */
function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface HardwareInfo {
  cpu: string;
  ramBytes: number;
  ramGb: number;
  /** Rough budget for model weights + KV cache. */
  usableModelGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
}

/** One catalog model. `about` is the user's one line; `notes` is evidence that is never displayed. */
export interface CatalogModel {
  name: string;
  /** Packing or build shown beside the name when the tag alone would not say it (Bonsai). */
  variant?: string;
  engine?: string;
  sizeGb: number;
  tools: boolean;
  vision: boolean;
  /** MLX builds and Bonsai packs are Apple-Silicon only — never offered on hardware that cannot run them. */
  appleSilicon?: boolean;
  /** Managed packs also have a minimum machine (Bonsai: 16 GB). */
  minRamGb?: number;
  /** The Apple-Silicon build of the same weights; on Apple Silicon only that build is shown. */
  mlx?: string;
  about: string;
  notes?: string;
}

export interface CatalogTier {
  minRamGb: number;
  expectation: string;
  label: string;
  /** Model ids in rank order: the first one that fits the machine is its Best fit. */
  picks: string[];
}

/** A catalog model judged against one machine. */
export interface CatalogChoice extends Omit<CatalogModel, "notes" | "mlx" | "minRamGb"> {
  model: string;
  fits: boolean;
  /** Weights + context + overhead, the figure compared with the machine's model budget. */
  needGb: number;
  /** The smallest common Mac memory size whose budget holds this model; null when none does. */
  needsRamGb: number | null;
  reason: string;
}

export async function detectHardware(): Promise<HardwareInfo> {
  const ramBytes = os.totalmem();
  let cpu = os.cpus()[0]?.model ?? "unknown";
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("sysctl", ["-n", "machdep.cpu.brand_string"]);
      cpu = stdout.trim() || cpu;
    } catch {
      /* keep the os.cpus() value */
    }
  }
  const ramGb = ramBytes / BYTES_PER_GB;
  const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
  return {
    cpu,
    ramBytes,
    ramGb: oneDecimal(ramGb),
    usableModelGb: oneDecimal(ramGb * budgetShare(appleSilicon)),
    platform: process.platform,
    arch: process.arch,
    appleSilicon,
  };
}

export function tiers(): CatalogTier[] {
  return catalog.tiers as unknown as CatalogTier[];
}

export function catalogModels(): Record<string, CatalogModel> {
  return catalog.models as unknown as Record<string, CatalogModel>;
}

/** The tier whose RAM requirement this machine meets (highest match). */
export function tierFor(ramGb: number): CatalogTier {
  const [lowest, ...higher] = tiers();
  if (!lowest) throw new Error(MESSAGE.NoTiers);
  let best = lowest;
  for (const tier of higher) if (ramGb + TIER_RAM_SLACK_GB >= tier.minRamGb) best = tier;
  return best;
}

export interface Recommendation {
  tier: CatalogTier;
  hardware: HardwareInfo;
  /** The tier's ranked models that fit this machine; the first is Best fit. */
  picks: CatalogChoice[];
  /** Every other model this machine's architecture can run, smallest first, fitting or not. */
  more: CatalogChoice[];
  defaultModel: string | null;
}

/** Common Mac memory sizes, for "Needs a 128 GB Mac". */
const MEMORY_SIZES_GB = [16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];

function budgetShare(appleSilicon: boolean): number {
  return appleSilicon ? APPLE_SILICON_MODEL_SHARE : OTHER_MODEL_SHARE;
}

/** Weights + KV cache + 1–2 GB overhead: the figure the plan's fit rule compares. */
function neededGb(sizeGb: number): number {
  return sizeGb + kvCacheGb(sizeGb) + MODEL_OVERHEAD_GB;
}

/** Fit of any model size (catalog or a looked-up Ollama tag) on this machine. */
export function fitFor(
  sizeGb: number,
  hw: HardwareInfo,
): Pick<CatalogChoice, "fits" | "needGb" | "needsRamGb" | "reason"> {
  const needed = neededGb(sizeGb);
  const fits = needed <= hw.usableModelGb;
  const needsRamGb = MEMORY_SIZES_GB.find((ram) => oneDecimal(ram * budgetShare(hw.appleSilicon)) >= needed) ?? null;
  return {
    fits,
    needGb: oneDecimal(needed),
    needsRamGb,
    reason: fits
      ? `${sizeGb} GB weights + ~${kvCacheGb(sizeGb)} GB context fits in ~${hw.usableModelGb} GB usable`
      : `needs ~${Math.round(needed)} GB, this machine has ~${hw.usableModelGb} GB usable`,
  };
}

/** Whether this machine's architecture should see the model at all — one build per model. */
function offered(id: string, model: CatalogModel, hw: HardwareInfo): boolean {
  if (model.appleSilicon && !hw.appleSilicon) return false;
  if (model.minRamGb !== undefined && hw.ramGb < model.minRamGb) return false;
  // One build per model: on Apple Silicon the MLX sibling replaces the portable GGUF.
  const mlxSibling = model.mlx && model.mlx !== id ? catalogModels()[model.mlx] : undefined;
  return !(hw.appleSilicon && mlxSibling);
}

function choice(id: string, model: CatalogModel, hw: HardwareInfo): CatalogChoice {
  const { notes: _notes, mlx: _mlx, minRamGb: _min, ...shown } = model;
  return { ...shown, model: id, ...fitFor(model.sizeGb, hw) };
}

export async function recommendModels(hardware?: HardwareInfo): Promise<Recommendation> {
  const hw = hardware ?? (await detectHardware());
  const tier = tierFor(hw.ramGb);
  const models = catalogModels();
  const available = Object.entries(models).filter(([id, model]) => offered(id, model, hw));
  const offeredById = new Map(available);
  const picks = tier.picks
    .flatMap((id) => {
      const model = offeredById.get(id);
      return model ? [choice(id, model, hw)] : [];
    })
    .filter((pick) => pick.fits);
  const shown = new Set(picks.map((pick) => pick.model));
  const more = available
    .filter(([id]) => !shown.has(id))
    .map(([id, model]) => choice(id, model, hw))
    .sort((a, b) => a.sizeGb - b.sizeGb);
  return { tier, hardware: hw, picks, more, defaultModel: picks[0]?.model ?? null };
}

function kvCacheGb(modelSizeGb: number): number {
  // 0.5–3 GB in the plan's rule; scale with model size and clamp.
  return Math.min(KV_CACHE_MAX_GB, Math.max(KV_CACHE_MIN_GB, oneDecimal(modelSizeGb * KV_CACHE_SHARE)));
}

/** Installed models the catalog considers superseded — the "stale install" flag. */
export function supersededBy(installedModel: string): string | null {
  const table = (catalog as { superseded: Record<string, string> }).superseded;
  const [base = installedModel] = installedModel.split(":");
  return table[installedModel] ?? table[base] ?? null;
}

export function judgeCandidates(): { local: string[]; delegated: string[] } {
  return (catalog as { judges: { local: string[]; delegated: string[] } }).judges;
}

export function catalogUpdated(): string {
  return (catalog as { updated: string }).updated;
}

/**
 * Memory a new preview window could actually take. `os.freemem()` on macOS is the
 * free-page count alone — 1.3 GB "free" on a 32 GB machine with 8 GB inactive — so a worker
 * limit built on it refused work the machine could easily do. On Darwin the answer is
 * vm_stat's free + inactive + speculative + purgeable pages; elsewhere `os.freemem()` stands.
 * Cached for two seconds: capacity is read before every worker start.
 */
let memoryCache: { at: number; value: { freeMb: number; totalMb: number } } | null = null;
export async function availableMemory(): Promise<{ freeMb: number; totalMb: number }> {
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_CACHE_MS) return memoryCache.value;
  const totalMb = Math.round(os.totalmem() / BYTES_PER_MB);
  let freeMb = Math.round(os.freemem() / BYTES_PER_MB);
  if (process.platform === "darwin") {
    try {
      const available = await darwinAvailableBytes();
      if (available > 0) freeMb = Math.round(available / BYTES_PER_MB);
    } catch {
      /* vm_stat missing or odd: the free-page count is the honest fallback */
    }
  }
  memoryCache = { at: Date.now(), value: { freeMb, totalMb } };
  return memoryCache.value;
}

/** vm_stat's free + inactive + speculative + purgeable pages, in bytes. */
async function darwinAvailableBytes(): Promise<number> {
  const { stdout } = await execFileAsync("vm_stat", [], { timeout: VM_STAT_TIMEOUT_MS });
  const text = String(stdout);
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? DEFAULT_PAGE_SIZE_BYTES);
  const pages = (name: string): number => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * pageSize;
}
