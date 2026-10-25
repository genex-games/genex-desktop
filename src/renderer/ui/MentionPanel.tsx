/**
 * The @ picker: a header that stays put (the words typed after the @, and the What and Whose
 * switchers), and under it the part that scrolls: Images as a row, then cover cards on shelves
 * (your games, assets, tools, games on genex.games) or the best matches for what was typed, then
 * the plugins. Focus stays in the text box, which hands the panel its keys (`mention-grid.ts`);
 * the header takes clicks without taking focus.
 */
import { type CSSProperties, type JSX, type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AssetScope } from "../../shared/asset-library.ts";
import {
  type MentionFilter,
  MentionShelf,
  mentionShelves,
  MentionWhat,
  SHELF_CAPS,
  searchMentions,
} from "../../shared/mention-corpus.ts";
import type { GameCover } from "../../shared/game-library.ts";
import { t } from "../../shared/i18n.ts";
import { type MentionDoc, MentionKind, MentionOrigin } from "../../shared/prompt-mention.ts";
import { MENTION_WORDS } from "../words.ts";
import type { MentionOption } from "./add-menu-entries.ts";
import { IMAGES_OPTION } from "./add-menu-entries.ts";
import { GameAvatar } from "./GameAvatar.tsx";
import { Icon } from "./icons.tsx";
import { pickerItem } from "./PickerPanel.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import { CatalogState } from "./use-mention-docs.ts";
import { ViewSwitcher, type ViewSwitcherItem } from "./view-switcher.tsx";

/** The chip each kind wears. */
const KIND_CHIP: Record<MentionKind, string> = {
  [MentionKind.Game]: MENTION_WORDS.game,
  [MentionKind.Tool]: MENTION_WORDS.tool,
  [MentionKind.Asset]: MENTION_WORDS.asset,
  [MentionKind.Plugin]: MENTION_WORDS.plugin,
};

/** Each shelf's heading. */
const SHELF_LABEL: Record<MentionShelf, string> = {
  [MentionShelf.Yours]: MENTION_WORDS.yourGames,
  [MentionShelf.YourAssets]: MENTION_WORDS.yourAssets,
  [MentionShelf.Assets]: MENTION_WORDS.assets,
  [MentionShelf.Tools]: MENTION_WORDS.tools,
  [MentionShelf.Games]: MENTION_WORDS.genexGames,
};

/** The left switcher: everything, or one kind. */
const WHAT_ITEMS: readonly ViewSwitcherItem<MentionWhat>[] = [
  { key: MentionWhat.All, label: MENTION_WORDS.all },
  { key: MentionWhat.Games, label: MENTION_WORDS.games },
  { key: MentionWhat.Assets, label: MENTION_WORDS.assets },
  { key: MentionWhat.Tools, label: MENTION_WORDS.tools },
];

/** The right switcher: everything you may tag, or only your own. */
const WHOSE_ITEMS: readonly ViewSwitcherItem<AssetScope>[] = [
  { key: AssetScope.Everyone, label: MENTION_WORDS.everyone },
  { key: AssetScope.Mine, label: MENTION_WORDS.mine },
];

/** The cards in the order the outline walks them, and the shelves they sit on. */
export function mentionCards(
  docs: readonly MentionDoc[],
  query: string,
  caps: Record<MentionShelf, number> = SHELF_CAPS,
): { label: string | null; docs: MentionDoc[] }[] {
  if (query.trim()) return [{ label: null, docs: searchMentions(docs, query) }];
  return mentionShelves(docs, caps).map((group) => ({ label: SHELF_LABEL[group.shelf], docs: group.docs }));
}

/** A card's kind as its chip says it: an asset by its own kind when genex.games says it. */
function kindWord(doc: MentionDoc): string {
  if (doc.kind === MentionKind.Asset && doc.assetKind) return MENTION_WORDS.assetKind[doc.assetKind];
  return KIND_CHIP[doc.kind];
}

/** A card's chips: its kind, then Yours on your published work, Saved and Shared on your library's. */
function cardChips(doc: MentionDoc): string[] {
  // A library asset is yours by being in the library: its marks say more than Yours would.
  const yours = doc.own && doc.origin !== MentionOrigin.Library;
  return [
    kindWord(doc),
    ...(yours ? [MENTION_WORDS.yours] : []),
    ...(doc.saved ? [MENTION_WORDS.saved] : []),
    ...(doc.shared ? [MENTION_WORDS.shared] : []),
  ];
}

