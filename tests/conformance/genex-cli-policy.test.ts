/**
 * Which Genex CLI commands an agent may run through `genex__cli` and `genex__cli-paid`, and the
 * exact argv Studio hands the pinned CLI. Everything else is a typed refusal that names what to use
 * instead; nothing here spawns anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GenexCliCommand,
  GenexCliRefusal,
  GenexCliRefusalCode,
  genexCliConsentArgs,
  genexCliRequest,
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
    ["llm price", { command: "llm price" }, FREE, GenexCliRefusalCode.Unavailable],
    ["help", { command: "help" }, FREE, GenexCliRefusalCode.Unavailable],
    ["an empty command", { command: "  " }, FREE, GenexCliRefusalCode.Unavailable],
    ["publish", { command: "publish" }, FREE, GenexCliRefusalCode.UseTool, /genex__publish/],
    ["preview", { command: "preview" }, PAID, GenexCliRefusalCode.UseTool, /genex__publish/],
    ["image", { command: "image" }, FREE, GenexCliRefusalCode.UseTool, /genex__asset/],
    ["animations", { command: "animations search", args: "run" }, FREE, GenexCliRefusalCode.UseTool, /genex__asset/],
    ["a flag in the command", { command: "doctor --json" }, FREE, GenexCliRefusalCode.Unavailable],
    [
      "a paid command through the free tool",
      { command: "llm bench", args: "hi", options: { "max-coins": 5 } },
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
      { command: "llm bench", args: "hi", options: { "max-coins": 5, "user-approved": true } },
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
      "--schema, a file in Studio's folder",
      { command: "llm bench", args: "hi", options: { "max-coins": 5, schema: "a.json" } },
      PAID,
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
      { command: "llm bench", args: "x".repeat(4001), options: { "max-coins": 5 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    ["a positional to a command without one", { command: "doctor", args: "x" }, FREE, GenexCliRefusalCode.InvalidValue],
    ["a missing positional", { command: "llm cancel" }, FREE, GenexCliRefusalCode.InvalidValue],
    [
      "max-coins 1.5",
      { command: "llm bench", args: "hi", options: { "max-coins": 1.5 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    [
      "max-coins 0",
      { command: "llm bench", args: "hi", options: { "max-coins": 0 } },
      PAID,
      GenexCliRefusalCode.InvalidValue,
    ],
    ["no max-coins", { command: "llm bench", args: "hi" }, PAID, GenexCliRefusalCode.InvalidValue],
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
  it("adds --user-approved itself to a paid bench, after the whole-number max-coins", () => {
    const request = genexCliRequest(
      { command: "llm bench", args: "Say hi", options: { "max-coins": 5, samples: 3 } },
      PAID,
    );
    assert.deepEqual(request.argv, ["llm", "bench", "Say hi", "--max-coins", "5", "--samples", "3", "--user-approved"]);
    assert.equal(request.argv.at(-1), "--user-approved");
    assert.equal(request.project, true);
    assert.equal(request.paid, true);
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
        { command: "shop add", args: "Iron Key", options: { price: 100, type: "durable", resellable: true } },
        FREE,
      ).argv,
      ["shop", "add", "Iron Key", "--price", "100", "--type", "durable", "--resellable"],
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
  const longText = `Benchmark with max-coins 5. ${"x".repeat(2100)}`;
  const rows: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      "a bench whose long prompt comes first",
      { command: "llm bench", args: longText, options: { model: "m".repeat(400), samples: 25, "max-coins": 250000 } },
      /max-coins: 250000/,
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
    const text = card({ command: "llm bench", args: longText, options: { "max-coins": 250000 } });
    assert.ok(text.indexOf("max-coins: 250000") < text.indexOf("Benchmark"), text);
  });
  it("refuses before anyone is asked when Studio would refuse the call", () => {
    assert.throws(() => genexCliConsentArgs({ command: "llm bench", args: "hi" }, PAID), GenexCliRefusal);
    assert.throws(() => genexCliConsentArgs({ command: "shop list" }, PAID), GenexCliRefusal);
  });
  it("asks nobody about a new item's draft, which spends nothing and sells nothing until the person puts it on sale", () => {
    const draft = { command: "shop add", args: "Ivory Coffin", options: { price: 300 } };
    assert.throws(() => genexCliConsentArgs(draft, PAID), GenexCliRefusal);
    assert.equal(genexCliRequest(draft, FREE).paid, false);
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
    ]);
    assert.equal(request.gamePaths, undefined, "nothing to copy from the game");
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
