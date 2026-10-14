/**
 * The crate checker the vendor job asks about an approved closure (extension ladder level 4,
 * person-decides policy): advisories, licences and bans refuse it whatever the person approved;
 * the trusted sources' audits are reported and never refuse. Every verdict names the engine that
 * produced it ({@link CrateCheckReport}).
 *
 * - The real engines ({@link cargoCrateChecker}) are the store's pinned cargo-deny over the pinned
 *   RustSec snapshot, and cargo-vet over each trusted source's pinned audit list, run in a sandbox
 *   of their own that writes only the job's `.check/` folder, adds no domain and closes loopback
 *   ({@link CHECK_RUN_POLICY}; a domain another run opens meanwhile is reachable, as for every
 *   sandboxed process: an accepted residual risk, `docs/agent/architecture.md`). Neither runs
 *   cargo: the host writes the closure's `cargo metadata` itself (cargo-deny reads it through
 *   `--metadata-path`; cargo-vet through a `CARGO` that prints it), so nothing resolves, builds or
 *   fetches. The host writes everything the engines read (the snapshot copy, cargo-deny's
 *   configuration, each source's cargo-vet store and shim) before the first engine runs, and
 *   nothing after: it never writes through a path an engine could have replaced. The snapshot is
 *   copied into the job (cargo-deny wants a git-shaped folder: a `.git/FETCH_HEAD` stands for the
 *   fetch) and every file of it is checked to be a regular file.
 * - The built-in rules ({@link builtinCrateChecker}) are a TypeScript copy of the same table: the
 *   fixture profiles' and the tests' engine, never the app's when the real one is missing (the
 *   app answers `crate-checker-unavailable` then). A real engine that fails (a timeout, an answer
 *   Genex cannot read, a snapshot it will not copy) answers `crate-check-failed`.
 */
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CrateAuditRow,
  CrateAuditSource,
  CrateAuditStatus,
  type CrateBlock,
  type CrateBlockRefusal,
  CrateCheckEngine,
  type CrateCheckReport,
  CrateNotice,
  CrateRefusal,
} from "../../shared/crate-requests.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { readRegularFile } from "../fsx.ts";
import { ProcessSandbox, type RunRequest, type RunResult, type SandboxPolicy, shellQuote } from "../spawn.ts";
import type { CratePolicy } from "./crate-policy.ts";
import { advisoryBlocks } from "./crate-policy.ts";
import { type CrateId, type CrateRefused, crateId, parseRequirement, type VettedCrate } from "./crate-vendor-job.ts";

/** The licences the vendored-set policy allows (`native/genex-rust/deny.toml` `[licenses] allow`, `crate-policy.json`). */
export const CRATE_LICENCE_ALLOW: readonly string[] = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "OFL-1.1",
  "Ubuntu-font-1.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);

/** Crates the vendored-set policy bans outright: GL backends (WebGPU core is the floor everywhere). */
export const CRATE_BANS: readonly string[] = Object.freeze([
  "glow",
  "khronos-egl",
  "glutin",
  "glutin_egl_sys",
  "glutin_wgl_sys",
]);

/** The trusted sources in the order a report lists them (the policy's). */
const AUDIT_SOURCES: readonly CrateAuditSource[] = Object.values(CrateAuditSource);
/** The job folder's own subfolder for the checks: a crate folder always starts with a letter. */
const CHECK_FOLDER = ".check";
/** cargo-deny 0.20's folder for the RustSec database under its `db-path` (its hash of {@link RUSTSEC_URL}). */
const CARGO_DENY_DB_FOLDER = "advisory-db-3157b0e258782691";
const RUSTSEC_URL = "https://github.com/rustsec/advisory-db";
const CRATES_IO = "registry+https://github.com/rust-lang/crates.io-index";
const ROOT_NAME = "genex-crate-check";
const ROOT_VERSION = "0.0.0";
/** How long each engine may take over one closure. */
const DENY_TIMEOUT_MS = 2 * MINUTE_MS;
const VET_TIMEOUT_MS = MINUTE_MS;
/** The most output an engine's run keeps. */
const ENGINE_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** The most files the snapshot copy takes (RustSec holds about 1,300). */
const SNAPSHOT_FILES_MAX = 20_000;
/** The most of one audit list the host reads. */
const AUDIT_LIST_MAX_BYTES = 16 * 1024 * 1024;

/** Every engine run's network: no domain of its own and no loopback (nothing on the machine to reach). */
export const CHECK_RUN_POLICY: Pick<SandboxPolicy, "allowedDomains" | "allowLocalBinding"> = Object.freeze({
  allowedDomains: [],
  allowLocalBinding: false,
});

