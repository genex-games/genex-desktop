/**
 * The harness's play-time AI checks (kind `ai`): what a game that uses `genex-ai` must hold before it
 * ships, measured on the build rather than asked of a judge.
 *
 *  - `replay-deterministic`: every demo replays the same frames under each seed from its tape;
 *  - `tape-covers-demos`: the tapes answer every AI call the demos make (a miss is a typed failure,
 *    never a live call), and none of their lines is refused;
 *  - `handles-no-answer`: with AI off, every demo ends — an `optional` game plays on, an AI-only one
 *    stops behind Studio's "needs AI" state — with no call left waiting, no crash, no console error;
 *  - `output-clamped`: the worst answers the game's shapes allow (numbers at their bounds, the longest
 *    strings, the fullest lists) break nothing: the game clamps what a model says before it lands;
 *  - `disclosure-shown`: the state says the "AI-generated" disclosure is drawn (`state().ai.disclosed`);
 *  - `no-direct-model-calls`: the build names no AI vendor's API and holds no vendor key: `genex-ai`
 *    is the only way to a model (the hosts and key shapes are the app's, `ai-contract.ts`);
 *  - `budget-in-gesture`: no grant was asked for outside a person's gesture.
 *
 * Every replay runs on the host (`ai.replay`): tapes and canned answers only, never the network. One
 * evidence pass asks for each demo's replay once per kind of answer, and every check reads it. A
 * studio that cannot replay leaves a check unmeasured, never failed.
 *
 * Its own module so a kept older checks.ts or spec.ts never asks a newer sibling for it; it imports
 * neither, so both import it without a cycle.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HostMethod } from "./host-methods.ts";
import { AiCheckTest, AiErrorCode, AiReplayAnswers, aiVendorOfHost, findAiKeys, type AiVendor } from "./ai-contract.ts";
import { isRecord } from "./json.ts";
import { clip, CLIP_REASON } from "./text.ts";
import { AI_CHECK_WORDS } from "./ai-checks-prompts.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { AiReplayResult } from "../types/host-api.d.ts";

/** What an AI check measures (its home is `ai-contract.ts`, which its words import without a cycle). */
export { AiCheckTest };

/** The seeds a demo's tape replays under (`ai.replay`): three, as the skill's procedure says. */
export const AI_CHECK_SEEDS: readonly number[] = [1, 2, 3];
/** The most demos one evidence pass replays: each replay plays the demo once per seed. */
export const AI_CHECK_MAX_DEMOS = 3;
/** The most files the vendor scan reads in one build, and the largest one it opens. */
export const AI_SCAN_MAX_FILES = 4000;
export const AI_SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How many findings a failing scan names. */
const SCAN_FINDINGS_NAMED = 3;
/** The state path the disclosure check reads: the SDK's status copied into `state().ai`. */
export const AI_DISCLOSED_PATH = "ai.disclosed";

/** A check's board id: `ai-<test>`. */
export const aiCheckId = (test: AiCheckTest | string): string => `ai-${test}`;

/** Whether a value is one of the AI check tests. */
export const isAiCheckTest = (value: unknown): value is AiCheckTest =>
  typeof value === "string" && (Object.values(AiCheckTest) as string[]).includes(value);

/** The build a pass looked at: the game, and the run's copy of it (null: the game's own folder). */
export interface AiBuild {
  project: string;
  root: string | null;
}

/** What an AI check reads off an evidence pass. */
export interface AiCheckEvidence {
  build?: AiBuild | null;
  registeredDemos?: string[] | null;
  state?: unknown;
  demoStates?: Record<string, unknown> | null;
}

/** An AI check's verdict: passed, failed, or unmeasured (`pass: null`). */
export interface AiVerdict {
  pass: boolean | null;
  reason: string;
  /** Unmeasured because the studio could not answer (no play-time AI, no build). */
  unavailable?: boolean;
}

/** One demo's replay as a check reads it: the host's answer, or why there is none. */
type DemoReplay = { demo: string; result: AiReplayResult } | { demo: string; error: string };

/** One evidence pass's replays, by demo and answers, so every check of the pass shares them. */
const REPLAYS = new WeakMap<object, Map<string, Promise<DemoReplay>>>();

/** The seeds a replay of each kind runs: every seed on the tape, one with no answer, two at the edges (largest, then smallest). */
const SEEDS_FOR: Record<AiReplayAnswers, readonly number[]> = {
  [AiReplayAnswers.Tape]: AI_CHECK_SEEDS,
  [AiReplayAnswers.None]: AI_CHECK_SEEDS.slice(0, 1),
  [AiReplayAnswers.Edge]: AI_CHECK_SEEDS.slice(0, 2),
};

