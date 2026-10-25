# Verification

## Choose the verification scope

Choose checks from the behavior and boundaries that can change. State the selected scope and
reason before running them. This table owns required verification; the layer catalog and topic
references describe available checks, not a cumulative checklist.

| Change | Required completion checks |
| --- | --- |
| Documentation or instructions only | Review changed guidance and run `npm run verify:context`; no app build or runtime suite. Run focused settings/skill tests when their configuration or adapters change. |
| Local copy, spacing or color | Inspect rendered fit, relevant states and contrast. No automatic full-suite or composer run. |
| Bounded behavior, including core or engine logic | Relevant behavioral tests, typecheck affected contracts and affected integration/rig suites; exercise the changed UI interaction when applicable. |
| Harness or game-template behavior | Red-first incident coverage, `npm run verify:harness`, and affected L3 rig suites. Preserve user harness edits. |
| Shared UI primitives, theme or overlays | Relevant gallery checks plus representative app consumers, keyboard/focus and native game visibility when affected. |
| Development scripts, hooks or runners | Relevant static checks and command selection/prerequisite/failure behavior, using synthetic processes when appropriate. |
| Broad integration changes or explicit full regression | `npm run verify`; add packaged acceptance when delivery/resources/packaging changes. |

A bounded edit can still cross persistence, lifecycle or provider contracts; cover those
connections. A gallery cannot prove native game layering. Packaging, live providers and paid
operations are not implied merely by finishing a task. Feature-specific acceptance applies only
when its behavior is in scope.

### Focused commands and prerequisites

Use installed Node 24 (`nvm use`); `node scripts/check-node.mjs` checks it without installation.
Use native `arm64` Node on Apple Silicon (`node -p process.arch`); record architecture in
benchmarks and compare matched runtimes, separately from any Rosetta-to-native gain.
Restoring missing or mismatched locked dependencies with `npm run deps` is included in authorized
build/run/test work. Do not repeat it without need. Dependency upgrades and global installations
are separate decisions; do not change machine-wide runtimes incidentally.

```sh
npm test -- tests/conformance/agent-context.test.ts
npm test -- --test-name-pattern='handbook' tests/conformance/agent-context.test.ts
node scripts/affected-tests.mjs --files src/shared/chat-activity.ts --run
node scripts/affected-tests.mjs --area <area-id> --tier L3 --run
npm run review:context -- --files <paths>
```

Named files/globs avoid the affected graph and run serially by default. Flags need explicit
files or `--group fast|rig`; a name filter alone does not imply full discovery. Full `npm test`
runs the fast group with two file workers, then rigs serially, and still runs rigs after fast
failures. `--group rig` cannot override serial execution. The child-process leak check remains
enabled; runtime isolation overrides are deliberate caller choices.

The selector combines import edges and `tests/test-map.json`. By default it reads changes
against the merge base with `origin/dev`, including untracked files; `--staged`, `--base REF`,
`--files`, and `--area` narrow selection. `--json` lists it and `--run` executes it. Rigs copy
seed/template code, so those changes also select the harness gate. A behavior change selecting
no tests needs an explicit test or map edge, not an unverified success report.

### Stop and reuse evidence

Run selected checks once after relevant edits settle. Reuse passes while code, tests, fixtures,
dependencies and build inputs match. Unrelated prose does not invalidate runtime evidence.
Rebuild changed runtime bytes before checking them; do not modify shared output under a suite.

Keep failure logs and investigate product, expectation, fixture or environment causes. Rerun
after a specific correction or diagnostic change; do not loop unchanged failures until green,
increase deadlines, or treat an isolated retry as clearing an unexplained aggregate failure.
Resume unaffected stages without repeating valid passes. Report baseline failures and missing
prerequisites without expanding a bounded task into unrelated repair work.

Test observable behavior; copy/spacing edits need no new automated assertions. Report selected
layers, actual results and limitations. Never describe a focused pass as full verification.
Benchmarks report measurements separately from tests; compare only matched inputs
([performance](../performance.md)).

## Test layers

This is a command catalog. The scope table above determines which layers apply.

| Layer | Available checks |
| --- | --- |
| L0 | `npm run check:static`: typecheck, architecture, context, changed-script syntax, changed-file lint, test style, vocabulary and bundled plugin versions. |
| L1 | `npm run check`: L0 plus affected non-rig tests; named tests for red/green iteration. |
| L2 | `npm run test:area -- <id>` for an area's non-rig tests; `npm run verify:harness` for harness/template behavior. `test:fast` covers all non-rig tests when that breadth is needed. |
| L3 | `node scripts/affected-tests.mjs --tier L3 --run` for affected rig suites. `npm run test:rig` covers all rigs at broad checkpoints; full `npm test` covers all Node tests. |
| L4 | Owned fixture UI session or `npm run test:ui -- <name>` for relevant rendered behavior. |
| L5 | Authorized live/manual or release acceptance; record accounts/provider mode without exposing credentials. |
| L5 evals | Live eval campaigns (`npm run eval -- … --live`) run only on the owner's Mac with their sign-in to the eval homes, never in CI ([evals](../evals.md#campaign-runbook)); `npm run test:eval-fixture` is the account-free L4 run of the same pipeline. |

