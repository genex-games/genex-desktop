import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { maintained } from "./studio-dev/files.mjs";

export interface Area {
  id: string;
  sources: string[];
  documents: string[];
  commands: string[];
}
export interface KnowledgeMap {
  version: 2;
  localOnly: string[];
  areas: Area[];
}
export const HANDBOOK_LIMITS = { overview: 500, topic: 800, total: 4000, topics: 8 } as const;
const overview = "docs/agent/context.md";
const topics = "docs/product";
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string" && !!v.trim());
export function matches(file: string, glob: string): boolean {
  // ** skips dotfiles; ownership of a folder includes its hidden inputs.
  return path.matchesGlob(file, glob) || (glob.endsWith("/**") && file.startsWith(glob.slice(0, -2)));
}
export function readKnowledgeMap(root: string): KnowledgeMap {
  const map = JSON.parse(fs.readFileSync(path.join(root, "docs/agent/knowledge-map.json"), "utf8"));
  if (map.version !== 2 || !strings(map.localOnly) || !Array.isArray(map.areas))
    throw new Error("knowledge map: unsupported schema/version");
  const ids = new Set<string>();
  for (const area of map.areas) {
    if (
      !area ||
      !/^[a-z][a-z0-9-]*$/.test(area.id) ||
      ids.has(area.id) ||
      !["sources", "documents", "commands"].every((k) => strings(area[k]))
    )
      throw new Error("knowledge map: invalid/duplicate area schema");
    if ("review" in area)
      throw new Error(`${area.id}: remove generated review fingerprints; record documentation review in the PR`);
    ids.add(area.id);
  }
  return map;
}
function headings(file: string): string[] {
  const prose = fs.readFileSync(file, "utf8").replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
  return [...prose.matchAll(/^#+\s+(.+)$/gm)].map((m) =>
    m[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-"),
  );
}
/** The product pages in the handbook's folder; anything that is not a Markdown page is an error. */
function handbookPages(root: string, errors: string[]): string[] {
  const folder = path.join(root, topics);
  if (!fs.existsSync(folder)) {
    errors.push(`handbook: missing ${topics}`);
    return [];
  }
  const pages: string[] = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) pages.push(`${topics}/${entry.name}`);
    else
      errors.push(
        `handbook: ${topics}/${entry.name} must be a Markdown page; keep evidence and technical assets elsewhere`,
      );
  }
  return pages;
}

/** One handbook page against its limit, and linked from the overview; returns its size. */
function checkPage(root: string, file: string, overviewText: string, errors: string[]) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    errors.push(`handbook: missing ${file}`);
    return { words: 0, bytes: 0 };
  }
  const text = fs.readFileSync(absolute, "utf8");
  const words = text.match(/\S+/g)?.length ?? 0;
  const bytes = Buffer.byteLength(text);
  const limit = file === overview ? HANDBOOK_LIMITS.overview : HANDBOOK_LIMITS.topic;
  if (words > limit || bytes > limit * 16)
    errors.push(
      `handbook: ${file} uses ${words} words / ${bytes} bytes; limit ${limit} words / ${limit * 16} bytes. Replace, shorten or reorganize existing content; do not append task history.`,
    );
  const link = `../product/${path.basename(file)}`;
  if (file !== overview && !overviewText.includes(`](${link})`)) errors.push(`handbook: link ${file} from ${overview}`);
  return { words, bytes };
}

