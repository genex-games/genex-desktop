/** The parts every plugin's page shares: its More menu, settings form, open panel, skills and what it is. */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import { t } from "../../../shared/i18n.ts";
import { PluginSourceKind, type PluginInfo, type PluginManifest } from "../../../shared/plugins.ts";
import { installPluginUpdate } from "../../state/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/kit.tsx";
import { PLUGINS_WORDS, SKILLS_WORDS, consentToolWords } from "../../words.ts";
import { PluginPanelHost } from "../PluginPanelHost.tsx";
import { capabilityLine, foldersLine, localAccessNote, shownName, sourceWords } from "./labels.ts";

const PAGE = PLUGINS_WORDS.page;
import type { OpenPanel, PluginsPage } from "./page.ts";
import { Mark, Section } from "./rows.tsx";
import { type ShownSkill, shownPluginSkill, skillChangeWords } from "./skills-sections.ts";

/** A plugin's saved setting values, by setting key. */
export type SettingValues = Record<string, unknown>;

type Setting = PluginManifest["settings"][number];

const INPUT_TYPE: Record<Setting["type"], string> = { boolean: "checkbox", number: "number", string: "text" };

/** A setting's new value from its input: checked for a switch, a number for a number, else the text. */
function settingValue(setting: Setting, input: HTMLInputElement): boolean | number | string {
  if (setting.type === "boolean") return input.checked;
  if (setting.type === "number") return Number(input.value);
  return input.value;
}

/**
 * The More menu beside a plugin's title: watch a local plugin's folder, or remove the plugin. Genex
 * holds the app's account, so it is turned off, never removed (the registry refuses): it has none.
 */
