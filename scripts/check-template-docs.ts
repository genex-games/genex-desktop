import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Rust template's pages are an in-app agent's whole knowledge of the genex facade: no model was
// trained on it. This check keeps them openable and true. Every path a page names opens in the game
// folder, every anchor exists, a snippet marked `<!-- compiled: <region> -->` is byte-equal to the
// `// region: <region>` span of an example the template-examples crate compiles, and every other
// Rust snippet (and inline `Type::call(..)`) names only types, calls and imports the facade's
// crates define. It reads text only; the compile itself is that crate's cargo build.

/** The shapes this check refuses. The ids name a rule in its report. */
export const TemplateDocsRule = {
  MissingPath: "missing-path",
  MissingAnchor: "missing-anchor",
  OutsidePath: "outside-path",
  TitleReference: "title-reference",
  SnippetDrift: "snippet-drift",
  SnippetRegion: "snippet-region",
  UnknownName: "unknown-name",
} as const;
export type TemplateDocsRule = (typeof TemplateDocsRule)[keyof typeof TemplateDocsRule];

/** One refused spelling: the page, its line, the rule and the text that broke it. */
export interface TemplateDocsFinding {
  file: string;
  line: number;
  rule: TemplateDocsRule;
  text: string;
}

const TEMPLATE = "src/game-template-rust";
const CRATES = "native/genex-rust/crates";
const SEED_SKILLS = "src/harness-seed/skills";
/** The seed skills an in-app agent reads beside a Rust game folder: their paths are the folder's. */
const GAME_FOLDER_SKILLS = [
  "rust-extension-ladder.md",
  "look-dev.md",
  "asset-sourcing.md",
  "comfort.md",
  "level-plan.md",
] as const;
/** Where compiled regions live: the examples the template-examples crate builds and its tests. */
const REGION_ROOTS = [`${TEMPLATE}/docs/examples`, "native/genex-rust/examples/template-examples/tests"] as const;
/** The game folder's own top-level folders a page may name before they exist there. */
const TEMPLATE_PREFIXES = ["docs/", "web/"] as const;
/** Names a snippet may call that no facade crate defines: the language's, std's, glam's and the game's own. */
const OUTSIDE_NAMES = new Set([
  ...["Default", "Self", "Some", "Ok", "Err", "Box", "Vec", "String", "Option", "Arc", "LazyLock"],
  ...["Vec2", "Vec3", "Vec4", "Quat", "Mat3", "Mat4"],
  "World",
]);
/** Pages whose tables open with another engine's habit: their first column names calls genex lacks. */
const FOREIGN_FIRST_COLUMN = [`${TEMPLATE}/docs/examples/coming-from.md`] as const;
/** The facade modules that re-export another crate whole (Rapier): their names are that crate's. */
const REEXPORTED_MODULES = ["physics"] as const;
/**
 * The Rapier names the Physics page calls through `genex::physics` (its whole prelude): Rapier's
 * own, so the facade's sources cannot hold them; the page's compiled rows pin them instead.
 */
const RAPIER_NAMES = new Set([
  "Ball",
  "ColliderBuilder",
  "Pose",
  "QueryFilter",
  "Ray",
  "RevoluteJointBuilder",
  "RigidBodyBuilder",
  "RopeJointBuilder",
]);
/** The receivers a snippet's calls are checked on, and the facade type each one is. */
const RECEIVERS: Record<string, string> = { frame: "Frame", gfx: "Gfx", game: "Game", sim: "Sim" };

/** What the facade's crates define: public item names, functions by the type they are `impl`ed on, every fn. */
export interface FacadeIndex {
  items: Set<string>;
  methods: Map<string, Set<string>>;
  fns: Set<string>;
  /** `pub use a::Original as Alias`: each alias and the type it names. */
  aliases: Map<string, string>;
  /** The fns a `macro_rules!` implements on the type it is given, by macro name. */
  macros: Map<string, Set<string>>;
  /** `macro!(Type ..)` invocations: the type, and the macro that made it. */
  invocations: Array<[string, string]>;
}

/** Every file under `dir` whose name ends with `suffix`, skipping `tests`, `target` and dot folders. */
function filesUnder(dir: string, suffix: string, skipTests = true): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const skipped = entry.name.startsWith(".") || entry.name === "target" || (skipTests && entry.name === "tests");
      return skipped ? [] : filesUnder(full, suffix, skipTests);
    }
    return entry.name.endsWith(suffix) ? [full] : [];
  });
}

