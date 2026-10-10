import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectUnityProject } from "./bridge-client.ts";

const PACKAGE = "com.genex.unity-bridge";
const RECEIPT = ".genex-install.json";
const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EDITORS = 40;
const VERSION = /^6000\.\d+\.\d+[abfp]\d+$/;
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "editor-package");
const MESSAGE = {
  Absolute: "Choose an absolute Unity project path.",
  Exists: "The project folder already exists. Open it instead of creating over its content.",
  Version: "Choose an installed Unity 6 version, such as 6000.5.5f1.",
  Edited: "The installed Unity bridge was modified. Preserve your edits before updating it.",
  Link: "Unity package installation refuses linked directories or files.",
  Conflict: "The Unity package manifest changed during installation. Retry after reviewing it.",
  Editor: "Choose a Unity Editor from the detected installed versions.",
};

interface PackageSnapshot {
  [file: string]: string;
}
/** A detected installation; its executable is never inferred from an agent command. */
export interface UnityEditor {
  version: string;
  executable: string;
}

function sha(text: Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await lstat(file).catch(() => null));
}

/** Every file considered for replacement is plain and bounded; Unity-generated metadata is retained. */
async function snapshot(root: string, relative = "", files: PackageSnapshot = {}): Promise<PackageSnapshot> {
  return snapshotEntries(root, relative, files, { entries: 0 });
}

async function packageFile(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(MESSAGE.Link);
  if (info.size > MAX_FILE_BYTES) throw new Error("Unity bridge package exceeds its bounded file budget.");
}

async function snapshotEntries(
  root: string,
  relative: string,
  files: PackageSnapshot,
  budget: { entries: number },
): Promise<PackageSnapshot> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (++budget.entries > MAX_FILES) throw new Error("Unity bridge package exceeds its bounded file budget.");
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(MESSAGE.Link);
    if (entry.isDirectory()) {
      await snapshotEntries(root, name, files, budget);
      continue;
    }
    if (!entry.isFile()) throw new Error(MESSAGE.Link);
    const file = path.join(root, name);
    await packageFile(file);
    if (name === RECEIPT || name.endsWith(".meta")) continue;
    files[name.split(path.sep).join("/")] = sha(await readFile(file));
  }
  return files;
}

function sameSnapshot(a: PackageSnapshot, b: PackageSnapshot): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

async function plainDirectory(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(MESSAGE.Link);
  const resolved = await realpath(file);
  const equal = process.platform === "win32" ? resolved.toLowerCase() === file.toLowerCase() : resolved === file;
  if (!equal) throw new Error(MESSAGE.Link);
}

async function checkInstalled(target: string): Promise<PackageSnapshot | null> {
  if (!(await exists(target))) return null;
  await plainDirectory(target);
  const receiptFile = path.join(target, RECEIPT);
  const info = await lstat(receiptFile).catch(() => null);
  if (!info) throw new Error(MESSAGE.Edited);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(MESSAGE.Link);
  if (info.size > MAX_FILE_BYTES) throw new Error("Unity bridge receipt exceeds its bounded file budget.");
  const receipt = await readFile(receiptFile, "utf8");
  let saved: PackageSnapshot;
  try {
    saved = JSON.parse(receipt);
  } catch {
    throw new Error(MESSAGE.Edited);
  }
  const current = await snapshot(target);
  if (!saved || typeof saved !== "object" || !sameSnapshot(current, saved)) throw new Error(MESSAGE.Edited);
  return current;
}