/** cargo-deny's diagnostic codes, by the refusal each gives. */
const ADVISORY_CODES: ReadonlySet<string> = new Set(["vulnerability", "unsound", "notice", "unmaintained"]);
const LICENCE_CODES: ReadonlySet<string> = new Set([
  "rejected",
  "unlicensed",
  "no-license-field",
  "empty-license-field",
  "parse-error",
  "missing-clarification-file",
  "gather-failure",
]);
const BAN_CODES: ReadonlySet<string> = new Set(["banned"]);

const MESSAGE = {
  noSnapshot: "there is no advisory snapshot to check against",
  advisory: (id: string, crate: string) => `${id} affects ${crate}`,
  licence: (crate: string, licence: string | null) => `${crate} is under ${licence ?? "no licence"}`,
  banned: (crate: string) => `${crate} is banned by the vendored-set policy`,
  unread: (why: string) => `the crate checker gave no answer it could read: ${why}`,
  timedOut: "the crate checker did not finish in time",
  snapshotEntry: (rel: string) => `the advisory snapshot holds ${rel}, which is not a regular file`,
  snapshotSize: "the advisory snapshot holds more files than one could",
} as const;

/** One RustSec advisory: the crate, the requirements its fixed versions meet, and its kind. */
export interface CrateAdvisory {
  id: string;
  name: string;
  patched: readonly string[];
  unaffected?: readonly string[];
  /** RustSec's `informational` kind (`unmaintained`, `unsound`, `notice`), or absent for a vulnerability. */
  informational?: string | null;
  /** Whether its author withdrew it. */
  withdrawn?: boolean;
}

/** What the checker is asked about: the extracted, read closure in its job folder. */
export interface CrateCheckInput {
  jobDir: string;
  root: CrateId;
  crates: readonly VettedCrate[];
  signal?: AbortSignal;
}

/** A closure passed (with its report), or the first refusal (with what was found, when anything ran). */
export type CrateCheckVerdict =
  | { ok: true; report: CrateCheckReport }
  | (CrateRefused & { report: CrateCheckReport | null });

/** An engine that judges an approved closure. */
export interface CrateChecker {
  check(input: CrateCheckInput): Promise<CrateCheckVerdict>;
}

const refuse = (refusal: CrateRefusal, detail: string, report: CrateCheckReport | null): CrateCheckVerdict => ({
  ok: false,
  refusal,
  detail,
  report,
});

