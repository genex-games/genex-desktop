# Studio's Genex design system

The implementation is `src/renderer/theme.css` and `src/renderer/ui/`. The app uses the
Genex source application's visual language with local desktop behavior. See
[SOURCES.md](SOURCES.md) for provenance and [the design workflow](../../docs/agent/design.md)
for principles and skill routing.

- **Type:** Zalando Sans SemiExpanded for words, Geist Mono for actions and machine text;
  restricted Geist fallback for Greek/Cyrillic. Chat/menu 14px, composer 15px, dialog title
  20px. Use named roles rather than adding arbitrary font sizes.
- **Color:** configurable semantic light/dark palettes on one shared lightness ramp. A first launch follows the
  system's light or dark, painted before the page's first frame (`appearance/first-paint.ts`); Genex dark is the dark default,
  with near-black page `#0e0d0f`, darker sidebar `#0b0b0d`, raised card/composer/dialog `#141416`, menu `#19191b`,
  indigo accent `#3c44c4`; light uses page `#f8f8f8`, sidebar `#f6f7f7`, cards and menus `#fdfdfd`, accent `#3f61f5`.
  Settings uses the sidebar and page colors; the menu color is only for menus. Desktop `--accent` means the chosen interactive accent; neutral hover
  uses `--hover`. Existing aliases resolve to the same palette. See [themes](THEMES.md).
- **Actions:** `Button` defaults to quiet `secondary`, 32px high. `default` is the accent
  primary action, white text on the accent darkened to 5:1 (`--accent-fill`); `accent-tint` is a restrained accent fill; `ghost` is for
  unobtrusive toolbar actions. Buttons and shortcut badges have rounded backgrounds with no borders.
  Shortcut modifier glyphs and keys have an explicit gap. Do not add a second primary action
  to demonstrate a variant.
- **Overlays:** Radix dropdowns for commands, Base UI popovers for search and mixed controls,
  `DialogSurface` for modal tasks. Portals handle clipping. The native game preview yields
  its rectangle while a shared overlay is mounted, including its exit animation.
- **Selectors:** `Switch`/`Toggle` for booleans, `ViewSwitcher` for segmented views. Arrow
  keys and Home/End select tabs.
- **Motion:** 150ms quick, 250ms opening, shared ease; disclosures and picker resizing
  transition in place, and what comes and goes in the chat opens and closes in place
  (`ui/Presence.tsx`, see Chat reading and activity). Interactive icons use control
  hover/focus. Reduced motion makes feedback static while preserving live content and timers.
- **Startup:** until the first screen is drawn (the studio with its games and open chat, the
  welcome, sandbox setup or a failure) the window shows only the Genex G, 34px wide, centred on the
  page colour in a tenth of the theme's ink, with a light crossing it once every 3.2s. It is
  markup in `index.html` (`#app-loader`), there before the app's bundle; it fades in after 120ms (so
  a faster start sees only the page), fades out in 200ms and never returns, and the window can be
  dragged by it. Reduced motion shows it at once and still. A failed start shows each
  area's failure and Retry, which stays up, busy (**Retrying…**), while it runs.
- **Loading:** there are no skeletons. A region whose content is on its way uses `Pending`: nothing
  for 400ms (the local reads behind chats, settings, activity and files usually finish unseen),
  then its label ("Loading conversation…") shimmering in ink-3, still under reduced motion.
  Nothing claims to be empty (No matches, No screenshot, stripes for a missing still) before its
  read has answered, and a read that fails says so instead of checking forever. Media keeps a
  plain inset tile of its final size while it loads; an agent's turn keeps `LoadingState`; actions
  swap their button label (**Sending…**) and disable it; a long one (Publish) is `Button busy`:
  a spinner, same fill, no second press.
- **Interaction:** enabled controls and their children use pointer cursors. Keep visible
  keyboard focus through a contrasting 2px inset edge, appropriate disabled states, semantic
  names and safe dialog dismissal. Focus must be distinct from hover without external rings;
  text fields draw no inset edge (a focused one always counts as keyboard focus): their caret
  and their own edge or panel show focus. A dialog layer or heading that script focuses
  (`tabindex="-1"`) is not a control and takes no edge, so the welcome never frames the window.
  All Settings tabs share the same
  viewport-capped 860px width and 720px content height.

## Development gallery

`node scripts/design-gallery.mjs` builds `Gallery.tsx` to `.studio-dev/design-gallery/`.
It uses the actual shared components and production stylesheet; it is not shipped.
Open the generated `index.html` to review the specimens.
`npm run test:design-ui` renders it in an isolated Electron profile, checks actual font usage,
keyboard selection, focus, pointer cursors and reduced motion, and writes screenshots plus
`report.json` there. Application acceptance still requires real Studio fixtures.

## Contrast and customization

The selected theme drives semantic roles; primary/destructive fills choose black or white
labels. Hover shifts the fill away from its label luminance, preserving readable contrast. Text roles are measured against
canvas, card, sidebar, menu, field and hover backgrounds. Preset acceptance and real computed
contrast checks live in `appearance.test.ts` and `run-appearance-ui.mjs`. User overrides remain
editable and portable; derived text adjustments preserve readability. Contradictory surface
brightness is reported with a readable Reset action. Settings font choices reuse offline or
system families. See [sources and format boundaries](THEMES.md).

## Chat reading and activity

The default build view in chat is one build card with one line of current work. Tools, attempts,
routine trace messages and detailed checks use progressive disclosure. Keep failed work and
required decisions visible; never infer success from a missing result. User bubbles and assistant
prose form the reading order, with delivered images/files as results in that conversation.
Use shared surfaces/type/spacing, no per-message model labels or repeated technical status cards.
Chat uses one 15px/22px reading size for replies, activity headings and tool steps;
14px/20px is reserved for descriptions and metadata. Headings use weight and spacing at
the same reading size. Keep Genex fonts and palette. The transcript sits 20px in from the column's sides and
scrolls flush under the composer, with no strip between its last line and the composer's edge. Soft user bubbles use 12px horizontal and 8px vertical
padding; images sent with a message sit right-aligned above it as 120×84 tiles with a 12px radius (placeholders hold their place while loading), and a tile opens the image beside the chat. Names of files that exist link wherever the chat shows them; names that are not files stay plain text. In Markdown prose (inline code paths, links without a scheme, bare paths) they are 6px-radius field chips with a 13px file icon in the body font. In plain text, code and tool rows they are underlined words in their own font and colour (underline 40% of the text colour, 3px offset, full colour and ink on hover); a focused link in a user bubble takes the line-strong fill, and one reached by keyboard in a folded bubble unfolds it. A tool row's path is a link beside its disclosure toggle, which stretches over the row; the path gives up its folders before its file name. The tooltip says what a click does — "Opens beside the chat", "Opens in its default app", "Opens in Finder" or "Shows in Finder" (Explorer on Windows) — then the path when the label hides it, and "In the build · not in your game folder yet" for build-only files. Game Markdown and images open a file tab in the stage: a 60px header with the name at 15px medium, "In the build · not in your game folder yet" at 13px ink-3 only for build-only files, Show in Finder (folder files only) and Close; Markdown reads at 15px/24px in a 700px column with 28px/44px insets, text as highlighted 13px mono, images centered. The stage returns to the previous tab on Close. User messages longer than seven rendered lines fold with a 32px fade and a left-aligned, unpadded Show more text button; Show less restores the compact view. Short messages have no toggle. One disclosure groups neighboring tools and routine updates, with a trailing
right/down chevron, 6px gap and regular weight. Failures stay visible in a muted amber count;
the failed step itself uses the error color. Expanded tools sit in a shared 10px-radius frame with row dividers and 8px top spacing.
Tool rows have 36px minimum height, 10px horizontal padding, 12px icons and 8px gaps.
Their single-line labels truncate; the complete label is available in the title and the
recorded input/output in expanded code blocks. Expanded details use 13px/20px mono, 10px outer insets, and 10px padding within code; output retains the same text inset. Tool data formats only on expansion. Explicit code languages use a limited highlight.js bundle and existing semantic colors; unknown logs and blocks over 32,000 characters remain plain.
Workers remain compact 32px rows with 6px insets/gaps, named tasks and disclosed details.
Successful tools need no repeated status. Code uses mono; tool labels, filenames and prose
use the body font. A shown path is not repeated in the result.

