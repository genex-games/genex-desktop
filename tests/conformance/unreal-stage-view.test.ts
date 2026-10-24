/**
 * The Live stage's Unreal card follows where the game's own Unreal project stands, as the Unreal
 * button and panel do: one line and at most one button per step the plugin's `stage-status` names,
 * never Open in Unreal for a project that isn't set up or is already open. Tested through the pure
 * view the card draws.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PanelStep } from "../../src/plugins/unreal/backend.ts";
import {
  keepStageStatus,
  keptStageStatus,
  ReopenStep,
  reopenStep,
  StageAct,
  stageView,
} from "../../src/renderer/panels/stage/unreal-stage-view.ts";
import { parseStageStatus, UnrealStageStep, type UnrealStageStatus } from "../../src/renderer/unreal-game.ts";

const NAME = "Lantern";
/** A `stage-status` answer as the plugin sends it, read the way the card reads it. */
function status(next: string, extra: Record<string, unknown> = {}): UnrealStageStatus {
  const parsed = parseStageStatus({
    next,
    project: { name: NAME, file: "/games/lantern/unreal/Lantern.uproject" },
    opening: null,
    openProject: null,
    editors: 1,
    ...extra,
  });
  assert.ok(parsed, `${next} is a step the card knows`);
  return parsed;
}

describe("the Live card's Unreal step", () => {
  it("knows each step the plugin names, by the plugin's own wire values", () => {
    assert.deepEqual(Object.values(UnrealStageStep).sort(), Object.values(PanelStep).sort());
  });

  const rows: Array<[string, UnrealStageStatus, string | null]> = [
    ["no Unreal installed: get it", status(PanelStep.GetUnreal, { project: null }), StageAct.GetUnreal],
    ["not set up: set up and open, never a bare Open", status(PanelStep.SetUp, { editors: 0 }), StageAct.SetUpAndOpen],
    ["not set up while Unreal has another project open: only set up", status(PanelStep.SetUp), StageAct.SetUp],
    ["set up and closed: open", status(PanelStep.Open, { editors: 0 }), StageAct.Open],
    ["opening: nothing to press", status(PanelStep.Starting, { opening: { at: 0, elapsedMs: 192_000 } }), null],
    ["ready: nothing to press", status(PanelStep.Connected), null],
    [
      "another project open: switch to this one",
      status(PanelStep.Switch, { openProject: { name: "Harbor", file: "/h/Harbor.uproject" } }),
      StageAct.Restart,
    ],
    ["not answering: restart", status(PanelStep.NotAnswering), StageAct.Restart],
    ["its port blocked: restart", status(PanelStep.PortBlocked), StageAct.Restart],
    ["Unreal open before setup: quit first", status(PanelStep.QuitFirst), StageAct.Quit],
    [
      "Unreal has a project open that isn't this one: nothing that quits it",
      status(PanelStep.OpenWhenFree, { holder: "Harbor" }),
      null,
    ],
    ["no project to show: the Unreal panel", status(PanelStep.Choose, { project: null }), StageAct.Panel],
  ];
  for (const [name, row, act] of rows)
    it(name, () => {
      const view = stageView(row, NAME);
      assert.equal(view.button?.act ?? null, act);
      assert.ok(view.line.length > 0, "always one line of where it stands");
    });

  it("times the opening, and names the project Unreal has open instead", () => {
    assert.equal(stageView(status(PanelStep.Starting), NAME).timer, true);
    assert.equal(stageView(status(PanelStep.Open), NAME).timer, false);
    const other = stageView(status(PanelStep.Switch, { openProject: { name: "Harbor", file: "/h" } }), NAME);
    assert.match(other.line, /Harbor/);
    assert.match(other.button?.label ?? "", /Lantern/);
  });

  it("says Unreal crashed while its crash report holds the port, and offers nothing until the report closes", () => {
    const view = stageView(status(PanelStep.Crashed, { editors: 0 }), NAME);
    assert.equal(view.button, null);
    assert.match(view.line, /Unreal crashed/);
    assert.match(view.line, /crash report/);
    assert.match(view.line, /Lantern/);
  });

  it("offers no Quit or Restart while two editors run, since one could reach the wrong project", () => {
    for (const next of [PanelStep.Switch, PanelStep.NotAnswering, PanelStep.PortBlocked, PanelStep.QuitFirst])
      assert.equal(stageView(status(next, { editors: 2, openProject: { name: "H", file: "/h" } }), NAME).button, null);
  });

  it("offers nothing that quits Unreal while a Loop is using it, and names that Loop", () => {
    const loop = { title: "Harbor Night", project: "/h/Harbor.uproject", here: false };
    const other = { name: "Harbor", file: "/h/Harbor.uproject" };
    for (const next of [PanelStep.Switch, PanelStep.NotAnswering, PanelStep.PortBlocked, PanelStep.QuitFirst]) {
      const view = stageView(status(next, { busyRun: loop, openProject: other }), NAME);
      assert.equal(view.button, null, next);
      assert.match(view.line, /A Loop in Harbor Night is using Unreal/, next);
    }
    const own = { ...loop, project: "/games/lantern/unreal/Lantern.uproject", here: true };
    assert.match(stageView(status(PanelStep.NotAnswering, { busyRun: own }), NAME).line, /^Lantern isn’t answering/);
    assert.equal(stageView(status(PanelStep.Connected, { busyRun: own }), NAME).line, "Ready in Unreal");
  });

  it("says what holds Unreal while this project waits for it, when known", () => {
    const loop = { title: "Harbor Night", project: "/h/Harbor.uproject", here: false };
    const lines: Array<[string, UnrealStageStatus, string]> = [
      [
        "set up beside a project it names",
        status(PanelStep.SetUp, { holder: "Harbor" }),
        "Unreal has Harbor open. Genex sets Lantern up for agents now; you confirm what changes. Open it once Unreal is free.",
      ],
      [
        "set up beside a Loop",
        status(PanelStep.SetUp, { busyRun: loop }),
        "A Loop in Harbor Night is using Unreal. Genex sets Lantern up for agents now; you confirm what changes. Open it after the Loop ends.",
      ],
      [
        "set up beside a project it can't name",
        status(PanelStep.SetUp),
        "Unreal has another project open. Genex sets Lantern up for agents now; you confirm what changes. Open it once Unreal is free.",
      ],
      [
        "open beside a project it names",
        status(PanelStep.OpenWhenFree, { holder: "Harbor" }),
        "Unreal has Harbor open. Open Lantern once Unreal is free.",
      ],
      [
        "open beside a Loop",
        status(PanelStep.OpenWhenFree, { busyRun: loop, holder: "Harbor" }),
        "A Loop in Harbor Night is using Unreal. Open Lantern after it ends.",
      ],
      [
        "open beside a project it can't name",
        status(PanelStep.OpenWhenFree),
        "Unreal has another project open. Open Lantern once Unreal is free.",
      ],
    ];
    for (const [name, row, line] of lines) {
      const view = stageView(row, NAME);
      assert.equal(view.line, line, name);
      const act = row.next === PanelStep.SetUp ? StageAct.SetUp : null;
      assert.equal(view.button?.act ?? null, act, `${name}: only Set up, never a quit`);
    }
  });

  it("says why setup is needed again, that a first start takes minutes, and where a moved project is chosen", () => {
    assert.match(stageView(status(PanelStep.SetUp, { portTaken: true, editors: 0 }), NAME).line, /port/);
    assert.equal(
      stageView(status(PanelStep.Starting, { firstStart: true }), NAME).hint,
      "The first start can take several minutes.",
    );
    assert.equal(stageView(status(PanelStep.Starting, { firstStart: false }), NAME).hint, null);
    assert.match(stageView(status(PanelStep.Choose, { project: null }), NAME).line, /^Lantern isn’t where it was/);
  });

  it("a folder holding an Unreal project with no link yet is told to choose it in the Unreal panel", () => {
    const view = stageView(status(PanelStep.Choose, { project: null }), NAME, { linked: false });
    assert.equal(view.line, "Choose this game’s Unreal project in the Unreal panel.");
    assert.equal(view.button?.act, StageAct.Panel);
    assert.equal(
      stageView(status(PanelStep.Connected), NAME, { linked: false }).line,
      "Ready in Unreal",
      "every other step reads as for a linked project",
    );
  });

  it("before the plugin first answers, offers nothing that could vanish a moment later", () => {
    const waiting = stageView(null, NAME, { linked: true, answered: false });
    assert.equal(waiting.button, null);
    assert.equal(waiting.line, "", "the line waits too, so no guess is replaced");
  });

  it("when the plugin answered nothing readable, offers Open in Unreal as before; an answer of another shape counts as none", () => {
    assert.equal(stageView(null, NAME).button?.act, StageAct.Open);
    assert.equal(stageView(null, NAME, { linked: true, answered: true }).button?.act, StageAct.Open);
    for (const odd of [null, "ready", { next: "launch" }, { next: 3 }]) assert.equal(parseStageStatus(odd), null);
  });

  it("a card that comes back starts from its own game's last answer", () => {
    const ready = { status: status(PanelStep.Connected), at: 1 };
    keepStageStatus("lantern", ready);
    assert.equal(keptStageStatus("lantern"), ready);
    assert.equal(keptStageStatus("harbor"), null, "never another game's");
  });
});

