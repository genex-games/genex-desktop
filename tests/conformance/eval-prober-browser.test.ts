/**
 * The quick probe and the boot probe in REAL headless Chromium, over a synthetic fixture game served
 * from 127.0.0.1. Opt-in: it launches a browser, so it runs only with `STUDIO_BROWSER_TESTS=1` and a
 * Playwright Chromium already installed (browsers are never downloaded here). Everything it proves
 * about the rows is also proven hermetically by `eval-prober-quick-probe.test.ts`; this file proves
 * the Playwright driver and the injected instrument work against a real page.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { probeBoot, runQuickProbe } from "../../scripts/evals/grade/quick-probe.ts";
import { probeLockPath } from "../../scripts/evals/prober/lock.ts";
import { CheckResult, EntranceVia, ProbeRow, RendererMode } from "../../scripts/evals/vocabulary.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Why this file skips. */
const SkipReason = {
  NotOptedIn: "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run",
  NoChromium: "no Playwright Chromium is installed; this suite never downloads one",
} as const;

/** The probes run in software mode, a headless launch the headless shell alone serves. */
function skipReason(): string | false {
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

const skip = skipReason();

describe("the quick probe in Chromium", { skip }, () => {
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

  it("boots, enters by the PLAY button and sees the input move the scene", { timeout: 180_000 }, async () => {
    const home = fs.realpathSync(await tmpDir("eval-prober-browser-"));
    const evidenceDir = path.join(home, "evidence", "probe");
    const result = await runQuickProbe(
      url,
      { firstDrawTimeoutMs: 30_000, rendererMode: RendererMode.Software, noErrorsMs: 15_000, evidenceDir },
      { lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) },
    );
    assert.equal(result.rows[ProbeRow.L1BuildsAndBoots], CheckResult.Pass);
    assert.equal(result.entrance, EntranceVia.StartControl);
    assert.equal(result.rows[ProbeRow.L2InputChangesState], CheckResult.Pass);
    assert.equal(result.rows[ProbeRow.L1StayedOnGame], CheckResult.Pass);
    assert.ok(result.evidence.frames.length > 0);
    assert.ok(result.evidence.frames.every((f) => fs.existsSync(f.path)));
  });

  it("answers the boot question alone within a scan's short timeout", { timeout: 120_000 }, async () => {
    const home = fs.realpathSync(await tmpDir("eval-prober-browser-"));
    const boot = await probeBoot(
      url,
      { firstDrawTimeoutMs: 20_000, rendererMode: RendererMode.Software },
      { lockPath: probeLockPath({ GENEX_EVALS_HOME: home }) },
    );
    assert.equal(boot.booted, CheckResult.Pass);
    assert.equal(boot.rendererMode, RendererMode.Software);
  });
});