/** Whether an SPDX expression is satisfied by `allow`: `OR` needs one side, `AND` both, `WITH` its pair or its base. */
export function licenceAllowed(expression: string | null, allow: readonly string[]): boolean {
  if (expression === null) return false;
  const tokens = expression.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let at = 0;
  const allowed = new Set(allow);
  const primary = (): boolean => {
    const token = tokens[at++];
    if (token === "(") {
      const inner = or();
      if (tokens[at++] !== ")") throw new Error("unbalanced");
      return inner;
    }
    if (token === undefined || token === ")" || /^(AND|OR|WITH)$/.test(token)) throw new Error("expected a licence");
    if (tokens[at] === "WITH") {
      const exception = tokens[at + 1];
      at += 2;
      return allowed.has(`${token} WITH ${exception}`) || allowed.has(token.replace(/\+$/, ""));
    }
    return allowed.has(token.replace(/\+$/, ""));
  };
  const and = (): boolean => {
    let value = primary();
    while (tokens[at] === "AND") {
      at += 1;
      value = primary() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (tokens[at] === "OR") {
      at += 1;
      value = and() || value;
    }
    return value;
  };
  try {
    const result = or();
    return at === tokens.length && result;
  } catch {
    return false;
  }
}

/** The advisories of `advisories` that affect `crate` and block under the policy's rule. */
function blockingAdvisories(advisories: readonly CrateAdvisory[], crate: CrateId): CrateAdvisory[] {
  return advisories.filter((advisory) => {
    if (advisory.name !== crate.name || !advisoryBlocks(advisory)) return false;
    const fixed = [...advisory.patched, ...(advisory.unaffected ?? [])].some((req) =>
      parseRequirement(req)?.(crate.version),
    );
    return !fixed;
  });
}

/** One crate a check refused the closure for. */
const blockOf = (refusal: CrateBlockRefusal, crate: CrateId, detail: string | null): CrateBlock => ({
  refusal,
  name: crate.name,
  version: crate.version,
  detail,
});

/** Each source's answer about `crates`, in report order, from the crate lists the sources' audits cover. */
function auditRows(
  crates: readonly CrateId[],
  covered: (source: CrateAuditSource) => ReadonlySet<string> | null,
): CrateAuditRow[] {
  return AUDIT_SOURCES.map((source) => {
    const list = covered(source);
    if (list === null) return { source, status: CrateAuditStatus.Unavailable };
    const all = crates.every((crate) => list.has(crateId(crate)));
    return { source, status: all ? CrateAuditStatus.Audited : CrateAuditStatus.NotAudited };
  });
}

/**
 * The notice a passing closure carries: none when a trusted source audited all of it; no audit
 * lists when no source's list was there to ask (never "unaudited": nobody was asked); unaudited
 * when the sources asked left some of it unaudited.
 */
export function noticeOf(rows: readonly CrateAuditRow[]): CrateNotice | null {
  if (rows.some((row) => row.status === CrateAuditStatus.Audited)) return null;
  if (rows.every((row) => row.status === CrateAuditStatus.Unavailable)) return CrateNotice.NoAuditLists;
  return CrateNotice.Unaudited;
}

/** The built-in rules' input: the policy's lists, the snapshot's advisories and each installed source's audited crates. */
export interface BuiltinCrateRules {
  licences: readonly string[];
  bans: readonly string[];
  /** The snapshot's advisories; null when there is no snapshot, which refuses every closure `crate-checker-unavailable`. */
  advisories: readonly CrateAdvisory[] | null;
  /** The snapshot's name in a report (a commit, or the fixtures'). */
  advisoryDb: string | null;
  /** The day the snapshot was pinned, `YYYY-MM-DD`. */
  advisoryDbDate: string | null;
  /** The crates each installed source's audits cover (`safe-to-deploy`); a source absent here is not installed. */
  audits: Partial<Record<CrateAuditSource, readonly CrateId[]>>;
}

/** The built-in rules as a checker: the fixture profiles' and the tests' engine. */
export function builtinCrateChecker(rules: BuiltinCrateRules): CrateChecker {
  return {
    check: async ({ crates }) => {
      if (rules.advisories === null) return refuse(CrateRefusal.CheckerUnavailable, MESSAGE.noSnapshot, null);
      const advisories = rules.advisories;
      const blocked = [
        ...crates.flatMap((crate) =>
          blockingAdvisories(advisories, crate).map((found) => blockOf(CrateRefusal.Advisory, crate, found.id)),
        ),
        ...crates
          .filter((crate) => !licenceAllowed(crate.licenseExpression, rules.licences))
          .map((crate) => blockOf(CrateRefusal.Licence, crate, crate.licenseExpression)),
        ...crates
          .filter((crate) => rules.bans.includes(crate.name))
          .map((crate) => blockOf(CrateRefusal.Banned, crate, null)),
      ];
      const report: CrateCheckReport = {
        engine: CrateCheckEngine.Builtin,
        engineVersion: null,
        auditEngine: null,
        auditEngineVersion: null,
        advisoryDb: rules.advisoryDb,
        advisoryDbDate: rules.advisoryDbDate,
        advisories: blockedDetails(blocked, CrateRefusal.Advisory),
        blocked,
        licenceAllowed: !blocked.some((found) => found.refusal === CrateRefusal.Licence),
        audits: [],
        notice: null,
      };
      const refused = blockRefusal(blocked, report);
      if (refused) return refused;
      const covered = (source: CrateAuditSource) => {
        const list = rules.audits[source];
        return list ? new Set(list.map(crateId)) : null;
      };
      const audits = auditRows(crates, covered);
      const installed = audits.some((row) => row.status !== CrateAuditStatus.Unavailable);
      const auditEngine = installed ? CrateCheckEngine.Builtin : null;
      return { ok: true, report: { ...report, auditEngine, audits, notice: noticeOf(audits) } };
    },
  };
}

/** The distinct details (advisory ids) of the blocks of one kind, sorted. */
const blockedDetails = (blocked: readonly CrateBlock[], refusal: CrateBlockRefusal): string[] =>
  [...new Set(blocked.flatMap((found) => (found.refusal === refusal && found.detail ? [found.detail] : [])))].sort();

/** The refusal a closure's blocks give, in the policy's order (advisories, licences, bans); null when none. */
function blockRefusal(blocked: readonly CrateBlock[], report: CrateCheckReport): CrateCheckVerdict | null {
  const first = (refusal: CrateBlockRefusal) => blocked.find((found) => found.refusal === refusal);
  const advisory = first(CrateRefusal.Advisory);
  if (advisory)
    return refuse(CrateRefusal.Advisory, MESSAGE.advisory(String(advisory.detail), crateId(advisory)), report);
  const licence = first(CrateRefusal.Licence);
  if (licence) return refuse(CrateRefusal.Licence, MESSAGE.licence(crateId(licence), licence.detail), report);
  const ban = first(CrateRefusal.Banned);
  if (ban) return refuse(CrateRefusal.Banned, MESSAGE.banned(crateId(ban)), report);
  return null;
}

// ── The real engines ───────────────────────────────────────────────────────────────────────────

/** The store's installed checker: the two programs (with their versions) and the snapshot's folder. */
export interface CrateCheckTools {
  cargoDeny: { bin: string; version: string };
  /** Null when the store does not hold it: the audits are then not asked. */
  cargoVet: { bin: string; version: string } | null;
  advisoryDb: { dir: string; commit: string };
}

/** A sandbox the engines run in for one job: it writes only the job's check folder; each run asks {@link CHECK_RUN_POLICY}. */
export interface CrateCheckSandbox {
  run(request: RunRequest): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** What every crate check sandbox shares: the protected paths, what no check reads, and the core's sandbox. */
export interface CrateCheckSandboxesOptions {
  /** Never readable nor writable: the studio's secrets and the engines' homes. */
  secretPaths: readonly string[];
  /** Never readable but for a check's own reads: the user's home and the games folder. */
  denyRead: readonly string[];
  /** False only where the core's own sandbox is off. */
  enabled?: boolean;
  /** The core's sandbox, whose config goes back into the process-wide runtime once a check's sandbox is open, and again once it goes. */
  alongside?: Pick<ProcessSandbox, "refreshConfig">;
}

/**
 * The checker's sandboxes: each writes only its job's check folder (its `TMPDIR` inside it),
 * reads the tools, the job folder and the system, and adds no domain; the engines' runs close
 * loopback too ({@link CHECK_RUN_POLICY}).
 */
export function crateCheckSandboxes(
  options: CrateCheckSandboxesOptions,
): (spec: { writes: string; reads: readonly string[] }) => Promise<CrateCheckSandbox> {
  return async ({ writes, reads }) => {
    const sandbox = await ProcessSandbox.create({
      writableRoots: [writes],
      scratchDir: path.join(writes, "tmp"),
      secretPaths: [...options.secretPaths],
      readableRoots: [...reads],
      denyRead: [...options.denyRead],
      enabled: options.enabled,
    });
    options.alongside?.refreshConfig();
    return {
      run: (request) => sandbox.run(request),
      dispose: async () => {
        await sandbox.dispose();
        options.alongside?.refreshConfig();
      },
    };
  };
}

/** What the real checker is given. */
export interface CargoCrateCheckerOptions {
  tools: CrateCheckTools;
  policy: CratePolicy;
  /** Opens the job's sandbox: `writes` is the check folder alone, `reads` the tools and the job folder. */
  sandbox: (spec: { writes: string; reads: readonly string[] }) => Promise<CrateCheckSandbox>;
  /** One trusted source's audit list, verified against the policy's sha256; null when it is not pinned or not there. */
  auditList: (source: CrateAuditSource) => Promise<string | null>;
  /** The day the policy pinned its snapshot, for the report (`advisories.pinnedAt`). */
  advisoryDbDate?: string | null;
}

/** The folders one check writes, under the job folder. */
function checkLayout(jobDir: string) {
  const root = path.join(jobDir, CHECK_FOLDER);
  return {
    root,
    home: path.join(root, "home"),
    tmp: path.join(root, "tmp"),
    workspace: path.join(root, "workspace"),
    manifest: path.join(root, "workspace", "Cargo.toml"),
    metadata: path.join(root, "metadata.json"),
    denyConfig: path.join(root, "deny.toml"),
    dbs: path.join(root, "dbs"),
    vet: (source: CrateAuditSource) => path.join(root, `vet-${source}`),
  };
}
type CheckLayout = ReturnType<typeof checkLayout>;

/** One package of the closure's `cargo metadata`. */
function metadataPackage(crate: VettedCrate) {
  const id = `${CRATES_IO}#${crate.name}@${crate.version}`;
  return {
    name: crate.name,
    version: crate.version,
    id,
    license: crate.licenseExpression,
    // Only a crate with no expression is judged by its file; the host checked that file is the
    // crate's own regular file (crate-vendor-job.ts `readCrate`).
    license_file:
      crate.licenseExpression === null && crate.licenseFile !== null ? path.join(crate.dir, crate.licenseFile) : null,
    description: null,
    source: CRATES_IO,
    dependencies: [],
    targets: [libTarget(crate.name, crate.dir)],
    features: {},
    manifest_path: path.join(crate.dir, "Cargo.toml"),
    metadata: null,
    publish: null,
    authors: [],
    categories: [],
    keywords: [],
    readme: null,
    repository: null,
    homepage: null,
    documentation: null,
    edition: "2021",
    links: null,
    default_run: null,
    rust_version: null,
  };
}

const libTarget = (name: string, dir: string) => ({
  kind: ["lib"],
  crate_types: ["lib"],
  name: name.replace(/-/g, "_"),
  src_path: path.join(dir, "src", "lib.rs"),
  edition: "2021",
  doc: true,
  doctest: true,
  test: true,
});

/**
 * The closure as `cargo metadata --format-version 1` would print it for a workspace of one path
 * crate depending on every closure crate at its exact version: a flat graph, which is all the
 * advisory, licence and ban checks and the audits read.
 */
export function closureMetadata(layout: { workspace: string; manifest: string }, crates: readonly VettedCrate[]) {
  const rootId = `path+file://${layout.workspace}#${ROOT_NAME}@${ROOT_VERSION}`;
  const ids = crates.map((crate) => `${CRATES_IO}#${crate.name}@${crate.version}`);
  const root = {
    ...metadataPackage({
      name: ROOT_NAME,
      version: ROOT_VERSION,
      cksum: "",
      licence: "MIT",
      licenseExpression: "MIT",
      licenseFile: null,
      buildScript: false,
      procMacro: false,
      dir: layout.workspace,
      digest: "",
    }),
    id: rootId,
    source: null,
    publish: [],
    manifest_path: layout.manifest,
    dependencies: crates.map((crate) => ({
      name: crate.name,
      source: CRATES_IO,
      req: `=${crate.version}`,
      kind: null,
      rename: null,
      optional: false,
      uses_default_features: true,
      features: [],
      target: null,
      registry: null,
    })),
  };
  const nodes = [
    {
      id: rootId,
      dependencies: ids,
      deps: crates.map((crate, at) => ({
        name: crate.name.replace(/-/g, "_"),
        pkg: ids[at],
        dep_kinds: [{ kind: null, target: null }],
      })),
      features: [],
    },
    ...ids.map((id) => ({ id, dependencies: [], deps: [], features: [] })),
  ];
  return {
    packages: [root, ...crates.map(metadataPackage)],
    workspace_members: [rootId],
    workspace_default_members: [rootId],
    resolve: { nodes, root: rootId },
    target_directory: path.join(layout.workspace, "target"),
    version: 1,
    workspace_root: layout.workspace,
    metadata: null,
  };
}

/** cargo-deny's configuration from the policy: the snapshot, the advisory rule, the licences and the bans. */
export function denyConfig(policy: CratePolicy, dbs: string): string {
  const list = (items: readonly string[]) => items.map((item) => JSON.stringify(item)).join(", ");
  return [
    "[advisories]",
    `db-path = ${JSON.stringify(dbs)}`,
    `db-urls = [${JSON.stringify(RUSTSEC_URL)}]`,
    // The policy's rule: unmaintained notices pass (withdrawn advisories never reach a report),
    // everything else blocks. Yanked versions never enter a closure (the resolver skips them).
    'unmaintained = "none"',
    'unsound = "all"',
    'yanked = "allow"',
    "",
    "[licenses]",
    `allow = [${list(policy.licences)}]`,
    "confidence-threshold = 0.9",
    'unused-allowed-license = "allow"',
    "",
    "[bans]",
    'multiple-versions = "allow"',
    'wildcards = "allow"',
    `deny = [${policy.bans.map((name) => `{ crate = ${JSON.stringify(name)} }`).join(", ")}]`,
    "",
  ].join("\n");
}

/** Copies the snapshot folder into `to`, every entry a regular file or a folder; throws on anything else. */
async function copySnapshot(from: string, to: string, budget = { files: SNAPSHOT_FILES_MAX }): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const info = await lstat(source);
    if (info.isDirectory()) await copySnapshot(source, path.join(to, entry.name), budget);
    else if (info.isFile()) {
      budget.files -= 1;
      if (budget.files < 0) throw new Error(MESSAGE.snapshotSize);
      await copyFile(source, path.join(to, entry.name));
    } else throw new Error(MESSAGE.snapshotEntry(entry.name));
  }
}

