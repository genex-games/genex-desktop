/**
 * File ownership for a facet. The one rule, shared by the edit-time
 * hook (Claude Code `PreToolUse`, which blocks a stray Write before it lands) and the after-
 * the-fact code review (`harness-seed/loop/review.ts`, which stays advisory once the hook
 * exists). A facet may touch its own modules, its notes, the studio scratch folder, and —
 * when it does not own `src/main.js` — that file only for its wiring line.
 *
 * The rule has two readings, because a worker builds in one of two worlds (M4.6). Inside the
 * studio's own template a facet is a module under `src/` and the entry carries a FACET WIRING
 * block every builder adds one line to. In a game the user brought there is no wiring block,
 * `src/` may hold nothing, and the entry is the game's own: the worker is given a SEAM — a
 * path, a folder or a glob — and everything else is somebody's existing code. `template` is
 * the one flag that says which world this is, and it is read as `template !== false`, so an
 * ownership object written before this rule existed keeps the behaviour it had.
 */
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { toPosixRelative } from "./paths.ts";

export interface OwnershipSpec {
  id: string;
  owns?: string[];
  /** The game's real entry module (default src/main.js) — a project with its own shape names its own. */
  main?: string;
  /** The contract module (default src/studio.js). */
  studio?: string;
  /**
   * Is this the studio's own template? Absent means yes. `false` for a game the user brought:
   * no FACET WIRING pass-through on the entry, no id-substring escape hatch, and a worker with
   * no seam owns the repository minus the entry, the contract and the page.
   */
  template?: boolean;
}

export interface Ownership {
  facetId: string;
  owns: string[];
  ownsMain: boolean;
  main?: string;
  studio?: string;
  /** False for a game the user brought — see `OwnershipSpec.template`. */
  template?: boolean;
  /**
   * Directory prefixes (or exact paths) the Codex locks must never make read-only, on top of
   * the ones every game has. The build output of a shape the studio serves from a subfolder
   * belongs here: locking it turns `npm run build` into a permissions error nobody can read.
   */
  neverLock?: string[];
}

/** The two files the rule singles out, for this project's shape. */
export function entryFiles(spec: { main?: string; studio?: string }): { main: string; studio: string } {
  return { main: spec.main ?? "src/main.js", studio: spec.studio ?? "src/studio.js" };
}

/** `src/studio.js` → `src/studio.d.ts`: the contract module's types, wherever it lives. */
function declarationFor(studio: string): string {
  return studio.replace(/\.[cm]?js$/, ".d.ts");
}

/** `src/studio.js` → `src/hud.js`: the contract's HUD module, beside it (M4.2a). */
function hudFor(studio: string): string {
  const at = studio.lastIndexOf("/");
  return at < 0 ? "hud.js" : `${studio.slice(0, at + 1)}hud.js`;
}

/** `tsconfig.json` and the files it references (`tsconfig.app.json`, `tsconfig.node.json`). */
function isTypeConfig(file: string): boolean {
  return /^tsconfig(\.[\w-]+)?\.json$/.test(file);
}

/**
 * Does `file` fall inside one `owns` entry? A seam with no `*` or `?` keeps the rule the
 * template has always had — the exact path, or anything under it as a directory. A seam with
 * either metacharacter is a glob: `*` and `?` stop at a slash, `**` crosses them. This body is
 * duplicated in `harness-seed/loop/review.ts`; `tests/conformance/harness-incidents.test.ts`
 * drives every case through both copies so they cannot drift.
 */
export function ownMatches(file: string, own: string): boolean {
  const pattern = String(own ?? "").trim();
  const target = String(file ?? "");
  if (!pattern || !target) return false;
  if (!/[*?]/.test(pattern)) return target === pattern || target.startsWith(pattern.replace(/\/?$/, "/"));
  return globRegExp(pattern).test(target);
}

/** `src/**\/*.ts` → a RegExp. `**` crosses slashes; `*` and `?` do not. */
function globRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches nothing at all, so `src/**/*.ts` covers `src/a.ts`.
        if (pattern[i + 2] === "/") {
          source += "(?:[^\\0]*\\/)?";
          i += 2;
        } else {
          source += "[^\\0]*";
          i += 1;
        }
      } else source += "[^/]*";
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The spec the rule reads, from the ownership a delegation carries. */
export function specOf(ownership: Ownership): OwnershipSpec {
  return {
    id: ownership.facetId,
    owns: ownership.owns,
    ...(ownership.main ? { main: ownership.main } : {}),
    ...(ownership.studio ? { studio: ownership.studio } : {}),
    ...(ownership.template === false ? { template: false } : {}),
  };
}

/** Files any facet may write: its own notes, the studio's scratch and the asset folders. */
function isSharedFile(file: string, spec: OwnershipSpec): boolean {
  // `loop/repo.ts facetNotes` — a builder's notes live in docs/notes/, out of the game's root.
  if (file === `docs/notes/NOTES.${spec.id}.md` || file === "NOTES.md") return true;
  if (file.startsWith(".studio/")) return true;
  // Assets (AG-930): any facet may write the Blender script that models its own objects;
  // `assets/<name>.glb` is written by the studio, never by a builder.
  if (file === "assets" || file.startsWith("assets/")) return true;
  // A bundled game serves `public/` from its output root: the same assets live there.
  return file === "public/assets" || file.startsWith("public/assets/");
}

