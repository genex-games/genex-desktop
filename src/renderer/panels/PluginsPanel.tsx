/**
 * Host-owned integrations page. Lifecycle, trust and account actions use the existing APIs.
 *
 * The page's parts live in `plugins/`: the toolbar, the Plugins and Skills tabs, a plugin's own
 * page, the rows and buttons they share, and the page's state (`page.ts`).
 */
import type { JSX, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LOCAL_BLENDER_PLUGIN_ID } from "../../shared/local-blender.ts";
import type { PluginIndexView, PluginInfo } from "../../shared/plugins.ts";
import { pluginUpdates } from "../state/plugins.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { IconButton } from "../ui/kit.tsx";
import type { ConnectorActions } from "./ConnectorsCard.tsx";
import { PluginsToolbar } from "./plugins/header.tsx";
import {
  ExtensionsTab,
  hasOwnPage,
  isActive,
  isOffList,
  PLUGIN_GUIDE_URL,
  SEARCH_LABEL,
  shownIntro,
  shownName,
  TAB_INTRO,
  TAB_LABEL,
} from "./plugins/labels.ts";
import {
  type OpenPanel,
  type PluginsPage,
  useBusyAction,
  usePluginsPageData,
  useProviderSkills,
} from "./plugins/page.ts";
import { MoreActions } from "./plugins/detail-parts.tsx";
import { PluginDetail, type SettingValues } from "./plugins/PluginDetail.tsx";
import { PluginsBrowse } from "./plugins/PluginsBrowse.tsx";
import { Mark, PluginPicture, PluginToggle, Section } from "./plugins/rows.tsx";
import { SkillsBrowse } from "./plugins/SkillsBrowse.tsx";
import type { ShownSkill } from "./plugins/skills-sections.ts";
import { useAsyncEffect } from "../use-async-effect.ts";
import { PLUGINS_WORDS, SKILLS_WORDS } from "../words.ts";
import { GithubInstallDialog } from "./plugins/GithubInstallDialog.tsx";

interface Props {
  project?: string | null;
  setupPlugin?: string;
  plugins: PluginInfo[];
  /** The plugin index as the store last read it, or null before its first answer. */
  index: PluginIndexView | null;
  /** The sidebar's Update plugins is running: the page starts no action of its own meanwhile. */
  updating: boolean;
  onPluginsRefresh: () => void;
  onIndexRefresh: () => void;
  onBack: () => void;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
}

/** Where the page is: its tab and search, the plugin or skill on show, the open plugin panel, the GitHub window. */
function useNavigation(setError: (error: string) => void) {
  const [tab, setTab] = useState<ExtensionsTab>(ExtensionsTab.Plugins);
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [skill, setSkill] = useState<ShownSkill | null>(null);
  const [selected, setSelected] = useState<OpenPanel | null>(null);
  const [github, setGithub] = useState(false);
  const openPlugin = (id: string): void => {
    setError("");
    setDetailId(id);
    setSkill(null);
    setSelected(null);
  };
  const browse = (): void => {
    setError("");
    setDetailId(null);
    setSkill(null);
    setSelected(null);
  };
  const changeTab = (next: ExtensionsTab): void => {
    setTab(next);
    setQuery("");
    browse();
  };
  return {
    tab,
    setTab,
    query,
    setQuery,
    detailId,
    skill,
    setSkill,
    selected,
    setSelected,
    github,
    setGithub,
    openPlugin,
    browse,
    changeTab,
  };
}
type Navigation = ReturnType<typeof useNavigation>;

