// Fill a test user's home like a person's before Genex first starts on it: many small files in
// the usual folders, a projects folder with deep node_modules trees and paths past Windows'
// MAX_PATH, a game library with large files, a junction that loops back, and the homes Genex's
// sandbox denies (.ssh, .claude, .codex, a browser profile). The sandbox start walks the profile,
// so its size is the point.
//
//   node scripts/canary/lived-in-profile.ts --home <dir> [--files 150000] [--large-files 3]
//
// It refuses the running account's own home unless --force-own-home is given: it is meant for a
// fresh canary user, never a person's account.
import { mkdir, open, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/** Files written by default: about what a few years of a gaming PC's profile holds. */
const DEFAULT_FILES = 150_000;
/** Files written at once. */
const BATCH = 256;
/** Large files in the game library, by size and by default count. */
const LARGE_FILE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_LARGE_FILES = 3;
/** How deep a node_modules chain goes: deep enough to pass 260 characters. */
const NODE_MODULES_DEPTH = 12;

/** Where the files go, and each folder's share of them. */
const BUCKETS = [
  { dir: ["Documents", "Work"], share: 0.12, ext: ".docx" },
  { dir: ["Downloads"], share: 0.08, ext: ".pdf" },
  { dir: ["Pictures", "Camera Roll"], share: 0.15, ext: ".jpg" },
  { dir: ["Music", "Library"], share: 0.05, ext: ".mp3" },
  { dir: ["source", "repos"], share: 0.35, ext: ".js" },
  { dir: ["AppData", "Local", "Temp"], share: 0.1, ext: ".tmp" },
  { dir: ["AppData", "Local", "Google", "Chrome", "User Data", "Default", "Cache"], share: 0.1, ext: "" },
  { dir: ["AppData", "Roaming", "discord", "Cache"], share: 0.05, ext: "" },
] as const;

/** The homes the sandbox denies (srt-win stamps each deny's parent), each with one file. */
const DENIED_HOMES = [
  [".ssh", "known_hosts"],
  [".ssh", "id_ed25519"],
  [".claude", "settings.json"],
  [".codex", "config.toml"],
  ["AppData", "Local", "Google", "Chrome", "User Data", "Local State"],
  [".gitconfig"],
] as const;

/** Folders of at most this many files, as real folders hold. */
const FILES_PER_FOLDER = 120;

async function writeBucket(home: string, bucket: (typeof BUCKETS)[number], count: number): Promise<number> {
  const root = path.join(home, ...bucket.dir);
  const jobs: Array<() => Promise<void>> = [];
  for (let index = 0; index < count; index++) {
    const folder = path.join(root, `folder-${Math.floor(index / FILES_PER_FOLDER)}`);
    jobs.push(async () => {
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `file-${index}${bucket.ext}`), `canary ${index}\n`);
    });
  }
  for (let start = 0; start < jobs.length; start += BATCH)
    await Promise.all(jobs.slice(start, start + BATCH).map((job) => job()));
  return count;
}

/** A project whose node_modules nest until the path is longer than Windows' MAX_PATH. */
async function deepProject(home: string): Promise<string> {
  const parts = [home, "source", "repos", "my-first-game"];
  for (let depth = 0; depth < NODE_MODULES_DEPTH; depth++)
    parts.push("node_modules", `@scope-${depth}`, `package-number-${depth}`);
  const dir = path.join(...parts);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "index.js");
  await writeFile(file, "module.exports = {};\n");
  return file;
}

/** Large files, sized without writing their bytes (the file system allocates them lazily). */
async function gameLibrary(home: string, count: number): Promise<void> {
  const dir = path.join(home, "SteamLibrary", "steamapps", "common", "Big Game");
  await mkdir(dir, { recursive: true });
  for (let index = 0; index < count; index++) {
    const handle = await open(path.join(dir, `data-${index}.pak`), "w");
    await handle.truncate(LARGE_FILE_BYTES);
    await handle.close();
  }
}

/** A link inside Documents back to Documents: a walk that follows links never ends. */
async function loopingLink(home: string): Promise<string> {
  const documents = path.join(home, "Documents");
  const link = path.join(documents, "Shortcuts", "Back to Documents");
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(documents, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      files: { type: "string", default: String(DEFAULT_FILES) },
      "large-files": { type: "string", default: String(DEFAULT_LARGE_FILES) },
      "force-own-home": { type: "boolean", default: false },
    },
  });
  if (!values.home) throw new Error("--home is required");
  const home = path.resolve(values.home);
  if (home === os.homedir() && !values["force-own-home"])
    throw new Error(`${home} is this account's own home; pass --force-own-home when it is the canary user's`);
  const total = Number(values.files);
  const started = performance.now();
  let written = 0;
  for (const bucket of BUCKETS) written += await writeBucket(home, bucket, Math.round(total * bucket.share));
  for (const parts of DENIED_HOMES) {
    const file = path.join(home, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "canary\n");
  }
  const deep = await deepProject(home);
  const large = Number(values["large-files"]);
  await gameLibrary(home, large);
  const link = await loopingLink(home);
  const seconds = Math.round((performance.now() - started) / 1000);
  console.log(`lived-in profile: ${written} files in ${seconds} s under ${home}`);
  console.log(
    `  deepest path: ${deep.length} characters; ${large} × ${LARGE_FILE_BYTES / 2 ** 30} GB game files; loop: ${link}`,
  );
}

await main();
