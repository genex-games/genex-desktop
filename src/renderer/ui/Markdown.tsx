/**
 * Markdown for chat — the contractor writes real reports (tables, bold, code) and the first
 * one rendered as raw asterisks and pipe characters.
 *
 * Raw HTML tokens are escaped during rendering; code is escaped exactly once.
 * Only tags produced from Markdown syntax reach the DOM. Styling lives in theme.css (`.prose`).
 * Names of files that exist become buttons (shared/chat-files.ts) inside a chat's
 * `ChatFilesScope`; `fileBase` is the document this text came from, so its relative links
 * resolve from its own folder. A one-line shell block leaves an empty slot; `renderCommand`,
 * when given, draws that command's actions into it.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ChatFileLookup, type ChatFileRef, fileMentions } from "../../shared/chat-files.ts";
import { answersOf, clickFileLink, useChatFileNames, useChatFiles } from "../chat-files.ts";
import { markdownBlocks, markdownHtml } from "./markdown-html.ts";
import { parseBlock, type ShownBlock, showBlocks } from "./prose-blocks.ts";

/** The name the text ends in while it is still arriving: it may be half written (`src/physics.j`). */
function unfinishedName(text: string): string | null {
  const tail = fileMentions(text).at(-1);
  return tail && /^\S*$/.test(text.slice(tail.end)) ? tail.name : null;
}

/** Where one offered command's actions are drawn. */
interface CommandSlot {
  node: Element;
  command: string;
  key: string;
}

/** The command slots of the rendered HTML, found again whenever the HTML changes. */
function useCommandSlots(root: RefObject<HTMLDivElement | null>, html: string, enabled: boolean): CommandSlot[] {
  const [slots, setSlots] = useState<CommandSlot[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new HTML is the reason to look for slots again
  useLayoutEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const blocks = [...node.querySelectorAll("[data-command]")];
    setSlots(
      blocks.flatMap((block, index) => {
        const slot = block.querySelector("[data-command-slot]");
        const command = block.getAttribute("data-command");
        return slot && command ? [{ node: slot, command, key: `${index}:${command}` }] : [];
      }),
    );
  }, [html, enabled]);
  return enabled ? slots : [];
}

/** Keeps `blocks` on screen in `root`, changing only the blocks that changed; null leaves it to React. */
function useShownBlocks(root: RefObject<HTMLDivElement | null>, blocks: string[] | null): void {
  const shown = useRef<ShownBlock[]>([]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !blocks) {
      shown.current = [];
      return;
    }
    // Whatever React drew before (the whole HTML) goes first.
    if (!shown.current.length) node.replaceChildren();
    shown.current = showBlocks<ChildNode>(node, shown.current, blocks, parseBlock);
  }, [root, blocks]);
}

/**
 * `streaming`: the text is still arriving, so a name at its very end may be half written; that
 * name is neither linked nor asked about yet.
 */
export const Markdown = memo(function Markdown({
  text,
  className = "",
  fileBase,
  streaming = false,
  renderCommand,
}: {
  text: string;
  className?: string;
  fileBase?: string;
  streaming?: boolean;
  /** The actions for a command a one-line shell block offers; without it the block is plain code. */
  renderCommand?: (command: string) => ReactNode;
}): JSX.Element {
  const { threadId, lookup } = useChatFiles();
  const unfinished = useMemo(() => (streaming && threadId ? unfinishedName(text) : null), [streaming, threadId, text]);
  // Only this text's own answers render it again (answersOf); the last parse's names say which.
  const shown = useRef<ChatFileRef[]>([]);
  const answered = answersOf(lookup, shown.current);
  // A reply still arriving with no commands to draw is kept block by block (prose-blocks.ts).
  const byBlock = streaming && !renderCommand;
  // One HTML object per render of this text: React 19 rewrites innerHTML whenever it changes,
  // which would detach the command slots the portals below draw into.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lookup` is read through `answered`, which changes exactly when this text's answers do
  const { html, blocks, names } = useMemo(() => {
    const found: ChatFileRef[] = [];
    const known: ChatFileLookup = (name, base) => (name === unfinished ? undefined : lookup(name, base));
    const files = threadId ? { lookup: known, names: found, ...(fileBase ? { base: fileBase } : {}) } : undefined;
    const withFiles = files ? { files } : {};
    const parts = byBlock ? markdownBlocks(text, withFiles) : null;
    const rendered = parts ? null : { __html: markdownHtml(text, { ...withFiles, streaming }) };
    return {
      html: rendered,
      blocks: parts,
      names: unfinished ? found.filter((ref) => ref.name !== unfinished) : found,
    };
  }, [text, threadId, fileBase, unfinished, answered, streaming, byBlock]);
  shown.current = names;
  useChatFileNames(threadId, names);
  const root = useRef<HTMLDivElement>(null);
  useShownBlocks(root, blocks);
  const slots = useCommandSlots(root, html?.__html ?? "", Boolean(renderCommand));
  return (
    <>
      <div
        ref={root}
        className={`prose ${className}`}
        onClick={(event) => clickFileLink(event, threadId)}
        {...(html ? { dangerouslySetInnerHTML: html } : {})}
      />
      {renderCommand && slots.map((slot) => createPortal(renderCommand(slot.command), slot.node, slot.key))}
    </>
  );
});
