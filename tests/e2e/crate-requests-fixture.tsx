/**
 * The crate request card (extension ladder level 4) in a Rust · wgpu game's Toolchain sheet, with
 * the real components over a fake host API: one request waiting for the person (its closure not
 * read yet), one waiting again after Genex could not install its checker, one refused for a
 * security advisory, one for its licence and one for a banned crate it brings in (cargo-deny's
 * verdicts), one added with a trusted source's audit (cargo-vet's) and one added with no audit (its
 * notice). Approving the waiting one answers it added. `run-crate-requests-ui.mjs` drives it.
 */
import { createRoot } from "react-dom/client";
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { ToolchainSheet } from "../../src/renderer/panels/ToolchainSheet.tsx";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import { studio } from "../../src/renderer/state/studio.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  CrateAuditSource,
  CrateAuditStatus,
  CrateCheckEngine,
  type CrateCheckReport,
  CrateDecision,
  type CrateDecisionInput,
  CrateNotice,
  CrateRefusal,
  CrateRequestState,
  type CrateRequestView,
} from "../../src/shared/crate-requests.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { setupTargets } from "../../src/shared/stack-setup.ts";
import { STACK_REQUIRED_COMPONENTS, ToolchainHost, type ToolchainStatus } from "../../src/shared/toolchain.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const HOST = ToolchainHost.MacArm64;
const MIB = 1024 * 1024;

const request = (overrides: Partial<CrateRequestView>): CrateRequestView => ({
  requestId: "crq-1",
  project: "pond",
  name: "tidy",
  version: "1.0.0",
  reason: null,
  state: CrateRequestState.Pending,
  licence: null,
  closureSize: null,
  buildScripts: null,
  procMacros: null,
  refusal: null,
  check: null,
  requestedAt: "2026-10-07T03:00:00.000Z",
  ...overrides,
});

/** Each trusted source's answer: Mozilla's as given, the others' lists not installed. */
const audits = (mozilla: CrateAuditStatus) =>
  Object.values(CrateAuditSource).map((source) => ({
    source,
    status: source === CrateAuditSource.Mozilla ? mozilla : CrateAuditStatus.Unavailable,
  }));

/** A report from the real engines over the pinned snapshot. */
const report = (overrides: Partial<CrateCheckReport>): CrateCheckReport => ({
  engine: CrateCheckEngine.CargoDeny,
  engineVersion: "0.20.2",
  auditEngine: CrateCheckEngine.CargoVet,
  auditEngineVersion: "0.10.0",
  advisoryDb: "550efd3d587a29b2e2c2b21b17a440da4fede999",
  advisoryDbDate: "2026-10-08",
  advisories: [],
  blocked: [],
  licenceAllowed: true,
  audits: audits(CrateAuditStatus.Audited),
  notice: null,
  ...overrides,
});

