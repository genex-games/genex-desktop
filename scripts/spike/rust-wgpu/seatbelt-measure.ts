/**
 * M0a.10a: what the Rust pond needs from the Mac game Seatbelt profile, measured from the deny log.
 * Each scenario runs a program through the host's own `prepareGameLaunch` (the v1 profile text,
 * `-D` parameters, environment and run directory a Studio run gets), with the program's arguments
 * appended, while `log stream` records the kernel's Sandbox reports between two sentinels.
 *
 * Per scenario: a plain run (no profile) gives the reference outcome; a run under the v1 profile
 * gives the baseline deny log; while the run does not match the reference, every proposable rule
 * its denials name is added and the run repeated; then each added rule is dropped alone and kept
 * only when the run breaks without it; the final set is confirmed twice. Rules the policy never
 * grants (network, fork or exec, writes outside `state/`, Apple's OpenGL, the refused services,
 * reads outside the system's own folders, credential and privacy services, raw input devices)
 * are recorded, never proposed. The result is written under `--out`: one log per run in
 * `deny-log/<scenario>/`, `measurement.json`, and `proposal.md` for the owner (M0a.10).
 *
 *   node scripts/spike/rust-wgpu/seatbelt-measure.ts --pond <bin> --window-probe <bin> --out <dir>
 *     [--only pond-headless|pond-windowed] [--ticks N] [--frames N] [--no-raise]
 *
 * Normally run through seatbelt-measure.sh, which builds both programs. Darwin only, and outside
 * any other sandbox: the kernel does not report the denials of a profile nested in another. A
 * refusal prints one typed line on stderr and exits 78: `seatbelt-measure-refusal: {"code","detail"}`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";
import { NativeRunMode } from "../../../src/shared/native-contract.ts";
import { gameSandboxProfile, prepareGameLaunch } from "../../../src/substrate/game-sandbox-profile.ts";
import { quote } from "../../../src/substrate/plugins/native-process.ts";

/** Why a measurement could not be made. Wire values: the refusal line spells them. */
export const MeasureRefusal = {
  NotDarwin: "not-darwin",
  Usage: "usage",
  /** `log stream` never showed its sentinel: no deny log can be read here. */
  LogUnavailable: "log-unavailable",
  /** The v1 run logged no denial at all: nothing was measured. */
  DenyLogEmpty: "deny-log-empty",
  /** The program fails without any profile, so there is no outcome to measure against. */
  ReferenceFailed: "reference-failed",
  /** No proposable rule set makes the run match its reference. */
  Unresolved: "unresolved",
  /** The final rule set did not reproduce on both confirmation runs. */
  Unstable: "unstable",
} as const;
export type MeasureRefusal = (typeof MeasureRefusal)[keyof typeof MeasureRefusal];

