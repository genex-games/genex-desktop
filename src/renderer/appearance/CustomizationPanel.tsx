/** Mount a plugin's declared panel inside the New Chat box, retaining its ordinary isolation and approval flow. */
import { useEffect, useState } from "react";
import type { PluginPanelDocument } from "../../shared/plugins.ts";
import { usePlugins } from "../state/hooks.ts";
import { PluginPanelHost } from "../panels/PluginPanelHost.tsx";
const MESSAGE = { Failed: "The plugin panel could not be loaded." } as const;
/** Only host-reviewed settings panels can be selected by a saved customization profile. */
export function CustomizationPanel({ id, panel }: { id: string; panel: string }) {
  const plugin = usePlugins((state) => state.list.find((entry) => entry.manifest.id === id) ?? null);
  const [document, setDocument] = useState<PluginPanelDocument | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    setDocument(null);
    setFailed(false);
    void window.studio
      .pluginPanel(id, panel)
      .then((next) => {
        if (!disposed) setDocument(next);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [id, panel]);
  if (failed) return <p>{MESSAGE.Failed}</p>;
  const allowed = plugin?.manifest.panels.some((entry) => entry.id === panel && entry.placement === "settings");
  if (!plugin || !document || !allowed) return null;
  return <PluginPanelHost plugin={plugin} document={document} project={null} className="h-full w-full border-0" />;
}
