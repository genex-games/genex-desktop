import {
  NativePlatform,
  RuntimeArchive,
  type PluginManifest,
  type PluginNativeRuntime,
  type PluginNativeJob,
  type PluginNativeArg,
  type PluginRuntimePin,
} from "../../shared/plugins.ts";
import { assertRelativePath } from "../paths.ts";
import { PLUGIN_ID } from "../../shared/plugin-id.ts";
/** Runtime, job and value names follow the plugin id rule. */
const name = PLUGIN_ID;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
/**
 * A candidate under a folder Genex knows: the home folder, Genex's data, the plugin's storage,
 * Windows's program folders and per-user programs, the program that opens a file type (`opens:.blend/`
 * then a path beside it), a Microsoft Store package's folder (`package:<name>/` then a path in it).
 */
const CANDIDATE_ALIAS = /^(home|studio|storage|programfiles|programfilesx86|localappdata|opens|package):(.+)$/;
/** A candidate the person chose in the plugin's settings: `setting:<key>` names a string setting. */
const SETTING_CANDIDATE = /^setting:([a-z][a-z0-9-]{0,39})$/;
/** The file type an `opens:` candidate names, and the package name a `package:` one does. */
const FILE_TYPE = /^\.[a-z0-9]{1,16}$/;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;
/** One path segment of a candidate may be a pattern with `*` (the segment `Blender *` matches `Blender 5.2`); the newest name wins. */
const WILDCARD = "*";
/** What Windows reads as a separator or a drive inside a path a candidate joins. */
const WINDOWS_SEPARATORS = /[\\:]/;
const ARCHIVE_FORMATS: string[] = Object.values(RuntimeArchive);
const PLATFORMS: string[] = Object.values(NativePlatform);
const ARG_SOURCES = ["package", "input", "output", "value"];
/** The largest each native declaration may be. */
const NATIVE_MANIFEST_LIMITS = {
  runtimes: 4,
  pins: 4,
  jobs: 8,
  labelChars: 120,
  candidates: 16,
  versionArgs: 16,
  versionPatternChars: 200,
  urlChars: 2048,
  notices: 16,
  args: 64,
  argChars: 2048,
  inputs: 16,
  values: 16,
  outputs: 32,
  valuePatternChars: 160,
  valueMaxLength: 1024,
  minTimeoutMs: 1000,
  maxTimeoutMs: 300000,
  maxOutputBytes: 256000,
  maxAssetBytes: 100 * 1024 ** 2,
} as const;
const L = NATIVE_MANIFEST_LIMITS;

/** What a publisher reads when a native runtime or job declaration is refused. */
const MESSAGE = {
  CandidatePath:
    "Runtime candidates must use absolute, home:, studio:, storage:, programfiles:, programfilesx86:, localappdata:, opens:, package: or setting: paths",
  CandidatePattern: "A runtime candidate may have one * pattern, in one path segment",
  CandidateSetting: "A setting: runtime candidate must name a string setting the plugin declares",
  DuplicatePlatform: "Each pinned native installation needs a platform of its own",
  InvalidInstall: "Invalid pinned native installation or missing trusted install action",
  InvalidRuntime: "Invalid native runtime",
  InvalidVersionPattern: "Invalid runtime version pattern",
  TimeoutRange: (label: string) => `${label}: timeoutMs must be an integer from 1000 to 300000 milliseconds`,
  OutputLimit: (label: string) =>
    `${label}: maxOutputBytes is the retained process log limit and must be 1 to 256000 bytes; use maxAssetBytes for generated files`,
  AssetLimit: (label: string) => `${label}: maxAssetBytes must be 1 to 104857600 bytes across generated files`,
  InvalidJobValue: "Invalid job value",
  InvalidJobValuePattern: "Invalid job value pattern",
  InvalidArgument: "Invalid native argument",
  InvalidBinding: "Invalid native argument binding",
  UndeclaredBinding: "Undeclared native argument binding",
  InvalidGpu: "Invalid native job GPU declaration",
  InvalidRecipe: "Invalid native job recipe",
  InvalidDeclarations: "Invalid native runtime/job declarations",
  JobLabel: (id: string | undefined) => `Native job ${id ?? "(unnamed)"}`,
} as const;

const text = (v: unknown, max = 1000): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !v.includes("\0");
const paths = (values: unknown, max = 32): values is string[] =>
  Array.isArray(values) && values.length <= max && values.every((v) => text(v));