Working status belongs to the chat's own work (a turn, a plan, Stop, a pending permission). While only a build runs, chat shows one build card instead, and nothing under it: an 8px-inset 16px-radius composer-colored surface with the lead's latest non-black frame (88×55, 10px radius, omitted until one exists), "Building" and a chevron at 15px, one line of what is happening now at 14px ink-3 (the part at work, "and N more" when several are, else what the lead is doing — never "Running a tool"), and its clock on the right at 14px: the elapsed time, and under it in ink-3 the most it was given ("up to 10h", a cap, never "of 10h": a build may finish inside it; an ∞ build shows only the clock). The finished build is the same card: its capture, the outcome and chevron, one line of failed checks, parts added and duration ("4 parts added · 5h 17m"; orange and led by "1 check failed" when one failed), and Play on the right in the model pill's fill (`pill-quiet`, as every result button, “See it” included) with a filled play glyph. Nothing wraps under it. The whole card is one button to the build's graph on Builds (its title stretched over the card, tooltip "Open in Builds"): the pointer on it steps the card to composer-panel with a line-strong ring and inks the nudging chevron; keyboard focus rings the card in accent; Play sits above it, and the pointer on Play leaves the card unlit. Studio learning after a build is a static line. The composer placeholder during a build reads "Talk to the lead while it builds…" when its lead takes the chat (live chat), else "Sends when the build finishes…".
The current status names the latest running tool, falling back to the actual task. Explicit
reply, tool and waiting phases retain priority. The live status line (home's Naming and Opening
too) is 12/18 type after a 14px halftone plasma orb (the Live loader's, `ui/StatusOrb.tsx`), 8px
apart; its words and clock shimmer together, a bright sweep then a rest (2.1s). Waiting for the
user stays static, with no orb. Elapsed time follows the status on its line in the same type and ink-3, in tabular figures, from its first whole second (never "0s"), and restarts with each new status; its width glides as it comes, changes or goes while the chat waits. A disclosure's chevron sits 2px closer to its words than the line's other gaps. Work disclosures reduce their surrounding reading space by 3px above and below; the live status uses a single reading gap after the last transcript row. Stop belongs to the PromptBar; activity and sidebar status lines have no Stop control. Planning names the current phase in this same status, without another status near the composer. Starting a build yields to actual conversation/worker activity; a cancelled plan is a historical entry, never a persistent current status. Empty conversations have no introduction or starter suggestions. Historical content does
not replay entrance animations. Streams use the same Markdown as final replies and bounded
updates. Long work trails mount 30 steps at a time, workers initially show six, and history
is paged/windowed. Studio build reports and learning use the same `ChatDisclosure` heading, body font and framed expansion as work logs; only genuine decisions get answer controls. Routine build decisions remain activity text, with failures visible. A new running build opens Builds once (after the idea-to-crane hand-off when Live shows the first-idea state); later tab choices remain with the user. There is one elapsed timer, without a second build-total line. Scroll-follow accounts for the composer/question dock changing height and
never pulls a reader away from history.

Loop intake uses the same question surface for `ask_user`: its options, then a row with a radio and an inline "Write your own answer…" field (focus or typing selects it; Enter sends), each radio on its label's first line. The footer pins **Chat about this** (a filled quiet button with a chat icon, at the leading edge) opposite **Send answer**; it puts the card aside behind its "Answer question" reopener and focuses the composer. The choices scroll inside the card (at most 60% of the window); the footer never does. That card has no close icon. **Send answer** stays disabled until a choice or typed text exists. Selection alone never sends. Questions survive reload and pagination; any submitted reply settles the question. Model-generated questions must be requested through the tool, not inferred from arbitrary prose or routine progress. Host handoff/session narration stays in diagnostics, including suppression of known older host templates.

Permission questions use one full-width composer-colored surface: 16px horizontal/12px
vertical padding, full-row choices with 16px radio marks and visible descriptions. Selection
never submits permission. Continue explicitly sends the selected answer; a busy request blocks
duplicate submission. Putting a question aside only collapses it and leaves a keyboard-reachable
reopener. Pending plugin and Claude permission questions are pinned above the composer even if
their history page is unloaded; settled outcomes remain in history. Request arguments are disclosed in context. Plans appear expanded with a scrolling Markdown
body and a fixed compact footer: primary **Approve**, secondary **Make changes** and **Cancel**.
Make changes shows a chat status and focuses the existing composer without overwriting its
draft. Approve remains disabled while that revision is being drafted; sending it requests a
new plan and explicit approval. Failed plan generation uses a recovery card with Choose model, Model providers, Try again and Dismiss; approval controls appear only for a prepared plan. Raw error details expand on demand. Steering can prefill the composer. These reuse existing consent
and plan APIs; they do not add the web app's question protocol. Permission cards/docks scroll when available height is short; option lists have no separate
scroll box. The plan body scrolls independently so all three footer actions remain reachable.

Claude Code's own permission requests use that surface too (`chat/PermissionRequest.tsx`). The
title is Claude Code's sentence ("Claude wants to edit main.js"); for Bash it reads "Claude wants
to run a command" and the command follows once, in highlighted mono (`chat-tool-code`), never
repeated in the title. A file tool shows its path as a link; the description line is Claude's
description, else its reason. Choices: **Allow** ("Just this once."), the offered grants in words,
every one named ("Always allow npm install commands in this game"; absent when none is offered)
and **Deny**, then an own-words row, "Tell Claude what to do instead…", which denies with that
message. **Request details** discloses the reason and the tool input. A plan leaving Plan mode is
**Approve this plan?**: its Markdown in a focusable region that scrolls (at most
max(5rem, 45vh − 19rem); its last line fades over 32px while more lies below), then **Yes, in Auto mode** (left out where Auto is unavailable for the
model), **Yes, and accept edits**, **Yes, and ask before changes** and a "Keep planning: what
should change?" row. Continue confirms; put aside, a card reopens from Review permission request
or Review plan. Settled, history keeps one disclosure line in the "Worked on N steps" type: the
outcome, then what it was about (Allowed · npm install three, Always allowed · …, Denied · …,
Withdrawn when the work stopped · …, and for a build's lead's card nobody answered in five minutes
Withdrawn: nobody answered · …; a plan reads Plan approved · Auto). It opens to the question as
asked, the command or path, the person's words and the reason. A lead's card never offers a mode, and a lead never brings a plan for approval.

Delivered media uses the shared preview tile, including model thumbnails; several visuals form a
two-column grid. The picture is the card and opens the viewer: nothing sits on it at rest; hover or
focus brightens its 1px outline, eases the picture in 3.5% and shows one 28px glass corner action,
Open in Assets (the four-tile glyph). Animation-only files (a rig and its clips, no mesh, read from
the GLB header) never get a card: they ride on the model whose bones they move as a "3 animations"
chip, or, when that model came earlier, share one 52px row (Knight animations · Wave · Jump) that
opens it. Sounds are 44px rows: a filled ink play button, the name, a 40-bar waveform seek and the
length, which gives way to Open in Assets on hover; the row is the player, with no dialog. Every
colour is the theme's, so models, pictures and sounds sit alike in light and dark; the Assets tab's
sound tile draws its waveform live the same way. Only files present in the game folder appear;
Loop-run files wait for the landed build result. Large deliveries reveal six previews at a time.
Asset grids omit per-file metadata and job headers. The viewer is the file on the page's own colour
(88%, blurred), with only Reveal in Finder and Close in the top corner and no title; a click on a
picture shows it at full size around the point clicked; a model opens playing its first clip, with
play, the clips and speed in one floating bar and "Drag to turn · Scroll to zoom · Double-click to
reset" above it. A kept Genex cover is one card once its turn ends, after the reply (never
mid-turn), the build card's composer-coloured 16px-radius surface with an 8px inset and a 1px line:
the shot at 16:9 (10px radius, object-cover, at most 26rem wide, the preview tile's hover; a click
opens it whole beside the chat), and under it a 15px ink caption, "Genex cover", 8px in, with
Publish on the right, the result button's size and type (as Play) in the accent fill, globe glyph.
Chat build outcomes show the finished build card: capture, delivery status and Play; the card itself
opens Builds.
Only current-revision captures are selected from checks. Failures stay explicit; detailed checks
and evidence limits remain in Builds/Studio. Learning counts link to Studio and omit zeros.
What appears in the chat opens in place over 250ms: its height grows from nothing while it fades in,
so what follows it (or, while the chat follows its newest line, the conversation above) glides
instead of jumping; what leaves closes the same way over 150ms. That covers new rows, a message
being sent, the work line and the build card (one closes as the other opens), the cards above the
composer (their height glides from one card to the next, which fades in), disclosures (the chevron
turns) and the build card's first picture, which slides in. A reply being written grows line by line
in a 150ms glide, except while the window rests (`renderer/motion-rest.ts`); work followed by a
streaming reply stays in the transcript above it, so nothing moves when the reply is saved, and the
saved reply does not enter again. A status label (and "Worked on N steps") stays at least a second, then the newest fades in while
its width glides to it, the chevron sliding along and fading in and out with the work's details. A
finished build card keeps its result's place, without words, for up to 3s while the result loads; a
result that never comes closes the place, a late one opens in it. History, an opened chat and media never
enter, and reduced motion shows every change at once. Only height and opacity move, a short layout of
the chat's tail per frame while something moves.

