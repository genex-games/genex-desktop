import path from "node:path";
import { constants } from "node:fs";
import { realpath, lstat, mkdir, readdir, copyFile } from "node:fs/promises";
import { openNoFollow } from "./fsx.ts";
import { toPosixRelative } from "./paths.ts";
import { createHash } from "node:crypto";
import { isPluginId } from "../shared/plugin-id.ts";
import { ASSET_FOLDERS } from "../shared/game-assets.ts";

/** A Studio delivery job id: a UUID, so it names a folder and never a path. */
const JOB_ID = /^[a-f0-9-]{36}$/;
/** The Genex plugin's delivery namespace: `assets/genex/<job>`. */
const GENEX_NAMESPACE = "genex";
/** Browser assets keep their layout; native Unity assets live in the Editor's import tree. */
export const AssetDeliveryLayout = { Browser: "browser", Unity: "unity" } as const;
export type AssetDeliveryLayout = (typeof AssetDeliveryLayout)[keyof typeof AssetDeliveryLayout];

const MESSAGE = {
  NotRegular: "Asset is not a regular file",
  InvalidNamespace: "Invalid asset namespace",
  InvalidJob: "Invalid delivery job",
  Escapes: "Asset output escapes the authorized game or crosses a symlink",
  ExistingNotRegular: "Existing asset is not a regular file or crosses a symlink",
  ExistingDiffers: "Existing asset differs from the saved result; retrieval will not overwrite it",
  Symlink: "Asset output contains a symlink",
  Exists: "EEXIST: asset destination already exists",
  OutputNotRegular: "Asset output is not a regular file",
} as const;

async function fileDigest(file: string): Promise<string> {
  const handle = await openNoFollow(file, constants.O_RDONLY);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(MESSAGE.NotRegular);
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export interface DeliveryOptions {
  /** A host-selected layout, never an arbitrary path supplied by a plugin. */
  layout?: AssetDeliveryLayout;
  /** Explicit SDK retrieval: accept identical bytes, never overwrite changed game files. */
  reuseExisting?: boolean;
  /** Quota admission runs before copying and counts only files not already present. */
  beforeCopy?: (newBytes: number) => Promise<void>;
}

/** Make (or reuse) a real directory at exactly `target`; a link anywhere on the way is refused. */
async function containedDirectory(target: string): Promise<void> {
  await mkdir(target).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const st = await lstat(target);
  if (st.isSymbolicLink() || !st.isDirectory() || (await realpath(target)) !== target) throw new Error(MESSAGE.Escapes);
}

/** An existing destination may be kept only when it is a regular file with the same bytes. */
async function assertSameFile(src: string, dest: string): Promise<void> {
  const info = await lstat(dest);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(MESSAGE.ExistingNotRegular);
  if ((await fileDigest(src)) !== (await fileDigest(dest))) throw new Error(MESSAGE.ExistingDiffers);
}

/** What a delivery will copy: each file, whether it is already there, and the bytes it adds. */
interface DeliveryPlan {
  allowed: string;
  reuseExisting: boolean;
  files: string[];
  pending: Array<{ src: string; dest: string; reused: boolean }>;
  newBytes: number;
}

/** Plan one output file: a new file adds its bytes, an existing one must be identical and allowed. */
async function planFile(plan: DeliveryPlan, src: string, dest: string, size: number): Promise<void> {
  const existing = await lstat(dest).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (existing) {
    if (!plan.reuseExisting) throw new Error(MESSAGE.Exists);
    await assertSameFile(src, dest);
  } else plan.newBytes += size;
  plan.pending.push({ src, dest, reused: !!existing });
  plan.files.push(toPosixRelative(path.relative(plan.allowed, dest)));
}

/** Walk the output tree, creating contained folders and planning every regular file. */
async function planTree(plan: DeliveryPlan, source: string, destination: string): Promise<void> {
  for (const name of await readdir(source)) {
    const src = path.join(source, name),
      dest = path.join(destination, name),
      st = await lstat(src);
    if (st.isSymbolicLink()) throw new Error(MESSAGE.Symlink);
    if (st.isDirectory()) {
      await containedDirectory(dest);
      await planTree(plan, src, dest);
    } else if (st.isFile()) await planFile(plan, src, dest, st.size);
    else throw new Error(MESSAGE.OutputNotRegular);
  }
}

/** Deliver into a unique host job directory; never overwrite an agent-controlled file. */
export async function deliverAssetFiles(
  output: string,
  root: string,
  jobId: string,
  namespace: string,
  options: DeliveryOptions = {},
): Promise<string[]> {
  if (!isPluginId(namespace)) throw new Error(MESSAGE.InvalidNamespace);
  if (!JOB_ID.test(jobId)) throw new Error(MESSAGE.InvalidJob);
  const allowed = await realpath(root);
  let target = allowed;
  const folder = options.layout === AssetDeliveryLayout.Unity ? ASSET_FOLDERS.UnityGenerated : ASSET_FOLDERS.Browser;
  const folders = folder.split("/");
  for (const part of [...folders, namespace, jobId]) {
    target = path.join(target, part);
    await containedDirectory(target);
  }
  const plan: DeliveryPlan = { allowed, reuseExisting: !!options.reuseExisting, files: [], pending: [], newBytes: 0 };
  await planTree(plan, output, target);
  await options.beforeCopy?.(plan.newBytes);
  for (const file of plan.pending) {
    if (file.reused) await assertSameFile(file.src, file.dest);
    else await copyFile(file.src, file.dest, constants.COPYFILE_EXCL);
  }
  return plan.files;
}

/** Existing Genex delivery layout stays stable. */
export const deliverGenexFiles = (output: string, root: string, jobId: string) =>
  deliverAssetFiles(output, root, jobId, GENEX_NAMESPACE);