/**
 * Writes the check folder before any engine runs: the workspace, the metadata, cargo-deny's
 * configuration, the snapshot copy, and each read audit list's cargo-vet store with its shim.
 */
async function writeCheckFolder(
  layout: CheckLayout,
  input: CrateCheckInput,
  options: CargoCrateCheckerOptions,
  lists: ReadonlyMap<CrateAuditSource, AuditList>,
) {
  for (const dir of [layout.home, layout.tmp, path.join(layout.workspace, "src")])
    await mkdir(dir, { recursive: true });
  const manifest = `[package]\nname = "${ROOT_NAME}"\nversion = "${ROOT_VERSION}"\nedition = "2021"\npublish = false\n`;
  await writeFile(layout.manifest, manifest);
  await writeFile(path.join(layout.workspace, "src", "lib.rs"), "");
  // One line: cargo-vet's metadata reader takes the first line of `cargo metadata`'s output.
  await writeFile(layout.metadata, `${JSON.stringify(closureMetadata(layout, input.crates))}\n`);
  await writeFile(layout.denyConfig, denyConfig(options.policy, layout.dbs));
  const db = path.join(layout.dbs, CARGO_DENY_DB_FOLDER);
  await copySnapshot(options.tools.advisoryDb.dir, db);
  // cargo-deny dates the database by its last fetch; the snapshot's is the pinned commit's.
  await mkdir(path.join(db, ".git"), { recursive: true });
  await writeFile(
    path.join(db, ".git", "FETCH_HEAD"),
    `${options.tools.advisoryDb.commit}\t\t'HEAD' of ${RUSTSEC_URL}\n`,
  );
  for (const [source, list] of lists) await writeVetStore(layout, source, list);
}

