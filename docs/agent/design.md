# Application design workflow

External development of Genex’s interface; generated games and the editable in-app harness have
their own guidance. Read only the surface specifications relevant to the task.

## Design foundations

- Prefer simplicity and minimalism. Before adding anything, try removing, combining or
  revealing it only when needed. For every label, sentence, icon, border, badge and control,
  ask: **“Do I actually need that?”** Keep it only if it helps someone act, understand state,
  find their way or recover. Run this removal pass before calling a design finished.
- Make the main task and next action obvious. Give secondary actions less emphasis; disclose
  advanced options in context with a clear way to find them. Keep game content central.
- Use spacing, alignment and typography to establish hierarchy before adding containers,
  dividers or decoration. Keep copy brief and concrete; fix confusing interactions before
  adding explanatory text. Show implementation details only when they help a user decide.
- Minimalism must preserve usability: clear names, discoverable controls, readable contrast,
  keyboard access, visible focus, useful state feedback and error recovery. Fewer elements
  are better only when the task remains understandable and achievable.
- Use `cursor: pointer` for enabled clickable controls, including buttons, links, tabs,
  menu items and actionable rows/cards. Disabled controls must not show a pointer. Preserve
  text-selection, resize and drag cursors where those describe the interaction.
- Evolve one shared system. Reuse the app's tokens, components, icons, terminology and density.
  Change shared patterns deliberately; avoid a new palette, type scale or component for one
  screen. Motion should explain a change or provide feedback and respect reduced motion.

These foundations and the agreed task scope take precedence over generic skill recipes.

## How instructions and skills connect

`AGENTS.md` requires this workflow for design tasks. This guide states the principles and
selects the relevant skills. Their `SKILL.md` files supply detailed techniques; open only the
supporting references needed for the current change. Announce the chosen skills and their
purpose briefly. Do not load them all for every task.

