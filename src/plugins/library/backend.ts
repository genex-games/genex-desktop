/**
 * The bundled Genex Library plugin: `library__search` reads the shipped catalog (no network, no
 * install) and matches any word; `library__add` installs one entry's files on demand into the
 * plugin's storage, each checked against its sha256 pin (`install.ts`), and has the host deliver
 * them to `assets/library/<folder>/`, where the game's `gfx.assets().library(id)` reads them
 * (`docs/api/library.md`). Each delivery leaves a provenance record (`jobs.write`): the entry, its
 * CC0 licence, source and authors, and every file's digest.
 */
import { rm } from "node:fs/promises";
import type { Activate, PluginActivation, PluginContext } from "../../plugin-sdk/index.d.ts";
import {
  LIBRARY_LICENCE,
  LIBRARY_TIERS,
  type LibraryCatalog,
  type LibraryEntry,
  LibraryError,
  LibraryKind,
  LibraryRefusal,
  type LibraryTier,
  libraryFolder,
  parseLibraryCatalog,
  searchLibrary,
} from "../../shared/genex-library.ts";
import catalogJson from "./catalog.json" with { type: "json" };
import { type LibraryNet, packSource, stageDelivery } from "./install.ts";
import { createLibraryNet } from "./net.ts";

/** The plugin's agent tools. Wire values: `plugin.json` names them. */
export const LibraryTool = { Search: "search", Add: "add" } as const;
export type LibraryTool = (typeof LibraryTool)[keyof typeof LibraryTool];

/** The host services the plugin calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  SettingsRead: "settings.read",
  AssetsDeliver: "assets.deliver",
  JobsWrite: "jobs.write",
} as const;

/** The plugin setting naming a local pack folder (`plugin.json`). */
const PACK_FOLDER_SETTING = "pack-folder";
const KINDS: ReadonlySet<string> = new Set(Object.values(LibraryKind));

const MESSAGE = {
  UnknownTool: "Unknown Genex Library tool",
  NoGame: "Open a game first: library__add delivers into the bound game's assets folder.",
  Refused: (code: string, detail: string) => `library ${code}: ${detail}. Nothing was delivered.`,
  BadKind: (kind: string) => `kind ${kind} is not one of ${[...KINDS].join(", ")}`,
  BadTier: (tier: string) => `tier ${tier} is not one of ${LIBRARY_TIERS.join(", ")}`,
  NoQuery: "query names what to find, for example 'wet asphalt' or 'park bench'",
  NoId: "id is what library__search returned, for example material/asphalt_01",
  Search:
    "Add one with library__add (id, optional tier). Status ready delivers now; slot-open is a tree the generator has not filled; not-built is in the catalog but not in the pack yet. sizeMetres is x, y (height), z; tileMetres is one texture repeat.",
  Load: {
    [LibraryKind.Material]: (id: string) =>
      `In on_reset: sim.world.surface = gfx.assets().library("${id}").map(|asset| asset.material()).unwrap_or_default(); then draw with frame.cube_with(transform, &world.surface) or model_with. The material repeats at its real size (world UV); keep its tile with .with_world_uv(metres) or set .with_uv_scale for a model's own UVs.`,
    [LibraryKind.Sky]: (id: string) =>
      `In on_reset: sim.world.sky = gfx.assets().library("${id}").map(|asset| asset.environment()).unwrap_or_else(|_| Environment::sky()); then frame.environment(world.sky.clone()) every frame.`,
    [LibraryKind.Model]: (id: string) =>
      `In on_reset: sim.world.prop = gfx.assets().library("${id}").map(|asset| asset.model()).unwrap_or_default(); then frame.model(&world.prop, transform). It is in metres at real size with its levels (and an impostor for rocks, vehicles and structures) set.`,
    [LibraryKind.Vegetation]: (id: string) =>
      `In on_reset: sim.world.tree = gfx.assets().library("${id}").map(|asset| asset.model()).unwrap_or_default(); then frame.model(&world.tree, transform): its members draw as one with an impostor past its last level.`,
  },
} as const;

/** What the plugin needs from outside: the network and the catalog (tests pass their own). */
export interface LibraryDeps {
  net: LibraryNet;
  catalog?: LibraryCatalog;
}

/** One delivered file as the provenance record keeps it. */
interface DeliveredFile {
  path: string;
  sha256: string;
  bytes: number;
}

/** The record of one delivery, kept under its folder's job id. */
export interface LibraryDelivery {
  jobId: string;
  id: string;
  kind: LibraryKind;
  tier: LibraryTier | null;
  licence: typeof LIBRARY_LICENCE;
  page: string;
  authors: string[];
  files: DeliveredFile[];
}

