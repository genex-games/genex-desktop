import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { coreLite } from "../helpers/core-lite.ts";

const FAILURES = [
  Object.assign(new Error("srt-win acl stamp timed out after 60000ms"), { code: "srt_win_timeout" }),
  Object.assign(new Error("WFP egress probe: CreateProcessWithLogonW: Access is denied"), {
    code: "wfp_verify_failed",
  }),
  new Error("could not deny the sandbox user Credentials: ERROR_INVALID_PARAMETER"),
];

describe("sandbox startup before harness recovery", () => {
  for (const failure of FAILURES) {
    it(`preserves harness edits and reports the original sandbox failure: ${failure.message}`, async () => {
      const { core, close } = await coreLite();
      const main = path.join(core.layout.harnessWs, "loop", "main.ts");
      const shipped = await readFile(main, "utf8");
      await core.snapshot("harness", "healthy before the local edit", undefined, true);
      const edited = `${shipped}\n// A valid edit that a sandbox fault must not rewind.\n`;
      await writeFile(main, edited);
      let checked = 0;
      let starts = 0;
      let restarts = 0;
      core.sandbox.ensureReady = async () => {
        checked++;
        throw failure;
      };
      core.host.start = async () => {
        starts++;
        throw failure;
      };
      core.host.restart = async () => {
        restarts++;
        throw failure;
      };
      try {
        await assert.rejects(core.start(), (error) => error === failure);
        assert.equal((await readFile(main, "utf8")) === edited, true, "the existing harness code must survive");
        assert.equal(checked, 1, "sandbox readiness is checked before the harness boots");
        assert.equal(starts, 0, "no harness process starts before the sandbox is ready");
        assert.equal(restarts, 0, "a sandbox fault must not trigger rewind or reseeding");
      } finally {
        await close();
      }
    });
  }
});
