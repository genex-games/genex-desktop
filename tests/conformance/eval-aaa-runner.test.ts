/**
 * The AA+ release gate's runner over fixtures: `collect` reads a finished run's judge shots by base
 * name only, the blind taste judge combines families by conjunction and leaves a view without a
 * clean 1600×900 capture unmeasured, the reference fetch reaches only Poly Haven and keeps nothing
 * that fails its md5, and the `aaa` commands write the report and keep the live gate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import jpeg from "jpeg-js";
import { main } from "../../scripts/eval.ts";
import { type AaaDeps, aaaCollectCommand, aaaGradeCommand, tastePins } from "../../scripts/evals/aaa/command.ts";
import { AAA_FACTS_SCHEMA, CollectError, CollectProblem, collectEvidence } from "../../scripts/evals/aaa/collect.ts";
import { EVIDENCE_FILE, FactSource } from "../../scripts/evals/aaa/evidence.ts";
import {
  allowedReferenceUrl,
  fetchReference,
  REFERENCE_SIZE,
  ReferenceFetchError,
  referenceStillName,
  reprojectEquirect,
} from "../../scripts/evals/aaa/references.ts";
import { AaaGrade } from "../../scripts/evals/aaa/rubric.ts";
import { readAaaSuite } from "../../scripts/evals/aaa/suite.ts";
import { judgeTaste, parseTier, readTasteTemplate, type TasteDeps } from "../../scripts/evals/aaa/taste.ts";
import type { GraderComplete } from "../../scripts/evals/grade/checklist/complete.ts";
import { CliExit } from "../../scripts/evals/cli/exit.ts";
import { GraderFamily } from "../../scripts/evals/vocabulary.ts";
import { passingEvidence, testSuite } from "../helpers/aaa-evidence.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = new URL("../..", import.meta.url).pathname;
const SUITE = readAaaSuite(REPO);
const BODYCAM = SUITE[0];
if (!BODYCAM) throw new Error("empty suite");
const TINY_JPEG = jpeg.encode({ width: 4, height: 4, data: new Uint8Array(64).fill(128) }, 80).data;

/** A finished run folder: report.json and an integration-head shot folder with images and stats. */
async function fakeRun(shots: Array<{ camera: string; file: string; luma: number; width?: number }>): Promise<string> {
  const run = await tmpDir("aaa-run-");
  const head = "1501e3f54558a51f350b5a56d9b0d78d841fb90f";
  const report = {
    runId: "run_test",
    project: "body-cam-2",
    goal: `${BODYCAM?.brief} Continue from the existing code in this workspace.`,
    integrationHead: head,
  };
  fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report));
  const dir = path.join(run, "director", "health_1501e3f5", "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  for (const shot of shots) {
    if (!/\.(?:jpg|png)$/.test(shot.file)) continue;
    fs.writeFileSync(path.join(dir, shot.file), TINY_JPEG);
    const stats = {
      width: shot.width ?? 960,
      height: 540,
      meanLuma: shot.luma,
      histogram: [0.41, ...Array(31).fill(0.019)],
    };
    fs.writeFileSync(path.join(dir, shot.file.replace(/\.jpg$/, ".stats.json")), JSON.stringify(stats));
  }
  const verdict = { shots: shots.map((s) => ({ camera: s.camera, path: `/Users/elsewhere/${s.file}` })) };
  fs.writeFileSync(path.join(run, "director", "health_1501e3f5", "verdict.json"), JSON.stringify(verdict));
  return run;
}

const ROLES = { classroom: "interior-hero", "demo:yard": "exterior-hero" };

