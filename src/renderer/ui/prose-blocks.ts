/**
 * A streaming reply's Markdown, kept on screen block by block: each update replaces only the
 * blocks whose HTML changed (usually the last), where setting the whole HTML again parsed and
 * rebuilt every block of the reply on every update.
 */

/** One block on screen: its HTML and the nodes it put in the container. */
export interface ShownBlock<N extends Removable = ChildNode> {
  html: string;
  nodes: readonly N[];
}

/** A node a block put on screen, as far as taking it off needs it. */
export interface Removable {
  remove(): void;
}

/** The container a reply's blocks are shown in, as far as showing them needs it. */
export interface BlockHost<N extends Removable = ChildNode> {
  append(...nodes: N[]): void;
}

/**
 * Show `blocks` in `host`, which shows `shown`: the blocks before the first changed one stay as
 * they are, the rest are removed and drawn again from `parse`. Returns what the host shows now.
 */
export function showBlocks<N extends Removable>(
  host: BlockHost<N>,
  shown: readonly ShownBlock<N>[],
  blocks: readonly string[],
  parse: (html: string) => N[],
): ShownBlock<N>[] {
  let kept = 0;
  while (kept < shown.length && kept < blocks.length && shown[kept]?.html === blocks[kept]) kept += 1;
  for (const block of shown.slice(kept)) for (const node of block.nodes) node.remove();
  const drawn = blocks.slice(kept).map((html) => ({ html, nodes: parse(html) }));
  for (const block of drawn) host.append(...block.nodes);
  return [...shown.slice(0, kept), ...drawn];
}

/** Nodes for one block's HTML, parsed outside the page. */
export function parseBlock(html: string): ChildNode[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  return [...template.content.childNodes];
}
