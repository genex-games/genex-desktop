/**
 * What the bound game's folder declares for a Studio-run Genex CLI command (`llm budget`: the AI
 * budget a native game's players approve on its Genex page). The CLI reads a declaration from the
 * folder it runs in, `genex.<key>` in package.json or else `<key>` in genex.json, and it never runs
 * in the game (`genex-cli.ts`). So Studio reads the two files here and writes the declaration alone
 * into the run folder, under the name of the file that held it, and the CLI finds it exactly as it
 * would in the game. Each file is read by its own name in the game's real folder, through one handle
 * that follows no link, and never past its cap; nothing is written into the game.
 */
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isJsonObject, NotARegularFileError, readRegularFile } from "../../substrate/fsx.ts";
import { type GameDeclaration, GenexCliRefusal, GenexCliRefusalCode } from "./genex-cli-policy.ts";
import { GENEX_CLI_PROMPT } from "./genex-cli-prompts.ts";

const KIB = 1024;
/** The most of a game's package.json or genex.json Studio reads for a declaration. */
export const DECLARATION_FILE_MAX_BYTES = 256 * KIB;
/** The most a declaration's own JSON holds: more is refused, never cut. */
export const DECLARATION_MAX_BYTES = 16 * KIB;
/** Owner-only, like the rest of the run folder. */
const PRIVATE_FILE = 0o600;
/** The object in package.json that holds a game's Genex settings. */
const PACKAGE_SECTION = "genex";

/** The files a declaration lives in. Names in the game's folder and the run folder: never rename one. */
export const DeclarationFile = { Package: "package.json", Settings: "genex.json" } as const;
export type DeclarationFile = (typeof DeclarationFile)[keyof typeof DeclarationFile];

/** The order the CLI reads them in: package.json's declaration wins. */
const READ_ORDER = [DeclarationFile.Package, DeclarationFile.Settings] as const;

/** What the game's folder says about one declaration. */
export interface GameDeclarationRead {
  /** The declaration as written, whatever its shape, and the file that holds it; absent when none does. */
  found?: { key: GameDeclaration; file: DeclarationFile; value: unknown };
  /** What the agent is told when a file was there and Studio did not read it; nothing is then copied. */
  note?: string;
}

/** One file's text, null when the game has none, or why Studio did not read it. */
async function fileText(folder: string, file: DeclarationFile): Promise<{ text: string | null } | { unread: string }> {
  try {
    const bytes = await readRegularFile(path.join(folder, file), DECLARATION_FILE_MAX_BYTES);
    return { text: bytes.toString("utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: null };
    const tooLarge = error instanceof NotARegularFileError && error.code === "EFBIG";
    return {
      unread: tooLarge
        ? GENEX_CLI_PROMPT.BudgetFileTooLarge(file, DECLARATION_FILE_MAX_BYTES / KIB)
        : GENEX_CLI_PROMPT.BudgetFileNotPlain(file),
    };
  }
}

/**
 * The object of a file that would hold a declaration: `genex` in package.json, genex.json itself.
 * Text that is not JSON, or not an object, holds none, as the CLI reads it.
 */
function holderOf(file: DeclarationFile, text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  if (file === DeclarationFile.Settings) return parsed;
  const section = parsed[PACKAGE_SECTION];
  return isJsonObject(section) ? section : null;
}

/**
 * What `game` (the bound game's real folder) declares under `key`: package.json's, else
 * genex.json's, else nothing. A file that is there and is not a plain file within its cap stops the
 * reading with a note, since Studio cannot tell what it declares. A declaration larger than Studio
 * copies is refused. Reads only; a value of any shape is passed on for the CLI to judge.
 */
export async function readGameDeclaration(game: string, key: GameDeclaration): Promise<GameDeclarationRead> {
  const folder = await realpath(game);
  for (const file of READ_ORDER) {
    const read = await fileText(folder, file);
    if ("unread" in read) return { note: read.unread };
    const holder = holderOf(file, read.text);
    if (!holder || !Object.hasOwn(holder, key)) continue;
    const value = holder[key];
    if (Buffer.byteLength(JSON.stringify(value)) > DECLARATION_MAX_BYTES)
      throw new GenexCliRefusal(
        GenexCliRefusalCode.InvalidValue,
        GENEX_CLI_PROMPT.BudgetTooLarge(key, file, DECLARATION_MAX_BYTES / KIB),
      );
    return { found: { key, file, value } };
  }
  return {};
}

/** Write what the game declares into the run folder `work`, alone, in a file named as the one that held it. */
export async function stageGameDeclaration(read: GameDeclarationRead, work: string): Promise<void> {
  if (!read.found) return;
  const { key, file, value } = read.found;
  const declared = { [key]: value };
  const body = file === DeclarationFile.Package ? { [PACKAGE_SECTION]: declared } : declared;
  await writeFile(path.join(work, file), `${JSON.stringify(body)}\n`, { flag: "wx", mode: PRIVATE_FILE });
}
