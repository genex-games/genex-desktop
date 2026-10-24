/** One plugin's page: its setup card, actions, settings form, open panel, connections, skills and what it is. */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { LOCAL_BLENDER_PLUGIN_ID } from "../../../shared/local-blender.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { BlenderDoes, BlenderRuntimeCard } from "./BlenderRuntime.tsx";
import { InstalledSteps } from "./CatalogDetail.tsx";
import {
  Information,
  OpenPanelSection,
  PluginNotes,
  PluginSkills,
  type SettingValues,
  SettingsFields,
  UpdateButton,
} from "./detail-parts.tsx";
import { GenexDetail } from "./genex/GenexDetail.tsx";
import { hasOwnPage, isActive, isOffList } from "./labels.ts";
import type { OpenPanel, PluginsPage } from "./page.ts";
import { PluginConnections } from "./PluginConnections.tsx";
import { AccountStep, ReinstallButton, Section } from "./rows.tsx";
import type { ShownSkill } from "./skills-sections.ts";

export type { SettingValues } from "./detail-parts.tsx";

/** Local Blender's page leads with Studio's own setup card instead of the plugin's frame. */
const isLocalBlender = (p: PluginInfo): boolean => p.manifest.id === LOCAL_BLENDER_PLUGIN_ID;

/** An installed plugin's own actions: its panels (unless Studio draws that setup itself) and its settings. */
function InstalledActions({
  detail,
  page,
  selected,
  onSettings,
}: {
  detail: PluginInfo;
  page: PluginsPage;
  selected: OpenPanel | null;
  onSettings: (values: SettingValues) => void;
}): JSX.Element {
  const { manifest } = detail;
  const panels = isLocalBlender(detail) ? [] : manifest.panels;
  return (
    <>
      {detail.enabled &&
        panels
          .filter((panel) => panel.placement === "settings" || page.project)
          .map((panel) => (
            <Button
              key={panel.id}
              disabled={page.busy}
              aria-pressed={selected?.document.title === panel.title}
              onClick={() =>
                void page.act(async () =>
                  page.setSelected({
                    id: manifest.id,
                    document: await window.studio.pluginPanel(manifest.id, panel.id),
                  }),
                )
              }
            >
              {panel.title}
            </Button>
          ))}
      {detail.enabled && manifest.settings.length > 0 && (
        <Button
          disabled={page.busy}
          onClick={() => void page.act(async () => onSettings(await window.studio.pluginSettings(manifest.id)))}
        >
          {t("Settings")}
        </Button>
      )}
    </>
  );
}

interface DetailProps {
  detail: PluginInfo;
  page: PluginsPage;
  selected: OpenPanel | null;
  selectedPlugin: PluginInfo | undefined;
  settings: SettingValues | undefined;
  onSettings: (update: (values: SettingValues | undefined) => SettingValues) => void;
  onSkill: (skill: ShownSkill) => void;
}

/** One plugin's page, below its title. Genex, installed and allowed, has a page of its own. */
export function PluginDetail(props: DetailProps): JSX.Element {
  const { detail } = props;
  if (hasOwnPage(detail)) return <GenexDetail detail={detail} page={props.page} onSkill={props.onSkill} />;
  return <GenericDetail {...props} />;
}

function GenericDetail({
  detail,
  page,
  selected,
  selectedPlugin,
  settings,
  onSettings,
  onSkill,
}: DetailProps): JSX.Element {
  const blender = isLocalBlender(detail);
  return (
    <>
      <PluginNotes detail={detail} />
      {blender && isActive(detail) && <BlenderRuntimeCard plugin={detail} />}
      <div className="extensions-detail-actions">
        <AccountStep plugin={detail} page={page} />
        <UpdateButton detail={detail} page={page} />
        {isOffList(detail) ? (
          <ReinstallButton plugin={detail} page={page} />
        ) : (
          <InstalledActions
            detail={detail}
            page={page}
            selected={selected}
            onSettings={(values) => onSettings(() => values)}
          />
        )}
      </div>
      {detail.enabled && settings && (
        <Section title={t("Settings")}>
          <SettingsFields
            detail={detail}
            page={page}
            values={settings}
            onSaved={(key, value) => onSettings((values) => ({ ...values, [key]: value }))}
          />
        </Section>
      )}
      {selected && selectedPlugin && (
        <OpenPanelSection selected={selected} selectedPlugin={selectedPlugin} page={page} />
      )}
      {blender && <BlenderDoes />}
      <InstalledSteps manifest={detail.manifest} />
      <PluginConnections plugin={detail} page={page} />
      <PluginSkills detail={detail} onSkill={onSkill} />
      <Information detail={detail} page={page} />
    </>
  );
}