describe("aaa collect", () => {
  it("builds a bundle from the integration head's shots, copying each image by base name", async () => {
    const run = await fakeRun([
      { camera: "classroom", file: "classroom.jpg", luma: 28 },
      { camera: "demo:yard", file: "demo_yard.jpg", luma: 49 },
      { camera: "demo:title", file: "demo_title.jpg", luma: 21 },
    ]);
    const outDir = await tmpDir("aaa-out-");
    const evidence = collectEvidence({
      prompt: BODYCAM,
      runDir: run,
      shotsDir: null,
      roles: ROLES,
      facts: null,
      clean: false,
      outDir,
    });
    assert.equal(evidence.promptVersion, BODYCAM.version);
    assert.equal(evidence.subject.head?.slice(0, 8), "1501e3f5");
    assert.deepEqual(
      evidence.captures.map((c) => [c.camera, c.role, c.meanLuma, c.darkFraction, c.clean]),
      [
        ["classroom", "interior-hero", 28, 0.41, false],
        ["demo:yard", "exterior-hero", 49, 0.41, false],
        ["demo:title", null, 21, 0.41, false],
      ],
    );
    assert.ok(fs.existsSync(path.join(outDir, "captures", "classroom.jpg")));
    assert.ok(fs.existsSync(path.join(outDir, EVIDENCE_FILE)));
  });

  it("never follows a verdict's path out of the shot folder", async () => {
    const outside = await tmpDir("aaa-outside-");
    fs.writeFileSync(path.join(outside, "secret.jpg"), "not an image");
    const run = await fakeRun([
      { camera: "classroom", file: "classroom.jpg", luma: 28 },
      { camera: "evil", file: "../../secret.jpg", luma: 50 },
      { camera: "odd", file: "a b;rm.jpg", luma: 50 },
    ]);
    const outDir = await tmpDir("aaa-out-");
    const evidence = collectEvidence({
      prompt: BODYCAM,
      runDir: run,
      shotsDir: null,
      roles: ROLES,
      facts: null,
      clean: null,
      outDir,
    });
    assert.deepEqual(
      evidence.captures.map((c) => c.camera),
      ["classroom"],
    );
    assert.deepEqual(fs.readdirSync(path.join(outDir, "captures")), ["classroom.jpg"]);
  });

  const refusals: Array<[string, () => Promise<Parameters<typeof collectEvidence>[0]>, CollectProblem]> = [
    [
      "a role the prompt lacks",
      async () => ({ ...(await base()), roles: { classroom: "vista" } }),
      CollectProblem.BadRoles,
    ],
    [
      "a facts file without its schema",
      async () => ({ ...(await base()), facts: { surfaces: [] } }),
      CollectProblem.BadFacts,
    ],
    [
      "a run with no report",
      async () => ({ ...(await base()), runDir: await tmpDir("aaa-empty-") }),
      CollectProblem.NoReport,
    ],
  ];
  async function base() {
    return {
      prompt: BODYCAM,
      runDir: await fakeRun([{ camera: "classroom", file: "classroom.jpg", luma: 28 }]),
      shotsDir: null,
      roles: ROLES,
      facts: null,
      clean: null,
      outDir: await tmpDir("aaa-out-"),
    };
  }
  for (const [name, input, problem] of refusals)
    it(`refuses ${name} and writes nothing`, async () => {
      const args = await input();
      assert.throws(
        () => collectEvidence(args),
        (e) => e instanceof CollectError && e.problem === problem,
      );
      assert.equal(fs.existsSync(path.join(args.outDir, EVIDENCE_FILE)), false);
    });

  it("adds the facts file's look facts and tracks, which then decide their floors", async () => {
    const facts = {
      schema: AAA_FACTS_SCHEMA,
      props: [
        {
          tag: "bench",
          nearestM: 2,
          origin: "primitive",
          organic: false,
          hasCards: null,
          source: FactSource.Reconstructed,
          cite: "review 3.6",
        },
      ],
    };
    const args = { ...(await base()), facts };
    const evidence = collectEvidence(args);
    assert.equal(evidence.props?.[0]?.cite, "review 3.6");
  });
});

