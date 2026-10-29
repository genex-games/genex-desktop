/**
 * Honest grading (plan 2, track D): the fixed full-resolution capture set, the anatomy, place and
 * look-feature floors, the dev-store guard and the vision judges' items. Each row changes one fact
 * of a bundle that passes every check and watches one check move.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type AaaEvidence, FactSource, parseEvidence } from "../../scripts/evals/aaa/evidence.ts";
import { closeupRole, type GradeContext, honestChecks, MAP_ROLE, sameHead } from "../../scripts/evals/aaa/honest.ts";
import { gradePrompt } from "../../scripts/evals/aaa/report.ts";
import { AaaFloor, AaaGrade, type FloorCheck } from "../../scripts/evals/aaa/rubric.ts";
import type { TasteDeps } from "../../scripts/evals/aaa/taste.ts";
import { judgeAnatomy, judgePlace, parseVerdict } from "../../scripts/evals/aaa/vision.ts";
import { CheckResult } from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CLIP, HEAD, PASSING_CONTEXT, passingEvidence, testSuite } from "../helpers/aaa-evidence.ts";

const [PROMPT] = testSuite();
if (!PROMPT) throw new Error("test suite is empty");
const TASTE = { summary: { grade: AaaGrade.AaPlus, sameFamily: false, detail: [] }, missing: [] };

const clone = (evidence: AaaEvidence): AaaEvidence => structuredClone(evidence);
const resultOf = (floor: AaaFloor, evidence: AaaEvidence, context: GradeContext = PASSING_CONTEXT) =>
  honestChecks(evidence, context).find((c: FloorCheck) => c.floor === floor)?.result;
const edit = (change: (e: AaaEvidence) => void): AaaEvidence => {
  const evidence = clone(passingEvidence(PROMPT));
  change(evidence);
  return evidence;
};
const closeup = (e: AaaEvidence) => e.captures.find((c) => c.role === closeupRole(CLIP));

describe("honest grading: the passing bundle", () => {
  it("passes every new check and still reaches AAA-ish", () => {
    for (const check of honestChecks(passingEvidence(PROMPT), PASSING_CONTEXT))
      assert.equal(check.result, CheckResult.Pass, check.floor);
    const taste = { summary: { grade: AaaGrade.AaaIsh, sameFamily: false, detail: [] }, missing: [] };
    assert.equal(gradePrompt(PROMPT, passingEvidence(PROMPT), taste, PASSING_CONTEXT).grade, AaaGrade.AaaIsh);
  });

  it("reads an older bundle without the new fields as unmeasured, never as passing", () => {
    const old: Record<string, unknown> = { ...passingEvidence(PROMPT) };
    for (const key of ["characters", "poses", "place", "lookFeatures", "store"]) delete old[key];
    old.captures = (old.captures as Array<Record<string, unknown>>).map(({ subjectFraction: _s, ...rest }) => rest);
    const evidence = parseEvidence(old);
    for (const floor of [
      AaaFloor.CaptureSet,
      AaaFloor.AnatomyPose,
      AaaFloor.PlaceCoherence,
      AaaFloor.LookFeatures,
      AaaFloor.StoreFresh,
    ])
      assert.notEqual(resultOf(floor, evidence), CheckResult.Pass, floor);
    assert.equal(gradePrompt(PROMPT, evidence, TASTE, PASSING_CONTEXT).grade, AaaGrade.BelowAa);
  });
});

describe("the fixed capture set", () => {
  const rows: Array<[string, (e: AaaEvidence) => void, CheckResult]> = [
    [
      "no map capture",
      (e) => {
        e.captures = e.captures.filter((c) => c.role !== MAP_ROLE);
      },
      CheckResult.Fail,
    ],
    [
      "a 960×540 map",
      (e) => {
        const m = e.captures.find((c) => c.role === MAP_ROLE);
        if (m) {
          m.width = 960;
          m.height = 540;
        }
      },
      CheckResult.Fail,
    ],
    [
      "no close-up for a clip",
      (e) => {
        e.captures = e.captures.filter((c) => c.role !== closeupRole(CLIP));
      },
      CheckResult.Fail,
    ],
    [
      "a close-up at 960×540",
      (e) => {
        const c = closeup(e);
        if (c) {
          c.width = 960;
          c.height = 540;
        }
      },
      CheckResult.Fail,
    ],
    [
      "a close-up where the character is small",
      (e) => {
        const c = closeup(e);
        if (c) c.subjectFraction = 0.2;
      },
      CheckResult.Fail,
    ],
    [
      "a close-up whose size share is unknown",
      (e) => {
        const c = closeup(e);
        if (c) c.subjectFraction = null;
      },
      CheckResult.Unknown,
    ],
    [
      "a close-up taken with post on",
      (e) => {
        const c = closeup(e);
        if (c) c.clean = false;
      },
      CheckResult.Fail,
    ],
    [
      "no list of clips",
      (e) => {
        e.characters = null;
      },
      CheckResult.Unknown,
    ],
    [
      "a second clip with no close-up",
      (e) => {
        e.characters?.clips.push({ character: "hero", clip: "run" });
      },
      CheckResult.Fail,
    ],
  ];
  for (const [name, change, expected] of rows)
    it(`${name} → ${expected}`, () => assert.equal(resultOf(AaaFloor.CaptureSet, edit(change)), expected));

  it("passes a game with no animated characters when only the map is needed", () => {
    const evidence = edit((e) => {
      e.characters = { clips: [], source: FactSource.Engine };
      e.captures = e.captures.filter((c) => c.role !== closeupRole(CLIP));
    });
    assert.equal(resultOf(AaaFloor.CaptureSet, evidence), CheckResult.Pass);
    assert.equal(resultOf(AaaFloor.AnatomyPose, evidence), CheckResult.Pass);
  });

  it("cannot certify an empty clip list that was only reconstructed", () => {
    const evidence = edit((e) => {
      e.characters = { clips: [], source: FactSource.Reconstructed };
    });
    assert.equal(resultOf(AaaFloor.CaptureSet, evidence), CheckResult.Unknown);
  });
});

describe("anatomy and pose", () => {
  const rows: Array<[string, (e: AaaEvidence) => void, CheckResult]> = [
    [
      "a torso that folds to 60% of its length",
      (e) => {
        if (e.poses?.[0]) e.poses[0].torsoLengthRatio = 0.6;
      },
      CheckResult.Fail,
    ],
    [
      "a limb that stretches 20%",
      (e) => {
        if (e.poses?.[0]) e.poses[0].limbLengthDrift = 0.2;
      },
      CheckResult.Fail,
    ],
    [
      "a body 10% inside itself",
      (e) => {
        if (e.poses?.[0]) e.poses[0].selfIntersection = 0.1;
      },
      CheckResult.Fail,
    ],
    [
      "floating feet",
      (e) => {
        if (e.poses?.[0]) e.poses[0].feetGrounded = false;
      },
      CheckResult.Fail,
    ],
    [
      "a clip with no validation",
      (e) => {
        e.poses = [];
      },
      CheckResult.Unknown,
    ],
    [
      "a torso that was never measured",
      (e) => {
        if (e.poses?.[0]) e.poses[0].torsoLengthRatio = null;
      },
      CheckResult.Unknown,
    ],
    [
      "reconstructed numbers that look fine",
      (e) => {
        if (e.poses?.[0]) e.poses[0].source = FactSource.Reconstructed;
      },
      CheckResult.Unknown,
    ],
  ];
  for (const [name, change, expected] of rows)
    it(`${name} → ${expected}`, () => assert.equal(resultOf(AaaFloor.AnatomyPose, edit(change)), expected));

  it("blocks Aa with the clip named", () => {
    const evidence = edit((e) => {
      if (e.poses?.[0]) e.poses[0].torsoLengthRatio = 0.6;
    });
    const report = gradePrompt(PROMPT, evidence, TASTE, PASSING_CONTEXT);
    assert.equal(report.grade, AaaGrade.BelowAa);
    const check = report.checks.find((c) => c.floor === AaaFloor.AnatomyPose);
    assert.match(check?.detail.join(" ") ?? "", /hero\/walk: torso keeps 60%/);
  });
});

describe("place coherence", () => {
  const place = (e: AaaEvidence, change: Partial<NonNullable<AaaEvidence["place"]>>) => {
    if (e.place) Object.assign(e.place, change);
  };
  const rows: Array<[string, (e: AaaEvidence) => void, CheckResult]> = [
    ["a zone nothing reaches", (e) => place(e, { reachableZones: 3 }), CheckResult.Fail],
    ["an unplanned dead end", (e) => place(e, { unplannedDeadEnds: 1 }), CheckResult.Fail],
    ["fewer zones than planned", (e) => place(e, { zones: 3, reachableZones: 3 }), CheckResult.Fail],
    ["no exit where one was planned", (e) => place(e, { exits: 0 }), CheckResult.Fail],
    ["no level plan", (e) => place(e, { plannedZones: null }), CheckResult.Unknown],
    ["no planned exits", (e) => place(e, { plannedExits: null }), CheckResult.Unknown],
    [
      "no reachability facts",
      (e) => {
        e.place = null;
      },
      CheckResult.Unknown,
    ],
  ];
  for (const [name, change, expected] of rows)
    it(`${name} → ${expected}`, () => assert.equal(resultOf(AaaFloor.PlaceCoherence, edit(change)), expected));
});

describe("look features against the preset", () => {
  it("fails when a feature the preset owns is off, naming it", () => {
    const evidence = edit((e) => {
      if (e.lookFeatures) e.lookFeatures.active = ["ssao"];
    });
    const check = honestChecks(evidence, PASSING_CONTEXT).find((c) => c.floor === AaaFloor.LookFeatures);
    assert.equal(check?.result, CheckResult.Fail);
    assert.match(check?.detail.join(" ") ?? "", /off in desktop-ultra: volumetric-fog/);
  });

  it("is unmeasured without look facts or a feature list", () => {
    assert.equal(
      resultOf(
        AaaFloor.LookFeatures,
        edit((e) => {
          e.lookFeatures = null;
        }),
      ),
      CheckResult.Unknown,
    );
    assert.equal(
      resultOf(
        AaaFloor.LookFeatures,
        edit((e) => {
          if (e.lookFeatures) e.lookFeatures.expected = [];
        }),
      ),
      CheckResult.Unknown,
    );
  });
});

describe("the dev-store guard", () => {
  it("passes a store built from the current head, whichever side is abbreviated", () => {
    assert.equal(resultOf(AaaFloor.StoreFresh, passingEvidence(PROMPT)), CheckResult.Pass);
    assert.equal(
      resultOf(AaaFloor.StoreFresh, passingEvidence(PROMPT), { ...PASSING_CONTEXT, expectedHead: HEAD.slice(0, 8) }),
      CheckResult.Pass,
    );
  });

  it("fails a stale store and blocks the grade", () => {
    const report = gradePrompt(PROMPT, passingEvidence(PROMPT), TASTE, {
      ...PASSING_CONTEXT,
      expectedHead: "ffff0000aaaa",
    });
    assert.equal(report.grade, AaaGrade.BelowAa);
    assert.equal(report.checks.find((c) => c.floor === AaaFloor.StoreFresh)?.result, CheckResult.Fail);
  });

  it("is unmeasured without the current head or the store's head", () => {
    assert.equal(
      resultOf(AaaFloor.StoreFresh, passingEvidence(PROMPT), { ...PASSING_CONTEXT, expectedHead: null }),
      CheckResult.Unknown,
    );
    assert.equal(
      resultOf(
        AaaFloor.StoreFresh,
        edit((e) => {
          e.store = null;
        }),
      ),
      CheckResult.Unknown,
    );
  });

  it("does not take two short or different heads as the same", () => {
    assert.equal(sameHead("abc12", "abc12"), false);
    assert.equal(sameHead("abc1234", "abc1235"), false);
    assert.equal(sameHead("ABC1234DEF", "abc1234"), true);
  });
});

describe("the vision judges' items", () => {
  const withVision = (vision: GradeContext["vision"]) =>
    gradePrompt(PROMPT, passingEvidence(PROMPT), TASTE, { expectedHead: HEAD, vision });

  it("cap a run at Aa while the judges have not spoken", () => {
    assert.equal(withVision(null).grade, AaaGrade.Aa);
  });

  it("fail a run the anatomy judge failed, with the judge's lines", () => {
    const report = withVision({
      anatomy: { pass: false, sameFamily: false, detail: ["closeup:hero/walk: gpt fail"] },
      place: PASSING_CONTEXT.vision?.place ?? null,
    });
    assert.equal(report.grade, AaaGrade.Aa);
    const check = report.checks.find((c) => c.floor === AaaFloor.AnatomyJudge);
    assert.equal(check?.result, CheckResult.Fail);
    assert.match(check?.detail.join(" ") ?? "", /gpt fail/);
  });

  it("fail a run the place judge failed", () => {
    const report = withVision({
      anatomy: PASSING_CONTEXT.vision?.anatomy ?? null,
      place: { pass: false, sameFamily: false, detail: [] },
    });
    assert.equal(report.checks.find((c) => c.floor === AaaFloor.PlaceJudge)?.result, CheckResult.Fail);
  });

  it("need no anatomy verdict for a game with no animated characters", () => {
    const evidence = edit((e) => {
      e.characters = { clips: [], source: FactSource.Engine };
    });
    assert.equal(resultOf(AaaFloor.AnatomyJudge, evidence, { ...PASSING_CONTEXT, vision: null }), CheckResult.Pass);
  });
});

describe("the vision judge runs", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const bundle = async () => {
    const dir = await tmpDir("aaa-honest-");
    fs.mkdirSync(path.join(dir, "captures"));
    fs.writeFileSync(path.join(dir, "captures", "a.png"), png);
    return dir;
  };
  const withImages = (evidence: AaaEvidence) => {
    for (const c of evidence.captures) c.image = "captures/a.png";
    return evidence;
  };
  const deps = (replies: string[]): TasteDeps => {
    let call = 0;
    return {
      pins: [{ family: "gpt", model: "m", effort: "medium", promptSha: "x" }] as unknown as TasteDeps["pins"],
      complete: async () => ({ text: replies[call++ % replies.length] ?? "" }) as never,
      votes: 3,
      builderFamily: "claude",
      referenceStills: () => [],
    };
  };

  it("parses a verdict only from the last line", () => {
    assert.equal(parseVerdict("torso folded\nVERDICT: fail"), false);
    assert.equal(parseVerdict("ok\nVERDICT: pass"), true);
    assert.equal(parseVerdict("VERDICT: pass\nbut actually"), null);
  });

  it("fails an item when most votes fail, and passes when most pass", async () => {
    const evidence = withImages(clone(passingEvidence(PROMPT)));
    const dir = await bundle();
    const failing = await judgeAnatomy(
      evidence,
      dir,
      "{{clip}} {{size}}",
      deps(["x\nVERDICT: fail", "x\nVERDICT: fail", "x\nVERDICT: pass"]),
    );
    assert.equal(failing.verdict?.pass, false);
    const passing = await judgeAnatomy(evidence, dir, "{{clip}} {{size}}", deps(["x\nVERDICT: pass"]));
    assert.equal(passing.verdict?.pass, true);
    assert.equal(passing.verdict?.sameFamily, false);
  });

  it("leaves the item unmeasured when a close-up or the map is missing or the reply is unusable", async () => {
    const dir = await bundle();
    const noImage = clone(passingEvidence(PROMPT));
    assert.equal((await judgeAnatomy(noImage, dir, "t", deps(["VERDICT: pass"]))).verdict, null);
    const evidence = withImages(clone(passingEvidence(PROMPT)));
    assert.equal((await judgeAnatomy(evidence, dir, "t", deps(["no verdict here"]))).verdict, null);
    assert.equal((await judgePlace(PROMPT, noImage, dir, "t", deps(["VERDICT: pass"]))).verdict, null);
    const judged = await judgePlace(PROMPT, evidence, dir, "t", deps(["VERDICT: pass"]));
    assert.equal(judged.verdict?.pass, true);
  });
});
