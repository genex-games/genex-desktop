/**
 * The design board as the app serves it (`main/design-pages.ts` decides what is read): a game's
 * board for the Design tab, the answer to a frame's request, the pictures the person drops on the
 * canvas, and `show_design`, the game's agent bringing an artboard in front of the person.
 */
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CHOICES_MAX,
  DESIGN_DROPS,
  DESIGN_FOLDER,
  type DesignBoard,
  designItemFile,
  DesignItemKind,
  designItemKind,
  type DesignTheme,
  noteWords,
  readDesignFiles,
  readDesignMaking,
  readDesignSpot,
} from "../../shared/design-board.ts";
import { DESIGN_MARKS_FILE, type DesignMarks, readDesignMarks, writeDesignMarks } from "../../shared/design-marks.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { ensureDirBelow, writeFileInDir } from "../../substrate/fsx.ts";
import {
  DesignHosts,
  type DesignItemFile,
  type DesignPageFacts,
  designPageUrl,
  type DesignServed,
  listDesignBoard,
  serveDesignFile,
} from "../design-pages.ts";
import { HttpStatus } from "../page-serve.ts";
import type { StudioCore } from "../studio-core.ts";
import { SHOW_DESIGN_ANSWER } from "./design-board-prompts.ts";

/** The largest picture the person may drop on the canvas, and how many names are tried for one that is taken. */
const DROP_MAX_BYTES = 20 * 1024 * 1024;
const DROP_NAME_TRIES = 50;
/** The longest name a dropped picture keeps, without its extension. */
const DROP_NAME_CHARS = 80;
/** The largest marks file that is read: the person's places, notes and picks are a few kilobytes. */
const MARKS_MAX_BYTES = 512 * 1024;

/** What the service needs of the core: where games are, and the app's ear. */
type DesignCore = Pick<StudioCore, "games" | "emit">;

/** What `show_design` did: its answer to the agent, and the artboard it brought in front of the person, if it did. */
export interface DesignShowResult {
  answer: string;
  item: DesignItemFile | null;
}

/** An answer that showed nothing. */
const unshown = (answer: string): DesignShowResult => ({ answer, item: null });

/**
 * A dropped picture's name as the board keeps it: its own file name, no folder and no leading dot,
 * of a kind the canvas shows as a picture; null for anything else.
 */
function dropName(name: unknown): { stem: string; extension: string } | null {
  if (typeof name !== "string") return null;
  const leaf = (name.split(/[\\/]/).pop() ?? "").replace(/^\.+/, "").trim();
  const extension = path.extname(leaf);
  const stem = leaf.slice(0, leaf.length - extension.length).slice(0, DROP_NAME_CHARS);
  if (!stem || designItemKind(leaf) !== DesignItemKind.Picture) return null;
  return designItemFile(`${DESIGN_DROPS}/${stem}${extension}`) ? { stem, extension } : null;
}

/** A game's design board: read for the tab, served to its frames, added to by the person, shown by its agent. */
export class DesignBoardService {
  readonly #core: DesignCore;
  readonly #hosts = new DesignHosts();
  /** What was read in each page listed, so a board read every two seconds reads a page's text once. */
  readonly #facts: DesignPageFacts = new Map();
  /**
   * Each game's last change to its marks file: a change waits for the one before it, so two saves
   * never write the file at once (a mix of both would read back as an empty board) and an offer's
   * read and write keep what a save in between wrote.
   */
  readonly #marksChanges = new Map<string, Promise<unknown>>();

  constructor(core: DesignCore) {
    this.#core = core;
  }

  /** The game's real folder, or null for a game that is not there. */
  async #root(project: string): Promise<string | null> {
    try {
      return await realpath(this.#core.games.dirFor(project));
    } catch {
      return null;
    }
  }