/** A typed measurement failure. */
export class MeasureError extends Error {
  readonly code: MeasureRefusal;
  constructor(code: MeasureRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** What becomes of one denial. Wire values: `measurement.json` spells them. */
export const RuleVerdict = {
  /** A rule the measurement may add and the owner may approve. */
  Proposable: "proposable",
  /** Something the game profile never grants, whatever a run needs. */
  RefusedByPolicy: "refused-by-policy",
  /** A report this script cannot turn into a narrow rule. */
  Unmappable: "unmappable",
} as const;
export type RuleVerdict = (typeof RuleVerdict)[keyof typeof RuleVerdict];

/** One kernel Sandbox report: the operation and what it named (empty when it named nothing). */
export interface Denial {
  operation: string;
  target: string;
}

/** The rule a denial would need, and whether it may be proposed. */
export interface CandidateRule {
  verdict: RuleVerdict;
  /** One SBPL line; empty unless proposable. */
  rule: string;
  denial: Denial;
}

const REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "seatbelt-measure-refusal:";
/** How long one run may take before it is killed and counted as broken. */
const RUN_TIMEOUT_MS = 2 * MINUTE_MS;
/** How long `log stream` may take to show a sentinel. */
const SENTINEL_TIMEOUT_MS = 20 * SECOND_MS;
const SENTINEL_RETRY_MS = 500;
/** Rounds of adding rules before a scenario is declared unresolved. */
const MAX_ROUNDS = 12;
const CONFIRM_RUNS = 2;
const STDERR_TAIL_CHARS = 600;
const DETAIL_CHARS = 200;
const DEFAULT_TICKS = 120;
const DEFAULT_FRAMES = 90;
const LOG = "/usr/bin/log";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SENTINEL_PROGRAM = "/usr/bin/true";
/** The nonce a measured run is started with (any valid one: the programs ignore the pipe). */
const RUN_NONCE = "seatbelt-measure";

/** Apple's OpenGL, which no game profile reads (the v1 profile's last file deny). */
const OPENGL_PATHS = [
  "/System/Library/Extensions/AppleMetalOpenGLRenderer.bundle",
  "/System/Library/Frameworks/OpenGL.framework",
];
/** Services the game profiles refuse by design (the v1 profile's hostile rows). */
const REFUSED_SERVICES = new Set([
  "com.apple.pasteboard.1",
  "com.apple.ScreenCapture",
  "com.apple.lsd.open",
  "com.apple.coreservices.appleevents",
  "com.apple.cvmsServ",
  "com.apple.tsm.uiserver",
  "com.apple.dock.server",
]);
/**
 * The only folders a proposed file rule may name: the operating system's own. The run's bundle
 * and `state/` are already readable under the v1 profile, so a read the game is denied anywhere
 * else (the user's home, Keychains, browser profiles, `/private/var/db`) is never proposed.
 */
const SYSTEM_READ_ROOTS = ["/System", "/usr/lib", "/usr/share", "/Library/Apple"];
/** Credential, trust and privacy services: a game never needs them, so no rule names them. */
const REFUSED_SERVICE_PREFIXES = [
  "com.apple.SecurityServer",
  "com.apple.securityd",
  "com.apple.security.",
  "com.apple.tccd",
  "com.apple.trustd",
  "com.apple.ctkd",
  "com.apple.CoreAuthentication",
  "com.apple.coreauthd",
];
/** Raw input, key store and radio user clients: a game reads input through its window only. */
const REFUSED_IOKIT_CLASS = /^(IOHID|AppleKeyStore|AppleSEP|IOBluetooth)/;
/** SBPL filter per operation family, for the reports that name one thing. */
const FILTER_OF: ReadonlyArray<readonly [RegExp, string]> = [
  [/^file-(read|ioctl|map)/, "literal"],
  [/^mach-lookup$/, "global-name"],
  [/^sysctl-read$/, "sysctl-name"],
  [/^iokit-open(-user-client)?$/, "iokit-user-client-class"],
  [/^iokit-open-service$/, "iokit-registry-entry-class"],
  [/^user-preference-read$/, "preference-domain"],
  [/^ipc-posix-shm/, "ipc-posix-name"],
  [/^darwin-notification-post$/, "notification-name"],
];
/** Operations that are never proposed: no network, no other program, writes only in `state/`. */
const POLICY_OPERATIONS = [/^network/, /^process-fork$/, /^process-exec/, /^file-write/, /^system-socket$/];
const MACH_LOOKUP = "mach-lookup";

/** A Sandbox report's first line: `[N duplicate reports for ]Sandbox: name(pid) deny(n) op [target]`. */
const REPORT = /^(?:\d+ duplicate reports for )?Sandbox: (.+?)\((\d+)\) deny\(\d+\) (\S+)(?: (.*))?$/;

/** One report parsed, with whether it belongs to process `pid` or carries `tag`. */
function reportOf(message: string, pid: number, tag: string | undefined): Denial | null {
  const [first = "", ...rest] = message.split("\n");
  const match = REPORT.exec(first.trim());
  if (!match) return null;
  const byTag = tag !== undefined && rest.some((line) => line.trim() === tag);
  if (Number(match[2]) !== pid && !byTag) return null;
  return { operation: match[3] ?? "", target: (match[4] ?? "").trim() };
}

const keyOf = (denial: Denial) => `${denial.operation} ${denial.target}`;

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The denials `messages` (eventMessage texts) report for process `pid` or carry `tag`, once each, in order. */
export function parseDenials(messages: readonly string[], pid: number, tag?: string): Denial[] {
  const denials = messages.flatMap((message) => reportOf(message, pid, tag) ?? []);
  return uniqueBy(denials, keyOf);
}

const underAny = (target: string, roots: readonly string[]) =>
  roots.some((root) => target === root || target.startsWith(`${root}/`));

/** Whether a file operation names something outside the system's own folders (or Apple's OpenGL). */
function refusedFile(target: string): boolean {
  return underAny(target, OPENGL_PATHS) || !underAny(target, SYSTEM_READ_ROOTS);
}

/** Whether a service is one the game profiles refuse by name or by family. */
function refusedService(service: string): boolean {
  return REFUSED_SERVICES.has(service) || REFUSED_SERVICE_PREFIXES.some((prefix) => service.startsWith(prefix));
}

/** Whether the game profile refuses `denial` by design, whatever a run needs. */
function refusedByPolicy(denial: Denial): boolean {
  const { operation, target } = denial;
  if (POLICY_OPERATIONS.some((pattern) => pattern.test(operation))) return true;
  if (operation.startsWith("file-")) return refusedFile(target);
  if (operation.startsWith("iokit-open")) return REFUSED_IOKIT_CLASS.test(target);
  return operation === MACH_LOOKUP && refusedService(target);
}

/** The narrowest rule that allows exactly `denial`, or why there is none. */
export function ruleFor(denial: Denial): CandidateRule {
  if (refusedByPolicy(denial)) return { verdict: RuleVerdict.RefusedByPolicy, rule: "", denial };
  const filter = FILTER_OF.find(([pattern]) => pattern.test(denial.operation))?.[1];
  if (!filter || denial.target === "") return { verdict: RuleVerdict.Unmappable, rule: "", denial };
  const rule = `(allow ${denial.operation} (${filter} ${quote(denial.target)}))`;
  return { verdict: RuleVerdict.Proposable, rule, denial };
}

/** `profile` with `rules` after its allows and before its closing denies (the OpenGL file deny first). */
export function withRules(profile: string, rules: readonly string[]): string {
  const lines = profile.split("\n");
  const at = lines.findIndex((line) => line.startsWith("(deny file-read*"));
  if (at < 0) throw new Error("the profile has no closing file deny to insert before");
  return [...lines.slice(0, at), ...rules, ...lines.slice(at)].join("\n");
}

/**
 * `profile` without the filter `atom` (an allow's `(kind "name")`); an allow left with no filter
 * is dropped whole, since a filterless allow would grant the operation wholesale.
 */
export function withoutAtom(profile: string, atom: string): string {
  return profile
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith("(allow") || !line.includes(atom)) return [line];
      const rest = line.replace(` ${atom}`, "");
      return /^\(allow(?: [\w*-]+)+\)$/.test(rest) ? [] : [rest];
    })
    .join("\n");
}

