/**
 * Which Genex CLI commands an agent may run through `genex__cli` and `genex__cli-paid`, and the
 * exact argv Studio hands the pinned CLI. Everything else is a typed refusal that names what to use
 * instead; nothing here spawns anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GameDeclaration,
  GenexCliCommand,
  GenexCliRefusal,
  GenexCliRefusalCode,
  genexCliConsentArgs,
  genexCliRequest,
  SCHEMA_MAX_BYTES,
} from "../../src/main/core/genex-cli-policy.ts";
import { consentArgsDigest } from "../../src/main/core/plugin-tools.ts";
import { consentAskWords } from "../../src/renderer/words.ts";

const FREE = { paid: false };
const PAID = { paid: true };

/** The refusal a call throws, so a row can name its code. */
function refusal(args: Record<string, unknown>, tool: { paid: boolean }): GenexCliRefusal {
  try {
    genexCliRequest(args, tool);
  } catch (error) {
    assert.ok(error instanceof GenexCliRefusal, `expected a typed refusal, got ${String(error)}`);
    return error;
  }
  assert.fail(`${JSON.stringify(args)} was not refused`);
}

describe("commands the agent may not run", () => {
  const rows: Array<[string, Record<string, unknown>, { paid: boolean }, GenexCliRefusalCode, RegExp?]> = [
    ["auth", { command: "auth" }, FREE, GenexCliRefusalCode.Unavailable],
    ["login", { command: "login" }, FREE, GenexCliRefusalCode.Unavailable],
    ["tools", { command: "tools" }, FREE, GenexCliRefusalCode.Unavailable],
    ["init", { command: "init" }, PAID, GenexCliRefusalCode.Unavailable],
    ["player", { command: "player install" }, FREE, GenexCliRefusalCode.Unavailable],
    ["remix", { command: "remix" }, FREE, GenexCliRefusalCode.Unavailable],
    ["domain", { command: "domain" }, PAID, GenexCliRefusalCode.Unavailable],
    [
      "llm price, whose saved bench no Studio run folder keeps",
      { command: "llm price" },
      FREE,
      GenexCliRefusalCode.Unavailable,
      /folder it removes.*answer of llm bench/,
    ],
    ["llm price through the paid tool", { command: "llm price" }, PAID, GenexCliRefusalCode.Unavailable, /removes/],
    ["help", { command: "help" }, FREE, GenexCliRefusalCode.Unavailable],
    ["an empty command", { command: "  " }, FREE, GenexCliRefusalCode.Unavailable],
    ["publish", { command: "publish" }, FREE, GenexCliRefusalCode.UseTool, /genex__publish/],
    ["preview", { command: "preview" }, PAID, GenexCliRefusalCode.UseTool, /genex__publish/],
    ["image", { command: "image" }, FREE, GenexCliRefusalCode.UseTool, /genex__asset/],
    ["animations", { command: "animations search", args: "run" }, FREE, GenexCliRefusalCode.UseTool, /genex__asset/],
    ["a flag in the command", { command: "doctor --json" }, FREE, GenexCliRefusalCode.Unavailable],
    [
      "a paid command through the free tool",
      { command: "llm bench", args: "hi", options: { "max-credits": 5 } },
      FREE,
      GenexCliRefusalCode.PaidTool,
      /genex__cli-paid/,
    ],
    [
      "shop add through the paid tool, whose card would ask about a draft that spends nothing",
      { command: "shop add", args: "Key", options: { price: 100 } },
      PAID,
      GenexCliRefusalCode.FreeTool,
      /genex__cli\b/,
    ],
    [
      "budget --assets through the free tool, an allowance no Studio run keeps",
      { command: "budget", options: { assets: 50 } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
      /Studio/,
    ],
    [
      "budget --assets through the paid tool",
      { command: "budget", options: { assets: 50 } },
      PAID,
      GenexCliRefusalCode.UnknownOption,
      /Studio/,
    ],
    [
      "a free command through the paid tool",
      { command: "shop list" },
      PAID,
      GenexCliRefusalCode.FreeTool,
      /genex__cli\b/,
    ],
    ["plain budget through the paid tool", { command: "budget" }, PAID, GenexCliRefusalCode.FreeTool],
  ];
  for (const [name, args, tool, code, names] of rows) {
    it(`refuses ${name}`, () => {
      const refused = refusal(args, tool);
      assert.equal(refused.code, code);
      if (names) assert.match(refused.message, names);
    });
  }
});

describe("flags and values the agent may not pass", () => {
  const rows: Array<[string, Record<string, unknown>, { paid: boolean }, GenexCliRefusalCode]> = [
    ["--env", { command: "doctor", options: { env: "/tmp/x" } }, FREE, GenexCliRefusalCode.ReservedFlag],
    ["--dir", { command: "llm models", options: { dir: "/" } }, FREE, GenexCliRefusalCode.ReservedFlag],
    [
      "--user-approved",
      { command: "llm bench", args: "hi", options: { "max-credits": 5, "user-approved": true } },
      PAID,
      GenexCliRefusalCode.ReservedFlag,
    ],
    ["--no-auth", { command: "doctor", options: { "no-auth": true } }, FREE, GenexCliRefusalCode.ReservedFlag],
    [
      "--api-url",
      { command: "doctor", options: { "api-url": "https://evil.example" } },
      FREE,
      GenexCliRefusalCode.ReservedFlag,
    ],
    ["--agents", { command: "doctor", options: { agents: "claude" } }, FREE, GenexCliRefusalCode.ReservedFlag],
    [
      "--force",
      { command: "shop remove", args: "sku_1", options: { force: true } },
      PAID,
      GenexCliRefusalCode.ReservedFlag,
    ],
    ["--json", { command: "doctor", options: { json: true } }, FREE, GenexCliRefusalCode.ReservedFlag],
    [
      "--schema on a command that reads no answer shape",
      { command: "llm status", options: { schema: "answer.schema.json" } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
    ],
    [
      "a dashed option name",
      { command: "llm models", options: { "--all": true } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
    ],
    [
      "an option another command takes",
      { command: "doctor", options: { all: true } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
    ],
    ["a positional of --force", { command: "llm cancel", args: "--force" }, FREE, GenexCliRefusalCode.InvalidValue],
    ["a positional with a newline", { command: "llm cancel", args: "a\nb" }, FREE, GenexCliRefusalCode.InvalidValue],
    ["a positional with a NUL", { command: "llm cancel", args: "a\u0000b" }, FREE, GenexCliRefusalCode.InvalidValue],
    [
      "an overlong positional",
      { command: "llm bench", args: "x".repeat(4001), options: { "max-credits": 5 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    ["a positional to a command without one", { command: "doctor", args: "x" }, FREE, GenexCliRefusalCode.InvalidValue],
    ["a missing positional", { command: "llm cancel" }, FREE, GenexCliRefusalCode.InvalidValue],
    [
      "max-credits 1.5",
      { command: "llm bench", args: "hi", options: { "max-credits": 1.5 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "max-credits 0",
      { command: "llm bench", args: "hi", options: { "max-credits": 0 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "max-coins 0, the ceiling under its old name",
      { command: "llm bench", args: "hi", options: { "max-coins": 0 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    ["no max-credits", { command: "llm bench", args: "hi" }, PAID, GenexCliRefusalCode.InvalidValue],
    [
      "max-credits and its old name max-coins with different ceilings",
      { command: "llm bench", args: "hi", options: { "max-credits": 5, "max-coins": 6 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "the old name first, then a different max-credits",
      { command: "llm bench", args: "hi", options: { "max-coins": 6, "max-credits": 5 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a text value starting with a dash",
      { command: "shop add", args: "Key", options: { price: 100, icon: "--env" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a type outside its choices",
      { command: "shop add", args: "Key", options: { price: 100, type: "rig" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a flag given a string",
      { command: "llm models", options: { all: "yes" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "options that are not an object",
      { command: "llm models", options: ["all"] },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    ["options that are not JSON", { command: "llm models", options: "{all" }, FREE, GenexCliRefusalCode.InvalidValue],
    ["a command that is not a string", { command: 7 }, FREE, GenexCliRefusalCode.Unavailable],
  ];
  for (const [name, args, tool, code] of rows) {
    it(`refuses ${name}`, () => assert.equal(refusal(args, tool).code, code));
  }
});

describe("the argv Studio runs", () => {
  it("runs doctor as it is, off any project", () => {
    assert.deepEqual(genexCliRequest({ command: "doctor" }, FREE), {
      command: GenexCliCommand.Doctor,
      argv: ["doctor"],
      project: false,
      paid: false,
    });
  });
  it("spells flags with dashes and values after them, in the order given", () => {
    const request = genexCliRequest({ command: " llm   models ", options: '{"all":true}' }, FREE);
    assert.deepEqual(request.argv, ["llm", "models", "--all"]);
    assert.equal(request.project, false);
  });
  it("adds --user-approved itself to a paid bench, after the whole-number max-credits", () => {
    const request = genexCliRequest(
      { command: "llm bench", args: "Say hi", options: { "max-credits": 5, samples: 3 } },
      PAID,
    );
    assert.deepEqual(request.argv, [
      "llm",
      "bench",
      "Say hi",
      "--max-credits",
      "5",
      "--samples",
      "3",
      "--user-approved",
    ]);
    assert.equal(request.argv.at(-1), "--user-approved");
    assert.equal(request.project, true);
    assert.equal(request.paid, true);
  });
  // The CLI renamed --max-coins to --max-credits (a bench spends credits) and prints a deprecation
  // line for the old name: an agent that learned it still gets its bench, under the current flag.
  it("reads the old max-coins as max-credits, and passes the CLI the current flag once", () => {
    const bench = (options: Record<string, unknown>) =>
      genexCliRequest({ command: "llm bench", args: "Say hi", options }, PAID).argv;
    const current = ["llm", "bench", "Say hi", "--max-credits", "5", "--user-approved"];
    assert.deepEqual(bench({ "max-coins": 5 }), current);
    assert.deepEqual(bench({ "max-coins": "5", "max-credits": 5 }), current, "the same ceiling under both names");
    assert.deepEqual(bench({ samples: 2, "max-coins": 9 }).slice(3), [
      "--samples",
      "2",
      "--max-credits",
      "9",
      "--user-approved",
    ]);
  });
  it("says which option a bench needs, and which names disagree, by the current name", () => {
    assert.match(refusal({ command: "llm bench", args: "hi" }, PAID).message, /needs the max-credits option/);
    const both = refusal({ command: "llm bench", args: "hi", options: { "max-credits": 5, "max-coins": 6 } }, PAID);
    assert.match(both.message, /max-credits.*max-coins.*5.*6/);
    const unknown = refusal({ command: "llm bench", args: "hi", options: { "max-credits": 5, coins: 1 } }, PAID);
    assert.equal(unknown.code, GenexCliRefusalCode.UnknownOption);
    assert.match(unknown.message, /max-credits/);
    assert.doesNotMatch(unknown.message, /max-coins/, "the old name is accepted, never advertised");
  });
  it("binds project commands to the hosted project and leaves free ones unbound", () => {
    assert.equal(genexCliRequest({ command: "llm status" }, FREE).project, true);
    assert.equal(genexCliRequest({ command: "llm cancel", args: "gen_1" }, FREE).project, true);
    assert.equal(genexCliRequest({ command: "shop list" }, FREE).project, true);
    assert.equal(genexCliRequest({ command: "budget" }, FREE).project, false);
  });
  it("sets and clears a shop item's resale with the CLI's two flags", () => {
    assert.deepEqual(
      genexCliRequest({ command: "shop set", args: "sku_1", options: { resellable: false, price: 50 } }, PAID).argv,
      ["shop", "set", "sku_1", "--no-resellable", "--price", "50"],
    );
    assert.deepEqual(
      genexCliRequest(
        {
          command: "shop add",
          args: "Iron Key",
          options: { price: 100, type: "durable", resellable: true, image: "key.png" },
        },
        FREE,
      ).argv,
      ["shop", "add", "Iron Key", "--price", "100", "--type", "durable", "--resellable", "--image", "key.png"],
    );
  });
  it("leaves out a flag that is false", () => {
    assert.deepEqual(genexCliRequest({ command: "llm models", options: { all: false } }, FREE).argv, ["llm", "models"]);
  });
});

describe("what the consent card shows for a paid call", () => {
  /** The card's text for `args`, the way the chat renders the durable record. */
  const card = (args: Record<string, unknown>) =>
    consentAskWords({
      pluginName: "Genex",
      tool: "genex__cli-paid",
      args: consentArgsDigest(genexCliConsentArgs(args, PAID)),
    });
  const longText = `Benchmark with max-credits 5. ${"x".repeat(2100)}`;
  const rows: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "a bench whose long prompt comes first",
      { command: "llm bench", args: longText, options: { model: "m".repeat(400), samples: 25, "max-credits": 250000 } },
      /max-credits: 250000/,
    ],
    [
      "a shop item change whose long id comes first",
      { command: "shop set", args: "k".repeat(3000), options: { icon: "i".repeat(400), price: 9000 } },
      /price: 9000/,
    ],
    [
      "a price change behind a long rename",
      { command: "shop set", args: "sku_1", options: { rename: "r".repeat(400), price: 70 } },
      /price: 70/,
    ],
  ];
  for (const [name, args, spend] of rows) {
    it(`names what it spends first for ${name}`, () => {
      const text = card(args);
      assert.match(text, /command: (llm bench|shop set)/);
      assert.match(text, spend);
    });
  }
  it("never shows the agent's own words before the amount", () => {
    const text = card({ command: "llm bench", args: longText, options: { "max-credits": 250000 } });
    assert.ok(text.indexOf("max-credits: 250000") < text.indexOf("Benchmark"), text);
  });
  it("names the ceiling in credits whichever name the agent used", () => {
    const shown = genexCliConsentArgs({ command: "llm bench", args: "hi", options: { "max-coins": 40 } }, PAID);
    assert.equal(shown["max-credits"], "40");
    assert.equal(shown["max-coins"], undefined);
  });
  it("shows the answer-shape file a bench reads, after what it spends", () => {
    const shown = genexCliConsentArgs(
      { command: "llm bench", args: "hi", options: { schema: "answer.schema.json", "max-credits": 40 } },
      PAID,
    );
    assert.deepEqual(Object.keys(shown), ["command", "max-credits", "schema", "args"]);
    assert.equal(shown.schema, "answer.schema.json");
  });
  it("refuses before anyone is asked when Studio would refuse the call", () => {
    assert.throws(() => genexCliConsentArgs({ command: "llm bench", args: "hi" }, PAID), GenexCliRefusal);
    assert.throws(() => genexCliConsentArgs({ command: "shop list" }, PAID), GenexCliRefusal);
  });
  it("asks nobody about a new item's draft, which spends nothing and sells nothing until the person puts it on sale", () => {
    const draft = { command: "shop add", args: "Ivory Coffin", options: { price: 300, image: "coffin.png" } };
    assert.throws(() => genexCliConsentArgs(draft, PAID), GenexCliRefusal);
    assert.equal(genexCliRequest(draft, FREE).paid, false);
  });
});

describe("the answer-shape file a bench reads (`--schema`)", () => {
  // Genex's pricing card benchmarks with the game's own JSON schema file, and the CLI never runs in
  // the game: the option names a small .json file inside it, which Studio checks by real path and
  // copies into the run folder (`genex-cli-game-paths.test.ts` holds that table).
  const bench = (schema: unknown) => ({ command: "llm bench", args: "hi", options: { "max-credits": 5, schema } });

  it("names a .json file inside the game for Studio to check and copy in", () => {
    const request = genexCliRequest(bench("src/npc/answer.schema.json"), PAID);
    assert.deepEqual(request.argv, [
      "llm",
      "bench",
      "hi",
      "--max-credits",
      "5",
      "--schema",
      "src/npc/answer.schema.json",
      "--user-approved",
    ]);
    assert.deepEqual(request.gamePaths, [
      {
        option: "schema",
        path: "src/npc/answer.schema.json",
        target: "file",
        index: 6,
        small: { extension: ".json", maxBytes: SCHEMA_MAX_BYTES },
      },
    ]);
    assert.equal(SCHEMA_MAX_BYTES, 16 * 1024, "Genex takes a schema of at most 16 KB");
    assert.equal(genexCliRequest(bench("Answer.Schema.JSON"), PAID).gamePaths?.[0]?.path, "Answer.Schema.JSON");
  });

  const refusals: Array<[string, unknown]> = [
    ["an absolute path", "/etc/answer.schema.json"],
    ["a home-relative path", "~/answer.schema.json"],
    ["a drive-letter path", "C:\\Users\\me\\answer.schema.json"],
    ["a network share", "\\\\host\\share\\answer.schema.json"],
    ["a path behind ../", "../other-game/answer.schema.json"],
    ["a path with ../ inside", "src/../../answer.schema.json"],
    ["a path with a backslash ..", "src\\..\\..\\answer.schema.json"],
    ["a path with a NUL", "answer\u0000.schema.json"],
    ["a path with a line break", "answer.schema.json\n--env"],
    ["a path that reads as a flag", "--env.json"],
    ["a file that is not .json", "answer.schema.txt"],
    ["a .json name with something after it", "answer.schema.json.bak"],
    ["a path with no extension", ".env"],
    ["the game itself", "."],
    ["an empty path", ""],
    ["a path longer than a path is", `${"a/".repeat(260)}s.json`],
    ["a path that is not text", { path: "answer.schema.json" }],
    ["a list of paths", ["a.json", "b.json"]],
  ];
  for (const [name, schema] of refusals) {
    it(`refuses ${name}`, () => {
      assert.equal(refusal(bench(schema), PAID).code, GenexCliRefusalCode.InvalidValue);
    });
  }
});

describe("a store item's picture", () => {
  it("is needed before the item is listed: shop add without one is refused, saying how to make it", () => {
    const refused = refusal({ command: "shop add", args: "Rogue", options: { price: 100 } }, FREE);
    assert.equal(refused.code, GenexCliRefusalCode.InvalidValue);
    assert.match(refused.message, /picture/);
    assert.match(refused.message, /image/);
    const listed = genexCliRequest(
      { command: "shop add", args: "Rogue", options: { price: 100, image: ".genex/scratch/rogue.png" } },
      FREE,
    );
    assert.deepEqual(
      listed.gamePaths?.map((file) => file.option),
      ["image"],
    );
  });
});

describe("a local draft's changes", () => {
  // A draft made before the game is on Genex lives in the game's .genex/items/ and nobody can buy
  // it: changing or removing it spends and sells nothing, so it asks nobody, as making it did.
  const LOCAL = "local_abcdefghijkl";
  const calls: Array<[string, Record<string, unknown>]> = [
    ["a new picture", { command: "shop set", args: LOCAL, options: { image: ".genex/scratch/rod.png" } }],
    ["a new price", { command: "shop set", args: LOCAL, options: { price: 300 } }],
    ["its removal", { command: "shop remove", args: LOCAL }],
  ];
  for (const [name, args] of calls) {
    it(`runs ${name} through the free tool, and no card asks about it`, () => {
      assert.equal(genexCliRequest(args, FREE).paid, false);
      assert.equal(refusal(args, PAID).code, GenexCliRefusalCode.FreeTool);
      assert.throws(() => genexCliConsentArgs(args, PAID), GenexCliRefusal);
    });
  }
  it("still asks about a change to an item in the store", () => {
    const listed = { command: "shop set", args: "sku_1", options: { price: 300 } };
    assert.equal(refusal(listed, FREE).code, GenexCliRefusalCode.PaidTool);
    assert.equal(genexCliConsentArgs(listed, PAID).price, "300");
    assert.equal(refusal({ command: "shop remove", args: "sku_1" }, FREE).code, GenexCliRefusalCode.PaidTool);
  });
});

describe("a store item's fields (marketplace plan 8.1)", () => {
  it("passes a description, repeated tags, sharing and a Free price to `shop add`", () => {
    const request = genexCliRequest(
      {
        command: "shop add",
        args: "Frost Axe",
        options: {
          price: 0,
          type: "durable",
          description: "Ice-blue head. Freezes an enemy for a second on hit.",
          tag: ["axe", "ice"],
          shared: true,
          image: ".genex/scratch/frost-axe.png",
        },
      },
      FREE,
    );
    assert.deepEqual(request.argv, [
      "shop",
      "add",
      "Frost Axe",
      "--price",
      "0",
      "--type",
      "durable",
      "--description",
      "Ice-blue head. Freezes an enemy for a second on hit.",
      "--tag",
      "axe",
      "--tag",
      "ice",
      "--shared",
      "--image",
      ".genex/scratch/frost-axe.png",
    ]);
    assert.deepEqual(
      request.gamePaths?.map((file) => file.option),
      ["image"],
      "only the picture is copied from the game",
    );
  });

  it("changes them with `shop set`: sharing off, one tag, a cleared description, Free, the type", () => {
    const request = genexCliRequest(
      {
        command: "shop set",
        args: "sku_1",
        options: { shared: false, tag: "wings", description: "", price: 0, type: "consumable" },
      },
      PAID,
    );
    assert.deepEqual(request.argv, [
      "shop",
      "set",
      "sku_1",
      "--no-shared",
      "--tag",
      "wings",
      "--description",
      "",
      "--price",
      "0",
      "--type",
      "consumable",
    ]);
  });

  it("names the game's picture, model and package where the argv takes them, for Studio to copy in", () => {
    const request = genexCliRequest(
      {
        command: "shop add",
        args: "Frost Axe",
        options: {
          price: 1200,
          image: ".genex/scratch/frost-axe.png",
          model: "assets/frost-axe.glb",
          package: "items/frost-axe",
        },
      },
      FREE,
    );
    assert.deepEqual(request.argv.slice(3), [
      "--price",
      "1200",
      "--image",
      ".genex/scratch/frost-axe.png",
      "--model",
      "assets/frost-axe.glb",
      "--package",
      "items/frost-axe",
    ]);
    assert.deepEqual(request.gamePaths, [
      { option: "image", path: ".genex/scratch/frost-axe.png", target: "file", index: 6 },
      { option: "model", path: "assets/frost-axe.glb", target: "file", index: 8 },
      { option: "package", path: "items/frost-axe", target: "folder", index: 10 },
    ]);
    for (const { index, path } of request.gamePaths ?? []) assert.equal(request.argv[index], path);
  });

  const refusals: Array<[string, Record<string, unknown>]> = [
    ["a price below Free", { price: -1 }],
    ["a description longer than genex.games keeps", { price: 100, description: "d".repeat(1001) }],
    ["a description with a line break", { price: 100, description: "one\ntwo" }],
    ["a description that reads as a flag", { price: 100, description: "--env" }],
    ["eleven tags", { price: 100, tag: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ["a tag longer than 32 characters", { price: 100, tag: ["t".repeat(33)] }],
    ["an empty tag", { price: 100, tag: [""] }],
    ["a tag that reads as a flag", { price: 100, tag: ["--json"] }],
    ["a tag that is not text", { price: 100, tag: [7] }],
    ["sharing given as text", { price: 100, shared: "yes" }],
    ["an absolute picture", { price: 100, image: "/etc/passwd" }],
    ["a home-relative picture", { price: 100, image: "~/secret.png" }],
    ["a drive-letter picture", { price: 100, image: "C:\\Users\\me\\secret.png" }],
    ["a picture behind ../", { price: 100, image: "../other-game/axe.png" }],
    ["a picture with ../ inside", { price: 100, image: "assets/../../secret.png" }],
    ["a picture with a backslash ..", { price: 100, image: "assets\\..\\..\\secret.png" }],
    ["a picture with a NUL", { price: 100, image: "axe\u0000.png" }],
    ["a picture that reads as a flag", { price: 100, image: "--env" }],
    ["the game itself as the package", { price: 100, package: "." }],
    ["an empty model", { price: 100, model: "" }],
    ["a picture that is not text", { price: 100, image: { path: "axe.png" } }],
  ];
  for (const [name, options] of refusals) {
    it(`refuses ${name}`, () => {
      assert.equal(
        refusal({ command: "shop add", args: "Frost Axe", options }, FREE).code,
        GenexCliRefusalCode.InvalidValue,
      );
    });
  }
});

describe("other creators' shared items (`genex items`)", () => {
  it("lists and searches the game's shared items through the free tool", () => {
    assert.deepEqual(genexCliRequest({ command: "items list" }, FREE), {
      command: GenexCliCommand.ItemsList,
      argv: ["items", "list"],
      project: true,
      paid: false,
    });
    assert.deepEqual(
      genexCliRequest({ command: "items search", args: "wings", options: { tag: ["fire"] } }, FREE).argv,
      ["items", "search", "wings", "--tag", "fire"],
    );
  });

  it("adds and removes one through the paid tool, which asks the person, and moves an added item into the game", () => {
    const added = genexCliRequest({ command: "items add", args: "sku_phoenix" }, PAID);
    assert.deepEqual(added.argv, ["items", "add", "sku_phoenix"]);
    assert.equal(added.project, true);
    assert.equal(added.delivers, "sku_phoenix");
    const removed = genexCliRequest({ command: "items remove", args: "sku_phoenix" }, PAID);
    assert.deepEqual(removed.argv, ["items", "remove", "sku_phoenix"]);
    assert.equal(removed.delivers, undefined, "a removal writes nothing into the game");
    assert.equal(refusal({ command: "items add", args: "sku_phoenix" }, FREE).code, GenexCliRefusalCode.PaidTool);
    assert.equal(refusal({ command: "items list" }, PAID).code, GenexCliRefusalCode.FreeTool);
  });

  const ids: Array<[string, unknown]> = [
    ["a path", "../sku"],
    ["a folder name with a slash", "sku/../../x"],
    ["two words", "sku_1 sku_2"],
    ["a dot segment", ".."],
    ["a flag", "--force"],
    ["an id too long to be one", "s".repeat(65)],
    ["no id", ""],
  ];
  for (const [name, id] of ids) {
    it(`refuses an item id that is ${name}`, () => {
      assert.equal(refusal({ command: "items add", args: id }, PAID).code, GenexCliRefusalCode.InvalidValue);
    });
  }
});

/**
 * A native game (an Unreal game, a downloaded one) has no approval sheet of its own, so it declares
 * the AI budget its players approve on its Genex page before Play. Reading what it declares asks
 * nobody; sending or withdrawing it changes what that public page offers, so the person approves it,
 * although it spends nothing.
 */
describe("the AI budget a native game declares (`genex llm budget`)", () => {
  const budget = (action?: unknown, options?: Record<string, unknown>) => ({
    command: "llm budget",
    ...(action === undefined ? {} : { args: action }),
    ...(options ? { options } : {}),
  });

  it("reads what the game declares through the free tool, with the game's declaration beside the call", () => {
    assert.deepEqual(genexCliRequest(budget("status"), FREE), {
      command: GenexCliCommand.LlmBudget,
      argv: ["llm", "budget", "status"],
      project: true,
      paid: false,
      declaration: GameDeclaration.ModelBudget,
    });
    const refused = refusal(budget("status"), PAID);
    assert.equal(refused.code, GenexCliRefusalCode.FreeTool);
    assert.match(refused.message, /`genex llm budget status`.*genex__cli\b/);
    assert.throws(() => genexCliConsentArgs(budget("status"), PAID), GenexCliRefusal, "no card asks about a read");
  });

  for (const action of ["set", "clear"]) {
    it(`runs ${action} only through the paid tool, which asks the person, and never adds --user-approved`, () => {
      assert.deepEqual(genexCliRequest(budget(action), PAID), {
        command: GenexCliCommand.LlmBudget,
        argv: ["llm", "budget", action],
        project: true,
        paid: true,
        declaration: GameDeclaration.ModelBudget,
      });
      const refused = refusal(budget(action), FREE);
      assert.equal(refused.code, GenexCliRefusalCode.PaidTool);
      assert.match(refused.message, new RegExp(`\`genex llm budget ${action}\`.*genex__cli-paid`));
    });
  }

  const actions: Array<[string, unknown]> = [
    ["no action", undefined],
    ["an empty action", ""],
    ["blank text", "  "],
    ["an action in capitals", "SET"],
    ["two actions", "status set"],
    ["an action with a space after it", "set "],
    ["an action with a line break", "set\n--env"],
    ["a flag", "--help"],
    ["a word of its own", "raise"],
    ["a local draft's id, which is free on other rows", "local_abcdefghijkl"],
    ["a number", 1],
    ["a list", ["set"]],
    ["an inherited name", "constructor"],
  ];
  for (const [name, action] of actions) {
    it(`refuses ${name}, naming the three actions, whichever tool asked`, () => {
      for (const tool of [FREE, PAID]) {
        const refused = refusal(budget(action), tool);
        assert.equal(refused.code, GenexCliRefusalCode.InvalidValue);
        assert.match(refused.message, /status, set, clear/);
      }
    });
  }

  const options: Array<[string, Record<string, unknown>, GenexCliRefusalCode]> = [
    ["the approval flag", { "user-approved": true }, GenexCliRefusalCode.ReservedFlag],
    ["json", { json: true }, GenexCliRefusalCode.ReservedFlag],
    ["a folder to read", { dir: "../elsewhere" }, GenexCliRefusalCode.ReservedFlag],
    ["a model", { model: "genex/small" }, GenexCliRefusalCode.UnknownOption],
    ["a ceiling", { "max-credits": 5 }, GenexCliRefusalCode.UnknownOption],
    ["a file", { schema: "genex.json" }, GenexCliRefusalCode.UnknownOption],
    ["an action as an option", { set: true }, GenexCliRefusalCode.UnknownOption],
  ];
  for (const [name, given, code] of options) {
    it(`takes no options: ${name} is refused`, () => {
      assert.equal(refusal(budget("status", given), FREE).code, code);
      assert.equal(refusal(budget("set", given), PAID).code, code);
    });
  }

  it("shows the person the command and the action it asks about", () => {
    assert.deepEqual(genexCliConsentArgs(budget("set"), PAID), { command: "llm budget", args: "set" });
    const card = consentAskWords({
      pluginName: "Genex",
      tool: "genex__cli-paid",
      args: consentArgsDigest(genexCliConsentArgs(budget("clear"), PAID)),
    });
    assert.match(card, /\(command: llm budget, args: clear\)/);
  });

  it("tells an agent that asks for a command Studio does not run where the budget's commands are", () => {
    const refused = refusal({ command: "llm budgets" }, FREE);
    assert.equal(refused.code, GenexCliRefusalCode.Unavailable);
    assert.match(refused.message, /llm budget status.*genex__cli;.*llm budget set\|clear.*genex__cli-paid/);
  });
});

describe("how a game's players used its AI (`genex llm usage`)", () => {
  it("is a free read of the game's hosted project", () => {
    const request = genexCliRequest({ command: "llm usage" }, FREE);
    assert.deepEqual(request.argv, ["llm", "usage"]);
    assert.equal(request.project, true);
    assert.equal(request.paid, false);
  });
  it("takes the window in days, 1 to 90", () => {
    assert.deepEqual(genexCliRequest({ command: "llm usage", options: { days: 1 } }, FREE).argv, [
      "llm",
      "usage",
      "--days",
      "1",
    ]);
    assert.deepEqual(genexCliRequest({ command: "llm usage", options: { days: "90" } }, FREE).argv.slice(2), [
      "--days",
      "90",
    ]);
  });
  const refused: [string, Record<string, unknown>, { paid: boolean }, GenexCliRefusalCode][] = [
    ["no days", { command: "llm usage", options: { days: 0 } }, FREE, GenexCliRefusalCode.InvalidValue],
    [
      "more days than the CLI keeps",
      { command: "llm usage", options: { days: 91 } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "days that are not a number",
      { command: "llm usage", options: { days: "week" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a second flag hidden in the value",
      { command: "llm usage", options: { days: "7 --all" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "an option it does not take",
      { command: "llm usage", options: { project: "other" } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
    ],
    [
      "the output flag Studio adds itself",
      { command: "llm usage", options: { json: true } },
      FREE,
      GenexCliRefusalCode.ReservedFlag,
    ],
    ["the paid tool", { command: "llm usage" }, PAID, GenexCliRefusalCode.FreeTool],
  ];
  for (const [name, args, tool, code] of refused) {
    it(`refuses ${name}`, () => assert.equal(refusal(args, tool).code, code));
  }
  it("refuses words after the command, which it does not take", () => {
    assert.throws(() => genexCliRequest({ command: "llm usage", args: "another-game" }, FREE), GenexCliRefusal);
  });
  it("is named among the commands when an agent asks for one Studio does not run", () => {
    assert.match(refusal({ command: "llm usages" }, FREE).message, /Available:.* llm usage, /);
  });
});

describe("a game's recent AI calls, one by one (`genex llm calls`)", () => {
  it("is a free read of the game's hosted project", () => {
    const request = genexCliRequest({ command: "llm calls" }, FREE);
    assert.deepEqual(request.argv, ["llm", "calls"]);
    assert.equal(request.project, true);
    assert.equal(request.paid, false);
  });
  it("takes only the failed ones, and how many, 1 to 100", () => {
    assert.deepEqual(genexCliRequest({ command: "llm calls", options: { failed: true, limit: 100 } }, FREE).argv, [
      "llm",
      "calls",
      "--failed",
      "--limit",
      "100",
    ]);
    assert.deepEqual(genexCliRequest({ command: "llm calls", options: { failed: false, limit: "1" } }, FREE).argv, [
      "llm",
      "calls",
      "--limit",
      "1",
    ]);
  });
  const refused: [string, Record<string, unknown>, { paid: boolean }, GenexCliRefusalCode][] = [
    ["no calls", { command: "llm calls", options: { limit: 0 } }, FREE, GenexCliRefusalCode.InvalidValue],
    [
      "more calls than the CLI lists",
      { command: "llm calls", options: { limit: 101 } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a count that is not a number",
      { command: "llm calls", options: { limit: "all" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a second flag hidden in the count",
      { command: "llm calls", options: { limit: "5 --days 90" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "a failed flag that is not yes or no",
      { command: "llm calls", options: { failed: "yes --json" } },
      FREE,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "an option it does not take",
      { command: "llm calls", options: { days: 7 } },
      FREE,
      GenexCliRefusalCode.UnknownOption,
    ],
    [
      "the output flag Studio adds itself",
      { command: "llm calls", options: { json: true } },
      FREE,
      GenexCliRefusalCode.ReservedFlag,
    ],
    ["the paid tool", { command: "llm calls" }, PAID, GenexCliRefusalCode.FreeTool],
  ];
  for (const [name, args, tool, code] of refused) {
    it(`refuses ${name}`, () => assert.equal(refusal(args, tool).code, code));
  }
  it("refuses words after the command, which it does not take", () => {
    assert.equal(refusal({ command: "llm calls", args: "gen_1" }, FREE).code !== undefined, true);
    assert.throws(() => genexCliRequest({ command: "llm calls", args: "gen_1" }, FREE), GenexCliRefusal);
  });
  it("is named among the commands when an agent asks for one Studio does not run", () => {
    assert.match(refusal({ command: "llm callz" }, FREE).message, /Available:.* llm calls, /);
  });
});
