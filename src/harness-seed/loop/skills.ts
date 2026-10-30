/**
 * Skills — PLAN.md §5.4, §8.2.
 *
 * A skill is a markdown file with YAML-ish frontmatter (`name`, `description`). The index (name +
 * description) is injected into every prompt; bodies are fetched on demand by the `read_skill`
 * tool. These files are also **the parameters SkillOpt trains**: the outer loop edits them with
 * bounded string operations and keeps an edit only if it provably helps.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PROTECTED_MARKER = "<!-- SLOW_UPDATE -->";

/** A skill file as parsed: its frontmatter, its body and the text it came from. */
export interface ParsedSkill {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

/** A skill in the workspace: parsed, and where it lives. */
export interface Skill extends ParsedSkill {
  file: string;
  slug: string;
}

/** One of SkillOpt's four bounded edits. */
export interface SkillEdit {
  op: string;
  anchor?: string;
  text?: string;
  [field: string]: unknown;
}

export async function loadSkills(workspace: string): Promise<Skill[]> {
  const dir = path.join(workspace, "skills");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    // `<slug>.best.md` is SkillOpt's archive copy of the last accepted version — history, not a
    // second live skill. Loading it doubled every optimised skill in the prompt (and would have
    // made the next pass optimise the archive as its own skill).
    if (entry.name.endsWith(".best.md")) continue;
    const file = path.join(dir, entry.name);
    const text = await readFile(file, "utf8");
    skills.push({ ...parseSkill(text), file, slug: entry.name.replace(/\.md$/, "") });
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function parseSkill(text: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta: Record<string, string> = {};
  let body = text;
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1]!.split("\n")) {
      const kv = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return {
    name: meta.name ?? "unnamed",
    description: meta.description ?? "",
    frontmatter: meta,
    body: body.trim(),
    raw: text,
  };
}

export function formatSkillIndex(skills: ReadonlyArray<Pick<Skill, "name" | "slug" | "description">>): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => `- **${skill.name}** (${skill.slug}): ${skill.description}`);
  return [
    "## Your skills",
    "Reference notes you may read with `read_skill` when one helps; none is required.",
    ...lines,
  ].join("\n");
}

export async function readSkill(workspace: string, slug: string): Promise<string> {
  const file = path.join(workspace, "skills", `${slug}.md`);
  return readFile(file, "utf8");
}

export async function writeSkill(workspace: string, slug: string, contents: string): Promise<string> {
  const file = path.join(workspace, "skills", `${slug}.md`);
  await writeFile(file, contents);
  return file;
}

/**
 * The four bounded edit operations SkillOpt is allowed to make (`skillopt/optimizer/skill.py`).
 * String-anchored rather than line-numbered, so an edit either matches or is rejected — it can
 * never land in the wrong place after the file has drifted.
 */
export function applyEdits<E extends SkillEdit>(
  text: string,
  edits: readonly E[],
): { text: string; applied: E[]; rejected: Array<{ edit: E; reason: string }> } {
  let out = text;
  const applied: E[] = [];
  const rejected: Array<{ edit: E; reason: string }> = [];
  for (const edit of edits) {
    const protectedRegion = protectedSpan(out);
    const result = applyOne(out, edit, protectedRegion);
    if (result.ok) {
      out = result.text!;
      applied.push(edit);
    } else {
      rejected.push({ edit, reason: result.reason! });
    }
  }
  return { text: out, applied, rejected };
}

function protectedSpan(text: string): { start: number; end: number } | null {
  const start = text.indexOf(PROTECTED_MARKER);
  if (start < 0) return null;
  const end = text.indexOf(PROTECTED_MARKER, start + PROTECTED_MARKER.length);
  return end < 0 ? { start, end: text.length } : { start, end: end + PROTECTED_MARKER.length };
}

function overlapsProtected(index: number, length: number, span: { start: number; end: number } | null): boolean {
  if (!span || index < 0) return false;
  return index < span.end && index + length > span.start;
}

/** A skill's protected region, as offsets into its text. */
type Span = { start: number; end: number } | null;
/** One edit applied to a skill's text: the new text, or why it was refused. */
type EditResult = { ok: boolean; text?: string; reason?: string };

/** The ops that find their place by an anchor in the text. */
const ANCHORED_OPS: readonly string[] = ["insert_after", "replace", "delete"];

function applyOne(text: string, edit: SkillEdit, span: Span): EditResult {
  // An empty anchor matches at offset 0: an `insert_after` without one landed above the
  // frontmatter, and the skill silently lost its name and its `trainable` flag.
  const anchored = typeof edit.anchor === "string" && edit.anchor.trim();
  if (ANCHORED_OPS.includes(edit.op) && !anchored) return { ok: false, reason: `${edit.op} needs an anchor` };
  const apply = Object.hasOwn(EDIT_OPS, edit.op) ? EDIT_OPS[edit.op] : undefined;
  if (!apply) return { ok: false, reason: `unknown op: ${edit.op}` };
  return apply(text, edit, span);
}

/** Put `replacement` where the edit's anchor is, unless the anchor is missing or protected. */
function spliceAnchor(text: string, edit: SkillEdit, span: Span, replacement: string, verb: string): EditResult {
  const anchor = edit.anchor ?? "";
  const index = text.indexOf(anchor);
  if (index < 0) return { ok: false, reason: `anchor not found: ${edit.anchor}` };
  if (overlapsProtected(index, anchor.length, span)) {
    return { ok: false, reason: `cannot ${verb} inside a protected region` };
  }
  return { ok: true, text: text.slice(0, index) + replacement + text.slice(index + anchor.length) };
}

/** How each op changes a skill's text. */
const EDIT_OPS: Record<string, (text: string, edit: SkillEdit, span: Span) => EditResult> = {
  append(text, edit) {
    if (!edit.text) return { ok: false, reason: "append needs text" };
    return { ok: true, text: `${text.replace(/\s*$/, "")}\n${edit.text}\n` };
  },
  insert_after(text, edit, span) {
    const index = text.indexOf(edit.anchor ?? "");
    if (index < 0) return { ok: false, reason: `anchor not found: ${edit.anchor}` };
    const at = index + (edit.anchor ?? "").length;
    if (overlapsProtected(at, 0, span)) return { ok: false, reason: "anchor is inside a protected region" };
    return { ok: true, text: `${text.slice(0, at)}\n${edit.text}${text.slice(at)}` };
  },
  replace: (text, edit, span) => spliceAnchor(text, edit, span, edit.text ?? "", "replace"),
  delete: (text, edit, span) => spliceAnchor(text, edit, span, "", "delete"),
};
