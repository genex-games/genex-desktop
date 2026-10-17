/**
 * The @ picker's body: cover cards on shelves (your games, assets, tools, games on genex.games),
 * or the best matches for what was typed, then Images and the plugins as rows. Focus stays in the
 * text box, which hands the panel its keys (`mention-grid.ts`).
 */
import { type CSSProperties, type JSX, useEffect, useState } from "react";
import { MentionShelf, mentionShelves, searchMentions } from "../../shared/mention-corpus.ts";
import type { GameCover } from "../../shared/game-library.ts";
import { type MentionDoc, MentionKind } from "../../shared/prompt-mention.ts";
import { MENTION_WORDS } from "../words.ts";
import type { MentionOption } from "./add-menu-entries.ts";
import { IMAGES_OPTION } from "./add-menu-entries.ts";
import { GameAvatar } from "./GameAvatar.tsx";
import { Icon } from "./icons.tsx";
import { pickerItem } from "./PickerPanel.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import { CatalogState } from "./use-mention-docs.ts";

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
  [MentionShelf.Assets]: MENTION_WORDS.assets,
  [MentionShelf.Tools]: MENTION_WORDS.tools,
  [MentionShelf.Games]: MENTION_WORDS.genexGames,
};

/** The cards in the order the outline walks them, and the shelves they sit on. */
export function mentionCards(
  docs: readonly MentionDoc[],
  query: string,
): { label: string | null; docs: MentionDoc[] }[] {
  if (query.trim()) return [{ label: null, docs: searchMentions(docs, query) }];
  return mentionShelves(docs).map((group) => ({ label: SHELF_LABEL[group.shelf], docs: group.docs }));
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
      aria-label={`${KIND_CHIP[doc.kind]}: ${doc.title}`}
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
        <span>{KIND_CHIP[doc.kind]}</span>
        {doc.own ? <span>{MENTION_WORDS.yours}</span> : null}
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

/**
 * While genex.games answers, the shelves it will fill stand in their real size as quiet cards, so
 * the panel opens at the height it settles at and nothing jumps when the covers arrive.
 */
function MentionSkeleton({ columns, query }: { columns: number; query: string }): JSX.Element {
  const shelves = query.trim() ? [1] : SKELETON_LINES;
  return (
    <div aria-busy="true" aria-label={MENTION_WORDS.reading} data-mention-skeleton>
      {shelves.map((lines, shelf) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder shelves have no identity.
        <section key={shelf} className="mention-shelf" aria-hidden>
          {query.trim() ? null : <span className="mention-skeleton-label" />}
          <div className="mention-grid">
            {Array.from({ length: lines * columns }, (_, card) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cards have no identity.
              <span key={card} className="mention-skeleton-card" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** What the panel shows and how it acts; `active` indexes cards first, then rows. */
export interface MentionPanelProps {
  list: string;
  query: string;
  groups: { label: string | null; docs: MentionDoc[] }[];
  rows: MentionOption[];
  columns: number;
  catalog: CatalogState;
  /** The plugins have been read: no rows means no match, not a read on its way. */
  rowsRead: boolean;
  picked: ReadonlySet<string>;
  atCap: boolean;
  covers: ReadonlyMap<string, GameCover | undefined>;
  active: number;
  optionId: (index: number) => string;
  onHighlight: (index: number) => void;
  onPick: (doc: MentionDoc) => void;
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
  const pluginStart = pluginsFirst ? lead.length : cardCount;
  const empty = cardCount === 0 && rows.length === 0;
  // The keys move the outline past the panel's edge: the outlined card scrolls into view.
  const activeId = optionId(active);
  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const plugins =
    rows.length > 0 ? (
      <section className="mention-shelf">
        {props.query ? null : <h4 className="mention-shelf-label">{MENTION_WORDS.plugins}</h4>}
        <div className="mention-grid">
          {rows.map((option, i) => {
            const at = pluginStart + i;
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
    ) : null;
  let index = pluginsFirst ? lead.length + rows.length : lead.length;
  return (
    <div
      role="listbox"
      id={props.list}
      aria-label={MENTION_WORDS.listLabel}
      data-mention-list
      className="mention-panel"
      style={{ "--mention-columns": props.columns } as CSSProperties}
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
      {props.catalog === CatalogState.Reading ? <MentionSkeleton columns={props.columns} query={props.query} /> : null}
      {pluginsFirst ? null : plugins}
      {empty && props.rowsRead && props.catalog !== CatalogState.Reading ? (
        <div className={`${pickerItem} text-ink-3`}>{MENTION_WORDS.noMatches}</div>
      ) : null}
      {props.atCap ? <p className="mention-cap">{MENTION_WORDS.atCap}</p> : null}
    </div>
  );
}