export function MoreActions({ detail, page }: { detail: PluginInfo; page: PluginsPage }): JSX.Element | null {
  const { manifest } = detail;
  const watchWords = detail.watching ? t("Stop watching folder") : t("Watch folder");
  const watchLabel = detail.watching
    ? t("Stop watching folder for {name}", { name: manifest.name })
    : t("Watch folder for {name}", { name: manifest.name });
  const watchable = detail.enabled && detail.origin?.kind === PluginSourceKind.Local;
  const removable = manifest.id !== GENEX_PLUGIN_ID;
  if (!watchable && !removable) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("More actions for {name}", { name: manifest.name })}>
          <Icon name="more" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {watchable && (
          <DropdownMenuItem
            aria-label={watchLabel}
            onSelect={() => void page.act(() => window.studio.pluginWatch(manifest.id, !detail.watching))}
          >
            {watchWords}
          </DropdownMenuItem>
        )}
        {removable && (
          <DropdownMenuItem
            onSelect={() =>
              void page.act(async () => {
                page.setSelected(null);
                await window.studio.pluginRemove(manifest.id);
              })
            }
          >
            {t("Remove plugin")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A plugin's settings as labelled fields; each change saves at once. `labels` renames settings by key. */
export function SettingsFields({
  detail,
  page,
  values,
  onSaved,
  labels = {},
}: {
  detail: PluginInfo;
  page: PluginsPage;
  values: SettingValues;
  onSaved: (key: string, value: unknown) => void;
  labels?: Readonly<Record<string, string>>;
}): JSX.Element {
  const { manifest } = detail;
  return (
    <>
      {manifest.settings.map((s) => {
        const boolean = s.type === "boolean";
        const label = labels[s.key] ?? s.label;
        return (
          <label key={s.key} className="extension-setting">
            <span>{label}</span>
            <input
              aria-label={label}
              type={INPUT_TYPE[s.type]}
              checked={boolean ? Boolean(values[s.key]) : undefined}
              value={boolean ? undefined : String(values[s.key] ?? "")}
              onChange={(e) => {
                const value = settingValue(s, e.target);
                void page.act(async () => {
                  await window.studio.pluginSetSetting(manifest.id, s.key, value);
                  onSaved(s.key, value);
                });
              }}
            />
          </label>
        );
      })}
    </>
  );
}

/** The open plugin panel in its sandboxed frame, with a Close button. */
export function OpenPanelSection({
  selected,
  selectedPlugin,
  page,
}: {
  selected: OpenPanel;
  selectedPlugin: PluginInfo;
  page: PluginsPage;
}): JSX.Element {
  return (
    <Section
      title={selected.document.title}
      action={<IconButton icon="close" label={t("Close plugin panel")} onClick={() => page.setSelected(null)} />}
    >
      <PluginPanelHost
        plugin={selectedPlugin}
        document={selected.document}
        project={page.project}
        className="extension-frame"
      />
    </Section>
  );
}

/** A plugin's skills: one line about them, and the list itself behind Show all. */
export function PluginSkills({
  detail,
  onSkill,
}: {
  detail: PluginInfo;
  onSkill: (skill: ShownSkill) => void;
}): JSX.Element | null {
  const { manifest } = detail;
  const [open, setOpen] = useState(false);
  if (!manifest.skills.length) return null;
  const change = skillChangeWords(detail.lastSkillChange);
  return (
    <Section title={t("Skills")} count={manifest.skills.length}>
      {change && (
        <p className="mb-3 text-sm text-ink-3" data-skill-change>
          {t("{lastChange}: {change}", { lastChange: SKILLS_WORDS.lastChange, change })}
        </p>
      )}
      <div className="extension-skills-line">
        <p>{PAGE.skillsLine(shownName(detail))}</p>
        <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
          {open ? PAGE.showFewer : PAGE.showAll}
          <Icon name="chevron-down" size={14} className={open ? "rotate-180" : ""} />
        </Button>
      </div>
      {open && (
        <div className="extensions-grid">
          {manifest.skills.map((s) => (
            <button
              key={s.name}
              type="button"
              className="extension-open"
              onClick={() => onSkill(shownPluginSkill(manifest.id, s))}
            >
              <Mark kind="box" />
              <span className="extension-name">{s.name}</span>
              <Icon name="chevron-right" className="ml-auto text-icon" />
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

/** A local plugin's tools the person always allowed, and the button that makes them ask again. */
function AllowedTools({ detail, page }: { detail: PluginInfo; page: PluginsPage | undefined }): JSX.Element | null {
  const tools = detail.allowedTools ?? [];
  if (!page || !tools.length) return null;
  return (
    <span className="extension-description" data-always-allowed="">
      {PAGE.alwaysAllowed(tools.map((tool) => consentToolWords(tool)).join(", "))}{" "}
      <Button
        variant="ghost"
        disabled={page.busy}
        onClick={() => void page.act(() => window.studio.pluginForgetAllowed(detail.manifest.id))}
      >
        {PAGE.askEveryTime}
      </Button>
    </span>
  );
}

/** What the plugin is: who makes it, which version from where, what it can do, where outside your games it writes, and what the scan saw. */
export function Information({ detail, page }: { detail: PluginInfo; page?: PluginsPage }): JSX.Element {
  const { manifest, scan } = detail;
  const bundled = detail.source === PluginSourceKind.Bundled;
  return (
    <Section title={PAGE.information}>
      <dl className="extension-information">
        <dt>{PAGE.developer}</dt>
        <dd>{manifest.publisher}</dd>
        <dt>{PAGE.version}</dt>
        <dd>{bundled ? PAGE.bundled(manifest.version) : PAGE.from(manifest.version, sourceWords(detail))}</dd>
        <dt>{PAGE.can}</dt>
        <dd>{capabilityLine(manifest)}</dd>
        {manifest.folders?.length ? (
          <>
            <dt>{PAGE.folders}</dt>
            <dd>{foldersLine(manifest)}</dd>
          </>
        ) : null}
        {scan && !bundled && (
          <>
            <dt>{PAGE.scan}</dt>
            <dd>
              {t("Scan: {verdict, select, safe {safe} caution {caution} dangerous {dangerous} other {{verdict}}}", {
                verdict: scan.verdict,
              })}
              {scan.findings.length
                ? ` · ${t("{count, plural, other {# findings}}", { count: scan.findings.length })}`
                : ""}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-6 text-xs text-ink-3">{localAccessNote(detail) ?? PAGE.trusted}</p>
      <AllowedTools detail={detail} page={page} />
    </Section>
  );
}

/** The plugin's problems above its page: its error and an update that waits for sessions to end. */
export function PluginNotes({ detail }: { detail: PluginInfo }): JSX.Element {
  return (
    <>
      {detail.error && (
        <p role="alert" className="extensions-error">
          {detail.error}
        </p>
      )}
      {detail.pendingVersion && (
        <p className="text-sm text-orange">
          {t("Update {version} waits for active sessions.", { version: detail.pendingVersion })}
        </p>
      )}
    </>
  );
}

/** Update to the plugin's newer version, when there is one and none is already waiting. */
export function UpdateButton({ detail, page }: { detail: PluginInfo; page: PluginsPage }): JSX.Element | null {
  const update = page.updates.get(detail.manifest.id);
  if (!update) return null;
  return (
    <Button disabled={page.busy} onClick={() => void page.act(() => installPluginUpdate(window.studio, update))}>
      {t("Update to {version}", { version: update.version })}
    </Button>
  );
}
