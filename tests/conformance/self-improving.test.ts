/**
 * The settings beside self-improvement: the one switch (`learning`), off by default, that lets the
 * harness change its own files, and Maximum workers with its migrations.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startRig, type Rig } from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

describe("settings: the one self-improving switch", () => {
  it("Maximum workers defaults to four, adds the lead's windows to the pool, and migrates old saved values", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const restart = async () => {
      await rig.core.stop();
      await rig.core.init();
    };
    assert.equal(rig.core.settings.buildersMax, 4);
    assert.equal(rig.core.settings.agentsMax, 6, "four workers plus the lead's two windows");
    const five = await rig.core.updateSettings({ buildersMax: 5 });
    assert.deepEqual([five.buildersMax, five.agentsMax], [5, 7]);
    const most = await rig.core.updateSettings({ buildersMax: 99 });
    assert.deepEqual([most.buildersMax, most.agentsMax], [12, 14], "never above the most offered");
    await rig.core.updateSettings({ buildersMax: 8 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 8, "eight chosen now stays eight, though it was the old default");

    await rig.core.updateSettings({ buildersMax: 12 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 12, "an explicit twelve is not replaced by the default");

    // Settings are saved whole on any change, so only a choice made from now on is told apart from a default.
    await rig.core.updateSettings({ buildersMax: 2 });
    await restart();
    assert.equal(rig.core.settings.buildersMax, 2, "two chosen now stays two");

    const settings = path.join(rig.userData, "settings.json");
    await writeFile(settings, JSON.stringify({ buildersMax: 8, agentsMax: 10, buildersDefault: 8 }));
    await restart();
    assert.deepEqual(
      [rig.core.settings.buildersMax, rig.core.settings.agentsMax],
      [4, 6],
      "the previous build's untouched default of eight becomes the new default of four",
    );
    await writeFile(settings, JSON.stringify({ buildersMax: 2, agentsMax: 4 }));
    await restart();
    assert.deepEqual(
      [rig.core.settings.buildersMax, rig.core.settings.agentsMax],
      [4, 6],
      "an older build's untouched default of two becomes the new default",
    );
    await writeFile(settings, JSON.stringify({ buildersMax: 6, agentsMax: 8 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 6, "any other number an older build saved was chosen and stays");
    await writeFile(settings, JSON.stringify({ buildersMax: 5, agentsMax: 7, buildersDefault: 5 }));
    await restart();
    assert.equal(
      rig.core.settings.buildersMax,
      4,
      "a count equal to the default its file recorded follows today's default",
    );

    await writeFile(settings, JSON.stringify({ agentsMax: 6 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 4, "the old untouched pool size becomes the new default");
    await writeFile(settings, JSON.stringify({ agentsMax: 8 }));
    await restart();
    assert.equal(rig.core.settings.buildersMax, 6, "a pool someone chose keeps its builders");
  });

  it("Self-improvement is off by default, and the choice persists", async () => {
    const rig = await startRig();
    rigs.push(rig);
    assert.equal(rig.core.settings.learning, false, "off by default: self-improvement is stopped");
    await rig.core.updateSettings({ learning: true });
    await rig.core.updateSettings({ learning: false });
    await rig.core.stop();
    await rig.core.init();
    assert.equal(rig.core.settings.learning, false, "the switch survives a relaunch");
    await rig.core.updateSettings({ learning: true });
    assert.equal(rig.core.settings.learning, true);
  });
});