function badRequest(detail: string): LibraryError {
  return new LibraryError(LibraryRefusal.BadRequest, detail);
}

function searchArgs(args: Record<string, unknown>): { query: string; kind?: LibraryKind; limit?: number } {
  if (typeof args.query !== "string" || !args.query.trim()) throw badRequest(MESSAGE.NoQuery);
  const asked: { query: string; kind?: LibraryKind; limit?: number } = { query: args.query };
  if (args.kind !== undefined && args.kind !== "") {
    if (!KINDS.has(String(args.kind))) throw badRequest(MESSAGE.BadKind(String(args.kind)));
    asked.kind = args.kind as LibraryKind;
  }
  if (typeof args.limit === "number") asked.limit = args.limit;
  return asked;
}

function addArgs(args: Record<string, unknown>): { id: string; tier?: LibraryTier } {
  if (typeof args.id !== "string" || !args.id) throw badRequest(MESSAGE.NoId);
  if (args.tier === undefined || args.tier === "") return { id: args.id };
  const tier = String(args.tier);
  if (!LIBRARY_TIERS.includes(tier as LibraryTier)) throw badRequest(MESSAGE.BadTier(tier));
  return { id: args.id, tier: tier as LibraryTier };
}

/** The pack folder setting, when the person set one. */
async function packFolder(ctx: PluginContext): Promise<string | undefined> {
  const settings = (await ctx.host(HostService.SettingsRead)) as Record<string, unknown> | null;
  const folder = settings?.[PACK_FOLDER_SETTING];
  return typeof folder === "string" && folder.trim() ? folder.trim() : undefined;
}

function recordOf(
  entry: LibraryEntry,
  tier: LibraryTier | null,
  jobId: string,
  files: DeliveredFile[],
): LibraryDelivery {
  return {
    jobId,
    id: entry.id,
    kind: entry.kind,
    tier,
    licence: LIBRARY_LICENCE,
    page: entry.source.page,
    authors: [...entry.source.authors],
    files,
  };
}

async function addEntry(args: Record<string, unknown>, ctx: PluginContext, catalog: LibraryCatalog, net: LibraryNet) {
  const request = addArgs(args);
  if (!ctx.directory) throw new LibraryError(LibraryRefusal.NoGame, MESSAGE.NoGame);
  const storage = (await ctx.host(HostService.StorageRoot)) as string;
  const source = packSource(catalog, await packFolder(ctx));
  const staged = await stageDelivery(catalog, request, storage, source, net);
  const jobId = libraryFolder(staged.entry.id);
  try {
    await ctx.host(HostService.AssetsDeliver, { output: staged.staged, jobId });
  } finally {
    await rm(staged.staged, { recursive: true, force: true });
  }
  const files = staged.files.map((file) => ({
    path: `${staged.folder}/${file.name}`,
    sha256: file.sha256,
    bytes: file.bytes,
  }));
  await ctx.host(HostService.JobsWrite, { id: jobId, value: recordOf(staged.entry, staged.tier, jobId, files) });
  return {
    id: staged.entry.id,
    kind: staged.entry.kind,
    tier: staged.tier,
    licence: LIBRARY_LICENCE,
    page: staged.entry.source.page,
    authors: staged.entry.source.authors,
    folder: staged.folder,
    files: files.map((file) => file.path),
    use: MESSAGE.Load[staged.entry.kind](staged.entry.id),
  };
}

/** A refusal as the agent reads it: the typed code first, then the detail. */
function refusal(error: unknown): unknown {
  if (error instanceof LibraryError) return new Error(MESSAGE.Refused(error.code, error.message));
  return error;
}

/** The plugin over `deps`; `activate` uses the real network and the shipped catalog. */
export function createLibraryPlugin(deps: LibraryDeps): Promise<PluginActivation> {
  const catalog = deps.catalog ?? parseLibraryCatalog(catalogJson);
  const activation: PluginActivation = {
    async tool(name, args, ctx) {
      try {
        if (name === LibraryTool.Search)
          return { results: searchLibrary(catalog, searchArgs(args)), use: MESSAGE.Search };
        if (name === LibraryTool.Add) return await addEntry(args, ctx, catalog, deps.net);
      } catch (error) {
        throw refusal(error);
      }
      throw new Error(MESSAGE.UnknownTool);
    },
  };
  return Promise.resolve(activation);
}

/** Activation is side-effect-free: the network is reached only inside `library__add`. */
export const activate: Activate = () => createLibraryPlugin({ net: createLibraryNet() });
