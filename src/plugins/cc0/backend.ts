/**
 * The bundled CC0 library plugin (owner call C11). `cc0__search` lists Poly Haven and ambientCG
 * assets; `cc0__fetch` downloads one, on the host and never in an agent's sandbox, under the CC0
 * fetch rules (`substrate/cc0-fetch.ts`: allowlisted https hosts, plain names, size, md5 and sha256
 * checked before anything is written), packs a Poly Haven model into one self-contained GLB, and
 * hands the files to `assets.deliver`, which lands them in `assets/cc0/<job>/` and records the
 * delivery. The plugin keeps a provenance record per delivery folder (`jobs.write`) from which the
 * host builds the CC0 rows of `genex-assets.lock` (`provenance.ts`).
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import type { Activate, PluginActivation, PluginContext } from "../../plugin-sdk/index.d.ts";
import { AssetLicence } from "../../shared/asset-db.ts";
import {
  Cc0Error,
  Cc0Refusal,
  checkedName,
  sha256,
  unpackedMembers,
  verified,
  ZIP_LIMITS,
  type ZipMember,
} from "../../substrate/cc0-fetch.ts";
import { CURATED, type CuratedManifest } from "./curated.ts";
import { packGlb } from "./glb.ts";
import { type Cc0Net, createCc0Net } from "./net.ts";
import type { Cc0DeliveredFile, Cc0Delivery } from "./provenance.ts";
import { createSearch, POLYHAVEN_CREDIT } from "./search.ts";
import { type Cc0Request, Cc0Source, checkedRequest, type FetchPlan, type PlannedFile, planFetch } from "./sources.ts";

/** The plugin's agent tools. Wire values: `plugin.json` names them. */
export const Cc0Tool = { Search: "search", Fetch: "fetch" } as const;
export type Cc0Tool = (typeof Cc0Tool)[keyof typeof Cc0Tool];

/** The plugin's panel actions. Wire values: `plugin.json` names them. */
export const Cc0Action = { Search: "search" } as const;

/** The host services the plugin calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  AssetsDeliver: "assets.deliver",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
} as const;

const MESSAGE = {
  UnknownTool: "Unknown CC0 library tool",
  UnknownAction: "Unknown CC0 library action",
  NoGame: "Open a game first: a CC0 fetch delivers into the bound game's assets folder.",
  Refused: (code: string, detail: string) =>
    `cc0 ${code}: ${detail}. Nothing was written; pick another asset or resolution with cc0__search.`,
  Use: "Each path is relative to the game folder. In a Rust game load a model in on_reset with gfx.assets().model(<path without its leading assets/>); a map's role (diff, nor_gl, arm) says how it is sampled. The licence is CC0-1.0: no credit is required, and the lock records the source.",
  TwoFilesOneName: (name: string) => `two files of this fetch are named ${name}`,
} as const;

/** What the plugin needs from outside: the network and the curated manifest (tests pass their own). */
export interface Cc0Deps {
  net: Cc0Net;
  curated?: CuratedManifest;
}

/** One file ready to deliver. */
interface Output {
  name: string;
  bytes: Uint8Array;
  map: string;
  url: string;
}

