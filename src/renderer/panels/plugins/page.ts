import { UiEvent } from "../../../shared/ui-events.ts";
/** The plugins page's shared state: its busy action runner, the data it polls, and the provider skills it reads on demand. */
import { useEffect, useRef, useState } from "react";
import type { ConnectionSnapshot } from "../../../shared/connections.ts";
import type { McpConnectorView } from "../../../shared/mcp.ts";
import type { PluginPanelDocument } from "../../../shared/plugins.ts";
import type { ProjectSkillInventory, ProviderSkillInventory } from "../../../shared/provider-skills.ts";
import type { PluginUpdate } from "../../state/plugins.ts";
import { ExtensionsTab, PLUGINS_POLL_MS } from "./labels.ts";

/** A plugin panel open on the page, and the plugin it belongs to. */
export interface OpenPanel {
  id: string;
  document: PluginPanelDocument;
}

/** What every part of the page needs to act: one action at a time, the project, and the page's navigation. */
export interface PluginsPage {
  busy: boolean;
  /** The last page action's failure; a page Studio draws itself shows it in place. */
  error: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  project: string | null | undefined;
  connections: ConnectionSnapshot | null;
  setConnections: (value: ConnectionSnapshot) => void;
  /** The newer version each installed plugin can move to, by plugin id. */
  updates: ReadonlyMap<string, PluginUpdate>;
  openPlugin: (id: string) => void;
  setSelected: (panel: OpenPanel | null) => void;
  matches: (...values: string[]) => boolean;
}

/** One plugin action at a time: busy while it runs, its error kept for the page, the plugin list re-read after. */
export function useBusyAction(onPluginsRefresh: () => void) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      acting.current = false;
      setBusy(false);
      onPluginsRefresh();
    }
  };
  return { error, setError, busy, act };
}

/** A catalog entry as the page lists it. */
export interface CatalogRow {
  id: string;
  name: string;
  version: string;
}

/**
 * What the page polls while open (plugins, connections, catalog) and reads once (Studio skills). The
 * plugin index is the store's: opening the page asks for it again.
 */
export function usePluginsPageData(
  project: string | null | undefined,
  onPluginsRefresh: () => void,
  onIndexRefresh: () => void,
  setError: (error: string) => void,
) {
  const [connections, setConnections] = useState<ConnectionSnapshot | null>(null);
  const [builtins, setBuiltins] = useState<Array<{ name: string; text: string; description: string }>>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  useEffect(() => {
    onIndexRefresh();
  }, [onIndexRefresh]);
  useEffect(() => {
    let disposed = false;
    const fail = (e: unknown): void => {
      if (!disposed) setError(String(e));
    };
    const update = (): void => {
      if (document.hidden) return;
      onPluginsRefresh();
      void window.studio
        .connections(undefined, project)
        .then((value) => {
          if (!disposed)
            setConnections((current) => (JSON.stringify(current) === JSON.stringify(value) ? current : value));
        })
        .catch(() => {});
      void window.studio
        .pluginsCatalog()
        .then((entries) => {
          if (!disposed)
            setCatalog((current) => {
              const next = entries.map((e) => ({
                id: e.manifest.id,
                name: e.manifest.name,
                version: e.manifest.version,
              }));
              return JSON.stringify(current) === JSON.stringify(next) ? current : next;
            });
        })
        .catch(fail);
    };
    update();
    void window.studio
      .studioSkills()
      .then((value) => {
        if (!disposed) setBuiltins(value);
      })
      .catch(fail);
    const timer = setInterval(update, PLUGINS_POLL_MS);
    document.addEventListener("visibilitychange", update);
    const unsubscribe = window.studio.onEvent((event) => {
      const changed =
        event.type === UiEvent.PluginsChanged ||
        event.type === UiEvent.ConnectionsChanged ||
        event.type === UiEvent.McpChanged;
      if (changed) update();
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      unsubscribe();
    };
  }, [onPluginsRefresh, project, setError]);
  return { connections, setConnections, builtins, catalog };
}

/**
 * The providers' own skills and the open game's, read the first time the Skills tab opens and again
 * on refresh; the latest read wins. The game's are read again when another game is open.
 */
export function useProviderSkills(
  tab: ExtensionsTab,
  project: string | null | undefined,
  setError: (error: string) => void,
) {
  const [providerInventory, setProviderInventory] = useState<ProviderSkillInventory[] | null>(null);
  const [game, setGame] = useState<ProjectSkillInventory | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const skillRequest = useRef(0);
  const gameRequest = useRef(0);
  const refreshGame = async (): Promise<void> => {
    const request = ++gameRequest.current;
    const value = project ? await window.studio.projectSkills(project).catch(() => null) : null;
    if (request === gameRequest.current) setGame(value);
  };
  const refreshSkills = async (): Promise<void> => {
    const request = ++skillRequest.current;
    const current = (): boolean => request === skillRequest.current;
    setSkillsLoading(true);
    void refreshGame();
    try {
      const value = await window.studio.providerSkills();
      if (current()) setProviderInventory(value);
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (current()) setSkillsLoading(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first visit to the Skills tab reads them; a refresh is the button's
  useEffect(() => {
    if (tab === ExtensionsTab.Skills && providerInventory === null) void refreshSkills();
  }, [tab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another open game has other skills; the tab's first visit reads the first
  useEffect(() => {
    if (tab === ExtensionsTab.Skills && providerInventory !== null) void refreshGame();
  }, [project]);
  useEffect(
    () => () => {
      skillRequest.current++;
      gameRequest.current++;
    },
    [],
  );
  return { providerInventory, game, skillsLoading, refreshSkills };
}

/** A plugin's own MCP servers as the host runs them now, read on open and whenever MCP or the plugin changes. */
export function usePluginServers(id: string, project: string | null | undefined): McpConnectorView[] {
  const [servers, setServers] = useState<McpConnectorView[]>([]);
  useEffect(() => {
    let disposed = false;
    const read = (): void => {
      void window.studio
        .mcpList(project)
        .then((all) => {
          if (disposed) return;
          const own = all.filter((view) => {
            const source = view.connector.source;
            return typeof source === "object" && source.plugin === id;
          });
          setServers((current) => (JSON.stringify(current) === JSON.stringify(own) ? current : own));
        })
        .catch(() => {});
    };
    read();
    const unsubscribe = window.studio.onEvent((event) => {
      const changed =
        event.type === UiEvent.McpChanged ||
        event.type === UiEvent.PluginsChanged ||
        event.type === UiEvent.ConnectionsChanged;
      if (changed) read();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [id, project]);
  return servers;
}
