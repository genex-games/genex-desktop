/**
 * A project's shape, in the words a person reads — and the choices the Open Game sheet offers.
 *
 * `ProjectShape` is the studio's own vocabulary — `three-vite`, `engine-export`, `serve: "dist"`
 * — and it reaches three surfaces at once: the Open Game sheet, the toast that says what was
 * opened, and the stage header. One table, so all three say the same thing. The sheet's rows are
 * here too, as data: what a folder offers is worth testing without a window. (The harness's own
 * status vocabulary is a different job and lives in `renderer/words.ts`; nothing here reads a run.)
 */
import type { FolderInspection, ProjectKind, ProjectShape } from "./game-project.ts";

/** For each kind: the phrase that finishes "This folder holds …", and the stage header's chip. */
const KINDS: Record<ProjectKind, { phrase: string; chip: string }> = {
  "studio-template": { phrase: "a game made from the Genex starter", chip: "studio starting point" },
  "three-vite": { phrase: "a 3D game with its own build", chip: "3D · own build" },
  "three-modules": { phrase: "a 3D game that runs as written", chip: "3D · runs as written" },
  canvas2d: { phrase: "a 2D canvas game", chip: "2D canvas" },
  phaser: { phrase: "a Phaser game", chip: "Phaser" },
  "engine-export": { phrase: "a game exported from a game engine", chip: "engine export" },
  unity: { phrase: "a Unity source project", chip: "Unity" },
  "own-script": { phrase: "a game with its own scripts", chip: "own scripts" },
};

/** What this folder holds, as a phrase: "This folder holds …". */
export function kindWords(kind: ProjectKind): string {
  return KINDS[kind].phrase;
}

/** The same fact in the two or three words a header has room for. */
export function kindChip(kind: ProjectKind): string {
  return KINDS[kind].chip;
}

/** How the studio will run it: the build it runs first, or nothing at all. */
export function runsWords(shape: ProjectShape): string {
  if (shape.kind === "unity") return "opens in the connected Unity Editor";
  if (!shape.build) return `opens ${shape.entry.split("?")[0]} directly, with no build step`;
  return `built with ${shape.build}, then shown from ${shape.serve === "." ? "the folder" : `${shape.serve}/`}`;
}

/** The toast after a folder is opened: what was found, and that it was not rewritten. */
export function openedWords(title: string, shape: ProjectShape): string {
  return `${title} is ${kindWords(shape.kind)} — Genex keeps it as it is and ${runsWords(shape)}.`;
}

/**
 * An engine export is a compiled artifact: there is no source for a builder to edit and no
 * contract for a judge to read, so a run on it would spend hours photographing a page nobody
 * can change (a Godot or Unity export). Play and screenshots still work, and the
 * harness refuses the run in its own words (`loop/main.ts` `loopRunRefusal`).
 */
export const ENGINE_EXPORT_REFUSAL =
  "This game was exported from a game engine. Genex can open it, play it and take screenshots — it cannot edit or judge a game that is already compiled. To have builders work on it, open the folder with the project's own scenes and scripts.";

/** Whether an unattended build can be started on this shape at all. */
export function canBuildUnattended(kind: ProjectKind): boolean {
  return kind !== "engine-export" && kind !== "unity";
}

/** What pressing a row's button asks for — the arguments of `studio.adoptFolder`. */
export interface OpenChoice {
  /** Explicit host-stored consent for this folder's Claude project configuration and hooks. */
  trustProjectSettings?: boolean;
  subdir?: string;
  template?: boolean;
  /** Set on any row that keeps a folder holding a game of its own as a repository — see `nestedWords`. */
  versionNested?: boolean;
}

/**
 * Keeping a folder whose game is a repository of its own is a decision with a consequence, so
 * the row that does it says the consequence and pressing it *is* the consent. Git records such a folder as a pointer, not as files: until the studio may add
 * those files to the folder's history, a run can read and run the game but nothing it changes
 * inside it can ever be made live, and the run's work is lost.
 * The game's own history is not deleted; it is renamed and kept beside it.
 */
