# Genex UI provenance

Imported with the application owner's authorization from their sibling repository
`genex-cli-threejs`, commit `e67920b591cff31d7d537a5477033a056840721a` (19 September 2026).
The source checkout was read only. Studio builds use local files and never require that checkout.
Paths below are relative to its `apps/web/` directory.

The owner's contributions and Studio adaptations use the repository's MIT license. Fonts and
other upstream components retain their separate notices. The code license grants no trademark
rights in the Genex name or logo.

| Source | Local adaptation |
| --- | --- |
| `public/genex-logo-dark.svg` | `ui/GenexLogo.tsx`: original dark wordmark paths and gradients, JSX attribute names and accessible image name |
| `app/globals.css`, `app/layout.tsx` | `src/renderer/theme.css`: dark tokens, type roles, offline font faces, tracking, surfaces and motion; desktop semantic aliases preserved |
| `app/fonts/{ZalandoSansSemiExpanded,GeistMono,Geist}-variable.woff2` | The same binaries in `src/renderer/fonts/` |
| `components/dom/ui/button.tsx`, `accent-chip.tsx` | `ui/Button.tsx`, `accent-chip.tsx`; secondary default for existing Studio actions, primary intents explicitly mapped |
| `components/dom/ui/{dropdown-menu,popover,switch,tooltip,input,textarea}.tsx` | Same primitives in `ui/`; desktop overlay stacking, import paths and accent semantics adapted |
| `components/dom/ui/dialog.tsx` | `ui/dialog.tsx`; desktop Radix branch, shared sizing, focus restoration and exit lifecycle; no mobile drawer |
| `components/dom/ui/{view-switcher,animate-height}.tsx` | Same components in `ui/`; keyboard navigation and font-resize measurement added |
| `lib/utils.ts` | `ui/cn.ts`: class composition and type-role merging; unrelated helpers omitted |
| `components/dom/ui/prompt-bar.tsx`, `components/create/{ComposerDock,Transcript,ChatMarkdown}.tsx` | Presentation adapted into existing Studio composer/transcript; existing safe Markdown, runtime model/role data, attachment and send/stop semantics retained |
| `components/dom/ui/pixel-loader.tsx` | `LoadingState.tsx`: the Genex shimmer and token roles; the pixel grid is drawn anew |

The original application's business code is not part of this transfer. Existing Studio
project, provider, plugin-consent and run logic remain the behavior authority.
The web app's primitives (`Button`, `dialog`, `dropdown-menu`, `input`, `popover`, `switch`,
`textarea`, `tooltip` and `cn.ts`) follow shadcn/ui, credited in
[THIRD-PARTY-NOTICES.md](../../../THIRD-PARTY-NOTICES.md#shadcnui).

## Font licenses

Each font is licensed under SIL Open Font License 1.1; its full notice ships beside the binary.
License texts were retrieved from the upstream copies:

- [Zalando Sans SemiExpanded OFL](https://github.com/google/fonts/blob/main/ofl/zalandosanssemiexpanded/OFL.txt), as published.
- [Geist Mono OFL](https://github.com/google/fonts/blob/main/ofl/geistmono/OFL.txt), as published (Latin, Cyrillic, Greek).
- [TikTok Sans OFL](https://github.com/google/fonts/blob/main/ofl/tiktoksans/OFL.txt): the Cyrillic and Greek of
  `TikTokSans[opsz,slnt,wdth,wght].ttf`, fixed at opsz 14, wdth 109, slnt 0 (Zalando Sans SemiExpanded's
  lowercase width), its weight axis relabelled so CSS weight w draws TikTok's 1.16w − 19 (Zalando's stem
  thickness at 300–700), named "TikTok Sans Genex"; `size-adjust: 101.3%` in theme.css matches
  Zalando's capital height.
- [LINE Seed JP OFL](https://github.com/google/fonts/blob/main/ofl/lineseedjp/OFL.txt): Regular and Bold, as published.
- [Pretendard OFL](https://github.com/orioncactus/pretendard/blob/main/LICENSE) (Reserved Font Name "Pretendard"):
  `PretendardVariable.ttf` 1.3.9 cut to Hangul and CJK punctuation and renamed "Genex Hangul", as the
  license requires of a modified copy.
- [Noto Sans SC OFL](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt): `NotoSansSC[wght].ttf`
  cut to the 7,445 characters of GB 2312 and the CJK and full-width punctuation; rarer characters fall to
  the system font.

Zalando Sans has Latin only (zalando/sans#40 asks for Cyrillic): Cyrillic and Greek come from TikTok
Sans, and the app language's script from LINE Seed JP, Genex Hangul or Noto Sans SC, all after
Zalando in the stack (`--font-language` in theme.css). There are no runtime font-network requests.

## Other notices

The Genex icon set in `ui/icons.tsx` is drawn for this app; its motion is plain CSS in
`styles/icons.css`. Lucide, Radix, Base UI, CVA, clsx, Tailwind Merge and animation CSS
retain their installed package licenses; the build gathers notices from actual bundled dependencies.

## AG-966 search and cover adaptation (20 September 2026)

Read from the owner's same sibling checkout, kept read-only:
- `apps/web/components/header/SearchBox.tsx` → `panels/GameSearchDialog.tsx`: dialog layout,
  debounce, keyboard navigation and thumbnail rows, adapted to the local library.
- `packages/catalog-search/src/{types,tokenize,buildIndex,query}.ts` → `src/shared/catalog-search/`:
  local BM25 engine, with prototype-safe index dictionaries. No package installation.
- `apps/web/components/game-page/CoverDialog.tsx` → `panels/GameCoverDialog.tsx`: local crop,
  preview and save flow. Normalize uploads to 256px PNG for Electron's native image decoder
  (the web source used WebP). No R2 upload, API request, analytics or paid AI regeneration.

`shared/game-cover.ts` and the default geometric placeholder are original procedural code for
this task. Existing fonts, logo paths and third-party notices are unchanged.

## Coin mark

Read from the owner's same repository (its checkout `genex-demo` holds the commit above), at
`origin/main` `b275f132905d5e9d5b9429acf6396fbbf8cb9144` (19 October 2026), kept read-only:
`apps/web/components/credits/CoinIcon.tsx` → `play/CoinMark.tsx`: genex.games' 11×10 pixel coin,
row for row, and the light and shade of its one gold (45% of the gold in white, 65% in black), as
the `--coin` tokens in `styles/play.css`. The component is written anew; its other palettes are not used.