A sent message appears at once, with its pictures. In an idle chat it is the next bubble and the
live status reads **Sending** (no spinner) until it is saved. While the chat's agent works, the
message goes into that work: it waits below as a muted bubble with a 12px **Sending…** label until
the agent reads it, then sits where it was read and the reply continues below it. Only where it
cannot join — for example during a build, to another model, in Studio's chat or with a local model
without sessions — does it read **Queued**, with Remove, until its own turn. The saved row takes its
place, carrying on the bubble's opening; a delivered one closes below the work as it opens where it
was read. Every sent bubble reveals **Rewind**
(the `rewind` glyph, a counter-clockwise arrow that turns back once) as a 24px icon button 4px left
of the bubble, centred on its last line, on row hover or focus-within and always under `hover: none`,
including messages before a build and ones read into another's answer; it is absent while the
chat answers (a running build does not count), on queued input and in Harness. It confirms in a
dialog: "Rewind to before this message?", one line on what leaves, a **Restore game files** switch
with what comes back (files changed outside the chat are named and turn it off by default), ghost
Cancel with initial focus and a destructive **Rewind chat**. When the files cannot come back the
switch is absent and one muted line says why, starting "Only the conversation rewinds:" (a build
or a commit changed the game after this message, there's no saved copy from before it, it joined
an answer already under way); a running build reads "A build is running. Rewinding stops it and
cuts off any answer under way; the game's files stay as they are." and the button reads **Stopping
the build…** while it works. The rewound words fill the composer ahead of any draft already there; its pictures join
those already attached, up to the composer's limit.

## Studio hierarchy and progressive disclosure

