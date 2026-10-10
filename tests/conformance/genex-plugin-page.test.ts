/**
 * The Genex plugin page reads the plugin's status once and shows one account state, the credits
 * it can honestly state, and each generation of the open game in plain words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GenexJob, GenexStatus } from "../../src/shared/genex.ts";
import type { PluginInfo, PluginManifest } from "../../src/shared/plugins.ts";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { accountPanel, hasOwnPage } from "../../src/renderer/panels/plugins/labels.ts";
import {
  CreditsKind,
  GENEX_ACTIVE_POLL_MS,
  GENEX_IDLE_POLL_MS,
  GenexAccountKind,
  genexAccountView,
  genexJobRows,
  genexPollMs,
  isGenexStatus,
  JobState,
} from "../../src/renderer/panels/plugins/genex/genex-view.ts";

const status = (over: Partial<GenexStatus> = {}): GenexStatus => ({
  connected: true,
  enabled: true,
  identity: "maker@example.invalid",
  operations: [],
  accountVerified: true,
  balance: 120,
  allowance: null,
  lanes: null,
  jobs: [],
  ...over,
});

const job = (over: Partial<GenexJob>): GenexJob => ({
  id: "job-1",
  project: "game",
  operation: "model",
  status: "downloaded",
  files: [],
  createdAt: "2026-09-27T10:00:00.000Z",
  ...over,
});

describe("Genex account state", () => {
  it("waits for the first answer", () => {
    assert.deepEqual(genexAccountView(null), { kind: GenexAccountKind.Loading });
  });

  it("names every step before an account is usable", () => {
    assert.deepEqual(genexAccountView(status({ connected: false, accountVerified: undefined })), {
      kind: GenexAccountKind.SignedOut,
      retry: false,
    });
    assert.deepEqual(genexAccountView(status({ connected: false, credentialState: "failed" })), {
      kind: GenexAccountKind.SignedOut,
      retry: true,
    });
    assert.deepEqual(
      genexAccountView(status({ connected: false, credentialState: "locked" })),
      { kind: GenexAccountKind.SignedOut, retry: false },
      "locked is how a never-connected profile starts; Connect unlocks a saved sign-in first",
    );
    assert.deepEqual(
      genexAccountView(
        status({ connected: false, authorization: { userCode: "WXYZ-1234", verifyUrl: "https://x", expiresAt: 1 } }),
      ),
      { kind: GenexAccountKind.SigningIn, code: "WXYZ-1234" },
      "a sign-in in progress wins over signed out",
    );
    assert.deepEqual(
      genexAccountView(status({ legal: { accepted: false, acceptUrl: "https://x" } })),
      { kind: GenexAccountKind.Terms },
      "terms come before credits",
    );
    assert.deepEqual(genexAccountView(status({ accountVerified: undefined })), { kind: GenexAccountKind.Checking });
    assert.deepEqual(genexAccountView(status({ error: "Genex is unreachable" })), {
      kind: GenexAccountKind.Attention,
      error: "Genex is unreachable",
    });
  });

  it("states credits only as far as Genex reported them", () => {
    const connected = (over: Partial<GenexStatus>) => {
      const view = genexAccountView(status(over));
      assert.equal(view.kind, GenexAccountKind.Connected);
      return view;
    };
    assert.deepEqual(connected({}), {
      kind: GenexAccountKind.Connected,
      identity: "maker@example.invalid",
      credits: { kind: CreditsKind.Count, count: 120 },
      spent: null,
      paused: [],
    });
    assert.deepEqual(connected({ unlimited: true, balance: 0 }).credits, { kind: CreditsKind.Unlimited });
    assert.deepEqual(connected({ balance: null }).credits, { kind: CreditsKind.Unknown }, "unknown is not zero");
    assert.deepEqual(connected({ balance: 0 }).credits, { kind: CreditsKind.Count, count: 0 });
    assert.equal(connected({ allowance: { spent: 14 } }).spent, 14);
    assert.equal(connected({ allowance: { spent: "14" } }).spent, null, "only a number is a spend");
  });

  it("lists the kinds Genex has paused", () => {
    const view = genexAccountView(
      status({
        lanes: {
          paused: false,
          lanes: [
            { kind: "music", available: false },
            { kind: "model", available: true },
            { kind: "voice", credit: "exhausted" },
            { kind: "image", mock: true },
          ],
        },
      }),
    );
    assert.equal(view.kind, GenexAccountKind.Connected);
    assert.deepEqual(view.paused, ["music", "voice", "image"]);
  });

  it("accepts only a status-shaped answer", () => {
    assert.equal(isGenexStatus(status()), true);
    assert.equal(isGenexStatus({ connected: "yes", jobs: [] }), false);
    assert.equal(isGenexStatus({ connected: true }), false);
    assert.equal(isGenexStatus(null), false);
  });
});

describe("Genex generations", () => {
  it("shows the newest first, in words, with what each cost", () => {
    const rows = genexJobRows([
      job({
        id: "a",
        operation: "texture",
        status: "downloaded",
        files: ["assets/genex/stone.png"],
        creditsCharged: 4,
      }),
      job({ id: "b", operation: "music", status: "generating", creditsCharged: 8 }),
      job({
        id: "c",
        operation: "sfx",
        status: "failed",
        error: "Prompt refused",
        creditsCharged: 2,
        creditsRefunded: 2,
      }),
    ]);
    assert.deepEqual(
      rows.map((r) => [r.id, r.label, r.file, r.state, r.credits]),
      [
        ["c", "Sound effect", null, JobState.Failed, "Refunded"],
        ["b", "Music", null, JobState.Working, "8 credits"],
        ["a", "Texture", "stone.png", JobState.Ready, "4 credits"],
      ],
    );
    assert.equal(rows[0]?.error, "Prompt refused");
  });

  it("says when a delivered asset is in the game", () => {
    const [row] = genexJobRows([
      job({
        status: "downloaded",
        use: {
          stage: "verified",
          inspectionId: "i",
          observedAt: "t",
          loadedFiles: [],
          consoleAvailable: true,
          verification: "agent-visual-observation",
        },
      }),
    ]);
    assert.equal(row?.state, JobState.InGame);
  });

  it("offers the candidates a character preview waits on", () => {
    const [preview] = genexJobRows([job({ operation: "character.preview", status: "approval_required" })]);
    assert.equal(preview?.state, JobState.Review);
    assert.deepEqual(preview?.candidates, [1, 2, 3]);
    const [remesh] = genexJobRows([job({ operation: "character.finalize", status: "approval_required" })]);
    assert.deepEqual(remesh?.candidates, [null], "a remesh has one thing to review");
    const [done] = genexJobRows([job({ operation: "character", status: "downloaded" })]);
    assert.deepEqual(done?.candidates, []);
  });

  it("shows each candidate's picture beside its number, so the choice is made by looking", () => {
    const picture = (n: number) => `data:image/png;base64,${btoa(`candidate ${n}`)}`;
    const images = [1, 2, 3].map((n) => ({ label: String(n), dataUrl: picture(n) }));
    const [preview] = genexJobRows([
      job({ operation: "character.preview", status: "approval_required", approval: { sourceId: "concept", images } }),
    ]);
    assert.deepEqual(preview?.pictures, { 1: picture(1), 2: picture(2), 3: picture(3) });
    const views = ["front", "back", "left", "right"].map((label) => ({ label, dataUrl: picture(1) }));
    const [remesh] = genexJobRows([
      job({
        operation: "character.finalize",
        status: "approval_required",
        approval: { sourceId: "preview", images: views },
      }),
    ]);
    assert.deepEqual(remesh?.pictures, {}, "a remesh keeps its views for the review");
  });

  it("never shows a candidate picture the review itself would refuse", () => {
    const images = [
      { label: "1", dataUrl: "https://assets.example.invalid/1.png" },
      { label: "2", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
      { label: "3", dataUrl: "data:image/webp;base64,UklGRg==" },
    ];
    const [preview] = genexJobRows([
      job({ operation: "character.preview", status: "approval_required", approval: { sourceId: "concept", images } }),
    ]);
    assert.deepEqual(preview?.pictures, { 3: "data:image/webp;base64,UklGRg==" });
  });

  it("keeps unknown operations and statuses readable", () => {
    const [row] = genexJobRows([job({ operation: "hologram", status: "queued-remotely" })]);
    assert.equal(row?.label, "Asset");
    assert.equal(row?.state, JobState.Working);
    const [unsure] = genexJobRows([job({ status: "unresolved" })]);
    assert.equal(unsure?.state, JobState.Unsure);
  });
});

describe("Genex status cadence", () => {
  const withJobs = (...statuses: string[]) =>
    status({ jobs: statuses.map((s, i) => job({ id: `job-${i}`, status: s })) });

  it("looks again soon while Genex is still working on something or a sign-in waits", () => {
    for (const moving of ["requested", "submitting", "accepted", "generating"])
      assert.equal(genexPollMs(withJobs("downloaded", moving)), GENEX_ACTIVE_POLL_MS, moving);
    const signingIn = status({ authorization: { userCode: "ABCD", verifyUrl: "https://x", expiresAt: 1 } });
    assert.equal(genexPollMs(signingIn), GENEX_ACTIVE_POLL_MS);
  });

  it("settles to the idle read once nothing is moving on Genex's side", () => {
    // An approved review continues as a new job, and a generation Genex finished waits for a
    // wait or a download: neither changes by itself, so neither keeps the page reading every 5 s.
    const settled = withJobs("approved", "generated", "downloaded", "failed", "approval_required", "stopped");
    assert.equal(genexPollMs(settled), GENEX_IDLE_POLL_MS);
    assert.equal(genexPollMs(withJobs()), GENEX_IDLE_POLL_MS);
    assert.equal(genexPollMs(null), GENEX_IDLE_POLL_MS, "no answer yet");
    assert.ok(GENEX_IDLE_POLL_MS > GENEX_ACTIVE_POLL_MS);
  });
});

describe("Genex account button", () => {
  it("opens the Genex page's own account card, never the plugin's frame", () => {
    const genex = manifest as unknown as PluginManifest;
    assert.equal(accountPanel(genex, "game"), undefined);
    const other = { ...genex, id: "other" };
    assert.equal(accountPanel(other, "game")?.id, "publish", "other plugins keep their project panel");
    assert.equal(accountPanel(other, null), undefined, "a project panel needs a game");
  });
  it("lets the Genex page show the account problem itself, so the Plugins page does not repeat it", () => {
    const genex = { manifest, enabled: true } as unknown as PluginInfo;
    assert.equal(hasOwnPage(genex), true);
    assert.equal(hasOwnPage({ ...genex, removed: true }), false, "a removed Genex shows the generic page");
    assert.equal(hasOwnPage({ ...genex, unlisted: true }), false, "unlisted code shows the generic page");
    assert.equal(hasOwnPage({ ...genex, manifest: { ...genex.manifest, id: "other" } }), false);
  });
});
