/** Disposable browser fixture: real host integration and SDK bridge, no provider or native account. */
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PluginCustomizationHost } from "../../src/renderer/appearance/PluginCustomizationHost.tsx";
import { initializeAppearance, updateAppearance, useAppearance } from "../../src/renderer/appearance/store.ts";
import { PluginPanelHost } from "../../src/renderer/panels/PluginPanelHost.tsx";
import { AppearanceSection } from "../../src/renderer/panels/AppearanceSection.tsx";
import { NewChatPluginSlot } from "../../src/renderer/appearance/NewChatPluginSlot.tsx";
import { Button } from "../../src/renderer/ui/Button.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import { parsePluginCustomization, type PluginCustomization } from "../../src/shared/plugin-customization.ts";
import { PluginCapability, PluginSourceKind, PluginHealth, type PluginInfo } from "../../src/shared/plugins.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

let saved: PluginCustomization | null = null;
let enabled = true;
let showAppearance = false;
const plugin = (): PluginInfo => ({
  manifest: {
    apiVersion: 3,
    id: "theme",
    version: "1.0.0",
    name: "Fixture theme",
    publisher: "Fixture",
    description: "Disposable API fixture",
    backend: "backend.mjs",
    tools: [],
    actions: [],
    skills: [],
    settings: [],
    panels: [{ id: "widget", title: "Fixture widget", file: "widget.html", placement: "settings" }],
    capabilities: [PluginCapability.UiCustomization],
  },
  enabled,
  removed: false,
  state: "enabled",
  health: PluginHealth.Ready,
  source: PluginSourceKind.Local,
  ...(saved ? { customization: saved } : {}),
});
let redraw = () => {};
const fake = fakeStudioApi({
  pluginPanel: async (id, panel) => {
    if (id !== "theme" || panel !== "widget" || !enabled) throw new Error("Undeclared panel");
    return { url: "studio-plugin://theme/widget", title: "Custom widget", html: "" };
  },
  pluginsList: async () => [plugin()],
  pluginCustomization: async (id) => {
    if (id !== "theme" || !enabled) throw new Error("UI customization capability required");
    return saved;
  },
  pluginSetCustomization: async (id, value) => {
    if (id !== "theme" || !enabled) throw new Error("UI customization capability required");
    saved = value === null ? null : parsePluginCustomization(value);
    await studio().plugins.refresh();
    redraw();
  },
});
window.studio = fake.api;
initializeAppearance();
await studio().plugins.refresh();
function Fixture() {
  const [, update] = useState(0);
  const { appearance, update: change } = useAppearance();
  redraw = () => update((previous) => previous + 1);
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "auto", height: "100vh", overflowY: "auto" }}>
      <nav style={{ display: "flex", gap: 8 }}>
        <Button id="native-control">New game</Button>
        <Button>Plugins</Button>
        <Button>Settings</Button>
      </nav>
      <div
        id="new-chat"
        style={{ margin: "24px 0", padding: 16, border: "1px solid var(--border)", background: "var(--field)" }}
      >
        <label htmlFor="native-prompt">What do you want to make?</label>
        <textarea id="native-prompt" style={{ display: "block", width: "100%", height: 70 }} />
      </div>
      <NewChatPluginSlot />
      <Button id="choose-theme" onClick={() => change((prev) => ({ ...prev, pluginTheme: "theme" }))}>
        Choose offered theme
      </Button>
      <Button id="set-light" onClick={() => change((prev) => ({ ...prev, mode: "light" }))}>
        Light
      </Button>
      <p id="chosen-theme">{appearance.pluginTheme ?? "built-in"}</p>
      <PluginPanelHost
        plugin={plugin()}
        document={{ url: "studio-plugin://theme/editor", title: "Test plugin", html: "" }}
        project={null}
        className="w-full h-[170px] border border-line"
      />
      {showAppearance && <AppearanceSection />}
      <PluginCustomizationHost />
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
Object.assign(window, {
  customizationFixture: {
    appearance: (next: boolean) => {
      showAppearance = next;
      redraw();
    },
    mode: (mode: "light" | "dark") => updateAppearance((prev) => ({ ...prev, mode })),
    select: (id: string | undefined) => updateAppearance((prev) => ({ ...prev, pluginTheme: id })),
    enable: async (next: boolean) => {
      enabled = next;
      await studio().plugins.refresh();
      redraw();
    },
    refresh: () => studio().plugins.refresh(),
    profile: () => saved,
  },
});