The shell is conversation-led: a full-height sidebar contains the theme-aware Genex wordmark,
Search, the Notifications bell, **New game**, **Plugins**, **Harness**, **Settings**, then **Games**. Everything above the game
list stays fixed; only the flat game list scrolls, with a 24px fade into the sidebar colour once it
has moved. The four actions are one stack of 36px rows, 2px apart, with labels styled like game titles, 18px animated
icons (their ink in line with the wordmark's left edge) and an 18px accent count badge on Harness. Game rows use 28px circular covers, 14px Medium
titles and a keyboard-reachable overflow menu 6px from the row edge. The row's end is one 28px slot: the working dot, else the pin, and ⋯ in their place on hover or focus. Rows, nav items and sidebar
buttons use the derived `--sidebar-selected`/`--sidebar-hover` fills (quieter than the shared hover in
dark themes, visible in light ones). The toggle sits 80px from the window edge, just clear of the
native window buttons, on one line with them and the header title (24px down), and stays there
when the sidebar is hidden. Send feedback's bug ends that line, centred over the bell's column,
and leaves with the sidebar; it opens an lg dialog: the text field, Attach app logs and (with a
chat open) Attach this chat, two switches that start off with a line each on what they add,
Cancel and Send. Pinned games sort first, then recent activity. The sidebar has no global readiness/build footer; activity
belongs to each game row and conversation, with Stop in the chat. No folder disclosures or chat counts. Sidebar visibility persists on wide
windows; at 900 CSS pixels and below it becomes a dismissible drawer so both content panes remain
usable at zoom. Hidden navigation and the content behind an open drawer are inert. Command-B
opens/closes navigation; Command-K opens the local search dialog without changing sidebar
visibility. Search uses the Genex BM25 engine, 120ms debounce, prefix matching, cover thumbnails,
arrow navigation and Enter. Escape closes it and restores focus. Native traffic-light space remains reserved in the
leading header when the sidebar is hidden. Respect reduced motion for the shell transition.

Notifications hang off the bell in a 360px picker-panel popover, never a modal. Waiting for you
(questions, plans, permission requests) comes first with an accent-tint action chip and stays until
the log settles it; activity follows under Today / Yesterday / Earlier and is read by opening.
Rows use 28px covers (a provider mark or glyph tile otherwise), a 14px Medium source with its
relative time beside it, and one 13px/18px line of text truncated with an ellipsis (the full text in
its tooltip; failures in orange); only rows new at opening carry a dot.
Rows open where the action lives and never repeat it. The bell shows a 15px accent-fill count for
waiting work or an 8px dot for unread news; the mark slides in diagonally and pops without moving
the bell, and the glyph rings once (`data-announce`) when something arrives. With the sidebar
hidden, Show sidebar carries the dot. Arrivals while Studio is unfocused also post macOS
notifications (at most three, else one summary); the Dock badge counts waiting work.

Selecting Harness (internally the Studio conversation) opens its assistant conversation beside Activity; selecting a game chat
restores chat + game stage. There is no global Build/Review switch. Command-2 enters Harness;
Command-1 returns to the last game chat. Unsent composer text survives first-time thread loading; new chats focus the composer after that load. The header and sidebar toggle remain reachable during chat loading and errors.
Activity spans all games and runs; it has no global game or run selector. An expanded run links
to its game chat, while normal Studio navigation preserves the previous game-stage selection.
Plugins opens as a full workspace page from the sidebar in either workspace. Its Plugins/Skills
header, search (12px radius), flat integration rows and detail pages share the app tokens. Back
to workspace is a secondary button. Add is the page's one accent button: Install from GitHub… |
Add MCP server…, Import MCP configuration… | Create a plugin ↗, Load local plugin…. Rows wear the
plugin's own picture (44px, 10px radius; 64px/14px on its page; 16px/4px in menus), full-bleed
like a Dock icon, else its initial on a `--line-strong` tile; interface glyphs use the icon colour.
Genex's row and page name it the game dev tools router ("Genex · Tripo, Meshy, …" as its line) and
its picture is the routed tools' marks on a dark 2×2 board that is never empty: every 1.3s a row or
column slides one step, one tool leaving as the next of eight slides in; still in menus and under
reduced motion. Its Connect is the accent fill.
Descriptions are one line with an ellipsis. A row's account is one step: Connect (with a tooltip;
a locked saved sign-in reads the same), Finish in your browser · Cancel, Reconnect, or the
balance in mono ink-2. MCP servers lists only servers the person added, each with its switch,
and before there is one a row with a dashed plug tile, "Connect any MCP server" and what can be
connected; a plugin's own server appears in search as "Part of …". Below it the Marketplace: its
title with no rule, a Coming soon badge and a shelf of dashed empty slots (a few faint glyphs, one
accent slot pulsing), until the catalog offers something you lack; then More plugins lists it. The list ends with Make your own plugin (dashed code tile, Read the guide ↗). Install from
GitHub is a lg dialog: GitHub link field, the plugin card (picture, name, "by owner", one line,
Version · Change), one muted note, Cancel and the accent action.
Every plugin page leads with one setup card (Genex's account, Local Blender's runtime) in the
same 16px-radius surface (15px medium state, 14px ink-3 line, one filled action, a failure's
reason in 13px red inside the card). Genex's connected card shows the green dot, identity and one
24px Credits stat with "One balance for all your games"; no per-game numbers (those are in the
usage panel). Then Genex's Tools it routes (each tool's mark on a dark 34px tile, its name and a
mono line, in a grid of 12px-radius cards) or another plugin's two-column grid of 40px glyph tiles
(What it does) and Connections; then Skills as one line with Show all, and Information (Developer, Version, "Can" in
words, the trusted-code line). No plugin frames on Genex's or Blender's pages; Publish is a
host-drawn lg dialog on the stage, "Publish to the web" with a globe after the title, for every open game: it first asks for
what is missing, one line and one press (an accent-tinted line "Publishing goes through" the Genex
plugin, a blue chip with ↗ that closes the dialog and opens the plugin's page, and Install Genex plugin or
Turn on Genex plugin in the footer; Connect Genex with the
browser code), then shows the Game page row (a Test version row only while a draft is online and
the game is not public), a stepped progress bar, and the accent Publish (Publish update once public). While the plugin
reports no Genex cover shot to send and the owner chose none, one 13px ink-3 line under the game row ("No cover yet.
Genex shows a real frame of your game.") carries a quiet sm Ask for a cover at its trailing edge; it closes the dialog
and leaves the ask in that game's composer, cursor at the end, never sent. Hidden while publishing. While it asks to set up (under the tinted line) or to publish, "Native app export for Mac,
Windows and Mobile coming soon" sits just above the buttons, in the description's type. More (⋯) and the switch sit beside every
plugin's title. Back to workspace and sidebar navigation restore the preserved conversation. Export is the first item of the game
chat header's ⋯ menu and uses that chat's bound game; it is disabled on drafts and absent from Harness. Preserve the mounted
game stage, selected build history and native-view occlusion behind Review, drawers and dialogs.

Chat header and stage strip are 48px: 8px above and below 32px controls, and every gap between
controls drags the window. The game title hugs its text (at most 320px, then truncates); select it
to rename, Enter to save and Escape to cancel. Rename updates the library display name; folder
paths and identifiers stay stable. Show in Finder and Terminal sit together at the header's end,
then ⋯ (Export game…, Rename). One game has one chat, so there is no chat switcher; conversations
left from before that rule, and unbound ones, are found through search. The stage strip does not
repeat the title. Icon-only controls carry tooltips with shortcut chips. The native game view paints
over the page, so no z-index lifts a tooltip above it: every tooltip keeps 4px clear of it, shifting
or turning as it opens, and stage-strip tooltips open sideways. Live never changes while it
is watched ([Builds and Live](../../docs/product/builds-live.md)): when something waits for it, the icon
Reload takes `bg-accent-tint` with its glyph in ink (the accent on its own tint falls under 3:1), the
sidebar's 7px accent dot and one `gate-pulse` (none under reduced motion), and its tooltip and aria-label say what changed ("The game changed —
reload to see it", "A new build is ready — reload to play it", plus a builder's note). The strip's end
holds one speaker for the game's sound, crossed out while off (⌥⌘M): no menu and no settings,
because agents' windows are always silent and Live is silent while hidden or behind another app.
Play/Stop sits before Reload: one icon button, ■ while the game runs, ▶ once it is stopped and a
13px ring spinner while either is under way; each glyph fades and grows in (150ms). Full screen
(four corners) follows the speaker and is disabled unless the running game is on the stage. In
full screen a studio-drawn dark glass pill sits 14px from the top-right corner, “Hold esc to exit
full screen” beside the exit glyph; after 2.6s the words fold into the icon, which rests at 45%
until the pointer is on it. Plugin buttons wear the prompt bar's model-pill fill (`pill-quiet`);
one whose status says its action is due (`attention`: Publish with something to publish) takes
the accent. Publish shows no badge: two looks, nothing else. While Live or Builds loads, a 52×36
halftone plasma in ink at 62% sits over a shimmering 13px line; it appears only after 0.4s, stays
at least 0.6s and fades out (150ms) before the native view is uncovered.

**Home** is where every launch starts and where the wordmark leads: nothing selected, one 21px
Medium line (“Everything you need to ship a game”) over the game composer (“What do you want to
make?”). Under it sit a quiet mono folder chip (Save the new game in: the games folder or Another
folder…, then Open a folder…) and, at the right, a ghost **Suggest prompt** (dice, mono 12px ink-3,
like the chip) that puts one of 100 ideas in an empty box; it steps aside while the
user writes their own. Behind them, an experimental background (`home-backdrop/`): a picture
(four bundled, or up to eight the user adds, kept 1600px WebP in IndexedDB) drawn once on a
canvas as dots, lines or ASCII (lines over the City picture by default) in a colour per theme
(#171717 dark, #e8e8e8 light, or the theme's ink), at the window's size and centred on the window, so the sidebar only covers or
uncovers it; a window resize redraws once it settles. Only the chips under the composer carry a
page-coloured halo. Home's top-right image button opens every setting in a 380px popover; Settings
→ Appearance repeats them under a preview of home. Entering a game crossfades it away. An empty
library adds no sidebar text. Its first message makes
the game: in one view transition the composer glides into the chat's place and the stage slides
in with the welcome's Planner (25% smaller, written once, then floating); the header and a
working sidebar row say Naming… in ink-3 until the model's name arrives, the folder is made from
it, and the game's own chat sends the message as home fades out over it. **New game**, Games
**+**, and Command-N open home, as the wordmark does, with the cursor in its composer; there is no
New game dialog. The chip's **Open a folder…** opens the Open a game folder sheet before any
writes: the folder's path under the title; one tinted summary (folder glyph and what the game is) or, when the folder holds more than one
game, radio rows under "Which game should Genex open?"; an engine export's refusal; a collapsed
**Details** (how it runs, packages, history, what a build still needs, every file Genex adds),
open from the start when keeping a nested repository is the consent; the Claude settings and hooks trust switch, on by default; then Cancel and the
primary in the dialog's usual footer, with no extra inset. **Delete** explicitly removes the game only from the sidebar; files and conversation
history stay on disk and opening the folder again restores the same identity. Active work blocks
removal.

Every game has a cover sphere: a recipe of one of 18 host-owned families plus a seed. Six
(Clouds, Aurora, Bands, Marble, Ember, Ocean) take one of 21 named palettes and share one sphere
program; twelve orb families ported from orbkit's MIT orbs (Orbital, Bricks, Plasma, Pixel,
Caustic, Tempest, Nimbus, Terminal, Voxel, Meadow, Galaxy, Thermal) take one of nine hue slots,
40° apart, and each is its own program. Every orb fills its circle; all but Terminal, Bricks and
Voxel get the Clouds light, rim and highlight over a dark glass body, and Voxel, whose blocks
break the silhouette, drops the image outline. No two games share a look: a new game takes the
family the library uses least and, in an orb family, the free hue farthest from that family's
other games; a look repeats only once its family is full, and the seed still sets it apart. The
first game in an empty library is always Clouds in the Genex sky. Records from before recipes
(no cover, or the old shared default) get a stable look from their seed or folder name at display
time, without rewriting the library. The game-building agent may call `set_game_cover` once
naming a family (and, for the six, a palette): enums only, no shader code; Genex keeps the family
and moves a taken palette or hue to a free one, and an unknown look keeps the current cover.
Uploads, earlier custom GLSL covers and a chosen look are kept. `GameAvatar` keeps sidebar/search
sizes at 28px/44px; one WebGL context paints every sphere into its own canvas. A row at rest
shows the still saved the first time its sphere drew, so a restart compiles nothing. Each sphere
keeps its own clock: a hovered or keyboard-focused row eases in from the frame it holds (about
200ms, 1.6× the earlier pace) and eases out to hold its new frame, at 24fps or less; the selected
game rests like any other row. Offscreen, hidden, inert and reduced-motion states hold still
frames; without a GPU rows show their saved still, or a lit gradient when there is none. A
changed cover cross-fades over 300ms.
**Change image** keeps the local center crop, preview and explicit save. Artwork stays in the
host-owned library index, outside game sources and exports. The older planet-surface experiment
remains a separate design reference, not a production dependency.
Scrollbars share a quiet rounded 6px thumb inside a 10px drag target, a transparent track and
no arrow buttons. The sidebar's game list uses a 3px thumb 2px from its border that shows only
while the sidebar is hovered or scrolling. Hover strengthens the thumb without adding decoration.
Empty game chat is blank; the composer is its entry point. The Harness chat always starts with its
first message, rendered like a reply (15/22 prose): ask about Harness and its improvements here;
games are built in their own chats. While it is empty, three example questions follow as filled
16px-radius chips that send in one click. **How it works**, a quiet text button right after the
Harness title in its chat header, opens a dialog: what Harness is, the four steps of its loop (you
build, it looks back, the edit is tested, you decide), what its tests cannot prove, and
**Harness settings** or **Done**.

Build summaries keep delivery state, failed checks and interaction-coverage limits visible.
In chat the outcome is the build card above: delivery, capture and Play; the card opens Builds.
Counts and revision identifiers live under **Technical details** in the Builds result card. Checks and
play/history actions remain separate, and a summary embedded in a completion card adds no
second card surface. Do not hide adverse evidence merely to make a result look cleaner.
The Builds graph stays a node graph: every node is one size (208×130), its picture filling it, a
name and one status on a dark fade at its bottom, and a count in a chip at the top right; a ring
outside it, never a border, so no state changes its size. Colour means state only (no per-part
colours); a ring in the graph accent means happening now. The graph draws its rings, live edge
and live status in the palette's `graph` (`--graph`, scoped to `[data-stage-graph]` in
`theme.css`), the app accent until set. Words match the chat: Added, Working, Being checked,
Left out. A part with steps has a row label; a part built in one session is its node. The build
says "Checking it starts…" (with the newest part's picture, softened) until a picture or a health
pass shows it runs, then "Ready to play"; node and card use the same words. While no part works
and nothing waits on a check, a node for the lead follows the build, so the run never looks done.
A node at work, the lead's included, is its agent's screen: the newest frame with the agent's
cursor, and a status that is the action in plain words with its age ("Pressing Space · 3s"; a step
being checked keeps "Being checked · …"). Its card shows that frame live and What it did, the
window's last frames with the newest as Now. No strip of screens sits above the stage.
The reviewers are an eye gate on the edge into what they looked at; one 52px status line ("Building ·
9 of 30 min" and a 2px progress rule) replaces per-card chips and per-node status boxes. A selected node opens in place: the camera glides to it at 160%, the graph dims to
40% and stays clickable, and one card (max 560px, centred, scrolling inside) carries the detail —
never a side panel. Replies go through the chat composer, so the app keeps one input. Semantic zoom
trades words for pictures below 60% and adds the asked sentence from 135%.

Activity is ordered by what the user must do: a **suggestions** block (only while proposals wait),
**Recent runs**, then **What Harness has learned**. Restores, restarts and app updates are Harness
looking after itself and are not listed; only a failed self-update with no automatic restore
after it shows one alert at the top. It has no settings or run form except one **Self-improvement** switch at
the right of its 48px header (off: no learning pass, no lessons, no automatic apply, the **Look for
improvements** button gone and the section saying so). Rows share one list-card grammar: header row as the toggle, a
chevron that turns, and the shared `.disclosure-body` height/opacity transition (reduced motion
keeps it static). Suggestions are one card: a check mark includes each row (green tint), the row
expands to plain **What changes** lines and **See the exact edit** (file, proposer notes, diff);
when a row has nothing else to read, the edit shows directly without that toggle. The diff shows
each change in file order with two unchanged lines around it and ⋯ for what it leaves out; lines
wrap to the card's width in ink on their tint (the sign carries the colour), so it scrolls only down. Reviewer vote
counts are not shown. The check mark and chevron stay aligned with the title's first line, and
the footer counts the selection and applies or discards it. Run rows show
the game cover, the request on one line, game · time and an outcome pill (Running, New build,
No build, Failed, Stopped). Expanded, a run gives only its result: one plain sentence (the run's
own report when it wrote one), before/after captures, Play build and Open game chat. Checks and
revision reports stay in the game's Builds tab. Learned rows say who let the change land, describe
it at reading size and keep the diff and **Undo this change**; a change the agent made to itself
during a build shows the plain title and summary it wrote, like a suggestion. Expanded bodies align with their
row's text and a hovered header never tints apart from its open body. Never lead with instruction-file names,
reviewer rationale or counts of reviewed tasks; they belong behind the exact edit. **Look for
improvements** appears once there are runs and reports on the button itself: a spinner with
**Looking…**, then **Found**, **Added** or **Nothing new** for a few seconds. Labels cross-fade while
the button's width animates to hug the visible label; no result sentence. Game chats show learning as
one line (“Harness learned 2 things from this build.”) with **Review in Harness** on its own line;
Harness's own records never appear in the Harness conversation. An intentional Stop reads
**Stopped**.

The Live stage, Assets and an empty Activity share one empty state (`ui/EmptyState.tsx`):
a 128×92 wireframe on a fading floor (an old-school computer drawn as a blueprint — faces in the
stage's colour, ink edges, hidden edges dashed, an accent screen with a blinking prompt, one turn
per 9s (`ui/wire-computer.ts`) — then a crane, teapot, the Harness glyph, the stopped game's
upright plate; theme colours, 30 fps only while visible, a still under Reduce Motion), a one-line
15/20 title, a one-line 13/18 subtitle of at most 40 characters and a fixed 48px button slot. A
title-only state (Game stopped) keeps no subtitle room: its title sits 6px under the art and its
button 15px under the title. Idea → building turns the computer to face you, boots its screen and
hands off to the rising crane; any other change of
scene cross-fades the art while the words rise out and in. Reuse it for new empty states.
With no runs, Activity shows only that empty state, centred: **A self-improving harness**, “Runs and
improvements will show up here.” and **Start building** (the last game chat, composer focused), or
**New game** when the library is empty.
Timed runs start from the composer's Mode menu. **Settings → Harness** holds **Maximum concurrent workers**
and **Apply suggestions automatically** with how suggestions are tested. The evaluation explanation
distinguishes instruction comparisons from game-quality evidence.
Use the existing content font for Harness prose and controls, code font only for technical text,
weights 400/500 and sizes 18px title, 15px regular, 14px small. Keep visible named entry points;
do not replace them with hover-only controls.

## First launch

The welcome (`renderer/onboarding/`, styles in `styles/onboarding.css`) is one full-window layer
in the app's own roles, above the inert shell and below dialogs, so the Codex sign-in window can
open over it. The Genex wordmark is 142px wide. The welcome's composer is a copy of the game
composer: the same panel, Add circle, borderless ∞ Loop button (as the bar appears its ∞
draws itself once and a light passes over the word once) and Send circle. The first step waits
1.4 s with a blinking caret, types 50 ms a letter, lets the prompt be read, then the pointer moves
to Send and presses it. Its stage is a fixed 760×380 drawing scaled between 0.5× and 1.2× to fit;
the second step shows **Plan your game** (the prompt lands on a translucent sheet in midair; a pen
writes the plan in about 1.5 s, once, ticks three tasks and sends them on), **Build with workers**
and **Reviewers test it**, in one row on identical fading floors. The two step bars sit at the bottom under Next. The connect screen is one group centred
under Back and Skip for now, with Start building's place reserved below it. Claude Code and Codex
stand in two columns 24px apart, each hugging its button, each extruded mark over its own button. Buttons are one line that hugs its words and
glides to the next label; sign-in and install progress use the app's LoaderGrid. Install stays in the
welcome: no browser trip, no arrow. Both sign-ins read Finish in your browser, which finishes on
its own; Claude's code box opens only from **Browser showed a code?** and the Connect ChatGPT window
only for a device code or a failed sign-in (Settings and the chat card alike). The marks are the vendors'
own paths, unaltered (`ui/provider-marks.ts`). All art is canvas in the empty states' wireframe
language, reads theme colours from CSS and holds a still frame under Reduce Motion. Skip for now
and Start building fade into home, the welcome's idea waiting in its composer.

After the welcome, the Genex promo is a 360px surface card floating 16px from a bottom corner
(above the workspace, beneath dialogs and toasts) that moves nothing beneath it: bottom-left while
home is up, clear of home's composer, and bottom-right over a game's stage, away from the chat's
composer. It holds a 19:10 muted looping
film (`src/renderer/media`, rendered with Remotion from `design/genex-promo-video/`; its poster
under Reduce Motion), a 28px translucent close over it, a 13px ink-3 eyebrow, a 17px title,
three 18px-glyph rows (14px medium title, one 13px ink-3 line: models, sound and art, publishing
with a playable link), then Learn more ↗ and the filled
**Connect Genex plugin** (32px buttons, 12px insets; Learn more is a quiet button outlined on
hover, and copies the link where the browser may not open). A failure only turns the primary into
↻ Try again, its reason in the tooltip. Waiting shows the LoaderGrid with Cancel; connected, a
green-dot title and Done. It stays hidden until the film has a first frame (at most
1.5s), then rises whole 16px over 480ms; it leaves 6px over 180ms and drops the film below 640px
of window height.

## Application settings

Settings is the fourth main sidebar action, directly below Harness. The dialog adapts the
reference Genex SettingsModal: quiet left navigation, a fixed section heading aligned with
Close, and an independently scrolling body. Model Providers, Local Models and Harness use a 208px
navigation column so their full names fit; below 640 CSS pixels navigation becomes a horizontal
row. Navigation, actions, versions and tags use Geist Mono; headings, labels and descriptions use
Zalando Sans. Settings paints the app shell's own sidebar and canvas colors so it never reads lighter
than the app; other dialogs use the surface step. The menu color is for menus only. Every dialog's
backdrop is 45% black. Settings → Harness holds the harness settings described under Activity.

Model Providers has one row per provider: name, CLI version, its status as a dot and word on a
22px plate tinted by its tone (green Connected, neutral Not connected, accent while busy, orange
or red when something needs attention), one context line (plan, and "Using your Terminal login" or
"Signed in for Studio only") and one action. The row's Account menu holds Check connection (which
also refreshes the model list), Update with the installed version, then the account changes. A
connected row adds Show in the model picker; the model list refreshes by itself and speaks only
while it first loads or after a refresh failed (Showing saved models… with Try again); a CLI update
in progress reads Updating…. A signed-out row's one action is Sign in. No filesystem path or
executable picker is shown; a missing or outdated CLI offers Install (or Update) and Check again, shows Installing… while the vendor's
installer runs, and adds the vendor's Install guide after a failure. Local Models ranks models that fit with a
Best fit tag, a memory meter and "Needs a N GB Mac" for the rest, plus Add from Ollama. An installed
row keeps the quiet Installed badge beside a ghost trash button; it asks on the row ("Delete it from
this Mac?") with Cancel, which takes focus, and a destructive Delete. Closing or switching sections preserves host installation
jobs. Harness holds **Maximum concurrent workers** (a ceiling the lead chooses under, default 8, maximum 12)
and **Apply suggestions automatically** with how suggestions are tested. The game model list's
Add more models opens Model Providers. First-launch and Studio setup links open the corresponding
section. Timed runs start from the composer's Mode menu; MCP stays in Plugins. Permissions lists
the always-allow rules chats saved, under each game's title: one mono rule per row with a ghost
trash button, **Stop allowing** (focus moves to the rule taking its place); with none, one ink-3
line says Always allow in a chat adds one. Each chat's mode stays in its composer.
Opening Settings preserves the workspace and draft, traps focus and occludes the native game.
Games comes first: the games folder as a mono path with **Change…** (a native folder picker).
Every tab (Games, Appearance, Model Providers, Local Models, Harness and Permissions) uses the same
viewport-capped 860px width and 720px content height; changing tabs
must not resize or reposition the dialog.
Escape/Close restores its entry point; arrow keys and Home/End navigate sections.

## Prompt composer

The Studio composer has one text area, an accessible Attach images button, the model button, the
effort pill and Send/Stop. Its model button opens the model list directly (no roles). The Studio
choice is saved apart from game chats (it starts from the last game pick once) and never becomes
the model new games inherit. It accepts image drop/paste and has no Loop, permission, tool or
context-ring controls. Provider setup is offered when no model is available.

The game composer has one text area and one toolbar: a filled 30px Add circle, a Mode pill, the
permissions pill (Claude orchestrators only), flexible space, a 16px context ring (2px stroke), a
model pill naming the orchestrator, an effort pill, and one 30px Send/Stop circle. With no AI model
at all (home or a game), the model pill's place is **Connect AI model** in the accent tint, which
opens Model Providers; there is no setup block under the composer. The prompt still takes typing,
Send stays quiet, and Enter or Send fills the button with the accent, rings it, bumps it once
(still under Reduce Motion) and shows its tooltip, "Connect an AI model to send", for 2.8 s; the
prompt stays. The pills share
one fill and 8px inline padding. The panel has a 26px radius and 10px insets, 7px at the bottom. Icon-only
controls have shared tooltips (Add names its @ shortcut); a tooltip hides while its panel is open.
Send and Stop are the same ink-filled control, so it never moves. When work settles and the
control becomes idle, Send replaces Stop without an exit animation. A settled run's stale
harness status cannot keep Stop visible; new work remains interruptible.
During work,
Stop replaces Send unless the composer has a sendable draft; typing a follow-up shows Send,
and sending or clearing it restores Stop. Whitespace alone keeps Stop visible. The composer Stop control
interrupts immediately and send the oldest queued message after the interrupted work settles;
an empty queue stays stopped. Waiting messages sit below the current work as muted bubbles with a
12px label: Sending… until the running turn reads them (no Remove), or Queued with a small Remove
icon beneath, outside the bubble, where they wait for a turn of their own. A delivered message
closes below the work as it opens where it was read. Until stopped work records its end, the
status reads Stopping. Worker task rows keep one truncated line; the full title is its tooltip.
Sending follows the latest conversation.
**Plan mode** is a one-message choice that defaults off and resets on
submission: Add's row turns it on, and while it is on a bulb icon button follows the pills behind a
1×16px hairline, turns it off, and the prompt reads "Describe what to plan…"; active build
follow-ups retain the existing plan. No standalone Keep going button is needed.

Composer panels share one density: 6px insets, 32px rows with 6px/10px padding, 12px medium
group labels and a 17px radius (row 11 + inset 6). Everything opens on click, never on hover.
Add spans the full composer width 8px above the writing surface: Images, then **Plan mode** (a
bulb, "Turn plan mode on", or "off" while on; it closes Add; disabled with why while a build owns
the chat), then plugins and MCP servers (each with its 16px picture) with switches. A status appears only when something needs
doing, with an accent action in white mono 12px (Set up, Connect, Retry) beside it; an account
needs only the Connect button, no words. Glyphs use the text colour. Manage plugins opens the
Plugins page. Typing @ at the caret
opens the same list as mentions while focus stays in the text: arrows move, Enter/Tab inserts,
Escape closes; with no match Enter sends as usual.
The permissions pill shows one glyph per mode: shield (Auto), help (Manual), pencil (Accept
edits), plan (Plan) and shield-off (Bypass permissions, orange in the pill and its row). Auto is
the glyph alone, its tooltip "Auto permissions"; another mode adds its label. The model's name keeps
its room (`ui/toolbar-fit.ts`, measured): when it would be cut short the label goes first (the
tooltip names the mode), then Mode's ∞ or time, then in the narrowest chat the pill (never Bypass). Its 360px panel opens
above, start-aligned, and shifts to stay over the chat, never the native game. Under a
**Permissions** label, five rows in Claude Code's order show glyph, label, one ink-3 description
line, a check on the current mode and number hints 1–5 (digits pick while it is open; arrows,
Home/End move). Auto carries a mono accent-tint **Recommended** tag; when the plan or model lacks
Auto, its line says Claude asks first. Its Plan is Claude Code's plan mode (it reads, never edits),
separate from Add's Plan mode (the studio's plan review), and shows no bulb. Choosing Bypass opens "Bypass permissions?" (it acts
anywhere on this Mac, "this computer" on Windows and Linux; Rewind restores only the game folder)
with ghost Cancel focused and a destructive **Bypass permissions**; focus returns to the pill.
Mode holds Loop mode, one control: Off, ∞ (until the build passes), 30 m, 1 h, 2 h
and Custom. Custom shows a ±15-minute stepper that also accepts typed times ("1h 15m", "90m",
"1:45") from 15 minutes to 24 hours. The trigger says **∞ Loop** (the ∞ draws itself once as
it is picked), the limit in muted mono before the word (**2h Loop**, **1h15 Loop**) or **Auto** when
off. Segments and stepper sit in a darker well, in mono.
While the chat's build runs or is paused, Mode names that build's limit, does not open and is dimmed
to 45% like a disabled composer icon, in both themes; after a finished build it is the chat's own
Loop again (Off: "Each message runs one turn."). There is no new-build choice.
The model panel (300px) lists three jobs as rows: **Main agent**, **Workers** ⓘ and **Reviewers** ⓘ,
each naming its model with a ›; the ⓘ tooltips say what the job does and close when the pointer
leaves. Workers and Reviewers always read quieter and stay choosable in Auto and Loop. A row opens
its model list (240px) to the right of the panel, else its left, else above; over a running game
the game hides while the list is open. The list groups
models under ChatGPT, Claude, then Local models, each group's name
in muted ink-3 at 11px regular; it marks the current one, and ends, below a line,
with Add more models (Model Providers). Arrows move between rows, → opens a list, and Escape or ← closes the list before
the panel. There is no effort or Fast control in this panel; Fast mode is not offered yet.
Effort is one control for every role: the pill opens **Effort** with a help tooltip, Faster/Smarter
ends and a stepped slider over the orchestrator's levels (click, drag or arrow keys). Workers and
reviewers use the closest level their models accept.
The ring panel (340px) shows Context window used/capacity with one meter, "Compacts automatically",
and, for a model whose chat can be compacted, Compact now (also `/compact` in the composer). Below it, each signed-in subscription has a block titled with
its plan (e.g. Claude Max plan) that opens the provider's usage page, then each limit with its reset
time, percent used and meter (amber from 75%, red from 90%). The orchestrator's plan comes first;
with two plans, each names the roles it serves or says Not in use. While Genex is connected, a
Genex credits block follows: Used by this game, then Left for all games in ink-3.
Fresh games inherit the last selected chat model; returning chats retain their own saved model.
Model lists contain concrete named models without search or provider-default rows; unavailable or empty local providers stay in setup. Claude rows name Fable 5.1, Opus 5 and Sonnet 5. Subscription models default to High when supported; an explicit saved effort remains. Legacy provider-default selections resolve to named models within that provider.
Tool/account setup stays in Add and Plugins; there is no duplicate connection status disclosure above the composer.
The accepted design is the owner's 2026-09-24 prompt-bar frames (roles panel, effort slider, plan
limits); it does not introduce a separate palette or scale.

