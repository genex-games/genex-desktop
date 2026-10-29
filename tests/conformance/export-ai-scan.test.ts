/**
 * The export's AI scan (owner decision D5): an export that holds an AI vendor's key is refused
 * before anything is written where it goes, naming the file and the vendor but never the key; a
 * build that reaches a vendor's API host exports with a warning and the agent's hint to use
 * `genex-ai`. Every near miss (a key-shaped word that is not a key, a host that only looks like a
 * vendor's) passes without either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiVendor } from "../../src/shared/ai-vendors.ts";
import { scanTextForAi, EXPORT_AI_HINT, EXPORT_AI_MAX_HOSTS } from "../../src/substrate/export-ai-scan.ts";
import { exportPublicGame } from "../../src/substrate/game-export.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

// Key-shaped values are built here, never written whole into the repository.
const ANTHROPIC = `sk-ant-api03-${"A1b2C3d4".repeat(12)}`;
const OPENROUTER = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;
const OPENAI_PROJECT = `sk-proj-${"Zx9_Yw8-".repeat(6)}`;
const GOOGLE = `AIza${"S".repeat(10)}${"q1_-".repeat(6)}${"z".repeat(1)}`;

describe("scanTextForAi keys", () => {
  const hits: Array<[string, string, AiVendor]> = [
    ["an Anthropic key", `const key = "${ANTHROPIC}";`, AiVendor.Anthropic],
    ["an OpenRouter key", `headers: { Authorization: "Bearer ${OPENROUTER}" }`, AiVendor.OpenRouter],
    ["an OpenAI project key", `apiKey:'${OPENAI_PROJECT}'`, AiVendor.OpenAi],
    ["a Google AI key", `?key=${GOOGLE}&alt=json`, AiVendor.Google],
    ["a key alone on a line", ANTHROPIC, AiVendor.Anthropic],
  ];
  for (const [name, text, vendor] of hits)
    it(`finds ${name}`, () => {
      assert.deepEqual(
        scanTextForAi(text).keys.map((key) => key.vendor),
        [vendor],
      );
    });

  const nearMisses: Array<[string, string]> = [
    ["the bare Anthropic prefix in prose", "Keys start with sk-ant- and are secret."],
    ["an Anthropic key one character short", ANTHROPIC.slice(0, ANTHROPIC.length - 18)],
    ["an OpenRouter key with a short body", OPENROUTER.slice(0, -1)],
    ["an OpenRouter key with a non-hex body", `sk-or-v1-${"g".repeat(64)}`],
    ["an OpenAI project key too short", `sk-proj-${"a".repeat(39)}`],
    ["a Google key one character short", GOOGLE.slice(0, -1)],
    ["a Google key inside a longer word", `x${GOOGLE}`],
    ["an OpenAI key glued to a word before it", `token${OPENAI_PROJECT}`],
    ["a variable named for a key", "const sk_ant_api03 = loadKey();"],
    ["a CSS class that starts like one", ".sk-proj-header { color: red; }"],
  ];
  for (const [name, text] of nearMisses)
    it(`lets ${name} through`, () => {
      assert.deepEqual(scanTextForAi(text).keys, []);
    });

  it("reports where a key is without the key", () => {
    const scan = scanTextForAi(`line one\nline two ${ANTHROPIC}\n`);
    assert.deepEqual(scan.keys, [{ vendor: AiVendor.Anthropic, line: 2 }]);
    assert.equal(JSON.stringify(scan).includes(ANTHROPIC), false);
  });
});

describe("scanTextForAi hosts", () => {
  const hits: Array<[string, string, string, AiVendor]> = [
    ["an https URL", 'fetch("https://api.openai.com/v1/chat")', "api.openai.com", AiVendor.OpenAi],
    ["a websocket URL", "new WebSocket('wss://api.openai.com/v1/realtime')", "api.openai.com", AiVendor.OpenAi],
    ["a scheme-relative URL", 'src="//openrouter.ai/api/v1"', "openrouter.ai", AiVendor.OpenRouter],
    ["capitals", "HTTPS://API.ANTHROPIC.COM/v1/messages", "api.anthropic.com", AiVendor.Anthropic],
    ["a port", "http://api.x.ai:443/v1", "api.x.ai", AiVendor.Xai],
    [
      "a regional Vertex host",
      "https://us-central1-aiplatform.googleapis.com/v1/projects",
      "us-central1-aiplatform.googleapis.com",
      AiVendor.Google,
    ],
    [
      "Gemini's exact host",
      "https://generativelanguage.googleapis.com/v1beta",
      "generativelanguage.googleapis.com",
      AiVendor.Google,
    ],
    ["a trailing root dot", "https://api.groq.com./openai", "api.groq.com", AiVendor.Groq],
  ];
  for (const [name, text, host, vendor] of hits)
    it(`finds ${name}`, () => {
      assert.deepEqual(scanTextForAi(text).hosts, [{ host, vendor }]);
    });

  const nearMisses: Array<[string, string]> = [
    ["a vendor's name as another site's subdomain", "https://openai.com.evil.io/v1"],
    ["a longer name ending like a vendor's", "https://notopenai.com/"],
    ["another top-level domain", "https://api.openai.co/v1"],
    ["Gemini's host under another domain", "https://generativelanguage.googleapis.com.evil.io/"],
    ["a prefix on an exact-only host", "https://evil-generativelanguage.googleapis.com/"],
    ["a host that only ends in x.ai's letters", "https://max.ai/"],
    ["a vendor named in prose", "Made with help from openai.com and anthropic.com."],
    ["a vendor's email address", "Write to support@anthropic.com"],
    ["a property access that spells a host", "const ok = box.aiming && x.ai;"],
  ];
  for (const [name, text] of nearMisses)
    it(`lets ${name} through`, () => {
      assert.deepEqual(scanTextForAi(text).hosts, []);
    });

  it("names each host once, at most a bounded number", () => {
    const many = Array.from({ length: EXPORT_AI_MAX_HOSTS + 5 }, (_, i) => `https://h${i}.openai.com/`).join("\n");
    const twice = "https://api.openai.com/a https://api.openai.com/b";
    assert.equal(scanTextForAi(many).hosts.length, EXPORT_AI_MAX_HOSTS);
    assert.equal(scanTextForAi(twice).hosts.length, 1);
  });
});

/** A game folder with an entry page and one module holding `code`. */
async function gameWith(temp: string, code: string): Promise<string> {
  const source = path.join(temp, "game");
  await mkdir(path.join(source, "src"), { recursive: true });
  await writeFile(path.join(source, "index.html"), '<script type="module" src="./src/main.js"></script>');
  await writeFile(path.join(source, "src/main.js"), code);
  return source;
}