/** Opening the page to set a plugin up shows that plugin and, when it has one, its settings panel. */
function useSetupPlugin(
  setupPlugin: string | undefined,
  plugins: PluginInfo[],
  nav: Navigation,
  setError: (error: string) => void,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: each setup request opens once, with the plugin list of that moment
  useEffect(() => {
    if (!setupPlugin) return;
    nav.openPlugin(setupPlugin);
    const plugin = plugins.find((p) => p.manifest.id === setupPlugin && isActive(p));
    // Local Blender's page leads with Studio's own setup card; its frame is not opened over it.
    const drawn = setupPlugin === LOCAL_BLENDER_PLUGIN_ID;
    const panel = drawn ? undefined : plugin?.manifest.panels.find((p) => p.placement === "settings");
    let disposed = false;
    if (panel)
      void window.studio
        .pluginPanel(setupPlugin, panel.id)
        .then((document) => {
          if (!disposed) nav.setSelected({ id: setupPlugin, document });
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, [setupPlugin]);
}

/** The line under the page title: the skill's source, the plugin's description, or what the tab is for. */
function pageIntro(nav: Navigation, detail: PluginInfo | undefined, plugins: PluginInfo[]): string | undefined {
  const { skill } = nav;
  if (skill) {
    if (skill.provider) return skill.provider;
    if (!skill.plugin) return SKILLS_WORDS.studioTitle;
    return plugins.find((p) => p.manifest.id === skill.plugin)?.manifest.name;
  }
  return detail ? shownIntro(detail) : TAB_INTRO[nav.tab];
}

/** A file skill's text, read from its plugin when its page opens; an inline skill already has it. */
function useSkillText(skill: ShownSkill): { text: string | undefined; error: string } {
  const [read, setRead] = useState<{ text?: string; error: string }>({ error: "" });
  useAsyncEffect(
    (alive) => {
      setRead({ error: "" });
      if (!skill.onDemand) return;
      window.studio.pluginSkillText(skill.plugin, skill.name).then(
        (text) => alive() && setRead({ text, error: "" }),
        (e) => alive() && setRead({ error: String(e) }),
      );
    },
    [skill.plugin, skill.name, skill.onDemand],
  );
  return { text: skill.text ?? read.text, error: read.error };
}

function SkillView({ skill, onViewPlugin }: { skill: ShownSkill; onViewPlugin: (id: string) => void }): JSX.Element {
  const { text, error } = useSkillText(skill);
  return (
    <>
      {skill.onDemand && (
        <p className="text-sm text-ink-3" data-skill-on-demand>
          {SKILLS_WORDS.onDemand}
        </p>
      )}
      <Section title={skill.provider ? "Skill details" : "Instructions"}>
        {error && (
          <p role="alert" className="extensions-error">
            {error}
          </p>
        )}
        <pre className="skill-instructions">{text ?? SKILLS_WORDS.loadingFile}</pre>
      </Section>
      {skill.plugin && <Button onClick={() => onViewPlugin(skill.plugin)}>View plugin</Button>}
    </>
  );
}

function SearchField({ nav }: { nav: Navigation }): JSX.Element {
  const label = SEARCH_LABEL[nav.tab];
  return (
    <label className="extensions-search">
      <Icon name="search" size={18} />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={nav.query}
        onChange={(e) => nav.setQuery(e.target.value)}
      />
      {nav.query && <IconButton icon="close" label="Clear search" onClick={() => nav.setQuery("")} />}
    </label>
  );
}

/** A new tab, plugin or skill starts at the top of the page, with its heading focused. */
function usePageTop(nav: Navigation) {
  const heading = useRef<HTMLHeadingElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
    heading.current?.focus({ preventScroll: true });
  }, [nav.tab, nav.detailId, nav.skill]);
  return { heading, scroll };
}

/** The plugin whose panel is open; the panel closes once its plugin is turned off or removed. */
function useOpenPanelPlugin(nav: Navigation, plugins: PluginInfo[]): PluginInfo | undefined {
  const { selected, setSelected } = nav;
  const selectedPlugin = selected ? plugins.find((p) => p.manifest.id === selected.id && isActive(p)) : undefined;
  useEffect(() => {
    if (selected && !selectedPlugin) setSelected(null);
  }, [selected, selectedPlugin, setSelected]);
  return selectedPlugin;
}

/** What the Skills tab's refresh and the Add menu do; an Add item that works on the Plugins tab goes there first. */
function toolbarActions({
  nav,
  act,
  skills,
  connectorActions,
  afterMenu,
}: {
  nav: Navigation;
  act: PluginsPage["act"];
  skills: ReturnType<typeof useProviderSkills>;
  connectorActions: RefObject<ConnectorActions | null>;
  afterMenu: RefObject<(() => void) | null>;
}) {
  const toPluginsTab = (then: () => void): void => {
    nav.changeTab(ExtensionsTab.Plugins);
    afterMenu.current = then;
  };
  const refresh = (): void => void skills.refreshSkills();
  const add = {
    installFromGithub: () => nav.setGithub(true),
    addServer: () => toPluginsTab(() => connectorActions.current?.add()),
    importConfig: () => toPluginsTab(() => connectorActions.current?.import()),
    createPlugin: () => void window.studio.openUrl(PLUGIN_GUIDE_URL),
    loadLocal: () => void act(() => window.studio.pluginInstall()),
  };
  return { refresh, add };
}

export function PluginsPanel({
  setupPlugin,
  project,
  plugins,
  index,
  updating,
  onPluginsRefresh,
  onIndexRefresh,
  onBack,
  sidebarHidden,
  onToggleSidebar,
}: Props): JSX.Element {
  const action = useBusyAction(onPluginsRefresh);
  const { error, setError, act } = action;
  const busy = action.busy || updating;
  const data = usePluginsPageData(project, onPluginsRefresh, onIndexRefresh, setError);
  const updates = useMemo(
    () => new Map(pluginUpdates(plugins, index).map((update) => [update.plugin.manifest.id, update])),
    [plugins, index],
  );
  const nav = useNavigation(setError);
  const skills = useProviderSkills(nav.tab, project, setError);
  const [settings, setSettings] = useState<Record<string, SettingValues>>({});
  const connectorActions = useRef<ConnectorActions>(null);
  const afterMenu = useRef<(() => void) | null>(null);
  const { heading, scroll } = usePageTop(nav);
  const detail = plugins.find((p) => p.manifest.id === nav.detailId);
  // Genex's page shows the failure inside its account card instead of above it.
  const ownPage = detail !== undefined && hasOwnPage(detail);
  const selectedPlugin = useOpenPanelPlugin(nav, plugins);
  useSetupPlugin(setupPlugin, plugins, nav, setError);
  const page: PluginsPage = {
    busy,
    error,
    act,
    project,
    connections: data.connections,
    setConnections: data.setConnections,
    updates,
    openPlugin: nav.openPlugin,
    setSelected: nav.setSelected,
    matches: (...values: string[]) =>
      values.join(" ").toLocaleLowerCase().includes(nav.query.trim().toLocaleLowerCase()),
  };
  const toolbar = toolbarActions({ nav, act, skills, connectorActions, afterMenu });
  // TODO(extensions): add marketplace-source management and skill recording only after host APIs
  // exist. The reference's unsupported actions must not become inert controls.
  // Skill discovery is read-only; activation stays with each provider.
  return (
    <section data-plugins-page aria-label="Studio plugins" className="extensions-page">
      <PluginsToolbar
        tab={nav.tab}
        sidebarHidden={sidebarHidden}
        refreshing={busy || skills.skillsLoading}
        afterMenu={afterMenu}
        onToggleSidebar={onToggleSidebar}
        onTab={nav.changeTab}
        onRefresh={toolbar.refresh}
        add={toolbar.add}
      />
      <div ref={scroll} className="extensions-scroll">
        <div className={`extensions-content ${detail || nav.skill ? "extensions-content-detail" : ""}`}>
          <PageHeading nav={nav} detail={detail} plugins={plugins} page={page} heading={heading} onBack={onBack} />
          {error && !ownPage && (
            <p role="alert" className="extensions-error">
              {error}
            </p>
          )}
          <PageBody
            nav={nav}
            page={page}
            detail={detail}
            plugins={plugins}
            selectedPlugin={selectedPlugin}
            settings={settings}
            onSettings={setSettings}
            data={data}
            index={index}
            skills={skills}
            connectorActions={connectorActions}
          />
        </div>
      </div>
      {nav.github && (
        <GithubInstallDialog
          onClose={() => nav.setGithub(false)}
          onInstalled={(id) => {
            nav.setGithub(false);
            nav.setTab(ExtensionsTab.Plugins);
            nav.openPlugin(id);
            onPluginsRefresh();
          }}
        />
      )}
    </section>
  );
}

/** The back button, the mark, the title with the plugin's switch, and the intro line. */
function PageHeading({
  nav,
  detail,
  plugins,
  page,
  heading,
  onBack,
}: {
  nav: Navigation;
  detail: PluginInfo | undefined;
  plugins: PluginInfo[];
  page: PluginsPage;
  heading: RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
}): JSX.Element {
  const { skill } = nav;
  const inside = Boolean(detail || skill);
  const shownPlugin = detail && !skill ? detail : null;
  return (
    <>
      <Button className="extensions-back" onClick={inside ? nav.browse : onBack}>
        <Icon name="chevron-left" size={14} />
        {inside ? TAB_LABEL[nav.tab] : PLUGINS_WORDS.back}
      </Button>
      {shownPlugin && <PluginPicture plugin={shownPlugin} size="large" />}
      {skill && <Mark large kind="box" />}
      <div className="extensions-title-row">
        <h1 ref={heading} tabIndex={-1}>
          {skill?.name ?? (detail ? shownName(detail) : TAB_LABEL[nav.tab])}
        </h1>
        {shownPlugin && !isOffList(shownPlugin) && (
          <div className="extensions-title-actions">
            <MoreActions detail={shownPlugin} page={page} />
            <PluginToggle plugin={shownPlugin} page={page} />
          </div>
        )}
      </div>
      <p className="extensions-intro">{pageIntro(nav, detail, plugins)}</p>
    </>
  );
}

/** What the page shows below its heading: a skill, a plugin, or the tab's lists. */
function PageBody({
  nav,
  page,
  detail,
  plugins,
  selectedPlugin,
  settings,
  onSettings,
  data,
  index,
  skills,
  connectorActions,
}: {
  nav: Navigation;
  page: PluginsPage;
  detail: PluginInfo | undefined;
  plugins: PluginInfo[];
  selectedPlugin: PluginInfo | undefined;
  settings: Record<string, SettingValues>;
  onSettings: (update: (all: Record<string, SettingValues>) => Record<string, SettingValues>) => void;
  data: ReturnType<typeof usePluginsPageData>;
  index: PluginIndexView | null;
  skills: ReturnType<typeof useProviderSkills>;
  connectorActions: RefObject<ConnectorActions | null>;
}): JSX.Element {
  if (nav.skill)
    return (
      <SkillView
        skill={nav.skill}
        onViewPlugin={(id) => {
          nav.setTab(ExtensionsTab.Plugins);
          nav.openPlugin(id);
        }}
      />
    );
  if (detail) {
    const id = detail.manifest.id;
    return (
      <PluginDetail
        detail={detail}
        page={page}
        selected={nav.selected}
        selectedPlugin={selectedPlugin}
        settings={settings[id]}
        onSettings={(update) => onSettings((all) => ({ ...all, [id]: update(all[id]) }))}
        onSkill={nav.setSkill}
      />
    );
  }
  return (
    <>
      <SearchField nav={nav} />
      {nav.tab === ExtensionsTab.Plugins ? (
        <PluginsBrowse
          plugins={plugins}
          page={page}
          query={nav.query}
          catalog={data.catalog}
          index={index}
          connectorActions={connectorActions}
        />
      ) : (
        <SkillsBrowse
          plugins={plugins}
          page={page}
          query={nav.query}
          builtins={data.builtins}
          game={skills.game}
          providerInventory={skills.providerInventory}
          skillsLoading={skills.skillsLoading}
          onSkill={nav.setSkill}
        />
      )}
    </>
  );
}
