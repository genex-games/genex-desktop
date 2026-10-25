/**
 * The Plugins tab: what is installed (on or off), the MCP servers you added, what was removed or
 * waits to be allowed, the catalog's Plugins (Genex's own) and Community plugins (anyone's, coming
 * soon until the catalog lists one) that you don't have, and a way to make one.
 */
import type { JSX, RefObject } from "react";
import { GENEX_PLUGIN_ID } from "../../../shared/genex.ts";
import { t, tc } from "../../../shared/i18n.ts";
import type { PluginIndexEntry, PluginIndexView, PluginInfo } from "../../../shared/plugins.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/kit.tsx";
import { PLUGINS_WORDS } from "../../words.ts";
import { type ConnectorActions, ConnectorsCard } from "../ConnectorsCard.tsx";
import { useGenexCredits } from "./genex/use-genex-credits.ts";
import { NeedsSetup, PublisherLink } from "./CatalogDetail.tsx";
import {
  CommunityView,
  catalogShelves,
  communityIds,
  communityView,
  meetsMinimumVersion,
  needsSetup,
  PLUGIN_GUIDE_URL,
  pluginAccount,
  shownName,
} from "./labels.ts";
import { MarketplaceSoon } from "./MarketplaceSoon.tsx";
import type { CatalogRow, PluginsPage } from "./page.ts";
import { PluginIcon } from "../../ui/PluginIcon.tsx";
import { PluginRows, PluginToggle, pluginMatches, Section } from "./rows.tsx";

const WORDS = PLUGINS_WORDS;