/** A card's picture: the cover, the game's own sphere on a plain card, or the plain card. */
function CardCover({ doc, cover }: { doc: MentionDoc; cover: GameCover | undefined }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  if (doc.coverUrl)
    return (
      <img
        src={doc.coverUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        data-loaded={loaded || undefined}
        ref={(node) => {
          if (node?.complete && node.naturalWidth > 0) setLoaded(true);
        }}
        onLoad={() => setLoaded(true)}
        className="mention-card-cover"
      />
    );
  return (
    <span className="mention-card-wash" aria-hidden>
      {doc.game ? <GameAvatar cover={cover} gameKey={doc.game} className="mention-card-avatar" /> : null}
    </span>
  );
}

/** One card: the cover is the control; the title sits on a dark scrim in both themes. */
function MentionCard({
  doc,
  id,
  active,
  picked,
  disabled,
  cover,
  onHover,
  onPick,
}: {
  doc: MentionDoc;
  id: string;
  active: boolean;
  picked: boolean;
  disabled: boolean;
  cover: GameCover | undefined;
  onHover: () => void;
  onPick: () => void;
}): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      aria-label={t("{kind}: {title}", { kind: kindWord(doc), title: doc.title })}
      data-mention-card={doc.handle}
      data-highlighted={active || undefined}
      className="mention-card"
      onMouseDown={(event) => event.preventDefault()}
      onClick={disabled ? undefined : onPick}
      onMouseMove={onHover}
    >
      <CardCover doc={doc} cover={cover} />
      <span className="mention-card-scrim" aria-hidden />
      <span className="mention-card-chips" aria-hidden>
        {cardChips(doc).map((chip) => (
          <span key={chip}>{chip}</span>
        ))}
      </span>
      {picked ? (
        <span className="mention-card-picked" title={MENTION_WORDS.inMessage}>
          <Icon name="check" size={12} />
        </span>
      ) : null}
      <span className="mention-card-title">{doc.title}</span>
    </div>
  );
}

/** Images, at the panel's top as a plain row: it adds pictures to the message, it tags nothing. */
function ImagesRow({
  option,
  id,
  active,
  onHover,
}: {
  option: MentionOption;
  id: string;
  active: boolean;
  onHover: () => void;
}): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-mention-option={option.id}
      data-highlighted={active || undefined}
      className={`${pickerItem} cursor-pointer hover:bg-control-hover data-highlighted:bg-control-hover`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={option.pick}
      onMouseMove={onHover}
    >
      <Icon name="image" className="text-icon-strong" />
      <span className="shrink-0">{option.name}</span>
      <span className="picker-desc">{MENTION_WORDS.imagesHint}</span>
    </div>
  );
}

/** A plugin that is on, as a card beside the others: its own picture on a plain card, chipped Plugin and On. */
function OptionCard({
  option,
  id,
  active,
  onHover,
}: {
  option: MentionOption;
  id: string;
  active: boolean;
  onHover: () => void;
}): JSX.Element {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={option.name}
      data-mention-option={option.id}
      data-highlighted={active || undefined}
      className="mention-card"
      onMouseDown={(event) => event.preventDefault()}
      onClick={option.pick}
      onMouseMove={onHover}
    >
      <span className="mention-card-wash mention-card-icon" aria-hidden>
        <PluginIcon name={option.name} src={option.icon} size="large" />
      </span>
      <span className="mention-card-scrim" aria-hidden />
      <span className="mention-card-chips" aria-hidden>
        <span>{MENTION_WORDS.plugin}</span>
        <span>{MENTION_WORDS.on}</span>
      </span>
      <span className="mention-card-title">{option.name}</span>
    </div>
  );
}

/** Lines of cards each skeleton shelf holds while genex.games answers: Assets two, Tools and Games one. */
const SKELETON_LINES = [2, 1, 1] as const;
/** The library's one line of cards while it answers, when the catalog is in. */
const LIBRARY_SKELETON_LINES = [1] as const;
/** How far the list must have scrolled under the header before its top edge fades. */
const SCROLLED_PX = 1;

/**
 * While genex.games or the library answers, the shelves they will fill stand in their real size as
 * quiet cards, so the panel opens at the height it settles at and nothing jumps when covers arrive.
 */
