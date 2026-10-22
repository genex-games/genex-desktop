import { answeredRecords, compactGraphEvents } from "../shared/run-graph-events.ts";
import path from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
import { compareIds } from "../shared/compare-ids.ts";
import { EventKind } from "../shared/event-log.ts";
import { summarizeRun, type RunSummary } from "../shared/run-summary.ts";
import type { EventEnvelope } from "../substrate/types.ts";
import { isBelow } from "../substrate/paths.ts";
import { supplementRunEvidence } from "./run-evidence.ts";

const SUMMARY_CACHE_MAX = 32;
const RUN_ID = /^[a-zA-Z0-9_-]+$/;

async function evidenceRoot(runs: string, runId: string): Promise<string | null> {
  if (!RUN_ID.test(runId)) return null;
  const root = await realpath(runs).catch(() => null);
  if (!root) return null;
  const run = await realpath(path.join(root, runId)).catch(() => null);
  return run && isBelow(root, run) ? run : null;
}

/** Fingerprint in-run files, resolving every directory before traversal and refusing escapes. */
async function evidenceVersion(runs: string, runId: string): Promise<string> {
  const run = await evidenceRoot(runs, runId);
  if (!run) return "";
  const rows: string[] = [];
  const pending: string[] = [run];
  const visited = new Set<string>();
  while (pending.length) {
    const candidate: string = pending.pop() ?? run;
    const resolved: string | null = await realpath(candidate).catch(() => null);
    if (!resolved) continue;
    const escaped = resolved !== run && !isBelow(run, resolved);
    if (escaped || visited.has(resolved)) continue;
    visited.add(resolved);
    const info = await lstat(resolved, { bigint: true }).catch(() => null);
    if (!info) continue;
    rows.push(`${resolved}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
    if (!info.isDirectory()) continue;
    const entries = await readdir(resolved).catch(() => []);
    for (const name of entries) pending.push(path.join(resolved, name));
  }
  return rows.sort(compareIds).join("\n");
}

interface PendingSummary {
  events: EventEnvelope[];
  version: string;
  result: Promise<RunSummary>;
}

interface CachedSummary {
  events: EventEnvelope[];
  version: string;
  summary: RunSummary;
}

/** Memoized run folds keyed by immutable history identity and current evidence-file metadata. */
export class RunSummaryCache {
  readonly #cache = new Map<string, CachedSummary>();
  readonly #pending = new Map<string, PendingSummary>();
  readonly #probes = new Map<string, Map<EventEnvelope[], Promise<string>>>();
  readonly #fold: typeof summarizeRun;
  readonly #version: typeof evidenceVersion;
  readonly #supplement: typeof supplementRunEvidence;
  #revision = 0;
  constructor(
    options: {
      fold?: typeof summarizeRun;
      version?: typeof evidenceVersion;
      supplement?: typeof supplementRunEvidence;
    } = {},
  ) {
    this.#fold = options.fold ?? summarizeRun;
    this.#version = options.version ?? evidenceVersion;
    this.#supplement = options.supplement ?? supplementRunEvidence;
  }
  /** Return a stable summary until either persisted source changes. */
  async read(events: EventEnvelope[], project: string, runId: string, runs: string): Promise<RunSummary> {
    const key = JSON.stringify([project, runId, path.resolve(runs)]);
    const version = await this.#readVersion(key, events, runs, runId);
    const cached = this.#cache.get(key);
    if (cached && cached.events === events && cached.version === version) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached.summary;
    }
    const pending = this.#pending.get(key);
    if (pending && pending.events === events && pending.version === version) return pending.result;
    const request = { events, version, result: this.#build(events, project, runId, runs) };
    this.#pending.set(key, request);
    try {
      const summary = await request.result;
      // A slower earlier history must not evict a newer request for the same run.
      if (this.#pending.get(key) === request) this.#remember(key, { events, version, summary });
      return summary;
    } finally {
      if (this.#pending.get(key) === request) this.#pending.delete(key);
    }
  }

  /** Share concurrent matching scans; a later request always checks the evidence files afresh. */
  async #readVersion(key: string, events: EventEnvelope[], runs: string, runId: string): Promise<string> {
    let probes = this.#probes.get(key);
    const pending = probes?.get(events);
    if (pending) return pending;
    probes ??= new Map();
    this.#probes.set(key, probes);
    const result = Promise.resolve().then(() => this.#version(runs, runId));
    probes.set(events, result);
    try {
      return await result;
    } finally {
      probes.delete(events);
      if (probes.size === 0) this.#probes.delete(key);
    }
  }

  async #build(events: EventEnvelope[], project: string, runId: string, runs: string): Promise<RunSummary> {
    const summary = this.#fold(events, project, runId);
    if (RUN_ID.test(runId)) summary.runDirectory = path.join(runs, runId);
    summary.graphEvents = compactGraphEvents([
      // The message the run answers, ahead of its own records: its start shows that message's pictures.
      ...answeredRecords(events, runId),
      ...events.filter((event) => {
        if (event.data.type !== EventKind.Custom) return false;
        const facts = event.data.payload as { runId?: string; project?: string };
        return facts?.runId === runId && (!facts.project || facts.project === project);
      }),
    ]);
    await this.#supplement(summary, runs);
    summary.revision = ++this.#revision;
    return summary;
  }

  #remember(key: string, entry: CachedSummary): void {
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    while (this.#cache.size > SUMMARY_CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
