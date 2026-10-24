/**
 * Rust and native games' Studio words in the reader's language: the destinations, the Toolchain
 * sheet, crate requests, the native run card, export, asset import, the frame profile, the net row,
 * the Linux sandbox setup and the chat's crash line. Under a catalog that marks every message the
 * app asks for, each word these groups show (and what each of their functions says for sample
 * values) carries the mark, so none reaches a Russian or Japanese reader in English. Names Genex
 * never translates (platforms, stacks, tools, an argument's own text) need no mark. In English the
 * whole sentences read exactly as the pieces they replaced did.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { MESSAGES } from "../../src/shared/locales/messages.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";

const OPEN = "⟦";
const CLOSE = "⟧";

/** The English of a catalog key (a context, U+0004, then the English, or the English alone). */
function englishOf(key: string): string {
  return key.slice(key.indexOf("\u0004") + 1);
}

/** A catalog that says every message as its English between marks. */
const MARKED = Object.fromEntries(MESSAGES.map((key) => [key, `${OPEN}${englishOf(key)}${CLOSE}`]));

/** The word groups Rust and native games brought to Studio. */
const GROUPS = [
  "SANDBOX_SETUP_WORDS",
  "DESTINATION_WORDS",
  "TOOLCHAIN_WORDS",
  "SEED_RETAKE_WORDS",
  "CRATE_REQUEST_WORDS",
  "NATIVE_WORDS",
  "BUILD_PROBLEM_WORDS",
  "EXPORT_WORDS",
  "ASSET_REFUSAL_WORDS",
  "ASSET_IMPORT_WORDS",
  "PROFILE_WORDS",
  "NET_WORDS",
] as const;

/** Names that stay as they are in every language (docs/agent/translation.md). */
const NAMES = [
  "Apple Development: Your Name (TEAMID)",
  "Apple Distribution: Your Name (TEAMID)",
  "Bytecode Alliance",
  "Embark",
  "Zcash",
  "Google",
  "Mozilla",
  "Ubuntu",
  "Debian",
  "Fedora",
  "Rust · wgpu",
  "C++ · raylib",
  "Three.js",
  "LLVM MinGW",
  "RustSec",
  "Binaryen",
  "Zig",
  "Rust",
  "Xcode",
  "Android",
  "Windows",
  "Linux",
  "Mac",
  "iPhone",
  "bundletool",
  "Emscripten",
  "CMake",
  "Ninja",
  "raylib",
];

/** A tool or variable name written as code: `cargo-deny`, `GENEX_KEYSTORE_PASSWORD`. */
const IDENTIFIER = /^([a-z0-9]+(-[a-z0-9]+)+|[A-Z][A-Z0-9]*(_[A-Z0-9]+)+)$/;

/** A web address, which no language changes. */
const ADDRESS = /https:\/\/\S+/g;

/** Text the samples themselves put in a sentence. */
const SAMPLE_WORDS = /^(X|Y|Z|A|B|C|Pond|mac|web|windows|true|false|null|undefined|NaN)$/;

/** A name as a whole word: "Rust" in "Rust games", never inside "Trust". */
function withoutName(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
  return text.replace(new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "g"), " ");
}

/** Sample values each function in a group is called with; a shape it does not take is skipped. */
const SAMPLES: readonly (readonly unknown[])[] = [
  [],
  ["X"],
  ["X", "Y"],
  [0],
  [1],
  [2],
  [2, 1],
  [3, 3],
  [1.25, null],
  [1.25, 2.5],
  [null, null],
  [null],
  [true],
  [false],
  [["A"]],
  [["A", "B", "C"]],
  [1048576 * 85],
  ["mac"],
  ["web"],
  ["windows"],
  ["rust-wgpu"],
  ["raylib-cpp"],
];

