/**
 * The loop's per-stack routing (M3.2): which stack a night is on, what it scaffolds and plans with,
 * which run is stamped compiled, which launches are refused for changing a game's stack, and the
 * review rules a Rust · wgpu game reads. Every answer is a table over the stacks; the raylib and
 * three.js rows are characterized as they were before Rust games.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuildTarget, GameStack, ProjectKind, TargetRefusal } from "../../src/harness-seed/loop/native-contract.ts";
import {
  nightStack,
  scaffoldFor,
  stackChangeRefusal,
  stampedStack,
  templateShapeFor,
  wiringFor,
} from "../../src/harness-seed/loop/native-loop.ts";
import {
  cppFindings,
  cppOwnedPlace,
  isCppOwnerFile,
  RUST_OWNER_FILES,
  reviewsCpp,
} from "../../src/harness-seed/loop/native-review.ts";
import { mechanicalReview } from "../../src/harness-seed/loop/review.ts";
import * as nativeLoop from "../../src/harness-seed/loop/native-loop.ts";
import * as nativeEvidence from "../../src/harness-seed/loop/native-evidence.ts";
import * as nativeReview from "../../src/harness-seed/loop/native-review.ts";
import * as nativeVerdict from "../../src/harness-seed/loop/native-verdict.ts";
import * as library from "../../src/harness-seed/loop/library.ts";
import * as gameTools from "../../src/harness-seed/tools/game-tools.ts";

const { Web, Mac, Windows, Linux, Ios, Android } = BuildTarget;

describe("what an intake scaffolds, per stack (M3.2)", () => {
  it("keeps the browser answer, and a desktop destination now asks for Rust, never raylib (M6.6)", () => {
    assert.deepEqual(scaffoldFor(undefined), {});
    assert.deepEqual(scaffoldFor([Web]), {});
    for (const targets of [[Mac], [Web, Mac], [Windows, Linux], [Web, Mac, Windows, Linux]])
      assert.deepEqual(scaffoldFor(targets), { kind: ProjectKind.RustWgpu, targets }, targets.join("+"));
    assert.deepEqual(scaffoldFor(["mac", "nonsense", Mac, Mac]), { kind: ProjectKind.RustWgpu, targets: [Mac] });
  });

  it("a phone destination asks for the Rust template, never three.js that drops it", () => {
    for (const targets of [[Ios], [Android], [Web, Ios], [Mac, Android], [Web, Mac, Ios, Android]])
      assert.deepEqual(scaffoldFor(targets), { kind: ProjectKind.RustWgpu, targets }, targets.join("+"));
  });

  it("an asked-for Rust game is one whatever its destinations", () => {
    assert.deepEqual(scaffoldFor([Web, Mac], GameStack.RustWgpu), { kind: ProjectKind.RustWgpu, targets: [Web, Mac] });
    assert.deepEqual(scaffoldFor(undefined, GameStack.RustWgpu), { kind: ProjectKind.RustWgpu, targets: [] });
  });

  it("plans with the template shape of the stack it scaffolds", () => {
    assert.equal(templateShapeFor([Web]), null);
    assert.equal(templateShapeFor([Mac])?.main, "src/main.rs");
    assert.equal(templateShapeFor([Mac])?.kind, ProjectKind.RustWgpu);
    assert.equal(templateShapeFor([Ios])?.main, "src/main.rs");
    assert.equal(templateShapeFor([Web], GameStack.RustWgpu)?.kind, ProjectKind.RustWgpu);
  });

  it("the night's stack is the folder's kind, else what the intake asked for", () => {
    const rust = { name: "pond", shape: { kind: ProjectKind.RustWgpu, main: "src/main.rs" } };
    assert.equal(nightStack(rust, [Mac]), GameStack.RustWgpu, "the folder wins");
    assert.equal(nightStack(null, [Mac]), GameStack.RustWgpu);
    const raylib = { name: "pong", shape: { kind: ProjectKind.RaylibCpp, main: "src/main.cpp" } };
    assert.equal(nightStack(raylib, [Mac]), GameStack.RaylibCpp, "an existing raylib folder keeps its stack");
    assert.equal(nightStack(null, [Android]), GameStack.RustWgpu);
    assert.equal(nightStack(null, [Web], GameStack.RustWgpu), GameStack.RustWgpu);
    assert.equal(nightStack(null, undefined), GameStack.ThreeJs);
  });

  it("a Rust entry takes the union merge of its FACET WIRING block, like a C++ one", () => {
    assert.deepEqual(wiringFor({ kind: ProjectKind.RustWgpu, main: "src/main.rs" }, true), {
      main: "src/main.rs",
      wiring: true,
    });
  });
});

describe("which runs are stamped compiled (M3.2)", () => {
  it("a Rust run is stamped Rust, a raylib run raylib, anything else none", () => {
    assert.equal(stampedStack({ stack: GameStack.RustWgpu }), GameStack.RustWgpu);
    assert.equal(stampedStack({ stack: GameStack.RaylibCpp }), GameStack.RaylibCpp);
    for (const run of [{ stack: GameStack.ThreeJs }, { stack: "unity" }, {}, null, undefined])
      assert.equal(stampedStack(run), null, JSON.stringify(run));
  });
});

describe("a launch that would change a game's stack (M3.2)", () => {
  const raylib = { name: "pong", shape: { kind: ProjectKind.RaylibCpp, main: "src/main.cpp" } };
  const browser = { name: "maze", shape: { kind: ProjectKind.StudioTemplate } };
  const rust = { name: "pond", shape: { kind: ProjectKind.RustWgpu, main: "src/main.rs" } };

  it("refuses a phone for a raylib game by its code, naming the phone", () => {
    const refused = stackChangeRefusal(raylib, [Mac, Ios]);
    assert.equal(refused?.code, TargetRefusal.StackIsFixed);
    assert.match(String(refused?.message), /ios/);
  });

  it("keeps the answers it gave before Rust games (characterization)", () => {
    assert.equal(stackChangeRefusal(browser, [Mac])?.code, TargetRefusal.StackIsFixed);
    assert.equal(stackChangeRefusal(raylib, [Web, Mac, Windows]), null);
    assert.equal(stackChangeRefusal(browser, [Web]), null);
    assert.equal(stackChangeRefusal(null, [Mac]), null);
  });

  it("lets a Rust game name any destination", () => {
    assert.equal(stackChangeRefusal(rust, [Web, Mac, Windows, Linux, Ios, Android]), null);
  });
});

describe("a Rust · wgpu game's review rules (M3.2)", () => {
  /** One added line in `file`, reviewed as the studio's template. */
  const review = (file: string, text: string, removed: string[] = []) =>
    cppFindings({ file, added: [{ line: 7, text }], removed, template: true });
  const categories = (file: string, text: string) => review(file, text).map((finding) => finding.category);

  it("reads its rules by stack: a Rust game and a raylib game, never a three.js one", () => {
    assert.equal(reviewsCpp(GameStack.RustWgpu, "src/main.rs", []), true);
    assert.equal(reviewsCpp(GameStack.RaylibCpp, "src/main.cpp", []), true);
    assert.equal(reviewsCpp(GameStack.ThreeJs, "src/main.js", ["src/fish.rs"]), false);
    assert.equal(reviewsCpp(null, "src/main.js", ["src/facets/fish.rs"]), true, "no stack named: by the files");
  });

  const hostile: Array<[string, string, string]> = [
    ["determinism", "src/facets/fish.rs", "let n = rand::thread_rng().gen::<u32>();"],
    ["determinism", "src/facets/fish.rs", "let roll = fastrand::u32(0..6);"],
    ["wall-clock", "src/facets/fish.rs", "let started = Instant::now();"],
    ["wall-clock", "src/game.rs", "let t = std::time::SystemTime::now();"],
    ["input", "src/facets/fish.rs", "if let winit::event::WindowEvent::KeyboardInput { .. } = event {"],
    ["frame-pacing", "src/facets/fish.rs", "std::thread::sleep(std::time::Duration::from_millis(16));"],
    ["collections", "src/facets/fish.rs", "let mut seen: HashMap<u32, u32> = HashMap::new();"],
    ["float-math", "src/facets/fish.rs", "let y = angle.sin() * radius;"],
    ["float-math", "src/facets/fish.rs", "let p = f32::powf(base, 2.5);"],
    ["unsafe", "src/facets/fish.rs", "unsafe { core::ptr::write(p, 1) }"],
    ["dependencies", "genex.toml", "[dependencies]"],
  ];
  for (const [category, file, text] of hostile)
    it(`finds ${category} in ${file}: ${text}`, () => {
      assert.ok(categories(file, text).includes(category), JSON.stringify(review(file, text)));
    });

  const allowed: Array<[string, string]> = [
    ["src/facets/fish.rs", "let y = genex::math::sin(angle) * radius;"],
    ["src/facets/fish.rs", "let d = (dx * dx + dy * dy).sqrt();"],
    ["src/facets/fish.rs", "let reach = ctx.rng.range_f32(1.0, 2.0);"],
    ["src/facets/fish.rs", "let mut seen: genex::Map<u32, u32> = genex::Map::default();"],
    ["src/facets/fish.rs", "// never use Instant::now() or thread_rng here"],
    ["genex.toml", "# no [dependencies]: the host writes the manifest"],
    ["genex.toml", 'title = "Pond"'],
  ];
  for (const [file, text] of allowed)
    it(`finds nothing in ${file}: ${text}`, () => {
      assert.deepEqual(review(file, text), []);
    });

  it("a removed genex::install is a contract finding", () => {
    const findings = cppFindings({
      file: "src/main.rs",
      added: [],
      removed: ["    genex::install(game);"],
      template: true,
    });
    assert.deepEqual(
      findings.map((finding) => finding.category),
      ["contract"],
    );
    assert.match(findings[0]?.what ?? "", /genex::install/);
  });

  it("a game the user brought keeps its own clock, randomness and input; its HashMap is still a finding", () => {
    const own = (text: string) =>
      cppFindings({ file: "src/fish.rs", added: [{ line: 1, text }], removed: [], template: false });
    assert.deepEqual(own("let t = Instant::now();"), []);
    assert.deepEqual(
      own("let m: HashMap<u8, u8> = HashMap::new();").map((finding) => finding.category),
      ["collections"],
    );
  });

  it("the C++ rules read no Rust file, and the Rust rules no C++ file", () => {
    assert.deepEqual(review("src/fish.rs", "SetTargetFPS(60);"), []);
    assert.deepEqual(review("src/fish.cpp", "let m: HashMap<u8, u8> = HashMap::new();"), []);
  });

  it("the entry owner holds src/main.rs, genex.toml and the API page; a facet owns src/facets/<slug>.rs", () => {
    assert.deepEqual([...RUST_OWNER_FILES].sort(), ["docs/GENEX_API.md", "genex.toml", "src/main.rs"]);
    for (const file of RUST_OWNER_FILES) assert.equal(isCppOwnerFile(file), true, file);
    assert.equal(isCppOwnerFile("src/facets/fish.rs"), false);
    assert.equal(cppOwnedPlace("fish", GameStack.RustWgpu), "src/facets/fish.rs");
    assert.equal(cppOwnedPlace("fish"), "src/fish.cpp", "a caller that names no stack is raylib's");
  });

  it("review.ts reads the Rust rules on a Rust night's diff", () => {
    const diff = [
      "diff --git a/src/facets/fish.rs b/src/facets/fish.rs",
      "--- a/src/facets/fish.rs",
      "+++ b/src/facets/fish.rs",
      "@@ -1,1 +1,2 @@",
      " use genex::prelude::*;",
      "+let started = Instant::now();",
    ].join("\n");
    const spec = { id: "fish", owns: ["src/facets/fish.rs"] };
    const findings = mechanicalReview(diff, spec as never, { stack: GameStack.RustWgpu, main: "src/main.rs" });
    assert.ok(
      findings.some((finding) => finding.category === "wall-clock"),
      JSON.stringify(findings),
    );
  });
});

describe("the parts a Rust night runs say so (M3.2)", () => {
  it("each module this package routes per stack carries SERVES_RUST", () => {
    for (const [name, part] of Object.entries({
      nativeLoop,
      nativeEvidence,
      nativeReview,
      nativeVerdict,
      library,
      gameTools,
    }))
      assert.equal((part as Record<string, unknown>).SERVES_RUST, true, name);
  });
});