/** One cargo-deny diagnostic: its code, the crate it names and the advisory id, if any. */
interface DenyFinding {
  code: string;
  crate: CrateId | null;
  advisory: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One JSON line of cargo-deny's, as an error diagnostic; null for any other line. */
function denyFinding(line: string): DenyFinding | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== "diagnostic" || !isRecord(value.fields)) return null;
  const { fields } = value;
  if (fields.severity !== "error" || typeof fields.code !== "string") return null;
  const graph = Array.isArray(fields.graphs) ? fields.graphs[0] : undefined;
  const krate = isRecord(graph) && isRecord(graph.Krate) ? graph.Krate : {};
  const crate = typeof krate.name === "string" ? { name: krate.name, version: String(krate.version) } : null;
  const advisory = isRecord(fields.advisory) && typeof fields.advisory.id === "string" ? fields.advisory.id : null;
  return { code: fields.code, crate, advisory };
}

/** The error diagnostics in cargo-deny's JSON lines (it writes them to stderr). */
export function denyFindings(output: string): DenyFinding[] {
  return output
    .split("\n")
    .map(denyFinding)
    .filter((found) => found !== null);
}

/** The refusal one finding's code gives, or null for a code that is none of the three. */
function findingRefusal(code: string): CrateBlockRefusal | null {
  if (ADVISORY_CODES.has(code)) return CrateRefusal.Advisory;
  if (LICENCE_CODES.has(code)) return CrateRefusal.Licence;
  if (BAN_CODES.has(code)) return CrateRefusal.Banned;
  return null;
}

