/**
 * The full prober in REAL headless Chromium, over the prober's synthetic fixture game served from
 * 127.0.0.1. Opt-in: it launches a browser, so it runs only with `STUDIO_BROWSER_TESTS=1` and a
 * Playwright Chromium matching the installed Playwright already on disk (browsers are never
 * downloaded here). Everything it proves about the rows is proven hermetically by
 * `eval-full-prober-probe.test.ts`; this file proves the phases' page-side reads and inputs work
 * against the real driver and instrument. The soak is shortened deliberately, so the five-minute
 * rows must read `unknown`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runFullProbe } from "../../scripts/evals/prober/full-probe.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
import { CheckResult, ProbeRow, RendererMode } from "../../scripts/evals/vocabulary.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Why this file skips. */
const SkipReason = {
  NotOptedIn: "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run",
  NoChromium:
    "no Chromium build matching the installed Playwright is on disk (Playwright 1.63 expects chromium-1243 or its headless shell); this suite never downloads one",
} as const;
type SkipReason = (typeof SkipReason)[keyof typeof SkipReason];

/** The prober runs in software mode, a headless launch the headless shell alone serves. */
function skipReason(): SkipReason | false {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return SkipReason.NotOptedIn;
  return playwrightHeadlessChromiumOnDisk() ? false : SkipReason.NoChromium;
}

const GAME_DIR = path.resolve(import.meta.dirname, "../fixtures/evals/prober/game");
/** The only files the fixture server answers; anything else is a 404. */
const SERVED: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html" },
  "/index.html": { file: "index.html", type: "text/html" },
  "/game.js": { file: "game.js", type: "text/javascript" },
};
const SHORT_SOAK_MS = 30_000;
/** A chosen budget for the short soak (the default floor, `probeBudgetMs`, would also hold it). */
const SHORT_SOAK_BUDGET_MS = 600_000;

describe("the full prober in Chromium", { skip: skipReason() }, () => {
  let server: http.Server;
  let url = "";
  before(async () => {
    server = http.createServer((req, res) => {
      const entry = SERVED[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
      if (!entry) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": entry.type }).end(fs.readFileSync(path.join(GAME_DIR, entry.file)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.html`;
  });
  after(() => server.close());

  it("answers every row, and a deliberately short soak leaves the five-minute rows unknown", {
    timeout: 600_000,
  }, async () => {
    const home = fs.realpathSync(await tmpDir("eval-full-prober-browser-"));
    const evidenceDir = path.join(home, "evidence", "probe");
    const result = await runFullProbe(
      url,
      {
        firstDrawTimeoutMs: 30_000,
        rendererMode: RendererMode.Software,
        evidenceDir,
        soakMs: SHORT_SOAK_MS,
        budgetMs: SHORT_SOAK_BUDGET_MS,
      },
      { lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) },
    );
    assert.deepEqual(Object.keys(result.rows).sort(), Object.values(ProbeRow).sort());
    assert.equal(result.quick, false);
    assert.equal(result.soakMs, SHORT_SOAK_MS);
    assert.equal(result.rows[ProbeRow.L1BuildsAndBoots], CheckResult.Pass);
    assert.equal(result.rows[ProbeRow.L1Survives5min], CheckResult.Unknown);
    assert.equal(result.rows[ProbeRow.L2NoSoftLock5min], CheckResult.Unknown);
    assert.ok(result.evidence.frames.every((f) => fs.existsSync(f.path)));
  });
});
