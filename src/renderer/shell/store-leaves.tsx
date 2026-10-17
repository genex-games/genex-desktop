/**
 * The leaves that read a fast-changing store themselves, so a plugin change or a toast re-renders
 * only them and never the whole shell. Agent frames are read by the Builds graph's own nodes.
 */
import type { ComponentProps, JSX } from "react";
import { PluginsPanel } from "../panels/PluginsPanel.tsx";
import { PreviewPanel } from "../panels/PreviewPanel.tsx";
import { usePlugins, useToasts } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { ToastStack } from "../ui/Toast.tsx";

/** The stage, reading the plugins itself: a plugin change re-renders only the stage. */
export function StagePreview(props: Omit<ComponentProps<typeof PreviewPanel>, "plugins">): JSX.Element {
  const plugins = usePlugins((s) => s.list);
  return <PreviewPanel {...props} plugins={plugins} />;
}

/** The Plugins room, reading the plugin list, the index and Update plugins' run itself. */
export function PluginsRoom(
  props: Omit<ComponentProps<typeof PluginsPanel>, "plugins" | "index" | "updating">,
): JSX.Element {
  const plugins = usePlugins((s) => s.list);
  const index = usePlugins((s) => s.index);
  const updating = usePlugins((s) => s.updating);
  return <PluginsPanel {...props} plugins={plugins} index={index} updating={updating} />;
}

/** The toast stack, reading the toasts itself: a toast coming or going re-renders only the stack. */
export function Toasts(): JSX.Element | null {
  const toasts = useToasts((s) => s.items);
  return <ToastStack toasts={toasts} onDismiss={studio().toasts.dismiss} />;
}
