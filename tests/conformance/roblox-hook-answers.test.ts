/**
 * The Roblox plugin's answers at Genex's moments: their words, a run's blocks against a chat's
 * notes, the Team Create notes naming the others, and the health note when Studio stops answering.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  crashAnswer,
  healthAnswer,
  loadAnswer,
  MOMENT_WORDS,
  PlaceLoad,
  PlaceSave,
  probeAnswer,
  RunStart,
  type SaveRead,
  StudioHealth,
  saveAnswer,
  shotsAnswer,
  startAnswer,
  teamAnswer,
} from "../../src/plugins/roblox/hook-answers.ts";
import { type HookContext, HookEvent } from "../../src/shared/plugin-hooks.ts";

const RUN_CHECKPOINT: HookContext = { on: HookEvent.CheckpointBefore, runId: "run_1", label: "Jump works" };
const CHAT_CHECKPOINT: HookContext = { on: HookEvent.CheckpointBefore, turn: "turn_1" };
const RESTORE: HookContext = { on: HookEvent.RestoreBefore, forPerson: true };
const BANNED = /\b(overnight|night|morning|tonight)\b/i;

const SAVED: SaveRead = { outcome: PlaceSave.Saved, written: 2, large: [] };
const FAILED: SaveRead = {
  outcome: PlaceSave.Failed,
  why: "The Genex helper in Roblox Studio didn't answer place.export in time.",
};
const UNSUPPORTED: SaveRead = { outcome: PlaceSave.Unsupported, why: "SerializationService isn't available" };
const NOT_CONNECTED: SaveRead = { outcome: PlaceSave.NotConnected };

describe("save-place's answers", () => {
  it("a run blocks a save point the place isn't in, a chat only notes it", () => {
    const rows: Array<[string, SaveRead, { run: "block" | "note" | "none"; chat: "block" | "note" | "none" }]> = [
      ["Studio not connected", NOT_CONNECTED, { run: "block", chat: "note" }],
      ["the export failed", FAILED, { run: "block", chat: "note" }],
      ["Studio can't export at all: the scripts only", UNSUPPORTED, { run: "note", chat: "note" }],
      ["saved", SAVED, { run: "none", chat: "note" }],
      ["not linked to a place", { outcome: PlaceSave.NotLinked }, { run: "none", chat: "none" }],
    ];
    const kind = (answer: ReturnType<typeof saveAnswer>) => (answer.block ? "block" : answer.note ? "note" : "none");
    for (const [name, read, expected] of rows) {
      assert.equal(kind(saveAnswer(read, RUN_CHECKPOINT)), expected.run, `run: ${name}`);
      assert.equal(kind(saveAnswer(read, CHAT_CHECKPOINT)), expected.chat, `chat: ${name}`);
    }
  });

  it("says what it saved, and what the scripts-only fallback means for Rewind", () => {
    assert.deepEqual(saveAnswer(SAVED, CHAT_CHECKPOINT), { note: "Saved Roblox Studio's place (2 parts changed)." });
    assert.deepEqual(saveAnswer({ ...SAVED, written: 0 }, CHAT_CHECKPOINT), {}, "nothing changed says nothing");
    assert.deepEqual(saveAnswer(UNSUPPORTED, RUN_CHECKPOINT), {
      note: "This Studio can't export its place (SerializationService isn't available), so save points hold the scripts only and Rewind brings back the scripts alone.",
    });
    assert.deepEqual(saveAnswer(NOT_CONNECTED, RUN_CHECKPOINT), {
      block:
        "Roblox Studio isn't connected for this game, so its place couldn't be saved. Open the place in Studio, then save again.",
    });
    assert.deepEqual(saveAnswer(NOT_CONNECTED, CHAT_CHECKPOINT), {
      note: "Roblox Studio isn't connected for this game, so this checkpoint holds the scripts only.",
    });
  });

  it("names the parts save points leave out, larger than 50 MB", () => {
    const large = {
      outcome: PlaceSave.Saved,
      written: 1,
      large: [".genex/place/Workspace.split/Island.rbxm"],
    } as const;
    assert.deepEqual(saveAnswer(large, RUN_CHECKPOINT), {
      note: ".genex/place/Workspace.split/Island.rbxm is larger than 50 MB, so save points leave it out and Rewind can't bring it back.",
    });
  });

  it("before a restore: a failed save blocks (nothing goes back) and others in Team Create are named", () => {
    assert.deepEqual(saveAnswer(FAILED, RESTORE), {
      block:
        "Genex couldn't save Roblox Studio's place first (The Genex helper in Roblox Studio didn't answer place.export in time.), so nothing went back. Try again in a moment.",
    });
    assert.deepEqual(saveAnswer(NOT_CONNECTED, RESTORE), {}, "a closed Studio has nothing newer to save");
    assert.deepEqual(saveAnswer(SAVED, RESTORE, ["Ana", "Bo"]), {
      note: "Others are in this place in Team Create (Ana, Bo): going back also undoes their edits since then.",
    });
    const many = saveAnswer(SAVED, RESTORE, ["Ana", "Bo", "Cy", "Di", "Ed"]);
    assert.match(String(many.note), /\(Ana, Bo, Cy and 2 more\)/);
    assert.equal(saveAnswer(FAILED, RESTORE, ["Ana"]).note, MOMENT_WORDS.TeamRewind(["Ana"]), "named beside the block");
  });
});

describe("load-place's answers", () => {
  it("never blocks: Studio closed leaves the load waiting, and each other case says what went back", () => {
    assert.deepEqual(loadAnswer({ outcome: PlaceLoad.Loaded }), {});
    assert.deepEqual(loadAnswer({ outcome: PlaceLoad.Pending }), {
      note: "Roblox Studio isn't connected for this game, so its place goes back the next time Studio opens it; the scripts went back now.",
    });
    assert.deepEqual(loadAnswer({ outcome: PlaceLoad.NoExport }), {
      note: "This save point holds no saved place, so only the scripts went back.",
    });
    const failed = loadAnswer({ outcome: PlaceLoad.Failed, why: "The saved place part Workspace.rbxm can't be read." });
    assert.equal(failed.block, undefined);
    assert.match(
      String(failed.note),
      /couldn't load the saved place \(The saved place part Workspace\.rbxm can't be read\.\)/,
    );
  });
});

describe("studio-state's answers", () => {
  it("quiet while Studio answers, pending while it may yet, blocked once it can't", () => {
    const rows: Array<[StudioHealth, "none" | "pending" | "block"]> = [
      [StudioHealth.Answers, "none"],
      [StudioHealth.Starting, "pending"],
      [StudioHealth.Connecting, "pending"],
      [StudioHealth.Silent, "pending"],
      [StudioHealth.Unlisted, "pending"],
      [StudioHealth.Gone, "block"],
      [StudioHealth.NotOpen, "block"],
      [StudioHealth.NoPlace, "block"],
      [StudioHealth.NotSetUp, "block"],
    ];
    for (const [health, expected] of rows) {
      const answer = healthAnswer(health, true);
      assert.equal(answer.block ? "block" : answer.pending ? "pending" : "none", expected, health);
    }
  });

  it("a Studio that stops answering may have a dialog open; on a Mac the agent may look with app_look, look only", () => {
    const mac = healthAnswer(StudioHealth.Silent, true);
    assert.equal(
      mac.pending,
      "Roblox Studio isn't answering; a dialog may be open in Studio. Look at Studio with app_look (look only) to see what it asks, and tell the person; never click it.",
    );
    assert.equal(mac.note, mac.pending, "the same words reach the record as a note");
    const windows = healthAnswer(StudioHealth.Silent, false);
    assert.equal(windows.pending, "Roblox Studio isn't answering; a dialog may be open in Studio.");
    assert.doesNotMatch(String(windows.note), /app_look/, "no app_look where there is none");
    assert.equal(healthAnswer(StudioHealth.Gone, true).block, "Roblox Studio isn't running: it crashed or was closed.");
  });
});

describe("the other moments' answers", () => {
  it("the crash note asks the person to reopen Studio and says Genex never closes it", () => {
    assert.deepEqual(crashAnswer(), {
      note: "Roblox Studio closed for this game. Reopen it with Open Studio in the Roblox Studio panel; Genex never closes or force-quits Studio.",
    });
  });

  it("the Team Create note names who else is in the place, once each time that changes", () => {
    assert.deepEqual(teamAnswer(["Ana", "Bo"], undefined), { note: "Also in this place in Team Create: Ana, Bo." });
    assert.deepEqual(teamAnswer(["Bo", "Ana"], ["Ana", "Bo"]), {}, "the same people say nothing again");
    assert.deepEqual(teamAnswer([], ["Ana"]), { note: "Nobody else is in this place in Team Create now." });
    assert.deepEqual(teamAnswer([], undefined), {}, "a place nobody shares says nothing");
    assert.deepEqual(teamAnswer(null, ["Ana"]), {}, "unknown says nothing");
  });

  it("a run's start: quiet when ready, a note when Genex opened the place, a block with the step otherwise", () => {
    assert.deepEqual(startAnswer({ outcome: RunStart.Ready }, true), {});
    assert.deepEqual(startAnswer({ outcome: RunStart.Opened, place: "sky-race" }, true), {
      note: "Opened sky-race in Roblox Studio for the Loop.",
    });
    assert.equal(startAnswer({ outcome: RunStart.NotSetUp }, true).block, MOMENT_WORDS.NotSetUp);
    assert.equal(startAnswer({ outcome: RunStart.NoPlace }, true).block, MOMENT_WORDS.NoPlace);
    assert.equal(
      startAnswer({ outcome: RunStart.NotConnected, minutes: 3 }, true).block,
      "Roblox Studio didn't connect for this game within 3 minutes. Open its place in Studio, then start again.",
    );
    assert.match(String(startAnswer({ outcome: RunStart.Silent }, true).block), /dialog may be open.*app_look/);
  });

  it("the viewport is one picture, and the probe claims nothing unsaved", () => {
    assert.deepEqual(shotsAnswer({ data: "AAAA" }), { images: [{ name: "viewport", data: "AAAA" }] });
    assert.deepEqual(shotsAnswer(null), {});
    assert.deepEqual(probeAnswer(true), { personActive: true });
  });

  it("every word is plain: no time-of-day words", () => {
    // A word that takes names gets a list; one that takes a reason or a count gets one value.
    const said = (word: (arg: never) => string) => {
      try {
        return word("why" as never);
      } catch {
        return word(["Ana"] as never);
      }
    };
    const words = Object.values(MOMENT_WORDS).map((value) =>
      typeof value === "function" ? said(value as (arg: never) => string) : value,
    );
    for (const text of words) assert.doesNotMatch(String(text), BANNED);
  });
});