export function nestedWords(nested: string[]): string[] {
  if (nested.length === 0) return [];
  const names = nested.map((rel) => `${rel}/`).join(", ");
  const one = nested.length === 1;
  return [
    `${names} ${one ? "is a repository of its own" : "are repositories of their own"} — Genex adds ${one ? "its" : "their"} files to this folder's history the first time a build goes live, so work inside ${one ? "it" : "them"} is not lost.`,
    `${one ? "Its own history is" : "Their own histories are"} kept beside ${one ? "it" : "them"}, renamed to .git.studio-backup.`,
  ];
}

/** One row of the Open Game sheet: a game that was found, or the folder itself. */
export interface OpenOption {
  /** The candidate's `rel`; "." for the picked folder itself. */
  id: string;
  label: string;
  /** What it is: "a 3D game with its own build", or what would happen to an empty folder. */
  headline: string;
  /** How it runs, or what starting here means. */
  detail: string;
  /** Facts about opening it that a person would want before agreeing: packages, git, nested repos. */
  facts: string[];
  /** What would stop a run on it, in the words `validateAt` already wrote. */
  problems: string[];
  /** Every file the studio would add, in the order it writes them. */
  writes: string[];
  /** Compiled: openable to play and screenshot, never buildable unattended. */
  engineExport: boolean;
  choice: OpenChoice;
  button: string;
}

/**
 * The sheet's rows for a picked folder, the one it would open first: every game found in it or
 * one level under it (the nested game is offered as *the* game), then
 * the folder itself, which is either a new game or the parent kept exactly as it is.
 */
export function openOptions(inspection: FolderInspection): OpenOption[] {
  // The game the studio would open leads, whatever order the folder was read in: the row that is
  // selected must be the row the eye lands on first.
  const found = [...inspection.candidates].sort(
    (a, b) => Number(b.rel === inspection.suggested) - Number(a.rel === inspection.suggested),
  );
  const options: OpenOption[] = found.map((candidate) => {
    const { preflight, shape } = candidate;
    const facts: string[] = [];
    if (preflight.needsInstall) {
      facts.push(
        preflight.install
          ? `Its packages aren’t installed yet — “${preflight.install}” runs on one press.`
          : "Its packages aren’t installed yet.",
      );
    }
    facts.push(
      preflight.git === "repo"
        ? "Genex saves each change to the folder’s own Git history."
        : "Genex starts Git history here, so any change can be undone.",
    );
    facts.push(...nestedWords(preflight.nested));
    return {
      id: candidate.rel,
      label: candidate.rel === "." ? "This folder" : `${candidate.rel}/`,
      headline: kindWords(shape.kind),
      detail: runsWords(shape),
      facts,
      problems: preflight.problems,
      writes: preflight.writes,
      engineExport: shape.kind === "engine-export",
      choice: {
        ...(candidate.rel === "." ? {} : { subdir: candidate.rel }),
        ...(preflight.nested.length > 0 ? { versionNested: true } : {}),
      },
      button: candidate.rel === "." ? "Open this game" : `Open ${candidate.rel}/`,
    };
  });
  // `starter` is empty when the folder is a game of its own — its own row above says it.
  if (inspection.starter.length > 0) {
    const beside = inspection.candidates.length > 0;
    options.push({
      id: ".",
      label: "This folder",
      headline: beside ? "no game of its own" : "an empty folder",
      detail: beside
        ? "the game inside it stays exactly where it is"
        : "Genex adds a starter game, then you describe the one you want",
      facts: [
        ...(beside ? ["No starter game is written beside the game you already have."] : []),
        ...nestedWords(inspection.nested),
      ],
      problems: [],
      writes: inspection.starter,
      engineExport: false,
      // Keeping the parent must never drop a second index.html beside somebody's real game.
      choice: {
        ...(beside ? { template: false } : {}),
        ...(inspection.nested.length > 0 ? { versionNested: true } : {}),
      },
      button: beside ? "Keep this folder" : "Start a game here",
    });
  }
  return options;
}

/** Which row opens by default — the one `inspect` suggested, else the first. */
export function suggestedOption(options: OpenOption[], suggested: string | null): number {
  const index = options.findIndex((option) => option.id === suggested);
  return index >= 0 ? index : 0;
}