`npm run typecheck` uses TS 7 through `scripts/tsc.ts`; `.bin/tsc` can resolve TS 6.
The app and harness have separate projects. A shared harness API change requires
`node scripts/gen-harness-types.ts` and its contract test. TypeScript JS API consumers import
`@typescript/typescript6`. `npm run lint` checks Biome formatting and readability;
`lint:changed` includes uncommitted/untracked files. The source-text test allowlist may only
shrink. See the [vocabulary recipe](recipes.md#vocabulary). Coverage under-reports code rigs
execute from temporary copies.

## CI and platform checks

Every PR and dev/main push runs independent Linux static checks and a test plan. The plan unions
mandatory baseline files with affected L1 files and removes duplicates. Regular files use up to
six jobs; mandatory seed-upgrade cases use three separate jobs. Selected harness coverage uses
up to six jobs: ordinary root groups stay whole, and the large incident group is divided into
complete direct test subtrees. Every assigned group/case runs exactly once. Jobs retain the Linux
sandbox and child-process cleanup checks ([tests](../../tests/AGENTS.md#runner)). `gate` requires
successful planning, static checks, unit and seed jobs; only an explicitly unselected harness may skip.
Changes to the exact shared runner/toolchain inputs listed in `ci-test-plan.mjs` select the
entire fast inventory and harness, including deletion/rename of those inputs.
The macOS fast group also uses up to six jobs behind its `fast` aggregate. Its existing events,
plus the package, Windows and terminal workflows, remain PRs into
`main`, pushes to `main`, and dispatches. The owner opens dev-to-main PRs by hand.
Rig runs are separate: `full-tests`-labelled PRs and dispatches. Label core/harness/engine PRs
`full-tests`. For platform-sensitive work, dispatch the relevant workflow on its branch.

Windows sandbox setup, curated suite and dispatch options live in
[Windows sandbox verification](../windows-sandbox.md#ci-and-curated-suite).
Node tests report elapsed time; measure before changing suite selection. Budgets are guidance,
not evidence that an unrun check passed.

## Full regression and failure evidence

See [the owning reference](../STUDIO-DEVELOPER-FIELD-GUIDE.md#full-regression-and-failure-evidence) when this behavior is in scope.

## Owned development sessions

See [the owning reference](../STUDIO-DEVELOPER-FIELD-GUIDE.md#owned-development-sessions) when this behavior is in scope.

## Credentials

See [the owning reference](../connections-and-context.md#credentials) when this behavior is in scope.

## Acceptance evidence

See [the owning reference](../harness-runtime.md#acceptance-evidence) when this behavior is in scope.

## Hardening gates

See [the owning reference](../release-readiness.md#hardening-gates) when this behavior is in scope.

## External coding CLI acceptance (supersedes bundled-provider acceptance)

See [the owning reference](../connections-and-context.md#external-coding-cli-acceptance-supersedes-bundled-provider-acceptance) when this behavior is in scope.

## Plugin acceptance

See [the owning reference](../plugins.md#plugin-acceptance) when this behavior is in scope.

## MCP connector acceptance

See [the owning reference](../connections-and-context.md#mcp-connector-acceptance) when this behavior is in scope.

## Build outcome reporting acceptance

See [the owning reference](../harness-runtime.md#build-outcome-reporting-acceptance) when this behavior is in scope.

## Shared design system

See [the owning reference](../../design/genex/README.md#shared-design-system) when this behavior is in scope.

### Cover sphere acceptance

See [the owning reference](../../design/genex/README.md#cover-sphere-acceptance) when this behavior is in scope.

### Plugins page visual acceptance

See [the owning reference](../../design/genex/README.md#plugins-page-visual-acceptance) when this behavior is in scope.

## Focused MCP, connection, context and native-plugin acceptance

See [the owning reference](../connections-and-context.md#focused-mcp-connection-context-and-native-plugin-acceptance) when this behavior is in scope.

### Context popover and native Live regression

See [the owning reference](../connections-and-context.md#context-popover-and-native-live-regression) when this behavior is in scope.

### Reliability acceptance

See [the owning reference](../connections-and-context.md#reliability-acceptance) when this behavior is in scope.

### Asset preview acceptance

See [the owning reference](../connections-and-context.md#asset-preview-acceptance) when this behavior is in scope.

## Embedded terminal acceptance

See [the owning reference](../STUDIO-DEVELOPER-FIELD-GUIDE.md#embedded-terminal-acceptance) when this behavior is in scope.

### Appearance checks

See [the owning reference](../STUDIO-DEVELOPER-FIELD-GUIDE.md#appearance-checks) when this behavior is in scope.

### Acceptance follow-up regressions

See [the owning reference](../STUDIO-DEVELOPER-FIELD-GUIDE.md#acceptance-follow-up-regressions) when this behavior is in scope.
