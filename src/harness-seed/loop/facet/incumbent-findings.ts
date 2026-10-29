/**
 * What the accepted build was measured as, for "did this round add it". The bodycam rerun compared
 * every early round with an empty record: before the first keep nothing had been stored, so the
 * shared world's own findings (a greybox the map builder was still texturing) counted as added by
 * a title or combat round that never touched it. The incumbent's own evidence is measured the same
 * way instead, and an incumbent nothing was ever measured on adds nothing to blame.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { asksForLook } from "../look-bar.ts";
import { auditProvenance } from "../provenance.ts";
import { measuredBlockers, presentOnly } from "../temporal-checks.ts";
import type { AnyRecord } from "../../types/harness.d.ts";

/** Does this evidence carry anything the harness measures: engine facts, frame statistics or a demo's state. */
function measurable(evidence: AnyRecord | null | undefined): boolean {
  if (!evidence) return false;
  if ((evidence.state as AnyRecord | undefined)?.__render) return true;
  const shots = Array.isArray(evidence.shots) ? (evidence.shots as AnyRecord[]) : [];
  if (shots.some((shot) => shot?.stats)) return true;
  return Object.keys((evidence.demoStates ?? {}) as object).length > 0;
}

/**
 * The incumbent's findings by key and severity: its own evidence measured now, raised by what its
 * kept round recorded; null when neither says anything, so the round is blamed for nothing. Its
 * provenance is audited against `root`, the folder the challenger's files are read from.
 */
export async function incumbentFindings(
  run: AnyRecord,
  evidence: AnyRecord | null | undefined,
  kept: Readonly<Record<string, number>> | null | undefined,
  root: string | null,
): Promise<Record<string, number> | null> {
  const recorded = kept ?? {};
  const seen = measurable(evidence);
  if (!seen && Object.keys(recorded).length === 0) return null;
  const lookBar = asksForLook(run as never);
  const audit = seen && lookBar ? await auditProvenance(run, evidence?.state as AnyRecord, root).catch(() => []) : [];
  const now = seen ? [...presentOnly(audit), ...measuredBlockers(run, evidence, lookBar)] : [];
  const out: Record<string, number> = Object.fromEntries(now.map((finding) => [finding.key, finding.severity]));
  for (const [key, severity] of Object.entries(recorded)) out[key] = Math.max(out[key] ?? 0, severity);
  return out;
}
