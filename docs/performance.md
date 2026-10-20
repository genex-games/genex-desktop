# Performance

How Genex's speed is defined, measured and kept. A performance change follows this page the way
a behavior change follows [verification](agent/verification.md). Numbers from a measurement go in
the PR description and `.studio-dev/evidence/`, never into this page; this page names what is
measured and how.

## Journeys

A journey starts at a person's input and ends when the result is on screen. It reports app
work apart from provider time, so a slow model never hides a slow app. Each journey has one
headline metric; everything else about it is a diagnostic.

| Journey | Starts | Ends | Headline metric | Instrumented by |
| --- | --- | --- | --- | --- |
| Launch | process start | composer accepts typing | ms, warm and first launch | `loadedAfterMs` (process start to main's code), marks `launch`, `core:<step>` per boot step, `window-created`, renderer `first-commit`, `composer-commit` |
| Open a chat | sidebar click | newest page painted | ms | not yet |
| Send | Enter | first visible progress, minus the provider's first-token time | ms of app overhead | `delta` → `text-paint` (paint side only) |
| Type | keydown | composer committed | ms per key; commits per key | `keydown` → `composer-commit`, Profiler counts |
| Stream | first delta | reply finished | renderer long tasks (> 50 ms) per minute | trace `toplevel` on demand |
| Live reload | Reload | first game frame | ms | not yet |
| Live resize | window or chat-handle drag | game view matches its slot | px behind per frame | dev control `window.resize` |
| Build turn | turn starts | turn's result recorded | ms outside model time | director `hostTimings` spans, `build_observation` (not yet aggregated) |
| Scroll | a fling in a long chat | rows drawn where it lands | frames painted with a blank block, beside a GPU-heavy game | `npm run test:ui -- chat-scroll-ui` (screencast frames, CPU profile, trace) |
| Run graph | run event | graph committed | ms; commits per event | `graph-commit`, Profiler counts (`event-batch` is never emitted) |
| Play | Play pressed in the switch | the first screen's covers loaded | ms after a relaunch and switching back; covers on screen still blank in a fast scroll | trace (cover requests), dev-control snapshot `play` (cards, covers on screen shown or blank, clips) |
| Idle | nothing happening | — | CPU %, rAF/s, memory after an hour of Autopilot | trace and heap on demand |

A journey that is "not yet" instrumented gets its marks before anyone optimizes it.

## Three kinds of number

- **Counters** are deterministic: React commits per interaction, IPC calls and bytes per journey,
  event files read per prompt, git processes per turn, eager renderer bytes, rAF per idle
  second. The same input gives the same count, so a counter can be a test assertion and a budget
  that only ratchets down. A counter is kept only while it moves with wall time; one that does
  not is dropped.
- **Lab wall time** comes from owned `studio:dev` profiles with diagnostics on. Report the median
  of at least three runs on matched inputs, with build id, source digest, React flavor (owned
  builds are development React with StrictMode), Mac model and display rate. A first launch and
  a warm launch are different rows.
- **Field time** stays on the person's Mac: Studio sends no analytics ([privacy](../PRIVACY.md)).
  A launch with `--studio-diagnostics` turns the main-process recorder (marks, IPC histograms,
  event-loop delay) on in any build, including a packaged one; Settings → Copy diagnostics
  carries its snapshot. Renderer marks exist only in owned builds, and Profiler counts only in
  owned fixture builds (`--commit-counts`): development React logs every render inside a Profiler
  with a diff of its props, which took most of a live session's main thread. The owner's own long
  sessions are the field sample.

## How a performance change is made

1. Name the journey and metric. Measure the current build first, on the fixture or profile that
   shows the problem, and keep the raw evidence.
2. Make it fail first: a counter assertion, a pure test of the scheduling or caching rule, or a
   dev-control measurement that shows the cost.
3. Change one thing. Re-measure on matched inputs.
4. Check the neighbouring journeys. A change that saves work by waiting (a debounce, a settle
   delay, a lazy load on the critical path) moves cost onto a person's input; measure that
   journey too.
5. Ratchet: lower the budget or counter limit in the same PR when the win is real.
6. The PR lists before and after per metric, with identities, and names every flipped assertion.

Timing thresholds in tests stay observational unless they are generous enough never to flake;
counters carry the regression gates.

## Tools

- `npm run studio:dev -- status --profile <id>` returns `performance`: startup marks, an
  invoke/push histogram per IPC channel, renderer journey pairs and event-loop delay.
- Dev-control `diagnostics` operations: `window.resize` (stepped resize of the studio window;
  returns how far Live's view trails its slot right after each change and just before the next,
  and how long it takes to settle), `graph.drag`, `cpu.start`/`cpu.stop` (a renderer),
  `main.cpu.start`/`main.cpu.stop` (the main process), `heap`, `trace.start`/`trace.stop`
  ([field guide](STUDIO-DEVELOPER-FIELD-GUIDE.md#owned-development-sessions)). Each operation checks
  the build is current from cached file fingerprints, so it does not stall the main process it measures.
- `npm run test:ui -- chat-scroll-ui [--build owned]`: flings a long chat with real input, alone
  and beside a stand-in game that keeps the GPU busy, and counts painted frames with a blank
  block; it also keeps a CPU profile and a trace of one fling.
- Fixture messages for journeys: `fixture:stream` (a short streamed reply) and `fixture:stream-long`
  (about ten thousand characters of Markdown and code, streamed at a fast model's pace, in a game chat).
- `dist/renderer/bundle-report.json`: eager renderer bytes against the budget in
  `scripts/renderer-build.mjs`; three.js must stay out of the eager graph.
- The eval ledger's `time.*` fields and `npm run eval -- compare|check` for whole-build timing
  ([evals](evals.md)).
- `scripts/bench/event-log.ts` for event-store reads at scale.

## Budgets in force

| Budget | Limit | Where |
| --- | --- | --- |
| Eager renderer bytes, release | 3,000,000 | `scripts/renderer-build.mjs` |
| Eager renderer bytes, development | 6,000,000 | `scripts/renderer-build.mjs` |
| three.js in the eager renderer graph | none | `scripts/renderer-build.mjs` |
| Production React in a packaged app | required | `tests/e2e/run-packaged-smoke.mjs` |
| sandbox-runtime, the Agent SDK or the MCP SDK imported at the top of main | none | `scripts/main-build.mjs` |
| Chat typing commits | unchanged per key | `tests/e2e/run-chat-ui.mjs` |

## Rules that keep work off the critical path

- The chat transcript mounts rows three screens ahead both ways and keeps them four screens
  back (`chat/transcript-window.ts`): a GPU busy with Live's game draws newly mounted rows late,
  so rows mounted just in time showed as a blank block under a fast fling.
- Endless "working" animations (status shimmer, busy dots and spinners, the working node's pulse)
  run only while the window is in front and was touched in the last two minutes
  (`renderer/motion-rest.ts`); while one runs, Chromium draws every frame.
- A live home background asks for no frames while Play or Plugins covers home (`ShaderCanvas`
  `covered`): the workspace is only hidden there, which its IntersectionObserver cannot see, so it
  drew every frame unseen.
- Play's covers load with their page rather than as they near the screen (a card's
  `content-visibility` hid a lazy cover until it was almost in view), the next page is read two
  screens ahead, and a cover the window has shown starts shown when Play opens again.
- A size read in an effect waits for a ResizeObserver's first call instead of forcing a layout
  mid-commit.
- Live's native view follows a resize in the window's own frame: main keeps the slot's right and
  bottom margins until the renderer measures again (`main/preview-anchor.ts`).
- Coding-CLI discovery reads the login shell's PATH once and asks an unchanged binary for
  `--version`/`--help` once, an answer kept across launches; sessions reuse both until Recheck.
- The launch's bootstrap does not wait for the engine checks: it carries the engines the last
  launch checked while this launch's checks run (`main/engine-boot.ts`).
- Plugin packages are inspected from directory listings, several folders at a time; event bodies
  are read through a sliding window.
- The launch's seed upgrade (`substrate/seed-upgrade.ts`) hashes the seed and the harness
  workspace, and rewrites renamed names, 32 files at a time rather than one after another.

## Packaged builds

`npm run make` builds with `--release` and packages with Forge; the DMG is that package. What
differs from an owned development build:

- **Renderer:** minified, production React, no StrictMode replays, no Profiler or journey marks.
  Owned builds overstate render cost; a packaged measurement needs `--studio-diagnostics`.
- **Main bundle:** `main.mjs` is a small entry (`main/boot.ts`) that turns on V8's compile cache
  and then imports the app, `app.mjs`, which is not minified in any mode. A packaged normal launch
  keeps the compiled code in `<userData>/v8-compile-cache` (`main/compile-cache.ts`), written 30 s
  after launch and at quit, so later launches skip most parsing and compiling (Electron 43, Linux:
  the bundle's import 238 → 168 ms median). Development, test and runner launches never write it.
  Heavy packages load on first use, not at its top.
- **Archive:** the app loads from `app.asar` with integrity validation; `dist/resources` (harness
  seed, vendored TypeScript, three.js, plugin payloads), node-pty and the sandbox vendor folder
  are unpacked because they are spawned or served.
- **Fuses:** `NODE_OPTIONS` and `--inspect` are off, so a packaged app cannot be profiled with a
  Node inspector; use diagnostics and Chromium traces.
- **First launch:** Gatekeeper verifies the signed bundle once, which lengthens the first start.
  A copy started from the mounted DMG or from Downloads runs from a read-only or translocated
  path instead of `/Applications`. Before the window opens, a new profile copies each bundled
  plugin into its plugin store (`core:plugins`); the Genex payload leaves out type declarations
  and source maps, two thirds of its files, which more than halves that copy
  (`plugin-payload-paths.test.ts`).
- **Data:** a packaged app opens the person's real profile, whose histories are larger than any
  fixture's; scale-dependent journeys (open a chat, send, run graph) are measured there too.

Nothing in the packaged build changes how Live follows the window, how chats render or how many
processes a build turn spawns; those journeys behave the same in both.