/** `text` from the brace at `open` to its match, or to the end. */
function braced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const IMPL = /\bimpl(?:<[^{]*?>)?\s+(?:[\w:<>, ']+?\s+for\s+)?(?:\w+::)*([A-Z]\w*)(?:<[^{]*?>)?\s*(?:where[^{]*)?\{/g;
const PUB_ITEM =
  /\bpub(?:\([^)]*\))?\s+(?:(?:const|async|unsafe)\s+)*(?:fn|struct|enum|trait|type|const|static|mod)\s+(\w+)/g;
const DERIVES_DEFAULT = /#\[derive\([^)]*\bDefault\b[^)]*\)\][^{;]*?\b(?:struct|enum)\s+([A-Z]\w*)/g;

/** The fn names inside `text`. */
const fnNames = (text: string): string[] => [...text.matchAll(/\bfn\s+([a-z_]\w*)/g)].map((match) => match[1] ?? "");

/** `index.methods`' set for `type`, made on first use. */
function methodsOf(index: FacadeIndex, type: string): Set<string> {
  const methods = index.methods.get(type) ?? new Set<string>();
  index.methods.set(type, methods);
  return methods;
}

/** A source's aliases, the macros that implement fns on a type they are given, and their invocations. */
function indexIndirect(index: FacadeIndex, text: string): void {
  for (const match of text.matchAll(/\b([A-Z]\w*)\s+as\s+([A-Z]\w*)\b/g))
    index.aliases.set(match[2] ?? "", match[1] ?? "");
  for (const match of text.matchAll(/\bmacro_rules!\s*(\w+)\s*\{/g)) {
    const body = braced(text, match.index + match[0].length - 1);
    if (/\bimpl\s+\$\w+/.test(body)) index.macros.set(match[1] ?? "", new Set(fnNames(body)));
  }
  for (const match of text.matchAll(/\b(\w+)!\s*[({]\s*([A-Z]\w*)/g))
    index.invocations.push([match[2] ?? "", match[1] ?? ""]);
}

/** Add one Rust source's names to `index`. */
function indexSource(index: FacadeIndex, source: string): void {
  const text = source.replace(/\/\/[^\n]*/g, "");
  indexIndirect(index, text);
  for (const match of text.matchAll(PUB_ITEM)) index.items.add(match[1] ?? "");
  for (const match of text.matchAll(/\bpub use [^;]*;/g))
    for (const name of match[0].matchAll(/\b[A-Za-z_]\w*\b/g)) index.items.add(name[0]);
  for (const name of fnNames(text)) index.fns.add(name);
  for (const match of text.matchAll(IMPL)) {
    const methods = methodsOf(index, match[1] ?? "");
    for (const name of fnNames(braced(text, match.index + match[0].length - 1))) methods.add(name);
  }
  for (const match of text.matchAll(DERIVES_DEFAULT)) methodsOf(index, match[1] ?? "").add("default");
}

/** Give each alias and each macro-made type the fns of what it names. */
function resolveIndirect(index: FacadeIndex): void {
  for (const [type, macro] of index.invocations)
    for (const name of index.macros.get(macro) ?? []) methodsOf(index, type).add(name);
  for (const [alias, original] of index.aliases) {
    const methods = index.methods.get(original);
    if (!methods) continue;
    for (const name of methods) methodsOf(index, alias).add(name);
  }
}

/** The facade's names, read from every crate's sources under `root`. */
export function facadeIndex(root: string): FacadeIndex {
  const index: FacadeIndex = {
    items: new Set(),
    methods: new Map(),
    fns: new Set(),
    aliases: new Map(),
    macros: new Map(),
    invocations: [],
  };
  for (const file of filesUnder(path.join(root, CRATES), ".rs")) indexSource(index, fs.readFileSync(file, "utf8"));
  resolveIndirect(index);
  return index;
}

/** A page to check: its repository path, its text, and the folder its game-folder paths resolve in. */
interface Page {
  file: string;
  text: string;
}

/** The pages an in-app agent reads in a Rust game folder, and the seed skills that name its paths. */
function pages(root: string): Page[] {
  const template = filesUnder(path.join(root, TEMPLATE), ".md", false);
  const skills = GAME_FOLDER_SKILLS.map((name) => path.join(root, SEED_SKILLS, name)).filter((file) =>
    fs.existsSync(file),
  );
  return [...template, ...skills].sort().map((file) => ({
    file: path.relative(root, file).split(path.sep).join("/"),
    text: fs.readFileSync(file, "utf8"),
  }));
}

/** A page's lines with fenced code blanked, so prose rules never read code (line numbers kept). */
function proseLines(text: string): string[] {
  let fence = "";
  return text.split("\n").map((line) => {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || fence === marker)) {
      fence = fence ? "" : marker;
      return "";
    }
    return fence ? "" : line;
  });
}

/** The heading anchors of a Markdown page, as a renderer spells them. */
function anchors(text: string): Set<string> {
  const slug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
  return new Set(
    proseLines(text).flatMap((line) => (/^#+\s+(.+)$/.exec(line) ? [slug(line.replace(/^#+\s+/, ""))] : [])),
  );
}

/** What a page links or names as a path, on each line: backticked paths and Markdown link targets. */
function namedPaths(line: string): string[] {
  const ticked = [...line.matchAll(/`([^`\s]+)`/g)].map((match) => match[1] ?? "");
  const linked = [...line.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => (match[1] ?? "").replace(/^<|>$/g, ""));
  return [...ticked.filter(looksLikePath), ...linked.filter((link) => !/^[a-z][a-z\d+.-]*:/i.test(link))];
}

/** Whether a backticked token is a path a reader would try to open (not a placeholder or a pattern). */
function looksLikePath(token: string): boolean {
  if (/[<>*{}$]/.test(token) || !token.includes("/")) return false;
  const outside = token.startsWith("/") || token.startsWith("../") || token.startsWith("native/");
  return outside || TEMPLATE_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/** The finding for one named path, or null when it opens (and its anchor exists) in the game folder. */
function pathFinding(root: string, page: Page, target: string): Omit<TemplateDocsFinding, "line"> | null {
  const [rel = "", anchor] = target.split("#");
  const base = page.file.startsWith(TEMPLATE) && !rel.startsWith(".") ? TEMPLATE : path.posix.dirname(page.file);
  const resolved = path.posix.normalize(path.posix.join(page.file.startsWith(SEED_SKILLS) ? TEMPLATE : base, rel));
  const escapes = rel.startsWith("/") || rel.startsWith("native/") || !`${resolved}/`.startsWith(`${TEMPLATE}/`);
  if (escapes) return { file: page.file, rule: TemplateDocsRule.OutsidePath, text: target };
  const full = path.join(root, rel ? resolved : page.file);
  if (!fs.existsSync(full)) return { file: page.file, rule: TemplateDocsRule.MissingPath, text: target };
  const hasAnchor = !anchor || !full.endsWith(".md") || anchors(fs.readFileSync(full, "utf8")).has(anchor);
  return hasAnchor ? null : { file: page.file, rule: TemplateDocsRule.MissingAnchor, text: target };
}

/** Every path, link and chapter-by-title reference on a page that does not open in the game folder. */
function checkPaths(root: string, page: Page): TemplateDocsFinding[] {
  return proseLines(page.text).flatMap((line, i) => {
    const findings: TemplateDocsFinding[] = [];
    for (const target of namedPaths(line)) {
      const finding = pathFinding(root, page, target);
      if (finding) findings.push({ ...finding, line: i + 1 });
    }
    for (const match of line.matchAll(/\(see ([A-Z][^)`]*)\)/g))
      findings.push({ file: page.file, line: i + 1, rule: TemplateDocsRule.TitleReference, text: match[0] });
    return findings;
  });
}