describe("a restart's reopen", () => {
  const mark = { game: "lantern", until: 60_000 };
  const closed = status(PanelStep.Open, { editors: 0 });

  it("opens this game's project once Unreal has closed and opening is the step", () => {
    assert.equal(reopenStep(mark, "lantern", closed, 1_000), ReopenStep.Open);
  });

  it("waits while an editor still runs (Unreal may first ask to save)", () => {
    assert.equal(reopenStep(mark, "lantern", status(PanelStep.Open, { editors: 1 }), 1_000), ReopenStep.Wait);
    assert.equal(reopenStep(mark, "lantern", null, 1_000), ReopenStep.Wait, "no answer yet");
  });

  it("opens nothing once the stage shows another game", () => {
    assert.equal(reopenStep(mark, "harbor", closed, 1_000), ReopenStep.Drop);
  });

  it("opens nothing after the wait runs out, or when opening isn't the step", () => {
    assert.equal(reopenStep(mark, "lantern", closed, 61_000), ReopenStep.Drop);
    assert.equal(reopenStep(mark, "lantern", status(PanelStep.PortBlocked, { editors: 0 }), 1_000), ReopenStep.Drop);
  });

  it("does nothing with no restart waiting", () => {
    assert.equal(reopenStep(null, "lantern", closed, 1_000), ReopenStep.Wait);
  });
});