/** The blocks cargo-deny's findings name: each advisory by id, each licence by the crate's own expression. */
function denyBlocks(findings: readonly DenyFinding[], crates: readonly VettedCrate[]): CrateBlock[] {
  const blocks = new Map<string, CrateBlock>();
  for (const found of findings) {
    const refusal = findingRefusal(found.code);
    const named = found.crate;
    if (refusal === null || named === null) continue;
    const block = blockOf(refusal, named, blockDetail(refusal, found, crates));
    blocks.set(`${refusal} ${crateId(block)} ${block.detail}`, block);
  }
  return [...blocks.values()];
}

/** What a block names besides its crate: an advisory's id, or the crate's own licence expression. */
function blockDetail(refusal: CrateBlockRefusal, found: DenyFinding, crates: readonly VettedCrate[]): string | null {
  if (refusal === CrateRefusal.Advisory) return found.advisory;
  if (refusal !== CrateRefusal.Licence || found.crate === null) return null;
  const id = crateId(found.crate);
  return crates.find((crate) => crateId(crate) === id)?.licenseExpression ?? null;
}

/** cargo-deny's verdict from its findings and exit, in the policy's order: advisories, licences, bans. */
function denyVerdict(findings: readonly DenyFinding[], result: RunResult, report: CrateCheckReport): CrateCheckVerdict {
  if (result.timedOut) return refuse(CrateRefusal.CheckFailed, MESSAGE.timedOut, null);
  const refused = blockRefusal(report.blocked, report);
  if (refused) return refused;
  const other = findings[0];
  if (other) return refuse(CrateRefusal.CheckFailed, MESSAGE.unread(other.code), null);
  if (result.code !== 0) return refuse(CrateRefusal.CheckFailed, MESSAGE.unread(`exit ${result.code}`), null);
  return { ok: true, report };
}

