import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { robloxHelperModel } from "../../scripts/build-plugins.mjs";
import { HELPER_VERSION, helperVersionOf } from "../../src/plugins/roblox/setup.ts";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const HELPER = path.join(REPO, "src/plugins/roblox/helper");

/** One `<Item>` of a Roblox XML model: its class, its properties by name and the items inside it. */
interface Item {
  className: string;
  referent: string;
  properties: Map<string, { tag: string; text: string }>;
  children: Item[];
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const decode = (text: string) => text.replace(/&(lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);

/** Where a read of a model's XML has got to. */
interface Cursor {
  xml: string;
  at: number;
}

function fail(cursor: Cursor, why: string): never {
  throw new Error(`${why} at ${cursor.at}: ${JSON.stringify(cursor.xml.slice(cursor.at, cursor.at + 40))}`);
}

function skipSpace(cursor: Cursor): void {
  while (/\s/.test(cursor.xml[cursor.at] ?? "")) cursor.at++;
}

/** An opening (or empty) tag with its quoted attributes. */
function readTag(cursor: Cursor): { name: string; attributes: Record<string, string>; empty: boolean } {
  const match = /^<([A-Za-z][\w:]*)((?:\s+[\w:]+="[^"<]*")*)\s*(\/?)>/.exec(cursor.xml.slice(cursor.at));
  if (!match) return fail(cursor, "expected a tag");
  cursor.at += match[0].length;
  const attributes: Record<string, string> = {};
  for (const pair of (match[2] ?? "").matchAll(/([\w:]+)="([^"]*)"/g))
    attributes[pair[1] as string] = decode(pair[2] ?? "");
  return { name: match[1] as string, attributes, empty: match[3] === "/" };
}

/** Reads `each` until the closing tag `name`, then that tag. */
function readUntil(cursor: Cursor, name: string, each: () => void): void {
  for (;;) {
    skipSpace(cursor);
    if (cursor.xml.startsWith(`</${name}>`, cursor.at)) {
      cursor.at += name.length + 3;
      return;
    }
    each();
  }
}

/** One CDATA section or one run of escaped text; undefined at the next tag. */
function readPiece(cursor: Cursor): string | undefined {
  const { xml, at } = cursor;
  if (xml.startsWith("<![CDATA[", at)) {
    const end = xml.indexOf("]]>", at);
    if (end < 0) fail(cursor, "an unclosed CDATA section");
    cursor.at = end + 3;
    return xml.slice(at + 9, end);
  }
  if (xml[at] === "<") return undefined;
  const next = xml.indexOf("<", at);
  if (next < 0) fail(cursor, "text past the root");
  const plain = xml.slice(at, next);
  if (/&(?!(lt|gt|amp|quot|apos);)/.test(plain)) fail(cursor, "a bare ampersand");
  cursor.at = next;
  return decode(plain);
}

function readText(cursor: Cursor): string {
  let out = "";
  for (let piece = readPiece(cursor); piece !== undefined; piece = readPiece(cursor)) out += piece;
  return out;
}

function readProperties(cursor: Cursor, item: Item): void {
  readUntil(cursor, "Properties", () => {
    const property = readTag(cursor);
    const name = property.attributes.name ?? fail(cursor, "a property without a name");
    item.properties.set(name, { tag: property.name, text: property.empty ? "" : readText(cursor) });
    if (!property.empty) readUntil(cursor, property.name, () => fail(cursor, `expected </${property.name}>`));
  });
}

function readItem(cursor: Cursor, attributes: Record<string, string>): Item {
  const item: Item = {
    className: attributes.class ?? fail(cursor, "an Item without a class"),
    referent: attributes.referent ?? fail(cursor, "an Item without a referent"),
    properties: new Map(),
    children: [],
  };
  readUntil(cursor, "Item", () => {
    const next = readTag(cursor);
    if (next.name === "Item") item.children.push(readItem(cursor, next.attributes));
    else if (next.name === "Properties") readProperties(cursor, item);
    else fail(cursor, `an unexpected <${next.name}>`);
  });
  return item;
}

/**
 * A strict reader of the XML a `.rbxmx` model is: every tag must close in order, attributes are
 * quoted, text is either escaped or one or more CDATA sections, and nothing follows the root.
 * Throws on anything else, so a model that reads is well-formed XML of that shape.
 */
function readModel(xml: string): { root: { name: string; attributes: Record<string, string> }; items: Item[] } {
  const cursor: Cursor = { xml, at: 0 };
  skipSpace(cursor);
  const root = readTag(cursor);
  const items: Item[] = [];
  readUntil(cursor, root.name, () => {
    const next = readTag(cursor);
    if (next.name !== "Item") fail(cursor, `an unexpected <${next.name}>`);
    items.push(readItem(cursor, next.attributes));
  });
  skipSpace(cursor);
  if (cursor.at !== xml.length) fail(cursor, "something after the root");
  return { root: { name: root.name, attributes: root.attributes }, items };
}

const source = (item: Item | undefined) => item?.properties.get("Source")?.text;
const nameOf = (item: Item) => item.properties.get("Name")?.text;

test("the helper builds into a readable Roblox model: the entry Script and one ModuleScript per module", async () => {
  const model = readModel(await robloxHelperModel(REPO));
  assert.equal(model.root.name, "roblox");
  assert.equal(model.root.attributes.version, "4");
  assert.equal(model.items.length, 1);
  const entry = model.items[0] as Item;
  assert.equal(entry.className, "Script");
  assert.equal(nameOf(entry), "GenexStudioHelper");
  assert.equal(entry.properties.get("Disabled")?.text, "false");
  // Enum.RunContext.Plugin, read from Studio 0.743.
  assert.equal(entry.properties.get("RunContext")?.text, "3");
  assert.equal(source(entry), await readFile(path.join(HELPER, "init.luau"), "utf8"));
  const files = (await readdir(HELPER)).filter((file) => file.endsWith(".luau") && file !== "init.luau");
  const modules = new Map(entry.children.map((child) => [nameOf(child), child]));
  assert.deepEqual(
    [...modules.keys()].sort(),
    [...files.map((file) => file.slice(0, -".luau".length)), "constants"].sort(),
  );
  for (const child of entry.children) {
    assert.equal(child.className, "ModuleScript");
    assert.deepEqual(child.children, []);
  }
  for (const file of files)
    assert.equal(
      source(modules.get(file.slice(0, -".luau".length))),
      await readFile(path.join(HELPER, file), "utf8"),
      file,
    );
  const referents = [entry, ...entry.children].map((item) => item.referent);
  assert.equal(new Set(referents).size, referents.length, "every item has its own referent");
});

test("the helper's VERSION is the plugin's helper version, and the built model carries it for Set up", async () => {
  const version = Number((await readFile(path.join(HELPER, "VERSION"), "utf8")).trim());
  assert.equal(version, HELPER_VERSION);
  assert.equal(helperVersionOf(await robloxHelperModel(REPO)), HELPER_VERSION);
});

test("two builds of the same tree are byte for byte the same", async () => {
  const first = await robloxHelperModel(REPO);
  const second = await robloxHelperModel(REPO);
  assert.equal(first, second);
});

const exec = promisify(execFile);

/** The Luau checker on PATH, or why the check is skipped. */
async function onPath(tool: string): Promise<string | undefined> {
  try {
    await exec(tool, ["--version"]);
    return undefined;
  } catch {
    return `${tool} isn't on PATH here; the helper's Luau is checked in Studio itself`;
  }
}

test("selene finds no problem in the helper's Luau", async (t) => {
  const missing = await onPath("selene");
  if (missing) return t.skip(missing);
  await exec("selene", ["--display-style", "quiet", HELPER]);
});

test("StyLua leaves the helper's Luau as it is", async (t) => {
  const missing = await onPath("stylua");
  if (missing) return t.skip(missing);
  await exec("stylua", ["--check", HELPER]);
});
