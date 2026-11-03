#!/usr/bin/env bash
# Local / in-house Playwright Electron suite. Not a GitHub Actions workflow.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! command -v node >/dev/null; then
  echo "Node is required. Install Node 24 (see .nvmrc) and retry." >&2
  exit 1
fi

node scripts/check-node.mjs

mkdir -p .studio-dev/evidence/playwright

main=".studio-dev/builds/playwright-e2e/main/main.mjs"
if [[ "${GENEX_E2E_SKIP_BUILD:-}" == "1" ]]; then
  if [[ ! -f "$main" ]]; then
    echo "GENEX_E2E_SKIP_BUILD=1 but $main is missing." >&2
    exit 1
  fi
elif [[ "${GENEX_E2E_FORCE_BUILD:-}" == "1" || ! -f "$main" ]]; then
  echo "Building developer tree --dev-build=playwright-e2e"
  node scripts/build.mjs --dev-build=playwright-e2e --commit-counts
else
  echo "Reusing $main (set GENEX_E2E_FORCE_BUILD=1 to rebuild)"
fi

playwright=(npx playwright test --config tests/playwright/playwright.config.ts)

if [[ "$(uname -s)" == "Linux" ]]; then
  if ! command -v bwrap >/dev/null || ! command -v socat >/dev/null; then
    echo "Linux fixture launches need bubblewrap (bwrap) and socat." >&2
    exit 1
  fi
fi

if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null; then
    echo "Linux without DISPLAY needs xvfb-run (package xvfb)." >&2
    exit 1
  fi
  echo "Running Playwright under xvfb-run"
  exec xvfb-run --auto-servernum -s "-screen 0 1280x800x24" -- "${playwright[@]}"
fi

exec "${playwright[@]}"