## Embedded terminal

The terminal is a resizable pane under the conversation; it reduces chat height while the game
keeps its own stage. Its header action and Ctrl/Cmd+backquote reopen it. Hide keeps the process and
scrollback; Stop ends the current process; Close session removes ended output. Show the session
picker only when there are multiple sessions. Shift+Escape returns keyboard control from xterm
to Hide; the resize separator supports arrow keys. Keep terminal output outside React state.
A short chat keeps the composer scrollable rather than clipping actions. Managed sign-in reveals
the pane and dismisses Settings while preserving the workspace/draft; its browser action opens a
main-owned link. Native screen-reader support follows the OS accessibility setting. Theme and
code-font changes apply to open terminals without restarting their processes. A one-line
`bash` block in a game reply has no fill, a hairline border and 14/20 mono (a step under the reply) with the command
name in accent and its arguments in green; ghost icon buttons inside it on the right are Play
(Stop while it runs) and Copy. Its output is a borderline card under it: 12/18 mono, folded to
eight newest lines with a top fade, a chevron to show all, a terminal icon that opens the dock on
that session ("Command"), and a 12px ink-3 status only while running or after a failure or stop.
The dock never opens by itself for it, and the result the agent receives is not drawn.

## Appearance and color roles

Settings → Appearance provides System/Light/Dark with independent palettes and profile-local
customization. New profiles default to the neutral charcoal Genex dark preset; persisted choices win. Start from `appearance/themes.ts` and the shared aliases in `theme.css`; do not
introduce dark-only foregrounds, translucent white field fills or fixed brand-colored shadows.
Colors are drawn exactly as the palette sets them; no role is lifted to a contrast floor. Filled
accent actions (primary buttons, text selection) use `--accent-fill`, `--accent-hover` and
`--accent-foreground`: a palette may set each (`accentFill`, `accentHover`, `accentText`), else the
fill is the accent darkened in OKLCH until white reaches 5:1. Quiet icons (icon buttons, sidebar
rows, menu and row glyphs) use `text-icon`/`text-icon-strong`, the palette's `icon` when set; the
sidebar's search and bell stay in the muted grey. The wordmark takes the palette's `logo` (`--logo`)
when set; its gradient runs through `logoShade` (`--logo-2`), and a shade equal to the logo draws it
solid (`--logo-fade`). Its sidebar width is `--logo-width`. The selected Settings tab's text reads `settingsTab` (`--settings-tab`). The prompt bar's edge reads `promptEdge`
(`--prompt-edge`), and its composer menus draw that same single edge (`--prompt-bar-edge`, no ring). The Live/Assets switch's current view reads `viewSwitch` (`--switch-fill`) and the
empty-state wire art `wireArt` (`--wire-art`); the stage's hatch draws `hatch` stripes
(`--hatch-stripe`) over `hatchGround` (`--hatch-ground`), else the text's faint `--stripe` over the canvas.
Chips, tabs and hover states read `controlFill`, `controlHover`, `controlText` and
`controlTextHover` when set (`--control-*`; utilities `bg-control-hover`, `text-control-text`,
`text-control-text-hover`); composer chips and pills use `chipHover` (`--chip-hover`); picker
selectors sit on `well` with the selected segment in `thumb`, and limit meters use `meterTrack`,
`meterFill`, `meterHigh` and `meterFull`. A preset's `shadows` may replace the composer menus'
(`--panel-shadow`), the prompt bar's (`--prompt-shadow`) and the selected segment's
(`--thumb-shadow`). Unset, each place keeps its own fallback. Use these, not `bg-hover`,
for new hover and open states. Menu and field
borders use their own soft semantic roles, distinct from quieter dividers. Do not brighten
decorative borders to a universal contrast threshold. Labeled buttons and shortcut hints use
borderless rounded fills; keyboard focus uses filled states without external rings. Text fields
keep their caret and a subtle edge change, and composer focus stays close to its idle state.
Dark preset sidebars have a distinct surface from the chat canvas (Genex Light's matches it); active navigation uses the selected
accent, while composer Send/Stop use the ink fill. Radii: hover rows and controls 11px, chips
and pills 10px, base 12.4px, cards 16px, menus 17px, composer 26px. Typography defaults remain the
Genex hierarchy; user choices alter interface, content and code roles without downloading fonts.
See [theme sources, interchange and checks](THEMES.md). Theme previews are
small diagrams of the workspace, and advanced colors stay behind Customize theme.

**Colour tweaker.** Presets are tuned in the colour tweaker (`appearance/tweaker/`), hidden in code
between tuning sessions. To bring it back, set `COLOR_TWEAKER_ON` in `ColorTweakerHost.tsx` to
`true`, open a `studio:dev` window with `STUDIO_FIXTURE_INTERACTIVE=1` and press ⌥⌘C (unpackaged runs
only); set it back to `false` before the PR. It is a draggable panel that previews any preset's roles live, with whole-palette
knobs, an inline color picker, contrast badges, the preset's shadows, the logo's size and the type the sidebar labels and chat header title share
(`--label-size`, `--label-tracking`, `--label-weight`). **Code** copies the changed `preset(...)` entries
to paste into `themes.ts` (and a tried logo width and label type for `theme.css`); closing it
returns to the saved appearance. It stays usable over open dialogs and popovers (`use-isolation.ts`).

## Shared design system

For chat history/streaming changes, run `node tests/e2e/run-chat-ui.mjs` under Node 24.
It owns a credential-disabled `chat-questions` fixture (the `chat-history` data plus a real
consent-ledger request with no plugin action) with 600 historical messages, parallel
workers, tools (including a failure), a plugin delivery and a streaming fixture engine. Real
input exercises paging/windowing, jump-to-latest, disclosures/keyboard/cursors, asset previews,
draft restoration and stream-to-message reconciliation. Consent coverage selects without auto-submitting,
collapses/reopens with the answer retained, and explicitly submits a durable decline. Reports include mounted/total counts, measured quiet task/tool row geometry, unified activity disclosures and spinner-free
status shimmer, renderer CPU capture, screenshots and full build/profile/provider identity under
`.studio-dev/evidence/chat-ui-<time>/report.json`. Retain failed reports when iterating.
`interrupted.test.ts` covers unanswered permission recovery across chats and repeated boots,
including a pre-existing compact context cache and preservation of approved/declined answers.
`chat-history.test.ts` checks page boundaries/concurrent appends, compact context, cross-worker
tool identities, unknown/stopped outcomes and asset projection. Native engine conformance
checks real adapter translation of synthetic partial messages and completed results; it does
not certify a live account. Build smoke retains loading/error/Stop and supported viewport/zoom
checks; design-gallery acceptance covers shared primitives and reduced motion. `npm run test:ui --
chat-motion-ui` plays the production ChatPanel through a send, work and its clock, tools, a streamed
reply, a question and a build, in a short and a long chat, frame by frame: it fails on a part that moves its
whole way in one frame, comes or goes at full opacity, or a status label shown under 300ms, and on
any motion left under reduced motion.

Use `npm run test:design-ui` for shared Genex primitive changes selected by the scope table. It builds the development-only
gallery and tests it in credential-disabled disposable Electron: actual per-script font
selection, 32px controls, pointer cursors, keyboard menus/tabs/switches, modal focus trapping
and restoration, disclosure collapse, reduced motion and zoom. Chat specimens also exercise
radio-key navigation, explicit submission, collapse focus, expanded plans and all three footer
actions, scroll-stable plan actions, single-line tool labels/highlighted code output, long-message
folding with keyboard expansion, timer placement,
300px width and 200% zoom. The gallery window is parked and nonfocusable, uses CDP keyboard
input, disables background throttling, and flushes a paint before captures. Owned development
app windows also disable background throttling so planning and scroll checks keep advancing
while the user works in another app. `markdown.test.ts` covers HTML/code escaping and unsafe
destinations; `syntax-highlight.test.ts` covers explicit grammars, inert output and the large-code
fallback; `chat-history.test.ts` also checks separate command input and multiline output.
For a real plan-flow check, the app-basics fixture recognizes `fixture:plan` in a manual-plan
request and returns a long plan with code and lists; adding “purple” produces its revision.
`fixture:pending` waits for real cancellation. Screenshots and a structured
report are saved in `.studio-dev/design-gallery/`. This does not require an accompanying full
`npm run verify`; it does not prove native game layering or provider authorization.

`node tests/e2e/run-window-recovery.mjs` kills the owned app-basics window's renderer: the page
must return by itself and note it in the Studio chat, twice, then stay dead without a dialog.
`chat-files.test.ts` covers which names a chat links and how each opens; opening one in another
app needs a live profile (fixtures refuse `studio:chat-file.open`).

Use `node tests/e2e/run-chat-reload.mjs` to verify a real pending fixture operation across
renderer reload: current work and Stop return, elapsed start is preserved, Stop cancels the
operation, and a second reload remains idle. It also steers a follow-up into the running turn
(it reads where the turn read it, recorded once, and stays there across the reload) and removes a
follow-up that cannot join through its actual Queued controls. It uses the owned run-controls
fixture and no live provider; the fixture chat's default engine takes no input mid-turn, so the
steer takes the interrupt-and-resume path (a Claude session reads it natively; `chat-steer.test.ts`
covers both).

Use `node tests/e2e/run-settings-ui.mjs` for Settings navigation and model setup UI. It builds
an immutable owned fixture app, checks the fourth sidebar action, both sections, keyboard focus,
composer Add more models routing, draft/selection preservation and native Live occlusion. Synthetic
provider/installation responses cover connection errors, downloads, cancellation, installed
controls and job hydration after switching/reopening. Compact navigation, 200% zoom and reduced
motion are included. Reports and screenshots live in `.studio-dev/evidence/settings-<id>/`.
It does not sign into a real account or download model weights.

Use `node tests/e2e/run-promptbar-ui.mjs` for composer behavior changes; a local visual edit
can use a focused rendered review instead. It uses production components
with deterministic gallery models and tests the composer metrics (30px Add/Send, 7px bottom
inset, 26px radius), tooltips, Plan mode, the Loop control (presets, Custom stepper and typed
times, arrow keys, Off keeping the saved time), toolbar order (ring, model, effort, Send), no Fast
control, the roles panel (Orchestrator/Workers/Judge rows, ⓘ tooltips, quiet Loop-off rows with
Turn on), the side model list (focus, groups, Add more models, chat-side placement, arrow keys,
Escape closing the list before the panel), the effort slider (keys, pointer snap, nearest level per
role), context-window preferences and plan limits (order, roles, levels, usage link), Add density,
plugin status actions and setup route, full-composer Add anchoring, @ mentions (filter, insert,
Escape, focus kept in the text),
Named model rows without search, provider-default or empty local placeholders; High defaults in both displayed and submitted role settings; Send state/payload, the ink-filled Send/Stop cross-fade, exclusive Send/Stop transitions during work (including whitespace, clearing,
follow-up submission, post-send guard and pointer/keyboard Stop), 200% zoom and reduced motion. Captures and results are in
`.studio-dev/evidence/composer/` (override with `COMPOSER_EVIDENCE` for a follow-up pass). `promptbar-redesign.test.ts` covers durable Auto/Loop
approval, revision, cancellation, retry, duplicate approval and the real host dispatch boundary.
No fixture authenticates a vendor or starts a paid generation. Native preview layering remains
covered by the full Build smoke and agentic-readiness gates.

Conversation queue coverage lives in `message-queue.test.ts`, `chat-steer.test.ts` (the host half without
the harness: `chat-steer-host.test.ts`), `coordinator.test.ts`,
`seed-contracts.test.ts` (the app's reader against the harness's), `promptbar-redesign.test.ts`
and `chat-session.test.ts`: durable editing/removal, replay, isolated
chat order, Stop-to-next-message handoff, same-session/context continuation and plan gating.
Director conformance covers both an ordinary message after a crash and Stop sending a queued
instruction during a live build; both retain the plan and integration head. Inspect muted queued bubbles, Edit/Remove, focus/fit and the actual Stop handoff
in an owned fixture app; composer gallery coverage alone cannot prove the host queue.
The gauntlet intake regression checks that launching handles the original commission while
later messages remain queued, preventing restart from replaying an already launched request.
Sending and rewinding: `pending-sends.test.ts` pairs placeholders with durable rows (queue id,
text fallback, plan-review expiry); `chat-rewind.test.ts` covers the withdrawn range, sessions,
plan reviews, held follow-ups, facts and notifications; `chat-checkpoints.test.ts` covers the
git checkpoints in temporary repositories (HEAD, index and branches untouched, ignored files,
`.env`, nested repositories, skip bits, outside changes, undo); `chat-rewind-studio.test.ts`
drives a real harness through rewind, file restore, a fresh session and a restart. Fixture
providers never edit files, so inspect Sending, Rewind and its dialog in an owned app and prove
file restores in the rig.

For Studio chat and Activity, run `node tests/e2e/run-studio-ui.mjs` under Node 24. It builds an
immutable owned app with the credential-disabled `studio-activity` fixture: multiple games,
historical runs beyond the bootstrap tail, a long brief, plain and legacy proposals, improvements
and recovery. Real pointer/keyboard checks cover the suggestion block (expand, include/exclude),
the Studio model menu, Look for improvements (the fixture stages one suggestion), image drop
through model completion, follow-up replies, Stop, blank-reply recovery, run results, game navigation/draft retention, Settings → Harness, three type
sizes/two weights, light/dark themes, compact layout and 200% zoom.
The report and captures under `.studio-dev/evidence/studio-*/` record actual build/profile/digests.
Inspect captures; the synthetic replies prove transport and lifecycle, not live authentication,
vendor quality or the cause of a historical watchdog stall. Native file picker remains unverified.
`studio-chat.test.ts`, `studio-activity.test.ts` and `threads.test.ts` cover completion authority,
full-history projection and legacy Studio run isolation without account access.

For the broader workspace refinement workflow, run `node tests/e2e/run-ux-refinement.mjs` under Node 24.
It creates and cleans owned sidebar/build-history profiles and checks actual pointer/keyboard
game rename cancellation, sidebar toggle/search focus, Studio chat + Activity navigation, unsent-text
restoration, sidebar Plugins and its keyboard ownership, game creation, ranked search, pin/rename/
remove with files retained, image dialog, sticky scrolling, settings
disclosure, duration/reference validation, provider setup access and build-history preservation. Captures and full instance identities
are written under `.studio-dev/evidence/ux-<time>/report.json`. The fixture suite does not
start paid or live-provider runs. Build smoke additionally checks adverse evidence and viewport
application; a requested resize alone is not a rendered layout pass.

The conversation-led shell's Build smoke asserts removal of global mode tabs, Export in the
chat header, Plugins in navigation, the accessible Genex wordmark and pointer cursors. It checks
chat + Review coexistence and native preview occlusion at 1440×900, 1080×680, 1800×900 and 200%
zoom, retaining the existing game-stage and stop-control regressions. Review entry now uses the
Studio conversation; keyboard return selects the last game chat rather than toggling an unrelated
mode bit. Native export/picker dialogs remain fixture-blocked; export backend conformance is separate.

Bonsai integration checks and the distinction between scripted session parity and real model
quality are specified in [local models](../../docs/local-models.md#verification). `bonsai.test.ts` and
`bonsai-director.test.ts` are part of npm test; build UI smoke exercises the local download
and crossed-role controls through the Studio sidebar and shared Model Picker. Real local trials use an isolated engine home with pinned runtime
and weights; they do not authorize live subscription or paid-asset checks.

AG-966 library acceptance: `tests/conformance/game-library.test.ts` covers duplicate folder names,
canonical thread reuse, legacy history preservation, persistent presentation metadata, removal
and re-adoption across macOS path aliases, seed stability/custom cover preservation and Unicode
BM25 search. `run-ux-refinement.mjs` uses the populated `sidebar` fixture. Native folder/image
pickers remain distinct manual gates; fixture success must not be reported as native picker
acceptance. Build smoke passes an owned synthetic image through the real cover dialog,
center-crop/preview/save and host decode, and checks executable image format rejection.
`node scripts/preview-game-covers.mjs` regenerates the standalone artwork experiment;
it is a review artifact, not a remote generation service.

### Cover sphere acceptance

Run `cover-shader.test.ts` with `game-library.test.ts` for cover contract changes. They prove the
18 families, hue slots and validation, no shared look until a family is full, the farthest free
hue, the builder's family kept, birth rolls (first game Clouds), older records, tool parity with
the seeded harness tool, project binding, upload races and the legacy GLSL path, not GPU
behavior. After building `dist/renderer/theme.css`, `node tests/e2e/run-cover-shaders.mjs`
exercises production GameAvatar and the legacy host compiler in credential-disabled Electron:
real sphere pixels, every orb family painting a lit ball, Voxel without an outline, held frames,
hover/keyboard easing, clocks that survive remounting, legacy covers,
intersection/inert/hidden/reduced-motion suspension, GPU loss, a reload that restores resting
rows from saved stills with no program linked, and a GPU-less reload. Evidence is in
`.studio-dev/cover-shaders/` (`orbs.png` shows every orb family). Inspect the full sidebar and
search in an owned app session; the `sidebar` fixture shows every family once, not a live
model's choice.

### Plugins page visual acceptance

The build smoke enters the full `[data-plugins-page]`, checks native preview occlusion, search
across plugins/MCP, manifest Skills, pointer cursors, compact layout at 200% zoom, the plugins'
own pictures, the Install from GitHub window, the tools Genex routes, plugin details/scan
information and the example's sandboxed panel. It returns via
sidebar navigation and retains the plugin lifecycle/toolbar checks. Passing
`--studio-build-shot=/absolute/path.png` to `test:build-ui` also saves the page, Skills, empty
search and zoom captures with `-plugins-*` suffixes for visual review. Owned development
fixtures support additional real pointer/keyboard checks of Add, MCP forms and workspace return.
These checks never approve native installation or live account access.

### Model recovery

Authentication failures retain known model names and the user's explicit choices. Keep the
model menu operable for recovery; unavailable choices do not silently become another model or
provider. Submission reports the unavailable selection. A sign-in notice identifies the failing
provider and does not duplicate the same attempt's adjacent harness reply.