function MentionSkeleton({
  columns,
  query,
  lines,
}: {
  columns: number;
  query: string;
  lines: readonly number[];
}): JSX.Element {
  const shelves = query.trim() ? [1] : lines;
  return (
    <div aria-busy="true" aria-label={MENTION_WORDS.reading} data-mention-skeleton>
      {shelves.map((count, shelf) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder shelves have no identity.
        <section key={shelf} className="mention-shelf" aria-hidden>
          {query.trim() ? null : <span className="mention-skeleton-label" />}
          <div className="mention-grid">
            {Array.from({ length: count * columns }, (_, card) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cards have no identity.
              <span key={card} className="mention-skeleton-card" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Keeps a header click from taking focus out of the text box, which keeps driving the picker. */
const keepFocus = (event: MouseEvent): void => event.preventDefault();

/**
 * The words typed after the @, in a search field that stays put: a click puts the caret back at
 * their end in the prompt, and Clear empties them there. The text box keeps the focus throughout.
 */
function MentionSearch({
  query,
  onFocusQuery,
  onClear,
}: {
  query: string;
  onFocusQuery: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <div className="mention-search">
      <button
        type="button"
        className="mention-search-field"
        aria-label={MENTION_WORDS.search}
        data-mention-search
        onClick={onFocusQuery}
      >
        <Icon name="search" size={14} className="mention-search-icon" />
        {query ? (
          <span className="mention-search-text">{query}</span>
        ) : (
          <span className="mention-search-placeholder">{MENTION_WORDS.search}</span>
        )}
      </button>
      {query ? (
        <button
          type="button"
          className="mention-search-clear"
          aria-label={MENTION_WORDS.clearLabel}
          data-mention-clear
          onClick={onClear}
        >
          {MENTION_WORDS.clear}
        </button>
      ) : null}
    </div>
  );
}

/** The header that stays put over the cards: the search field, then What on the left and Whose on the right. */
function MentionHeader({
  query,
  filter,
  onFilter,
  onFocusQuery,
  onClear,
}: {
  query: string;
  filter: MentionFilter;
  onFilter: (filter: MentionFilter) => void;
  onFocusQuery: () => void;
  onClear: () => void;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a press anywhere in the header leaves the focus in the text box, which drives the picker.
    <div className="mention-head" data-mention-head onMouseDown={keepFocus}>
      <MentionSearch query={query} onFocusQuery={onFocusQuery} onClear={onClear} />
      <div className="mention-switches">
        <ViewSwitcher
          items={WHAT_ITEMS}
          active={filter.what}
          onSelect={(what) => onFilter({ ...filter, what })}
          label={MENTION_WORDS.whatLabel}
          sans
          dataAttribute="data-mention-what"
        />
        <ViewSwitcher
          items={WHOSE_ITEMS}
          active={filter.whose}
          onSelect={(whose) => onFilter({ ...filter, whose })}
          label={MENTION_WORDS.whoseLabel}
          sans
          dataAttribute="data-mention-whose"
        />
      </div>
    </div>
  );
}

/**
 * The scrolling list's edges: its top fades once cards have scrolled under the header, its bottom
 * while more lies below. Measured on every render (cards come and go) and on scroll and resize;
 * the attributes are set directly, so scrolling never renders.
 */
function useEdgeFades() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => measureEdges(ref.current));
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => measureEdges(element);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, []);
  return ref;
}

/** Mark whether a scrolling list has scrolled from its top and whether more of it lies below. */
function measureEdges(element: HTMLElement | null): void {
  if (!element) return;
  const bottom = element.scrollTop + element.clientHeight;
  element.toggleAttribute("data-scrolled", element.scrollTop >= SCROLLED_PX);
  element.toggleAttribute("data-more", bottom < element.scrollHeight - SCROLLED_PX);
}

/** What the panel shows and how it acts; `active` indexes cards first, then rows. */
export interface MentionPanelProps {
  list: string;
  query: string;
  groups: { label: string | null; docs: MentionDoc[] }[];
  rows: MentionOption[];
  columns: number;
  catalog: CatalogState;
  /** The library has not answered yet while the switchers show assets. */
  libraryReading: boolean;
  /** The plugins have been read: no rows means no match, not a read on its way. */
  rowsRead: boolean;
  picked: ReadonlySet<string>;
  atCap: boolean;
  covers: ReadonlyMap<string, GameCover | undefined>;
  active: number;
  optionId: (index: number) => string;
  onHighlight: (index: number) => void;
  onPick: (doc: MentionDoc) => void;
  filter: MentionFilter;
  onFilter: (filter: MentionFilter) => void;
  /** Put the caret back at the end of the words after the @. */
  onFocusQuery: () => void;
  /** Empty the words after the @, keeping the @ and the focus. */
  onClearQuery: () => void;
}

/** The plugins' cards, each a tag; `start` is the first one's place in the outline's order. */
function PluginShelf({
  rows,
  start,
  labelled,
  active,
  optionId,
  onHighlight,
}: {
  rows: MentionOption[];
  start: number;
  labelled: boolean;
  active: number;
  optionId: (index: number) => string;
  onHighlight: (index: number) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section className="mention-shelf">
      {labelled ? <h4 className="mention-shelf-label">{MENTION_WORDS.plugins}</h4> : null}
      <div className="mention-grid">
        {rows.map((option, i) => {
          const at = start + i;
          return (
            <OptionCard
              key={option.id}
              option={option}
              id={optionId(at)}
              active={at === active}
              onHover={() => onHighlight(at)}
            />
          );
        })}
      </div>
    </section>
  );
}

/** The skeleton the panel shows: genex.games' shelves while it answers, else the library's line. */
function skeletonLines(props: MentionPanelProps): readonly number[] | null {
  if (props.catalog === CatalogState.Reading) return SKELETON_LINES;
  return props.libraryReading ? LIBRARY_SKELETON_LINES : null;
}

/** The picker's body inside the composer's panel. */
export function MentionPanel(props: MentionPanelProps): JSX.Element {
  const { groups, active, optionId, onHighlight } = props;
  // Images heads the panel as a row; the plugins' cards come after the others.
  const lead = props.rows.filter((row) => row.id === IMAGES_OPTION);
  const rows = props.rows.filter((row) => row.id !== IMAGES_OPTION);
  const cardCount = lead.length + groups.reduce((sum, group) => sum + group.docs.length, 0);
  // A typed name reaches a plugin first: its tile leads the matches, as its shelf ends the panel.
  const pluginsFirst = props.query.trim().length > 0;
  const skeleton = skeletonLines(props);
  const empty = cardCount === 0 && rows.length === 0;
  const scroller = useEdgeFades();
  // biome-ignore lint/correctness/useExhaustiveDependencies: other words or other switchers are another list, which starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [props.query, props.filter]);
  // The keys move the outline past the list's edge: the outlined card scrolls into view.
  const activeId = optionId(active);
  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const plugins = (
    <PluginShelf
      rows={rows}
      start={pluginsFirst ? lead.length : cardCount}
      labelled={!props.query}
      active={active}
      optionId={optionId}
      onHighlight={onHighlight}
    />
  );
  let index = pluginsFirst ? lead.length + rows.length : lead.length;
  return (
    <div className="mention-panel" style={{ "--mention-columns": props.columns } as CSSProperties}>
      <MentionHeader
        query={props.query}
        filter={props.filter}
        onFilter={props.onFilter}
        onFocusQuery={props.onFocusQuery}
        onClear={props.onClearQuery}
      />
      <div
        ref={scroller}
        role="listbox"
        id={props.list}
        aria-label={MENTION_WORDS.listLabel}
        data-mention-list
        className="mention-scroll"
      >
        {lead.map((option, at) => (
          <ImagesRow
            key={option.id}
            option={option}
            id={optionId(at)}
            active={at === active}
            onHover={() => onHighlight(at)}
          />
        ))}
        {pluginsFirst ? plugins : null}
        {groups.map((group) => (
          <section key={group.label ?? "matches"} className="mention-shelf">
            {group.label ? <h4 className="mention-shelf-label">{group.label}</h4> : null}
            <div className="mention-grid">
              {group.docs.map((doc) => {
                const at = index++;
                const picked = props.picked.has(doc.handle);
                return (
                  <MentionCard
                    key={doc.handle}
                    doc={doc}
                    id={optionId(at)}
                    active={at === active}
                    picked={picked}
                    disabled={props.atCap && !picked}
                    cover={doc.game ? props.covers.get(doc.game) : undefined}
                    onHover={() => onHighlight(at)}
                    onPick={() => props.onPick(doc)}
                  />
                );
              })}
            </div>
          </section>
        ))}
        {skeleton ? <MentionSkeleton columns={props.columns} query={props.query} lines={skeleton} /> : null}
        {pluginsFirst ? null : plugins}
        {empty && props.rowsRead && !skeleton ? (
          <div className={`${pickerItem} text-ink-3`}>{MENTION_WORDS.noMatches}</div>
        ) : null}
      </div>
      {props.atCap ? <p className="mention-cap">{MENTION_WORDS.atCap}</p> : null}
    </div>
  );
}
