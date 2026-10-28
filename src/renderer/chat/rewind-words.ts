/**
 * What the Rewind dialog says about the game files: whether they can go back with the chat, and
 * when they cannot, why only the conversation rewinds. Pure, so the words are tested without a DOM.
 */
import { FilesStay, type RewindFiles } from "../../shared/chat-rewind.ts";
import { t } from "../../shared/i18n.ts";

/** The dialog's own lines beside the files. */
export const REWIND_WORDS = {
  rewind: t("Rewind chat"),
  rewinding: t("Rewinding…"),
  /** The confirmation waits for the running build to close before the chat goes back. */
  stoppingBuild: t("Stopping the build…"),
  checking: t("Checking the game files…"),
  restoreFiles: t("Restore game files"),
} as const;

/** Up to three file names, and how many more there are. */
const names = (files: readonly string[]): string => {
  const shown = files
    .slice(0, 3)
    .map((file) => file.split("/").pop())
    .join(", ");
  if (files.length <= 3) return shown;
  return t("{count, plural, other {{names} and # more}}", { names: shown, count: files.length - 3 });
};

type RestoreFiles = Extract<RewindFiles, { state: "restore" }>;
export interface RewindFilesWords {
  line: string | null;
  outside: string | null;
  nested: string | null;
}

/**
 * The files too large to save, by name: "Too large to save, so they stay as they are: big.uasset,
 * take2.wav." An answer without their names says how many: "3 files were … stay as they are".
 */
function tooLargeWords(count: number, files: readonly string[]): string {
  if (files.length === 1) return t("Too large to save, so it stays as it is: {names}.", { names: names(files) });
  if (files.length) return t("Too large to save, so they stay as they are: {names}.", { names: names(files) });
  return t(
    "{count, plural, one {# file was too large to save and stays as it is.} other {# files were too large to save and stay as they are.}}",
    { count },
  );
}

/** What stays as it is whatever the rewind does: nested repositories, and files too large to save. */
function keptWords(files: RewindFiles): string | null {
  const nested = "nested" in files && files.nested.length ? files.nested : [];
  const tooLarge = files.state === "restore" ? files.tooLarge : 0;
  const tooLargeFiles = files.state === "restore" ? (files.tooLargeFiles ?? []) : [];
  const lines = [
    nested.length
      ? t("Files inside {folders} keep their own history and stay as they are.", {
          folders: names(nested.map((name) => `${name}/`)),
        })
      : null,
    tooLarge ? tooLargeWords(tooLarge, tooLargeFiles) : null,
  ];
  return lines.filter(Boolean).join(" ") || null;
}

/** Files changed outside this chat that a restore would put back too. */
function outsideWords(files: RestoreFiles): string | null {
  const count = files.outside.length;
  if (count)
    return t(
      "{count, plural, one {Including # file changed outside this chat: {names}.} other {Including # files changed outside this chat: {names}.}}",
      { count, names: names(files.outside) },
    );
  return files.outsideUnknown ? t("Some of them may have changed outside this chat.") : null;
}

/** Why only the conversation rewinds, one plain line each. */
const FILES_STAY_WORDS: Record<FilesStay, string> = {
  [FilesStay.BuildChanged]: t(
    "Only the conversation rewinds: a build changed the game after this message, so its files stay as they are.",
  ),
  [FilesStay.BuildRunning]: t(
    "A build is running. Rewinding stops it and cuts off any answer under way; the game’s files stay as they are.",
  ),
  [FilesStay.HistoryChanged]: t(
    "Only the conversation rewinds: a commit changed the game after this message, so its files stay as they are.",
  ),
  [FilesStay.NoCheckpoint]: t(
    "Only the conversation rewinds: there’s no saved copy of the game from before this message.",
  ),
  [FilesStay.JoinedAnswer]: t(
    "Only the conversation rewinds: this message joined an answer already under way, so there’s no saved copy from just before it.",
  ),
  [FilesStay.TooLarge]: t("Only the conversation rewinds: the files that changed were too large to save."),
};

/** Why only the conversation rewinds, naming the files when they were all too large to save. */
function filesStayLine(files: Extract<RewindFiles, { state: "unavailable" }>): string {
  const named = files.reason === FilesStay.TooLarge && files.tooLargeFiles?.length;
  if (!named) return FILES_STAY_WORDS[files.reason];
  return t("Only the conversation rewinds: the files that changed were too large to save: {names}.", {
    names: names(files.tooLargeFiles ?? []),
  });
}

/** What the game files do when the chat goes back, in plain lines. */
export function rewindFilesWords(files: RewindFiles): RewindFilesWords {
  const nested = keptWords(files);
  switch (files.state) {
    case "restore":
      return {
        line: t(
          "{count, plural, one {# file goes back to how it was before this message.} other {# files go back to how they were before this message.}}",
          { count: files.files },
        ),
        outside: outsideWords(files),
        nested,
      };
    case "unchanged":
      return { line: t("The game files haven’t changed since this message."), outside: null, nested };
    case "unavailable":
      return { line: filesStayLine(files), outside: null, nested: null };
    case "none":
      return { line: t("Only the conversation rewinds."), outside: null, nested: null };
  }
}

/** A restore that would also put back files changed outside this chat starts off. */
export const restoresByDefault = (files: RewindFiles): boolean =>
  !(files.state === "restore" && (files.outside.length || files.outsideUnknown));

/** The confirm button while it works: a build is stopped first, then the chat goes back. */
export const rewindBusyLabel = (stopsBuild: boolean): string =>
  stopsBuild ? REWIND_WORDS.stoppingBuild : REWIND_WORDS.rewinding;