/** Ask the host for one demo's replay, once per pass and kind of answer. */
function replayOf(ctx: HarnessCtx, pass: object, build: AiBuild, demo: string, answers: AiReplayAnswers) {
  const memo = REPLAYS.get(pass) ?? new Map<string, Promise<DemoReplay>>();
  REPLAYS.set(pass, memo);
  const key = `${answers}\n${demo}`;
  const known = memo.get(key);
  if (known) return known;
  const asked: Promise<DemoReplay> = ctx
    .call(HostMethod.AiReplay, {
      project: build.project,
      demo,
      seeds: [...SEEDS_FOR[answers]],
      answers,
      ...(build.root ? { root: build.root } : {}),
    })
    .then(
      (result) => ({ demo, result }),
      (err: unknown) => ({ demo, error: clip(err instanceof Error ? err.message : String(err), CLIP_REASON) }),
    );
  memo.set(key, asked);
  return asked;
}

/** Every demo's replay of one kind, in the order the game registers them, at most `AI_CHECK_MAX_DEMOS`. */
async function replaysOf(
  ctx: HarnessCtx,
  pass: object,
  build: AiBuild,
  demos: readonly string[],
  answers: AiReplayAnswers,
): Promise<{ results: Array<{ demo: string; result: AiReplayResult }>; error: string | null }> {
  const replays = await Promise.all(demos.map((demo) => replayOf(ctx, pass, build, demo, answers)));
  const failed = replays.find((replay): replay is { demo: string; error: string } => "error" in replay);
  if (failed) return { results: [], error: failed.error };
  return { results: replays.filter((replay) => "result" in replay), error: null };
}

const passed = (): AiVerdict => ({ pass: true, reason: "" });
const failed = (reason: string): AiVerdict => ({ pass: false, reason });
const unmeasured = (reason: string, unavailable = false): AiVerdict => ({
  pass: null,
  reason,
  ...(unavailable ? { unavailable: true } : {}),
});

