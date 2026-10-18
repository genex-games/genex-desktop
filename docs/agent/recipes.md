# Recipes

Step lists for common changes: the files to touch, in order, and the tests to extend. Each
recipe starts red: write or extend the test first and watch it fail for the right reason. Run
L0/L1 (`npm run check:static`, `npm run check`) while iterating and the layers named in the
recipe before the PR; see [verification](verification.md#test-layers). Terms are in the
[glossary](glossary.md).

## IPC channel

A renderer action that needs main-process or core work.

1. Contract: add the method and its types to `StudioApi` in `src/shared/studio-api.ts`. Shared
   types live in `src/shared/`; the renderer may import them.
2. Channel map: in `src/shared/ipc-channels.ts` add `"studio:<area>.<verb>": "<method>"` to
   `STUDIO_INVOKE_CHANNELS` and the payload the preload sends to `StudioInvokePayloads` (derive
   it from the method's parameters with `Arg<…>` where it is one of them). The result is always
   the method's, so it is never written twice. A push from main is a key of
   `STUDIO_PUSH_CHANNELS` naming its `on*` subscription instead; a new UI event on the existing
   `studio:event` push (`UiEventMap`) or a new durable custom event (`CustomEventMap`) is not a
   channel (see [Event type](#event-type)), and neither is a new method the harness calls, which
   is a key of `HarnessHostApi` (see [Harness RPC method](#harness-rpc-method)).
3. Preload: add the named call in `src/preload/studio-bridge.ts`,
   `name: (...) => invoke("studio:<area>.<verb>", { ... })` (`subscribe(channel, listener)` for a
   push). No generic passthrough.
4. Main: register it in the domain's registrar, `src/main/ipc/<domain>.ts` (composed by
   `src/main/index.ts`), with `handle('studio:<area>.<verb>', payload => core.<method>(...))`.
   Do not annotate the payload: `handle()` types it and the result from the map, so a handler
   that disagrees with the preload does not compile. It wraps errors and runs the fixture guard. Validate payload fields here or
   in the core method (the sender is a browser); resolve path parameters by realpath inside the
   owned root. Push with `pushToRenderer(window.webContents, channel, payload)`, never a raw
   `send`.
5. Core: put the behavior in a `StudioCore` method or the service under `src/main/core/` it
   delegates to, not in the handler. Public core methods are pinned by
   `tests/conformance/core-surface.test.ts`: update its golden list deliberately.
6. Policy: classify the channel in `src/main/dev/native-policy.ts`: the fixture-safe list for
   work inside the profile, the native list for accounts, native dialogs, downloads, external
   apps or OS paths. Both lists take their keys from the channel map and a map channel in
   neither fails `npm run typecheck`; `tests/conformance/native-policy.test.ts` covers the guard
   itself. A native step inside a handler that is no channel of its own goes in `NATIVE_STEPS`.
7. Fixtures: if fixture UI runs reach the call, make sure `src/main/dev/fixtures.ts` gives it
   deterministic data, and add a default to `tests/helpers/fake-studio-api.ts`.
8. Tests: behavior of the core method via `tests/helpers/core-lite.ts`; renderer use via
   `fake-studio-api.ts`. `tests/conformance/ipc-contract.test.ts` checks that the preload, main
   and the fixture policy use exactly the map's channels; `tests/conformance/architecture.test.ts`
   and `npm run verify:architecture` guard the browser boundary.
9. Docs: add the UI entry to [the feature map](feature-map.md) when a control uses it.

Layers: L1, L2 (`npm run test:area -- <id>`), L4 when the UI changes.

## Harness RPC method

A new `ctx.call("<name>")` the harness uses.

1. Contract first: add `"<area>.<verb>": { params: …; result: … }` to `HarnessHostApi` in
   `src/shared/harness-api.ts` (`params: void` when it takes nothing). Data shapes it carries
   belong in `src/shared` too; the substrate re-exports them.
2. Add the handler to its namespace's table in `src/main/harness-rpc/<namespace>.ts` as
   `"<area>.<verb>": async (p) => …`, with the behavior in a `src/main/core/` service. Do not
   annotate `p` or cast the handler: `api()` is `HarnessHostHandlers`, so the params and result
   come from the map, and a missing, extra or disagreeing handler fails `npm run typecheck`. Host
   code that needs the same work calls a typed core method or service, not `api()[…]`; public
   core methods stay pinned by `tests/conformance/core-surface.test.ts`.
3. Treat every parameter as hostile: the harness is agent-edited code. When a param names a file,
   a folder or a game folder, add its zod schema to `HARNESS_PARAM_SCHEMAS` (only those fields,
   optional ones `.nullish()`); `HarnessHost` refuses a malformed call with `InvalidParams`
   before the handler runs. Still resolve the path by realpath inside its owned root in the
   handler.
4. Update the golden table in `tests/conformance/rpc-surface.test.ts`; its second test checks
   that every name the seed calls exists. `tests/conformance/harness-api.test.ts` checks the
   schemas at the choke point and that each accepts every params value its type allows.
5. Add its member to `HostMethod` beside the map (the typecheck fails for a method without one)
   and run `node scripts/gen-harness-types.ts`: it writes `types/host-api.d.ts` and the seed's
   copy of the names, `loop/host-methods.ts`.
6. Call it as `ctx.call(HostMethod.AreaVerb, …)` from `src/harness-seed/loop/*.ts` and follow
   the harness incident recipe below if it fixes loop behavior.

## Event type

Durable history the UI or the harness reads later.

1. Most new events are `custom` events: `{ type: "custom", event_type: "<snake_case>", payload }`
   (`EventData` in `src/shared/event-log.ts`, re-exported by `src/substrate/types.ts`). A new
   top-level `type` changes the append-only log format and needs a strong reason.
2. Register it first in `src/shared/custom-events.ts`: add a member to `CustomEvent`
   (`CUSTOM_EVENT_TYPES` lists the values) and, when the app reads it, its payload to
   `CustomEventMap` (every field optional: the harness writes it and may be agent-edited, and old
   logs keep old shapes; reuse a payload type that already lives in `src/shared`). A `CustomEventMap` key the registry lacks fails the typecheck;
   `tests/conformance/custom-events.test.ts` fails for a name the code writes or reads (including
   through `customPayload`/`customEvent`) that the registry lacks, and for a registered name
   nothing uses.
3. Emit it from the owner: the harness via `appendRun` (`loop/run-events.ts`; add the name to
   its copy, `RunEvent`), or the core via its event store (`src/substrate/event-store.ts`) with
   `customEventData(CustomEvent.X, payload)`. Payloads carry ids and typed codes, never display
   sentences.
4. Project it where it is read: transcript entries in `src/renderer/chat-entries.ts` (one
   narrator in `NARRATORS`), run structure in `src/renderer/run-graph.ts` (one case in
   `applyRunEvent` or `applyPartEvent`, readers in `run-graph-parse.ts`), run summaries in
   `src/shared/run-summary.ts`.
   Read the payload with `customEvent(event, name)` / `customPayload(data, name)` (a name or a
   list of names; `null` for any other event, `{}` for a missing payload), `delegatedPayload`
   for the `delegated.<engine>` trace, or `customRecord` for any custom event; never
   `data.payload as`. Put user-facing words in `src/renderer/words.ts`.
5. Live updates reach the renderer through the `studio:event` push channel of the IPC map
   (`STUDIO_PUSH_CHANNELS` in `src/shared/ipc-channels.ts`, delivered by `onEvent`); no new
   channel is needed. A new transient UI event (`area.verb`) is a key of `UiEventMap` in
   `src/shared/ui-events.ts` first (fields the harness writes are optional) with its `UiEvent`
   member, then `this.emit(UiEvent.AreaVerb, payload)` in the core,
   `pushUiEvent({ type, payload })` in main or `ctx.notify` in the harness. The renderer narrows on `event.type` (`isUiEventIn` for a
   family such as `chat.`); never cast `event.payload`.
   `tests/conformance/ui-events.test.ts` fails for a produced name the map lacks, or a key
   nothing produces.
6. Tests: projection tests in `tests/conformance/run-graph.test.ts`,
   `run-summary.test.ts` or `chat-history.test.ts`; storage behavior in `event-store.test.ts`.
   Replaying old logs must still work: add an old-shape event to the test.

## Provider or engine

1. Implement `Engine` from `src/substrate/engines/types.ts` in
   `src/substrate/engines/<name>.ts`. Direct engines implement `complete`, `models` and `status`
   (model on `ollama.ts`); session engines implement `delegate` and honor abort, timeout,
   resume, read-only and ownership options (model on `codex.ts`). Map failures to
   `EngineError` kinds, never to matched message text.
2. Add a row to `PROVIDERS` in `src/shared/providers.ts`: `id` (= `Engine.id`), the `label` a
   person says, `subscription`, `login` (`terminal` | `console` | `cli` | `none`), `roles` (`presets` |
   `sessions` | `completion` | `single`), `billing` (`local` | `subscription` | `metered`: a metered
   engine is never picked automatically) and, for a subscription, the `signIn` copy. A direct engine
   that holds sessions passes its id to `LocalSessions` (`engine`), as `openrouter.ts` does. `SUBSCRIPTION_ENGINES` in
   main and the renderer, the sign-in card, chat labels and `EngineDescriptor.provider` from
   `describe()` follow from it. Register the engine in `StudioCore.init`
   (`src/main/studio-core.ts`); the preferred order already appends `SUBSCRIPTION_ENGINES`.
3. Harness roles: for `roles: "presets"`, add model rows and tool syntax in
   `src/harness-seed/loop/model-roles.ts` (`ENGINE_MODELS`, `toolCall`, `toolSyntax`) and the same
   rows in `src/shared/model-roles.ts` (see [Seed contract](#seed-contract)); a `sessions` engine
   joins `SESSION_ENGINES` in both, a `completion` engine `COMPLETION_ROLE_ENGINES` (which jobs each
   may take: `takesRoles`, `crossesTo`), and one that reaches studio tools through the bridge joins
   `BRIDGE_ENGINES`;
   `tests/conformance/providers.test.ts` fails when either copy disagrees with the table. Run
   `node scripts/gen-harness-types.ts` if the descriptor shape changed.
4. Fixtures: add a scripted variant in `fixtureEngines()` in `src/main/dev/fixture-engines.ts` so
   UI runs never reach the real provider.
5. Tests: `tests/conformance/engines.test.ts` plus an `engine-<name>.test.ts` modeled on
   `engine-codex.test.ts`, which stubs the provider stream. Add
   `director-cross-engine.test.ts` coverage if the engine holds sessions.
6. Live checks are L5 and need explicit permission.

## Plugin tool

No core change. See [the plugin guide](../PLUGIN_GUIDE.md) and [plugin contract](../plugins.md).

1. Scaffold: `npm run plugin:new -- <id> --out <parent-dir>` (sample in `src/plugins/example/`).
2. Declare the tool in `tools[]` of `plugin.json` with scalar parameters and an optional
   `confirmation`; implement it in `backend.mjs` with the SDK in `src/plugin-sdk/`.
3. Check: `npm run plugin:doctor -- <dir>`, then package with
   `npm run plugin:pack -- <prebuilt-dir> <artifact.json>`.
4. For a first-party plugin under `src/plugins/`, extend `tests/conformance/plugins.test.ts`
   or `plugin-devkit.test.ts`. Manifest validation lives in `src/substrate/plugins/manifest.ts`.
5. Any change to a bundled plugin (manifest, skills, backend, shipped files) bumps its `version`:
   profiles run the installed package and are only offered a newer one.

## Panel or stage action

1. Plugin stage button: declare `toolbar[]` with a matching `actions[]` in the manifest; the
   host renders it through `src/renderer/panels/PluginToolbar.tsx`. No core change.
2. Built-in stage view: extend `StageView` and `VIEWS` in `src/renderer/stage.ts`, the
   tabs in `src/renderer/panels/stage/stage-tabs.ts` (`stageTabs`, `data-stage-action`; drawn by
   `StageStrip`'s `ViewSwitcher`), and the
   stage switching in `src/renderer/shell/use-stage-views.ts` and `shell/WorkspaceStage.tsx`.
   Full-stage views must hide the native game view through the preview bounds call.
3. Panel control: add a stable `data-*` attribute or aria-label and keep existing ones;
   smoke runners select by them. Add or update the row in [the feature map](feature-map.md).
4. Follow [the design workflow](design.md) for UI decisions.
5. Tests: pure logic in `src/renderer/*.ts` gets a Node test (components can use
   `tests/helpers/fake-studio-api.ts`); the rendered surface gets L4:
   `npm run test:ui -- build-smoke` or a `studio:dev` fixture snapshot.

## Asset format

Delivery through `assets.deliver` is already format-agnostic; preview and classification are
not.

1. Format: one row in `ASSET_FORMATS` in `src/shared/game-assets.ts` — kind, preview mode,
   MIME, whether it is a raster thumbnail or a model texture, and how each compiled stack takes
   it (`stacks`: loads, converts at import, or refused; `stackAcceptsAsset` marks a refused
   delivery). The inventory, the preview's MIME map, main's contained readers (`isImageFile`)
   and the audio checks (`isAudioFile`) all read that row. Where a project keeps a format (an
   engine's asset folder) is the `CORE_WORKSPACE` table in `src/shared/project-workspace.ts`.
2. Preview: `assetPreviewMode` in `src/shared/asset-preview.ts` only if the mode needs new logic.
3. 3D formats: a loader branch in `src/renderer/asset-model-viewer.js`; copy any decoder in
   `scripts/build.mjs`.
4. UI only if the new mode needs it: `src/renderer/panels/AssetThumbnail.tsx`,
   `AssetPreview.tsx`.
5. Tests: `tests/conformance/asset-preview.test.ts` and `game-assets.test.ts`; add a small
   synthetic sample to `tests/fixtures/asset-previews/` and note its source in its README.

## Destination

A place a compiled game is built for (Browser, Mac, Windows, Linux, and the phones below). Every
list of destinations reads the vocabularies, so a new one is mostly rows. The steps below are the
C++ · raylib lane's; a Rust · wgpu destination follows the phone steps after them.

1. Test first in `tests/conformance/game-targets.test.ts`: the host matrix row and
   `judgingTarget` for the new destination.
2. Contract: a `BuildTarget` member in `src/shared/game-project.ts` (in `BUILD_TARGETS` order,
   and `DESKTOP_TARGETS` for a desktop one), its row in `src/shared/game-targets.ts`
   (`hostTarget`, `buildRefusal`, `runRefusal`) and its `REQUIRED_COMPONENTS` in
   `src/shared/toolchain.ts`.
3. Toolchain: pinned entries in `src/substrate/toolchain-store/manifest.ts` (each digest also in
   the dev cache's `SHA256SUMS`), a `targets` and raylib variant in `recipe.json` with
   `tests/conformance/genex-cmake.test.ts` rows, and `PREWARMED_TARGETS` in `prewarm.ts` once
   prewarm builds its outputs. A `recipe.json` change makes the dev store re-prewarm
   (`node scripts/toolchains/dev-store.ts`).
4. Lane: its `CPP_BUILD_TIMEOUT_MS` row in `src/main/cpp-build.ts`, and a diagnostics pattern if
   its tools print a new error shape (`tests/conformance/cpp-build.test.ts`).
5. Words and UI: `DESTINATION_WORDS` in `src/renderer/words.ts`; the create dialog
   (`src/renderer/create-game-destinations.ts`) and the stage badges
   (`src/renderer/panels/stage/destinations.ts`) follow the vocabularies. `game.scaffold`'s
   targets schema is in `src/shared/harness-api.ts`; regenerate with
   `node scripts/gen-harness-types.ts`.
6. Run `node scripts/affected-tests.mjs --files <changed files> --run` with
   `GENEX_REQUIRE_TOOLCHAINS=1`, and `tests/conformance/cpp-lane-real.test.ts` where the dev
   toolchains are present.

A phone destination (iPhone and iPad, Android) is a Rust · wgpu destination with extra rows, and
an agent never runs it:

1. Test first: the admission row in `native-cross-admission.test.ts` and the gate's hostile table
   (`native-gate-elf.test.ts`, `native-gate-pe.test.ts`, `native-gate-wasm.test.ts`), signing in
   `mobile-sign.test.ts`, the launch in `device-launch.test.ts`.
2. Binary: `RUST_ADMITTED_EXECUTABLES` in `src/shared/native-contract.ts` (format, machine, files),
   its gate in `src/substrate/native-gate-*.ts`, and the notices row in
   `src/substrate/rust-notices.ts` (a destination without one is refused before anything is
   written).
3. Build and sign: its builder in `src/main/rust-build-mobile.ts` (registered by
   `rustTargetBuilders`; its row in `STACK_HOST_MATRIX`'s and the seed copy's `build`, never
   `run`) and its signer in `src/substrate/mobile-sign.ts`. The person's own identities are
   `ExportSigning` kinds the harness is refused before anything is read.
4. Export: its packaging in `src/substrate/<phone>-package.ts`, its run in
   `src/main/core/<phone>-export-run.ts` with an `EXPORT_RUNS` entry, and its services in
   `src/main/core/mobile-export-deps.ts` (lanes, the person's SDK probe, store tools, signer
   sandbox), bound by `StudioCore`'s export runners; `MOBILE_ARTIFACTS` and `ARTIFACT_SIGNINGS`
   name what the export sheet offers. `mobile-export-core.test.ts` holds the binding and
   `mobile-export-real.test.ts` the real lane-to-package row (`GENEX_REQUIRE_TOOLCHAINS=1`).
   Until the owner's device row runs, `RUST_GPU_QUALIFICATION` keeps it `untested` and the
   menu says "Untested on real devices".
5. Launch: its package path in `DEVICE_PACKAGE` (`src/main/core/device-launch.ts`) and its button
   in `stage/DeviceLaunch.tsx`. The launch stays a person's press
   (`studio:native.launchDevice`, native-classified); add no harness method, lease or capture
   that starts a device (`harness-api.test.ts`, `device-launch.test.ts` and the sandbox's adb
   and `~/.android` denies fail otherwise).
6. Judge it on the Mac or web build of the same code: the judge does not build a phone, so its
   parity rows stay unmeasured ("not built or run by the judge"), never a pass.

## Stack

What a game is written in (`three-js`, `raylib-cpp`, `rust-wgpu`); the Rust · wgpu stack is the
worked example. A stack is decided by the game's files and never changes, so most of a new one is
table rows that the typecheck forces.

1. Test first: per-stack table rows in `tests/conformance/game-project.test.ts`, detection and
   creation rows in `game-workspace.test.ts` (whose pre-M1 characterization digests must stay
   equal), and the seam's dispatch in `game-build-lane.test.ts`.
2. Contract: `GameStack` and `ProjectKind` members and `STACK_OF_KIND`, `STACK_TARGETS` in
   `src/shared/game-project.ts`; `STACK_HOST_MATRIX` in `game-targets.ts`; the required
   components and `LOCK_FILE_OF_STACK` in `toolchain.ts`; `setupTargets` in `stack-setup.ts`.
   Every exhaustive `Record<GameStack, …>` then fails the typecheck until it has a row. A stack
   a new game may start on joins `CREATABLE_STACKS` and the default's rows (`defaultStackFor`,
   `rustDefaultHost` in `toolchain.ts`: the host-conditional switch, its reasons and the
   rollback to Three.js); C++ · raylib stays out of both, its creation being retired
   (`CreationRefusal.RaylibCreationRetired`, `tests/conformance/stack-default.test.ts`). The
   seed's copy in `loop/native-contract.ts` is held by `seed-contracts.test.ts`
   ([seed contract](#seed-contract)).
3. Detection and creation: the stack's marker file in `src/substrate/project-shape.ts` (read by
   `lstat`, never followed), its checks in `game-validation.ts`, and its template
   `src/game-template-<stack>/`, shipped by `scripts/build.mjs` and
   `tests/helpers/resources.ts`. Until it ships, creation stays behind the development gate
   (`src/main/core/stack-gate.ts`), opened per host when it does.
4. Builds: register its lane in `coreGameBuilds` (`src/main/core/internals.ts`); until then every
   build is refused `lane-missing`. A destination's builder lands in its own module and is
   registered over the lane's table in one line (`rustTargetBuilders`), with any settings the
   lane merges (`targetSettings`). Each `isCompiledStack` call site is classified in
   `tests/fixtures/stack-split-sites.json` (`split-sites.test.ts`).
5. Toolchains: its pinned recipe beside `rust-recipe.json`, its lock file, and retention rows in
   `toolchain-retention.test.ts`.
6. Seed and plugins: list the seed modules an older kept copy cannot serve
   (`tests/fixtures/seed-exports-pre-rust.json`, `seedNightRefusal` in
   `src/substrate/seed-upgrade.ts`); a plugin skill naming the stack needs a new plugin API
   (`PRE_RUST_SKILL_STACKS`, `RUST_SKILL_STACKS_API` in `src/shared/plugins.ts`).
7. Words and UI: `STACK_WORDS` in `src/renderer/words.ts`, `stackOffer` in
   `src/renderer/create-game-destinations.ts`, and a fixture seed (`rust-game`,
   [dev fixture](#dev-fixture)).
8. Add the new suites to the `stack-identity` area in `docs/agent/knowledge-map.json`, then run
   `npm run test:area -- stack-identity` and `npm run verify:harness`.

## Genex API

What a generated Rust game can call: the `genex` facade in `native/genex-rust`, held by its own
tests and by the reference page the in-app agent reads. The
[add-genex-api skill](../../.agents/skills/add-genex-api/SKILL.md) has the files and the tests;
in short:

1. Test first in `native/genex-rust/crates/genex/tests/` (or a compile-fail case), run only
   through `node scripts/toolchains/rust-env.ts -- cargo test -p genex --offline --locked`.
2. The facade and the runtime crate behind it; new dependencies only from the vendored set
   (`scripts/toolchains/rust-vendor.ts check`).
3. the topic page `native/genex-rust/docs/api/<topic>.md` (and its row in the index
   `docs/GENEX_API.md`), byte-equal in `src/game-template-rust/docs/`; vocabularies in `tests/fixtures/rust-facade-vocabulary.json`.
4. A verb, refusal or native feature the app knows also goes through `src/shared/native-contract.ts`
   and the seed's copy ([seed contract](#seed-contract)).
5. `npm run test:rust-spike`, `npm run test:area -- rust-runtime` and `npm run verify:harness`;
   re-inventory the release tree (`rust-release.ts inventory`) for review.

## Zustand store

Renderer state that outlives a component: a domain store in `src/renderer/state/`.

1. Test first in `tests/conformance/renderer-state.test.ts`: the pure actions in Node, and the
   store through `createStudio` with `tests/helpers/fake-studio-api.ts` (no DOM).
2. Factory: `create<Domain>Store` with `zustand/vanilla` in `src/renderer/state/<domain>.ts`, and
   its changes as exported pure `(state, input) => state` actions. Fetches go through
   `createRefresher` (`refresher.ts`); a studio-wide subscription or poll lives in `studio.ts`.
3. Events: route the UI events that should re-read it in `ui-event-routes.ts`.
4. Reads: a selector hook in `hooks.ts` (`useShallow` for objects and arrays); components never
   read a store without a selector. Storage keys come from `src/renderer/storage.ts` only.
5. Keep UI-only state (dialogs, drafts, toggles) local, and derivations in the pure modules
   (`chat-entries.ts`, `run-graph.ts`, `build-progress.ts`, `src/shared/run-state.ts`).

## Seed contract

A rule the app and the harness both apply. The app must not load the seed
(`npm run verify:architecture` fails any import of `src/harness-seed/` from main, preload,
renderer or shared), and the seed cannot import the app.

1. Test first: extend `tests/conformance/seed-contracts.test.ts` with the input both copies must
   answer the same way.
2. Change the seed's copy in `src/harness-seed/loop/*.ts` and the app's typed copy in
   `src/shared/` (`coordinator.ts`, `message-queue.ts`, `model-roles.ts`, `skill-edits.ts`, or a
   new module beside them) in the same change.
3. An existing profile keeps an agent-edited seed file on upgrade, so the app's copy must still
   read records an older seed wrote.

## Vocabulary

A closed set of names code compares or writes: statuses, phases, kinds, event or method names.
The conventions are in [AGENTS.md](../../AGENTS.md#readability).

1. Grep the values first: every spelling in use, persisted or on the wire, keeps its exact text.
2. Declare it in the module that owns the type (`src/shared/<domain>.ts` for a contract, the top
   of the module for a private one): `export const EngineStatusCode = { Ready: "ready", … } as const`
   and `export type EngineStatusCode = (typeof EngineStatusCode)[keyof typeof EngineStatusCode]`.
   To bind it to an existing union, add `satisfies Record<string, Existing>` and the reverse
   `Exclude<Existing, …>` check (`HostMethod`, `UiEvent`, `EventKind` do both). Move every
   caller in the same change instead of keeping an alias; only a seed export an older seed
   imports stays (`tests/fixtures/seed-exports-2e-pre.json`, like `CLAUDE_CODE_ENGINE`).
3. Put its predicates beside it (`isEngineReady`, `isContextFailure`), not at call sites.
4. The seed cannot import it: give the seed its own copy (`RunEvent` in `loop/run-events.ts`) and
   hold the two together in `tests/conformance/seed-contracts.test.ts`
   ([seed contract](#seed-contract)). `HostMethod` is generated instead.
5. The scans in `custom-events.test.ts`, `ui-events.test.ts` and `rpc-surface.test.ts` read
   `Vocab.Member` as its value, so a migrated call site stays covered: run them.
6. `node scripts/check-vocabulary.ts` (part of `check:static`) refuses raw engine ids, custom
   event names, engine status codes, seed `ctx.call` names, harness RPC handler keys and inline
   `setTimeout` sleeps outside their homes. A module that must spell one of those values for
   another vocabulary (a vendor, a binary name) declares its own object instead; only a
   vocabulary's home joins a rule's `homes`, with its reason.

## Dev fixture

A named, deterministic `studio:dev` state for UI work without accounts.

1. Add the name to `FixtureName` in `src/main/dev/fixture-kit.ts` (`FIXTURE_NAMES` lists it), seed
   its state in a `fixture-*.ts` module and pick that seed in `prepareFixture()` in
   `src/main/dev/fixtures.ts`. Reuse must never reset a project's files or history.
2. Keep engines scripted (`fixtureEngines()`); fixture runs never reach a provider, network or
   Keychain.
3. `npm run studio:dev -- fixtures` lists it; start it with
   `npm run studio:dev -- start --profile <slug> --fixture <name>`.
4. Tests: `tests/conformance/dev-policy.test.ts` and `studio-dev-cli.test.ts`; record a golden
   snapshot when the fixture backs a UI check.
5. Mention it in [owned development sessions](verification.md#owned-development-sessions).

## Harness incident fix

A loop failure seen in a real run.

1. Reproduce it as one `it` in `tests/conformance/harness-incidents.test.ts`, named after the
   incident, on the rig (`tests/helpers/studio-rig.ts`) or on the pure function the fix lives
   in. It must fail before the fix.
2. Fix it in `src/harness-seed/loop/*.ts`. Keep the seed dependency-free and remember that
   existing profiles keep agent-edited files on seed upgrade.
3. Run `npm run verify:harness` (incidents and scoreboard), then L3 `npm run test:rig` if the
   fix touches run orchestration.
4. Prompt text under `src/harness-seed/prompts/`, `judge/` or `skills/` is product copy; edit it
   as such.
