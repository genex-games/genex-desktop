import { test } from "node:test";
import assert from "node:assert/strict";
import { showBlocks, type ShownBlock } from "../../src/renderer/ui/prose-blocks.ts";
import { markdownBlocks, markdownHtml } from "../../src/renderer/ui/markdown-html.ts";

/** A node that knows whether it was taken out of the host. */
interface FakeNode {
  html: string;
  removed: boolean;
  remove(): void;
}

function host() {
  const children: FakeNode[] = [];
  const parsed: string[] = [];
  const parse = (html: string) => {
    parsed.push(html);
    const node: FakeNode = {
      html,
      removed: false,
      remove() {
        this.removed = true;
        children.splice(children.indexOf(this), 1);
      },
    };
    return [node];
  };
  const target = { append: (...nodes: FakeNode[]) => children.push(...nodes) };
  return { children, parsed, parse, target };
}

const shownHtml = (children: FakeNode[]) => children.map((node) => node.html).join("");

test("a growing reply draws again only the block that changed", () => {
  const { children, parsed, parse, target } = host();
  const first = "# Plan\n\nThe cube spins.\n\nNext it";
  let shown: ShownBlock<FakeNode>[] = showBlocks(target, [], markdownBlocks(first), parse);
  assert.equal(shownHtml(children), markdownHtml(first, { streaming: true }));
  const before = [...children];
  parsed.length = 0;

  const grown = `${first} jumps.`;
  shown = showBlocks(target, shown, markdownBlocks(grown), parse);

  assert.equal(shownHtml(children), markdownHtml(grown, { streaming: true }));
  assert.deepEqual(parsed, [markdownBlocks(grown).at(-1)], "only the last block was parsed again");
  assert.deepEqual(
    before.filter((node) => !node.removed),
    children.slice(0, -1),
    "the finished blocks are the same nodes",
  );
  assert.equal(shown.length, markdownBlocks(grown).length);
});

test("a block that changes earlier in the reply draws it and everything after it again", () => {
  const { children, parse, target } = host();
  let shown = showBlocks(target, [], ["<p>a</p>", "<p>b</p>", "<p>c</p>"], parse);
  const [a] = children;
  shown = showBlocks(target, shown, ["<p>a</p>", "<h2>b</h2>"], parse);
  assert.deepEqual(
    children.map((node) => node.html),
    ["<p>a</p>", "<h2>b</h2>"],
  );
  assert.equal(children[0], a);
  assert.equal(shown.length, 2);
});