// The deny log.

/** Captured kernel Sandbox reports between two sentinels. */
export interface DenyLogSession {
  /** Ends the capture; answers every report's eventMessage seen since it began. */
  close(): Promise<string[]>;
}

/** Where deny logs come from: the unified log, or a test double. */
export interface DenyLogSource {
  open(): Promise<DenyLogSession>;
}

/** Starts a process that the sentinel profile denies at once, so the log reports `tag`. */
async function emitSentinel(tag: string): Promise<void> {
  const profile = `(version 1)(deny default (with message ${quote(tag)}))`;
  const child = spawn(SANDBOX_EXEC, ["-p", profile, SENTINEL_PROGRAM], { stdio: "ignore" });
  await once(child, "close");
}

/** Waits until `seen()` holds, re-emitting `tag` until then; refuses after the sentinel timeout. */
async function awaitSentinel(tag: string, seen: () => boolean): Promise<void> {
  const deadline = Date.now() + SENTINEL_TIMEOUT_MS;
  while (!seen()) {
    if (Date.now() > deadline) throw new MeasureError(MeasureRefusal.LogUnavailable, `log stream never showed ${tag}`);
    await emitSentinel(tag);
    await sleep(SENTINEL_RETRY_MS);
  }
}

/** eventMessage of each ndjson line that has one. */
function eventMessages(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    if (!line.startsWith("{")) return [];
    try {
      const entry = JSON.parse(line) as { eventMessage?: unknown };
      return typeof entry.eventMessage === "string" ? [entry.eventMessage] : [];
    } catch {
      return [];
    }
  });
}

/** Every complete line `child` prints, as it prints them. */
function collectLines(child: ChildProcess): string[] {
  const lines: string[] = [];
  let held = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    held += chunk;
    const parts = held.split("\n");
    held = parts.pop() ?? "";
    lines.push(...parts);
  });
  return lines;
}

/** `log stream --style ndjson` over the kernel's Sandbox reports, bracketed by sentinels. */
export const unifiedLog: DenyLogSource = {
  async open() {
    const stream = spawn(LOG, ["stream", "--style", "ndjson", "--predicate", 'sender == "Sandbox"'], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = collectLines(stream);
    const nonce = randomBytes(6).toString("hex");
    const shown = (tag: string) => () => lines.some((line) => line.includes(tag));
    const begin = `genex-seatbelt-sentinel-${nonce}-begin`;
    try {
      await awaitSentinel(begin, shown(begin));
    } catch (error) {
      stream.kill();
      throw error;
    }
    const from = lines.length;
    return {
      async close() {
        const end = `genex-seatbelt-sentinel-${nonce}-end`;
        try {
          await awaitSentinel(end, shown(end));
        } finally {
          stream.kill();
        }
        return eventMessages(lines.slice(from)).filter((message) => !message.includes(nonce));
      },
    };
  },
};

// Runs.

/** How one run ended. */
export interface RunOutput {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** The run's writable folder (the run directory's `state/`, or a temporary one for a plain run). */
  state: string;
  timedOut: boolean;
}

/** Whether a run did what the scenario is for, and what it produced (equal outcomes, equal fingerprints). */
export interface Judgement {
  ok: boolean;
  fingerprint: string;
  detail: string;
}

