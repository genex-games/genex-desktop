/**
 * Nicknames: the shape rules genex.games judges a handle by, judged the same way in the app so the
 * field can say what is wrong while it is typed. A handle is 3 to 20 of a–z, 0–9 and dashes, with
 * no dash at either end and never two together; what was typed is read trimmed, without a leading
 * @, in lowercase. A name in another script suggests a Latin handle. Whether a well-formed handle
 * is free is genex.games' to say; the app's own handle is the account's at once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HANDLE_LENGTH,
  HandleProblem,
  HandleState,
  handleBaseFromName,
  handleKept,
  handleProblem,
  isHandle,
  localHandleCheck,
  normalizeHandleInput,
  shownAsTaken,
} from "../../src/shared/handle.ts";

describe("a handle's shape", () => {
  it("reads what was typed trimmed, without a leading @, in lowercase", () => {
    const cases: Array<[string, string]> = [
      ["rabneba", "rabneba"],
      ["  RabNeba ", "rabneba"],
      ["@rab-neba", "rab-neba"],
      ["@@rab", "@rab"],
      ["rab neba", "rab neba"],
      ["", ""],
    ];
    for (const [typed, read] of cases) assert.equal(normalizeHandleInput(typed), read, typed);
  });

  it("names the first rule a handle breaks, length before letters", () => {
    const cases: Array<[string, HandleProblem | null]> = [
      ["rab", null],
      ["rab-neba", null],
      ["r2d2", null],
      ["a".repeat(HANDLE_LENGTH.max), null],
      ["", HandleProblem.TooShort],
      ["rn", HandleProblem.TooShort],
      ["рн", HandleProblem.TooShort],
      ["a".repeat(HANDLE_LENGTH.max + 1), HandleProblem.TooLong],
      ["рабнеба", HandleProblem.LatinOnly],
      ["rab neba", HandleProblem.LatinOnly],
      ["rab_neba", HandleProblem.LatinOnly],
      ["rab.neba", HandleProblem.LatinOnly],
      ["RabNeba", HandleProblem.LatinOnly],
      ["josé", HandleProblem.LatinOnly],
      ["-rab", HandleProblem.DashEdge],
      ["rab-", HandleProblem.DashEdge],
      ["rab--neba", HandleProblem.DashEdge],
      ["---", HandleProblem.DashEdge],
    ];
    for (const [handle, problem] of cases) assert.equal(handleProblem(handle), problem, handle);
  });

  it("takes as a stored handle only a well-formed string", () => {
    for (const good of ["rab", "rab-neba", "player-x1y2z"]) assert.equal(isHandle(good), true, good);
    for (const bad of ["", "RAB", "rab--neba", "-rab", "a".repeat(21), 7, null, undefined, {}, "rab/../x"])
      assert.equal(isHandle(bad), false, String(bad));
  });

  it("suggests a Latin handle from a name: words run together, other scripts spelled in Latin", () => {
    const cases: Array<[string, string]> = [
      ["Rab Neba", "rabneba"],
      ["Рабнеба", "rabneba"],
      ["José Núñez", "josenunez"],
      ["Øyvind Straße", "oyvindstrasse"],
      ["Юлия Щукина", "yuliyashchukina"],
      ["Mira Kovač", "mirakovac"],
      ["🎮🎮", ""],
      ["李小龍", ""],
      ["A very long display name indeed", "averylongdisplayname"],
    ];
    for (const [name, handle] of cases) assert.equal(handleBaseFromName(name), handle, name);
  });
});

describe("what the field knows before genex.games answers", () => {
  it("judges a shape problem at once, offering a Latin handle for letters it can't take", () => {
    assert.deepEqual(localHandleCheck("rn", null), { handle: "rn", state: HandleState.TooShort, suggestions: [] });
    assert.deepEqual(localHandleCheck("Рабнеба", null), {
      handle: "рабнеба",
      state: HandleState.LatinOnly,
      suggestions: ["rabneba"],
    });
    // Nothing Latin is left of it: no suggestion, never a made-up one.
    assert.deepEqual(localHandleCheck("李小龍", null), {
      handle: "李小龍",
      state: HandleState.LatinOnly,
      suggestions: [],
    });
    // A Latin form that is itself too short is no suggestion either.
    assert.deepEqual(localHandleCheck("Ы Ы", null), { handle: "ы ы", state: HandleState.LatinOnly, suggestions: [] });
    assert.deepEqual(localHandleCheck("rab-", null), { handle: "rab-", state: HandleState.DashEdge, suggestions: [] });
  });

  it("knows the account's own handle is the account's, typed in any case", () => {
    assert.deepEqual(localHandleCheck(" @RabNeba", "rabneba"), {
      handle: "rabneba",
      state: HandleState.Yours,
      suggestions: [],
    });
  });

  it("leaves a well-formed handle that is not the account's to genex.games", () => {
    assert.equal(localHandleCheck("rab", "rabneba"), null);
    assert.equal(localHandleCheck("rab", null), null);
  });

  it("lets only a free handle or the account's own be kept, and shows a reserved one as taken", () => {
    const kept = Object.values(HandleState).filter(handleKept);
    assert.deepEqual(kept.toSorted(), [HandleState.Free, HandleState.Yours].toSorted());
    const taken = Object.values(HandleState).filter(shownAsTaken);
    assert.deepEqual(taken.toSorted(), [HandleState.Reserved, HandleState.Taken].toSorted());
  });
});
