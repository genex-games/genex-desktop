/**
 * A plugin action pressed by the user, wherever it was pressed — a panel frame, the Plugins
 * dialog, a toolbar button. One implementation of the review → ticket → native approval
 * sequence, so a confirmed action reaches main the same way from every surface.
 */
import type { PluginInfo } from "../shared/plugins.ts";

/** The pictures a review may show: inline PNG, JPEG or WebP, never a link to fetch. */
const REVIEW_IMAGE = /^data:image\/(png|jpeg|webp);base64,/;

/** Whether `dataUrl` is a picture Studio shows in a plugin's review. */
export const isReviewImage = (dataUrl: unknown): dataUrl is string =>
  typeof dataUrl === "string" && REVIEW_IMAGE.test(dataUrl);

/** What the host shows before a confirmed action goes to the native dialog; `resolve(false)` cancels. */
export interface PluginReviewRequest {
  message: string;
  images: Array<{ label: string; dataUrl: string }>;
  resolve: (yes: boolean) => void;
}

export async function runPluginAction({
  plugin,
  name,
  args,
  project,
  review,
}: {
  plugin: PluginInfo;
  name: string;
  args: unknown;
  project: string | null | undefined;
  /** Shows the host-rendered review; the promise it settles gates the ticketed call. */
  review: (request: PluginReviewRequest) => void;
}): Promise<unknown> {
  const declaration = plugin.manifest.actions.find((a) => a.name === name);
  if (!declaration) throw new Error("Undeclared action");
  const actual = args ?? {};
  let ticket: string | undefined;
  if (declaration.confirmation) {
    const info = await window.studio.pluginReview(plugin.manifest.id, name, actual, project ?? undefined);
    ticket = info.ticket;
    const images = (info.images ?? []).filter((i) => isReviewImage(i.dataUrl));
    if (images.length !== (info.images ?? []).length) throw new Error("Invalid approval image");
    // Text-only actions are reviewed once in the trusted native dialog. Candidate pictures
    // still need the Studio image review before that final approval.
    if (images.length) {
      const yes = await new Promise<boolean>((resolve) =>
        review({ message: info.message ?? declaration.confirmation ?? declaration.label, images, resolve }),
      );
      if (!yes) throw new Error("Cancelled");
    }
  }
  return window.studio.pluginAction(plugin.manifest.id, name, actual, project ?? undefined, ticket);
}
