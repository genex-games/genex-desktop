import { type JSX, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { EngineDescriptor } from "../types.ts";
import { SettingsSection } from "../settings-navigation.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { Icon, type IconName } from "../ui/icons.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { ModelProvidersSection, type ModelSettingsProps } from "./ModelsSection.tsx";
import { LocalModelsSection } from "./LocalModelsSection.tsx";
import { HarnessSection } from "./HarnessSection.tsx";
import { GamesSection } from "./GamesSection.tsx";
import { PermissionsSection } from "./PermissionsSection.tsx";
import { PrivacySection } from "./PrivacySection.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { ABOUT_WORDS, PRIVACY_WORDS } from "../words.ts";

interface SectionTab {
  id: SettingsSection;
  label: string;
  icon: IconName;
}

const SECTIONS: readonly SectionTab[] = [
  { id: SettingsSection.Providers, label: "Model Providers", icon: "globe" },
  { id: SettingsSection.Local, label: "Local Models", icon: "box" },
  { id: SettingsSection.Appearance, label: "Appearance", icon: "palette" },
  { id: SettingsSection.Games, label: "Games", icon: "folder" },
  { id: SettingsSection.Harness, label: "Harness", icon: "harness" },
  { id: SettingsSection.Permissions, label: "Permissions", icon: "shield" },
  { id: SettingsSection.Privacy, label: PRIVACY_WORDS.tab, icon: "eye" },
  { id: SettingsSection.About, label: ABOUT_WORDS.tab, icon: "info" },
];

/** The tab a key moves to from the tab at `index`: first, last, next or previous (wrapping), or none. */
function tabAfterKey(key: string, index: number): SectionTab | undefined {
  const count = SECTIONS.length;
  if (key === "Home") return SECTIONS[0];
  if (key === "End") return SECTIONS[count - 1];
  if (key === "ArrowDown" || key === "ArrowRight") return SECTIONS[(index + 1) % count];
  if (key === "ArrowUp" || key === "ArrowLeft") return SECTIONS[(index + count - 1) % count];
  return undefined;
}

/** The body of one settings section. */
function SectionBody({
  section,
  engines,
  onEnginesRefresh,
  gamesRootLabel,
  onGamesRoot,
}: {
  section: SettingsSection;
  engines: EngineDescriptor[];
  onEnginesRefresh: ModelSettingsProps["onEnginesRefresh"];
  gamesRootLabel: string;
  onGamesRoot: (label: string) => void;
}): JSX.Element {
  if (section === SettingsSection.Games) return <GamesSection rootLabel={gamesRootLabel} onRoot={onGamesRoot} />;
  if (section === SettingsSection.Appearance) return <AppearanceSection />;
  if (section === SettingsSection.Providers)
    return <ModelProvidersSection engines={engines} onEnginesRefresh={onEnginesRefresh} />;
  if (section === SettingsSection.Harness) return <HarnessSection />;
  if (section === SettingsSection.Permissions) return <PermissionsSection />;
  if (section === SettingsSection.Privacy) return <PrivacySection />;
  if (section === SettingsSection.About) return <AboutSection />;
  return <LocalModelsSection engines={engines} onEnginesRefresh={onEnginesRefresh} />;
}

/** Reference Genex settings layout, using the desktop dialog's focus and preview lifecycle. Its surfaces
 * match the app shell (sidebar + canvas) rather than a raised dialog, so Settings never reads lighter than the app. */
export function SettingsDialog({
  section,
  onSection,
  onDismiss,
  returnFocus,
  engines,
  onEnginesRefresh,
  gamesRootLabel,
  onGamesRoot,
}: {
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onDismiss: () => void;
  returnFocus?: React.RefObject<HTMLElement | null>;
  engines: EngineDescriptor[];
  onEnginesRefresh: ModelSettingsProps["onEnginesRefresh"];
  gamesRootLabel: string;
  onGamesRoot: (label: string) => void;
}) {
  const [horizontal, setHorizontal] = useState(() => window.matchMedia("(max-width: 639px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setHorizontal(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const selectedTab = useRef<HTMLButtonElement>(null);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabAfterKey(event.key, index);
    if (!next) return;
    event.preventDefault();
    onSection(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };
  return (
    <DialogSurface
      title="Settings"
      size="2xl"
      testId="settings-dialog"
      headerHidden
      className="settings-dialog overflow-hidden bg-background p-0"
      initialFocus={selectedTab}
      returnFocus={returnFocus}
      onDismiss={onDismiss}
    >
      <div className="settings-layout flex min-h-0 min-w-0 max-sm:flex-col">
        <nav
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 border-border/75 bg-(--sidebar) p-3 max-sm:overflow-x-auto max-sm:border-b max-sm:pr-14 sm:w-52 sm:flex-col sm:border-r sm:pb-6"
        >
          <p className="px-3 pt-1 pb-2 font-mono text-micro text-muted-foreground max-sm:hidden">Settings</p>
          <div
            role="tablist"
            aria-label="Settings sections"
            aria-orientation={horizontal ? "horizontal" : "vertical"}
            className="flex gap-1 sm:flex-col"
          >
            {SECTIONS.map((tab, index) => (
              <button
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={section === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={section === tab.id ? 0 : -1}
                ref={section === tab.id ? selectedTab : undefined}
                onClick={() => onSection(tab.id)}
                onKeyDown={(event) => navigate(event, index)}
                className={`flex items-center gap-2 rounded-control px-3 py-1.5 text-left font-mono text-sm whitespace-nowrap transition-colors duration-(--duration-quick) motion-reduce:transition-none ${section === tab.id ? "bg-accent-primary/12 text-[var(--settings-tab,var(--accent-ink))]" : "text-muted-foreground hover:bg-foreground/5 hover:text-control-text-hover"}`}
              >
                <Icon name={tab.icon} size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-content flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mt-3.5 flex min-h-8 shrink-0 items-center ps-5 pe-14">
            <h2 className="text-lg font-medium text-foreground">{SECTIONS.find((tab) => tab.id === section)?.label}</h2>
          </div>
          <div
            key={section}
            role="tabpanel"
            id={`settings-panel-${section}`}
            aria-labelledby={`settings-tab-${section}`}
            tabIndex={0}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pt-3 pb-6 text-body-sm"
          >
            <SectionBody
              section={section}
              engines={engines}
              onEnginesRefresh={onEnginesRefresh}
              gamesRootLabel={gamesRootLabel}
              onGamesRoot={onGamesRoot}
            />
          </div>
        </div>
      </div>
    </DialogSurface>
  );
}
