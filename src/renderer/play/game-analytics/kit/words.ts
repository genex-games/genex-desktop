/** The few words the kit says by itself; every report brings its own labels, titles and sentences. */
import { t } from "../../../../shared/i18n.ts";

/** The kit's own copy. */
export const KIT_WORDS = {
  /** The heading of a chart's first table column when its places are days. */
  day: t("Day"),
  /** The heading of the column that names the marks on a day. */
  marks: t("Marks"),
  /** The sum of a day's stacked series. */
  total: t("Total"),
  /** A funnel step's default lines: who goes on, how many do not, and the last step against the first. */
  goOn: (share: string) => t("{share} go on", { share }),
  leave: (count: string) => t("{count} leave", { count }),
  ofFirstStep: (share: string) => t("{share} of the first step", { share }),
  /** The button that opens and closes a table row with rows inside it. */
  showParts: (name: string) => t("Show what is inside {name}", { name }),
  hideParts: (name: string) => t("Hide what is inside {name}", { name }),
} as const;
