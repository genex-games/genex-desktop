/**
 * The Plugins tab: what is installed (on or off), the MCP servers you added, what was removed or
 * waits to be allowed, More plugins when the catalog has something you don't have (else the
 * Marketplace, coming soon), and a way to make your own.
 */
import type { JSX, RefObject } from "react";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import type { PluginIndexEntry, PluginIndexView, PluginInfo } from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/kit.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { type ConnectorActions, ConnectorsCard } from "../ConnectorsCard.tsx";
import { useGenexCredits } from "./genex/use-genex-credits.ts";
import { MoreView, meetsMinimumVersion, moreView, PLUGIN_GUIDE_URL, pluginAccount, shownName } from "./labels.ts";
import { MarketplaceSoon } from "./MarketplaceSoon.tsx";
import type { CatalogRow, PluginsPage } from "./page.ts";
import { PluginIcon } from "../../ui/PluginIcon.tsx";
import { PluginRows, pluginMatches, Section } from "./rows.tsx";

const WORDS = PLUGINS_WORDS;

function Installed({ installed, page, query }: { installed: PluginInfo[]; page: PluginsPage; query: string }) {
  const nothingShown = installed.filter((p) => pluginMatches(page, p)).length === 0;
  const credits = useGenexCredits(installed, pluginAccount(page.connections, GENEX_PLUGIN_ID), page.connections);
  return (
    <Section title="Installed" count={installed.length}>
      <PluginRows list={installed} page={page} credits={credits} />
      {nothingShown && (
        <p className="extensions-empty">
          {query ? "No installed plugins match your search." : "No plugins installed yet. Add one from the Add menu."}
        </p>
      )}
    </Section>
  );
}

/** What a catalog entry offers: a Studio floor it is under, an update, or install. */
function EntryAction({
  entry,
  index,
  page,
  removed,
}: {
  entry: PluginIndexEntry;
  index: PluginIndexView;
  page: PluginsPage;
  removed: Set<string>;
}): JSX.Element {
  const blocked =
    entry.minStudioVersion !== undefined && !meetsMinimumVersion(index.studioVersion, entry.minStudioVersion);
  if (blocked) return <span className="text-xs text-ink-3">Needs Studio ≥ {entry.minStudioVersion}</span>;
  return (
    <IconButton
      icon="plus"
      disabled={page.busy}
      label={`${removed.has(entry.id) ? "Reinstall" : "Install"} ${entry.name}`}
      onClick={() => void page.act(() => window.studio.pluginInstall(entry.id))}
    />
  );
}

/** One plugin you don't have: its picture, name and one line, and the way to get it. */
function CatalogEntry({ name, description, children }: { name: string; description: string; children: JSX.Element }) {
  return (
    <div className="extension-row">
      <div className="extension-open extension-static">
        <PluginIcon name={name} />
        <span className="extension-copy">
          <span className="extension-name">{name}</span>
          <span className="extension-description" title={description}>
            {description}
          </span>
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * More plugins: only what the catalog has that you don't. Until it has something (or while it
 * loads or can't be read) the Marketplace is only Coming soon, hidden while searching.
 */
function MorePlugins({
  index,
  catalog,
  page,
  installed,
  removed,
  searching,
}: {
  index: PluginIndexView | null;
  catalog: CatalogRow[];
  page: PluginsPage;
  installed: Set<string>;
  removed: Set<string>;
  searching: boolean;
}): JSX.Element | null {
  const entries = (index?.entries ?? []).filter(
    (e) => !installed.has(e.id) && page.matches(e.name, e.description, e.category),
  );
  const releases = catalog.filter((c) => !installed.has(c.id) && page.matches(c.name));
  const view = moreView({ index, entries: entries.length, releases: releases.length });
  if (view === MoreView.Soon || !index) return searching ? null : <MarketplaceSoon />;
  return (
    <Section title={WORDS.more.title} hooks={{ "data-more-plugins": "" }}>
      {entries.map((e) => (
        <article key={e.id} data-plugin-tier={e.tier} data-plugin-category={e.category}>
          <CatalogEntry name={e.name} description={e.description}>
            <EntryAction entry={e} index={index} page={page} removed={removed} />
          </CatalogEntry>
        </article>
      ))}
      {releases.map((p) => (
        <CatalogEntry key={p.id} name={p.name} description={p.version}>
          <IconButton
            icon="plus"
            disabled={page.busy}
            label={`Install ${p.name}`}
            onClick={() => void page.act(() => window.studio.pluginInstall(p.id))}
          />
        </CatalogEntry>
      ))}
    </Section>
  );
}

/** The last row: every plugin here, Studio's own included, is one folder anyone can make. */
function MakeYourOwn(): JSX.Element {
  return (
    <section className="extension-row extension-own" aria-label={WORDS.own.title}>
      <span className="extension-icon extension-icon-row extension-icon-make" aria-hidden="true">
        <Icon name="code" size={20} />
      </span>
      <span className="extension-copy">
        <span className="extension-name">{WORDS.own.title}</span>
        <span className="extension-description">{WORDS.own.text}</span>
      </span>
      <Button onClick={() => void window.studio.openUrl(PLUGIN_GUIDE_URL)}>
        {WORDS.own.guide}
        <Icon name="arrow-up-right" size={14} />
      </Button>
    </section>
  );
}

/** The Plugins tab's lists, below the search. */
export function PluginsBrowse({
  plugins,
  page,
  query,
  catalog,
  index,
  connectorActions,
}: {
  plugins: PluginInfo[];
  page: PluginsPage;
  query: string;
  catalog: CatalogRow[];
  index: PluginIndexView | null;
  connectorActions: RefObject<ConnectorActions | null>;
}): JSX.Element {
  const installed = plugins.filter((p) => !p.removed && !p.unlisted);
  const removed = plugins.filter((p) => p.removed);
  const unlisted = plugins.filter((p) => p.unlisted);
  return (
    <>
      <Installed installed={installed} page={page} query={query} />
      <ConnectorsCard
        ref={connectorActions}
        project={page.project}
        query={query}
        onOpenPlugin={page.openPlugin}
        pluginName={(id) => {
          const owner = plugins.find((p) => p.manifest.id === id);
          return owner ? shownName(owner) : id;
        }}
      />
      {removed.length > 0 && (
        <Section title="Removed" count={removed.length}>
          <PluginRows list={removed} page={page} />
        </Section>
      )}
      {unlisted.length > 0 && (
        <Section title="Not enabled" count={unlisted.length}>
          <p className="mb-3 text-sm text-ink-3">Found locally. These plugins only run after you allow them.</p>
          <PluginRows list={unlisted} page={page} />
        </Section>
      )}
      <MorePlugins
        index={index}
        catalog={catalog}
        page={page}
        installed={new Set(installed.map((p) => p.manifest.id))}
        removed={new Set(removed.map((p) => p.manifest.id))}
        searching={Boolean(query)}
      />
      {!query && <MakeYourOwn />}
    </>
  );
}
