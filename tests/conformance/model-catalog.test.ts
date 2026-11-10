/**
 * Model recommendations.
 *
 * The catalog is data the user acts on: it decides which model the studio installs and defaults
 * to. Two ways it can lie, both of which happened before these tests existed:
 *   - it recommended a model that had been superseded (and, once deleted, told the user to
 *     re-download it);
 *   - the fit rule was tuned for discrete GPUs and declared the studio's own verified default
 *     model too large for the machine it was measured on;
 *   - on a PC it counted RAM alone, so a 24 GB graphics card could not download a 21.7 GB model,
 *     and the row said it needed a Mac.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  catalogModels,
  detectHardware,
  fitFor,
  hardwareOf,
  recommendModels,
  supersededBy,
  tiers,
  tierFor,
  type HardwareInfo,
} from "../../src/substrate/hardware.ts";
import type { GpuInfo } from "../../src/substrate/gpu-memory.ts";

/** A machine fixture built the way detectHardware() builds one, so the fit budget matches. */
function machine(ramGb: number, appleSilicon: boolean): HardwareInfo {
  return hardwareOf({
    cpu: appleSilicon ? "Apple M2 Max" : "Intel Core i9",
    ramBytes: ramGb * 1024 ** 3,
    platform: appleSilicon ? "darwin" : "linux",
    arch: appleSilicon ? "arm64" : "x64",
    gpus: [],
  });
}

/** A Windows PC with `ramGb` of RAM and these graphics cards. */
function pc(ramGb: number, gpus: GpuInfo[]): HardwareInfo {
  return hardwareOf({ cpu: "AMD Ryzen 9 7950X", ramBytes: ramGb * 1024 ** 3, platform: "win32", arch: "x64", gpus });
}

const RTX_24 = { name: "NVIDIA GeForce RTX 4090", memoryGb: 24 };

