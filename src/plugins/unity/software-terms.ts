/**
 * Whether this Mac's Unity has had its Software Terms accepted. A fresh Unity's first editor shows
 * them in a window of its own before its Pipeline server starts, so an editor waiting there looks
 * like one still starting. Unity keeps each version a person accepted as a `Terms-<id>` key in its
 * preferences, a binary property list whose key names are stored as plain text: no such key, or no
 * preferences yet, means that window is waiting. Only looks; nothing is written.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EditorsEnv } from "./editors.ts";

/** Unity's own preferences on a Mac, under the person's home folder. */
const PREFERENCES = ["Library", "Preferences", "com.unity3d.UnityEditor5.x.plist"] as const;
/** The key of one accepted version of the terms. */
const ACCEPTED = /Terms-[0-9a-f]{32}/;
/** Past this the file is not Unity's preferences as Unity writes them, and is not read. */
const MAX_PREFERENCES_BYTES = 4 * 1024 * 1024;

/** Whether the terms were accepted on this Mac; undefined where Genex can't tell (not a Mac, an unreadable file). */
export async function termsAccepted(env: EditorsEnv): Promise<boolean | undefined> {
  if (env.platform !== "darwin") return undefined;
  const file = path.join(env.home, ...PREFERENCES);
  const info = await stat(file).catch(() => null);
  if (!info) return false;
  if (!info.isFile() || info.size > MAX_PREFERENCES_BYTES) return undefined;
  const bytes = await readFile(file).catch(() => null);
  return bytes ? ACCEPTED.test(bytes.toString("latin1")) : undefined;
}
