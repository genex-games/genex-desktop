/** The plugins page's toolbar: the sidebar button, the tabs, refresh and the Add menu. */
import type { JSX, RefObject } from "react";
import { t } from "../../../shared/i18n.ts";
import { Button } from "../../ui/Button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx";
import { Icon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/kit.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { EXTENSIONS_TABS, ExtensionsTab, REFRESH_LABEL, TAB_LABEL } from "./labels.ts";
import { SidebarToggle } from "../../shell/use-shell-chrome.ts";

/** What the Add menu can start: a GitHub install, an MCP server, the plugin guide, or a local plugin. */
export interface AddActions {
  installFromGithub: () => void;
  addServer: () => void;
  createPlugin: () => void;
  loadLocal: () => void;
}

const WORDS = PLUGINS_WORDS.add;

function AddMenu({
  actions,
  afterMenu,
}: {
  actions: AddActions;
  afterMenu: RefObject<(() => void) | null>;
}): JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t("Add integration")} variant="default">
          {t("Add")} <Icon name="chevron-down" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64"
        onCloseAutoFocus={(event) => {
          const next = afterMenu.current;
          if (next) {
            event.preventDefault();
            afterMenu.current = null;
            requestAnimationFrame(next);
          }
        }}
      >
        <DropdownMenuItem onSelect={actions.installFromGithub}>
          <Icon name="plus" />
          {WORDS.github}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={actions.addServer}>
          <Icon name="plugins" />
          {WORDS.server}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Making a plugin, then loading the folder to try it: the maker's pair. */}
        <DropdownMenuItem onSelect={actions.createPlugin}>
          <Icon name="code" />
          <span className="flex-1">{WORDS.create}</span>
          <Icon name="arrow-up-right" size={14} className="text-ink-3" />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={actions.loadLocal}>
          <Icon name="folder" />
          {WORDS.local}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The page's toolbar. */
export function PluginsToolbar({
  tab,
  sidebarHidden,
  refreshing,
  afterMenu,
  add,
  onToggleSidebar,
  onTab,
  onRefresh,
}: {
  tab: ExtensionsTab;
  sidebarHidden: boolean;
  refreshing: boolean;
  afterMenu: RefObject<(() => void) | null>;
  add: AddActions;
  onToggleSidebar: () => void;
  onTab: (tab: ExtensionsTab) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <header
      className={`extensions-toolbar titlebar-drag window-controls-end ${sidebarHidden ? "extensions-toolbar-inset" : ""}`}
    >
      {sidebarHidden && (
        <button
          type="button"
          className="no-drag sidebar-toggle"
          data-sidebar-toggle={SidebarToggle.Show}
          aria-label={t("Show sidebar")}
          aria-controls="studio-sidebar"
          aria-expanded="false"
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      )}
      <nav className="no-drag extensions-tabs" aria-label={t("Extensions")}>
        {EXTENSIONS_TABS.map((value) => (
          <button
            type="button"
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => onTab(value)}
          >
            {TAB_LABEL[value]}
          </button>
        ))}
      </nav>
      <div className="no-drag ml-auto flex items-center gap-2">
        {/* The Plugins tab keeps itself current; skills are read on demand, so they keep a refresh. */}
        {tab === ExtensionsTab.Skills && (
          <IconButton icon="reload" label={REFRESH_LABEL[tab]} disabled={refreshing} onClick={onRefresh} />
        )}
        <AddMenu actions={add} afterMenu={afterMenu} />
      </div>
    </header>
  );
}