/** Bound the normal reading layer, including new pages that have not been added to the map. */
export function checkHandbook(root: string): string[] {
  const errors: string[] = [];
  let totalWords = 0;
  let totalBytes = 0;
  const overviewFile = path.join(root, overview);
  const overviewText = fs.existsSync(overviewFile) ? fs.readFileSync(overviewFile, "utf8") : "";
  const pages = handbookPages(root, errors);
  if (!pages.length) errors.push("handbook: at least one product page is required");
  if (pages.length > HANDBOOK_LIMITS.topics)
    errors.push(`handbook: ${pages.length} product pages exceed ${HANDBOOK_LIMITS.topics}; combine overlapping topics`);
  for (const file of [overview, ...pages]) {
    const { words, bytes } = checkPage(root, file, overviewText, errors);
    totalWords += words;
    totalBytes += bytes;
  }
  if (totalWords > HANDBOOK_LIMITS.total || totalBytes > HANDBOOK_LIMITS.total * 16)
    errors.push(
      `handbook: total ${totalWords} words / ${totalBytes} bytes exceeds ${HANDBOOK_LIMITS.total} words / ${HANDBOOK_LIMITS.total * 16} bytes; splitting files does not increase the shared budget`,
    );
  return errors;
}
/** Words one `docs/agent` reference page may hold: a current reference someone can read, not a log. */
export const REFERENCE_WORD_LIMIT = 12_000;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
/** A heading that dates its section: `(2026-09-22)`, `(17 September)`, `(16 September continuation)`. */
const DATED_HEADING = new RegExp(`\\((?:[^)]*\\b\\d{4}-\\d{2}-\\d{2}\\b|\\d{1,2} (?:${MONTHS})\\b)[^)]*\\)`);
/** `docs/agent/*.md` describe the code as it is: no dated headings (history belongs in the PR), bounded size. */
export function checkReferences(root: string): string[] {
  const errors: string[] = [];
  const folder = path.join(root, "docs/agent");
  if (!fs.existsSync(folder)) return errors;
  for (const name of fs
    .readdirSync(folder)
    .filter((n) => n.endsWith(".md"))
    .sort()) {
    const file = `docs/agent/${name}`;
    const text = fs.readFileSync(path.join(folder, name), "utf8");
    const prose = text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
    for (const match of prose.matchAll(/^#+\s+(.+)$/gm)) {
      if (DATED_HEADING.test(match[1]!))
        errors.push(`${file}: dated heading "${match[1]}"; describe current behavior and drop the date`);
    }
    const words = text.match(/\S+/g)?.length ?? 0;
    if (words > REFERENCE_WORD_LIMIT)
      errors.push(
        `${file} uses ${words} words; limit ${REFERENCE_WORD_LIMIT}. Replace or shorten outdated sections instead of appending.`,
      );
  }
  return errors;
}
/** Folders whose tracked files must not cite a gitignored document: a reader of the code cannot open it. */
export const CITATION_ROOTS = ["src/", "scripts/", "tests/"] as const;
/**
 * Shipped payload is compared byte for byte by the seed upgrade, so even a comment edit there
 * refreshes (or backs up) every install's copy. Old citations in it are cleaned up only alongside
 * a deliberate seed change, never by this check. `tests/fixtures/shipped/` holds byte-for-byte
 * copies of files the studio once shipped, which an upgrade recognises by digest: editing one
 * would make it a copy nobody shipped.
 */
export const CITATION_EXEMPT = [
  "src/harness-seed/",
  "src/game-template/",
  "src/harness-boot/",
  "tests/fixtures/shipped/",
] as const;
const citationAllowed = new Set(["docs/agent/knowledge-map.json", ".gitignore"]);
/**
 * Tracked files under CITATION_ROOTS that name a local-only Markdown document. A document is a
 * localOnly entry without wildcards; its full path always counts, and its bare file name counts
 * unless a tracked file shares it (a generic README.md is not a citation of a local one).
 */
export function localCitations(root: string, localOnly: string[], tracked: string[]): string[] {
  const basenames = new Set(tracked.map((file) => path.posix.basename(file)));
  const names = new Set<string>();
  for (const entry of localOnly) {
    if (/[*?[{]/.test(entry) || !entry.endsWith(".md")) continue;
    names.add(entry);
    if (!basenames.has(path.posix.basename(entry))) names.add(path.posix.basename(entry));
  }
  if (!names.size) return [];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Name boundaries: a local NOTES.md is not cited by a maintained TEAM-NOTES.md.
  const pattern = new RegExp(
    `(?<![\\w-])(${[...names]
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|")})(?![\\w-])`,
    "g",
  );
  const errors: string[] = [];
  for (const file of tracked) {
    if (
      citationAllowed.has(file) ||
      !CITATION_ROOTS.some((dir) => file.startsWith(dir)) ||
      CITATION_EXEMPT.some((dir) => file.startsWith(dir))
    )
      continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    } // staged deletion
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => {
      for (const match of line.matchAll(pattern))
        errors.push(
          `${file}:${i + 1}: cites local-only document ${match[1]}; state the rule or link a maintained doc instead`,
        );
    });
  }
  return errors;
}
/** What checking the handbook's links needs: where it is, what is local-only, and what it found. */
interface LinkCheck {
  root: string;
  errors: string[];
  localOnly: (file: string) => boolean;
  /** Maintained documents reached so far; each is checked for its own links once. */
  documents: Set<string>;
}

/** A link must stay in the repo, avoid local-only files, resolve, and name a heading that exists. */
function checkLink(check: LinkCheck, from: string, link: string, base: string): void {
  const [target, anchor] = link.replace(/^<|>$/g, "").split("#");
  const dest = target ? path.resolve(base, target) : path.join(check.root, from);
  const relative = path.relative(check.root, dest).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative) || check.localOnly(relative)) {
    check.errors.push(`${from}: unsafe/local-only document link ${link}`);
    return;
  }
  if (!fs.existsSync(dest)) {
    check.errors.push(`${from}: broken local link ${link}`);
    return;
  }
  if (!dest.endsWith(".md") || !fs.statSync(dest).isFile()) return;
  if (anchor && !headings(dest).includes(anchor)) check.errors.push(`${from}: broken local anchor ${link}`);
  // Check reachable maintained docs once. Historical evidence is never a prerequisite.
  check.documents.add(relative);
}

