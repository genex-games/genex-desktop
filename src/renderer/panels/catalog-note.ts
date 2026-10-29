/**
 * What a connected provider row says about its model list (Settings → Model Providers): nothing
 * while the list is fine, since it refreshes by itself; a quiet line while the first list loads;
 * and, after a refresh fails, which models it shows with a Try again beside it.
 */
import { t } from "../../shared/i18n.ts";
import { ModelCatalogState, type ModelCatalogStatus } from "../../shared/model-catalog.ts";

/** Why the row speaks about its model list. */
export const CatalogNoteKind = { Loading: "loading", Problem: "problem" } as const;
export type CatalogNoteKind = (typeof CatalogNoteKind)[keyof typeof CatalogNoteKind];

/** One line under the row's account line, and whether it offers Try again. */
export interface CatalogNote {
  kind: CatalogNoteKind;
  text: string;
  /** The provider's own reason, for the line's tooltip. */
  detail?: string;
  retry: boolean;
  /** Try again is running: the line stays and its button waits. */
  retrying: boolean;
}

const MESSAGE = {
  loading: t("Loading models…"),
  saved: t("Showing saved models. The list didn't refresh."),
  unavailable: t("Couldn't load the model list."),
} as const;

/** The row's model-list line, or null when there is nothing worth saying. */
export function catalogNote(catalog: ModelCatalogStatus | undefined): CatalogNote | null {
  if (!catalog) return null;
  const unavailable = catalog.state === ModelCatalogState.Unavailable;
  if (unavailable || catalog.problem)
    return {
      kind: CatalogNoteKind.Problem,
      text: unavailable ? MESSAGE.unavailable : MESSAGE.saved,
      ...(catalog.problem ? { detail: catalog.problem.message } : {}),
      retry: true,
      retrying: catalog.refreshing,
    };
  if (catalog.state === ModelCatalogState.Loading)
    return { kind: CatalogNoteKind.Loading, text: MESSAGE.loading, retry: false, retrying: false };
  return null;
}
