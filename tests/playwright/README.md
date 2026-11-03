# Playwright Electron end-to-end suite

This suite drives the **real Genex Electron app** through Playwright’s `_electron` launcher. It does
not replace the in-app self-test (`npm run test:e2e` / `tests/e2e/run-electron-e2e.mjs`). It is the
offline desktop journey pack for local and in-house Linux CI.

It never talks to a live model provider. Chat and provider rows use the same **fixture engines** as
`studio:dev --fixture …`. Recorded Pi 1.4.0 JSON-mode streams live in
`tests/fixtures/transcripts/pi-recorded/` and are exercised by `tests/conformance/engine-pi.test.ts`;
this UI suite does not spawn `pi` or replay those files over the network.

## Command

```sh
npm run test:playwright
```

That runs `scripts/run-playwright-e2e.sh`: Node 24 check, a shared `--dev-build=playwright-e2e`
compile when needed, then Playwright. On Linux it wraps the run in `xvfb-run` when `DISPLAY` is
unset. Reports:

- HTML: `.studio-dev/evidence/playwright/html/index.html`
- JUnit: `.studio-dev/evidence/playwright/junit.xml`

Skip a rebuild when the tree is already there: `GENEX_E2E_SKIP_BUILD=1`. Force one:
`GENEX_E2E_FORCE_BUILD=1`.

Do not add this to GitHub Actions. Run it from the local/in-house job that already builds this
fork.

## Node and OS dependencies

- **Node 24** (see `.nvmrc`). `nvm use` then `node -v`.
- Locked npm install: `npm run deps`.
- **Electron 43** from `node_modules` (the postinstall downloads the binary).
- **Playwright** `@playwright/test` 1.63.0 (already in `package.json`; no extra browser install —
  the app is Electron).
- **Linux CI:** `xvfb`, **bubblewrap** (`bwrap`) and **socat** (the app’s ProcessSandbox refuses to
  start a developer/fixture profile without them), plus the usual Electron runtime libraries
  (`libnss3`, `libatk-bridge2.0-0`, `libgtk-3-0`, `libgbm1`, `libasound2`). The script passes
  `--no-sandbox --disable-gpu --disable-dev-shm-usage` on Linux. User namespaces must be available
  to `bwrap` (the same requirement as a Linux Genex install).
- A normal **macOS** developer machine can run the same `npm run test:playwright` without xvfb.

## Environment variables (credentials)

Nothing in this folder reads a secret into Git. Fixture launches scrub inherited provider tokens
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GENEX_TOKEN`, …) via `fixtureElectronEnv`.

| Variable | Role |
| --- | --- |
| `GENEX_E2E_PI_API_KEY` | Optional. Declares that a Pi/provider key exists for a human live check. **This suite never sends it.** Missing/invalid credential coverage uses fixture statuses instead. |
| `GENEX_E2E_PI_HOME` | Optional. A throwaway `HOME` that would hold a real `~/.pi` store. Unused by the default specs. |
| `GENEX_E2E_SKIP_BUILD` | `1` to reuse `.studio-dev/builds/playwright-e2e`. |
| `GENEX_E2E_FORCE_BUILD` | `1` to compile that tree even when it exists. |
| `DISPLAY` | If set on Linux, xvfb is not wrapped (use a real or existing virtual display). |

When those Pi variables are absent, the provider specs still pass: first-launch shows Pi **Not
installed**, and `STUDIO_FIXTURE_USAGE_FILE` `{"pi":"signed_out"}` shows **Not connected** and Sign
in, with no CLI and no HTTP.

## Journeys

1. **Launch** — `app-basics` fixture: the main window, the fixture game, the prompt bar, no fatal
   `pageerror` / console error (a short ignore list drops Chromium/React DevTools noise).
2. **Sign-in / Pi setup** — first-launch welcome (`data-onboarding-action=next|skip`) then Settings →
   Model Providers → `[data-provider-row="pi"]`. A second spec uses a signed-out Pi fixture status.
3. **Chat** — game composer `[data-chat-composer] [data-promptbar]`, Send, wait for the fixture
   engine’s `I can build a small scene with a clear sense of place.`
4. **Persistence** — Appearance → Light, quit, relaunch the same profile, `html[data-theme=light]`.

Selectors are existing `data-*` / aria hooks. No extra `data-testid` was added.