describe("the blind taste judge", () => {
  const [prompt] = testSuite();
  if (!prompt) throw new Error("no prompt");

  async function bundleWithImages(): Promise<string> {
    const dir = await tmpDir("aaa-taste-");
    fs.mkdirSync(path.join(dir, "captures"));
    for (const name of ["classroom.jpg", "yard.jpg"]) fs.writeFileSync(path.join(dir, "captures", name), TINY_JPEG);
    fs.writeFileSync(path.join(dir, "ref.jpg"), TINY_JPEG);
    return dir;
  }
  const withImages = () => {
    const evidence = passingEvidence(prompt);
    for (const [i, c] of evidence.captures.entries())
      Object.assign(c, { image: `captures/${["classroom", "yard"][i]}.jpg` });
    return evidence;
  };
  const deps = (
    dir: string,
    replies: Partial<Record<GraderFamily, string>>,
    families: GraderFamily[] = [GraderFamily.Gpt],
  ): TasteDeps & { calls: string[] } => {
    const calls: string[] = [];
    const complete: GraderComplete = async (pin, question) => {
      calls.push(`${pin.family}:${question.images.map((i) => i.label).join("+")}`);
      return {
        text: replies[pin.family] ?? "no verdict",
        model: pin.model,
        usage: { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 },
      };
    };
    return {
      pins: tastePins(families, "sha") ?? [],
      complete,
      votes: 1,
      builderFamily: GraderFamily.Claude,
      referenceStills: () => [path.join(dir, "ref.jpg")],
      calls,
    };
  };

  it("reads the tier on the reply's last line only", () => {
    assert.equal(parseTier("Sharp and bevelled.\nTIER: aa-plus"), AaaGrade.AaPlus);
    assert.equal(parseTier("TIER: aaa-ish\nbut actually not"), null);
    assert.equal(parseTier("TIER: AAA"), null);
  });

  it("judges each view blind beside the references and takes the lowest family", async () => {
    const dir = await bundleWithImages();
    const d = deps(dir, { gpt: "ok\nTIER: aa-plus", claude: "soft\nTIER: aa" }, [
      GraderFamily.Gpt,
      GraderFamily.Claude,
    ]);
    const { template } = readTasteTemplate();
    const outcome = await judgeTaste(prompt, withImages(), dir, template, d);
    assert.equal(outcome.summary?.grade, AaaGrade.Aa);
    assert.equal(outcome.summary?.sameFamily, true);
    assert.deepEqual(d.calls.slice(0, 2), ["gpt:REFERENCE 1+CANDIDATE", "claude:REFERENCE 1+CANDIDATE"]);
  });

  it("is unmeasured when a view has no clean 1600×900 capture, or a family gives no tier", async () => {
    const dir = await bundleWithImages();
    const { template } = readTasteTemplate();
    const small = withImages();
    Object.assign(small.captures[0] ?? {}, { width: 960, height: 540 });
    const noCapture = await judgeTaste(prompt, small, dir, template, deps(dir, { gpt: "TIER: aaa-ish" }));
    assert.equal(noCapture.summary, null);
    assert.match(noCapture.missing.join(), /interior-hero: no clean capture/);
    const silent = await judgeTaste(prompt, withImages(), dir, template, deps(dir, {}));
    assert.equal(silent.summary, null);
  });
});

describe("reference stills", () => {
  it("cuts the panorama column the yaw names, at the reference size", () => {
    const width = 360;
    const height = 180;
    const data = new Uint8Array(width * height * 4);
    for (let x = 0; x < width; x++)
      for (let y = 0; y < height; y++) data[(y * width + x) * 4] = Math.floor((x / width) * 255);
    const pano = { width, height, data };
    const centre = (yawDeg: number) => {
      const still = reprojectEquirect(pano, { yawDeg, pitchDeg: 0, fovYDeg: 60, width: 16, height: 9 });
      return still.data[(4 * 16 + 8) * 4] ?? 0;
    };
    assert.ok(Math.abs(centre(0) - 128) <= 2, String(centre(0)));
    assert.ok(Math.abs(centre(90) - 191) <= 2, String(centre(90)));
    assert.equal(REFERENCE_SIZE.width / REFERENCE_SIZE.height, 16 / 9);
  });

  const hostile: Array<[string, unknown]> = [
    ["another host", "https://evil.example/x.jpg"],
    ["a lookalike host", "https://dl.polyhaven.org.evil.example/x.jpg"],
    ["plain http", "http://dl.polyhaven.org/x.jpg"],
    ["credentials in the URL", "https://user:pw@dl.polyhaven.org/x.jpg"],
    ["a port", "https://dl.polyhaven.org:8443/x.jpg"],
    ["not a string", { url: "https://dl.polyhaven.org/x.jpg" }],
  ];
  for (const [name, url] of hostile)
    it(`refuses ${name} as a download URL`, () => assert.equal(allowedReferenceUrl(url), null));

  async function fetchWith(tonemappedUrl: string, md5: (bytes: Uint8Array) => string) {
    const dir = await tmpDir("aaa-refs-");
    const pano = jpeg.encode({ width: 64, height: 32, data: new Uint8Array(64 * 32 * 4).fill(90) }, 90).data;
    const requested: string[] = [];
    const fetchBytes = async (url: string) => {
      requested.push(url);
      if (url.includes("/files/"))
        return new TextEncoder().encode(JSON.stringify({ tonemapped: { url: tonemappedUrl, md5: md5(pano) } }));
      if (url.includes("/info/")) return new TextEncoder().encode(JSON.stringify({ authors: { "A. Person": "All" } }));
      return pano;
    };
    const ref = { source: "polyhaven" as const, asset: "snowy_park_01", matches: "exterior-hero", yawDeg: [0, 120] };
    return { dir, requested, run: () => fetchReference(ref, dir, fetchBytes) };
  }
  const realMd5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

  it("writes a CC0 still per yaw with its authors", async () => {
    const { dir, run } = await fetchWith("https://dl.polyhaven.org/file/x.jpg", realMd5);
    const record = await run();
    assert.deepEqual(record.authors, ["A. Person"]);
    assert.equal(record.licence, "CC0-1.0");
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      [referenceStillName(record, 0), referenceStillName(record, 120)].sort(),
    );
  });

  it("downloads nothing from a foreign host and keeps nothing that fails its md5", async () => {
    const foreign = await fetchWith("https://evil.example/x.jpg", realMd5);
    await assert.rejects(foreign.run(), ReferenceFetchError);
    assert.equal(
      foreign.requested.some((u) => u.includes("evil")),
      false,
    );
    const tampered = await fetchWith("https://dl.polyhaven.org/file/x.jpg", () => "0".repeat(32));
    await assert.rejects(tampered.run(), ReferenceFetchError);
    assert.deepEqual(fs.readdirSync(tampered.dir), []);
  });
});

