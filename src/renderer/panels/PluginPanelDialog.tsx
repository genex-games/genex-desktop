/**
 * A plugin's panel opened from the stage strip, as one dialog: the panel's own heading is the
 * dialog's title (and its Back the dialog's arrow), and the frame is as tall as the panel, so the
 * dialog scrolls once instead of holding a page with its own padding and scrollbar.
 */
import type { JSX } from "react";
import { useRef, useState } from "react";
import type { PluginInfo, PluginPanelDocument } from "../../shared/plugins.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { type PanelHead, PanelSurface } from "./panel-bridge.ts";
import { PluginPanelHost } from "./PluginPanelHost.tsx";

export function PluginPanelDialog({
  plugin,
  document,
  title,
  project,
  onDismiss,
}: {
  plugin: PluginInfo;
  document: PluginPanelDocument;
  /** The manifest's name for the panel: the title until the panel tells its own heading. */
  title: string;
  project: string | null | undefined;
  onDismiss: () => void;
}): JSX.Element {
  const [head, setHead] = useState<PanelHead | null>(null);
  const back = useRef<(() => void) | null>(null);
  return (
    <DialogSurface
      title={head?.title ?? title}
      description={head?.description ?? undefined}
      onBack={head?.back ? () => back.current?.() : undefined}
      size="2xl"
      onDismiss={onDismiss}
    >
      {/* A panel that tells no height (an older SDK) keeps a fixed frame that scrolls inside. */}
      <PluginPanelHost
        plugin={plugin}
        document={document}
        project={project}
        surface={PanelSurface.Card}
        onHead={setHead}
        backRef={back}
        className="-mx-1 h-[min(560px,calc(100dvh-12rem))] w-[calc(100%+0.5rem)] rounded-control border-0"
      />
    </DialogSurface>
  );
}
