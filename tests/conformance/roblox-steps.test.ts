/**
 * The Roblox Studio setup rows, as the Set up panel and the chat's steps card both draw them: one
 * builder, so the card shows the panel's rows with the same words, ticks and buttons. For each
 * state of Studio: plain words with no time words, the step that is next, Do it for me with Restart
 * Studio and Studio's own click path while Studio is open with its MCP server off, macOS's Documents
 * note before Set up on a Mac only, and the place block's live-saved-data warning and Rojo note.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RobloxAction } from "../../src/plugins/roblox/actions.ts";
import {
  nowStep,
  type RobloxRow,
  type RobloxStepFacts,
  RobloxStepId,
  robloxRows,
  robloxSteps,
} from "../../src/plugins/roblox/engine-steps.ts";
import { LIVE_DATA_CLICK_PATH, MCP_SWITCH_CLICK_PATH, MESSAGE } from "../../src/plugins/roblox/words.ts";

const BANNED_WORDS = /overnight|night|morning|tonight|Unreal/i;
/** What a row must never show a person: code, ids or a value that didn't arrive. */
const NOT_PLAIN = /undefined|null|NaN|\[object|studio_id|execute_luau|[{}]/;

const BASE: RobloxStepFacts = {
  installed: true,
  version: "0.743.0.7431133",
  setUp: true,
  running: true,
  answering: true,
  linked: false,
};

/** Every state the rows can be read in, by a name a failure reads well with. */
const STATES: Record<string, RobloxStepFacts> = {
  missing: { ...BASE, installed: false, setUp: false, running: false, answering: false, version: undefined },
  getting: {
    ...BASE,
    installed: false,
    setUp: false,
    running: false,
    answering: false,
    getting: { detail: "Downloading Roblox's installer." },
  },
  "install failed": {
    ...BASE,
    installed: false,
    setUp: false,
    running: false,
    answering: false,
    failed: { detail: "Genex couldn't download Roblox's installer." },
  },
  "not set up, closed": { ...BASE, setUp: false, running: false, answering: false, mac: true },
  "not set up, open": { ...BASE, setUp: false, answering: false, mac: true },
  "set up, closed": { ...BASE, running: false, answering: false },
  "open, switch off": { ...BASE, answering: false, mcpOn: false, canClick: true },
  "open, switch off, no clicking": { ...BASE, answering: false, mcpOn: false },
  "open, switch on": { ...BASE, answering: false, mcpOn: true, canClick: true },
  "open, switch on, place linked": { ...BASE, answering: false, mcpOn: true, canClick: true, linked: true },
  "ready, no place": BASE,
  "ready, linked": { ...BASE, linked: true, place: "Place1" },
  "linked, live data": { ...BASE, linked: true, place: "Pet Valley", liveData: true },
  "linked, Rojo": { ...BASE, linked: true, place: "Obby Lab", rojo: true },
};

const NEXT: Record<string, RobloxStepId | undefined> = {
  missing: RobloxStepId.Studio,
  getting: RobloxStepId.Studio,
  "install failed": RobloxStepId.Studio,
  "not set up, closed": RobloxStepId.Helper,
  "not set up, open": RobloxStepId.Helper,
  "set up, closed": RobloxStepId.SignIn,
  "open, switch off": RobloxStepId.Mcp,
  "open, switch off, no clicking": RobloxStepId.Mcp,
  "open, switch on": RobloxStepId.Mcp,
  "open, switch on, place linked": RobloxStepId.Mcp,
  "ready, no place": RobloxStepId.Place,
  "ready, linked": undefined,
  "linked, live data": undefined,
  "linked, Rojo": undefined,
};

/** Each row's words as a person reads them, warnings and notes included. */
const wordsOf = (row: RobloxRow) =>
  [
    row.label,
    row.detail,
    row.note,
    row.waiting,
    row.warning?.text,
    row.action?.label,
    ...(row.more ?? []).map((choice) => choice.label),
    ...(row.clickPath ?? []),
    ...(row.warning?.clickPath ?? []),
  ].filter((text): text is string => typeof text === "string");

const row = (facts: RobloxStepFacts, id: RobloxStepId) => {
  const found = robloxRows(facts).find((candidate) => candidate.id === id);
  assert.ok(found, `a ${id} row`);
  return found;
};

describe("the Roblox Studio setup rows", () => {
  for (const [name, facts] of Object.entries(STATES))
    it(`${name}: the five rows in order, in plain words, the next step named`, () => {
      const rows = robloxRows(facts);
      assert.deepEqual(
        rows.map((candidate) => candidate.id),
        [RobloxStepId.Studio, RobloxStepId.SignIn, RobloxStepId.Helper, RobloxStepId.Mcp, RobloxStepId.Place],
      );
      for (const candidate of rows)
        for (const text of wordsOf(candidate)) {
          assert.ok(text.trim().length > 0, `${candidate.id} has no empty words`);
          assert.doesNotMatch(text, BANNED_WORDS, `${candidate.id}: ${text}`);
          assert.doesNotMatch(text, NOT_PLAIN, `${candidate.id}: ${text}`);
        }
      assert.equal(nowStep(facts), NEXT[name]);
    });

  for (const [name, facts] of Object.entries(STATES))
    it(`${name}: the chat's card shows the panel's rows with the same words, ticks and buttons`, () => {
      const rows = robloxRows(facts);
      const card = robloxSteps(facts);
      assert.deepEqual(
        card.steps.map(({ id, label, done, action }) => ({ id, label, done, action })),
        rows.map(({ id, label, done, action }) => ({ id, label, done, action })),
      );
      for (const [at, cardRow] of card.steps.entries()) {
        const panelRow = rows[at];
        assert.ok(panelRow);
        assert.ok(cardRow.detail.startsWith(panelRow.detail), "the card's line starts with the panel's");
        if (panelRow.clickPath)
          assert.ok(cardRow.detail.includes(panelRow.clickPath.join(" › ")), "the card names Studio's click path");
      }
      assert.equal(
        card.open,
        rows.some((candidate) => !candidate.done),
      );
    });

  it("Studio open with its MCP server off: Do it for me first, Restart Studio beside it, and Studio's own click path", () => {
    const mcp = row(STATES["open, switch off"] as RobloxStepFacts, RobloxStepId.Mcp);
    assert.equal(mcp.done, false);
    assert.deepEqual(mcp.action, { name: RobloxAction.DoItForMe, args: {}, label: "Do it for me" });
    assert.deepEqual(mcp.more, [{ name: RobloxAction.RestartStudio, args: {}, label: "Restart Studio" }]);
    assert.deepEqual(mcp.clickPath, MCP_SWITCH_CLICK_PATH.split(" › "));
    // Flipped: a Studio on its sign-in screen doesn't answer either, so the row says to sign in first.
    assert.equal(mcp.detail, `${MESSAGE.Steps.McpOff} ${MESSAGE.Steps.SignInFirst}`);
    assert.equal(mcp.waiting, MESSAGE.Steps.Waiting);
  });

  it("where Genex can't click in Studio (Windows, or no computer control), the MCP step never offers Do it for me", () => {
    const mcp = row(STATES["open, switch off, no clicking"] as RobloxStepFacts, RobloxStepId.Mcp);
    assert.deepEqual(mcp.action, { name: RobloxAction.RestartStudio, args: {}, label: "Restart Studio" });
    assert.equal(mcp.more, undefined);
    assert.deepEqual(mcp.clickPath, MCP_SWITCH_CLICK_PATH.split(" › "));
    for (const facts of Object.values(STATES))
      if (!facts.canClick)
        for (const candidate of robloxRows(facts))
          assert.notEqual(candidate.action?.name, RobloxAction.DoItForMe, JSON.stringify(facts));
  });

  it("Studio open with the switch already on waits for Studio: sign in first, open a place, and no Do it for me", () => {
    // Flipped: the switch is on, so clicking it can't help; Studio waits for a sign-in or a place.
    const linked = row(STATES["open, switch on, place linked"] as RobloxStepFacts, RobloxStepId.Mcp);
    assert.equal(linked.detail, `${MESSAGE.Steps.McpOnWaiting} ${MESSAGE.Steps.SignInFirst}`);
    assert.equal(linked.waiting, MESSAGE.Steps.Waiting);
    assert.equal(linked.action?.name, RobloxAction.RestartStudio);
    const noPlace = row(STATES["open, switch on"] as RobloxStepFacts, RobloxStepId.Mcp);
    assert.equal(noPlace.detail, `${MESSAGE.Steps.McpOnNoPlace} ${MESSAGE.Steps.SignInFirst}`);
    assert.match(noPlace.detail, /New Roblox game/);
  });

  it("the sign-in step tells someone with no Roblox account where to make one", () => {
    const signIn = row(STATES["set up, closed"] as RobloxStepFacts, RobloxStepId.SignIn);
    assert.match(signIn.detail, /No Roblox account yet\? Choose Sign up on Studio's sign-in screen\./);
  });

  it("the place step in the panel doesn't send the person to the button that opened it; the chat's card does", () => {
    const facts = STATES["ready, no place"] as RobloxStepFacts;
    assert.doesNotMatch(row(facts, RobloxStepId.Place).detail, /Roblox Studio button/);
    const card = robloxSteps(facts).steps.find((step) => step.id === RobloxStepId.Place);
    assert.match(card?.detail ?? "", /Choose it with the Roblox Studio button\./);
  });

  it("Studio open before Set up: the helper step offers Restart Studio, since Set up waits for Studio to close", () => {
    const helper = row(STATES["not set up, open"] as RobloxStepFacts, RobloxStepId.Helper);
    assert.equal(helper.action?.name, RobloxAction.RestartStudio);
    const closed = row(STATES["not set up, closed"] as RobloxStepFacts, RobloxStepId.Helper);
    assert.equal(closed.action?.name, RobloxAction.Setup);
  });

  it("macOS's Documents note shows before Set up on a Mac, and nowhere else", () => {
    const mac = STATES["not set up, closed"] as RobloxStepFacts;
    assert.equal(row(mac, RobloxStepId.Helper).note, MESSAGE.Setup.DocumentsNote);
    assert.equal(row({ ...mac, mac: false }, RobloxStepId.Helper).note, undefined, "not on Windows");
    assert.equal(row({ ...mac, setUp: true }, RobloxStepId.Helper).note, undefined, "not once set up");
  });

  it("a game whose Studio can reach its live saved data says so in the place block, with the switch to turn it off", () => {
    const place = row(STATES["linked, live data"] as RobloxStepFacts, RobloxStepId.Place);
    assert.equal(place.done, true);
    assert.equal(place.label, "This game builds in Pet Valley");
    assert.match(place.warning?.text ?? "", /^Studio can reach this game's live saved data/);
    assert.deepEqual(place.warning?.clickPath, LIVE_DATA_CLICK_PATH.split(" › "));
    assert.equal(row(STATES["ready, linked"] as RobloxStepFacts, RobloxStepId.Place).warning, undefined);
  });

  it("a game with the person's own Rojo project says Rojo keeps its scripts in step", () => {
    const place = row(STATES["linked, Rojo"] as RobloxStepFacts, RobloxStepId.Place);
    assert.equal(place.detail, "Rojo keeps your scripts in step, so Genex leaves them to it.");
  });

  it("Get Roblox Studio that stopped says why and offers it again; one under way offers Stop", () => {
    const failed = row(STATES["install failed"] as RobloxStepFacts, RobloxStepId.Studio);
    assert.equal(failed.detail, "Genex couldn't download Roblox's installer.");
    assert.equal(failed.action?.name, RobloxAction.GetStudio);
    const getting = row(STATES.getting as RobloxStepFacts, RobloxStepId.Studio);
    assert.equal(getting.busy, true);
    assert.equal(getting.action?.name, RobloxAction.CancelGetStudio);
  });
});
