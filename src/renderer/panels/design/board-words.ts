/** What the canvas's tools and the person's notes say. Loaded with the Design tab. */
import { t } from "../../../shared/i18n.ts";

export const BOARD_WORDS = {
  move: t("Move"),
  note: t("Note"),
  addPicture: t("Add a picture"),
  notePlaceholder: t("Write a note…"),
  deleteNote: t("Delete note"),
  noteNew: t("Not sent yet"),
  noteTold: t("Sent to Genex"),
  newNotes: (count: number) => t("{count, plural, one {# new note} other {# new notes}}", { count }),
  newPicks: (count: number) => t("{count, plural, one {# new pick} other {# new picks}}", { count }),
  useThis: t("Use this"),
  notThis: t("Not this"),
  chosen: t("Chosen"),
  tell: t("Tell Genex"),
  drawing: (title: string) => t("Genex is drawing {title}", { title }),
  next: (title: string) => t("{title} · next", { title }),
} as const;
