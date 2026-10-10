# Contributing

Thanks for helping. This page is the human on-ramp; [AGENTS.md](AGENTS.md) holds the same rules
in the form coding agents read, and the two must agree. Report security problems privately
([SECURITY.md](SECURITY.md)), never in a public issue. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## Before you start

- Open an issue (bug or feature template) before a large change, so the approach can be agreed.
- Contributor terms are not settled yet: see [Contributor terms](#contributor-terms) below.
  Until they are, a pull request may be held before merge.

AI-assisted contributions follow the same review, tests and attribution requirements as other
code. The contributor remains responsible for understanding the change and having the rights
to submit it. Disclose material generated/copying assistance and third-party sources; exclude
private prompts, credentials and customer or provider records from issues and pull requests.

## Set up

You need macOS on Apple Silicon, Git, and Node 24 (see the
[release readiness](docs/release-readiness.md) for the platform matrix).

```bash
nvm install          # once; reads .nvmrc (Node 24)
nvm use              # in every new shell: every script expects Node 24
npm ci               # the postinstall check refuses any other Node
npm run check:static # proves the toolchain works
```

After an Electron upgrade, or on Linux, run `npm run rebuild:terminal` to rebuild node-pty.
Restore missing or mismatched locked dependencies as needed for requested development; upgrades
are a separate decision. Do not use your normal Studio profile for development. For automated
checks, start an isolated fixture profile with
`npm run studio:dev -- start --profile <name> --fixture app-basics`. Fixture profiles use
scripted models, so no account is needed. For real manual testing, use a visible owned live
profile and leave it running for the person testing. See the
[field guide](docs/STUDIO-DEVELOPER-FIELD-GUIDE.md) for more commands and where data lives.

## Find your way

Read the [product overview](docs/agent/context.md), then only the page for the part you are
changing. `npm run review:context -- --files <paths>` lists the owning area, its docs and the
tests a change can affect. [Recipes](docs/agent/recipes.md) give the steps for common changes
(an IPC channel, an event type, a plugin tool, a provider). Folder notes are in
[src/AGENTS.md](src/AGENTS.md) and [tests/AGENTS.md](tests/AGENTS.md).

## Test first

Every behavior change starts with a test that fails for the reported reason, then the fix that
makes it pass. Characterize current behavior before refactoring it. Test through the code's
interface: a new test that reads source files as text and matches their spelling is refused by
`scripts/check-test-style.ts`. Copy or spacing edits need no new test. Name every assertion you
flip on purpose in the pull request.

Tests run on `node --test` under Node 24, which strips TypeScript types, so the code uses
erasable syntax only: no `enum`, `namespace` or parameter properties.

## The check loop

Use the cheapest layer that proves the change, and climb only when the change crosses the next
layer's boundary. The [layer table](docs/agent/verification.md#test-layers) lists available commands.

The [verification scope table](docs/agent/verification.md#choose-the-verification-scope)
owns required checks. Documentation changes need context verification; bounded behavior needs
relevant tests and affected integration suites; harness changes add the incident gate and
affected rig suites. Broad integration changes need full verification. Reuse passing results
until their relevant inputs change.

Single files: `npm test -- tests/conformance/<name>.test.ts`. A UI change also needs a rendered
look, not just a build; follow the [design workflow](docs/agent/design.md).

## Continuous integration

- **Check** (`.github/workflows/check.yml`) runs on every pull request and push: architecture
  boundaries, typecheck, Biome lint, test-style, baseline behavior contracts and affected L1
  tests in the Linux `gate` job. PR tests compare against the target branch's exact base SHA. The macOS
  `fast` job runs non-rig tests only on PRs targeting `main`, pushes to `main`, and dispatches.
  Manual runs accept an exact comparison `base`; set `fast=false` for a Linux-only fork run.
  Set `full=true` to run `npm run verify` on macOS, including serial rigs and fixture Electron
  acceptance. This is opt-in and uses a billed runner; it does not sign into live providers.
  `full_mode=acceptance` resumes only build/Electron stages; cite the earlier Node/rig pass and
  verify that its inputs still match. A continuation alone is not full verification.
  The gate also checks shared vocabulary and changed-script syntax.
  Fork feature pushes run Linux, documentation and Windows checks before upstream approval;
  upstream feature pushes skip these jobs, preserving the dev/main push policy.
- **Rig** (`rig.yml`) runs the serial rig group on pull requests labelled `full-tests` and on
  demand. Add that label when you touch core, harness or engine code.
- **Developer documentation** (`context.yml`) checks handbook size, links and the knowledge map.
- **Embedded terminal** (`terminal.yml`) builds and packages on macOS and Linux to test the
  terminal. Its billed runs use the same main-target/push/dispatch gate.

Forks run with a read-only token and no secrets. No CI job signs in to a provider.

## Pull requests

Fill in the [pull request template](.github/pull_request_template.md): what and why, which layers
ran (a focused pass is not a full run), red-first evidence for fixes, flipped assertions, and the
docs you updated or why they are still accurate. Docs describe the current app: replace outdated
statements in the same pull request instead of appending history. Keep one change per pull
request, and keep raw logs and screenshots out of Git.

## Contributor terms

Not decided yet. The owner will choose one of:

- **Developer Certificate of Origin (DCO).** You add a `Signed-off-by:` line to each commit
  (`git commit -s`), certifying you have the right to submit the code under the project's
  license. No separate agreement; a CI check verifies the sign-off.
- **Contributor License Agreement (CLA).** You sign an agreement once (usually through a bot on
  your first pull request) granting the project owner rights to your contribution, which also
  allows relicensing later.

The project uses [MIT](LICENSE), copyright `genex.games`. Contributions must be yours to
submit under MIT; retain upstream notices and identify copied sources. Formal DCO or CLA
automation remains an owner decision. See [release readiness](docs/release-readiness.md#distribution-and-open-source).
