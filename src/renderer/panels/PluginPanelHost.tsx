/**
 * A plugin panel on screen: a sandboxed frame and the one bridge it may talk over
 * (`panel-host-bridge.ts`). The frame gets `context`, its plugin's `settings`, its declared
 * `action`s — a confirmed action runs the same review → ticket → native approval sequence a toolbar
 * press does — and `chooseFile`, Studio's own file picker. Nothing else crosses; the panel never
 * sees `window.studio`. When the game (or the surface) changes under an open panel, a review still
 * waiting is cancelled, requests already asked are answered in the game they were asked in, and the
 * panel is told its context changed.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { PluginInfo, PluginPanelDocument } from "../../shared/plugins.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { PluginReviewRequest } from "../plugin-actions.ts";
import { type PanelHead, PanelSurface } from "./panel-bridge.ts";
import { type PanelBridge, PanelMessage, openPanelBridge } from "./panel-host-bridge.ts";
import { PluginApproval } from "./PluginApproval.tsx";

interface Props {
  plugin: PluginInfo;
  document: PluginPanelDocument;
  project: string | null | undefined;
  className?: string;
  /** What the frame sits on, so the panel paints its background to match (a dialog's card, else the page). */
  surface?: PanelSurface;
  /** The panel's heading as it tells it (a dialog shows it as its title); null until it tells one. */
  onHead?: (head: PanelHead | null) => void;
  /** Filled with what presses the panel's own Back, for the dialog's arrow. */
  backRef?: RefObject<(() => void) | null>;
}

/** Cancels a review still waiting, so its action never runs. */
const cancelReview = (r: PluginReviewRequest | null): null => {
  r?.resolve(false);
  return null;
};

/** What the bridge reads and tells: the panel's frame, plugin, game and surface, and where its review and size go. */
type BridgeDeps = {
  frame: RefObject<HTMLIFrameElement | null>;
  plugin: PluginInfo;
  project: string | null | undefined;
  surface: PanelSurface;
  onHead?: (head: PanelHead | null) => void;
  setReview: (update: (r: PluginReviewRequest | null) => PluginReviewRequest | null) => void;
  setHeight: (height: number | null) => void;
};

/**
 * The bridge to the frame, open while the same plugin's panel shows. The plugin, game and surface
 * are read as they are at each request, without re-subscribing per change; another game or surface
 * cancels a review still waiting (it is the old game's) and tells the panel to read its context again.
 */
function usePanelBridge({ frame, plugin, project, surface, onHead, setReview, setHeight }: BridgeDeps): void {
  const now = useRef({ plugin, project, surface, onHead });
  now.current = { plugin, project, surface, onHead };
  const bridge = useRef<PanelBridge | null>(null);
  const id = plugin.manifest.id;
  useEffect(() => {
    const open = openPanelBridge({
      frame: () => frame.current?.contentWindow ?? null,
      plugin: () => now.current.plugin,
      project: () => now.current.project,
      surface: () => now.current.surface,
      style: () => getComputedStyle(window.document.documentElement),
      review: (request) => setReview(() => request),
      onHead: (head) => now.current.onHead?.(head),
      onHeight: setHeight,
    });
    bridge.current = open;
    const handle = (event: MessageEvent) => void open.receive(event);
    const notifyContext = () => open.contextChanged();
    window.addEventListener("focus", notifyContext);
    const unsubscribe = window.studio.onEvent((event) => {
      if (event.type === UiEvent.PluginsChanged && event.payload?.id === id) notifyContext();
    });
    window.addEventListener("message", handle);
    return () => {
      open.close();
      if (bridge.current === open) bridge.current = null;
      unsubscribe();
      window.removeEventListener("focus", notifyContext);
      window.removeEventListener("message", handle);
      setReview(cancelReview);
    };
  }, [frame, id, setReview, setHeight]);
  const shown = useRef({ project, surface });
  useEffect(() => {
    const before = shown.current;
    shown.current = { project, surface };
    if (before.project === project && before.surface === surface) return;
    setReview(cancelReview);
    bridge.current?.contextChanged();
  }, [project, surface, setReview]);
}

export function PluginPanelHost({
  plugin,
  document,
  project,
  className = "h-[65vh] w-full border border-line",
  surface = PanelSurface.Page,
  onHead,
  backRef,
}: Props): JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null);
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  // The panel's own height once it tells one: the frame grows with it, so its dialog scrolls once.
  const [height, setHeight] = useState<number | null>(null);
  usePanelBridge({ frame, plugin, project, surface, onHead, setReview, setHeight });
  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => frame.current?.contentWindow?.postMessage({ type: PanelMessage.Back }, "*");
    return () => {
      backRef.current = null;
    };
  }, [backRef]);
  return (
    <>
      <iframe
        ref={frame}
        title={document.title}
        sandbox="allow-scripts"
        className={className}
        style={height === null ? undefined : { height }}
        src={document.url}
      />
      {review ? <PluginApproval review={review} onClose={() => setReview(null)} /> : null}
    </>
  );
}