/** What `value` shows a person: every string leaf, and every string its functions return for the samples. */
function shown(value: unknown, at: string, out: Map<string, string>): void {
  if (typeof value === "string") {
    out.set(at, value);
    return;
  }
  if (typeof value === "function") {
    for (const args of SAMPLES) {
      let result: unknown;
      try {
        result = (value as (...a: readonly unknown[]) => unknown)(...args);
      } catch {
        continue;
      }
      shown(result, `${at}(${JSON.stringify(args).slice(1, -1)})`, out);
    }
    return;
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) shown(item, `${at}.${key}`, out);
}

/** Whether `text` holds words to translate outside every marked message, once names and sample values are out. */
function untranslated(text: string): boolean {
  let depth = 0;
  let outside = "";
  for (const char of text) {
    if (char === OPEN) depth++;
    else if (char === CLOSE) depth = Math.max(0, depth - 1);
    else outside += depth === 0 ? char : " ";
  }
  const rest = NAMES.reduce(withoutName, outside).replace(ADDRESS, " ");
  const words = rest
    .split(/[\s,;:·()]+/)
    .filter((word) => !IDENTIFIER.test(word) && !SAMPLE_WORDS.test(word.replace(/\.$/, "")));
  return /[A-Za-z]{2,}/.test(words.join(" "));
}

const crashEvent = (id: number, payload: object): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "game",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data: { type: "custom", event_type: "game_crashed", payload },
});

/** Crash records and the line the chat says for each, as it read before its words were translated. */
const CRASH_LINES: readonly [object, string][] = [
  [
    { project: "Pond", kind: "panic", location: { file: "src/lib.rs", line: 1234 }, tick: 1200, repeat: 3 },
    "Pond panicked at src/lib.rs:1234 (tick 1200); the same crash in 3 runs.",
  ],
  [{ kind: "device-lost", fatal: false }, "A game lost its GPU device."],
  [{ project: "Pond", kind: "out-of-memory", tick: 5 }, "Pond ran out of memory (tick 5)."],
  [{ project: "Pond" }, "Pond crashed."],
  [{ project: "Pond", kind: "wasm-trap", repeat: 2 }, "Pond trapped in WebAssembly; the same crash in 2 runs."],
  [{ project: "Pond", kind: "hang" }, "Pond stopped answering and was ended."],
  [{ project: "Pond", kind: "gpu-validation", location: { file: "a.rs", line: 7 } }, "Pond hit a GPU error at a.rs:7."],
  [{ project: "Pond", kind: "native-fault" }, "Pond crashed with a memory fault."],
  [{ project: "Pond", kind: "process-exit" }, "Pond exited abnormally."],
];

/** The chat's line for each crash record, in the language set when the chat module loaded. */
async function crashLines(): Promise<string[]> {
  const { toEntries } = await import("../../src/renderer/chat-entries.ts");
  const entries = toEntries(CRASH_LINES.map(([payload], index) => crashEvent(index + 1, payload)));
  return entries.map((entry) => ("text" in entry && typeof entry.text === "string" ? entry.text : ""));
}

describe("Rust and native Studio words in another language", () => {
  let words: Record<string, unknown> = {};
  before(async () => {
    // The renderer loads its language before its modules, so their constants read the catalog.
    setLocale(Locale.Russian, MARKED);
    words = await import("../../src/renderer/words.ts");
  });
  after(() => setLocale(Locale.English, {}));

  for (const group of GROUPS) {
    it(`says every word of ${group} through the catalog`, () => {
      const out = new Map<string, string>();
      shown(words[group], group, out);
      assert.ok(out.size > 0, `${group} shows words`);
      const english = [...out].filter(([, text]) => untranslated(text)).map(([at, text]) => `${at}: ${text}`);
      assert.deepEqual(english, []);
    });
  }

  it("says the chat's crash line through the catalog", async () => {
    const lines = await crashLines();
    assert.equal(lines.length, CRASH_LINES.length);
    assert.deepEqual(
      lines.filter((line) => untranslated(line)),
      [],
    );
  });
});

describe("the chat's crash line in English", () => {
  it("reads as one sentence, exactly as before", async () => {
    setLocale(Locale.English, {});
    assert.deepEqual(
      await crashLines(),
      CRASH_LINES.map(([, line]) => line),
    );
  });
});