/** Copy only the metadata Unity generated for known package files, preserving stable GUIDs on update. */
async function preserveMetadata(from: string, to: string, relative = ""): Promise<void> {
  await plainDirectory(path.join(from, relative));
  for (const entry of await readdir(path.join(from, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (await exists(path.join(to, name))) await preserveMetadata(from, to, name);
      continue;
    }
    if (!entry.name.endsWith(".meta")) continue;
    await packageFile(path.join(from, name));
    const subject = name.slice(0, -5);
    if (await exists(path.join(to, subject))) await cp(path.join(from, name), path.join(to, name));
  }
}

async function installTransaction(
  packages: string,
  target: string,
  before: string,
  manifest: string,
  source: PackageSnapshot,
  installed: PackageSnapshot | null,
  signal?: AbortSignal,
): Promise<void> {
  const stage = path.join(packages, `.genex-stage-${randomUUID()}`);
  const backup = path.join(packages, `.genex-backup-${randomUUID()}`);
  const manifestPath = path.join(packages, "manifest.json");
  const nextManifest = path.join(packages, `.genex-manifest-${randomUUID()}.json`);
  let moved = false,
    replaced = false;
  try {
    await cp(SOURCE, stage, { recursive: true });
    if (installed) await preserveMetadata(target, stage);
    await writeFile(path.join(stage, RECEIPT), `${JSON.stringify(source, null, 2)}\n`);
    await writeFile(nextManifest, manifest, { flag: "wx" });
    signal?.throwIfAborted();
    if ((await readFile(manifestPath, "utf8")) !== before) throw new Error(MESSAGE.Conflict);
    if (installed) {
      if (!sameSnapshot(installed, (await checkInstalled(target)) ?? {})) throw new Error(MESSAGE.Edited);
      await rename(target, backup);
      moved = true;
      if (!sameSnapshot(installed, (await checkInstalled(backup)) ?? {})) throw new Error(MESSAGE.Edited);
    }
    await rename(stage, target);
    replaced = true;
    await rename(nextManifest, manifestPath);
  } catch (error) {
    if (replaced) await rm(target, { recursive: true, force: true });
    if (moved) await rename(backup, target);
    throw error;
  } finally {
    // All three paths are unique children of the validated project Packages folder.
    await rm(stage, { recursive: true, force: true });
    await rm(nextManifest, { force: true });
  }
  await rm(backup, { recursive: true, force: true });
}

/** Install the bundled package explicitly, preserving dependencies and refusing edited package content. */
export async function installUnityBridge(requestedRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { root } = await inspectUnityProject(requestedRoot);
  const packages = path.join(root, "Packages");
  await plainDirectory(packages);
  const target = path.join(packages, PACKAGE);
  const installed = await checkInstalled(target);
  const source = await snapshot(SOURCE);
  const before = await readFile(path.join(packages, "manifest.json"), "utf8");
  const manifest = JSON.parse(before);
  const dependency = `file:${PACKAGE}`;
  const current = manifest.dependencies[PACKAGE];
  if (current && current !== dependency)
    throw new Error("A different Unity bridge dependency is configured. Review it before replacing it.");
  if (installed && sameSnapshot(installed, source) && current === dependency)
    return { installed: true, changed: false, projectRoot: root };
  manifest.dependencies[PACKAGE] = dependency;
  await installTransaction(
    packages,
    target,
    before,
    `${JSON.stringify(manifest, null, 2)}\n`,
    source,
    installed,
    signal,
  );
  return { installed: true, changed: true, projectRoot: root };
}

/** Create only a new Unity source folder; existing projects are never used as a template destination. */
export async function createUnityProject(requestedRoot: string, version: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(requestedRoot)) throw new Error(MESSAGE.Absolute);
  if (!VERSION.test(version)) throw new Error(MESSAGE.Version);
  if (await exists(requestedRoot)) throw new Error(MESSAGE.Exists);
  const parent = await realpath(path.dirname(requestedRoot));
  const root = path.join(parent, path.basename(requestedRoot));
  await mkdir(root);
  try {
    for (const directory of ["Assets", "Packages", "ProjectSettings"]) await mkdir(path.join(root, directory));
    await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), `m_EditorVersion: ${version}\n`);
    const dependencies = Object.fromEntries(
      ["audio", "imageconversion", "physics", "ui"].map((name) => [`com.unity.modules.${name}`, "1.0.0"]),
    );
    await writeFile(path.join(root, "Packages", "manifest.json"), `${JSON.stringify({ dependencies }, null, 2)}\n`);
    signal?.throwIfAborted();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { created: true, projectRoot: root, version };
}

function editorRoot(): string {
  if (process.platform === "win32")
    return path.join(process.env.ProgramFiles || "C:\\Program Files", "Unity/Hub/Editor");
  if (process.platform === "darwin") return "/Applications/Unity/Hub/Editor";
  return path.join(os.homedir(), "Unity/Hub/Editor");
}

function editorBinary(): string {
  if (process.platform === "darwin") return "Unity.app/Contents/MacOS/Unity";
  if (process.platform === "win32") return "Editor/Unity.exe";
  return "Editor/Unity";
}

/** Read the standard Hub installations without downloading or signing into Unity. */
export async function listUnityEditors(): Promise<UnityEditor[]> {
  const root = editorRoot();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const editors: UnityEditor[] = [];
  for (const entry of entries.slice(0, MAX_EDITORS)) {
    if (!entry.isDirectory() || !VERSION.test(entry.name)) continue;
    const executable = path.join(root, entry.name, editorBinary());
    if ((await lstat(executable).catch(() => null))?.isFile()) editors.push({ version: entry.name, executable });
  }
  return editors.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/** A human-invoked Open Editor action launches one detected GUI application with fixed project arguments. */
export async function launchUnityEditor(root: string, executable: string) {
  const project = await inspectUnityProject(root);
  const editor = (await listUnityEditors()).find((candidate) => candidate.executable === executable);
  if (!editor) throw new Error(MESSAGE.Editor);
  const child = spawn(editor.executable, ["-projectPath", project.root], {
    env: unityEditorEnvironment(process.env),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { opened: true, projectRoot: project.root, version: editor.version };
}

/** A GUI Editor needs profile/toolchain paths; provider keys and shell authentication stay in Genex. */
export function unityEditorEnvironment(parent: Record<string, string | undefined>): Record<string, string> {
  const basics = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LANGUAGE",
    "TZ",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    "__CF_USER_TEXT_ENCODING",
  ]);
  return Object.fromEntries(
    Object.entries(parent).filter(
      ([key, value]) => value !== undefined && (basics.has(key.toUpperCase()) || /^LC_/.test(key)),
    ),
  ) as Record<string, string>;
}