  /** The game's board: its artboards in the board's order, each with the address it loads; empty for a game with none. */
  async board(project: string): Promise<DesignBoard> {
    const root = await this.#root(project);
    if (!root) return { items: [], stamp: "" };
    const { items, stamp } = await listDesignBoard(root, this.#facts);
    const host = this.#hosts.hostFor(project);
    const placed = items.map(({ version, ...item }) => ({ ...item, url: designPageUrl(host, item.file, version) }));
    return { items: placed, stamp };
  }

  /** What a frame's request to `host` for `pathname` gets: only a host this launch gave a game answers. */
  async serve(host: string, pathname: string, theme?: DesignTheme): Promise<DesignServed> {
    const project = this.#hosts.projectOf(host);
    const root = project ? await this.#root(project) : null;
    return root ? serveDesignFile(root, pathname, theme) : { status: HttpStatus.NotFound };
  }

  /**
   * A picture the person dropped on the canvas, kept in the board's `from-you` section under its
   * own name (a taken name gets a number). Only a picture, of a bounded size, is kept, and only in
   * that folder of the game, reached by no link; anything else is refused and writes nothing.
   * Answers the picture's file in the game folder, or null.
   */
  async drop(project: string, name: unknown, data: unknown): Promise<string | null> {
    const named = dropName(name);
    const bytes = data instanceof Uint8Array ? data : null;
    const root = await this.#root(project);
    if (!named || !bytes || !root || bytes.byteLength === 0 || bytes.byteLength > DROP_MAX_BYTES) return null;
    const folder = await ensureDirBelow(root, [...DESIGN_FOLDER.split("/"), DESIGN_DROPS]).catch(() => null);
    if (!folder) return null;
    for (let attempt = 1; attempt <= DROP_NAME_TRIES; attempt += 1) {
      const leaf = `${named.stem}${attempt > 1 ? ` ${attempt}` : ""}${named.extension}`;
      const written = await writeFile(path.join(folder, leaf), bytes, { flag: "wx" }).then(
        () => true,
        (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : null),
      );
      if (written === null) return null;
      if (written) return `${DESIGN_FOLDER}/${DESIGN_DROPS}/${leaf}`;
    }
    return null;
  }

  /**
   * What the person did on the game's board (`shared/design-marks.ts`): read from the one file the
   * board keeps it in, itself and no link; nothing done for a game or a file that is not there, a
   * file too large, or one that does not parse.
   */
  async marks(project: string): Promise<DesignMarks> {
    const root = await this.#root(project);
    if (!root) return readDesignMarks(null);
    const file = path.join(root, ...DESIGN_MARKS_FILE.split("/"));
    try {
      const info = await lstat(file);
      const own = info.isFile() && info.size <= MARKS_MAX_BYTES && (await realpath(file)) === file;
      return readDesignMarks(own ? JSON.parse(await readFile(file, "utf8")) : null);
    } catch {
      return readDesignMarks(null);
    }
  }

  /**
   * Keep what the person did on the game's board: what is written is what a read would take
   * (anything else in `marks` is dropped), in the board's own folder, reached by no link. False
   * when the game is not there or the file could not be written.
   */
  saveMarks(project: string, marks: unknown): Promise<boolean> {
    return this.#inTurn(project, () => this.#writeMarks(project, marks));
  }

  /** `change` once the game's change to its marks before it has ended, however that ended. */
  #inTurn<T>(project: string, change: () => Promise<T>): Promise<T> {
    const before = this.#marksChanges.get(project) ?? Promise.resolve();
    const turn = before.then(change, change);
    const settled = turn.catch(() => undefined);
    this.#marksChanges.set(project, settled);
    void settled.then(() => {
      if (this.#marksChanges.get(project) === settled) this.#marksChanges.delete(project);
    });
    return turn;
  }

  async #writeMarks(project: string, marks: unknown): Promise<boolean> {
    const root = await this.#root(project);
    if (!root) return false;
    const parts = DESIGN_MARKS_FILE.split("/");
    const name = parts.pop() ?? "";
    try {
      await writeFileInDir(await ensureDirBelow(root, parts), name, writeDesignMarks(readDesignMarks(marks)));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `show_design`'s `making`: the artboards the agent is about to make, told to the canvas, which
   * shows them being drawn until their files are there. Nothing is written; the files told, in order.
   */
  making(project: string, files: unknown): string[] {
    const making = readDesignMaking(files);
    if (making.length > 0) this.#core.emit(UiEvent.DesignMaking, { project, files: making });
    return making;
  }

  /**
   * `show_design`'s `choose`: the artboards the person is to pick among, which alone wear Use this
   * and Not this. Kept with what the person did on the board (their places, notes and picks stay)
   * and told to the canvas; only artboards the board holds are offered, and none ends the choosing.
   * The artboards offered, or null for a game that is not there.
   */
  async offer(project: string, files: unknown): Promise<string[] | null> {
    const root = await this.#root(project);
    if (!root) return null;
    const held = new Set((await listDesignBoard(root, this.#facts)).items.map((item) => item.file));
    const choices = readDesignFiles(files, CHOICES_MAX).filter((file) => held.has(file));
    await this.#inTurn(project, async () => this.#writeMarks(project, { ...(await this.marks(project)), choices }));
    this.#core.emit(UiEvent.DesignChoices, { project, files: choices });
    return choices;
  }

  /**
   * `show_design`: with no artboard, how to design on the board and what it holds now; with an
   * artboard of the game's board, the Design tab opens on it, with the agent's few words and the
   * spot it points at, if it pointed. It writes no file.
   */
  async show(project: string, page: unknown, said: { note?: unknown; spot?: unknown } = {}): Promise<DesignShowResult> {
    const root = await this.#root(project);
    const items = root ? (await listDesignBoard(root, this.#facts)).items : [];
    const files = items.map((listed) => listed.file);
    if (page === undefined || page === null || page === "") return unshown(SHOW_DESIGN_ANSWER.guide(files));
    const file = designItemFile(page);
    if (!file) return unshown(SHOW_DESIGN_ANSWER.badName);
    const shown = items.find((listed) => listed.file === file);
    if (!shown) return unshown(SHOW_DESIGN_ANSWER.missing(file, files));
    const spot = readDesignSpot(said.spot);
    this.#core.emit(UiEvent.DesignShown, { project, file, note: noteWords(said.note), ...(spot ? { spot } : {}) });
    return { answer: SHOW_DESIGN_ANSWER.shown(file), item: shown };
  }
}