/** A fenced Rust snippet: its first code line, its text and the compiled region it mirrors, if any. */
interface Snippet {
  line: number;
  code: string;
  region: string | null;
}

/** The page's ```rust blocks, each with the `<!-- compiled: .. -->` marker on the line before it. */
function snippets(text: string): Snippet[] {
  const lines = text.split("\n");
  const found: Snippet[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```rust\s*$/.test(lines[i] ?? "")) continue;
    const end = lines.findIndex((line, j) => j > i && /^\s*```\s*$/.test(line));
    const close = end < 0 ? lines.length : end;
    const region = /<!--\s*compiled:\s*(\S+)\s*-->/.exec(lines[i - 1] ?? "")?.[1] ?? null;
    found.push({ line: i + 2, code: lines.slice(i + 1, close).join("\n"), region });
    i = close;
  }
  return found;
}

/** `code` with its common indentation removed and trailing blanks trimmed: how a snippet is compared. */
function dedent(code: string): string {
  const lines = code.replace(/\s+$/, "").split("\n");
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join("\n");
}

/** Every `// region: <name>` span of the compiled sources, dedented, by name. */
export function compiledRegions(root: string): Map<string, string> {
  const regions = new Map<string, string>();
  for (const file of REGION_ROOTS.flatMap((dir) => filesUnder(path.join(root, dir), ".rs", false))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/^[ \t]*\/\/ region: (\S+)[ \t]*\n([\s\S]*?)^[ \t]*\/\/ endregion\b/gm))
      regions.set(match[1] ?? "", dedent(match[2] ?? ""));
  }
  return regions;
}

