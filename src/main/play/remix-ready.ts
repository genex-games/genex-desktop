/**
 * Whether a remixable game's source on Genex holds a game (`game-source.ts`), so Play offers Remix
 * only where it would make one. A game whose creator never shared its project has a README, or a publish's bookkeeping,
 * as its source; its card shows no Remix. Git is asked for the source's head commit, and once per
 * commit for its file names without their contents (a blobless shallow clone of Genex's https git)
 * and, when that decides it, its package.json. Answers are kept by commit in Studio's data and
 * trusted for a while before git is asked again, so a game is looked at anew only once its source
 * changes. A look that fails says no and keeps nothing: Remix stays hidden until one works. A
 * computer without Git (a Mac without Apple's developer tools) is never asked: its /usr/bin/git only
 * stands in for theirs and would ask the person to install them while they browse.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { HOST_GIT_CONFIG, hostGitEnv, hostGitRuns } from "../../substrate/git-policy.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { marksGame, sourceHoldsGame } from "./game-source.ts";
import { isRemixSource } from "./remix.ts";

const exec = promisify(execFile);

/** How long a kept answer is trusted before git is asked for the source's head again. */
export const READY_TRUST_MS = 10 * MINUTE_MS;
/**
 * How long the answer to whether this computer runs Git is trusted: once Apple's developer tools are
 * installed, Remix shows within it.
 */
export const GIT_RUNS_TRUST_MS = MINUTE_MS;
/** How long asking git for a source's head may take. */
const HEAD_TIMEOUT_MS = 15 * SECOND_MS;
/** How long listing a source's files may take: a blobless clone of one commit. */
const LIST_TIMEOUT_MS = MINUTE_MS;
/** The most git may print for a source's file names. */
const LIST_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
/** How many sources are looked at at once. */
const LOOKS_AT_ONCE = 4;

/** Settings every look runs under: https only, no filters, hooks or prompts (the host's git policy first). */
const LOOK_CONFIG = [
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "filter.lfs.smudge=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
] as const;

/** What a look at a source answers: its files and, when it has one, its root package.json's text. */
export interface SourceListing {
  paths: string[];
  packageJson: string | null;
}

/** An answer kept for a source: the commit it is for, whether that commit holds a game, and when git last said so. */
export interface KeptReadiness {
  head: string;
  holds: boolean;
  at: number;
}

/** How a readiness asks git and keeps its answers. */
export interface RemixReadyDeps {
  /** Whether this computer runs Git at all: a Mac without Apple's developer tools has only a stand-in. */
  gitRuns(): Promise<boolean>;
  /** The source's head commit, or null when git can't say. */
  head(url: string): Promise<string | null>;
  /** The source's files at its head. */
  list(url: string): Promise<SourceListing>;
  load(): Promise<Record<string, KeptReadiness>>;
  save(kept: Record<string, KeptReadiness>): Promise<void>;
  now(): number;
}

/** A kept answer as read back: anything else is no answer. */
const isKept = (value: unknown): value is KeptReadiness => {
  const kept = value as Partial<KeptReadiness> | null;
  return typeof kept?.head === "string" && typeof kept.holds === "boolean" && Number.isFinite(kept.at);
};

/** Readiness over `deps`: `ready(url)` answers whether that source holds a game, a few looks at a time. */
export function remixReadiness(deps: RemixReadyDeps) {
  let kept: Promise<Record<string, KeptReadiness>> | null = null;
  const looking = new Map<string, Promise<boolean>>();
  const queue: Array<() => void> = [];
  let running = 0;
  let git: { at: number; runs: Promise<boolean> } | null = null;
  /** Whether git runs here, asked once for a while: never run a stand-in that asks to install tools. */
  const gitRuns = () => {
    if (!git || deps.now() - git.at >= GIT_RUNS_TRUST_MS)
      git = { at: deps.now(), runs: deps.gitRuns().catch(() => false) };
    return git.runs;
  };
  const memory = () => {
    kept ??= deps.load().then(
      (all) => Object.fromEntries(Object.entries(all).filter(([, value]) => isKept(value))),
      () => ({}),
    );
    return kept;
  };
  /** Run `look` once a slot is free, so a full shelf never opens dozens of connections at once. */
  const slot = async <T>(look: () => Promise<T>): Promise<T> => {
    if (running >= LOOKS_AT_ONCE) await new Promise<void>((resolve) => queue.push(resolve));
    running += 1;
    try {
      return await look();
    } finally {
      running -= 1;
      queue.shift()?.();
    }
  };
  const look = async (url: string): Promise<boolean> => {
    if (!(await gitRuns())) return false;
    const all = await memory();
    const known = all[url];
    if (known && deps.now() - known.at < READY_TRUST_MS) return known.holds;
    const head = await slot(() => deps.head(url)).catch(() => null);
    if (!head) return false;
    if (known?.head === head) {
      all[url] = { ...known, at: deps.now() };
      await deps.save(all).catch(() => {});
      return known.holds;
    }
    const listing = await slot(() => deps.list(url)).catch(() => null);
    if (!listing) return false;
    const holds = sourceHoldsGame(listing.paths, listing.packageJson);
    all[url] = { head, holds, at: deps.now() };
    await deps.save(all).catch(() => {});
    return holds;
  };
  /** Whether the source at `url` holds a game; one look per source at a time. */
  const ready = (url: string): Promise<boolean> => {
    if (!isRemixSource(url)) return Promise.resolve(false);
    const pending = looking.get(url);
    if (pending) return pending;
    const started = look(url).finally(() => looking.delete(url));
    looking.set(url, started);
    return started;
  };
  return { ready };
}