/** The first failing demo's verdict, or a pass. */
function firstFailure(
  results: ReadonlyArray<{ demo: string; result: AiReplayResult }>,
  verdictOf: (demo: string, result: AiReplayResult) => AiVerdict,
): AiVerdict {
  let unknown: AiVerdict | null = null;
  for (const { demo, result } of results) {
    const verdict = verdictOf(demo, result);
    if (verdict.pass === false) return verdict;
    if (verdict.pass === null) unknown ??= verdict;
  }
  return unknown ?? passed();
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Determinism: every seed of every demo replayed the same frames. */
function deterministic(demo: string, result: AiReplayResult): AiVerdict {
  return result.deterministic === true ? passed() : failed(AI_CHECK_WORDS.notDeterministic(demo));
}

/** Coverage: the tape answered every call, and the reader took every line. */
function covered(demo: string, result: AiReplayResult): AiVerdict {
  if (isCount(result.misses) && result.misses > 0) return failed(AI_CHECK_WORDS.misses(demo, result.misses));
  if (isCount(result.rejected) && result.rejected > 0) return failed(AI_CHECK_WORDS.rejected(demo, result.rejected));
  return passed();
}

/** A demo with no answer, or with the worst answers: it ended, settled, with nothing left waiting. */
function settled(words: { unsettled: (demo: string) => string }) {
  return (demo: string, result: AiReplayResult): AiVerdict => {
    if (result.settled === undefined || result.stuck === undefined) return unmeasured(AI_CHECK_WORDS.cannotTell);
    if (result.settled !== true) return failed(words.unsettled(demo));
    if (result.stuck > 0) return failed(AI_CHECK_WORDS.stuck(demo, result.stuck));
    return passed();
  };
}

/** No grant asked for outside a gesture. */
function inGesture(demo: string, result: AiReplayResult): AiVerdict {
  if (!isRecord(result.refused)) return unmeasured(AI_CHECK_WORDS.cannotTell);
  const outside = result.refused[AiErrorCode.NoGesture] ?? 0;
  return outside > 0 ? failed(AI_CHECK_WORDS.noGesture(demo, outside)) : passed();
}

/** What each replay-reading test replays, and how it reads one demo's result. */
const REPLAY_TESTS: Partial<
  Record<AiCheckTest, { answers: AiReplayAnswers; verdict: (demo: string, result: AiReplayResult) => AiVerdict }>
> = {
  [AiCheckTest.ReplayDeterministic]: { answers: AiReplayAnswers.Tape, verdict: deterministic },
  [AiCheckTest.TapeCoversDemos]: { answers: AiReplayAnswers.Tape, verdict: covered },
  [AiCheckTest.BudgetInGesture]: { answers: AiReplayAnswers.Tape, verdict: inGesture },
  [AiCheckTest.HandlesNoAnswer]: {
    answers: AiReplayAnswers.None,
    verdict: settled({ unsettled: AI_CHECK_WORDS.unsettledOff }),
  },
  [AiCheckTest.OutputClamped]: {
    answers: AiReplayAnswers.Edge,
    verdict: settled({ unsettled: AI_CHECK_WORDS.unsettledEdge }),
  },
};

/** The `ai` field of a state, when it reports one. */
function aiStatusOf(state: unknown): Record<string, unknown> | null {
  return isRecord(state) && isRecord(state.ai) ? state.ai : null;
}

/** The disclosure: drawn in any state the pass read (the main one or a demo's end). */
function disclosureVerdict(evidence: AiCheckEvidence): AiVerdict {
  const states = [evidence.state, ...Object.values(evidence.demoStates ?? {})];
  const statuses = states.map(aiStatusOf).filter((status) => status !== null);
  if (statuses.length === 0) return unmeasured(AI_CHECK_WORDS.noStatus(AI_DISCLOSED_PATH));
  return statuses.some((status) => status.disclosed === true) ? passed() : failed(AI_CHECK_WORDS.notDisclosed);
}

// ── the scan for direct model calls ────────────────────────────────────────────────────────

/** Folders the scan never enters: version control, installed packages, Genex's own and the tapes. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", ".studio", ".studio-dev"]);
const SKIPPED_PATHS: ReadonlySet<string> = new Set(["ai/tapes"]);
/** The files a build's code or its config is written in. */
const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".html",
  ".htm",
  ".json",
  ".gd",
  ".cs",
  ".lua",
  ".py",
  ".rs",
  ".env",
]);
/** A host as a URL names it (`https://…`, `wss://…`, `//…`). */
const URL_HOST = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
/** A bare host quoted as a whole string, with an optional port or path. */
const QUOTED_HOST = /["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:\/[^"'`\s]*)?["'`]/gi;

/** One thing the scan found: whose API or key, and in which file. Never the key itself. */
export interface DirectCallHit {
  vendor: AiVendor;
  file: string;
  what: "host" | "key";
  /** The host it names; never a key. */
  host?: string;
}

/** What a scan read: what it found, how many files it read, and the files it left out for their size. */
export interface DirectCallScan {
  hits: DirectCallHit[];
  scanned: number;
  skipped: string[];
}

/** The vendor hosts a text names, each once. */
function hostsIn(text: string): Array<{ vendor: AiVendor; host: string }> {
  const found = new Map<string, AiVendor>();
  for (const pattern of [URL_HOST, QUOTED_HOST]) {
    for (const match of text.matchAll(pattern)) {
      const host = String(match[1]).toLowerCase();
      const vendor = aiVendorOfHost(host);
      if (vendor && !found.has(host)) found.set(host, vendor);
    }
  }
  return [...found].map(([host, vendor]) => ({ vendor, host }));
}

/** The findings of one file's text. */
function hitsIn(file: string, text: string): DirectCallHit[] {
  const hosts = hostsIn(text).map(({ vendor, host }) => ({ vendor, file, what: "host" as const, host }));
  const keys = findAiKeys(text).map(({ vendor }) => ({ vendor, file, what: "key" as const }));
  return [...hosts, ...keys];
}

/** Whether the scan enters a folder (by its path in the build). */
const entersFolder = (name: string, rel: string): boolean => !SKIPPED_DIRS.has(name) && !SKIPPED_PATHS.has(rel);

/** Whether the scan reads a file of this name: one a build's code or config is written in. */
const readsFile = (name: string): boolean => SCANNED_EXTENSIONS.has(path.extname(name).toLowerCase());

/** One folder's entries, sorted, or none when it cannot be read. */
async function entriesOf(root: string, rel: string) {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The size of a regular file under `root`, or null for anything else (a link included). */
async function regularFileSize(root: string, rel: string): Promise<number | null> {
  const info = await lstat(path.join(root, rel)).catch(() => null);
  return info?.isFile() ? info.size : null;
}

/** A scan's walk so far: the folders still to read, the files it will read and those too large to. */
interface ScanWalk {
  root: string;
  queue: string[];
  files: string[];
  skipped: string[];
}

/** Take one entry of a folder into the walk: a folder to read later, or a regular file of a scanned kind. */
async function takeEntry(
  walk: ScanWalk,
  entry: { name: string; isDirectory(): boolean; isFile(): boolean },
  rel: string,
) {
  const child = rel ? `${rel}/${entry.name}` : entry.name;
  if (entry.isDirectory()) {
    if (entersFolder(entry.name, child)) walk.queue.push(child);
    return;
  }
  if (!entry.isFile() || !readsFile(entry.name)) return;
  const size = await regularFileSize(walk.root, child);
  if (size === null) return;
  if (size > AI_SCAN_MAX_FILE_BYTES) walk.skipped.push(child);
  else walk.files.push(child);
}

/** The files under `root` the scan reads, by their path in it: regular files only, never through a link. */
async function scannedFiles(root: string): Promise<{ files: string[]; skipped: string[] }> {
  const walk: ScanWalk = { root, queue: [""], files: [], skipped: [] };
  while (walk.queue.length && walk.files.length < AI_SCAN_MAX_FILES) {
    const rel = walk.queue.shift() ?? "";
    for (const entry of await entriesOf(root, rel)) await takeEntry(walk, entry, rel);
  }
  return { files: walk.files.slice(0, AI_SCAN_MAX_FILES), skipped: walk.skipped };
}

/**
 * Scan a build's folder for direct AI vendor calls: the vendor hosts its code names in a URL or a
 * quoted host, and the vendor keys it holds. It reads regular files under `root` only — a link is
 * never followed, out of the folder or within it — and skips version control, installed packages,
 * Genex's own folders and the saved playtests. Read-only; never throws.
 */
export async function scanForDirectCalls(root: string): Promise<DirectCallScan> {
  const { files, skipped } = await scannedFiles(root);
  const hits: DirectCallHit[] = [];
  let scanned = 0;
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (text === null) continue;
    scanned += 1;
    hits.push(...hitsIn(file, text));
  }
  return { hits, scanned, skipped };
}

/** The build's folder: the run's copy, or the game's own as the library lists it. */
async function buildFolder(ctx: HarnessCtx, build: AiBuild): Promise<string | null> {
  if (build.root) return build.root;
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  const game = Array.isArray(games) ? games.find((entry) => entry?.name === build.project) : null;
  return typeof game?.dir === "string" && game.dir ? game.dir : null;
}

/** The scan as a verdict: what it found, named by vendor and file. */
async function directCallsVerdict(ctx: HarnessCtx, build: AiBuild): Promise<AiVerdict> {
  const folder = await buildFolder(ctx, build);
  if (!folder) return unmeasured(AI_CHECK_WORDS.noFolder(build.project), true);
  const scan = await scanForDirectCalls(folder);
  if (scan.hits.length === 0) return passed();
  const named = scan.hits.slice(0, SCAN_FINDINGS_NAMED).map(AI_CHECK_WORDS.hit);
  return failed(AI_CHECK_WORDS.directCalls(named, scan.hits.length));
}

// ── the measurement ────────────────────────────────────────────────────────────────────────

/** The demos a pass replays: the game's registered ones, at most `AI_CHECK_MAX_DEMOS`. */
function demosOf(evidence: AiCheckEvidence): string[] {
  const demos = Array.isArray(evidence.registeredDemos) ? evidence.registeredDemos : [];
  return demos.filter((demo) => typeof demo === "string" && demo).slice(0, AI_CHECK_MAX_DEMOS);
}

/** A replay-reading test's verdict over every demo the pass replays. */
async function replayVerdict(
  ctx: HarnessCtx,
  evidence: AiCheckEvidence & object,
  build: AiBuild,
  test: AiCheckTest,
): Promise<AiVerdict> {
  const reading = REPLAY_TESTS[test];
  if (!reading) return unmeasured(AI_CHECK_WORDS.unknownTest(test));
  const demos = demosOf(evidence);
  if (demos.length === 0) {
    return test === AiCheckTest.TapeCoversDemos ? failed(AI_CHECK_WORDS.noDemo) : unmeasured(AI_CHECK_WORDS.noDemo);
  }
  const { results, error } = await replaysOf(ctx, evidence, build, demos, reading.answers);
  if (error !== null) return unmeasured(AI_CHECK_WORDS.cannotReplay(error), true);
  return firstFailure(results, reading.verdict);
}

/** The build an evidence pass names, when it names one. */
function buildOf(evidence: AiCheckEvidence | null | undefined): AiBuild | null {
  const build = evidence?.build;
  if (!isRecord(build) || typeof build.project !== "string" || !build.project) return null;
  return { project: build.project, root: typeof build.root === "string" && build.root ? build.root : null };
}

/**
 * Measure one AI check on an evidence pass. Replays are asked of the host once per pass, demo and
 * kind of answer; a check the studio cannot answer is unmeasured, never failed.
 */
export async function measureAiCheck(
  ctx: HarnessCtx,
  test: unknown,
  evidence: (AiCheckEvidence & object) | null | undefined,
): Promise<AiVerdict> {
  if (!isAiCheckTest(test)) return unmeasured(AI_CHECK_WORDS.unknownTest(String(test)));
  if (test === AiCheckTest.DisclosureShown) return disclosureVerdict(evidence ?? {});
  const build = buildOf(evidence);
  if (!build || !evidence) return unmeasured(AI_CHECK_WORDS.noBuild, true);
  if (test === AiCheckTest.NoDirectModelCalls) return directCallsVerdict(ctx, build);
  return replayVerdict(ctx, evidence, build, test);
}