/** Runs cargo-deny over the closure; its verdict. */
async function runDeny(
  sandbox: CrateCheckSandbox,
  layout: CheckLayout,
  options: CargoCrateCheckerOptions,
  input: CrateCheckInput,
): Promise<CrateCheckVerdict> {
  const q = shellQuote;
  const command = [
    q(options.tools.cargoDeny.bin),
    "-L error -f json --offline",
    `--metadata-path ${q(layout.metadata)}`,
    `--manifest-path ${q(layout.manifest)}`,
    `--config ${q(layout.denyConfig)}`,
    "check advisories licenses bans",
  ].join(" ");
  const result = await sandbox.run({
    command,
    cwd: layout.root,
    env: { HOME: layout.home, CARGO_HOME: path.join(layout.home, ".cargo"), TMPDIR: layout.tmp },
    timeoutMs: DENY_TIMEOUT_MS,
    maxOutputBytes: ENGINE_OUTPUT_MAX_BYTES,
    label: "crate-check:cargo-deny",
    signal: input.signal,
    policy: { ...CHECK_RUN_POLICY },
  });
  const findings = denyFindings(`${result.stdout}\n${result.stderr}`);
  const blocked = denyBlocks(findings, input.crates);
  const report: CrateCheckReport = {
    engine: CrateCheckEngine.CargoDeny,
    engineVersion: options.tools.cargoDeny.version,
    auditEngine: null,
    auditEngineVersion: null,
    advisoryDb: options.tools.advisoryDb.commit,
    advisoryDbDate: options.advisoryDbDate ?? null,
    advisories: blockedDetails(blocked, CrateRefusal.Advisory),
    blocked,
    licenceAllowed: !findings.some((found) => LICENCE_CODES.has(found.code)),
    audits: [],
    notice: null,
  };
  return denyVerdict(findings, result, report);
}

/**
 * One source's audit list as a cargo-vet imports lock: its tables moved under `audits.<source>`
 * (`[[audits.x]]`, `[criteria.x]`, `[[wildcard-audits.x]]`), its `trusted` entries left out (an
 * import never carries them). `cargo vet fmt` then writes it as cargo-vet does.
 */