/** One program, the run mode it is started in, its arguments and how its outcome is judged. */
export interface Scenario {
  id: string;
  mode: NativeRunMode;
  program: string;
  args(state: string): string[];
  judge(run: RunOutput): Promise<Judgement>;
}

/** One sandboxed run of a scenario with a profile variant. */
export interface Attempt {
  label: string;
  /** The rules added to the v1 profile for this run. */
  rules: string[];
  judgement: Judgement;
  code: number | null;
  signal: string | null;
  stderrTail: string;
  denials: Denial[];
  /** Every report the log captured while the run was going (all processes). */
  log: string[];
}

/** What a measurement needs from its surroundings. */
export interface MeasureDeps {
  log: DenyLogSource;
  /** The native-runs root: a real folder of the measurement's own. */
  runsRoot: string;
  /** Told one line per sandboxed run. */
  progress?: (line: string) => void;
}

/** Collects a child's output and its end, killing it after the run timeout. */
async function finish(child: ChildProcess, state: string): Promise<RunOutput> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, RUN_TIMEOUT_MS);
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  return { code, signal, stdout, stderr, state, timedOut };
}

/** A fresh run directory under `root` holding `program` as `Game.app/Contents/MacOS/game`, as assembly leaves one. */
async function runDirFor(root: string, program: string) {
  const runId = randomBytes(8).toString("hex");
  const runDir = path.join(root, runId);
  const bundle = path.join(runDir, "bundle");
  const macos = path.join(bundle, "Game.app", "Contents", "MacOS");
  const state = path.join(runDir, "state");
  await mkdir(macos, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  const exe = path.join(macos, "game");
  await copyFile(program, exe);
  return { runId, runDir, bundle, exe, state };
}

/** Runs `scenario` without any profile, in a temporary state folder: the reference outcome. */
export async function plainRun(scenario: Scenario, root: string): Promise<Judgement> {
  const state = path.join(root, `plain-${randomBytes(6).toString("hex")}`);
  await mkdir(state, { mode: 0o700 });
  try {
    const child = spawn(scenario.program, scenario.args(state), { cwd: state, stdio: ["ignore", "pipe", "pipe"] });
    return await scenario.judge(await finish(child, state));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

/** How a run's profile differs from v1 for its mode. */
export type ProfileEdit = (profile: string) => string;

/**
 * Runs `scenario` the way Studio starts a game (`prepareGameLaunch`: v1 profile, `-D` parameters,
 * exact environment, `state/` as cwd, fd 3 a pipe) with the profile rewritten by `edit`, and reads
 * back the deny log of that run. `rules` only labels the attempt.
 */
export async function sandboxedRun(
  scenario: Scenario,
  edit: ProfileEdit,
  deps: MeasureDeps,
  label: string,
  rules: string[],
): Promise<Attempt> {
  const run = await runDirFor(deps.runsRoot, scenario.program);
  try {
    const launch = await prepareGameLaunch({ ...run, mode: scenario.mode, nonce: RUN_NONCE }, deps.runsRoot);
    const profileFile = launch.args[launch.args.indexOf("-f") + 1] ?? "";
    await writeFile(profileFile, edit(gameSandboxProfile({ mode: scenario.mode })));
    const session = await deps.log.open();
    const child = spawn(launch.file, [...launch.args, ...scenario.args(launch.cwd)], {
      env: launch.env,
      cwd: launch.cwd,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const output = await finish(child, launch.cwd);
    const log = await session.close();
    const judgement = await scenario.judge(output);
    const denials = parseDenials(log, child.pid ?? -1, `genex-game-${run.runId}`);
    const { code, signal } = output;
    return { label, rules, judgement, code, signal, stderrTail: output.stderr.slice(-STDERR_TAIL_CHARS), denials, log };
  } finally {
    await rm(run.runDir, { recursive: true, force: true });
  }
}

// The measurement.

/** A rule the run needs, with what the run did without it. */
export interface NeededRule {
  rule: string;
  denial: Denial;
  /** The run with every other needed rule but this one. */
  without: { code: number | null; signal: string | null; detail: string; stderrTail: string };
}

/** A v1 rule atom checked by removal: whether the run breaks without it. */
export interface BaseProbe {
  atom: string;
  needed: boolean;
  detail: string;
}

/** One scenario's measurement. */
export interface ScenarioResult {
  id: string;
  mode: NativeRunMode;
  reference: Judgement;
  baseline: Attempt;
  needed: NeededRule[];
  /** Rules added while searching that the run turned out not to need. */
  dropped: CandidateRule[];
  /** Denials of the final configuration: denied, and the run still matched. */
  residual: CandidateRule[];
  /** Denials seen on the way that were never proposable. */
  refused: CandidateRule[];
  baseProbes: BaseProbe[];
  attempts: Attempt[];
}

const matches = (attempt: Attempt, reference: Judgement) =>
  attempt.judgement.ok && attempt.judgement.fingerprint === reference.fingerprint;

/** Proposable candidates of `attempt`'s denials not already in `known`. */
function freshCandidates(attempt: Attempt, known: readonly CandidateRule[]): CandidateRule[] {
  const have = new Set(known.map((rule) => rule.rule));
  const proposable = attempt.denials.map(ruleFor).filter((rule) => rule.verdict === RuleVerdict.Proposable);
  return uniqueBy(proposable, (rule) => rule.rule).filter((rule) => !have.has(rule.rule));
}

interface Search {
  scenario: Scenario;
  reference: Judgement;
  deps: MeasureDeps;
  attempts: Attempt[];
}

async function attemptWith(search: Search, edit: ProfileEdit, label: string, rules: string[]): Promise<Attempt> {
  const result = await sandboxedRun(search.scenario, edit, search.deps, label, rules);
  search.attempts.push(result);
  search.deps.progress?.(
    `${search.scenario.id} ${label}: ${result.judgement.detail}; ${result.denials.length} denial(s)`,
  );
  return result;
}

function attempt(search: Search, rules: readonly CandidateRule[], label: string): Promise<Attempt> {
  const texts = rules.map((rule) => rule.rule);
  return attemptWith(search, (profile) => withRules(profile, texts), label, texts);
}

/** Adds the rules each failing run's denials name until the run matches its reference. */
async function grow(search: Search, baseline: Attempt): Promise<CandidateRule[]> {
  let rules: CandidateRule[] = [];
  let current = baseline;
  for (let round = 1; !matches(current, search.reference); round++) {
    const fresh = freshCandidates(current, rules);
    if (round > MAX_ROUNDS || fresh.length === 0) {
      const detail = `${search.scenario.id}: still "${current.judgement.detail}" after ${round - 1} round(s), no new proposable denial`;
      throw new MeasureError(MeasureRefusal.Unresolved, detail);
    }
    rules = [...rules, ...fresh];
    current = await attempt(search, rules, `round-${round}`);
  }
  return rules;
}

/** Drops each added rule alone; keeps it only when the run breaks without it. */
async function shrink(search: Search, rules: readonly CandidateRule[]) {
  let kept = [...rules];
  const needed: NeededRule[] = [];
  const dropped: CandidateRule[] = [];
  for (const [index, rule] of rules.entries()) {
    const without = kept.filter((other) => other !== rule);
    const trial = await attempt(search, without, `without-${index + 1}`);
    if (matches(trial, search.reference)) {
      kept = without;
      dropped.push(rule);
      continue;
    }
    const { code, signal, stderrTail } = trial;
    needed.push({
      rule: rule.rule,
      denial: rule.denial,
      without: { code, signal, detail: trial.judgement.detail, stderrTail },
    });
  }
  return { needed, kept, dropped };
}

/** Each of `atoms` removed alone from the v1 profile (plus `kept`): whether the run still works. */
async function probeBase(search: Search, atoms: readonly string[], kept: readonly CandidateRule[]) {
  const texts = kept.map((rule) => rule.rule);
  const probes: BaseProbe[] = [];
  for (const atom of atoms) {
    const edit = (profile: string) => withRules(withoutAtom(profile, atom), texts);
    const trial = await attemptWith(search, edit, `base-without ${atom}`, texts);
    probes.push({ atom, needed: !matches(trial, search.reference), detail: trial.judgement.detail });
  }
  return probes;
}

/** Confirms the final set reproduces; refuses when it does not. */
async function confirm(search: Search, kept: readonly CandidateRule[]): Promise<Attempt[]> {
  const runs: Attempt[] = [];
  for (let index = 1; index <= CONFIRM_RUNS; index++) runs.push(await attempt(search, kept, `confirm-${index}`));
  if (!runs.every((run) => matches(run, search.reference))) {
    throw new MeasureError(MeasureRefusal.Unstable, `${search.scenario.id}: the final rule set did not reproduce`);
  }
  return runs;
}

/** Measures one scenario end to end; refuses when nothing was measured or nothing works. */
export async function measureScenario(
  scenario: Scenario,
  deps: MeasureDeps,
  baseAtoms: readonly string[] = [],
): Promise<ScenarioResult> {
  const reference = await plainRun(scenario, deps.runsRoot);
  if (!reference.ok) {
    throw new MeasureError(MeasureRefusal.ReferenceFailed, `${scenario.id} fails with no profile: ${reference.detail}`);
  }
  const search: Search = { scenario, reference, deps, attempts: [] };
  const baseline = await attempt(search, [], "v1");
  if (baseline.denials.length === 0) {
    throw new MeasureError(
      MeasureRefusal.DenyLogEmpty,
      `${scenario.id}: the v1 run logged no denial; nothing was measured`,
    );
  }
  const { needed, kept, dropped } = await shrink(search, await grow(search, baseline));
  const confirms = await confirm(search, kept);
  const baseProbes = await probeBase(search, baseAtoms, kept);
  const seen = search.attempts.flatMap((run) => run.denials.map(ruleFor));
  const refused = uniqueBy(
    seen.filter((rule) => rule.verdict !== RuleVerdict.Proposable),
    (rule) => keyOf(rule.denial),
  );
  const residual = uniqueBy(
    confirms.flatMap((run) => run.denials.map(ruleFor)),
    (rule) => keyOf(rule.denial),
  );
  const { id, mode } = scenario;
  return { id, mode, reference, baseline, needed, dropped, residual, refused, baseProbes, attempts: search.attempts };
}

// The two scenarios.

const lastLine = (text: string) => text.trim().split("\n").at(-1)?.slice(0, DETAIL_CHARS) ?? "";
const ended = (run: RunOutput) => (run.timedOut ? "timed out" : `exit ${run.code ?? "-"} signal ${run.signal ?? "-"}`);

/** The pond's `--self-test` headless: ok when it exits 0 with its record; the record is the fingerprint. */
export function pondHeadless(pond: string, ticks: number): Scenario {
  return {
    id: "pond-headless",
    mode: NativeRunMode.Headless,
    program: pond,
    args: (state) => ["--self-test", String(ticks), "--out", path.join(state, "self-test.json"), "--state-dir", state],
    async judge(run) {
      const record = await readFile(path.join(run.state, "self-test.json"), "utf8").catch(() => "");
      const ok = run.code === 0 && record.includes('"captures"');
      if (ok) return { ok, fingerprint: record, detail: "self-test record written" };
      return { ok, fingerprint: "", detail: `${ended(run)}: ${lastLine(run.stderr)}` };
    },
  };
}

/** The window probe's report line. */
interface WindowReport {
  surfaces?: number;
  presented?: number;
  /** Frames the surface gave no drawable for (wgpu skips acquisition while the window is occluded). */
  skipped?: number;
  error?: string | null;
}

function windowReport(stdout: string): WindowReport {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as WindowReport;
  } catch {
    return { error: line || "no report" };
  }
}

/** The pond in a window through the probe: ok when it exits 0 having presented frames on its surface. */
export function pondWindowed(probe: string, frames: number, raise = true): Scenario {
  return {
    id: "pond-windowed",
    mode: NativeRunMode.Window,
    program: probe,
    args: () => ["--frames", String(frames), ...(raise ? [] : ["--no-raise"])],
    async judge(run) {
      const report = windowReport(run.stdout);
      const presented = report.presented ?? 0;
      const ok = run.code === 0 && (report.surfaces ?? 0) > 0 && presented > 0 && !report.error;
      if (ok) return { ok, fingerprint: "presented", detail: `presented ${presented} frames` };
      const counts = `${report.surfaces ?? 0} surface(s), ${presented} presented, ${report.skipped ?? 0} without a drawable`;
      return { ok, fingerprint: "", detail: `${ended(run)}, ${counts}: ${report.error ?? lastLine(run.stderr)}` };
    },
  };
}

/** The v1 headless rules Metal is expected to rest on, each checked by removal (the Metal headless dependency). */
export const METAL_HEADLESS_ATOMS = [
  '(iokit-user-client-class "AGXDeviceUserClient")',
  '(global-name "com.apple.MTLCompilerService")',
] as const;

// The report.

const code = (text: string) => `\`${text.replaceAll("`", "'")}\``;
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();

/** Known reasons, by denial, for the proposal's "why" column; anything else is left to the owner. */
const WHY: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^sysctl-read hw\.pagesize/,
    "Rust std reads the page size to place the main thread's stack guard; without it std aborts before main",
  ],
  [/^iokit-open.* AGX/, "Metal device (AGX GPU user client)"],
  [/^mach-lookup com\.apple\.MTLCompilerService/, "Metal shader compiler service (MSL compiles for wgpu pipelines)"],
  [/^mach-lookup com\.apple\.windowserver/, "WindowServer session for the window"],
  [/^iokit-open.* IOSurface/, "IOSurface for CAMetalLayer drawables"],
  [
    /^mach-lookup com\.apple\.CARenderServer/,
    "Core Animation's render server, which composites the window's CAMetalLayer (inferred from the name and the run: no drawable reaches the screen without it)",
  ],
  [
    /^mach-lookup com\.apple\.windowmanager\.server/,
    "macOS WindowManager (Stage Manager) service: without it the window never becomes visible, so wgpu gets no drawable (inferred; see the windowed caveat)",
  ],
];

/** How the runs were made and what they do not cover, for the owner reading the proposal. */
const CAVEATS = [
  "- Every run is started the way Studio starts a game (`prepareGameLaunch`: the v1 profile text, its `-D` parameters, the exact environment, `state/` as the working folder, fd 3 a pipe), with the program's arguments appended; `ProcessSandbox.spawnGame` itself passes a game no arguments, so it is not the caller here.",
  '- "Needed" means: with every other kept rule, removing this one alone makes the run fail or differ from its plain run (the headless self-test record must be byte-identical; the windowed run must present frames). Everything else stays denied, including denials logged by runs that still matched.',
  "- Headless: the pond's `--self-test` (seed 1, the cast demo, GPU-culled frames, capture readback, device-less audio), debug build.",
  "- Windowed: no Rust game has a native window path yet, so the run is the generated window probe (`.studio-dev/seatbelt-measure/window-probe`): genex-platform-desktop's winit shell, a wgpu surface on the window's CAMetalLayer, genex-render's present, the pond's own frames. Unattended, an ordinary window opened behind the other windows is occluded and wgpu acquires no drawable, so the probe raises its window to the floating level (`setLevel:`/`orderFrontRegardless`). `com.apple.windowmanager.server` may be needed by that raise rather than by every window: check it once interactively (a visible, unraised window: `--no-raise`) before approving it.",
  "- Not exercised: CoreAudio output (the pond's audio is device-less; v1 already allows the audio services), the egui HUD paint, gamepads and IME, the embedded (Live) profile.",
];

function whyOf(denial: Denial): string {
  const text = keyOf(denial);
  return WHY.find(([pattern]) => pattern.test(text))?.[1] ?? "not explained by this script: owner to judge";
}

function neededRows(results: readonly ScenarioResult[]): string[] {
  const rows = results.flatMap((result) => result.needed.map((entry) => ({ id: result.id, entry })));
  if (rows.length === 0) return ["| - | - | none: every run matched its reference under v1 | - | - |"];
  return rows.map(
    ({ id, entry }, index) =>
      `| R${index + 1} | ${id} | ${code(entry.rule)} | ${cell(whyOf(entry.denial))} | ${cell(entry.without.detail)} |`,
  );
}

function denialList(rules: readonly CandidateRule[]): string[] {
  if (rules.length === 0) return ["- none"];
  return rules.map((rule) => `- ${code(keyOf(rule.denial))} (${rule.verdict})`);
}

function metalSection(results: readonly ScenarioResult[]): string[] {
  const headless = results.find((result) => result.mode === NativeRunMode.Headless);
  if (!headless) return ["Not measured (the headless scenario did not run)."];
  const base = headless.baseProbes.map(
    (probe) =>
      `- v1 ${code(probe.atom)}: ${probe.needed ? "needed" : "not needed"} (without it: ${cell(probe.detail)})`,
  );
  const added = headless.needed.map((entry) => `- new ${code(entry.rule)}: ${cell(whyOf(entry.denial))}`);
  return [
    "Metal headless (wgpu on Metal with no window: `Gpu::headless`, MSL pipelines, capture readback) rests on",
    "the v1 rules below, each checked by removing it alone, plus the new headless rules:",
    "",
    ...base,
    ...(added.length > 0 ? added : ["- no new rule"]),
  ];
}

function scenarioSection(result: ScenarioResult): string[] {
  return [
    `### ${result.id} (${result.mode} profile)`,
    "",
    `- Reference (no profile): ${result.reference.detail}. Under v1: ${cell(result.baseline.judgement.detail)}.`,
    `- Sandboxed runs: ${result.attempts.length} (${result.attempts.map((run) => run.label).join(", ")}).`,
    "",
    "Still denied under the final rule set while the run matched its reference (stay denied):",
    "",
    ...denialList(result.residual),
    "",
    "Added while searching, then shown unnecessary (dropped alone, the run still matched):",
    "",
    ...denialList(result.dropped),
    "",
    "Seen and never proposable (the policy refuses it, or no narrow rule exists):",
    "",
    ...denialList(result.refused),
    "",
  ];
}

/** The owner's proposal: one line per needed rule, the Metal headless dependency, then each run's details. */
export function renderProposal(results: readonly ScenarioResult[], host: Readonly<Record<string, string>>): string {
  const facts = Object.entries(host)
    .map(([key, value]) => `${key} ${value}`)
    .join("; ");
  return [
    "# Seatbelt rule proposal for the Rust pond (M0a.10a)",
    "",
    "For the owner's decision in M0a.10: write `approval.md` beside this file, each rule approved or rejected.",
    "M1.13 adds exactly the approved rules to `src/substrate/game-sandbox-profile.ts`. Generated by",
    "`scripts/spike/rust-wgpu/seatbelt-measure.sh`; the raw deny log of every run is in `deny-log/`.",
    "",
    `Host: ${facts}.`,
    "",
    "## Proposed rules (each one needed: removing it alone breaks the run)",
    "",
    "| # | Run | Rule | Why | Without it |",
    "|---|-----|------|-----|------------|",
    ...neededRows(results),
    "",
    "## Metal headless dependency",
    "",
    ...metalSection(results),
    "",
    "## How this was measured, and what it does not cover",
    "",
    ...CAVEATS,
    "",
    "## Per run",
    "",
    ...results.flatMap(scenarioSection),
  ].join("\n");
}

// The command.

async function writeEvidence(out: string, results: readonly ScenarioResult[], host: Record<string, string>) {
  for (const result of results) {
    const dir = path.join(out, "deny-log", result.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const [index, run] of result.attempts.entries()) {
      const name = `${String(index + 1).padStart(2, "0")}-${run.label.replace(/[^A-Za-z0-9._-]+/g, "_")}.log`;
      await writeFile(path.join(dir, name), `${run.log.join("\n---\n")}\n`);
    }
  }
  const summary = results.map(({ attempts, ...rest }) => ({
    ...rest,
    attempts: attempts.map(({ log: _log, ...kept }) => kept),
  }));
  await writeFile(path.join(out, "measurement.json"), `${JSON.stringify({ host, results: summary }, null, 2)}\n`);
  await writeFile(path.join(out, "proposal.md"), `${renderProposal(results, host)}\n`);
}

async function output(file: string, args: string[]): Promise<string> {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
  return (await finish(child, "")).stdout.trim();
}

async function hostFacts(): Promise<Record<string, string>> {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const version = await output("/usr/bin/sw_vers", ["-productVersion"]);
  const build = await output("/usr/bin/sw_vers", ["-buildVersion"]);
  return {
    macOS: `${version} (${build})`,
    chip: await output("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    profile: `v1 at ${await output("/usr/bin/git", ["-C", repo, "rev-parse", "--short", "HEAD"])}`,
    date: new Date().toISOString(),
  };
}

function refuse(refusal: MeasureRefusal, detail: string): never {
  process.stderr.write(`${REFUSAL_PREFIX} ${JSON.stringify({ code: refusal, detail })}\n`);
  process.exit(REFUSAL_EXIT);
}

function options() {
  const { values } = parseArgs({
    options: {
      pond: { type: "string" },
      "window-probe": { type: "string" },
      out: { type: "string" },
      only: { type: "string" },
      ticks: { type: "string", default: String(DEFAULT_TICKS) },
      frames: { type: "string", default: String(DEFAULT_FRAMES) },
      "no-raise": { type: "boolean", default: false },
    },
  });
  const { pond, out, only, ticks, frames } = values;
  const probe = values["window-probe"];
  if (!pond || !probe || !out) refuse(MeasureRefusal.Usage, "--pond, --window-probe and --out are required");
  const raise = !values["no-raise"];
  const scenarios = [pondHeadless(pond, Number(ticks)), pondWindowed(probe, Number(frames), raise)];
  const chosen = scenarios.filter((scenario) => !only || scenario.id === only);
  if (chosen.length === 0) refuse(MeasureRefusal.Usage, `no scenario named ${only}`);
  return { out, scenarios: chosen };
}

async function measureAll(scenarios: readonly Scenario[]): Promise<ScenarioResult[]> {
  const runsRoot = path.join(await realpath(os.tmpdir()), `genex-seatbelt-measure-${randomBytes(4).toString("hex")}`);
  await mkdir(runsRoot, { mode: 0o700 });
  const results: ScenarioResult[] = [];
  const progress = (line: string) => process.stderr.write(`seatbelt-measure: ${line}\n`);
  try {
    for (const scenario of scenarios) {
      const atoms = scenario.mode === NativeRunMode.Headless ? METAL_HEADLESS_ATOMS : [];
      progress(scenario.id);
      results.push(await measureScenario(scenario, { log: unifiedLog, runsRoot, progress }, atoms));
    }
    return results;
  } finally {
    await rm(runsRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") refuse(MeasureRefusal.NotDarwin, "Seatbelt is the Mac's");
  const { out, scenarios } = options();
  const results = await measureAll(scenarios).catch((error: unknown) => {
    if (error instanceof MeasureError) refuse(error.code, error.message);
    throw error;
  });
  await mkdir(out, { recursive: true });
  await writeEvidence(out, results, await hostFacts());
  for (const result of results) {
    const rules = result.needed.map((entry) => entry.rule).join(" ") || "none";
    process.stdout.write(`${result.id}: ${result.needed.length} rule(s) needed: ${rules}\n`);
  }
}

if (import.meta.main) await main();