The skills are repository-local in `.agents/skills`, which Codex discovers from the working
directory up to the repository root. Matching descriptions support automatic selection;
the explicit routing here also tells an agent which files to read. This is an instruction
workflow, not a runtime hook or a guarantee that a skill was executed. If discovery is stale,
read the linked file directly and report a missing file rather than pretending it was used.
See [OpenAI's skill documentation](https://learn.chatgpt.com/docs/build-skills).

`CLAUDE.md` imports `AGENTS.md`; agents that do not discover `.agents/skills` can use
these same file links. Keep one set of skills. Installation does not add skills to the app's
in-app harness or change machine-wide agent settings.

## Select by the actual task

| Task or changed concern | Read | Use it for |
| --- | --- | --- |
| UI polish, controls, surfaces, icons, motion | [better-ui](../../.agents/skills/better-ui/SKILL.md) | Consistent details and interaction feedback |
| Screen/panel composition, hierarchy, spacing, density, resizing | [better-layout](../../.agents/skills/better-layout/SKILL.md) | Grouping, alignment and progressive disclosure |
| Palette, themes, semantic color or contrast | [better-colors](../../.agents/skills/better-colors/SKILL.md) | Role-based color and measured contrast |
| Type hierarchy, text sizing, wrapping or truncation | [better-typography](../../.agents/skills/better-typography/SKILL.md) | Readability with real content |
| Labels, buttons, hints, empty states, errors or other product copy | [better-writing](../../.agents/skills/better-writing/SKILL.md) | Short, consistent, actionable language |
| Illustrations, loading/empty/being-made drawings, icons with depth | [wire-art](../../.agents/skills/wire-art/SKILL.md) | Genex's wireframe art language and how to explore it |
| User requests alternative designs for a component | [variant](../../.agents/skills/variant/SKILL.md) | Distinct options along one design axis, with tradeoffs |
| User requests a component stress-test page | [break](../../.agents/skills/break/SKILL.md) | Real component states and content extremes in a visual report |

For a broad redesign, start with layout and UI, adding writing, typography and colors when
those concerns change. A copy edit needs writing; a clipped title needs typography and possibly
layout. An unrelated backend or documentation task does not need a design pass.

`variant` and `break` preserve upstream's explicit-invocation policy in Codex's
`agents/openai.yaml` (`allow_implicit_invocation: false`). Invoke them with `$variant` or
`$break`, or follow their linked instructions when the user explicitly requests that workflow.
Do not create variant pickers or stress-test pages during routine polish. Normal interaction,
content and resizing checks remain part of every applicable UI change without invoking `break`.

## Work from the app

1. Inspect the requested surface and relevant neighbors before editing. Use the
   [feature map](feature-map.md) to identify project/thread/run state; report an unavailable baseline.
2. Reuse [theme tokens](../../src/renderer/theme.css), [shared controls](../../src/renderer/ui/kit.tsx),
   [buttons](../../src/renderer/ui/Button.tsx) and [icons](../../src/renderer/ui/icons.tsx).
   The [design system](../../design/genex/README.md) owns fonts, icons, motion and accepted surface
   specifications.
3. Apply the removal pass and choose only relevant skills. Record substantial system decisions
   in the local task note; a small edit needs no separate proposal. Keep exploration pages out
   of shipping code. Retain a requested stress-test page; remove discarded variants after selection.
4. Review the rendered result under the [verification scope](verification.md#choose-the-verification-scope).
   A copy/spacing edit needs a fit check, not every UI suite. Shared interactions need relevant
   consumers and tests. Popover geometry/focus needs inspection beside the native game.
   Check relevant loading, empty, error, disabled, hover/focus and long-content states;
   supported pane/window sizes, zoom, keyboard access and reduced motion. Verify computed pointer
   cursors over clickable controls and nested content; preserve disabled, selection and drag cursors.
5. Report selected skills, meaningful decisions, build/profile/provider identity and observed
   pass/fail/unverified results. Stop when relevant checks pass. Update the owning specification
   when an accepted decision changes the shared system; temporary choices stay in local notes.

## Resolve skill conflicts in context

The user's direction, repository foundations, accessibility needs and task scope govern how
generic recipes apply. Existing conventions are a starting point, not proof that they are
usable. Fix a demonstrated problem within scope and record deliberate system changes.

- Exact skill values for animation, spacing or type do not mandate a global token migration.
  Do not add shadows, icons, motion, explanatory paragraphs or empty-state sections merely
  because a recipe includes them. Each must survive the removal pass.
- Apply web/mobile recipes to relevant surfaces. A generic 320px/mobile example does not set
  this macOS app's supported window size. Test the actual supported windows and resizable panes;
  do not use compact density to excuse unreadable text or unreachable controls.
- The selected upstream skills reference `better-accessibility`, `better-interface` and
  `interface-review`, which are not installed in this set. Do not claim to have run them or
  install extra skills silently. Keep the accessibility requirements in the foundations and use
  authoritative documentation for specific requirements when needed.
- A review-only request reports findings. A request to fix/design/implement already authorizes
  relevant fixes, including copy and color corrections; do not ask again just because a skill
  says to leave changes to the user. Variant selection remains a user choice unless delegated.
- `break`'s one-look budget and the skills' source-only review fallbacks do not replace the
  repository's UI acceptance checks. A skill's `Approve` is a scoped review result, never merge
  authorization or evidence for uninspected states. Report missing coverage explicitly.

## Maintain the skill set

The seven requested skills, including their local references, are pinned to one upstream
commit. [Sources and local adaptations](../../.agents/skills/SOURCES.md) record provenance
and the retained license. The repeated typography URL represents one installation.

Upgrade deliberately: inspect the upstream diff and references, use the skill installer into
a temporary destination at a chosen commit, preserve the local invocation-policy files and
the documented pointer-cursor rule in `better-ui`, then
replace only the reviewed skill directories. Update provenance, validate local references and
review the `developer-tooling` knowledge-map area. Do not auto-update on design tasks.


## Chat reading and activity

See [the maintained design specification](../../design/genex/README.md#chat-reading-and-activity) for this surface.

## Studio hierarchy and progressive disclosure

See [the maintained design specification](../../design/genex/README.md#studio-hierarchy-and-progressive-disclosure) for this surface.

## First launch

See [the maintained design specification](../../design/genex/README.md#first-launch) for this surface.

## Application settings

See [the maintained design specification](../../design/genex/README.md#application-settings) for this surface.

## Prompt composer

See [the maintained design specification](../../design/genex/README.md#prompt-composer) for this surface.

## Embedded terminal

See [the maintained design specification](../../design/genex/README.md#embedded-terminal) for this surface.

## Appearance and color roles

See [the maintained design specification](../../design/genex/README.md#appearance-and-color-roles) for this surface.