/** The names a snippet defines or imports from a re-exported crate, which the facade need not define. */
function ownNames(code: string): Set<string> {
  const own = new Set([...OUTSIDE_NAMES, ...RAPIER_NAMES]);
  for (const match of code.matchAll(/\b(?:struct|enum|trait|type|for)\s+([A-Z]\w*)/g)) own.add(match[1] ?? "");
  for (const module of REEXPORTED_MODULES)
    for (const match of code.matchAll(new RegExp(`\\buse\\s+genex::${module}::([^;]+);`, "g")))
      for (const name of (match[1] ?? "").matchAll(/\b[A-Z]\w*\b/g)) own.add(name[0]);
  return own;
}

/** The unknown names in one line of Rust: `Type::call(`, a checked receiver's call, a `.with_*(` builder. */
function unknownNames(index: FacadeIndex, line: string, own: Set<string>): string[] {
  const code = line.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const unknown: string[] = [];
  for (const [call, type = "", name = ""] of code.matchAll(/\b([A-Z]\w*)::([a-z_]\w*)\s*[(<]/g)) {
    // A one-letter type is a generic parameter (`W::default()`), the caller's own.
    if (own.has(type) || type.length === 1) continue;
    const known = index.methods.get(type)?.has(name) ?? false;
    if (!known) unknown.push(call);
  }
  for (const [call, receiver = "", name = ""] of code.matchAll(/(?<![\w.])(frame|gfx|game|sim)\.([a-z_]\w*)\s*\(/g))
    if (!index.methods.get(RECEIVERS[receiver] ?? "")?.has(name)) unknown.push(call);
  for (const [call, name = ""] of code.matchAll(/\.(with_\w+)\s*\(/g)) if (!index.fns.has(name)) unknown.push(call);
  return unknown;
}

/** The unknown imports of a snippet's `use genex::..;` lines (a re-exported crate's names are its own). */
function unknownImports(index: FacadeIndex, line: string): string[] {
  const use = /^\s*use\s+genex::([^;]+);/.exec(line)?.[1];
  if (!use || REEXPORTED_MODULES.some((module) => use.startsWith(`${module}::`))) return [];
  const names = [...use.matchAll(/\b[A-Za-z_]\w*\b/g)].map((match) => match[0]);
  return names.filter((name) => !["self", "as", "prelude"].includes(name) && !index.items.has(name));
}

/** A drifted or regionless compiled snippet, or the unknown names of an uncompiled one. */
function checkSnippet(page: Page, snippet: Snippet, index: FacadeIndex, regions: Map<string, string>) {
  const at = (rule: TemplateDocsRule, text: string, offset = 0): TemplateDocsFinding => ({
    file: page.file,
    line: snippet.line + offset,
    rule,
    text,
  });
  if (snippet.region) {
    const compiled = regions.get(snippet.region);
    if (compiled === undefined) return [at(TemplateDocsRule.SnippetRegion, snippet.region)];
    return compiled === dedent(snippet.code) ? [] : [at(TemplateDocsRule.SnippetDrift, snippet.region)];
  }
  const own = ownNames(snippet.code);
  return snippet.code
    .split("\n")
    .flatMap((line, i) =>
      [...unknownNames(index, line, own), ...unknownImports(index, line)].map((name) =>
        at(TemplateDocsRule.UnknownName, name, i),
      ),
    );
}

/** A prose line as the inline check reads it: a habit table's first cell is another engine's. */
function genexPart(page: Page, line: string): string {
  const foreign = (FOREIGN_FIRST_COLUMN as readonly string[]).includes(page.file) && line.startsWith("|");
  return foreign ? line.split("|").slice(2).join("|") : line;
}

/** The unknown `Type::call(..)` names in a page's inline code. */
function checkInline(page: Page, index: FacadeIndex): TemplateDocsFinding[] {
  return proseLines(page.text).flatMap((line, i) =>
    [...genexPart(page, line).matchAll(/`([^`]+)`/g)].flatMap((match) =>
      unknownNames(index, match[1] ?? "", new Set([...OUTSIDE_NAMES, ...RAPIER_NAMES]))
        .filter((name) => name.includes("::"))
        .map((name) => ({ file: page.file, line: i + 1, rule: TemplateDocsRule.UnknownName, text: name })),
    ),
  );
}

/** Every finding over the Rust template's pages and the seed skills that name its paths. */
export function checkTemplateDocs(repoRoot: string): TemplateDocsFinding[] {
  const root = path.resolve(repoRoot);
  const index = facadeIndex(root);
  const regions = compiledRegions(root);
  return pages(root).flatMap((page) => [
    ...checkPaths(root, page),
    ...snippets(page.text).flatMap((snippet) => checkSnippet(page, snippet, index, regions)),
    ...checkInline(page, index),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = checkTemplateDocs(process.cwd());
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule} ${finding.text}`);
    process.exitCode = 1;
  } else console.log("Rust template docs: paths, anchors, compiled snippets and facade names pass.");
}
