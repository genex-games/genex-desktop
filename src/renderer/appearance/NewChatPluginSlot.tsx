/** One normal-flow slot below the composer, never a portal or an app overlay. */
import { customizationProviders } from "../../shared/plugin-customization.ts";
import { usePlugins } from "../state/hooks.ts";
import { CustomizationPanel } from "./CustomizationPanel.tsx";
const MESSAGE = { Source: "Plugin" } as const;
/** Select one eligible declared panel deterministically, irrespective of plugin-list order. */
export function NewChatPluginSlot() {
  const owner = usePlugins(
    (state) =>
      customizationProviders(state.list)
        .filter(
          (p) =>
            p.customization?.newChat &&
            p.manifest.panels.some(
              (panel) => panel.id === p.customization?.newChat?.panel && panel.placement === "settings",
            ),
        )
        .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))[0] ?? null,
  );
  const slot = owner?.customization?.newChat;
  if (!owner || !slot) return null;
  const panel = owner.manifest.panels.find((entry) => entry.id === slot.panel);
  return (
    <section
      data-new-chat-plugin={owner.manifest.id}
      className="new-chat-plugin"
      aria-label={`${MESSAGE.Source}: ${owner.manifest.name}`}
    >
      <header className="new-chat-plugin-source">
        <span>
          {MESSAGE.Source}: {owner.manifest.name}
        </span>
        <span>{panel?.title}</span>
      </header>
      <div className="new-chat-plugin-content" style={{ height: slot.height }}>
        <CustomizationPanel
          key={`${owner.manifest.id}/${owner.manifest.version}/${slot.panel}`}
          id={owner.manifest.id}
          panel={slot.panel}
        />
      </div>
    </section>
  );
}