export function importsLockOf(source: CrateAuditSource, text: string): string {
  const out: string[] = ["", "# cargo-vet imports lock", ""];
  let keep = true;
  for (const line of text.split("\n")) {
    const header = /^\s*(\[\[?)\s*([A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_."-]+)*)\s*(\]\]?)\s*$/.exec(line);
    if (!header) {
      if (keep) out.push(line);
      continue;
    }
    const [, open = "[", key = "", close = "]"] = header;
    const [table, ...rest] = key.split(".");
    keep = rest.length > 0 && (table === "audits" || table === "criteria" || table === "wildcard-audits");
    if (keep) out.push(`${open}audits.${source}.${table}.${rest.join(".")}${close}`);
  }
  return `${out.join("\n")}\n`;
}

/** One trusted source's audit list as read (a regular file, capped), and where the policy names it. */
interface AuditList {
  text: string;
  url: string;
}

/**
 * Writes one source's cargo-vet store, in a folder the host makes new (never one already there):
 * the import named in the config, its list as the imports lock, and the `CARGO` shim that prints
 * the closure's metadata.
 */
async function writeVetStore(layout: CheckLayout, source: CrateAuditSource, list: AuditList): Promise<void> {
  const dir = layout.vet(source);
  await mkdir(dir);
  const write = (name: string, text: string, mode = 0o644) =>
    writeFile(path.join(dir, name), text, { flag: "wx", mode });
  await write(
    "config.toml",
    `\n# cargo-vet config file\n\n[cargo-vet]\nversion = "0.10"\n\n[imports.${source}]\nurl = ${JSON.stringify(list.url)}\n`,
  );
  await write("audits.toml", "\n# cargo-vet audits file\n\n[audits]\n");
  await write("imports.lock", importsLockOf(source, list.text));
  await write("cargo", `#!/bin/sh\nexec cat ${shellQuote(layout.metadata)}\n`, 0o755);
}

/** Each pinned source's audit list the host can read; a link in its place, or a list over the cap, is not read. */
async function readAuditLists(options: CargoCrateCheckerOptions): Promise<Map<CrateAuditSource, AuditList>> {
  const lists = new Map<CrateAuditSource, AuditList>();
  if (options.tools.cargoVet === null) return lists;
  for (const found of options.policy.audits.imports) {
    const file = await options.auditList(found.source);
    if (file === null) continue;
    const bytes = await readRegularFile(file, AUDIT_LIST_MAX_BYTES).catch(() => null);
    if (bytes !== null) lists.set(found.source, { text: bytes.toString("utf8"), url: found.url });
  }
  return lists;
}

/** The crates cargo-vet's JSON `check` answer says are vetted; null when it is no answer. */
export function vettedCrates(output: string): ReadonlySet<string> | null {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.conclusion !== "string") return null;
  const rows = [value.vetted_fully, value.vetted_partially, value.vetted_with_exemptions].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );
  const vetted = new Set<string>();
  for (const row of rows) if (isRecord(row)) vetted.add(`${String(row.name)}@${String(row.version)}`);
  return vetted;
}

/** Runs cargo-vet over the closure against one source's audit list; what it covers, or null when it gave no answer. */
async function runVet(
  sandbox: CrateCheckSandbox,
  layout: CheckLayout,
  source: CrateAuditSource,
  vet: NonNullable<CrateCheckTools["cargoVet"]>,
  signal?: AbortSignal,
): Promise<ReadonlySet<string> | null> {
  const q = shellQuote;
  const store = layout.vet(source);
  const shim = path.join(store, "cargo");
  const common = [
    `--manifest-path ${q(layout.manifest)}`,
    `--store-path ${q(store)}`,
    `--cache-dir ${q(path.join(store, "cache"))}`,
    "--no-registry-suggestions --no-minimize-exemptions",
  ].join(" ");
  const run = (sub: string, extra: string) =>
    sandbox.run({
      command: `${q(vet.bin)} vet ${sub} ${common} ${extra}`.trim(),
      cwd: layout.root,
      env: { HOME: layout.home, CARGO: shim, TMPDIR: layout.tmp },
      timeoutMs: VET_TIMEOUT_MS,
      maxOutputBytes: ENGINE_OUTPUT_MAX_BYTES,
      label: `crate-check:cargo-vet:${source}`,
      signal,
      policy: { ...CHECK_RUN_POLICY },
    });
  const formatted = await run("fmt", "");
  if (formatted.code !== 0) return null;
  const checked = await run("check", "--locked --frozen --output-format json");
  if (checked.timedOut) return null;
  const vetted = vettedCrates(checked.stdout);
  if (vetted === null) return null;
  // A failing check still names its failures: every crate it does not list as vetted is unaudited.
  return vetted;
}

/** Each trusted source's answer, asked through cargo-vet where its list was read (its store already written). */
async function vetAudits(
  sandbox: CrateCheckSandbox,
  layout: CheckLayout,
  input: CrateCheckInput,
  options: CargoCrateCheckerOptions,
  lists: ReadonlyMap<CrateAuditSource, AuditList>,
): Promise<{ rows: CrateAuditRow[]; ran: boolean }> {
  const covered = new Map<CrateAuditSource, ReadonlySet<string> | null>();
  const vet = options.tools.cargoVet;
  if (vet !== null)
    for (const source of lists.keys()) covered.set(source, await runVet(sandbox, layout, source, vet, input.signal));
  return { rows: auditRows(input.crates, (source) => covered.get(source) ?? null), ran: covered.size > 0 };
}

/**
 * The real checker: cargo-deny decides advisories, licences and bans; cargo-vet reports each
 * trusted source's audits. Both run in one sandbox per job ({@link CargoCrateCheckerOptions.sandbox})
 * that writes only `<jobDir>/.check`, with no domain of their own and no loopback.
 */
export function cargoCrateChecker(options: CargoCrateCheckerOptions): CrateChecker {
  return {
    check: async (input) => {
      const layout = checkLayout(input.jobDir);
      const lists = await readAuditLists(options);
      try {
        await writeCheckFolder(layout, input, options, lists);
      } catch (error) {
        return refuse(CrateRefusal.CheckFailed, MESSAGE.unread(String(error)), null);
      }
      const { tools } = options;
      const reads = [
        input.jobDir,
        path.dirname(tools.cargoDeny.bin),
        ...(tools.cargoVet ? [path.dirname(tools.cargoVet.bin)] : []),
      ];
      const sandbox = await options.sandbox({ writes: layout.root, reads });
      try {
        const denied = await runDeny(sandbox, layout, options, input);
        if (!denied.ok) return denied;
        const { rows, ran } = await vetAudits(sandbox, layout, input, options, lists);
        const audit =
          ran && tools.cargoVet
            ? { auditEngine: CrateCheckEngine.CargoVet, auditEngineVersion: tools.cargoVet.version }
            : {};
        return { ok: true, report: { ...denied.report, ...audit, audits: rows, notice: noticeOf(rows) } };
      } finally {
        await sandbox.dispose();
      }
    },
  };
}
