import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { isScriptPath, RunContext, ScriptClass, type ScriptRef } from "../../src/plugins/roblox/helper-protocol.ts";
import {
  decodeName,
  encodeName,
  layoutScripts,
  MAX_SCRIPT_NAME_CHARS,
  scriptFile,
  scriptKey,
  scriptRefOf,
} from "../../src/plugins/roblox/script-paths.ts";

// One fixed seed, so two runs try the same names; FC_SEED replays a reported failure.
const SEED = Number(process.env.FC_SEED ?? 1_729_017);

const module = (...path: string[]): ScriptRef => ({ path, class: ScriptClass.ModuleScript });
const server = (...path: string[]): ScriptRef => ({ path, class: ScriptClass.Script, runContext: RunContext.Legacy });
const local = (...path: string[]): ScriptRef => ({ path, class: ScriptClass.LocalScript });

/** Characters Windows refuses in a file name, beside the separators and control characters. */
const WINDOWS_UNSAFE = /[<>:"|?*\\/\u0000-\u001f\u007f]/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i;

/** Every segment of `file` is a name Windows, macOS and Linux all keep as written. */
function portable(file: string): boolean {
  return file
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        !WINDOWS_UNSAFE.test(segment) &&
        !WINDOWS_DEVICE.test(segment) &&
        !/[. ]$/.test(segment) &&
        Buffer.byteLength(segment, "utf8") <= 255,
    );
}

test("Rojo's names: Script, LocalScript, ModuleScript and a script with children", () => {
  assert.equal(scriptFile(server("ServerScriptService", "Round")), "ServerScriptService/Round.server.luau");
  assert.equal(
    scriptFile(local("StarterPlayer", "StarterPlayerScripts", "Input")),
    "StarterPlayer/StarterPlayerScripts/Input.client.luau",
  );
  assert.equal(
    scriptFile(module("ReplicatedStorage", "Shared", "Inventory")),
    "ReplicatedStorage/Shared/Inventory.luau",
  );
  assert.equal(
    scriptFile(server("ServerScriptService", "Combat"), { container: true }),
    "ServerScriptService/Combat/init.server.luau",
  );
  assert.deepEqual(scriptRefOf("ServerScriptService/Combat/init.server.luau"), server("ServerScriptService", "Combat"));
  assert.deepEqual(scriptRefOf("ReplicatedStorage/Shared/init.luau"), module("ReplicatedStorage", "Shared"));
  assert.deepEqual(scriptRefOf("ServerScriptService/Combat/Hit.luau"), module("ServerScriptService", "Combat", "Hit"));
});

test("a Script's other run contexts each have a name of their own", () => {
  for (const runContext of [RunContext.Server, RunContext.Client, RunContext.Plugin]) {
    const ref: ScriptRef = { path: ["ServerScriptService", "Main"], class: ScriptClass.Script, runContext };
    const file = scriptFile(ref);
    assert.ok(file, runContext);
    assert.deepEqual(scriptRefOf(file), ref, file);
  }
  assert.equal(
    scriptFile({ path: ["ServerScriptService", "Tool"], class: ScriptClass.Script, runContext: RunContext.Plugin }),
    "ServerScriptService/Tool.plugin.luau",
  );
});

test("files that aren't one of the game's scripts map to nothing", () => {
  for (const file of [
    "ServerScriptService/Main.lua",
    "ServerScriptService/Main.server.json",
    "Main.luau",
    "init.luau",
    "ServerScriptService/init.server.luau",
    "NotAService/Main.luau",
    "serverscriptservice/Main.luau",
    "ServerScriptService/.luau",
    "ServerScriptService/Bad%zz.luau",
    "ServerScriptService/%41.luau",
    "ServerScriptService/lower%2e.luau",
    "ServerScriptService/Main.server.luau/x",
    "",
  ])
    assert.equal(scriptRefOf(file), undefined, file);
});

test("hostile instance names map reversibly to plain portable files, or are refused", () => {
  const rows: Array<{ name: string; file?: string }> = [
    { name: "..", file: "ServerScriptService/%2E%2E.luau" },
    { name: ".", file: "ServerScriptService/%2E.luau" },
    { name: "/etc/passwd", file: "ServerScriptService/%2Fetc%2Fpasswd.luau" },
    { name: "C:\\Windows", file: "ServerScriptService/C%3A%5CWindows.luau" },
    { name: "CON", file: "ServerScriptService/%43ON.luau" },
    { name: "com1.server", file: "ServerScriptService/%63om1%2Eserver.luau" },
    { name: "a.", file: "ServerScriptService/a%2E.luau" },
    { name: "a ", file: "ServerScriptService/a%20.luau" },
    { name: "Rocket 🚀", file: "ServerScriptService/Rocket 🚀.luau" },
    { name: "100%", file: "ServerScriptService/100%25.luau" },
    { name: "tab\there", file: "ServerScriptService/tab%09here.luau" },
    { name: "nul\u0000byte", file: "ServerScriptService/nul%00byte.luau" },
    { name: "Main.server", file: "ServerScriptService/Main%2Eserver.luau" },
    { name: "init", file: "ServerScriptService/%69nit.luau" },
    { name: "Thing.luau", file: "ServerScriptService/Thing%2Eluau.luau" },
    { name: "x".repeat(300) },
    { name: "/".repeat(MAX_SCRIPT_NAME_CHARS) },
    { name: "" },
    { name: "lone \ud800 surrogate" },
  ];
  for (const { name, file } of rows) {
    const ref = module("ServerScriptService", name);
    assert.equal(scriptFile(ref), file, JSON.stringify(name));
    if (!file) continue;
    assert.ok(isScriptPath(file), file);
    assert.ok(portable(file), file);
    assert.deepEqual(scriptRefOf(file), ref, file);
  }
});