/** The delivery folder's job id: a UUID made from the source, id and resolution, so a repeat fetch lands beside the first. */
function jobIdOf(request: Cc0Request): string {
  const hex = createHash("sha256")
    .update(`${request.source}\n${request.id}\n${request.resolution ?? ""}`)
    .digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/**
 * A downloader for one fetch: each URL is downloaded once (a model's maps are both its glTF's
 * resources and loose files) and every use is verified against its own planned size and digests.
 */
function downloader(net: Cc0Net): (file: PlannedFile) => Promise<Uint8Array> {
  const fetched = new Map<string, Promise<Uint8Array>>();
  return async (file) => {
    const pending = fetched.get(file.url) ?? net.download(new URL(file.url), file.bytes);
    fetched.set(file.url, pending);
    const bytes = await pending;
    verified(file, bytes, file.sha256 === null);
    return bytes;
  };
}

/** The members of `zip` its plan wants, listed from the central directory without inflating anything. */
function wantedMembers(zip: Uint8Array, plan: NonNullable<FetchPlan["zip"]>): ZipMember[] {
  const listed: ZipMember[] = [];
  let entries = 0;
  try {
    unzipSync(zip, {
      filter: (entry) => {
        entries += 1;
        const map = plan.roleOf(entry.name);
        if (map !== null && plan.maps.includes(map)) {
          listed.push({ name: entry.name, bytes: entry.originalSize, sha256: null, map });
        }
        return false;
      },
    });
  } catch (error) {
    throw new Cc0Error(Cc0Refusal.ZipInvalid, error instanceof Error ? error.message : String(error));
  }
  if (entries > ZIP_LIMITS.maxEntries) {
    throw new Cc0Error(Cc0Refusal.ZipTooManyEntries, `${entries} entries, at most ${ZIP_LIMITS.maxEntries}`);
  }
  return plan.maps.flatMap((map) => listed.filter((member) => member.map === map));
}

/** Every file the plan delivers, downloaded and verified in memory: a refusal leaves nothing anywhere. */
async function outputsOf(plan: FetchPlan, net: Cc0Net): Promise<Output[]> {
  const outputs: Output[] = [];
  const downloaded = downloader(net);
  if (plan.model) {
    const resources = new Map<string, Uint8Array>();
    for (const resource of plan.model.resources) resources.set(resource.uri, await downloaded(resource));
    const gltf = await downloaded(plan.model.gltf);
    outputs.push({
      name: plan.model.name,
      bytes: packGlb(gltf, resources),
      map: plan.model.gltf.map,
      url: plan.model.gltf.url,
    });
  }
  for (const file of plan.files)
    outputs.push({ name: file.name, bytes: await downloaded(file), map: file.map, url: file.url });
  if (plan.zip) {
    const zip = await downloaded(plan.zip.file);
    for (const { member, bytes } of unpackedMembers(zip, wantedMembers(zip, plan.zip), true, ZIP_LIMITS)) {
      outputs.push({ name: checkedName(member.name), bytes, map: member.map, url: plan.zip.file.url });
    }
  }
  const names = new Set<string>();
  for (const output of outputs) {
    const folded = output.name.toLowerCase();
    if (names.has(folded)) throw new Cc0Error(Cc0Refusal.ManifestInvalid, MESSAGE.TwoFilesOneName(output.name));
    names.add(folded);
  }
  return outputs;
}

/** Writes the outputs into a fresh folder of the plugin's storage and has the host deliver them; the folder goes after. */
async function deliver(outputs: readonly Output[], jobId: string, ctx: PluginContext): Promise<string[]> {
  const storage = await ctx.host(HostService.StorageRoot);
  const folder = path.join(storage, "jobs", jobId);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  try {
    for (const output of outputs) await writeFile(path.join(folder, output.name), output.bytes, { flag: "wx" });
    return await ctx.host(HostService.AssetsDeliver, { output: folder, jobId });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The record for this delivery: the files delivered now, plus those an earlier fetch into the folder left. */
async function recordOf(
  plan: FetchPlan,
  jobId: string,
  files: Cc0DeliveredFile[],
  ctx: PluginContext,
): Promise<Cc0Delivery> {
  const earlier = (await ctx.host(HostService.JobsRead, { id: jobId })) as Cc0Delivery | null;
  const now = new Set(files.map((file) => file.path));
  const kept = (earlier?.files ?? []).filter((file) => !now.has(file.path));
  return {
    jobId,
    source: plan.source,
    id: plan.id,
    kind: plan.kind,
    resolution: plan.resolution,
    licence: AssetLicence.Cc0,
    page: plan.page,
    authors: plan.authors,
    files: [...kept, ...files].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

async function fetchAsset(args: Record<string, unknown>, ctx: PluginContext, deps: Cc0Deps) {
  const request = checkedRequest(args);
  if (!ctx.directory) throw new Error(MESSAGE.NoGame);
  const plan = await planFetch(request, deps.net, deps.curated ?? CURATED);
  const outputs = await outputsOf(plan, deps.net);
  const jobId = jobIdOf(request);
  const paths = await deliver(outputs, jobId, ctx);
  const byName = new Map(paths.map((file) => [path.posix.basename(file), file]));
  const files: Cc0DeliveredFile[] = outputs.map((output) => ({
    path: byName.get(output.name) ?? `assets/cc0/${jobId}/${output.name}`,
    sha256: sha256(output.bytes),
    bytes: output.bytes.byteLength,
    map: output.map,
    url: output.url,
  }));
  await ctx.host(HostService.JobsWrite, { id: jobId, value: await recordOf(plan, jobId, files, ctx) });
  return {
    jobId,
    source: plan.source,
    id: plan.id,
    kind: plan.kind,
    licence: AssetLicence.Cc0,
    page: plan.page,
    authors: plan.authors,
    files: files.map(({ url: _url, ...file }) => file),
    ...(plan.source === Cc0Source.PolyHaven ? { credit: POLYHAVEN_CREDIT } : {}),
    use: MESSAGE.Use,
  };
}

/** A refusal as the agent reads it: the typed code first, then what to do. */
function refusal(error: unknown): unknown {
  if (error instanceof Cc0Error) return new Error(MESSAGE.Refused(error.code, error.message));
  return error;
}

/** The plugin over `deps`; `activate` uses the real network and the shipped manifest. */
export function createCc0Plugin(deps: Cc0Deps): Promise<PluginActivation> {
  const search = createSearch(deps.net);
  const activation: PluginActivation = {
    async tool(name, args, ctx) {
      try {
        if (name === Cc0Tool.Search) return await search(args);
        if (name === Cc0Tool.Fetch) return await fetchAsset(args, ctx, deps);
      } catch (error) {
        throw refusal(error);
      }
      throw new Error(MESSAGE.UnknownTool);
    },
    async action(name, args) {
      if (name !== Cc0Action.Search) throw new Error(MESSAGE.UnknownAction);
      try {
        return await search(args);
      } catch (error) {
        throw refusal(error);
      }
    },
  };
  return Promise.resolve(activation);
}

/** Activation is side-effect-free: the network is reached only inside a tool call. */
export const activate: Activate = () => createCc0Plugin({ net: createCc0Net() });
