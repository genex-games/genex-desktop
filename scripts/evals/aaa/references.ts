/**
 * The taste judge's reference stills: CC0 Poly Haven panoramas, fetched once into the eval home and
 * cut into 1600×900 perspective stills at each yaw the suite names. Only the two Poly Haven hosts
 * are ever contacted, a download must match the md5 the API lists, and every still records its
 * licence and authors beside it. Nothing here enters Git.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import type { AaaPrompt, AaaReference } from "./suite.ts";

/** Reference stills' size: the clean capture minimum, so both sides are judged at one scale. */
export const REFERENCE_SIZE = { width: 1600, height: 900 } as const;
/** Vertical field of view of a reference still, a typical game camera. */
export const REFERENCE_FOV_Y_DEG = 60;
/** JPEG quality of a written still. */
const REFERENCE_JPEG_QUALITY = 92;
/** The only hosts a reference fetch may reach. */
export const REFERENCE_HOSTS = ["api.polyhaven.com", "dl.polyhaven.org"] as const;
/** The licence every Poly Haven asset carries (polyhaven.com/license). */
export const POLY_HAVEN_LICENCE = "CC0-1.0";
/** The record of fetched assets, beside the stills. */
export const REFERENCE_RECORD = "references.json";

/** Decoded RGBA pixels. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A perspective view into an equirectangular panorama. */
export interface PanoramaView {
  yawDeg: number;
  pitchDeg: number;
  fovYDeg: number;
  width: number;
  height: number;
}

const RAD = Math.PI / 180;

function sampleBilinear(src: Rgba, x: number, y: number, out: Uint8Array, at: number): void {
  const x0 = Math.floor(x);
  const y0 = Math.min(src.height - 1, Math.max(0, Math.floor(y)));
  const y1 = Math.min(src.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = Math.min(1, Math.max(0, y - y0));
  const wrap = (xi: number) => ((xi % src.width) + src.width) % src.width;
  const corners = [
    [wrap(x0), y0, (1 - fx) * (1 - fy)],
    [wrap(x0 + 1), y0, fx * (1 - fy)],
    [wrap(x0), y1, (1 - fx) * fy],
    [wrap(x0 + 1), y1, fx * fy],
  ] as const;
  for (let c = 0; c < 4; c++) {
    let sum = 0;
    for (const [cx, cy, w] of corners) sum += (src.data[(cy * src.width + cx) * 4 + c] ?? 0) * w;
    out[at + c] = Math.round(sum);
  }
}

/**
 * Cut a perspective still out of an equirectangular panorama: yaw 0 looks at the panorama's
 * centre column, positive yaw turns right, positive pitch looks up.
 */
export function reprojectEquirect(src: Rgba, view: PanoramaView): Rgba {
  const out = new Uint8Array(view.width * view.height * 4);
  const tanY = Math.tan((view.fovYDeg * RAD) / 2);
  const tanX = tanY * (view.width / view.height);
  const [sy, cy] = [Math.sin(view.yawDeg * RAD), Math.cos(view.yawDeg * RAD)];
  const [sp, cp] = [Math.sin(view.pitchDeg * RAD), Math.cos(view.pitchDeg * RAD)];
  for (let v = 0; v < view.height; v++)
    for (let u = 0; u < view.width; u++) {
      const x = ((2 * (u + 0.5)) / view.width - 1) * tanX;
      const y = (1 - (2 * (v + 0.5)) / view.height) * tanY;
      const y1 = y * cp + sp;
      const z1 = cp - y * sp;
      const lon = Math.atan2(x * cy + z1 * sy, z1 * cy - x * sy);
      const lat = Math.atan2(y1, Math.hypot(x, z1));
      const sx = (lon / (2 * Math.PI) + 0.5) * src.width - 0.5;
      const syPix = (0.5 - lat / Math.PI) * src.height - 0.5;
      sampleBilinear(src, sx, syPix, out, (v * view.width + u) * 4);
    }
  return { width: view.width, height: view.height, data: out };
}

/** A reference still's file name. */
export function referenceStillName(ref: Pick<AaaReference, "asset">, yawDeg: number): string {
  return `${ref.asset}-yaw${String(Math.round(yawDeg)).padStart(3, "0")}.jpg`;
}

/** The stills on disk for a view role: the role's own references, or every reference of the prompt. */
export function referenceStills(dir: string, prompt: AaaPrompt, role: string): string[] {
  const own = prompt.references.filter((ref) => ref.matches === role);
  const refs = own.length ? own : prompt.references;
  return refs
    .flatMap((ref) => ref.yawDeg.map((yaw) => path.join(dir, referenceStillName(ref, yaw))))
    .filter((file) => fs.existsSync(file));
}

/** Why a reference fetch stopped. */
export class ReferenceFetchError extends Error {
  constructor(asset: string, detail: string) {
    super(`reference ${asset}: ${detail}`);
    this.name = "ReferenceFetchError";
  }
}

/** The network a fetch uses: GET a URL, answering its bytes. */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

/** A URL on one of the reference hosts over https, or null. */
export function allowedReferenceUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const hostOk = url !== null && (REFERENCE_HOSTS as readonly string[]).includes(url.hostname);
  return hostOk && url?.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
}