test("every name maps to a portable file and back to itself", () => {
  const name = fc.oneof(
    fc.string({ unit: "binary", minLength: 1, maxLength: 40 }),
    fc.string({
      unit: fc.constantFrom(".", " ", "%", "/", "\\", ":", "\u0000", "a", "N", "U", "L", "é"),
      minLength: 1,
    }),
    fc.constantFrom("CON", "nul", "LPT¹", "init", "x.server", "x.client", "x.plugin", "a.luau", "..", "COM3.txt"),
  );
  const ref = fc.record({
    path: fc.tuple(
      fc.constantFrom("Workspace", "ServerScriptService", "StarterGui"),
      fc.array(name, { minLength: 1, maxLength: 4 }),
    ),
    kind: fc.constantFrom(
      { class: ScriptClass.ModuleScript },
      { class: ScriptClass.LocalScript },
      { class: ScriptClass.Script, runContext: RunContext.Legacy },
      { class: ScriptClass.Script, runContext: RunContext.Server },
      { class: ScriptClass.Script, runContext: RunContext.Client },
      { class: ScriptClass.Script, runContext: RunContext.Plugin },
    ),
    container: fc.boolean(),
  });
  fc.assert(
    fc.property(ref, ({ path: [service, names], kind, container }) => {
      const script: ScriptRef = { path: [service, ...names], ...kind };
      const file = scriptFile(script, { container });
      // Every name fits once escaped while its UTF-8 is short: three bytes per escaped byte at most.
      if (file === undefined) return names.some((part) => Buffer.byteLength(part, "utf8") > 70);
      return isScriptPath(file) && portable(file) && JSON.stringify(scriptRefOf(file)) === JSON.stringify(script);
    }),
    { seed: SEED, numRuns: 2_000 },
  );
  fc.assert(
    fc.property(fc.string({ unit: "binary", minLength: 1, maxLength: 60 }), (raw) => {
      const encoded = encodeName(raw);
      return encoded === undefined || decodeName(encoded) === raw;
    }),
    { seed: SEED, numRuns: 2_000 },
  );
});

test("a name decodes only from its one spelling", () => {
  assert.equal(decodeName("Main"), "Main");
  assert.equal(decodeName("%2E%2E"), "..");
  assert.equal(decodeName("%41"), undefined, "A is never escaped");
  assert.equal(decodeName("a%2e"), undefined, "escapes are upper case");
  assert.equal(decodeName("a%"), undefined);
  assert.equal(decodeName("a%FF"), undefined, "not UTF-8");
  assert.equal(decodeName("CON"), undefined, "a device name is never written raw");
  assert.equal(decodeName("a."), undefined);
});

test("layout: a script with scripts below it becomes a folder", () => {
  const combat = server("ServerScriptService", "Combat");
  const hit = module("ServerScriptService", "Combat", "Hit");
  const layout = layoutScripts([], [hit, combat]);
  assert.equal(layout.files.get(scriptKey(combat)), "ServerScriptService/Combat/init.server.luau");
  assert.equal(layout.files.get(scriptKey(hit)), "ServerScriptService/Combat/Hit.luau");
  assert.deepEqual(layout.refused, []);
});

test("layout refuses names that differ only in letter case, in a file or a folder on the way", () => {
  const upper = module("ReplicatedStorage", "Foo");
  const lower = module("ReplicatedStorage", "foo");
  const shared = module("ReplicatedStorage", "Shared", "A");
  const sharedLower = module("ReplicatedStorage", "shared", "B");
  const layout = layoutScripts([], [lower, upper, sharedLower, shared]);
  assert.equal(layout.files.get(scriptKey(upper)), "ReplicatedStorage/Foo.luau");
  assert.equal(layout.files.get(scriptKey(shared)), "ReplicatedStorage/Shared/A.luau");
  assert.deepEqual(
    layout.refused.map((ref) => ref.path.join("/")).sort(),
    ["ReplicatedStorage/foo", "ReplicatedStorage/shared/B"],
    "macOS and Windows would put foo in Foo's file and shared/ in Shared/",
  );
});

test("layout refuses both scripts of one name: neither file could say which one it is", () => {
  const one = module("ReplicatedStorage", "Twin");
  const other = module("ReplicatedStorage", "Twin");
  const layout = layoutScripts([], [one, other]);
  assert.equal(layout.files.size, 0);
  assert.equal(layout.refused.length, 2);
});

test("layout keeps a file already on disk where it is and refuses a new one that would clash with it", () => {
  const main = server("ServerScriptService", "Main");
  const util = module("ServerScriptService", "Main", "Util");
  const clash = module("ServerScriptService", "MAIN.SERVER");
  const layout = layoutScripts(["ServerScriptService/Main.server.luau"], [main, util, clash]);
  assert.equal(layout.files.get(scriptKey(main)), "ServerScriptService/Main.server.luau", "never moved");
  assert.equal(layout.files.get(scriptKey(util)), "ServerScriptService/Main/Util.luau");
  assert.equal(layout.files.has(scriptKey(clash)), false, "MAIN.SERVER.luau is Main.server.luau on macOS");
  assert.deepEqual(layout.refused, [clash]);
});