/** Every area's commands exist and its documents are safe, working links. */
function checkAreas(check: LinkCheck, map: KnowledgeMap, scripts: Record<string, unknown>): void {
  for (const area of map.areas) {
    for (const command of area.commands)
      if (!scripts[command]) check.errors.push(`${area.id}: unknown command ${command}`);
    for (const link of area.documents) {
      if (path.isAbsolute(link) || link.split("/").includes(".."))
        check.errors.push(`${area.id}: unsafe document ${link}`);
      else checkLink(check, area.id, link, check.root);
    }
  }
}

/** The local links inside every document reached so far (and those they reach in turn). */
function checkDocumentLinks(check: LinkCheck): void {
  for (const document of check.documents) {
    const prose = fs
      .readFileSync(path.join(check.root, document), "utf8")
      .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = (match[1] ?? "").replace(/^<|>$/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
      checkLink(check, document, link, path.dirname(path.join(check.root, document)));
    }
  }
}

// Inspect the index so staged removals pass and force-added artifacts fail, including in CI.
function checkGitIndex(check: LinkCheck, map: KnowledgeMap): void {
  if (!fs.existsSync(path.join(check.root, ".git"))) return;
  try {
    const tracked = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: check.root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    for (const file of tracked) if (check.localOnly(file)) check.errors.push(`local artifact in Git index: ${file}`);
    check.errors.push(...localCitations(check.root, map.localOnly, tracked));
  } catch (error) {
    check.errors.push(`cannot check Git artifact policy: ${(error as Error).message}`);
  }
}

export function checkContext(repoRoot: string): string[] {
  const root = path.resolve(repoRoot);
  const errors: string[] = [];
  let map: KnowledgeMap;
  try {
    map = readKnowledgeMap(root);
  } catch (error) {
    return [(error as Error).message];
  }
  errors.push(...checkHandbook(root), ...checkReferences(root));
  const scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {};
  const check: LinkCheck = {
    root,
    errors,
    localOnly: (file: string) => map.localOnly.some((glob) => matches(file, glob)),
    documents: new Set<string>(fs.existsSync(path.join(root, overview)) ? [overview] : []),
  };
  checkAreas(check, map, scripts);
  checkDocumentLinks(check);
  for (const file of maintained(root)) {
    if (!map.areas.some((area) => area.sources.some((glob) => matches(file, glob))))
      errors.push(`unmapped maintained input: ${file}`);
  }
  checkGitIndex(check, map);
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkContext(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      "Agent context: handbook size, links, commands, ownership and artifact policy pass. Prose accuracy still needs review.",
    );
}
