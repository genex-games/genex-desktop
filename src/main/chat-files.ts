/**
 * Where a file a chat names is, and how it may open (shared/chat-files.ts has the renderer side).
 *
 * A name resolves against that chat's game — its folder, or the run's build when the build is
 * newer — or, when it is absolute, wherever it is on this computer. Markdown and images of the
 * game open beside the chat. Everything else opens in the app the system uses for it, and only for
 * the kinds of file that app opens as a document: programs, scripts, installers, profiles, files
 * with an exec bit and any type this list does not know are shown in the file manager instead,
 * never launched. Credentials and the studio's own secrets are not files the chat can link to.
 */
import { execFile, spawn } from "node:child_process";
import { createWriteStream, type Stats } from "node:fs";
import { chmod, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { StudioPlatform } from "../shared/boot.ts";
import {
  CHAT_FILE_LIMIT,
  CHAT_FILE_NAME_MAX,
  ChatFileOpen,
  type ChatFileLink,
  type ChatFileOpenOutside,
  type ChatFileRef,
} from "../shared/chat-files.ts";
import { extensionOf, fileKind } from "../shared/game-file.ts";
import { credentialHomes } from "../substrate/credential-homes.ts";
import { isInside } from "../substrate/paths.ts";
import { hostGitConfig, hostGitEnv } from "../substrate/git-policy.ts";

const execFileAsync = promisify(execFile);

/** Why a click on a file the chat names opens nothing. */
const MESSAGE = {
  gone: (name: string) => `${name || "That file"} isn’t on this computer any more.`,
  notInBuild: "That file isn’t in the build any more.",
} as const;

/** A build's file list is read in one go; a game's history stays well under this. */
const GIT_OUTPUT_MAX = 64 * 1024 * 1024;
/** Commits whose file lists are kept: a commit's files never change. */
const TREES_KEPT = 6;
/** How long the folder's file list answers names given without their folder. */
const LISTING_MS = 3_000;
/** Symbolic links in a commit's tree (mode 120000) are not files of the build. */
const SYMLINK_MODE = "120000";
/** Any exec bit: such a file is only shown, never opened. */
const EXEC_BITS = 0o111;
/** A copied build file is read-only, so it cannot be edited by mistake. */
const READ_ONLY = 0o444;

export interface ChatFileScope {
  home: string;
  /** The chat's game. `head` is the run's build; `preferBuild` while that build is running or not landed. */
  game: { dir: string; head: string | null; preferBuild: boolean; runId: string | null } | null;
  /** Where a Studio chat's relative names are. */
  workspace: string | null;
  /** Never linked: credentials and the studio's secrets. */
  deny: string[];
  /** Run worktrees (`scratch/autopilot/<runId>/<worktree>/…`), whose paths map back into the game. */
  worktrees: string | null;
  /** Where a file only the build has is copied to be opened; no agent process can write there. */
  copies: string;
}

/**
 * Where a person keeps credentials: their own engine logins (the engines' system homes, and the
 * folders their environment moves them to) and the usual key, cloud and registry stores.
 */
export function credentialRoots(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const stores = [
    ".genex",
    ".ssh",
    path.join("Library", "Keychains"),
    ".aws",
    path.join(".config", "gh"),
    ".netrc",
    ".gnupg",
    ".docker",
    ".kube",
    ".npmrc",
  ].map((dir) => path.join(home, dir));
  return [...credentialHomes([], env, home), ...stores];
}

/** Opened in their app as documents. Any other type is shown in the file manager. */
const DOCUMENT_TYPES = new Set([
  // text and code
  ...["txt", "text", "md", "markdown", "mdx", "rtf", "json", "jsonc", "json5", "ndjson", "js", "mjs", "cjs", "jsx"],
  ...["ts", "mts", "cts", "tsx", "css", "scss", "sass", "less", "html", "htm", "xhtml", "xml", "svg", "csv", "tsv"],
  ...["yaml", "yml", "toml", "ini", "cfg", "conf", "log", "diff", "patch", "glsl", "vert", "frag", "wgsl", "hlsl"],
  ...["shader", "lua", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "java", "kt", "swift", "sql", "graphql"],
  ...["gql", "proto", "vue", "svelte", "astro"],
  // images
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif", "ico", "icns", "psd"],
  ...["exr", "hdr", "ktx", "ktx2", "dds", "tga", "aseprite", "ase"],
  // sound and video
  ...["wav", "mp3", "ogg", "oga", "m4a", "aac", "flac", "aif", "aiff", "opus", "mid", "midi", "caf", "weba"],
  ...["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpg", "mpeg", "ogv"],
  // 3D, fonts and documents
  ...["glb", "gltf", "obj", "mtl", "fbx", "usdz", "usd", "usda", "usdc", "stl", "ply", "dae", "blend", "3ds", "vox"],
  ...["ttf", "otf", "woff", "woff2"],
  ...["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "odt", "ods", "odp", "epub"],
]);
/** Documents Windows runs instead of opening: Windows Script Host takes `.js` by default. */
const WINDOWS_RUNS = new Set(["js", "mjs", "cjs"]);
/** Folders macOS treats as one document. Any other folder with an extension is a bundle (an app). */
const DOCUMENT_PACKAGES = new Set(["pages", "numbers", "key", "rtfd"]);

/** A file or a folder, as `openModeFor` tells them apart. */
export const FileShape = { File: "file", Directory: "directory" } as const;
export type FileShape = (typeof FileShape)[keyof typeof FileShape];

/** How a folder opens: a plain one in the file manager, a document package in its app, a bundle only shown. */
function folderOpenMode(ext: string): ChatFileOpenOutside {
  if (!ext) return ChatFileOpen.Folder;
  return DOCUMENT_PACKAGES.has(ext) ? ChatFileOpen.App : ChatFileOpen.Finder;
}

/** How a file or folder opens, by what it is — never by what launching it would do. */
export function openModeFor(
  file: string,
  shape: FileShape,
  platform: NodeJS.Platform = process.platform,
): ChatFileOpenOutside {
  const ext = extensionOf(path.basename(file));
  if (shape === FileShape.Directory) return folderOpenMode(ext);
  const runs = platform === StudioPlatform.Windows && WINDOWS_RUNS.has(ext);
  return DOCUMENT_TYPES.has(ext) && !runs ? ChatFileOpen.App : ChatFileOpen.Finder;
}

/** How a file on disk opens: `openModeFor`, except that anything with an exec bit is only shown. */
function openModeOf(file: string, info: Stats): ChatFileOpenOutside {
  if (info.isDirectory()) return openModeFor(file, FileShape.Directory);
  if ((Number(info.mode) & EXEC_BITS) !== 0) return ChatFileOpen.Finder;
  return openModeFor(file, FileShape.File);
}

/** A control character, which no file name the chat means holds. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL_CHAR = /[\x00-\x1f]/;
/** The position an editor adds to a name (`:42`, `:42:7`, `#L12-L20`). */
const TRAILING_POSITION = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

/**
 * A `file:` URL's path, or null when it is not one the platform can read. On Windows the URL's
 * path of a drive (`/C:/Users/me`) is that drive's path (`C:/Users/me`).
 */
function filePathOf(value: string, platform: NodeJS.Platform): string | null {
  try {
    const file = decodeURIComponent(new URL(value).pathname);
    return platform === StudioPlatform.Windows ? file.replace(/^\/(?=[A-Za-z]:\/)/, "") : file;
  } catch {
    return null;
  }
}

/** The chat's words for a file → a name to look up, or null when it cannot be one. */
export function chatFileName(raw: unknown, platform: NodeJS.Platform = process.platform): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed || trimmed.length > CHAT_FILE_NAME_MAX || CONTROL_CHAR.test(trimmed)) return null;
  let value = trimmed.replace(/^(["'`])(.*)\1$/, "$2");
  if (/^file:/i.test(value)) {
    const file = filePathOf(value, platform);
    if (file === null) return null;
    value = file;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return null;
  }
  // A tool row clips long input ("src/a… [12 more chars]"); a clipped name is not a file.
  if (/…|\[\d+ more chars\]$/.test(value)) return null;
  return value.replace(TRAILING_POSITION, "") || null;
}

function tilde(file: string, home: string): string {
  return isInside(home, file) ? `~${file.slice(path.resolve(home).length)}` : file;
}

/** A path part that is a `.git` folder, in any case: APFS and NTFS ignore it. */
const isGitPart = (part: string): boolean => part.toLowerCase() === ".git";

/** A game-relative name, normalized; null when it leaves the game or reaches into `.git`. */
function gamePath(name: string, base?: string): string | null {
  const slashed = name.replace(/\\/g, "/");
  const joined = base ? path.posix.join(path.posix.dirname(base.replace(/\\/g, "/")), slashed) : slashed;
  const value = path.posix.normalize(joined).replace(/^(\.\/)+/, "");
  const leaves = !value || value === "." || value === ".." || value.startsWith("../") || value.startsWith("/");
  if (leaves || value.split("/").some(isGitPart)) return null;
  return value;
}

/** A path inside `root` that reaches into a `.git` folder. */
const inGit = (root: string, file: string): boolean => path.relative(root, file).split(path.sep).some(isGitPart);

/** A realpath strictly inside `root` (not `root` itself), outside `.git` and every denied folder. */
const reachable = (root: string, file: string, deny: string[]): boolean =>
  file !== root && isInside(root, file) && !inGit(root, file) && !deny.some((dir) => isInside(dir, file));

type Found =
  /** In the game folder. */
  | { where: "game"; rel: string; file: string; info: Stats }
  /** Only the run's build has it (or the build's is newer): a git blob. */
  | { where: "build"; rel: string; blob: string }
  /** Anywhere else on this computer. `rel` when it is a run worktree's copy of a game file. */
  | { where: "disk"; file: string; info: Stats; rel?: string };

type Game = NonNullable<ChatFileScope["game"]>;

/** Markdown and images: the kinds of game file the studio shows beside the chat. */
function opensBeside(file: string): boolean {
  const kind = fileKind(file);
  return kind === "markdown" || kind === "image";
}

const git = async (dir: string, args: string[]) => {
  const env = hostGitEnv();
  return execFileAsync("git", [...(await hostGitConfig(dir, env)), "-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_MAX,
    env,
  });
};

/** A commit's files as `ls-tree -r -z` lists them: path → blob, symbolic links left out. */
function treeEntries(stdout: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of stdout.split("\0")) {
    const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match?.[1] && match[2] && match[3] && match[1] !== SYMLINK_MODE) files.set(match[3], match[2]);
  }
  return files;
}

export class ChatFileResolver {
  /** The PATH that finds the user's git filters (git-lfs); an app started from the Finder has a bare one. */
  readonly #toolPath: () => Promise<string>;
  /** A commit's files never change; a few recent ones are kept. */
  readonly #trees = new Map<string, Promise<Map<string, string>>>();
  /** The folder's file list, briefly, for names given without their folder. */
  readonly #listings = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(toolPath: () => Promise<string> = async () => process.env.PATH ?? "") {
    this.#toolPath = toolPath;
  }

  /** The toolchain PATH without ambient Git configuration or credential routing. */
  async #userGitEnv(): Promise<NodeJS.ProcessEnv> {
    const toolPath = await this.#toolPath().catch(() => process.env.PATH ?? "");
    return hostGitEnv(toolPath ? { PATH: toolPath } : {});
  }

  async resolve(scope: ChatFileScope, refs: ChatFileRef[]): Promise<Array<ChatFileLink | null>> {
    const deny = await this.#denyRoots(scope);
    return Promise.all(
      refs.slice(0, CHAT_FILE_LIMIT).map(async (ref) => {
        const found = await this.#find(scope, ref, deny).catch(() => null);
        return found ? this.#link(scope, found) : null;
      }),
    );
  }

  /** What a click opens: an existing path and the way to open it (`beside` is never answered here). */
  async target(scope: ChatFileScope, ref: ChatFileRef): Promise<{ open: ChatFileOpenOutside; target: string }> {
    const found = await this.#find(scope, ref, await this.#denyRoots(scope)).catch(() => null);
    if (!found) throw new Error(MESSAGE.gone(String(ref?.name ?? "").trim()));
    if (found.where === "build") {
      const copy = await this.#copyOut(scope, found.rel, found.blob);
      return { open: openModeFor(found.rel, FileShape.File), target: copy };
    }
    return { open: openModeOf(found.file, found.info), target: found.file };
  }

  #link(scope: ChatFileScope, found: Found): ChatFileLink {
    if (found.where === "build") {
      const open = opensBeside(found.rel) ? ChatFileOpen.Beside : openModeFor(found.rel, FileShape.File);
      return { open, path: found.rel, build: true };
    }
    // Judged by the file itself: a `notes.md` that links to a script is the script.
    const { rel } = found;
    if (rel && found.info.isFile() && opensBeside(rel) && opensBeside(found.file))
      return { open: ChatFileOpen.Beside, path: rel };
    return { open: openModeOf(found.file, found.info), path: tilde(found.file, scope.home) };
  }

  async #find(scope: ChatFileScope, ref: ChatFileRef, deny: string[]): Promise<Found | null> {
    const name = chatFileName(ref?.name);
    if (!name) return null;
    const base = typeof ref.base === "string" && ref.base.length <= CHAT_FILE_NAME_MAX ? ref.base : undefined;
    if (name === "~" || name.startsWith("~/") || path.isAbsolute(name)) {
      const absolute = path.resolve(name.startsWith("~") ? path.join(scope.home, name.slice(1)) : name);
      return this.#onDisk(scope, absolute, deny);
    }
    if (scope.game) return this.#findInGame(scope.game, name, base, deny);
    if (scope.workspace) return this.#findInWorkspace(scope, scope.workspace, gamePath(name, base), deny);
    return null;
  }

  async #findInGame(game: Game, name: string, base: string | undefined, deny: string[]): Promise<Found | null> {
    const rel = gamePath(name, base);
    if (!rel) return null;
    const direct = await this.#inGame(game, rel, deny);
    if (direct || base || /^\.{1,2}\//.test(name)) return direct;
    // `intro.mp4`, `video/intro.mp4`: the one file of the game with that name.
    const [only, ...more] = await this.#named(game, rel);
    return only !== undefined && more.length === 0 ? this.#inGame(game, only, deny) : null;
  }

  async #findInWorkspace(scope: ChatFileScope, workspace: string, rel: string | null, deny: string[]) {
    const root = await realpath(workspace).catch(() => null);
    if (!root || !rel) return null;
    const file = await realpath(path.join(root, ...rel.split("/"))).catch(() => null);
    if (!file || file === root || !isInside(root, file)) return null;
    return this.#onDisk(scope, file, deny);
  }

  async #onDisk(scope: ChatFileScope, absolute: string, deny: string[]): Promise<Found | null> {
    const file = await realpath(absolute).catch(() => null);
    // The disk's root is never what a chat means (`//` is a code comment).
    if (!file || file === path.parse(file).root || deny.some((root) => isInside(root, file))) return null;
    const info = await stat(file).catch(() => null);
    if (!info || (!info.isFile() && !info.isDirectory())) return null;
    if (!scope.game) return { where: "disk", file, info };
    const dir = await realpath(scope.game.dir).catch(() => null);
    if (dir && file !== dir && isInside(dir, file)) {
      if (inGit(dir, file)) return null;
      return { where: "game", rel: path.relative(dir, file).split(path.sep).join("/"), file, info };
    }
    return (await this.#worktreeCopy(scope, scope.game, file, info, deny)) ?? { where: "disk", file, info };
  }

  /** A file in the run's worktree that is its copy of a game file; its Markdown opens beside. */
  async #worktreeCopy(scope: ChatFileScope, game: Game, file: string, info: Stats, deny: string[]) {
    const worktrees = scope.worktrees ? await realpath(scope.worktrees).catch(() => null) : null;
    if (!worktrees || !isInside(worktrees, file)) return null;
    const [runId, , ...rest] = path.relative(worktrees, file).split(path.sep);
    const ours = Boolean(runId) && runId === game.runId && rest.length > 0 && !rest.some(isGitPart);
    if (!ours) return null;
    const rel = rest.join("/");
    const known = await this.#inGame(game, rel, deny);
    return known ? ({ where: "disk", file, info, rel } as const) : null;
  }

  async #inGame(game: Game, rel: string, deny: string[]): Promise<Found | null> {
    const root = await realpath(game.dir).catch(() => null);
    if (!root) return null;
    const folder = await this.#folderFile(root, rel, deny);
    const blob = game.head ? ((await this.#tree(game.dir, game.head)).get(rel) ?? null) : null;
    const buildFirst = blob !== null && (game.preferBuild || !folder);
    if (!buildFirst || blob === null) return folder ? { where: "game", rel, ...folder } : null;
    // The build's copy is newer only when it differs from the folder's.
    const same = folder?.info.isFile() === true && (await this.#blobOf(game.dir, folder.file)) === blob;
    return folder && same ? { where: "game", rel, ...folder } : { where: "build", rel, blob };
  }

  /** The game folder's own file or folder at `rel`, when it is one the chat may link. */
  async #folderFile(root: string, rel: string, deny: string[]): Promise<{ file: string; info: Stats } | null> {
    const file = await realpath(path.join(root, ...rel.split("/"))).catch(() => null);
    if (!file || !reachable(root, file, deny)) return null;
    const info = await stat(file).catch(() => null);
    return info && (info.isFile() || info.isDirectory()) ? { file, info } : null;
  }

  /** Files of the game (folder and build) whose path ends with `rel`. */
  async #named(game: Game, rel: string): Promise<string[]> {
    const pool = new Set(await this.#listing(game.dir));
    if (game.head) for (const file of (await this.#tree(game.dir, game.head)).keys()) pool.add(file);
    return [...pool].filter((file) => file === rel || file.endsWith(`/${rel}`));
  }

  #tree(dir: string, head: string): Promise<Map<string, string>> {
    const key = `${dir}\n${head}`;
    const kept = this.#trees.get(key);
    if (kept) return kept;
    const tree = /^[0-9a-f]{7,64}$/i.test(head)
      ? git(dir, ["ls-tree", "-r", "-z", "--full-tree", head]).then(
          ({ stdout }) => treeEntries(String(stdout)),
          () => new Map<string, string>(),
        )
      : Promise.resolve(new Map<string, string>());
    this.#trees.set(key, tree);
    for (const oldest of [...this.#trees.keys()].slice(0, Math.max(0, this.#trees.size - TREES_KEPT))) {
      this.#trees.delete(oldest);
    }
    return tree;
  }

  #listing(dir: string): Promise<string[]> {
    const cached = this.#listings.get(dir);
    if (cached && Date.now() - cached.at < LISTING_MS) return cached.files;
    const files = git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).then(
      ({ stdout }) => String(stdout).split("\0").filter(Boolean),
      () => [] as string[],
    );
    this.#listings.set(dir, { at: Date.now(), files });
    return files;
  }

  /** The raw file's blob identity; resolving a link never executes a repository clean filter. */
  async #blobOf(dir: string, file: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", dir, "hash-object", "--no-filters", "--", file], {
        encoding: "utf8",
        env: await this.#userGitEnv(),
      });
      return String(stdout).trim() || null;
    } catch {
      return null;
    }
  }

  async #denyRoots(scope: ChatFileScope): Promise<string[]> {
    const roots = await Promise.all(scope.deny.map((dir) => realpath(dir).catch(() => path.resolve(dir))));
    return [...new Set([...roots, ...scope.deny.map((dir) => path.resolve(dir))])];
  }

  /** A read-only copy of the build's file, named as the file so its app recognizes it. */
  async #copyOut(scope: ChatFileScope, rel: string, blob: string): Promise<string> {
    if (!scope.game || !/^[0-9a-f]{40,64}$/i.test(blob)) throw new Error(MESSAGE.notInBuild);
    const folder = path.join(scope.copies, blob.slice(0, 16));
    const file = path.join(folder, path.posix.basename(rel));
    if ((await stat(file).catch(() => null))?.isFile()) return file;
    await mkdir(folder, { recursive: true });
    const partial = path.join(folder, `.${process.pid}-${Date.now()}.partial`);
    // Read stored bytes; opening a chat link never runs smudge filters or downloads LFS content.
    const child = spawn("git", ["-C", scope.game.dir, "cat-file", "blob", blob], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: await this.#userGitEnv(),
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      await pipeline(child.stdout, createWriteStream(partial));
      if ((await exited) !== 0) throw new Error(MESSAGE.notInBuild);
      await chmod(partial, READ_ONLY);
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    return file;
  }
}