const inRange = (v: number, min: number, max: number) => v >= min && v <= max;
const isValidPattern = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};
const isPositiveSafeInteger = (v: number) => Number.isSafeInteger(v) && v > 0;
const isTimeout = (v: number) => Number.isInteger(v) && inRange(v, L.minTimeoutMs, L.maxTimeoutMs);
const isOutputLimit = (v: number) => Number.isSafeInteger(v) && inRange(v, 1, L.maxOutputBytes);
const isAssetLimit = (v: number) => Number.isSafeInteger(v) && inRange(v, 1, L.maxAssetBytes);
const isPlainObject = (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A runtime's name, label, candidates and version probe are well formed and its id is new. */
function isValidRuntime(r: PluginNativeRuntime, ids: Set<string>): boolean {
  if (!r || !name.test(r.id) || ids.has(r.id) || !text(r.label, L.labelChars)) return false;
  if (!paths(r.candidates, L.candidates) || !r.candidates.length) return false;
  return (
    paths(r.version?.args, L.versionArgs) &&
    text(r.version.pattern, L.versionPatternChars) &&
    SEMVER.test(r.version.minimum)
  );
}

/** The relative part of an `opens:` or `package:` candidate, after the file type or package name it starts with. */
function anchoredPath(kind: string, rest: string): string {
  const [anchor = "", ...segments] = rest.split("/");
  const valid = kind === "opens" ? FILE_TYPE.test(anchor) : PACKAGE_NAME.test(anchor);
  if (!valid || !segments.length) throw new Error(MESSAGE.CandidatePath);
  return segments.join("/");
}

/**
 * A candidate is absolute, an alias path that stays inside its root, or a string setting the
 * plugin declares. At most one segment holds a `*` pattern.
 */
function validateCandidate(candidate: string, m: PluginManifest): void {
  const setting = SETTING_CANDIDATE.exec(candidate);
  if (setting) {
    if (!m.settings.some((s) => s.key === setting[1] && s.type === "string")) throw new Error(MESSAGE.CandidateSetting);
    return;
  }
  const alias = CANDIDATE_ALIAS.exec(candidate);
  if (!candidate.startsWith("/") && !alias) throw new Error(MESSAGE.CandidatePath);
  const kind = alias?.[1] ?? "",
    rest = alias?.[2] ?? candidate.slice(1);
  const relative = kind === "opens" || kind === "package" ? anchoredPath(kind, rest) : rest;
  // Windows reads `\` as a separator and `C:` as a drive, so `..\` or a drive would leave the root.
  if (WINDOWS_SEPARATORS.test(relative)) throw new Error(MESSAGE.CandidatePath);
  assertRelativePath(relative);
  const patterned = relative.split("/").filter((segment) => segment.includes(WILDCARD));
  if (patterned.length > 1 || (patterned[0] ?? "").split(WILDCARD).length > 2)
    throw new Error(MESSAGE.CandidatePattern);
}

/** A pinned download behind a confirmed setup action: https, a digest, sizes, a known format and computer. */
function isValidInstall(i: PluginRuntimePin, m: PluginManifest): boolean {
  if (!i || !m.actions.some((a) => a.name === i.action && a.confirmation)) return false;
  if (!/^https:\/\//.test(i.url) || !text(i.url, L.urlChars) || !SHA256_HEX.test(i.sha256)) return false;
  if (i.platform !== undefined && !PLATFORMS.includes(i.platform)) return false;
  return (
    isPositiveSafeInteger(i.bytes) &&
    isPositiveSafeInteger(i.unpackedBytes) &&
    ARCHIVE_FORMATS.includes(i.format) &&
    paths(i.notices, L.notices)
  );
}

function validateInstall(i: PluginRuntimePin, m: PluginManifest): PluginRuntimePin {
  if (!isValidInstall(i, m)) throw new Error(MESSAGE.InvalidInstall);
  for (const file of [i.entry, i.executable, ...i.notices]) {
    if (WINDOWS_SEPARATORS.test(file)) throw new Error(MESSAGE.InvalidInstall);
    assertRelativePath(file);
  }
  return { ...i, notices: [...i.notices] };
}

/** The runtime's `install` and `installs`, each valid and each for a computer of its own. */
function validatePins(r: PluginNativeRuntime, m: PluginManifest): Pick<PluginNativeRuntime, "install" | "installs"> {
  const listed = r.installs === undefined || (Array.isArray(r.installs) && r.installs.length <= L.pins);
  if (!listed) throw new Error(MESSAGE.InvalidInstall);
  const install = r.install ? validateInstall(r.install, m) : undefined;
  const installs = r.installs?.map((pin) => validateInstall(pin, m));
  const platforms = [install, ...(installs ?? [])].flatMap((pin) =>
    pin ? [pin.platform ?? NativePlatform.MacArm64] : [],
  );
  if (new Set(platforms).size !== platforms.length) throw new Error(MESSAGE.DuplicatePlatform);
  return { ...(install ? { install } : {}), ...(installs ? { installs } : {}) };
}

function validateRuntime(r: PluginNativeRuntime, m: PluginManifest, ids: Set<string>): PluginNativeRuntime {
  if (!isValidRuntime(r, ids)) throw new Error(MESSAGE.InvalidRuntime);
  for (const c of r.candidates) validateCandidate(c, m);
  if (!isValidPattern(r.version.pattern)) throw new Error(MESSAGE.InvalidVersionPattern);
  ids.add(r.id);
  return {
    id: r.id,
    label: r.label,
    candidates: [...r.candidates],
    version: { ...r.version, args: [...r.version.args] },
    ...validatePins(r, m),
  };
}

/** The limit-specific errors, so a publisher learns which limit a recipe broke. */
function validateJobLimits(j: PluginNativeJob | undefined): void {
  if (!j) return;
  const label = MESSAGE.JobLabel(j.id);
  if (!isTimeout(j.timeoutMs)) throw new Error(MESSAGE.TimeoutRange(label));
  if (!isOutputLimit(j.maxOutputBytes)) throw new Error(MESSAGE.OutputLimit(label));
  if (!isAssetLimit(j.maxAssetBytes)) throw new Error(MESSAGE.AssetLimit(label));
}

/** A recipe's id, runtime, argument count, inputs, values and outputs are declared and bounded. */
function isValidRecipe(j: PluginNativeJob, ids: Set<string>, runtimes: PluginNativeRuntime[]): boolean {
  if (!j || !name.test(j.id) || ids.has(j.id) || !runtimes.some((r) => r.id === j.runtime)) return false;
  if (!Array.isArray(j.args) || j.args.length > L.args) return false;
  if (!paths(j.inputs, L.inputs) || j.inputs.some((k) => !name.test(k))) return false;
  if (!isPlainObject(j.values) || Object.keys(j.values).length > L.values) return false;
  if (!paths(j.outputs, L.outputs) || !j.outputs.length) return false;
  return isTimeout(j.timeoutMs) && isOutputLimit(j.maxOutputBytes) && isAssetLimit(j.maxAssetBytes);
}

function validateJobValues(j: PluginNativeJob): void {
  for (const [key, v] of Object.entries(j.values)) {
    const valid =
      name.test(key) &&
      v &&
      text(v.pattern, L.valuePatternChars) &&
      Number.isInteger(v.maxLength) &&
      inRange(v.maxLength, 1, L.valueMaxLength);
    if (!valid) throw new Error(MESSAGE.InvalidJobValue);
    if (!isValidPattern(v.pattern)) throw new Error(MESSAGE.InvalidJobValuePattern);
  }
}

/** An argument binding names something the recipe declares. */
function isDeclaredBinding(j: PluginNativeJob, arg: Exclude<PluginNativeArg, string>): boolean {
  if (arg.source === "input") return j.inputs.includes(arg.name);
  if (arg.source === "value") return Object.hasOwn(j.values, arg.name);
  if (arg.source === "output") return j.outputs.includes(arg.name);
  return true;
}

function validateJobArg(j: PluginNativeJob, arg: PluginNativeArg): void {
  if (typeof arg === "string") {
    if (!text(arg, L.argChars)) throw new Error(MESSAGE.InvalidArgument);
    return;
  }
  if (!arg || !text(arg.name) || !ARG_SOURCES.includes(arg.source)) throw new Error(MESSAGE.InvalidBinding);
  if (arg.source === "package") assertRelativePath(arg.name);
  if (!isDeclaredBinding(j, arg)) throw new Error(MESSAGE.UndeclaredBinding);
}

function validateJob(j: PluginNativeJob, ids: Set<string>, runtimes: PluginNativeRuntime[]): PluginNativeJob {
  validateJobLimits(j);
  if (j?.gpu !== undefined && typeof j.gpu !== "boolean") throw new Error(MESSAGE.InvalidGpu);
  if (!isValidRecipe(j, ids, runtimes)) throw new Error(MESSAGE.InvalidRecipe);
  validateJobValues(j);
  for (const file of j.outputs) assertRelativePath(file);
  for (const arg of j.args) validateJobArg(j, arg);
  ids.add(j.id);
  return {
    ...j,
    args: j.args.map((a) => (typeof a === "string" ? a : { ...a })),
    inputs: [...j.inputs],
    values: { ...j.values },
    outputs: [...j.outputs],
  };
}

export function validateNativeDeclarations(m: PluginManifest): {
  nativeRuntimes: PluginNativeRuntime[];
  nativeJobs: PluginNativeJob[];
} {
  const declared =
    Array.isArray(m.nativeRuntimes) &&
    m.nativeRuntimes.length <= L.runtimes &&
    Array.isArray(m.nativeJobs) &&
    m.nativeJobs.length <= L.jobs;
  if (!declared || !m.nativeRuntimes || !m.nativeJobs) throw new Error(MESSAGE.InvalidDeclarations);
  const runtimeIds = new Set<string>();
  const runtimes = m.nativeRuntimes.map((r) => validateRuntime(r, m, runtimeIds));
  const jobIds = new Set<string>();
  const jobs = m.nativeJobs.map((j) => validateJob(j, jobIds, runtimes));
  return { nativeRuntimes: runtimes, nativeJobs: jobs };
}