/** Play's remix readiness as `remixReadiness` makes it. */
export type RemixReadiness = ReturnType<typeof remixReadiness>;

/** The most games one ask may name: a shelf's worth of cards. */
const READY_MAX_SLUGS = 100;

/** Where a readiness for slugs finds each game's source: the catalog's address for it, else its own page's. */
export interface SourceAddresses {
  /** The address the catalog last named for `slug`, if it named one. */
  sourceOf(slug: string): string | null;
  /** The game's page, which names its address. */
  world(slug: string): Promise<{ cloneUrl: string | null }>;
}

/** Whether each named game's source holds a game: what Play asks before it shows a card's Remix. */
export async function readyFor(
  slugs: readonly unknown[],
  readiness: Pick<RemixReadiness, "ready">,
  addresses: SourceAddresses,
): Promise<Record<string, boolean>> {
  const wanted = [...new Set(slugs.filter(isPlaySlug))].slice(0, READY_MAX_SLUGS);
  const answers = await Promise.all(
    wanted.map(async (slug) => {
      const url = addresses.sourceOf(slug) ?? (await addresses.world(slug).catch(() => null))?.cloneUrl ?? null;
      return [slug, url ? await readiness.ready(url) : false] as const;
    }),
  );
  return Object.fromEntries(answers);
}

/**
 * `gallery` whose game pages offer Remix only when the game's source holds a game: the viewer's
 * bar asks its page, so it hides Remix as a card does.
 */
export function withReadyRemix<
  G extends { world(slug: string): Promise<{ remixable: boolean; cloneUrl: string | null }> },
>(gallery: G, readiness: Pick<RemixReadiness, "ready">): G {
  const world = async (slug: string) => {
    const page = await gallery.world(slug);
    if (!page.remixable || !page.cloneUrl) return page;
    return (await readiness.ready(page.cloneUrl)) ? page : { ...page, remixable: false };
  };
  return { ...gallery, world };
}

/** The head commit git names for `url`'s default branch, or null. */
async function gitHead(url: string): Promise<string | null> {
  const { stdout } = await exec("git", [...HOST_GIT_CONFIG, ...LOOK_CONFIG, "ls-remote", "--", url, "HEAD"], {
    env: hostGitEnv(),
    windowsHide: true,
    timeout: HEAD_TIMEOUT_MS,
  });
  const sha = stdout.split(/\s/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** `url`'s files at its head, from a blobless shallow clone in a folder of `scratch` that goes again after. */
async function gitList(url: string, scratch: string): Promise<SourceListing> {
  const dir = await mkdtemp(path.join(scratch, "remix-look-"));
  const options = { env: hostGitEnv({ GIT_LFS_SKIP_SMUDGE: "1" }), windowsHide: true, timeout: LIST_TIMEOUT_MS };
  try {
    const clone = [...HOST_GIT_CONFIG, ...LOOK_CONFIG, "clone", "--quiet", "--depth=1", "--filter=blob:none"];
    await exec("git", [...clone, "--no-checkout", "--single-branch", "--no-tags", "--", url, dir], options);
    const listed = await exec("git", [...HOST_GIT_CONFIG, "ls-tree", "-r", "-z", "--name-only", "HEAD"], {
      ...options,
      cwd: dir,
      maxBuffer: LIST_OUTPUT_MAX_BYTES,
    });
    const paths = listed.stdout.split("\0").filter(Boolean);
    // Only the root package.json's contents are fetched, and only when the names alone don't decide it.
    const packageJson =
      paths.includes("package.json") && !marksGame(paths)
        ? (
            await exec("git", [...HOST_GIT_CONFIG, ...LOOK_CONFIG, "cat-file", "-p", "HEAD:package.json"], {
              ...options,
              cwd: dir,
            })
          ).stdout
        : null;
    return { paths, packageJson };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Readiness over the host's git, keeping its answers in `file` and its looks in `scratch`. */
export function gitRemixReadiness(file: string, scratch: string, now: () => number = Date.now): RemixReadiness {
  return remixReadiness({
    gitRuns: () => hostGitRuns(),
    head: gitHead,
    list: (url) => gitList(url, scratch),
    load: async () => JSON.parse(await readFile(file, "utf8")) as Record<string, KeptReadiness>,
    save: (kept) => atomicWriteJson(file, kept),
    now,
  });
}
