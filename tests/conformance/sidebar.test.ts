/**
 * The rail — the ported design-system left panel.
 *
 * `node --test` cannot render a .tsx (its type stripping does not transform JSX) and the
 * conformance suite has no DOM, so these are source-level gates. They are still real tests:
 * each one has a failure the port actually risked.
 *
 *   · the kit speaks a vocabulary of theme tokens, and a token the theme never defines does not
 *     error — it renders transparent text on a transparent row. The token gate below resolves
 *     every class and every `var(--…)` the ported files use against `theme.css`.
 *   · the rail is where `run-agentic-readiness` types and clicks. The selector gate keeps the
 *     handles `docs/agent/feature-map.md` names.
 *   · the plan's vocabulary table says the section reads GAMES, that no destructive control hides
 *     behind a hover, and that the mono eyebrows and counters go.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");

const PORTED = ["src/renderer/ui/kit.tsx", "src/renderer/ui/icons.tsx", "src/renderer/panels/Sidebar.tsx"];

const theme = read("src/renderer/theme.css");
const sidebar = read("src/renderer/panels/Sidebar.tsx");
const kit = read("src/renderer/ui/kit.tsx");

/** Every custom property `theme.css` declares, wherever it declares it. */
function declared(): Set<string> {
  return new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** The `@theme inline` block — the only declarations Tailwind turns into utility names. */
function themeBlock(): string {
  const start = theme.indexOf("@theme inline {");
  assert.notEqual(start, -1, "theme.css no longer has an @theme inline block");
  const end = theme.indexOf("\n}", start);
  return theme.slice(start, end);
}

/** Utility prefix → the `@theme` namespace it reads, for the utilities the kit uses. */
const NAMESPACES: Record<string, string[]> = {
  bg: ["--color-"],
  text: ["--color-", "--text-"],
  border: ["--color-"],
  rounded: ["--radius-"],
  shadow: ["--shadow-"],
  h: ["--spacing-"],
  size: ["--spacing-"],
  w: ["--spacing-"],
};

/**
 * Suffixes Tailwind ships itself: a number (its spacing scale), and the handful of keywords the
 * kit leans on. Anything else must come from a token, or the utility silently does nothing.
 */
const BUILT_IN = new Set(["full", "left", "white", "transparent", "r", "t", "gradient-to-b", "none"]);

describe("the rail's theme tokens", () => {
  it("resolves every namespaced utility the ported files use", () => {
    const block = themeBlock();
    const missing: string[] = [];
    for (const file of PORTED) {
      const source = read(file);
      for (const match of source.matchAll(
        /(?<![\w-])(bg|text|border|rounded|shadow|h|size|w)-([a-z][a-z0-9-]*)(?![\w-])/g,
      )) {
        const [whole, prefix, suffix] = match as unknown as [string, string, string];
        if (BUILT_IN.has(suffix)) continue;
        const ok =
          theme.includes(`@utility ${whole} `) || NAMESPACES[prefix]!.some((ns) => block.includes(`${ns}${suffix}:`));
        if (!ok) missing.push(`${file}: ${whole}`);
      }
    }
    assert.deepEqual(missing, [], "utilities with no token behind them render as nothing");
  });

  it("resolves every var(--…) the ported files reference", () => {
    const defined = declared();
    const missing: string[] = [];
    for (const file of PORTED) {
      for (const match of read(file).matchAll(/var\((--[a-z0-9-]+)\)/g)) {
        if (!defined.has(match[1]!)) missing.push(`${file}: ${match[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("aliases desktop names onto the shared Genex palette", () => {
    const defined = declared();
    // Every alias points at something: `--fg: var(--ink)` is only useful if `--ink` is real.
    for (const match of theme.matchAll(/(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)\s*;/g)) {
      assert.ok(defined.has(match[2]!), `${match[1]} aliases ${match[2]}, which theme.css never defines`);
    }
    // The panels that have not been ported still read the ramp the app shipped with.
    for (const token of ["--page", "--canvas", "--surface", "--inset", "--ink", "--ink-2", "--ink-3"]) {
      assert.ok(defined.has(token), `${token} disappeared; the unported panels render on it`);
    }
    // The self test reads --canvas off the document to prove the stylesheet arrived at all.
    assert.match(theme, /--canvas:\s*var\(--background\)/);
  });

  it("keeps the hit target the small glyphs depend on", () => {
    assert.ok(kit.includes("hit-24"), "the kit draws 11-13px glyphs and pads their hit area");
    assert.match(theme, /\.hit-24::after\s*\{/);
  });
});

describe("the game library's navigation", () => {
  it("keeps stable game and Studio locators", () => {
    assert.match(sidebar, /data-thread="studio"/);
    assert.match(sidebar, /data-thread=\{threadId\}/);
    assert.match(sidebar, /data-project=\{game\.name\}/);
    assert.match(sidebar, /<nav\b/);
  });
  it("has a keyboard-reachable overflow and confirmation before removal", () => {
    assert.match(sidebar, /DropdownMenuTrigger asChild/);
    assert.match(sidebar, /aria-label=\{t\("Actions for \{game\}"/);
    assert.match(theme, /sidebar-game:focus-within \.sidebar-game-menu/);
    assert.match(read("src/renderer/panels/GameDialogs.tsx"), /files and conversation history stay/);
  });
  it("keeps New game and search above the scrolling library", () => {
    assert.match(sidebar, /sidebar-fixed/);
    assert.match(sidebar, /data-sidebar-scroll/);
    assert.match(sidebar, />\s*\{t\("New game"\)\}\s*</);
    assert.match(sidebar, /label=\{t\("Create game"\)\}[^>]*onClick=\{onNewGame\}/);
    assert.match(sidebar, /<span>\{t\("Games"\)\}<\/span>/);
    assert.doesNotMatch(sidebar, /New chat in|toggleFolder|<ChatRow/);
  });
  it("uses shared keyboard search rather than an inline filter", () => {
    const search = read("src/renderer/panels/GameSearchDialog.tsx");
    assert.match(search, /role="combobox"/);
    assert.match(search, /aria-activedescendant/);
    assert.match(search, /role="listbox"/);
    assert.match(search, /initialFocus=\{input\}/);
  });
});