/** Files that belong to whoever owns the entry: the entry, the contract and its companions, the page. */
function isEntryOwnersFile(file: string, entry: ReturnType<typeof entryFiles>): boolean {
  // The contract's declaration and the compiler config belong to whoever owns the entry: a
  // TypeScript game whose build is `tsc -b && vite build` cannot import ./studio.js until they
  // agree, and the brief that tells the builder to fix that must not also forbid the edit.
  if (file === declarationFor(entry.studio) || isTypeConfig(file)) return true;
  return file === entry.main || file === entry.studio || file === hudFor(entry.studio) || file === "index.html";
}

/**
 * A worker with no seam in somebody's own game: everything except the entry, the contract,
 * its declaration and the page. Wider than the template's `src/` on purpose — the game's
 * code is not under src/ — and the reason `worker_start` refuses to start a second one.
 */
function outsideEntry(file: string, entry: ReturnType<typeof entryFiles>): boolean {
  const reserved = [entry.main, entry.studio, declarationFor(entry.studio), hudFor(entry.studio), "index.html"];
  return !reserved.includes(file);
}

export function allowedFile(file: string, spec: OwnershipSpec, ownsMain: boolean): boolean {
  if (!file) return true;
  // Absent means the studio's template: every ownership object written before M4.6 keeps the
  // behaviour it had, and only a caller that says so gets the own-shape rule.
  const template = spec.template !== false;
  const entry = entryFiles(spec);
  if (isSharedFile(file, spec)) return true;
  if (ownsMain && isEntryOwnersFile(file, entry)) return true;
  // The FACET WIRING block — reviewed by content. There is no such block in a game the user
  // brought, so a worker that does not own the entry there does not get to open it at all.
  if (template && file === entry.main) return true;
  if (spec.owns?.length) {
    // `file.includes(spec.id)` is the template's escape hatch for a facet whose modules grew
    // past what the planner named. In a real repository it is a trap: a worker called "core"
    // would own src/scoreboard.ts by spelling.
    return spec.owns.some((own) => ownMatches(file, own)) || (template && file.includes(spec.id));
  }
  if (!template) return outsideEntry(file, entry);
  const contractFile = file === entry.studio || file === hudFor(entry.studio);
  return file.startsWith("src/") && !contractFile;
}

/**
 * Normalise an absolute or cwd-relative path into the repo-relative form the rule reads: `/`
 * separated, null for the workspace itself, `..` for anything outside it.
 */
export function relativeGamePath(
  filePath: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const raw = String(filePath ?? "").trim();
  if (!raw) return null;
  if (platform === StudioPlatform.Windows) return windowsGamePath(raw, cwd);
  const normalisedCwd = path.posix.normalize(cwd).replace(/\/+$/, "");
  // Read what the path resolves to, not how it is spelled: `src/sky/../../index.html` is the
  // entry page, not a file under an owned `src/sky/`.
  const target = path.posix.normalize(raw).replace(/\/+$/, "");
  if (!target.startsWith("/")) return target === "." ? null : target;
  if (target === normalisedCwd) return null;
  if (!target.startsWith(`${normalisedCwd}/`)) return "..";
  return target.slice(normalisedCwd.length + 1);
}

/**
 * The Windows reading: either slash, any case. An absolute path (a drive, a rooted `\path` or a
 * UNC share) is compared with the workspace by `path.win32`; a drive-relative `C:file` resolves
 * against a folder nobody chose, so it reads as outside.
 */
function windowsGamePath(raw: string, cwd: string): string | null {
  const win = path.win32;
  if (/^[a-z]:(?![\\/])/i.test(raw)) return "..";
  if (!win.isAbsolute(raw)) return toPosixRelative(raw, StudioPlatform.Windows).replace(/^\.\//, "");
  const rel = win.relative(cwd, raw);
  if (!rel) return null;
  const outside = rel === ".." || rel.startsWith(`..${win.sep}`) || win.isAbsolute(rel);
  return outside ? ".." : toPosixRelative(rel, StudioPlatform.Windows);
}

/** The reason a blocked edit reports, in the builder's own terms. */
export function ownershipReason(file: string, ownership: Ownership): string {
  const entry = entryFiles(ownership);
  if (ownership.template === false) {
    const seam = ownership.owns.length ? ownership.owns.join(", ") : "the files this part of the game needs";
    return `${file} is outside worker "${ownership.facetId}"'s seam — this game is the user's own, so keep this work in ${seam} (and docs/notes/NOTES.${ownership.facetId}.md)${ownership.ownsMain ? "" : `; ${entry.main}, ${entry.studio} and index.html belong to whoever owns the entry`}. If the work genuinely needs another file, say so in your summary instead of editing it.`;
  }
  const where = ownership.owns.length ? ownership.owns.join(", ") : `src/${ownership.facetId}.js`;
  return `${file} is outside facet "${ownership.facetId}"'s ownership — keep this facet's work in ${where} (and docs/notes/NOTES.${ownership.facetId}.md); ${entry.main} only for the FACET WIRING line${ownership.ownsMain ? "" : `; ${entry.studio} and index.html belong to the main owner`}.`;
}