async function fetchJson(fetchBytes: FetchBytes, url: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(await fetchBytes(url)));
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** One fetched asset, as the record lists it. */
export interface ReferenceRecord {
  asset: string;
  licence: typeof POLY_HAVEN_LICENCE;
  page: string;
  authors: string[];
  md5: string;
  stills: string[];
}

/** Fetch one Poly Haven panorama, check its md5, and write a still per yaw. */
export async function fetchReference(ref: AaaReference, dir: string, fetchBytes: FetchBytes): Promise<ReferenceRecord> {
  const files = await fetchJson(fetchBytes, `https://api.polyhaven.com/files/${ref.asset}`);
  const info = await fetchJson(fetchBytes, `https://api.polyhaven.com/info/${ref.asset}`);
  const tonemapped = (files.tonemapped ?? {}) as Record<string, unknown>;
  const url = allowedReferenceUrl(tonemapped.url);
  if (!url) throw new ReferenceFetchError(ref.asset, "the tonemapped preview is not on a Poly Haven host");
  const bytes = await fetchBytes(url.href);
  const md5 = createHash("md5").update(bytes).digest("hex");
  if (md5 !== tonemapped.md5) throw new ReferenceFetchError(ref.asset, "the download does not match its md5");
  const pano = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 1024 });
  const stills = ref.yawDeg.map((yawDeg) => {
    const still = reprojectEquirect(pano, { yawDeg, pitchDeg: 0, fovYDeg: REFERENCE_FOV_Y_DEG, ...REFERENCE_SIZE });
    const name = referenceStillName(ref, yawDeg);
    fs.writeFileSync(path.join(dir, name), jpeg.encode({ ...still, data: still.data }, REFERENCE_JPEG_QUALITY).data);
    return name;
  });
  const authors = typeof info.authors === "object" && info.authors !== null ? Object.keys(info.authors) : [];
  const page = `https://polyhaven.com/a/${ref.asset}`;
  return { asset: ref.asset, licence: POLY_HAVEN_LICENCE, page, authors, md5, stills };
}

/** Fetch every reference of the suite not already on disk; returns the record written beside them. */
export async function fetchReferences(
  prompts: readonly AaaPrompt[],
  dir: string,
  fetchBytes: FetchBytes,
): Promise<ReferenceRecord[]> {
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, REFERENCE_RECORD);
  const records: ReferenceRecord[] = fs.existsSync(recordFile) ? JSON.parse(fs.readFileSync(recordFile, "utf8")) : [];
  const seen = new Set(records.map((r) => r.asset));
  for (const ref of prompts.flatMap((p) => p.references)) {
    if (seen.has(ref.asset)) continue;
    records.push(await fetchReference(ref, dir, fetchBytes));
    seen.add(ref.asset);
    fs.writeFileSync(recordFile, `${JSON.stringify(records, null, 2)}\n`);
  }
  return records;
}