let views: CrateRequestView[] = [
  request({
    requestId: "crq-7",
    name: "glyph-gl",
    version: "0.3.0",
    reason: "A GL text renderer for the menus.",
    state: CrateRequestState.Refused,
    licence: "MIT",
    closureSize: 2,
    buildScripts: false,
    procMacros: false,
    refusal: CrateRefusal.Banned,
    check: report({
      blocked: [{ refusal: CrateRefusal.Banned, name: "glow", version: "0.13.0", detail: null }],
      auditEngine: null,
      auditEngineVersion: null,
      audits: [],
    }),
    requestedAt: "2026-10-07T03:06:00.000Z",
  }),
  request({
    requestId: "crq-6",
    name: "glam",
    version: "0.29.2",
    reason: "Vector maths for the boids.",
    refusal: CrateRefusal.CheckerUnavailable,
    requestedAt: "2026-10-07T03:05:00.000Z",
  }),
  request({
    requestId: "crq-5",
    name: "fresh",
    version: "0.1.0",
    reason: "Weather particles over the pond.",
    state: CrateRequestState.Vendored,
    licence: "MIT",
    closureSize: 1,
    buildScripts: false,
    procMacros: false,
    check: report({ audits: audits(CrateAuditStatus.NotAudited), notice: CrateNotice.Unaudited }),
    requestedAt: "2026-10-07T03:04:00.000Z",
  }),
  request({
    requestId: "crq-4",
    name: "smallvec",
    version: "1.6.0",
    reason: "Small inline lists for the fish's paths.",
    state: CrateRequestState.Refused,
    licence: "MIT OR Apache-2.0",
    closureSize: 1,
    buildScripts: false,
    procMacros: false,
    refusal: CrateRefusal.Advisory,
    check: report({
      advisories: ["RUSTSEC-2021-0003"],
      blocked: [{ refusal: CrateRefusal.Advisory, name: "smallvec", version: "1.6.0", detail: "RUSTSEC-2021-0003" }],
      auditEngine: null,
      auditEngineVersion: null,
      audits: [],
    }),
    requestedAt: "2026-10-07T03:03:00.000Z",
  }),
  request({
    requestId: "crq-3",
    name: "hecs",
    version: "0.10.5",
    reason: "An entity store for the pond's fish, so schools can be queried by component.",
    requestedAt: "2026-10-07T03:02:00.000Z",
  }),
  request({
    requestId: "crq-2",
    name: "copyleft",
    version: "1.0.0",
    reason: "Text layout for the score screen.",
    state: CrateRequestState.Refused,
    licence: "GPL-3.0-only",
    closureSize: 1,
    buildScripts: false,
    procMacros: false,
    refusal: CrateRefusal.Licence,
    check: report({
      licenceAllowed: false,
      blocked: [{ refusal: CrateRefusal.Licence, name: "copyleft", version: "1.0.0", detail: "GPL-3.0-only" }],
      auditEngine: null,
      auditEngineVersion: null,
      audits: [],
    }),
    requestedAt: "2026-10-07T03:01:00.000Z",
  }),
  request({
    requestId: "crq-1",
    reason: "Tidy layouts for the HUD.",
    state: CrateRequestState.Vendored,
    licence: "MIT OR Apache-2.0",
    closureSize: 2,
    buildScripts: false,
    procMacros: false,
    check: report({}),
  }),
];

/** Every Rust component in: the sheet is ready, so only the card speaks. */
function toolchainStatus(): ToolchainStatus {
  const ids = [
    ...new Set(setupTargets(GameStack.RustWgpu, HOST).flatMap((t) => STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu][t])),
  ];
  const entries = Object.fromEntries(ids.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return {
    host: HOST,
    clt: { present: false, version: null },
    xcode: { present: true, version: "26.6" },
    installed: ids.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 120 * MIB })),
    lock: null,
    stackLocks: { [GameStack.RustWgpu]: { version: 1, entries, digest: "1".repeat(64) } },
    keptPreRust: [],
    job: null,
    storeBytes: 2200 * MIB,
    downloads: [],
    freeBytes: 40 * 1024 * MIB,
    reserveBytes: 256 * MIB,
    unhosted: [],
  };
}

/** The person's decision: approving the waiting request adds it (its closure read), declining refuses it. */
function decide(input: CrateDecisionInput): CrateRequestView {
  const approved = input.decision === CrateDecision.Approve;
  const decided: Partial<CrateRequestView> = approved
    ? {
        state: CrateRequestState.Vendored,
        licence: "MIT OR Apache-2.0",
        closureSize: 3,
        buildScripts: false,
        procMacros: false,
        check: report({ audits: audits(CrateAuditStatus.NotAudited), notice: CrateNotice.Unaudited }),
      }
    : { state: CrateRequestState.Refused, refusal: CrateRefusal.Declined };
  views = views.map((view) => (view.requestId === input.requestId ? { ...view, ...decided } : view));
  const found = views.find((view) => view.requestId === input.requestId);
  if (!found) throw new Error("There is no such crate request.");
  return found;
}

document.documentElement.dataset.platform = StudioPlatform.Mac;
const fake = fakeStudioApi({
  toolchainStatus: async () => toolchainStatus(),
  cratesList: async () => views,
  cratesDecide: async (input) => decide(input),
});
window.studio = fake.api;
const app = studio();
app.session.setState({ status: SessionStatus.Ready, welcoming: false, developer: true });
initializeAppearance();

Object.assign(window, {
  test: {
    calls: () => fake.calls.map((call) => ({ method: call.method, args: JSON.parse(JSON.stringify(call.args)) })),
    theme: (mode: "light" | "dark") => updateAppearance((previous) => ({ ...previous, mode })),
  },
});

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <ToolchainSheet
      open
      targets={[...setupTargets(GameStack.RustWgpu, HOST)]}
      stack={GameStack.RustWgpu}
      onClose={() => {}}
    />,
  );