describe("model catalog", () => {
  it("every tier's first-ranked model fits the machine that tier describes", async () => {
    // A Best fit the studio cannot run is worse than none: it is confident, and wrong.
    for (const tier of tiers()) {
      const { defaultModel, picks } = await recommendModels(machine(tier.minRamGb, true));
      assert.equal(
        defaultModel,
        tier.picks[0],
        `${tier.label}: its first-ranked model ${tier.picks[0]} does not fit — ${picks[0]?.reason}`,
      );
    }
  });

  it("ranks every tier with real catalog models and short, displayable lines", () => {
    const models = catalogModels();
    for (const tier of tiers())
      for (const id of tier.picks) assert.ok(models[id], `${tier.label} ranks unknown model ${id}`);
    for (const [id, model] of Object.entries(models)) {
      assert.ok(model.about.length > 0 && model.about.length <= 60, `${id}: about must be one short line`);
      assert.ok(model.sizeGb > 0, `${id}: size`);
      if (model.mlx) assert.ok(models[model.mlx]?.appleSilicon, `${id}: its MLX sibling must be Apple-Silicon only`);
    }
  });

  it("recommends Bonsai PQ2_0 by default on a 32 GB Apple Silicon Mac", async () => {
    const { defaultModel, hardware, picks } = await recommendModels(machine(32, true));
    assert.equal(defaultModel, "bonsai-2:27b-pq2_0");
    assert.equal(picks[0]?.model, defaultModel);
    assert.ok(hardware.usableModelGb >= 23, `Metal is handed ~76% of unified memory, got ${hardware.usableModelGb}`);
  });

  it("makes Qwen 3.5 122B the Best fit on 128 GB and larger Apple Silicon Macs", async () => {
    for (const ram of [128, 192]) {
      const { defaultModel, picks } = await recommendModels(machine(ram, true));
      assert.equal(defaultModel, "qwen3.5:122b");
      assert.ok(picks[0]?.vision && picks[0].tools, "the large-Mac Best fit must build and see the game");
    }
  });

  it("shows one build per model: MLX on Apple Silicon, the portable build elsewhere", async () => {
    const apple = await recommendModels(machine(64, true));
    const appleIds = [...apple.picks, ...apple.more].map((p) => p.model);
    assert.ok(appleIds.includes("qwen3.8:27b-mlx"));
    assert.ok(!appleIds.includes("qwen3.8:27b"), "the GGUF sibling is hidden where the MLX build runs");

    const other = await recommendModels(machine(64, false));
    const otherIds = [...other.picks, ...other.more].map((p) => p.model);
    assert.ok(otherIds.includes("qwen3.8:27b"));
    assert.ok(!otherIds.some((id) => id.includes("-mlx")), "an MLX build was offered to a non-Apple machine");
    assert.ok(!other.defaultModel?.includes("-mlx"));
  });

  it("puts every other runnable model under More models, with the Mac it needs", async () => {
    const { picks, more } = await recommendModels(machine(32, true));
    assert.ok(picks.every((p) => p.fits));
    const ids = new Set(picks.map((p) => p.model));
    assert.ok(
      more.every((p) => !ids.has(p.model)),
      "a model appears in both lists",
    );
    assert.deepEqual(
      more.map((p) => p.sizeGb),
      [...more.map((p) => p.sizeGb)].sort((a, b) => a - b),
      "More models is smallest first",
    );
    const big = more.find((p) => p.model === "qwen3.5:122b");
    assert.equal(big?.fits, false);
    assert.equal(big?.needsRamGb, 128);
    assert.equal(more.find((p) => p.model === "gemma4:31b")?.needsRamGb, 36);
    assert.equal(more.find((p) => p.model === "qwen3.8-flash-next:125b-mlx")?.needsRamGb, 192);
  });

  it("judges any looked-up size with the same fit rule", () => {
    const fit = fitFor(6.6, machine(32, true));
    assert.equal(fit.fits, true);
    assert.equal(fit.needGb, 8.9);
    assert.equal(fitFor(600, machine(32, true)).needsRamGb, null, "nothing common holds it");
  });

  it("flags a superseded install rather than leaving the user on an old model", () => {
    assert.equal(supersededBy("qwen3.6:27b"), "qwen3.8:27b");
    assert.equal(supersededBy("qwen3.8:27b-mlx"), null, "the current default is not stale");
  });

  it("never offers a superseded model", () => {
    // A stale flag that redirects to something also stale sends the user on a pointless download.
    for (const id of Object.keys(catalogModels()))
      assert.equal(supersededBy(id), null, `${id} is offered but marked superseded`);
  });

  it("adds a PC's graphics memory to its RAM's share, less 1 GB per card", async () => {
    // Detection hands its cards to the budget: the reported 24 GB card with 32 GB of RAM got 21.3 GB.
    const hw = await detectHardware(async () => [RTX_24]);
    assert.equal(hw.gpuModelGb, 23);
    assert.deepEqual(hw.gpus, [RTX_24]);
    const ramShare = hw.ramGb * (hw.appleSilicon ? 0.72 : 2 / 3);
    assert.ok(Math.abs(hw.usableModelGb - (ramShare + 23)) < 0.11, `got ${hw.usableModelGb} GB usable`);

    const two = pc(32, [RTX_24, { name: "NVIDIA GeForce RTX 3090", memoryGb: 24 }]);
    assert.equal(two.gpuModelGb, 46, "Ollama spreads a model over every card");
    assert.equal(pc(32, []).usableModelGb, 21.3, "a PC without a card keeps RAM's ⅔");
  });

  it("offers a model that fits a PC's graphics card, and runs it there", async () => {
    // The report: a 24 GB card with 32 GB of RAM showed no Download for gemma4:26b (21.7 GB).
    const { picks, more, defaultModel } = await recommendModels(pc(32, [RTX_24]));
    const gemma = [...picks, ...more].find((p) => p.model === "gemma4:26b");
    assert.equal(gemma?.needGb, 21.7);
    assert.equal(gemma?.fits, true);
    assert.equal(gemma?.split, false, "21.7 GB runs entirely on a 24 GB card");
    assert.equal(defaultModel, "qwen3.8:27b");
    assert.equal(picks[0]?.split, false, "Best fit runs on the card");
  });

  it("fits a model larger than the card when card and RAM hold it, and says it runs split", async () => {
    const { picks, more } = await recommendModels(pc(32, [RTX_24]));
    const all = [...picks, ...more];
    const nemotron = all.find((p) => p.model === "nemotron-3.5-lightning:30b");
    assert.equal(nemotron?.fits, true, "29.9 GB fits 23 GB on the card plus 21.3 GB of RAM");
    assert.equal(nemotron?.split, true);
    const coder = all.find((p) => p.model === "qwen3-coder-next");
    assert.equal(coder?.fits, false);
    assert.equal(coder?.split, false);
    assert.equal(coder?.needsRamGb, null, "a PC is never told which Mac it needs");
  });

  it("ranks a PC's tier by its graphics memory too", async () => {
    // RAM alone ranks 16 GB's small models first; a 24 GB card runs the 32 GB tier's Best fit.
    assert.equal((await recommendModels(pc(16, []))).defaultModel, "gemma4:12b");
    assert.equal((await recommendModels(pc(16, [RTX_24]))).defaultModel, "qwen3.8:27b");
    // A small card never lowers a large-RAM PC's tier below what its RAM ranks.
    assert.equal(
      (await recommendModels(pc(32, [{ name: "GeForce RTX 3060 Ti", memoryGb: 8 }]))).defaultModel,
      "qwen3.8:27b",
    );
  });

  it("makes Best fit a model that runs on the card, ahead of one that runs split", async () => {
    // Split with RAM, a 27B model answers many times slower than a 12B one on a 12 GB card.
    const small = await recommendModels(pc(16, [{ name: "GeForce RTX 3060", memoryGb: 12 }]));
    assert.equal(small.defaultModel, "gemma4:12b");
    assert.equal(small.picks[0]?.split, false);
    const big = await recommendModels(pc(64, [RTX_24]));
    assert.equal(big.defaultModel, "qwen3.8:27b", "gemma4:31b needs 23.8 GB: split on a 24 GB card");
    const firstSplit = big.picks.findIndex((p) => p.split);
    assert.ok(firstSplit > 0, "the split picks come after the ones on the card");
    assert.ok(big.picks.slice(firstSplit).every((p) => p.split));
  });

  it("keeps a PC without a graphics card on RAM alone, and never names a Mac", async () => {
    const { picks, more, defaultModel } = await recommendModels(pc(32, []));
    assert.equal(defaultModel, "qwen3.8:27b");
    const all = [...picks, ...more];
    assert.equal(all.find((p) => p.model === "gemma4:26b")?.fits, false);
    assert.ok(
      all.every((p) => !p.split),
      "nothing is split without a card",
    );
    assert.ok(all.every((p) => p.needsRamGb === null));
  });

  it("picks the tier the machine actually meets", () => {
    assert.equal(tierFor(32).minRamGb, 32);
    assert.equal(tierFor(16).minRamGb, 16);
    assert.equal(tierFor(192).minRamGb, 192);
    assert.ok(tierFor(8).minRamGb <= 8);
  });
});

it("offers both Bonsai packings on supported Macs and neither on 8 GB or other hardware", async () => {
  const supported = await recommendModels(machine(16, true));
  assert.deepEqual(
    supported.picks.filter((p) => p.engine === "bonsai").map((p) => p.model),
    ["bonsai-2:27b-pq2_0", "bonsai-2:27b-ptq1_0"],
  );
  for (const hw of [machine(8, true), machine(32, false)]) {
    const { picks, more } = await recommendModels(hw);
    assert.equal(
      [...picks, ...more].some((p) => p.engine === "bonsai"),
      false,
    );
  }
});
