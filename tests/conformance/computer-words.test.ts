/**
 * What an agent is told about the computer it works on names that computer: a Windows PC on
 * Windows, a Mac on a Mac, in the main agent's reach and in Auto mode's environment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mainAgentReachNote } from "../../src/main/core/delegation-prompts.ts";
import { type AutoModeSeat, autoModeRules } from "../../src/substrate/engines/claude-auto-mode.ts";

describe("the computer an agent is told it works on", () => {
  it("is a Windows PC on Windows and a Mac on a Mac, in the main agent's reach", () => {
    assert.match(mainAgentReachNote("win32"), /the user's own Windows PC/);
    assert.doesNotMatch(mainAgentReachNote("win32"), /\bMac\b/);
    assert.match(mainAgentReachNote("darwin"), /the user's own Mac/);
  });

  it("is a Windows PC on Windows and a Mac on a Mac, in Auto mode's environment, for every seat", () => {
    const cwd = "C:\\Games\\Valley";
    const seats: AutoModeSeat[] = [
      { cwd, gameFolder: true },
      { cwd, gameFolder: false, worker: true },
      { cwd, gameFolder: false },
    ];
    for (const seat of seats) {
      const windows = autoModeRules(seat, "win32").environment.join("\n");
      assert.match(windows, /Windows PC/, JSON.stringify(seat));
      assert.doesNotMatch(windows, /\bMac\b/, JSON.stringify(seat));
      assert.match(autoModeRules(seat, "darwin").environment.join("\n"), /own Mac/, JSON.stringify(seat));
    }
  });
});