describe("exportPublicGame and AI vendors", () => {
  it("refuses an export holding a vendor key, names the file and vendor, and writes nothing", async () => {
    const temp = await tmpDir("studio-export-ai-");
    try {
      const source = await gameWith(temp, `const KEY = "${OPENROUTER}";`);
      const target = path.join(temp, "public");
      await assert.rejects(exportPublicGame(source, target, ["index.html", "src"]), (error: Error) => {
        assert.match(error.message, /src\/main\.js/);
        assert.match(error.message, /OpenRouter/);
        assert.equal(error.message.includes(OPENROUTER), false, "the refusal never repeats the key");
        return true;
      });
      assert.deepEqual((await readdir(temp)).sort(), ["game"], "no target and no staging folder is left");
    } finally {
      await removeTree(temp);
    }
  });

  it("refuses a key in a binary asset too", async () => {
    const temp = await tmpDir("studio-export-ai-bin-");
    try {
      const source = await gameWith(temp, 'console.log("game")');
      await mkdir(path.join(source, "assets"));
      await writeFile(
        path.join(source, "assets/blob.bin"),
        Buffer.concat([Buffer.from([0, 255, 10]), Buffer.from(GOOGLE), Buffer.from([0])]),
      );
      await assert.rejects(
        exportPublicGame(source, path.join(temp, "public"), ["index.html", "src", "assets"]),
        /Google/,
      );
    } finally {
      await removeTree(temp);
    }
  });

  it("exports a game that reaches a vendor host, with the hosts and the genex-ai hint", async () => {
    const temp = await tmpDir("studio-export-ai-host-");
    try {
      const source = await gameWith(temp, 'fetch("https://api.anthropic.com/v1/messages");');
      const result = await exportPublicGame(source, path.join(temp, "public"), ["index.html", "src"]);
      assert.deepEqual(result.aiDirect, {
        hosts: [{ file: "src/main.js", host: "api.anthropic.com", vendor: AiVendor.Anthropic }],
        hint: EXPORT_AI_HINT,
      });
      assert.match(EXPORT_AI_HINT, /genex-ai/);
    } finally {
      await removeTree(temp);
    }
  });

  it("exports near misses with no warning and no refusal", async () => {
    const temp = await tmpDir("studio-export-ai-near-");
    try {
      const source = await gameWith(
        temp,
        `// keys start with sk-ant- ; see https://notopenai.com and https://openai.com.evil.io\nconst short = "sk-proj-abc";`,
      );
      const result = await exportPublicGame(source, path.join(temp, "public"), ["index.html", "src"]);
      assert.equal(result.aiDirect, undefined);
      assert.deepEqual(result.included.sort(), ["index.html", "src/main.js"]);
    } finally {
      await removeTree(temp);
    }
  });

  it("does not scan Studio's own vendored library", async () => {
    const temp = await tmpDir("studio-export-ai-vendor-");
    try {
      const source = await gameWith(temp, 'import { REVISION } from "three"; console.log(REVISION);');
      await writeFile(
        path.join(source, "index.html"),
        `<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><script type="module" src="./src/main.js"></script>`,
      );
      const vendor = path.join(temp, "vendor");
      await mkdir(vendor);
      await writeFile(
        path.join(vendor, "three.module.js"),
        `export const REVISION = "t"; const docs = "https://api.openai.com/";`,
      );
      const result = await exportPublicGame(source, path.join(temp, "public"), ["index.html", "src"], vendor);
      assert.equal(result.aiDirect, undefined);
    } finally {
      await removeTree(temp);
    }
  });
});
