/**
 * The game's design board in the chat, where its agent showed an artboard (`show_design`, recorded
 * as `design_shown`): a small stack of the board's artboards with the shown one on top, a "Game
 * design" tag, the artboard's title and the agent's few words on it (else how many artboards the
 * board holds). The block reads the board as it is now, so it changes as the agent goes on. One
 * press anywhere opens the Design tab on that artboard; an artboard that left the board leaves one
 * line. Built on the chat's build card.
 */
import type { CSSProperties, JSX } from "react";
import { type DesignItem, DesignItemKind } from "../../shared/design-board.ts";
import type { DesignPageEntry } from "../chat-entries.ts";
import { openDesignPage } from "../open-beside.ts";
import { useLiveBoard } from "../panels/design/design-boards.ts";
import { boardStack, pageCaption } from "../panels/design/design-model.ts";
import { DESIGN_WORDS } from "../words.ts";
import { BuildCard } from "./BuildCard.tsx";

/** How far the two artboards behind the top one lean and stand out, to each side. */
const STACK_TILT_DEG = 6;
const STACK_SPREAD_PX = 14;

/** One artboard of the stack: a small sheet edged in the card's own colour, so the three read apart. */
const THUMB =
  "absolute top-[10px] left-[18px] h-[55px] w-[88px] overflow-hidden rounded-[8px] bg-inset shadow-[0_0_0_2px_var(--composer)]";

/** Where an artboard of the stack lies: the top one straight, the next to the left, the third to the right. */
function lean(place: number): CSSProperties {
  if (place === 0) return {};
  const side = place === 1 ? -1 : 1;
  return { transform: `translateX(${side * STACK_SPREAD_PX}px) rotate(${side * STACK_TILT_DEG}deg)` };
}

/** A line of a page's shape: a sheet that holds words is drawn as lines, never as words to read. */
function Bar({ width, strong = false }: { width: string; strong?: boolean }): JSX.Element {
  return (
    <span
      className="block h-1 shrink-0 rounded-full"
      style={{ width, background: strong ? "var(--ink-3)" : "var(--line-strong)" }}
    />
  );
}

/** One artboard, small: a picture as itself; a page or a model as a sheet's shape. */
function Thumb({ item, place }: { item: DesignItem; place: number }): JSX.Element {
  if (item.kind === DesignItemKind.Picture)
    return <img src={item.url} alt="" draggable={false} className={`${THUMB} object-cover`} style={lean(place)} />;
  return (
    <span className={`${THUMB} flex flex-col gap-[5px] px-[10px] py-[9px]`} style={lean(place)}>
      <Bar width="52%" strong />
      <Bar width="92%" />
      <Bar width="78%" />
      <Bar width="60%" />
    </span>
  );
}

/** The stack: up to three artboards, the first on top; one empty sheet while the board is being read. */
function Stack({ items }: { items: readonly DesignItem[] }): JSX.Element {
  return (
    <span data-design-stack="" aria-hidden="true" className="relative block h-[76px] w-[124px] shrink-0">
      {items.length === 0 ? <span className={THUMB} /> : null}
      {items.map((item, place) => <Thumb key={item.file} item={item} place={place} />).reverse()}
    </span>
  );
}

/** An artboard's file as a name: `docs/design/world/the-town.png` is `the-town`. */
const nameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

/**
 * The design block in the transcript, for an artboard the game's agent showed: the stack, the tag,
 * the artboard's title, and the agent's note (else the board's count). One press opens the Design
 * tab on that artboard.
 */
export function DesignPageCard({ entry }: { entry: DesignPageEntry }): JSX.Element {
  const { design } = entry;
  const board = useLiveBoard(design.project);
  const shown = board?.items.find((item) => item.file === design.file);
  const title = pageCaption({ name: nameOf(design.file), title: shown?.title || design.title }, undefined);
  if (board && !shown)
    return (
      // The artboard's title, which the game's agent wrote.
      <p data-design-card={design.file} data-design-gone="" data-analytics-mask className="m-0 text-chat text-ink-3">
        {DESIGN_WORDS.gone(title)}
      </p>
    );
  const line = design.note || (board ? DESIGN_WORDS.artboards(board.items.length) : "");
  return (
    // The artboards, the title and the agent's note are the person's game: kept out of usage recordings.
    <section data-design-card={design.file} data-analytics-mask className="min-w-0">
      <BuildCard
        picture={<Stack items={board && shown ? boardStack(board.items, shown.file) : []} />}
        tag={<span className="font-mono text-[12px] text-ink-3 leading-4">{DESIGN_WORDS.cardKind}</span>}
        title={title}
        line={
          <p title={line} className="m-0 truncate text-status text-ink-3">
            {line}
          </p>
        }
        open={{ onClick: () => openDesignPage(design.file), hint: DESIGN_WORDS.openInDesign }}
      />
    </section>
  );
}