describe("the aaa commands", () => {
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);
  const deps = (home: string): AaaDeps => ({
    root: REPO,
    home: () => home,
    now: () => new Date("2026-10-29T00:00:00Z"),
    graderComplete: async () => {
      throw new Error("no model in tests");
    },
    fetchBytes: async () => {
      throw new Error("no network in tests");
    },
  });

  it("collects a run and grades it below AA, writing report.json and report.md", async () => {
    const run = await fakeRun([
      { camera: "classroom", file: "classroom.jpg", luma: 28 },
      { camera: "demo:yard", file: "demo_yard.jpg", luma: 49 },
    ]);
    const work = await tmpDir("aaa-cli-");
    const roles = path.join(work, "roles.json");
    fs.writeFileSync(roles, JSON.stringify(ROLES));
    const bundle = path.join(work, "bundle");
    const collected = await aaaCollectCommand(
      ["--prompt", BODYCAM.id, "--run", run, "--roles", roles, "--out", bundle, "--clean", "no"],
      out,
      deps(work),
    );
    assert.equal(collected, CliExit.Ok);
    const graded = await aaaGradeCommand([bundle, "--out", path.join(work, "report")], out, deps(work));
    assert.equal(graded, CliExit.Refused);
    const report = JSON.parse(fs.readFileSync(path.join(work, "report", "report.json"), "utf8"));
    assert.equal(report.prompts[0].grade, AaaGrade.BelowAa);
    assert.equal(report.gate.pass, false);
    assert.ok(fs.existsSync(path.join(work, "report", "report.md")));
  });

  it("refuses bad usage and a live taste judge without fetched references", async () => {
    const work = await tmpDir("aaa-cli-");
    assert.equal(await aaaGradeCommand(["--out", work], out, deps(work)), CliExit.Usage);
    assert.equal(await aaaGradeCommand([work, "--out", work, "--taste", "maybe"], out, deps(work)), CliExit.Usage);
    assert.equal(
      await aaaCollectCommand(["--prompt", "nope", "--run", work, "--roles", "r", "--out", work], out, deps(work)),
      CliExit.Usage,
    );
    const bundle = path.join(work, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, EVIDENCE_FILE), JSON.stringify({ ...passingEvidence(BODYCAM), captures: [] }));
    assert.equal(await aaaGradeCommand([bundle, "--out", work, "--taste", "live"], out, deps(work)), CliExit.NotReady);
  });

  it("keeps the live gate on a live taste judge and on fetching references", async () => {
    const env = { CI: "", GITHUB_ACTIONS: "" };
    const printed: string[] = [];
    assert.equal(
      await main(["aaa", "grade", "x", "--out", "y", "--taste", "live"], (l) => printed.push(l), { env }),
      CliExit.Usage,
    );
    assert.equal(await main(["aaa", "references"], (l) => printed.push(l), { env }), CliExit.Usage);
    assert.match(printed.join("\n"), /live-required: aaa grade needs --live/);
  });
});