function Installed({ installed, page, query }: { installed: PluginInfo[]; page: PluginsPage; query: string }) {
  const nothingShown = installed.filter((p) => pluginMatches(page, p)).length === 0;
  const credits = useGenexCredits(installed, pluginAccount(page.connections, GENEX_PLUGIN_ID), page.connections);
  return (
    <Section title={tc("heading", "Installed")} count={installed.length}>
      <PluginRows list={installed} page={page} credits={credits} />
      {nothingShown && (
        <p className="extensions-empty">
          {query
            ? t("No installed plugins match your search.")
            : t("No plugins installed yet. Add one from the Add menu.")}
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
  const minimum = entry.minStudioVersion;
  const blocked = minimum !== undefined && !meetsMinimumVersion(index.studioVersion, minimum);
  if (blocked) return <span className="text-xs text-ink-3">{t("Needs Studio ≥ {version}", { version: minimum })}</span>;
  return (
    <IconButton
      icon="plus"
      disabled={page.busy}
      label={
        removed.has(entry.id) ? t("Reinstall {name}", { name: entry.name }) : t("Install {name}", { name: entry.name })
      }
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

/** A catalog entry you don't have, as a row with its install action. */
function EntryRow({
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
  return (
    <article data-plugin-tier={entry.tier} data-plugin-category={entry.category}>
      <CatalogEntry name={entry.name} description={entry.description}>
        <EntryAction entry={entry} index={index} page={page} removed={removed} />
      </CatalogEntry>
    </article>
  );
}

/**
 * A community plugin as a tile: its picture beside its name and publisher, a few lines, and its
 * control. Not installed, the + opens its page (how to start, Install); installed, its switch. The
 * whole tile opens its page.
 */
function CommunityTile({
  entry,
  installed,
  page,
}: {
  entry: PluginIndexEntry;
  installed: PluginInfo | undefined;
  page: PluginsPage;
}): JSX.Element {
  const open = (): void => page.openPlugin(entry.id);
  return (
    <article
      className="community-tile"
      data-plugin-tier={entry.tier}
      data-plugin-category={entry.category}
      data-plugin-installed={installed ? "" : undefined}
    >
      <div className="community-tile-head">
        <PluginIcon name={entry.name} />
        <span className="community-tile-title">
          <button
            type="button"
            className="extension-name community-tile-open"
            title={entry.name}
            aria-label={WORDS.listing.open(entry.name)}
            onClick={open}
          >
            {entry.name}
          </button>
          <PublisherLink repo={entry.repo} />
        </span>
        <span className="community-tile-control">
          {installed && needsSetup(installed, pluginAccount(page.connections, entry.id)) && <NeedsSetup />}
          {installed ? (
            <PluginToggle plugin={installed} page={page} />
          ) : (
            <IconButton icon="plus" disabled={page.busy} label={WORDS.listing.open(entry.name)} onClick={open} />
          )}
        </span>
      </div>
      <span className="community-tile-description" title={entry.description}>
        {entry.description}
      </span>
    </article>
  );
}

/** Plugins: the plugins Genex makes that you don't have, from the catalog and from Studio itself; hidden when none. */
function OurPlugins({
  index,
  entries,
  releases,
  page,
  removed,
}: {
  index: PluginIndexView | null;
  entries: PluginIndexEntry[];
  releases: CatalogRow[];
  page: PluginsPage;
  removed: Set<string>;
}): JSX.Element | null {
  const shown = index ? entries : [];
  if (shown.length + releases.length === 0) return null;
  return (
    <Section title={WORDS.ours.title} hooks={{ "data-catalog-plugins": "ours" }}>
      {index && shown.map((e) => <EntryRow key={e.id} entry={e} index={index} page={page} removed={removed} />)}
      {releases.map((p) => (
        <CatalogEntry key={p.id} name={p.name} description={p.version}>
          <IconButton
            icon="plus"
            disabled={page.busy}
            label={t("Install {name}", { name: p.name })}
            onClick={() => void page.act(() => window.studio.pluginInstall(p.id))}
          />
        </CatalogEntry>
      ))}
    </Section>
  );
}

/**
 * Community plugins: everyone else's plugins, installed or not, as a grid of tiles under their
 * publishers' names. Until the catalog has one (or while it loads or can't be read) it is only
 * Coming soon, hidden while searching.
 */
function CommunityPlugins({
  index,
  entries,
  installed,
  page,
  searching,
}: {
  index: PluginIndexView | null;
  entries: PluginIndexEntry[];
  installed: Map<string, PluginInfo>;
  page: PluginsPage;
  searching: boolean;
}): JSX.Element | null {
  if (communityView({ index, entries: entries.length }) === CommunityView.Soon || !index)
    return searching ? null : <MarketplaceSoon />;
  return (
    <Section title={WORDS.community.title} hooks={{ "data-catalog-plugins": "community" }}>
      <div className="community-grid">
        {entries.map((e) => (
          <CommunityTile key={e.id} entry={e} installed={installed.get(e.id)} page={page} />
        ))}
      </div>
    </Section>
  );
}

/** The catalog's two shelves, Plugins then Community plugins, with only what you don't have. */
function CatalogPlugins({
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
  installed: Map<string, PluginInfo>;
  removed: Set<string>;
  searching: boolean;
}): JSX.Element {
  const entries = (index?.entries ?? []).filter((e) => page.matches(e.name, e.description, e.category, e.publisher));
  const releases = catalog.filter((c) => !installed.has(c.id) && page.matches(c.name));
  const { ours, community } = catalogShelves(entries);
  const missing = ours.filter((e) => !installed.has(e.id));
  return (
    <>
      <OurPlugins index={index} entries={missing} releases={releases} page={page} removed={removed} />
      <CommunityPlugins index={index} entries={community} installed={installed} page={page} searching={searching} />
    </>
  );
}

/** The last row: anyone can make a community plugin, one folder like Studio's own. */
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
  const community = communityIds(index);
  const removed = plugins.filter((p) => p.removed);
  const unlisted = plugins.filter((p) => p.unlisted);
  return (
    <>
      <Installed installed={installed.filter((p) => !community.has(p.manifest.id))} page={page} query={query} />
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
        <Section title={t("Removed")} count={removed.length}>
          <PluginRows list={removed} page={page} />
        </Section>
      )}
      {unlisted.length > 0 && (
        <Section title={t("Not enabled")} count={unlisted.length}>
          <p className="mb-3 text-sm text-ink-3">{t("Found locally. These plugins only run after you allow them.")}</p>
          <PluginRows list={unlisted} page={page} />
        </Section>
      )}
      <CatalogPlugins
        index={index}
        catalog={catalog}
        page={page}
        installed={new Map(installed.map((p) => [p.manifest.id, p]))}
        removed={new Set(removed.map((p) => p.manifest.id))}
        searching={Boolean(query)}
      />
      {!query && <MakeYourOwn />}
    </>
  );
}
